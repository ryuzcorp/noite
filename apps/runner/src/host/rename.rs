//! App rename: new display name and/or slug.
//!
//! Slug is identity (subdomain, git prefix, fleet bucket, Caddy route,
//! bare mirror), so a slug change moves every artifact: stop the fleet,
//! move local dirs + both S3 prefixes, then update the DB row. The
//! reconcile loop respawns the fleet and rewrites Caddy from the DB on
//! its next tick, so no explicit restart/rewrite is needed here.
//!
//! Locking (ordering: AppLock → slug lock, see
//! [`ryuz_git::GitSync`]): this module claims the `AppLock` (bailing on an
//! in-flight deploy, 409 at the API layer) and then holds both slugs' locks
//! across the whole move so no push can write under the old prefix mid-move.
//! Those same guards are what serialize a rename against a create for the
//! target slug: the slug-taken check is repeated after both guards are held
//! (R-03), so the loser of a race bails before moving a single object.
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
            // A resume of a partially moved rename: the target already holds
            // what the earlier attempt moved, while the reconcile loop has
            // respawned the app under the old slug and recreated the source.
            // Neither tree may be merged into the other and neither is ours to
            // delete, so keep the recreated source aside and let the moved
            // target stand (a human can reconcile the salvage dir).
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default();
            let name = to.file_name().and_then(|n| n.to_str()).unwrap_or("rename");
            let salvaged = to.with_file_name(format!(".{name}.recreated-{stamp}"));
            tokio::fs::rename(from, &salvaged).await.with_context(|| {
                format!(
                    "keep a recreated rename source {} aside at {}",
                    from.display(),
                    salvaged.display()
                )
            })?;
            tracing::warn!(
                from = %from.display(),
                to = %to.display(),
                salvaged = %salvaged.display(),
                "kept a recreated rename source aside; the target already holds the moved data"
            );
            return Ok(());
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

/// Where the durable rename marker for `target` lives. The content names the
/// app and the slug it was moving from: a retry that finds its own marker
/// knows the target prefix may already hold *this app's* moved objects, so it
/// must not wipe them as a deleted tenant's leftovers.
fn rename_marker(cfg: &Config, target: &str) -> std::path::PathBuf {
    exec::work_root(cfg)
        .join("rename")
        .join(format!("{target}.json"))
}

/// One unfinished rename recorded on disk: the app, the slug it is leaving,
/// and the target whose prefix may already hold part of its data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingRename {
    pub app_id: String,
    pub from: String,
    pub to: String,
}

/// Read one marker file into its pending rename (`None` when unreadable or
/// malformed; a malformed marker is removed by [`pending_renames`]).
async fn read_marker(path: &std::path::Path) -> Option<PendingRename> {
    let to = path
        .file_name()?
        .to_str()?
        .strip_suffix(".json")?
        .to_string();
    let text = tokio::fs::read_to_string(path).await.ok()?;
    let mut lines = text.lines();
    let app_id = lines.next()?.to_string();
    let from = lines.next()?.to_string();
    if app_id.is_empty() || from.is_empty() {
        return None;
    }
    Some(PendingRename { app_id, from, to })
}

/// Whether the marker at `path` was written by `app_id` moving from `from`.
async fn marker_names_rename(path: &std::path::Path, app_id: &str, from: &str) -> bool {
    matches!(
        read_marker(path).await,
        Some(marker) if marker.app_id == app_id && marker.from == from
    )
}

/// Whether the marker at `path` belongs to `app_id` at all (any source slug):
/// a row that already names the target makes any marker of its own stale.
async fn marker_belongs_to(path: &std::path::Path, app_id: &str) -> bool {
    matches!(
        read_marker(path).await,
        Some(marker) if marker.app_id == app_id
    )
}

/// Every unfinished rename on disk, oldest first. Malformed markers are
/// removed: they reserve nothing and would block a slug forever.
pub(crate) async fn pending_renames(cfg: &Config) -> Vec<PendingRename> {
    let dir = exec::work_root(cfg).join("rename");
    let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        // `.json` only: a marker being written lives in a `.tmp` sibling, so a
        // concurrent pass can never read (and delete) a partial file.
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match read_marker(&path).await {
            Some(marker) => out.push(marker),
            None => {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    out
}

/// Whether `slug` is reserved by an unfinished rename: another create or
/// rename must not wipe or move into the prefix it may already hold data in.
pub(crate) async fn target_reserved(cfg: &Config, slug: &str) -> bool {
    tokio::fs::metadata(rename_marker(cfg, slug)).await.is_ok()
}

/// Remove every marker whose source slug is `from`: once the app left that
/// slug (a successful rename, a delete, a different rename), an attempt that
/// started there can never be resumed and must not block its target.
pub(crate) async fn forget_markers_from(cfg: &Config, from: &str) -> usize {
    let mut removed = 0;
    for marker in pending_renames(cfg).await {
        if marker.from == from {
            clear_rename_marker(cfg, &marker.to).await;
            removed += 1;
        }
    }
    removed
}

/// Durably record that `app_id` started moving `from` → `to` before the first
/// object moves. `sync_all` on the file and its directory puts the fact on
/// disk: the whole point is that it survives the crash the move might not.
async fn write_rename_marker(
    cfg: &Config,
    app_id: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    let path = rename_marker(cfg, to);
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("rename marker has no parent: {}", path.display()))?;
    tokio::fs::create_dir_all(parent).await?;
    // Write-then-rename: a concurrent `pending_renames` must never observe a
    // partial marker (it would treat it as malformed and delete it, losing the
    // reservation of a move that may already have moved data). The temp name
    // ends in `.tmp`, which the reader skips.
    let tmp = parent.join(format!(".{to}.json-{}.tmp", crate::models::new_id()));
    let write = async {
        use tokio::io::AsyncWriteExt as _;
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(format!("{app_id}\n{from}\n").as_bytes())
            .await?;
        file.sync_all().await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(e) = write {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e).with_context(|| format!("write rename marker {}", path.display()));
    }
    // The directory entry is what makes the file survive a crash; best-effort
    // (`sync_all` on a directory is not portable), the content sync above is
    // the part that matters.
    if let Ok(dir) = tokio::fs::File::open(parent).await {
        let _ = dir.sync_all().await;
    }
    Ok(())
}

/// Test hook: seed the marker a crashed attempt leaves behind, so a retry can
/// be driven without reproducing the crash.
#[cfg(test)]
pub(crate) async fn write_rename_marker_for_test(
    cfg: &Config,
    app_id: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    write_rename_marker(cfg, app_id, from, to).await
}

/// Drop a finished (or no-longer-relevant) marker. A failure here is not
/// worth failing the rename for: the caller always has a much worse outcome
/// to report if it matters.
async fn clear_rename_marker(cfg: &Config, target: &str) {
    let _ = tokio::fs::remove_file(rename_marker(cfg, target)).await;
}

/// Forget the failed-rename marker for `target`. Called on every ownership
/// change of the target slug (create, delete, a resumed purge): the attempt it
/// recorded no longer owns anything under that slug, and a later retry must
/// wipe the target instead of adopting the new owner's leftovers.
pub(crate) async fn forget_target_marker(cfg: &Config, target: &str) {
    clear_rename_marker(cfg, target).await;
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
    git_sync: &ryuz_git::GitSync,
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
        // Name only: write just the name. Writing the whole row from this
        // read would carry a stale slug/prefix back over a concurrent slug
        // rename that committed in between (review finding, 2026-11-12).
        db::rename_app_name(pool, app_id, new_name).await?;
        return db::get_app(pool, app_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("app not found"));
    }
    if !crate::lifecycle::slug_ok(cfg, new_slug) {
        anyhow::bail!("invalid slug");
    }
    let Some(_claim) = deploy::claim_wait_owned(deploying, app_id, Duration::from_secs(120)).await
    else {
        anyhow::bail!("deploy in flight; retry rename shortly");
    };
    // The row above was read *before* the claim. A delete claims the app too,
    // so it can have committed while we waited: moving the prefixes of a row
    // that no longer exists would resurrect the deleted tenant's `git/`,
    // `fleets/` and `envs/` data under our target slug, where no row and no
    // purge tombstone points at it (review finding, 2026-11-12). Nothing else
    // can change the row while the claim is ours, so this read is the one the
    // whole move must act on.
    let app = db::get_app(pool, app_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))?;
    // Derive the target from the *fresh* row: a request that named no slug is
    // a name-only rename even if a concurrent rename moved the row while this
    // one waited on the claim. Using the pre-claim slug here would move the
    // app back to it (review finding, 2026-11-12).
    let new_name = name.unwrap_or(&app.name);
    let new_slug = slug.unwrap_or(&app.slug);
    // The caller's requested slug is now the app's slug: a name-only write,
    // no move (the same branch the read above takes when nothing changed).
    if new_slug == app.slug {
        db::rename_app(
            pool,
            app_id,
            name.unwrap_or(&app.name),
            &app.slug,
            &app.subdomain,
            &app.git_prefix,
            &app.fleet_bucket,
        )
        .await?;
        // The row already names the target: if a previous attempt left its
        // marker behind (a crash after the row update), that rename is
        // applied, so the marker must not make a later rename skip a wipe.
        if marker_belongs_to(&rename_marker(cfg, new_slug), app_id).await {
            clear_rename_marker(cfg, new_slug).await;
        }
        return db::get_app(pool, app_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("app not found"));
    }
    // A background wipe of a just-deleted app on the target slug is a chore
    // with no owner: ask it to yield before we queue on its guard, exactly like
    // create does. Whatever it leaves behind is wiped below, under the guard.
    crate::host::purge::stop(new_slug);
    // R-02: pushes hold `push_guard(slug)` across git + S3 + manifest, so the
    // whole move (dirs, both S3 prefixes, row update, re-sweep) runs under
    // both slugs' guards — a push to either slug lands fully before or fully
    // after. Taken after the AppLock (ordering: AppLock → push_guard), in
    // lexical order so opposite renames cannot invert.
    let (_old_push, _new_push) = git_sync.lock_pair(&app.slug, new_slug).await;
    // R-03: the service layer's check ran before these guards. A create for
    // this slug (or another rename onto it) may have landed in between, and
    // moving our prefixes onto a live slug would overwrite that app's git
    // history. Re-check under the guards — this is the authoritative one — and
    // bail before touching anything.
    if let Some(other) = db::get_app_by_slug(pool, new_slug).await? {
        if other.id != app_id {
            anyhow::bail!("slug already taken");
        }
    }
    // Another unfinished rename owns this target: its moved objects may be
    // the only copy left, so taking the slug and wiping it would destroy them.
    // Only this app's own retry may continue past the reservation.
    let marker = rename_marker(cfg, new_slug);
    let resuming = marker_names_rename(&marker, &app.id, &app.slug).await;
    if !resuming && target_reserved(cfg, new_slug).await {
        anyhow::bail!("the target slug is being renamed; retry shortly");
    }
    // A free slug is not necessarily an EMPTY prefix: the delete that freed it
    // drops the row first and wipes in the background, so a wipe can still be
    // running, stopped, or dead with its data left behind. Move our own
    // prefixes into that and we would own another tenant's objects — and
    // `ensure_synced_locked` would rehydrate their git history into our
    // mirror. Wipe the target here, under its guard, exactly as create does,
    // so "we hold a slug" always implies "its prefixes are ours alone".
    //
    // A retry of *this* move is the exception: a failed attempt can have moved
    // some local dirs and S3 objects to the target already while the row still
    // names the old slug, so wiping the target would delete this app's own
    // data. The marker below records the attempt before the first object
    // moves; when it names this app and source slug, the wipe is skipped and
    // the idempotent move resumes.
    if resuming {
        tracing::info!(
            slug = new_slug,
            "resuming a rename whose target already holds this app's moved data"
        );
    } else {
        match crate::host::purge::purge_slug(
            cfg,
            procs,
            logs,
            git_sync,
            new_slug,
            supervisor::StopGrace::NORMAL,
            None,
            false,
        )
        .await?
        {
            crate::host::purge::Purged::Done => {
                // The target prefix is empty while we hold its guard: every
                // pending-purge tombstone for the slug is satisfied, and this
                // app owns the row from the move below. A failure only leaves
                // the tombstone for `purge::resume_pending`, which re-checks
                // the row (we hold the guard until the row write) and wipes
                // again.
                // A tombstone left behind would let the purge resume pass wipe
                // the target *after* this rename moved objects into it: fail
                // before moving anything instead.
                crate::db::clear_app_purges(pool, new_slug)
                    .await
                    .with_context(|| {
                        format!("clear the target slug's purge tombstone for {new_slug}")
                    })?;
                // Written *after* the wipe (so it never vouches for a prefix
                // the wipe did not finish) and *before* the first move.
                write_rename_marker(cfg, &app.id, &app.slug, new_slug).await?;
            }
            crate::host::purge::Purged::Stopped => {
                anyhow::bail!("the leftover wipe for the target slug was stopped")
            }
        }
    }
    let renamed = rename_slugged(cfg, pool, procs, logs, &app, new_name, new_slug).await?;
    // The row is committed to the target: the move is no longer resumable (a
    // retry takes the name-only branch), so the marker has done its job.
    // Attempts that started from the old slug are dead for the same reason.
    clear_rename_marker(cfg, new_slug).await;
    forget_markers_from(cfg, &app.slug).await;
    // The old generation ends here: its S3 prefix moved to the new slug, so
    // its seq marker must go too — otherwise a future slug reuse would skip
    // its restarted seq as stale. `applied[new_slug]` starts empty, so the
    // moved manifest is applied once on the next read.
    git_sync.forget(&app.slug).await;
    Ok(renamed)
}

/// Resume every rename an earlier attempt left unfinished (the durable
/// markers). The loop runs this on its slow tick: a crash mid-move no longer
/// needs a client retry, and until the move resolves the target slug stays
/// reserved (a create or another rename onto it is refused). Stale markers —
/// the app row is gone, already at another slug, or already at the target —
/// are removed so they can never block a slug.
pub async fn resume_pending_renames(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    git_sync: &ryuz_git::GitSync,
) -> usize {
    let mut resumed = 0;
    for marker in pending_renames(cfg).await {
        let app = match db::get_app(pool, &marker.app_id).await {
            Ok(app) => app,
            Err(e) => {
                tracing::warn!(
                    app_id = %marker.app_id,
                    error = %format!("{e:#}"),
                    "pending rename left for the next pass: could not read its app"
                );
                continue;
            }
        };
        let live = app.as_ref().is_some_and(|app| app.slug == marker.from);
        if !live {
            // The app left (deleted, or another rename completed): the attempt
            // has nothing to resume and must not keep reserving the target.
            clear_rename_marker(cfg, &marker.to).await;
            continue;
        }
        match rename_app(
            cfg,
            pool,
            procs,
            logs,
            deploying,
            git_sync,
            &marker.app_id,
            None,
            Some(&marker.to),
        )
        .await
        {
            Ok(app) => {
                resumed += 1;
                tracing::info!(
                    app_id = %app.id,
                    slug = %app.slug,
                    "resumed an unfinished rename"
                );
            }
            Err(e) => tracing::warn!(
                app_id = %marker.app_id,
                from = %marker.from,
                to = %marker.to,
                error = %format!("{e:#}"),
                "unfinished rename still pending; retrying on a later pass"
            ),
        }
    }
    resumed
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
    // The prefix changed, so keys for the old prefix must not survive
    // (SPEC, Scoped credentials); the next spawn mints the new-prefix pair.
    // R-10: a revoke failure must not vanish — warn loudly instead of `let _`.
    if let Err(e) = crate::host::credentials::revoke_app(pool, cfg, &app.id).await {
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

    // The slug (and every host under it) changed: push the table now.
    if let Err(e) = crate::host::edge_table::push_routes(pool, cfg).await {
        tracing::warn!(app_id = %app.id, error = %format!("{e:#}"), "edge push after rename");
    }
    db::get_app(pool, &app.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))
}

#[cfg(test)]
mod tests {
    use super::{
        move_dir, parse_listing_keys, pending_renames, write_rename_marker, PendingRename,
    };

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

    /// A retry after a crash can find the source recreated by a respawn while
    /// the target already holds the earlier attempt's moved data. The move
    /// must not fail (which would wedge the rename forever) nor merge or
    /// delete either tree: the recreated source is kept aside.
    #[tokio::test]
    async fn a_recreated_source_is_kept_aside_when_the_target_holds_moved_data() {
        let base =
            std::env::temp_dir().join(format!("noite-rename-salvage-{}", crate::models::new_id()));
        let from = base.join("fleets").join("old");
        let to = base.join("fleets").join("new");
        std::fs::create_dir_all(&from).expect("recreated source");
        std::fs::write(from.join("recreated.json"), "{}").expect("source file");
        std::fs::create_dir_all(&to).expect("moved target");
        std::fs::write(to.join("moved.json"), "{}").expect("target file");

        move_dir(&from, &to)
            .await
            .expect("a recreated source must not fail the retry");

        assert!(to.join("moved.json").exists(), "the moved data stays");
        assert!(!from.exists(), "the recreated source is moved aside");
        let mut salvaged = Vec::new();
        for entry in std::fs::read_dir(base.join("fleets")).expect("read fleets") {
            let entry = entry.expect("entry");
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(".new.recreated-")
            {
                salvaged.push(entry.path());
            }
        }
        assert_eq!(salvaged.len(), 1, "exactly one salvage dir is kept");
        assert!(salvaged[0].join("recreated.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A marker write is atomic: a concurrent scan sees either no marker or a
    /// complete one. A temp file mid-write must be ignored and left alone —
    /// deleting it would drop the reservation of a move already under way.
    #[tokio::test]
    async fn a_marker_is_never_observed_partially_written() {
        let base =
            std::env::temp_dir().join(format!("noite-rename-atomic-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        let dir = crate::host::exec::work_root(&cfg).join("rename");
        std::fs::create_dir_all(&dir).expect("rename dir");
        let inflight = dir.join(".slug.json-inflight.tmp");
        std::fs::write(&inflight, "app-id\nold").expect("partial temp");

        assert!(
            pending_renames(&cfg).await.is_empty(),
            "a temp file is not a marker"
        );
        assert!(inflight.exists(), "the in-flight temp is not deleted");

        write_rename_marker(&cfg, "app-id", "old", "slug")
            .await
            .expect("atomic marker write");
        assert_eq!(
            pending_renames(&cfg).await,
            vec![PendingRename {
                app_id: "app-id".into(),
                from: "old".into(),
                to: "slug".into(),
            }]
        );
        let temps: Vec<_> = std::fs::read_dir(&dir)
            .expect("read dir")
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                (path.extension().and_then(|e| e.to_str()) == Some("tmp")).then_some(path)
            })
            .collect();
        assert_eq!(temps, vec![inflight], "the write leaves no temp behind");
        let _ = std::fs::remove_dir_all(&base);
    }
}
