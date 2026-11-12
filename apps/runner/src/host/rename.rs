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

/// Reverse move for a cancel: the app kept serving under its source slug while
/// the forward attempt was pending, so the source prefix can hold objects newer
/// than the copies this attempt moved to the target. The destination wins: an
/// existing destination key is kept and only the target copy is deleted. This
/// mirrors `move_dir`'s local parking, which never overwrites an existing
/// destination tree either.
async fn move_s3_prefix_keep_destination(cfg: &Config, from: &str, to: &str) -> anyhow::Result<()> {
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
    // One listing of the destination prefix is cheaper and less racy than a
    // HEAD per moved key: every key already there is newer by definition.
    // The snapshot is sound because the caller holds the AppLock and both
    // slugs' push guards, which exclude every writer of either prefix.
    let existing_json = s3::s3_list_prefix(cfg, &bucket, &to_key).await?;
    let existing: std::collections::HashSet<String> = parse_listing_keys(&existing_json, to, from)?
        .into_iter()
        .collect();
    use futures::StreamExt;
    let moves = futures::stream::iter(keys.into_iter().map(|key| {
        let rel = key.strip_prefix(&from_key).unwrap_or(&key).to_string();
        let bucket = bucket.clone();
        let to_key = format!("{to_key}{rel}");
        let keep_existing = existing.contains(&to_key);
        async move {
            if !keep_existing {
                s3::s3_copy_key(cfg, &bucket, &key, &to_key).await?;
            }
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

/// Move this app's `move_dir` salvage trees from one slug's name to the
/// other's. The salvage belongs to the app, not to the slug: a rename that
/// commits off `from` must take `.from.recreated-*` with it, or the next create
/// of that slug would sweep the app's parked data as the new tenant's own. The
/// same holds for a cancel leaving the target's name. One failed rename does
/// not stop the rest; any failure is returned so the caller can decide (the
/// cancel keeps its marker, the committed rename only warns).
async fn relocate_salvage(cfg: &Config, from: &str, to: &str) -> anyhow::Result<()> {
    if from == to {
        return Ok(());
    }
    let root = exec::work_root(cfg);
    let plain_from = format!(".{from}.recreated-");
    let plain_to = format!(".{to}.recreated-");
    let git_from = format!(".{from}.git.recreated-");
    let git_to = format!(".{to}.git.recreated-");
    let mut failures = 0_usize;
    for (tree, from_prefix, to_prefix) in [
        ("repos", git_from.as_str(), git_to.as_str()),
        ("git-http", git_from.as_str(), git_to.as_str()),
        ("projects", plain_from.as_str(), plain_to.as_str()),
        ("fleets", plain_from.as_str(), plain_to.as_str()),
        ("builds", plain_from.as_str(), plain_to.as_str()),
        ("cache", plain_from.as_str(), plain_to.as_str()),
        ("envs", plain_from.as_str(), plain_to.as_str()),
    ] {
        let parent = root.join(tree);
        let Ok(mut entries) = tokio::fs::read_dir(&parent).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(suffix) = name.strip_prefix(from_prefix) else {
                continue;
            };
            let dest = parent.join(format!("{to_prefix}{suffix}"));
            if let Err(e) = tokio::fs::rename(entry.path(), &dest).await {
                failures += 1;
                tracing::warn!(
                    from = %entry.path().display(),
                    to = %dest.display(),
                    error = %e,
                    "could not relocate a rename salvage dir"
                );
            }
        }
    }
    if failures > 0 {
        anyhow::bail!("{failures} rename salvage dir(s) could not be relocated");
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
/// the target whose prefix may already hold part of its data, and the failed
/// automatic resume passes so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingRename {
    pub app_id: String,
    pub from: String,
    pub to: String,
    /// Failed automatic resume passes; a manual retry resets it.
    pub attempts: u32,
    /// Short class of the last failure (why the last pass could not move).
    pub last_failure: Option<String>,
    /// When the last attempt failed (ISO 8601).
    pub last_attempt_at: Option<String>,
    /// The owner asked to cancel: the pass must move the data back and never
    /// complete the forward rename, even after a crash mid-cancel.
    pub cancelling: bool,
}

/// Automatic resume passes a marker gets before it stops being retried
/// (about an hour at the loop's five-minute slow tick). A stuck rename still
/// reserves its target; the client must retry it or cancel with a rename
/// back to the marker's source.
const MAX_RESUME_ATTEMPTS: u32 = 12;

/// Read one marker file into its pending rename (`None` when unreadable or
/// malformed; a malformed marker is removed by [`pending_renames`]). Markers
/// written before the attempt fields existed parse as zero attempts.
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
    let attempts = lines
        .next()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let last_failure = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let last_attempt_at = lines
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cancelling = lines
        .next()
        .is_some_and(|value| matches!(value.trim(), "1" | "true"));
    Some(PendingRename {
        app_id,
        from,
        to,
        attempts,
        last_failure,
        last_attempt_at,
        cancelling,
    })
}

/// One marker's bytes. The failure line is flattened: a marker is one record
/// per line, and an error message must never turn into a second field.
fn marker_text(marker: &PendingRename) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}\n{}\n",
        marker.app_id,
        marker.from,
        marker.attempts,
        marker
            .last_failure
            .as_deref()
            .unwrap_or("")
            .replace('\n', " "),
        marker.last_attempt_at.as_deref().unwrap_or(""),
        if marker.cancelling { "1" } else { "" }
    )
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
/// removed (they reserve nothing). A marker whose slug fails the grammar is
/// skipped — never unlinked — so its target stays reserved: its slugs may be
/// out of grammar only because the live config (control hosts) changed.
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
            // Every slug in a marker becomes a path segment or an S3 prefix in
            // the resume/cancel passes, so only the grammar (shape and path
            // safety) is enforced here. Live-config reservations are not: a
            // control-host rename must not delete a marker written before that
            // config, which would release the target and the build uid it
            // guards. Skip it (never unlink) and let the reservation stand.
            Some(marker)
                if !crate::lifecycle::slug_grammar_ok(&marker.from)
                    || !crate::lifecycle::slug_grammar_ok(&marker.to) =>
            {
                tracing::warn!(
                    path = %path.display(),
                    from = %marker.from,
                    to = %marker.to,
                    "rename marker names a slug outside the grammar; skipping it and keeping its reservation"
                );
            }
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

/// The marker reserving `slug`, if any. Callers that answer a `409` need the
/// app and source it names, so the message can tell the owner how to cancel.
pub(crate) async fn reserved_target(cfg: &Config, slug: &str) -> Option<PendingRename> {
    read_marker(&rename_marker(cfg, slug)).await
}

/// Whether an unfinished rename of `app_id` is still on disk. A marker whose
/// app row is gone keeps that app's build uid reserved (the purge tombstone
/// carries it): the moved `builds/`/`cache/` trees under its target are still
/// owned by the uid until the resume pass wipes them.
pub(crate) async fn app_has_pending_rename(cfg: &Config, app_id: &str) -> bool {
    pending_renames(cfg)
        .await
        .iter()
        .any(|marker| marker.app_id == app_id)
}

/// fsync a directory, so an entry just created or renamed into it survives a
/// power loss. A failure is the caller's to propagate: a marker that may not
/// be on disk must never vouch for a move that already started. Filesystems
/// that cannot fsync a directory (`EINVAL`/`ENOTSUP` — some overlay and
/// network mounts) are the one exception: renaming must still work there, so
/// the unsupported call is a loud warning rather than a failed rename.
async fn sync_dir(path: &std::path::Path) -> std::io::Result<()> {
    match tokio::fs::File::open(path).await?.sync_all().await {
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported
            ) =>
        {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "directory fsync unsupported here; a rename marker may not survive a power loss"
            );
            Ok(())
        }
        other => other,
    }
}

/// Durably record that `app_id` started moving `from` → `to` before the first
/// object moves. `sync_all` on the file **and both directories** puts the fact
/// on disk: the whole point is that it survives the crash the move might not.
async fn write_rename_marker(
    cfg: &Config,
    app_id: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    write_marker(
        cfg,
        &PendingRename {
            app_id: app_id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            attempts: 0,
            last_failure: None,
            last_attempt_at: None,
            cancelling: false,
        },
    )
    .await
}

/// Atomically rewrite one marker (attempt count, last failure, time).
async fn write_marker(cfg: &Config, marker: &PendingRename) -> anyhow::Result<()> {
    let to = marker.to.as_str();
    let path = rename_marker(cfg, to);
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("rename marker has no parent: {}", path.display()))?;
    // A first creation of `rename/` must be durable in its own parent too;
    // syncing only the new directory would leave its entry to be lost.
    let created = match tokio::fs::create_dir(parent).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(parent).await?;
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(e) => {
            return Err(e)
                .with_context(|| format!("create rename marker directory {}", parent.display()))
        }
    };
    if created {
        if let Some(root) = parent.parent() {
            sync_dir(root)
                .await
                .with_context(|| format!("fsync {}", root.display()))?;
        }
    }
    // Write-then-rename: a concurrent `pending_renames` must never observe a
    // partial marker (it would treat it as malformed and delete it, losing the
    // reservation of a move that may already have moved data). The temp name
    // ends in `.tmp`, which the reader skips.
    let tmp = parent.join(format!(".{to}.json-{}.tmp", crate::models::new_id()));
    let write = async {
        use tokio::io::AsyncWriteExt as _;
        let mut file = tokio::fs::File::create(&tmp).await?;
        file.write_all(marker_text(marker).as_bytes()).await?;
        file.sync_all().await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(e) = write {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e).with_context(|| format!("write rename marker {}", path.display()));
    }
    // The directory entry is what makes the file survive a crash: without it
    // the marker can vanish while the app row still names the source, and a
    // later create would wipe the unreserved target (the moved objects' only
    // copy). Never report success — and so never start the move — on a
    // failed sync.
    sync_dir(parent)
        .await
        .with_context(|| format!("fsync rename marker directory {}", parent.display()))?;
    Ok(())
}

/// Persist one failed automatic resume pass, but only if the marker still is
/// the snapshot the pass scanned: a cancel, a commit or another pass may have
/// replaced or dropped it while this one ran, and writing the snapshot back
/// would resurrect a reservation (or a rename the owner just cancelled). The
/// target's guard is what makes the check and the write atomic. A write that
/// fails is reported as not recorded: the bound and the stuck event must never
/// advance on a count the marker does not hold.
async fn record_resume_failure(
    cfg: &Config,
    git_sync: &ryuz_git::GitSync,
    marker: &PendingRename,
    class: &str,
) -> FailureRecord {
    let _guard = git_sync.lock(&marker.to).await;
    let current = read_marker(&rename_marker(cfg, &marker.to)).await;
    if current.as_ref() != Some(marker) {
        tracing::debug!(
            target = %marker.to,
            "rename marker changed while its resume pass ran; the failure is not recorded"
        );
        return FailureRecord::NotRecorded;
    }
    let mut next = marker.clone();
    next.attempts = next.attempts.saturating_add(1);
    next.last_failure = Some(class.to_string());
    next.last_attempt_at = Some(crate::models::now_iso());
    if let Err(e) = write_marker(cfg, &next).await {
        tracing::warn!(
            target = %next.to,
            error = %format!("{e:#}"),
            "could not record a failed rename resume pass; the bound does not advance"
        );
        return FailureRecord::NotRecorded;
    }
    FailureRecord::Recorded(next)
}

/// Whether a failed resume pass made it onto the marker. Only a recorded
/// failure may move the automatic bound or raise a stuck event.
enum FailureRecord {
    Recorded(PendingRename),
    NotRecorded,
}

/// Reset a marker's failed-pass count: a manual forward retry is a fresh
/// decision by the app's owner, so the automatic bound starts over and a
/// crash-left `cancelling` flag is cleared (the retry is the newest word).
async fn reset_resume_attempts(cfg: &Config, marker: &PendingRename) {
    if marker.attempts == 0
        && marker.last_failure.is_none()
        && marker.last_attempt_at.is_none()
        && !marker.cancelling
    {
        return;
    }
    let mut next = marker.clone();
    next.attempts = 0;
    next.last_failure = None;
    next.last_attempt_at = None;
    // A manual forward retry is the latest owner decision: it also clears a
    // cancel a crash may have recorded before the retry was issued.
    next.cancelling = false;
    if let Err(e) = write_marker(cfg, &next).await {
        tracing::warn!(
            target = %next.to,
            error = %format!("{e:#}"),
            "could not reset a rename marker's failed-pass count"
        );
    }
}

/// A fixed class for the marker and the stuck app event. It is a closed set:
/// the error chain can carry store prefixes and presigned URLs (a listing
/// error names the prefix it walked), so no part of it is ever embedded.
fn failure_class(err: &anyhow::Error) -> String {
    let message = format!("{err:#}").to_lowercase();
    if message.contains("deploy in flight") {
        "deploy in flight"
    } else if message.contains("slug already taken") {
        "slug already taken"
    } else if message.contains("reserved by an unfinished rename")
        || message.contains("has an unfinished rename")
        || message.contains("being renamed")
    {
        "target reserved"
    } else if message.contains("stopped") {
        "target wipe stopped"
    } else if message.contains("s3://")
        || message.contains("s3 ")
        || message.contains("s3_")
        || message.contains("storage")
    {
        "storage move failed"
    } else if message.contains("rename marker") || message.contains("fsync") {
        "rename marker write failed"
    } else if message.contains("rename ")
        || message.contains("remove ")
        || message.contains("move ")
    {
        "local move failed"
    } else {
        "move failed"
    }
    .to_string()
}

/// One app event for a rename whose automatic passes ran out. Best effort: a
/// lost event never changes the marker's state.
async fn record_stuck_event(pool: &sqlx::SqlitePool, marker: &PendingRename, class: &str) {
    let description = format!(
        "rename to {} is stuck: {class}; retry the rename or rename back to {} to cancel",
        marker.to, marker.from
    );
    if let Err(e) = db::insert_app_event(
        pool,
        &crate::models::new_id(),
        &marker.app_id,
        "rename",
        "rename stuck",
        &description,
        "🔁",
        "{}",
        "",
        &crate::models::now_iso(),
    )
    .await
    {
        tracing::warn!(
            app_id = %marker.app_id,
            target = %marker.to,
            error = %e,
            "could not record the stuck-rename app event"
        );
    }
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

/// Test hook: seed a marker already carrying failed automatic passes, so the
/// resume bound can be driven without running twelve real failures.
#[cfg(test)]
pub(crate) async fn write_rename_marker_with_attempts_for_test(
    cfg: &Config,
    app_id: &str,
    from: &str,
    to: &str,
    attempts: u32,
    last_failure: &str,
) -> anyhow::Result<()> {
    write_marker(
        cfg,
        &PendingRename {
            app_id: app_id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            attempts,
            last_failure: Some(last_failure.to_string()),
            last_attempt_at: Some(crate::models::now_iso()),
            cancelling: false,
        },
    )
    .await
}

/// Test hook: seed a marker already recorded as cancelling, so the resume
/// pass can be driven as the crash of an interrupted cancel leaves it.
#[cfg(test)]
pub(crate) async fn write_cancelling_marker_for_test(
    cfg: &Config,
    app_id: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<()> {
    write_marker(
        cfg,
        &PendingRename {
            app_id: app_id.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            attempts: 0,
            last_failure: None,
            last_attempt_at: None,
            cancelling: true,
        },
    )
    .await
}

/// Drop a finished (or no-longer-relevant) marker. A failure here is not
/// worth failing the rename for: the caller always has a much worse outcome
/// to report if it matters.
async fn clear_rename_marker(cfg: &Config, target: &str) {
    let _ = tokio::fs::remove_file(rename_marker(cfg, target)).await;
}

/// Remove a marker and report whether it is really gone. Used where a caller
/// must not report success while the reservation still exists (the cancel:
/// its marker is the only record that the reverse move is authoritative).
async fn remove_rename_marker(cfg: &Config, target: &str) -> std::io::Result<()> {
    match tokio::fs::remove_file(rename_marker(cfg, target)).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
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
    rename_app_inner(
        cfg,
        pool,
        procs,
        logs,
        deploying,
        git_sync,
        app_id,
        name,
        slug,
        RenameOrigin::Manual,
    )
    .await
}

/// Who asked for the rename. Only a manual retry resets the marker's
/// failed-pass count and continues past the automatic bound; the resume pass
/// must never do either, and it carries the marker snapshot it acted on so a
/// concurrent cancel or commit cannot be replayed as a fresh rename.
enum RenameOrigin<'a> {
    Manual,
    Auto(&'a PendingRename),
}

impl RenameOrigin<'_> {
    fn is_manual(&self) -> bool {
        matches!(self, RenameOrigin::Manual)
    }
}

// Same reason as `rename_app`: the params are the rename's whole context.
#[allow(clippy::too_many_arguments)]
async fn rename_app_inner(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    git_sync: &ryuz_git::GitSync,
    app_id: &str,
    name: Option<&str>,
    slug: Option<&str>,
    origin: RenameOrigin<'_>,
) -> anyhow::Result<App> {
    let app = db::get_app(pool, app_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))?;
    // A rename *back* to the source is a cancel, not a no-op: the unfinished
    // attempt may already have moved local dirs and S3 objects to its target.
    // Requesting that source slug explicitly moves them back and drops the
    // marker; the app keeps the slug it has. Detected before the name-only
    // branch below, where an explicit slug equal to the current one would
    // otherwise be indistinguishable from a plain name write.
    if let Some(requested) = slug {
        if requested == app.slug {
            if let Some(pending) = pending_renames(cfg)
                .await
                .into_iter()
                .find(|marker| marker.app_id == app.id && marker.from == app.slug)
            {
                return cancel_pending_rename(
                    cfg, pool, procs, logs, deploying, git_sync, &app, name, &pending,
                )
                .await;
            }
        }
    }
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
        db::rename_app_name(pool, app_id, new_name).await?;
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
    // An unfinished rename of *this* app to a different target may already
    // have moved objects to it (a crash before the row update). Committing
    // this target would clear that marker and leave the moved objects owned
    // by nobody — a create of the other target could then wipe their only
    // copy. Only the pending move may finish; the client retries this rename
    // after it resumes, or cancels with a rename back to the source.
    for pending in pending_renames(cfg).await {
        if pending.app_id == app.id && pending.from == app.slug && pending.to != new_slug {
            anyhow::bail!(
                "this app has an unfinished rename to {}; retry it or rename back to {} to cancel",
                pending.to,
                app.slug
            );
        }
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
    // The automatic pass acts on a marker snapshot it scanned before it had
    // either guard. A cancel, a commit or another pass can have resolved that
    // marker in between — replaying the snapshot as a fresh rename would undo
    // the cancel, purge a prefix that no longer belongs to this app, or
    // recreate a reservation for a slug a new owner now holds. Only the exact
    // snapshot still on disk may act; anything else is a no-op for this pass.
    let marker = rename_marker(cfg, new_slug);
    let existing = read_marker(&marker).await;
    if let RenameOrigin::Auto(expected) = origin {
        if existing.as_ref() != Some(expected) {
            tracing::debug!(
                app_id = %app.id,
                target = %new_slug,
                "resume pass skipped: its rename marker changed since the scan"
            );
            return db::get_app(pool, app_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("app not found"));
        }
    }
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
    let resuming = existing
        .as_ref()
        .is_some_and(|pending| pending.app_id == app.id && pending.from == app.slug);
    // A manual retry of the pending target is the owner's fresh decision:
    // reset the failed-pass count (and the automatic bound with it). Done
    // under both guards, on the marker read under them, so it cannot rewrite
    // a snapshot a cancel or another pass already replaced.
    if origin.is_manual() && resuming {
        if let Some(current) = existing.as_ref() {
            reset_resume_attempts(cfg, current).await;
        }
    }
    // The file itself is the reservation, exactly like `target_reserved`: a
    // marker this pass cannot parse still guards moved data (and the resume
    // pass will remove it if it is truly malformed).
    if !resuming && tokio::fs::metadata(&marker).await.is_ok() {
        if let Some(reserved) = existing.as_ref() {
            if reserved.app_id == app.id {
                anyhow::bail!(
                    "this app has an unfinished rename to {new_slug}; retry it or rename back to {} to cancel",
                    reserved.from
                );
            }
        }
        anyhow::bail!("the slug is reserved by an unfinished rename of another app");
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
        // A retry may find the marker an earlier attempt could not confirm on
        // disk (the final directory fsync failed and the write reported an
        // error, leaving the file behind). Sync it now: a marker that may not
        // survive a crash must not vouch for data this retry moves.
        if let Some(dir) = marker.parent() {
            sync_dir(dir)
                .await
                .with_context(|| format!("fsync rename marker directory {}", dir.display()))?;
        }
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
                crate::host::purge::clear_purges_if_no_rename(cfg, pool, new_slug)
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
    let renamed = rename_slugged(cfg, pool, procs, logs, &app, name, new_slug).await?;
    // The app's salvage trees belong to it, not to the slug it is leaving: take
    // them along so the next create of the old slug cannot sweep them.
    if let Err(e) = relocate_salvage(cfg, &app.slug, new_slug).await {
        tracing::warn!(
            app_id = %app.id,
            from = %app.slug,
            to = %new_slug,
            error = %format!("{e:#}"),
            "renamed app but could not relocate its salvage dirs"
        );
    }
    // The row is committed to the target: the move is no longer resumable (a
    // retry takes the name-only branch), so the marker has done its job.
    // Markers left by other apps on the old slug are *not* touched here: a
    // slug freed by this rename can be re-created by another app, and its
    // markers are its own (the resume pass resolves stale ones per app).
    clear_rename_marker(cfg, new_slug).await;
    // The old generation ends here: its S3 prefix moved to the new slug, so
    // its seq marker must go too — otherwise a future slug reuse would skip
    // its restarted seq as stale. `applied[new_slug]` starts empty, so the
    // moved manifest is applied once on the next read.
    git_sync.forget(&app.slug).await;
    Ok(renamed)
}

/// Cancel an unfinished rename by moving whatever the attempt moved back to
/// the app's current slug, then dropping the marker. The app keeps its slug;
/// the target becomes free again. Runs under the AppLock and both slugs'
/// guards, exactly like the forward move, so a push to either slug cannot
/// interleave.
#[allow(clippy::too_many_arguments)]
async fn cancel_pending_rename(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    git_sync: &ryuz_git::GitSync,
    app: &App,
    name: Option<&str>,
    pending: &PendingRename,
) -> anyhow::Result<App> {
    let Some(_claim) = deploy::claim_wait_owned(deploying, &app.id, Duration::from_secs(120)).await
    else {
        anyhow::bail!("deploy in flight; retry rename shortly");
    };
    // The row was read before the claim: a delete can have committed while we
    // waited, and cancelling a move for a row that no longer exists would
    // resurrect its data. Re-read under the claim.
    let app = db::get_app(pool, &app.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))?;
    if app.slug != pending.from {
        anyhow::bail!("the pending rename no longer matches this app; retry shortly");
    }
    // A wipe of the target (a delete's chore, or a resume pass) must yield:
    // the target may hold this app's moved objects, which we are moving back.
    crate::host::purge::stop(&pending.to);
    let (_source_push, _target_push) = git_sync.lock_pair(&app.slug, &pending.to).await;
    // A manual retry or an overlapping pass can have resolved the marker while
    // we waited for the guards.
    if !marker_names_rename(&rename_marker(cfg, &pending.to), &app.id, &app.slug).await {
        anyhow::bail!("the pending rename changed; retry shortly");
    }
    // Record the intent before touching data, under both guards: a crash mid-
    // cancel leaves a marker the resume pass must finish as a cancel. Without
    // it, that pass would complete the forward rename instead. A failure here
    // aborts before anything moves.
    let Some(current) = read_marker(&rename_marker(cfg, &pending.to)).await else {
        anyhow::bail!("the pending rename changed; retry shortly");
    };
    let cancelling = PendingRename {
        cancelling: true,
        ..current.clone()
    };
    write_marker(cfg, &cancelling)
        .await
        .with_context(|| format!("record the cancel of rename target {}", pending.to))?;
    // The marker is not an ownership proof: under the guards, re-check the
    // target exactly like the forward move. A marker that outlived a re-create
    // must never let this cancel stop that tenant's fleet, move its dirs or
    // empty its prefixes into ours.
    if let Some(other) = db::get_app_by_slug(pool, &pending.to).await? {
        if other.id != app.id {
            anyhow::bail!("slug already taken");
        }
    }
    // Mirror the forward move: stop the source's production and environment
    // fleets (the reconcile loop respawns them from the pre-move row while the
    // cancel waits) and settle before moving data under a dying node. The
    // target can only hold a leftover of the attempt (no row names it).
    supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    supervisor::stop_environment_fleets(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    supervisor::stop_fleet(procs, &pending.to, supervisor::StopGrace::NORMAL).await;
    supervisor::stop_environment_fleets(procs, &pending.to, supervisor::StopGrace::NORMAL).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let root = exec::work_root(cfg);
    let pairs = vec![
        (
            source::bare_repo(cfg, &pending.to),
            source::bare_repo(cfg, &app.slug),
        ),
        (
            root.join("git-http").join(format!("{}.git", pending.to)),
            root.join("git-http").join(format!("{}.git", app.slug)),
        ),
        (
            root.join("projects").join(&pending.to),
            root.join("projects").join(&app.slug),
        ),
        (
            root.join("fleets").join(&pending.to),
            root.join("fleets").join(&app.slug),
        ),
        (
            root.join("builds").join(&pending.to),
            root.join("builds").join(&app.slug),
        ),
        (
            root.join("cache").join(&pending.to),
            root.join("cache").join(&app.slug),
        ),
        (
            root.join("envs").join(&pending.to),
            root.join("envs").join(&app.slug),
        ),
    ];
    for (from, to) in &pairs {
        move_dir(from, to).await?;
    }
    // Reverse of the forward move. The app kept serving under its slug while
    // the attempt was pending, so an object that exists at the destination is
    // newer than the target's copy: keep it and only delete the target copy
    // (destination-wins, mirroring `move_dir`'s local parking). A retry after
    // a partial cancel keeps whatever already returned.
    move_s3_prefix_keep_destination(
        cfg,
        &format!("s3://{}/git/{}/", cfg.s3_bucket, pending.to),
        &format!("s3://{}/git/{}/", cfg.s3_bucket, app.slug),
    )
    .await?;
    move_s3_prefix_keep_destination(
        cfg,
        &format!("s3://{}/fleets/{}/", cfg.s3_bucket, pending.to),
        &format!("s3://{}/fleets/{}/", cfg.s3_bucket, app.slug),
    )
    .await?;
    move_s3_prefix_keep_destination(
        cfg,
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(&pending.to)),
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(&app.slug)),
    )
    .await?;
    // The forward move pointed every environment row (and its in-memory log
    // ring) at the target prefix; put them back on the app's slug, or preview
    // deploys keep writing into a prefix this call frees.
    let envs = db::list_all_environments(pool).await?;
    for env in envs.iter().filter(|env| env.app_id == app.id) {
        db::set_environment_bucket(pool, &env.id, &cfg.envs_uri(&app.slug, &env.label)).await?;
        let from = supervisor::env_fleet_key(&pending.to, &env.label);
        let to = supervisor::env_fleet_key(&app.slug, &env.label);
        let ring = logs.lock().await.remove(&from).unwrap_or_default();
        if !ring.is_empty() {
            logs.lock().await.insert(to, ring);
        }
    }
    let ring = logs.lock().await.remove(&pending.to).unwrap_or_default();
    if !ring.is_empty() {
        logs.lock().await.insert(app.slug.clone(), ring);
    }
    // The app's salvage trees parked under the target's name come home with
    // it; otherwise a create of the freed target would sweep them as its own.
    // A failure keeps the marker (still `cancelling`), so the resume pass
    // retries the whole idempotent cancel instead of reporting it done.
    relocate_salvage(cfg, &pending.to, &app.slug)
        .await
        .with_context(|| format!("relocate the salvage for rename target {}", pending.to))?;
    // The target is ours no longer: the marker is what reserved it, and the
    // app row (still on its slug) is untouched. The unlink is part of the
    // cancel's contract: reporting success while the reservation survives
    // would let the next pass complete a rename the owner cancelled.
    remove_rename_marker(cfg, &pending.to)
        .await
        .with_context(|| format!("drop the cancelled rename marker for {}", pending.to))?;
    git_sync.forget(&pending.to).await;
    if let Some(name) = name {
        db::rename_app_name(pool, &app.id, name).await?;
    }
    tracing::info!(
        app_id = %app.id,
        slug = %app.slug,
        target = %pending.to,
        "cancelled an unfinished rename and moved its data back"
    );
    db::get_app(pool, &app.id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("app not found"))
}

/// Wipe what an unfinished rename moved under a target whose app row is gone,
/// then drop its marker. The moved objects belong to nobody now (a deleted
/// tenant's data under a slug no row owns) and are the only copy, so the slug
/// stays reserved — create/rename refuse it — until this succeeds.
async fn wipe_orphaned_target(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    procs: &ProcMap,
    logs: &LogState,
    git_sync: &ryuz_git::GitSync,
    marker: &PendingRename,
) -> anyhow::Result<WipeOutcome> {
    // A delete's chore may still be wiping the target: stop it and do the
    // work here, exactly like create does, instead of running two wipes of
    // one prefix.
    crate::host::purge::stop(&marker.to);
    // The guard makes "no row owns this slug" authoritative: a create or
    // rename inserts its row under it and only after wiping the prefixes.
    let _guard = git_sync.lock(&marker.to).await;
    // Overlapping passes (boot and the loop) can both have scanned this
    // marker. If one already resolved it — or a new rename replaced it —
    // this pass's snapshot is stale, and wiping would destroy the newer
    // attempt's moved data. Only the marker still on disk may act.
    let current = read_marker(&rename_marker(cfg, &marker.to)).await;
    if current.as_ref() != Some(marker) {
        return Ok(WipeOutcome::Skipped);
    }
    if db::get_app_by_slug(pool, &marker.to).await?.is_none() {
        crate::host::purge::purge_slug(
            cfg,
            procs,
            logs,
            git_sync,
            &marker.to,
            supervisor::StopGrace::FOR_DELETE,
            None,
            false,
        )
        .await?;
    }
    // A row owns the slug again: its own create wiped the prefixes before it
    // inserted the row, so nothing of the old attempt is left to preserve.
    clear_rename_marker(cfg, &marker.to).await;
    // The dead app's purge tombstone is NOT cleared here: it is the only
    // durable retry for the *source* wipe, which this pass never checked.
    // The purge resume clears it after its own (idempotent) source wipe,
    // now that no marker holds the uid back (`clear_purges_if_no_rename`).
    Ok(WipeOutcome::Wiped)
}

/// How a resume pass resolved an orphaned target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WipeOutcome {
    /// The target was wiped (or a new owner already wiped it) and the marker
    /// dropped.
    Wiped,
    /// Another pass resolved or replaced the marker since this pass scanned
    /// it; nothing was touched.
    Skipped,
}

/// Resume every rename an earlier attempt left unfinished (the durable
/// markers). The loop runs this on its slow tick: a crash mid-move no longer
/// needs a client retry, and until the move resolves the target slug stays
/// reserved (a create or another rename onto it is refused). A marker whose
/// app row is gone is resolved by wiping what it moved to the target (the
/// objects belong to nobody) before the marker is dropped, so a failed delete
/// never discards a target that still holds data. A marker whose row already
/// names the target is removed (the attempt committed; only its cleanup was
/// lost); one naming any other slug is left alone — that app may still own
/// what the attempt moved. Every failed pass is recorded on the marker; after
/// [`MAX_RESUME_ATTEMPTS`] the pass stops retrying it (recording one `rename
/// stuck` event) until the owner retries the rename or cancels it.
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
            if app.is_some() {
                // The row already names the target: the attempt committed and
                // only its marker survived (a crash before the cleanup). An
                // app at any other slug may still own what the attempt moved,
                // so its marker is left for a later rename/recovery.
                if app.as_ref().is_some_and(|app| app.slug == marker.to)
                    && marker_names_rename(
                        &rename_marker(cfg, &marker.to),
                        &marker.app_id,
                        &marker.from,
                    )
                    .await
                {
                    clear_rename_marker(cfg, &marker.to).await;
                }
                continue;
            }
            // The app is gone: whatever the attempt moved under the target
            // belongs to nobody. Wipe it, then drop the marker; the slug stays
            // reserved until the wipe is done.
            match wipe_orphaned_target(cfg, pool, procs, logs, git_sync, &marker).await {
                Ok(WipeOutcome::Wiped) => tracing::info!(
                    app_id = %marker.app_id,
                    from = %marker.from,
                    target = %marker.to,
                    "wiped the target of a deleted app's unfinished rename"
                ),
                Ok(WipeOutcome::Skipped) => tracing::debug!(
                    app_id = %marker.app_id,
                    target = %marker.to,
                    "orphaned rename target skipped: its marker changed since the scan"
                ),
                Err(e) => tracing::warn!(
                    app_id = %marker.app_id,
                    target = %marker.to,
                    error = %format!("{e:#}"),
                    "the target of a deleted app's unfinished rename is still pending; retrying on a later pass"
                ),
            }
            continue;
        }
        // A recorded cancel must be finished, never turned back into the
        // forward move: a crash mid-cancel or a failed marker unlink leaves
        // exactly this marker. The cancel is idempotent, so a later pass
        // continues where the crash stopped.
        if marker.cancelling {
            if let Some(app) = app.as_ref() {
                match cancel_pending_rename(
                    cfg, pool, procs, logs, deploying, git_sync, app, None, &marker,
                )
                .await
                {
                    Ok(_) => {
                        resumed += 1;
                        tracing::info!(
                            app_id = %marker.app_id,
                            slug = %marker.from,
                            target = %marker.to,
                            "finished a cancelled rename"
                        );
                    }
                    Err(e) => tracing::warn!(
                        app_id = %marker.app_id,
                        from = %marker.from,
                        to = %marker.to,
                        error = %format!("{e:#}"),
                        "a cancelled rename is still pending; retrying on a later pass"
                    ),
                }
            }
            continue;
        }
        // The automatic passes ran out (about an hour at the loop's slow
        // tick). Keep the reservation — its target may hold the only copy of
        // the moved data — but stop retrying until the owner retries the
        // rename or cancels with a rename back to `from`. The stuck event was
        // recorded when the last pass failed.
        if marker.attempts >= MAX_RESUME_ATTEMPTS {
            tracing::debug!(
                app_id = %marker.app_id,
                from = %marker.from,
                to = %marker.to,
                attempts = marker.attempts,
                "unfinished rename is stuck; waiting for a manual retry or cancel"
            );
            continue;
        }
        match rename_app_inner(
            cfg,
            pool,
            procs,
            logs,
            deploying,
            git_sync,
            &marker.app_id,
            None,
            Some(&marker.to),
            RenameOrigin::Auto(&marker),
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
            Err(e) => {
                let class = failure_class(&e);
                let FailureRecord::Recorded(next) =
                    record_resume_failure(cfg, git_sync, &marker, &class).await
                else {
                    // The marker this pass scanned is gone or was replaced (a
                    // cancel, a commit, another pass), or the write failed:
                    // the failure belongs to an attempt whose count the marker
                    // does not hold, so the bound and the stuck event stay put.
                    continue;
                };
                if next.attempts >= MAX_RESUME_ATTEMPTS {
                    record_stuck_event(pool, &next, &class).await;
                    tracing::warn!(
                        app_id = %marker.app_id,
                        from = %marker.from,
                        to = %marker.to,
                        attempts = next.attempts,
                        error = %format!("{e:#}"),
                        "unfinished rename is stuck; automatic resume stopped"
                    );
                } else {
                    tracing::warn!(
                        app_id = %marker.app_id,
                        from = %marker.from,
                        to = %marker.to,
                        attempts = next.attempts,
                        error = %format!("{e:#}"),
                        "unfinished rename still pending; retrying on a later pass"
                    );
                }
            }
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
    new_name: Option<&str>,
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
    let envs = db::list_all_environments(pool).await?;
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
    // The name is written only when the caller asked for one: this write lands
    // after a long move, and carrying the pre-move name back over a name-only
    // rename that committed in between would undo it (review finding,
    // 2026-11-12). Every slug-derived column always follows the move.
    match new_name {
        Some(new_name) => {
            db::rename_app(
                pool,
                &app.id,
                new_name,
                new_slug,
                &subdomain,
                &Config::git_prefix(new_slug),
                &cfg.fleets_uri(new_slug),
            )
            .await?
        }
        None => {
            db::rename_app_slug(
                pool,
                &app.id,
                new_slug,
                &subdomain,
                &Config::git_prefix(new_slug),
                &cfg.fleets_uri(new_slug),
            )
            .await?
        }
    }
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
        move_dir, parse_listing_keys, pending_renames, record_resume_failure, target_reserved,
        write_rename_marker, PendingRename,
    };

    /// A resume pass failing after a cancel or commit resolved its marker must
    /// not write the stale snapshot back: that would resurrect the reservation
    /// (and a later cancel would act on it). The compare-and-swap under the
    /// target's guard only ever updates the marker it scanned.
    #[tokio::test]
    async fn a_stale_resume_snapshot_does_not_recreate_its_marker() {
        let base =
            std::env::temp_dir().join(format!("noite-rename-stale-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        write_rename_marker(&cfg, "app-id", "old", "slug")
            .await
            .expect("marker");
        let stale = pending_renames(&cfg)
            .await
            .into_iter()
            .next()
            .expect("scanned marker");
        super::forget_target_marker(&cfg, "slug").await;
        let git_sync = ryuz_git::GitSync::default();
        assert!(
            matches!(
                record_resume_failure(&cfg, &git_sync, &stale, "storage move failed").await,
                super::FailureRecord::NotRecorded
            ),
            "a resolved marker is not rewritten"
        );
        assert!(
            pending_renames(&cfg).await.is_empty(),
            "the cancel/commit stays resolved"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A cancel moves the target's objects back over an app that kept serving
    /// under its slug: the destination's newer object must win, and only the
    /// target copy is deleted (a blind overwrite would roll back a live
    /// `own.json`/LTX write).
    #[tokio::test]
    async fn a_cancel_keeps_a_newer_destination_object() {
        let (endpoint, objects) = crate::testutil::spawn_stateful_s3_stub().await;
        let mut cfg = crate::config::config_for_tests();
        cfg.s3_endpoint = endpoint;
        {
            let mut store = objects.lock().unwrap_or_else(|p| p.into_inner());
            store.insert("fleets/new/own.json".into(), "older-target".into());
            store.insert("fleets/old/own.json".into(), "newer-source".into());
            store.insert("fleets/new/ltx.bin".into(), "only-target".into());
        }
        super::move_s3_prefix_keep_destination(
            &cfg,
            "s3://noite/fleets/new/",
            "s3://noite/fleets/old/",
        )
        .await
        .expect("reverse move");
        let store = objects.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            store.get("fleets/old/own.json").map(String::as_str),
            Some("newer-source"),
            "the app's newer object is not overwritten"
        );
        assert_eq!(
            store.get("fleets/old/ltx.bin").map(String::as_str),
            Some("only-target"),
            "a key only the target holds still moves back"
        );
        assert!(!store.contains_key("fleets/new/own.json"));
        assert!(!store.contains_key("fleets/new/ltx.bin"));
    }

    /// Marker slugs are path and prefix segments in the resume/cancel passes.
    /// A marker outside the slug grammar is skipped — never turned into a path
    /// — but it is not unlinked: the reservation it carries still guards data
    /// this pass may simply not understand.
    #[tokio::test]
    async fn a_marker_outside_the_grammar_is_skipped_but_kept() {
        let base =
            std::env::temp_dir().join(format!("noite-rename-bad-slug-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        let dir = crate::host::exec::work_root(&cfg).join("rename");
        std::fs::create_dir_all(&dir).expect("rename dir");
        std::fs::write(dir.join("evil.json"), "app-id\n../etc\n").expect("bad marker");
        assert!(pending_renames(&cfg).await.is_empty(), "the pass skips it");
        assert!(
            dir.join("evil.json").exists(),
            "the reservation is never dropped by a validation pass"
        );
        assert!(
            target_reserved(&cfg, "evil").await,
            "the target stays reserved"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A marker written before a control host was configured still passes the
    /// marker validation: `slug_ok` (live config) is not the grammar, and
    /// deleting the marker would release its target and the uid it guards.
    #[tokio::test]
    async fn a_control_host_slug_marker_survives_and_stays_reserved() {
        let base = std::env::temp_dir().join(format!(
            "noite-rename-control-slug-{}",
            crate::models::new_id()
        ));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        assert!(
            crate::lifecycle::slug_grammar_ok("api"),
            "the control host is grammar-valid"
        );
        assert!(
            !crate::lifecycle::slug_ok(&cfg, "api"),
            "and reserved by the live config"
        );
        write_rename_marker(&cfg, "app-id", "old", "api")
            .await
            .expect("marker");
        assert_eq!(pending_renames(&cfg).await.len(), 1, "the marker survives");
        assert!(
            target_reserved(&cfg, "api").await,
            "its target is still reserved"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A manual forward retry clears a `cancelling` flag a crash left behind:
    /// the latest owner decision wins.
    #[tokio::test]
    async fn a_manual_reset_clears_a_recorded_cancel() {
        let base = std::env::temp_dir().join(format!(
            "noite-rename-reset-cancel-{}",
            crate::models::new_id()
        ));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        super::write_cancelling_marker_for_test(&cfg, "app-id", "old", "new")
            .await
            .expect("cancelling marker");
        let marker = pending_renames(&cfg)
            .await
            .into_iter()
            .next()
            .expect("marker");
        assert!(marker.cancelling);
        super::reset_resume_attempts(&cfg, &marker).await;
        let marker = pending_renames(&cfg)
            .await
            .into_iter()
            .next()
            .expect("marker");
        assert!(!marker.cancelling, "the retry's decision is the newest");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The classes persisted in markers and shown to the tenant are a fixed
    /// set: a storage listing error names its prefix, and that must not leak.
    #[test]
    fn failure_classes_are_a_fixed_set() {
        let listing = anyhow::anyhow!("s3 list git/secret-slug/ denied by the store");
        assert_eq!(super::failure_class(&listing), "storage move failed");
        let local = anyhow::anyhow!("rename /data/runner/fleets/x -> /data/runner/fleets/y");
        assert_eq!(super::failure_class(&local), "local move failed");
        assert_eq!(
            super::failure_class(&anyhow::anyhow!("something odd")),
            "move failed"
        );
    }

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
                attempts: 0,
                last_failure: None,
                last_attempt_at: None,
                cancelling: false,
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
