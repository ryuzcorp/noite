//! App rename: new display name and/or slug.
//!
//! Slug is identity (subdomain, git prefix, fleet bucket, Caddy route,
//! bare mirror), so a slug change moves every artifact: stop the fleet,
//! move local dirs + both S3 prefixes, then update the DB row. The
//! reconcile loop respawns the fleet and rewrites Caddy from the DB on
//! its next tick, so no explicit restart/rewrite is needed here.
//!
//! Callers must hold no deploy: like delete, bail when the app lock is
//! claimed (409 at the API layer).
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::db;
use crate::host::cmd;
use crate::host::deploy::{self, Deploying};
use crate::host::logs::LogState;
use crate::host::source;
use crate::host::supervisor::{self, ProcMap};
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

/// `aws s3 mv --recursive`, skipped when the source prefix is empty so a
/// retry after a partial move stays a no-op instead of an error.
async fn move_s3_prefix(cfg: &Config, from: &str, to: &str) -> anyhow::Result<()> {
    let bucket = from
        .strip_prefix("s3://")
        .and_then(|s| s.split('/').next())
        .unwrap_or(&cfg.s3_bucket);
    let from_key = from.strip_prefix(&format!("s3://{bucket}/")).unwrap_or(from);
    let json = cmd::s3_list_prefix(cfg, bucket, from_key).await?;
    let empty = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|v| v.get("Contents")?.as_array().map(|c| c.is_empty()))
        .unwrap_or(true);
    if empty {
        return Ok(());
    }
    let env_owned = cmd::aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    cmd::run_cmd(
        "aws",
        &["--endpoint-url", &cfg.s3_endpoint, "s3", "mv", "--recursive", from, to],
        None,
        &env,
        Duration::from_secs(300),
    )
    .await
    .with_context(|| format!("move S3 prefix {from} → {to}"))?;
    Ok(())
}

pub async fn rename_app(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
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
        return Ok(db::get_app(pool, app_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("app not found"))?);
    }
    if !crate::lifecycle::slug_ok(new_slug) {
        anyhow::bail!("invalid slug");
    }
    if !deploy::claim_wait(deploying, app_id, Duration::from_secs(120)).await {
        anyhow::bail!("deploy in flight; retry rename shortly");
    }
    let result = rename_slugged(cfg, pool, procs, logs, &app, new_name, new_slug).await;
    deploy::release(deploying, app_id).await;
    result
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
    supervisor::stop_fleet(procs, &app.slug).await;
    // Same settle as purge: don't move S3 under a dying node.
    tokio::time::sleep(Duration::from_millis(500)).await;

    let root = cmd::work_root(cfg);
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

    // Carry the in-memory log ring to the new slug.
    let ring = logs.lock().await.remove(&app.slug).unwrap_or_default();
    if !ring.is_empty() {
        logs.lock().await.insert(new_slug.to_string(), ring);
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
    // The loop may have respawned the old-slug fleet mid-move (it reads the
    // pre-update row); kill it and re-sweep both prefixes so late writes
    // land under the new slug instead of orphaning under the old one.
    supervisor::stop_fleet(procs, &app.slug).await;
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
    Ok(db::get_app(pool, &app.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))?)
}
