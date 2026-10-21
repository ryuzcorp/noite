//! App rename: new display name and/or slug.
//!
//! Slug is identity (subdomain, git prefix, fleet bucket, Caddy route,
//! bare mirror), so a slug change moves every artifact: stop the fleet,
//! move local dirs + both S3 prefixes, then update the DB row. The
//! reconcile loop respawns the fleet and rewrites Caddy from the DB on
//! its next tick, so no explicit restart/rewrite is needed here.
//!
//! Locking (ordering: CREATE_LOCK → AppLock → push_guard, see
//! [`crate::host::git_manifest::GitSync`]): the service layer holds
//! `CREATE_LOCK` across slug-changing renames (serializing the slug-taken
//! check → move → row update against creates and other renames); this module
//! claims the `AppLock` (bailing on an in-flight deploy, 409 at the API
//! layer) and then holds both slugs' `push_guard`s across the whole move so
//! no push can write under the old prefix mid-move.
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::db;
use crate::host::deploy::{self, Deploying};
use crate::host::logs::LogState;
use crate::host::source;
use crate::host::supervisor::{self, ProcMap};
use crate::host::{exec, s3};
use crate::models::App;

async fn move_dir(from: &std::path::Path, to: &std::path::Path) -> anyhow::Result<()> {
    if !from.exists() {
        return Ok(());
    }
    if to.exists() {
        // The reconcile loop can recreate an empty state dir mid-rename
        // (it respawns from the pre-update DB row); drop it, keep the data.
        let mut empty = false;
        if to.is_dir() {
            if let Ok(mut dir) = tokio::fs::read_dir(to).await {
                empty = dir
                    .next_entry()
                    .await
                    .map(|entry| entry.is_none())
                    .unwrap_or(false);
            }
        }
        if empty {
            tokio::fs::remove_dir(to).await?;
        } else {
            anyhow::bail!("rename target {} already exists", to.display());
        }
    }
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::rename(from, to)
        .await
        .with_context(|| format!("rename {} → {}", from.display(), to.display()))?;
    Ok(())
}

/// Parse one `s3_list_prefix` listing into its object keys. R-06: a listing
/// that does not parse (or has no `Contents` array) is an error, never an
/// empty prefix — treating it as empty skips the move while the row update
/// still points the app at the new prefix, orphaning data under the old one.
fn parse_listing_keys(json: &str, from: &str, to: &str) -> anyhow::Result<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(json)
        .with_context(|| format!("parse S3 listing for move {from} → {to}"))?;
    let contents = value
        .get("Contents")
        .and_then(|v| v.as_array())
        .with_context(|| format!("S3 listing for move {from} → {to} has no Contents"))?;
    Ok(contents
        .iter()
        .filter_map(|o| o.get("Key")?.as_str().map(str::to_string))
        .collect())
}

/// Object-by-object prefix move, skipped when the source prefix is empty so a
/// retry after a partial move stays a no-op instead of an error. Copies run
/// eight at a time; each key is uploaded before its source is deleted, so a
/// crash leaves the union of both prefixes (never a loss).
async fn move_s3_prefix(cfg: &Config, from: &str, to: &str) -> anyhow::Result<()> {
    let bucket = from
        .strip_prefix("s3://")
        .and_then(|s| s.split('/').next())
        .unwrap_or(&cfg.s3_bucket)
        .to_string();
    let from_key = from
        .strip_prefix(&format!("s3://{bucket}/"))
        .unwrap_or(from)
        .to_string();
    let to_key = to
        .strip_prefix(&format!("s3://{bucket}/"))
        .unwrap_or(to)
        .to_string();
    let json = s3::s3_list_prefix(cfg, &bucket, &from_key).await?;
    let keys = parse_listing_keys(&json, from, to)?;
    if keys.is_empty() {
        return Ok(());
    }
    use futures::StreamExt;
    let moves = futures::stream::iter(keys.into_iter().map(|key| {
        let rel = key.strip_prefix(&from_key).unwrap_or(&key).to_string();
        let bucket = bucket.clone();
        let to_key = format!("{to_key}{rel}");
        async move {
            s3::s3_copy_key(cfg, &bucket, &key, &to_key).await?;
            s3::s3_delete_key(cfg, &key).await
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<anyhow::Result<()>>>();
    for r in moves.await {
        r.with_context(|| format!("move S3 prefix {from} → {to}"))?;
    }
    Ok(())
}

// Nine params thread the rename through every subsystem (db, fleets, git,
// caddy, logs) in one call — a params struct would just rename the problem.
#[allow(clippy::too_many_arguments)]
pub async fn rename_app(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    git_sync: &crate::host::git_manifest::GitSync,
    app_id: &str,
    name: Option<&str>,
    slug: Option<&str>,
) -> anyhow::Result<App> {
    let app = db::get_app(pool, app_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))?;
    let new_name = name.unwrap_or(&app.name);
    let new_slug = slug.unwrap_or(&app.slug);
    if new_slug == app.slug {
        db::rename_app(
            pool,
            app_id,
            new_name,
            &app.slug,
            &app.subdomain,
            &app.git_prefix,
            &app.fleet_bucket,
        )
        .await?;
        return db::get_app(pool, app_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("app not found"));
    }
    if !crate::lifecycle::slug_ok(new_slug) {
        anyhow::bail!("invalid slug");
    }
    let Some(_claim) = deploy::claim_wait_owned(deploying, app_id, Duration::from_secs(120)).await
    else {
        anyhow::bail!("deploy in flight; retry rename shortly");
    };
    // R-02: pushes hold `push_guard(slug)` across git + S3 + manifest, so the
    // whole move (dirs, both S3 prefixes, row update, re-sweep) runs under
    // both slugs' guards — a push to either slug lands fully before or fully
    // after. Taken after the AppLock (ordering: AppLock → push_guard), in
    // lexical order so opposite renames cannot invert.
    let (_old_push, _new_push) = git_sync.push_guards(&app.slug, new_slug).await;
    rename_slugged(cfg, pool, procs, logs, &app, new_name, new_slug).await
}

async fn rename_slugged(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
    new_name: &str,
    new_slug: &str,
) -> anyhow::Result<App> {
    supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    // Environment fleets are keyed `slug.label`, so the rename has to stop
    // them too; the reconcile loop respawns them under the new key from the
    // updated rows.
    supervisor::stop_environment_fleets(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    // Same settle as purge: don't move S3 under a dying node.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let root = exec::work_root(cfg);
    let pairs = vec![
        (
            source::bare_repo(cfg, &app.slug),
            source::bare_repo(cfg, new_slug),
        ),
        (
            root.join("git-http").join(format!("{}.git", app.slug)),
            root.join("git-http").join(format!("{new_slug}.git")),
        ),
        (
            root.join("projects").join(&app.slug),
            root.join("projects").join(new_slug),
        ),
        (
            root.join("fleets").join(&app.slug),
            root.join("fleets").join(new_slug),
        ),
        (
            root.join("builds").join(&app.slug),
            root.join("builds").join(new_slug),
        ),
        // T5.1: the persistent bun cache moves with the app.
        (
            root.join("cache").join(&app.slug),
            root.join("cache").join(new_slug),
        ),
        // Every preview environment's local state dir (`envs/<slug>/`).
        (
            root.join("envs").join(&app.slug),
            root.join("envs").join(new_slug),
        ),
    ];
    for (from, to) in &pairs {
        move_dir(from, to).await?;
    }

    move_s3_prefix(
        cfg,
        &format!("s3://{}/git/{}/", cfg.s3_bucket, app.slug),
        &format!("s3://{}/git/{new_slug}/", cfg.s3_bucket),
    )
    .await?;
    move_s3_prefix(
        cfg,
        &format!("s3://{}/fleets/{}/", cfg.s3_bucket, app.slug),
        &format!("s3://{}/fleets/{new_slug}/", cfg.s3_bucket),
    )
    .await?;
    // Every preview environment's bucket prefix (`envs/<slug>/`) moves with
    // the slug, and each environment row's stored bucket follows.
    move_s3_prefix(
        cfg,
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(&app.slug)),
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(new_slug)),
    )
    .await?;

    // Carry the in-memory log rings to the new keys (`fleets/<slug>` and each
    // `slug.label` environment ring).
    let ring = logs.lock().await.remove(&app.slug).unwrap_or_default();
    if !ring.is_empty() {
        logs.lock().await.insert(new_slug.to_string(), ring);
    }
    let envs = db::list_all_environments(pool).await.unwrap_or_default();
    for env in envs.iter().filter(|e| e.app_id == app.id) {
        let from = supervisor::env_fleet_key(&app.slug, &env.label);
        let to = supervisor::env_fleet_key(new_slug, &env.label);
        let ring = logs.lock().await.remove(&from).unwrap_or_default();
        if !ring.is_empty() {
            logs.lock().await.insert(to, ring);
        }
        db::set_environment_bucket(pool, &env.id, &cfg.envs_uri(new_slug, &env.label)).await?;
    }

    let subdomain = format!("{new_slug}.{}", cfg.base_domain);
    db::rename_app(
        pool,
        &app.id,
        new_name,
        new_slug,
        &subdomain,
        &Config::git_prefix(new_slug),
        &cfg.fleets_uri(new_slug),
    )
    .await?;
    // The prefix changed, so a scoped pair for the old prefix must not
    // survive (SPEC, Scoped credentials). A scoped provider mints the new-prefix pair here.
    // R-10: a revoke failure must not vanish — warn loudly instead of `let _`.
    if let Err(e) = crate::host::credentials::revoke(pool, &app.id).await {
        tracing::warn!(app_id = %app.id, error = %format!("{e:#}"), "slug renamed but credential revoke failed");
    }
    // The loop may have respawned the old-slug fleet mid-move (it reads the
    // pre-update row); kill it and re-sweep both prefixes so late writes
    // land under the new slug instead of orphaning under the old one.
    supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    supervisor::stop_environment_fleets(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    move_s3_prefix(
        cfg,
        &format!("s3://{}/git/{}/", cfg.s3_bucket, app.slug),
        &format!("s3://{}/git/{new_slug}/", cfg.s3_bucket),
    )
    .await?;
    move_s3_prefix(
        cfg,
        &format!("s3://{}/fleets/{}/", cfg.s3_bucket, app.slug),
        &format!("s3://{}/fleets/{new_slug}/", cfg.s3_bucket),
    )
    .await?;
    move_s3_prefix(
        cfg,
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(&app.slug)),
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(new_slug)),
    )
    .await?;
    db::get_app(pool, &app.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))
}

#[cfg(test)]
mod tests {
    use super::parse_listing_keys;

    /// R-06: an empty `Contents` is the only "nothing to move" shape. Garbage
    /// and a missing `Contents` are errors — the move must fail instead of
    /// pointing the row at an empty prefix while data sits under the old one.
    #[test]
    fn listing_parse_refuses_to_read_garbage_as_empty() {
        let empty = r#"{"Contents":[],"CommonPrefixes":[]}"#;
        assert!(parse_listing_keys(empty, "s3://b/git/a/", "s3://b/git/c/")
            .expect("empty listing parses")
            .is_empty());
        let keys = parse_listing_keys(
            r#"{"Contents":[{"Key":"git/a/x.bundle"},{"Key":"git/a/y.bundle"}]}"#,
            "s3://b/git/a/",
            "s3://b/git/c/",
        )
        .expect("keyed listing parses");
        assert_eq!(keys, vec!["git/a/x.bundle", "git/a/y.bundle"]);
        assert!(
            parse_listing_keys("not json at all", "s3://b/git/a/", "s3://b/git/c/").is_err(),
            "malformed listings must error, never skip"
        );
        assert!(
            parse_listing_keys(r#"{"CommonPrefixes":[]}"#, "s3://b/git/a/", "s3://b/git/c/")
                .is_err(),
            "a listing without Contents must error, never skip"
        );
    }
}
