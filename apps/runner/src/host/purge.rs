// Full app teardown: stop the fleet, wipe local work dirs, and empty the
// S3 prefixes that hold the git mirror + fleet durability (D1 / DO / telemetry).
// Used by DELETE /v1/apps/{id} (in the background, after the row is gone) and
// by create's leftover wipe (inline, before the new row lands).
//
// Locking (ordering: AppLock → slug lock, see [`ryuz_git::GitSync`]): callers
// hold the slug's lock before calling — delete's background purge takes it
// after the row delete, create holds it across purge → init → insert — so a
// push writing under the same prefixes (git + S3 + manifest) cannot interleave
// with the wipe. This function takes no locks itself: taking another guard for
// the same slug here would self-deadlock against the caller's.
//
// A background purge is a chore, never a gate: the delete frees the slug and
// the row immediately, and a create that wants the slug back asks
// [`PurgeStop`] to end the wipe instead of queueing behind it.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::host::logs::{self, LogState};
use crate::host::source;
use crate::host::supervisor::{self, ProcMap};
use crate::host::{exec, s3};

/// How a purge ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purged {
    /// Every local dir and S3 prefix for the slug is empty.
    Done,
    /// `stop` asked the wipe to end: the slug is being reused, and the create
    /// that asked runs its own wipe from scratch under the slug lock.
    Stopped,
}

/// The stop handle of one background purge. A create for the same slug sets
/// it before it waits for the slug lock, so a heavy wipe never delays a
/// re-create by more than its current batch.
#[derive(Debug, Default)]
pub struct PurgeStop(AtomicBool);

impl PurgeStop {
    /// Ask the wipe to end at its next batch boundary.
    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// One slug's shared stop handle and how many registrations hold it.
type Registered = (Arc<PurgeStop>, usize);

/// The background purges in flight, by slug: one shared [`PurgeStop`] per
/// slug, plus how many registrations hold it. A second registration (the
/// delete's chore racing a resume pass for the same slug, or two resume
/// passes) joins the existing handle instead of replacing it, so one
/// [`stop`] reaches every unfinished wipe of the slug. The entry goes when
/// the last registration drops.
static RUNNING: LazyLock<Mutex<HashMap<String, Registered>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn running() -> std::sync::MutexGuard<'static, HashMap<String, Registered>> {
    RUNNING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Register a background purge for `slug`. The returned guard must live for
/// the wipe's whole life: dropping it unregisters this registration.
pub fn begin(slug: &str) -> RegisteredPurge {
    let mut map = running();
    let (stop, held) = map
        .entry(slug.to_string())
        .or_insert_with(|| (Arc::new(PurgeStop::default()), 0));
    *held += 1;
    RegisteredPurge {
        slug: slug.to_string(),
        stop: stop.clone(),
    }
}

/// One registered background purge. Deregisters on drop.
pub struct RegisteredPurge {
    slug: String,
    stop: Arc<PurgeStop>,
}

impl RegisteredPurge {
    pub fn stop(&self) -> &PurgeStop {
        &self.stop
    }
}

impl Drop for RegisteredPurge {
    fn drop(&mut self) {
        let mut map = running();
        let remove = match map.get_mut(&self.slug) {
            // Only our own shared handle goes: a later generation's entry
            // (the map was emptied and the slug re-registered) is not ours.
            Some((live, held)) if Arc::ptr_eq(live, &self.stop) => {
                *held = held.saturating_sub(1);
                *held == 0
            }
            _ => false,
        };
        if remove {
            map.remove(&self.slug);
        }
    }
}

/// Ask a background purge of `slug` to end. `true` when one was running.
pub fn stop(slug: &str) -> bool {
    let live = running().get(slug).map(|(stop, _)| stop.clone());
    match live {
        Some(stop) => {
            stop.stop();
            true
        }
        None => false,
    }
}

/// Whether a wipe of `slug` is already registered: a delete's chore or an
/// earlier resume pass (`resume_pending` leaves such a slug alone).
pub fn is_running(slug: &str) -> bool {
    running().contains_key(slug)
}

/// What one [`resume_pending`] pass found and did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeResume {
    /// Tombstones read from `app_purge`.
    pub pending: usize,
    /// Tombstones cleared because their slug's prefixes are empty.
    pub cleared: usize,
    /// Tombstones whose wipe failed (the S3 store, a local dir): left for the
    /// next pass.
    pub failed: usize,
}

impl PurgeResume {
    /// Whether the pass has anything an operator should see in the log.
    pub fn noteworthy(&self) -> bool {
        self.cleared > 0 || self.failed > 0
    }
}

/// Remove one CI-cache volume by name. `kill_on_drop` + a bound keep a hung
/// container CLI from pinning the caller: the reconcile sweep retries whatever
/// this leaves behind, so a failure only logs.
async fn remove_ci_volume(cfg: &Config, name: &str) -> anyhow::Result<()> {
    let run = tokio::process::Command::new(&cfg.ci_docker_bin)
        .args(["volume", "rm", "-f", name])
        .kill_on_drop(true)
        .output();
    let out = match tokio::time::timeout(Duration::from_secs(30), run).await {
        Err(_) => anyhow::bail!("remove CI cache volume {name}: timed out"),
        // No container CLI on this host: no workflow ever created a volume
        // here, so there is nothing to remove.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(result) => result?,
    };
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    // A volume that is already gone is what the removal wanted.
    if no_such_volume(&stderr) {
        return Ok(());
    }
    anyhow::bail!("remove CI cache volume {name}: {}", stderr.trim())
}

/// Whether the CLI said the volume is not there (docker says "no such
/// volume", podman "no such object" or "volume … not found"). Only these
/// shapes: a bare "not found" can be a missing context or plugin, which is a
/// failure the sweep must retry, not a removal.
fn no_such_volume(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("no such volume")
        || text.contains("no such object")
        || (text.contains("volume") && text.contains("not found"))
}

/// The fast path after a delete: remove the deleted app's own CI cache volume.
/// Best-effort by contract and never on a caller's critical path — the caller
/// runs it detached, outside the slug guard, and [`reconcile_ci_caches`] is
/// the durable retry. The tombstone clear never waits on it.
pub async fn remove_ci_cache_volume(cfg: &Config, app_id: &str) -> anyhow::Result<()> {
    let name = crate::host::deploy::ci_cache_volume(cfg, app_id);
    remove_ci_volume(cfg, &name).await
}

/// Remove every CI cache volume that no live app owns.
///
/// The volume is keyed by this install's tag and the app id
/// ([`crate::host::deploy::ci_cache_volume`]), so a volume named after a slug,
/// a deleted app, or an app whose wipe died is garbage nobody mounts again.
/// This pass is the durable cleanup for all of them (the delete's own removal
/// is a fast path): it lists the volumes by the shared prefix and drops every
/// name in *this install's* namespace whose suffix is not an existing app's
/// id. Volumes without this install's tag belong to another install sharing
/// the daemon (or to a build from before the tag existed) and are never
/// touched. Non-fatal throughout — it runs at boot and on the slow loop tick,
/// never under a slug guard, and a failing pass only leaves the volumes for
/// the next one.
pub async fn reconcile_ci_caches(cfg: &Config, pool: &sqlx::SqlitePool) -> usize {
    let listed = tokio::process::Command::new(&cfg.ci_docker_bin)
        .args([
            "volume",
            "ls",
            "--filter",
            "name=noite-ci-cache-",
            "--format",
            "{{.Name}}",
        ])
        .kill_on_drop(true)
        .output();
    let listed = match tokio::time::timeout(Duration::from_secs(30), listed).await {
        Ok(Ok(out)) if out.status.success() => out,
        // No container CLI on this host, or none this process may talk to:
        // there is nothing to reconcile here.
        Ok(Ok(out)) => {
            tracing::debug!(
                error = %String::from_utf8_lossy(&out.stderr).trim(),
                "CI cache volume listing refused; skipping the sweep"
            );
            return 0;
        }
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "no container CLI for the CI cache sweep");
            return 0;
        }
        Err(_) => {
            tracing::warn!("CI cache volume listing timed out; retrying on a later pass");
            return 0;
        }
    };
    // Load-bearing order: list the volumes first, then snapshot the live ids.
    // A volume only exists because a deploy of an existing row created it, so
    // an id snapshot taken *after* the listing contains every live owner; a
    // snapshot taken first would let an app created in between lose its new
    // volume.
    let live: std::collections::HashSet<String> = match crate::db::app_ids(pool).await {
        Ok(ids) => ids.into_iter().collect(),
        Err(e) => {
            tracing::warn!(error = %e, "CI cache sweep could not read the app ids");
            return 0;
        }
    };
    let ours = crate::host::deploy::ci_cache_volume_install_prefix(cfg);
    let listing = String::from_utf8_lossy(&listed.stdout);
    let mut removed = 0;
    for name in listing.lines().map(str::trim) {
        // Only this install's namespace: a foreign install's volume (or a
        // pre-tag name) is not ours to remove, and treating its suffix as a
        // local app id would delete another installation's active cache.
        let Some(suffix) = name.strip_prefix(&ours) else {
            continue;
        };
        if live.contains(suffix) {
            continue;
        }
        match remove_ci_volume(cfg, name).await {
            Ok(()) => removed += 1,
            Err(e) => {
                tracing::warn!(volume = name, error = %format!("{e:#}"), "could not remove an orphaned CI cache volume; retrying on a later pass")
            }
        }
    }
    removed
}

/// Clear the purge tombstones of `slug` once its prefixes are empty — unless a
/// deleted app's unfinished rename still exists. Its target may hold the
/// `builds/`/`cache/` trees that app's build uid owns, and the tombstone is
/// the allocator's record of that uid; the rename resume pass clears the
/// tombstone after it wipes the target and drops the marker.
pub(crate) async fn clear_purges_if_no_rename(
    cfg: &Config,
    pool: &sqlx::SqlitePool,
    slug: &str,
) -> sqlx::Result<u64> {
    let mut cleared = 0;
    for app_id in crate::db::purge_app_ids(pool, slug).await? {
        if crate::host::rename::app_has_pending_rename(cfg, &app_id).await {
            tracing::info!(
                slug,
                app_id = %app_id,
                "keeping a deleted app's purge tombstone: an unfinished rename still owns its build uid"
            );
            continue;
        }
        cleared += crate::db::clear_app_purges_for_app(pool, &app_id).await?;
    }
    Ok(cleared)
}

/// Resume every wipe the durable tombstones (`app_purge`) still owe.
///
/// A hard delete writes its tombstone in the same transaction as the row
/// (`db::delete_app`), so a crash, an S3 failure or a wipe a re-create
/// stopped can never lose the fact that the tenant's `git/`, `fleets/` and
/// `envs/` data is still in the bucket. This pass runs at boot and on the
/// reconcile loop's slow tick, paced like every background wipe (the S3
/// batches are serialized process-wide, see `s3::s3_rm_prefix_paced`), and is
/// stoppable: a create or rename that wants the slug calls [`stop`] like it
/// does for the delete's own chore and then wipes authoritatively.
///
/// Each slug is handled like that chore: take its push guard, then skip (and
/// clear) when a row already owns the slug — the create/rename that inserted
/// it wiped the prefixes under this same guard, so every tombstone for the
/// slug is satisfied. A wipe that ends `Done` with no row, or that is stopped
/// and then finished by the taker, clears the tombstones too; an error keeps
/// them for the next pass. Never fatal: the caller logs and boots on.
pub async fn resume_pending(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    log_state: &LogState,
    git_sync: &ryuz_git::GitSync,
) -> PurgeResume {
    let tombstones = match crate::db::pending_purges(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "pending app purges unreadable; leaving them for the next pass");
            return PurgeResume::default();
        }
    };
    let mut report = PurgeResume {
        pending: tombstones.len(),
        ..PurgeResume::default()
    };
    for slug in tombstones {
        // A delete's own chore (or an earlier pass) is already wiping it; two
        // wipes of one prefix would only duplicate the store load.
        if is_running(&slug) {
            continue;
        }
        // An unfinished rename reserves this slug: the prefix may already hold
        // objects the attempt moved there, and wiping it would destroy their
        // only copy (the rename's own resume pass owns the slug now).
        if crate::host::rename::target_reserved(cfg, &slug).await {
            tracing::debug!(
                slug,
                "pending purge skipped: an unfinished rename owns the slug"
            );
            continue;
        }
        let registered = begin(&slug);
        // Holding the guard is what makes the check and the clear authoritative:
        // a create/rename inserts its row under this same guard and only after
        // wiping the prefixes, so "no row now" cannot change under the wipe.
        let guard = git_sync.lock(&slug).await;
        // A rename can have reserved the slug while this pass waited for the
        // guard; re-check under it, exactly like the row check below.
        if crate::host::rename::target_reserved(cfg, &slug).await {
            tracing::debug!(
                slug,
                "pending purge skipped: a rename reserved the slug while we waited"
            );
            continue;
        }
        // `Ok(true)`: the prefixes are empty (or the taker's wipe made them so)
        // and every tombstone for the slug can go. `Ok(false)`: a create took
        // the slug and stopped the wipe; it clears the tombstone itself once its
        // own wipe is done.
        let satisfied = match crate::db::get_app_by_slug(pool, &slug).await {
            Ok(Some(_)) => {
                tracing::debug!(slug, "pending purge satisfied: a new app owns the slug");
                Ok(true)
            }
            Ok(None) => match purge_slug(
                cfg,
                procs,
                log_state,
                git_sync,
                &slug,
                supervisor::StopGrace::FOR_DELETE,
                Some(registered.stop()),
                false,
            )
            .await
            {
                Ok(Purged::Done) => {
                    tracing::info!(slug, "resumed purge emptied the slug's data");
                    Ok(true)
                }
                Ok(Purged::Stopped) => {
                    tracing::info!(slug, "resumed purge stopped: the slug is being reused");
                    Ok(false)
                }
                Err(e) => Err(e),
            },
            Err(e) => Err(e.into()),
        };
        match satisfied {
            Ok(true) => {
                match clear_purges_if_no_rename(cfg, pool, &slug).await {
                    Ok(_) => report.cleared += 1,
                    Err(e) => {
                        tracing::warn!(slug, error = %e, "pending purge wiped the slug but could not clear its tombstone");
                        report.failed += 1;
                    }
                }
                // The resume pass wiped the target (or a new owner did): a
                // failed-rename marker for it no longer describes anything a
                // retry may resume onto.
                crate::host::rename::forget_target_marker(cfg, &slug).await;
            }
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(slug, error = %format!("{e:#}"), "pending purge failed; retrying on a later pass");
                report.failed += 1;
            }
        }
        drop(guard);
        drop(registered);
    }
    report
}

/// Wipe every on-disk and S3 artifact for `slug`. Does **not** touch the DB row
/// — callers decide when to delete that (create wipes before inserting the
/// new row; delete deletes the row first).
///
/// Requires the caller to hold the slug's `push_guard` (see the module docs).
/// Order matters inside, too: stop celld first so it cannot rewrite leases /
/// D1 / telemetry into the prefix we are about to empty.
///
/// `stop` is only for a background purge: `None` runs to completion, which is
/// what create needs (the new row must not land on a half-wiped prefix).
///
/// `fleets_stopped` is the caller's `supervisor::any_fleet` answer from
/// *before* it stopped this slug's fleets (delete does that before handing the
/// wipe to the background). A stop removes the map entries, so the wipe cannot
/// rediscover them; carrying the fact keeps the settle wait when a node was
/// really killed (an `aws rm` racing a dying node corrupts its LTX chain).
#[allow(clippy::too_many_arguments)] // matches the callers' state; a params struct would too
pub async fn purge_slug(
    cfg: &Config,
    procs: &ProcMap,
    log_state: &LogState,
    git_sync: &ryuz_git::GitSync,
    slug: &str,
    grace: supervisor::StopGrace,
    stop: Option<&PurgeStop>,
    fleets_stopped: bool,
) -> anyhow::Result<Purged> {
    // The generation ends here: drop the seq marker first, so a failed purge
    // still converges on a full manifest sync instead of skipping a restarted
    // seq as stale. The caller holds the slug's `push_guard`, so no push can
    // interleave with the wipe.
    git_sync.forget(slug).await;
    let hull_stopped = || stop.is_some_and(PurgeStop::stopped);
    if hull_stopped() {
        return Ok(Purged::Stopped);
    }
    // Per-step durations go on the final log line: a delete that takes tens
    // of seconds (seen in CI, 2026-10-22) must name its slow step.
    let started = std::time::Instant::now();
    let ms =
        |since: std::time::Instant| u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX);
    let had_fleet = fleets_stopped || supervisor::any_fleet(procs, slug).await;
    supervisor::stop_fleet(procs, slug, grace).await;
    // Preview environments are fleets of their own (`slug.label`): they share
    // this app's data, so they go down before it is cleared. Their rows go
    // with the app row (FK cascade); `envs/<slug>/` is cleared below.
    supervisor::stop_environment_fleets(procs, slug, grace).await;
    // Brief settle, and only when something was running: aws rm racing a
    // dying node leaves incomplete LTX chains (own.json epoch N, ltX only
    // under e1) → D1 RestoreFailed on next boot. A wipe with no fleet (the
    // common case for a re-created slug) must not sleep.
    if had_fleet {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    logs::clear(log_state, slug).await;
    let stop_ms = ms(started);
    if hull_stopped() {
        return Ok(Purged::Stopped);
    }

    let local = std::time::Instant::now();
    let root = exec::work_root(cfg);
    for path in [
        source::bare_repo(cfg, slug),
        root.join("git-http").join(format!("{slug}.git")),
        root.join("projects").join(slug),
        root.join("fleets").join(slug),
        root.join("builds").join(slug),
        // T5.1: the persistent bun cache is per-app tenant data too.
        root.join("cache").join(slug),
        // Every preview environment's state dir (one tree, `envs/<slug>/`).
        root.join("envs").join(slug),
    ] {
        if hull_stopped() {
            return Ok(Purged::Stopped);
        }
        if path.exists() {
            tokio::fs::remove_dir_all(&path)
                .await
                .with_context(|| format!("remove {}", path.display()))?;
        }
    }
    // `move_dir` parks a recreated source as `.<slug>.recreated-<ts>` next to
    // its target when a rename is retried while the reconcile loop has already
    // recreated the old state dir. Those trees are this slug's own salvage, so
    // the wipe is the last place that can remove them; the exact prefix
    // (`.<slug>.recreated-`) keeps a neighbouring slug untouched (`ab` vs
    // `abc`).
    remove_recreated_siblings(cfg, slug).await?;
    let local_ms = ms(local);

    // git/  — tip bundles + refs (source of truth for redeploy)
    // fleets/ — celld durability: D1 sqlite, DO state, peer-auth, telemetry
    // envs/ — every environment's own celld durability (its own D1/DO/R2)
    let mut step = std::time::Instant::now();
    let mut s3_git_ms = 0;
    let mut s3_fleets_ms = 0;
    let mut s3_envs_ms = 0;
    for (index, prefix) in [
        format!("s3://{}/git/{slug}/", cfg.s3_bucket),
        format!("s3://{}/fleets/{slug}/", cfg.s3_bucket),
        format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(slug)),
    ]
    .into_iter()
    .enumerate()
    {
        if hull_stopped() {
            return Ok(Purged::Stopped);
        }
        clear_s3_prefix(cfg, &prefix, stop).await?;
        let ms_done = ms(step);
        match index {
            0 => s3_git_ms = ms_done,
            1 => s3_fleets_ms = ms_done,
            _ => s3_envs_ms = ms_done,
        }
        step = std::time::Instant::now();
    }
    // A stop during the *last* prefix's wipe makes `clear_s3_prefix` return
    // `Ok(())` with objects left behind; without this check the caller would
    // see `Done` and clear the tombstone that owes the cleanup.
    if hull_stopped() {
        return Ok(Purged::Stopped);
    }
    tracing::info!(
        slug,
        total_ms = ms(started),
        stop_ms,
        local_ms,
        s3_git_ms,
        s3_fleets_ms,
        s3_envs_ms,
        "purged local + S3 app data"
    );
    Ok(Purged::Done)
}

/// Remove the `.<slug>.recreated-<ts>` salvage dirs `move_dir` leaves under
/// the per-app trees. Matching is by exact prefix, leading dot included, so a
/// slug that is a prefix of another (`ab` vs `abc`) never loses its data. The
/// bare-repo trees name their entries `<slug>.git`, so their salvage dirs are
/// `.<slug>.git.recreated-…`; `envs/` holds the per-environment durability and
/// is swept the same way as the rest of the app's local data.
async fn remove_recreated_siblings(cfg: &Config, slug: &str) -> anyhow::Result<()> {
    let root = exec::work_root(cfg);
    let plain = format!(".{slug}.recreated-");
    let git = format!(".{slug}.git.recreated-");
    for (tree, prefix) in [
        ("repos", git.as_str()),
        ("git-http", git.as_str()),
        ("projects", plain.as_str()),
        ("fleets", plain.as_str()),
        ("builds", plain.as_str()),
        ("cache", plain.as_str()),
        ("envs", plain.as_str()),
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
            if !name.starts_with(prefix) {
                continue;
            }
            let path = entry.path();
            if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                tokio::fs::remove_dir_all(&path)
                    .await
                    .with_context(|| format!("remove recreated rename dir {}", path.display()))?;
            }
        }
    }
    Ok(())
}

async fn clear_s3_prefix(
    cfg: &Config,
    prefix: &str,
    stop: Option<&PurgeStop>,
) -> anyhow::Result<()> {
    let bucket = prefix
        .strip_prefix("s3://")
        .and_then(|s| s.split('/').next())
        .unwrap_or(&cfg.s3_bucket)
        .to_string();
    let key = prefix
        .strip_prefix(&format!("s3://{bucket}/"))
        .unwrap_or(prefix);
    // Only a background purge is paced and stoppable; the create's own wipe
    // runs unpaced under the slug lock, since it is the authoritative one and
    // the caller already bounds it.
    let finished = match stop {
        Some(stop) => {
            let stopped = || stop.stopped();
            s3::s3_rm_prefix_paced(cfg, &bucket, key, &stopped)
                .await
                .with_context(|| format!("clear S3 prefix {prefix}"))?
        }
        None => {
            s3::s3_rm_prefix(cfg, &bucket, key)
                .await
                .with_context(|| format!("clear S3 prefix {prefix}"))?;
            true
        }
    };
    // A paced wipe answers `false` only on a stop; the caller's own check at
    // the top of the loop reports [`Purged::Stopped`].
    let stopped = || stop.is_some_and(PurgeStop::stopped);
    if !finished && !stopped() {
        anyhow::bail!("clear S3 prefix {prefix} ended early");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::models::EnvironmentKind;

    /// A purge covers `envs/<slug>/` — the local state dirs, the bucket prefix
    /// and every environment fleet of the app — so an app delete leaves no
    /// preview behind (ROADMAP: purge covers `envs/<slug>/` and its rows).
    #[tokio::test]
    async fn purge_covers_environment_data() {
        let base =
            std::env::temp_dir().join(format!("noite-purge-envs-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "purge",
                slug: "purge",
                user_id: "local",
                subdomain: "purge.localhost",
                listen: 30200,
                internal: 30201,
            },
        )
        .await
        .expect("app");
        db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "purge",
                label: "feature",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/feature",
                created_by: "user_1",
                listen: 30210,
                internal: 30211,
            },
        )
        .await
        .expect("environment");

        // A local env state dir and a running env fleet.
        let state_dir = crate::host::supervisor::env_state_dir(&cfg, "purge", "feature");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("deploy.json"), "{}").unwrap();
        let procs = crate::host::supervisor::new_procs();
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn");
        let pid = child.id().expect("pid");
        procs.lock().await.insert(
            crate::host::supervisor::env_fleet_key("purge", "feature"),
            crate::host::supervisor::FleetEntry::test_entry(child),
        );

        // The production contract: callers hold the slug's push guard across
        // the purge so no push writes under the wiped prefixes mid-teardown.
        let git_sync = ryuz_git::GitSync::default();
        let _push = git_sync.lock("purge").await;
        let ended = purge_slug(
            &cfg,
            &procs,
            &crate::host::logs::new_state(),
            &git_sync,
            "purge",
            crate::host::supervisor::StopGrace::NORMAL,
            None,
            false,
        )
        .await
        .expect("purge");

        assert_eq!(ended, Purged::Done);
        assert!(!state_dir.exists(), "the environment state dir is wiped");
        assert!(
            !procs
                .lock()
                .await
                .contains_key(&crate::host::supervisor::env_fleet_key("purge", "feature")),
            "the environment fleet is stopped"
        );
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        // The row survives purge (the caller deletes the app row, whose
        // cascade takes the environment rows with it).
        assert_eq!(
            db::list_environments(&pool, &app.id).await.unwrap().len(),
            1
        );
        db::delete_app(&pool, &app.id).await.expect("delete app");
        assert!(db::list_environments(&pool, &app.id)
            .await
            .unwrap()
            .is_empty());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A wipe that a reused slug asks to stop ends before it touches the
    /// prefix: the create that asked then wipes from scratch itself, so the
    /// two never fight over the same keys.
    #[tokio::test]
    async fn a_stopped_purge_leaves_the_prefix_for_the_next_caller() {
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = std::env::temp_dir()
            .join(format!("noite-purge-stop-{}", crate::models::new_id()))
            .to_string_lossy()
            .into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let procs = crate::host::supervisor::new_procs();
        let git_sync = ryuz_git::GitSync::default();
        let _push = git_sync.lock("stopped").await;
        let stop = PurgeStop::default();
        stop.stop();
        let ended = purge_slug(
            &cfg,
            &procs,
            &crate::host::logs::new_state(),
            &git_sync,
            "stopped",
            crate::host::supervisor::StopGrace::NORMAL,
            Some(&stop),
            false,
        )
        .await
        .expect("purge");
        assert_eq!(ended, Purged::Stopped);
        let _ = std::fs::remove_dir_all(&cfg.work_dir);
    }

    /// A wipe removes the `.<slug>.recreated-<ts>` salvage dirs a rename's
    /// `move_dir` leaves behind, and only for that exact slug: a neighbouring
    /// slug that starts with the same text (`ab` vs `abc`) keeps its data.
    #[tokio::test]
    async fn a_purge_removes_only_this_slugs_recreated_dirs() {
        let scratch = crate::testutil::TempDir::new("noite-purge-recreated");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let root = crate::host::exec::work_root(&cfg);
        // `repos/` and `git-http/` name their entries `<slug>.git`, so their
        // salvage dirs carry the `.git` infix; the rest are plain.
        for (tree, own, salvage, other, other_salvage) in [
            (
                "repos",
                "ab.git",
                ".ab.git.recreated-100",
                "abc.git",
                ".abc.git.recreated-100",
            ),
            (
                "git-http",
                "ab.git",
                ".ab.git.recreated-100",
                "abc.git",
                ".abc.git.recreated-100",
            ),
            (
                "projects",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "fleets",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "builds",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "cache",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "envs",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
        ] {
            for name in [own, salvage, other_salvage, other] {
                let path = root.join(tree).join(name);
                std::fs::create_dir_all(&path).expect("fixture dir");
                std::fs::write(path.join("keep.json"), "{}").expect("fixture file");
            }
        }
        let git_sync = ryuz_git::GitSync::default();
        let _push = git_sync.lock("ab").await;
        let ended = purge_slug(
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &git_sync,
            "ab",
            crate::host::supervisor::StopGrace::NORMAL,
            None,
            false,
        )
        .await
        .expect("purge");
        assert_eq!(ended, Purged::Done);
        for (tree, own, salvage, other, other_salvage) in [
            (
                "repos",
                "ab.git",
                ".ab.git.recreated-100",
                "abc.git",
                ".abc.git.recreated-100",
            ),
            (
                "git-http",
                "ab.git",
                ".ab.git.recreated-100",
                "abc.git",
                ".abc.git.recreated-100",
            ),
            (
                "projects",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "fleets",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "builds",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "cache",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
            (
                "envs",
                "ab",
                ".ab.recreated-100",
                "abc",
                ".abc.recreated-100",
            ),
        ] {
            assert!(
                !root.join(tree).join(salvage).exists(),
                "{tree}: the slug's salvage dir is removed"
            );
            assert!(
                !root.join(tree).join(own).exists(),
                "{tree}: the slug's own dir is wiped"
            );
            assert!(
                root.join(tree).join(other_salvage).exists(),
                "{tree}: a longer slug's salvage dir is untouched"
            );
            assert!(
                root.join(tree).join(other).exists(),
                "{tree}: a longer slug's dir is untouched"
            );
        }
    }

    /// The delete path stops the app's fleets before it hands the wipe to the
    /// background task, so the process map is already empty when the wipe
    /// looks. The caller's carried fact keeps the settle wait that protects a
    /// just-killed node's LTX chain from racing the `aws rm`.
    #[tokio::test]
    async fn a_wipe_after_a_caller_stop_still_settles() {
        let scratch = crate::testutil::TempDir::new("noite-purge-settle");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let git_sync = ryuz_git::GitSync::default();
        let _push = git_sync.lock("settled").await;
        let started = std::time::Instant::now();
        let ended = purge_slug(
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &git_sync,
            "settled",
            crate::host::supervisor::StopGrace::NORMAL,
            None,
            true,
        )
        .await
        .expect("purge");
        assert_eq!(ended, Purged::Done);
        assert!(
            started.elapsed() >= Duration::from_millis(500),
            "a wipe that follows the caller's stop must still settle"
        );
    }

    /// One shared handle per slug: a second registration joins the running
    /// wipe's stop, so a create's `stop` reaches every unfinished purge of the
    /// slug (a delete's chore and a resume pass can overlap). The entry goes
    /// with the last registration, and the next generation starts fresh.
    #[test]
    fn the_purge_registry_tracks_one_live_handle_per_slug() {
        let first = begin("registry-slug");
        assert!(stop("registry-slug"));
        assert!(first.stop().stopped());
        let second = begin("registry-slug");
        assert!(
            second.stop().stopped(),
            "a second registration shares the live stop handle"
        );
        drop(first);
        assert!(
            stop("registry-slug"),
            "the surviving registration keeps the handle live"
        );
        assert!(second.stop().stopped());
        drop(second);
        assert!(!stop("registry-slug"), "nothing left to stop");
        let next = begin("registry-slug");
        assert!(!next.stop().stopped(), "a new generation starts unstopped");
        drop(next);
    }

    /// A store that answers the first two listings empty and the third (the
    /// `envs/` prefix) with one key, then sets the stop flag when it receives
    /// that key's delete. The stop therefore lands during the *last* prefix.
    async fn spawn_stop_on_last_listing(stop: Arc<PurgeStop>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stop s3");
        let addr = listener.local_addr().expect("addr");
        let listed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let stop = stop.clone();
                let listed = listed.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 16384];
                    let read = sock.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    let is_list = request.starts_with("GET ") && request.contains("list-type=2");
                    let body = if request.starts_with("POST ") {
                        // The only delete this purge sends is the envs/ key.
                        stop.stop();
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                         <DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>"
                            .to_string()
                    } else if is_list && listed.fetch_add(1, Ordering::SeqCst) == 2 {
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                         <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                         <Name>noite</Name><Prefix>envs/stoplast/</Prefix><MaxKeys>1000</MaxKeys>\
                         <IsTruncated>false</IsTruncated>\
                         <Contents><Key>envs/stoplast/feature/durable.sqlite</Key>\
                         <LastModified>2026-11-12T00:00:00.000Z</LastModified>\
                         <ETag>\"abc\"</ETag><Size>1</Size></Contents>\
                         </ListBucketResult>"
                            .to_string()
                    } else {
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                         <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                         <Name>noite</Name><MaxKeys>1000</MaxKeys>\
                         <IsTruncated>false</IsTruncated></ListBucketResult>"
                            .to_string()
                    };
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// The stop checks between prefixes miss a stop that lands while the last
    /// prefix is being wiped. `Done` there would let the caller clear the
    /// tombstone that owes the leftover cleanup.
    #[tokio::test]
    async fn a_stop_during_the_last_prefix_is_not_reported_as_done() {
        let scratch = crate::testutil::TempDir::new("noite-purge-last-stop");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        let stop = Arc::new(PurgeStop::default());
        cfg.s3_endpoint = spawn_stop_on_last_listing(stop.clone()).await;
        let git_sync = ryuz_git::GitSync::default();
        let _push = git_sync.lock("stoplast").await;
        let ended = purge_slug(
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &git_sync,
            "stoplast",
            crate::host::supervisor::StopGrace::NORMAL,
            Some(stop.as_ref()),
            false,
        )
        .await
        .expect("purge");
        assert_eq!(
            ended,
            Purged::Stopped,
            "a stop during the last prefix must keep the tombstone"
        );
    }

    /// A store that refuses every request with a final 4xx, so the resume pass
    /// sees a deterministic S3 failure (no internal retry/backoff).
    async fn spawn_denied_s3() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind denied s3");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let body = "<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>denied</Message></Error>";
                    let resp = format!(
                        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// One slug's deleted app with its purge still owed: a row insert, a local
    /// dir a wipe must remove, then the hard delete that writes the tombstone.
    async fn tombstoned_slug(
        cfg: &Config,
        slug: &'static str,
    ) -> (sqlx::SqlitePool, crate::models::App) {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            cfg,
            db::NewApp {
                name: slug,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30300,
                internal: 30301,
            },
        )
        .await
        .expect("app");
        let dir = crate::host::exec::work_root(cfg)
            .join("projects")
            .join(slug);
        std::fs::create_dir_all(&dir).expect("seed dir");
        std::fs::write(dir.join("deploy.json"), "{}").expect("seed file");
        db::delete_app(&pool, &app.id).await.expect("delete row");
        (pool, app)
    }

    /// F1: a delete that dropped the row and then died (a crash, a restart or
    /// an upgrade mid-wipe) leaves the durable tombstone; the boot resume wipes
    /// the slug and clears it.
    #[tokio::test]
    async fn a_crash_between_the_row_delete_and_the_wipe_is_resumed() {
        let scratch = crate::testutil::TempDir::new("noite-purge-resume");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let (pool, _app) = tombstoned_slug(&cfg, "resumed").await;
        assert_eq!(
            db::pending_purges(&pool).await.expect("tombstones"),
            vec!["resumed".to_string()],
            "the row delete must write the tombstone in the same transaction"
        );

        let report = resume_pending(
            &pool,
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &ryuz_git::GitSync::default(),
        )
        .await;

        assert_eq!(report.pending, 1);
        assert_eq!(report.cleared, 1);
        assert_eq!(report.failed, 0);
        assert!(
            db::pending_purges(&pool)
                .await
                .expect("tombstones")
                .is_empty(),
            "a finished wipe clears the tombstone"
        );
        assert!(
            !crate::host::exec::work_root(&cfg)
                .join("projects")
                .join("resumed")
                .exists(),
            "the resumed wipe removed the local dir"
        );
        pool.close().await;
    }

    /// F1: a create stops the delete's wipe and then aborts before inserting
    /// (a lost slug race, a quota refusal); the stopped wipe left the tombstone
    /// and the next resume pass finishes it.
    #[tokio::test]
    async fn a_stopped_wipe_is_resumed_when_its_create_aborted() {
        let scratch = crate::testutil::TempDir::new("noite-purge-stopped-resume");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let (pool, _app) = tombstoned_slug(&cfg, "aborted").await;
        let git_sync = ryuz_git::GitSync::default();
        let registered = begin("aborted");
        registered.stop().stop();
        let ended = purge_slug(
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &git_sync,
            "aborted",
            crate::host::supervisor::StopGrace::FOR_DELETE,
            Some(registered.stop()),
            false,
        )
        .await
        .expect("purge");
        drop(registered);
        assert_eq!(ended, Purged::Stopped);
        assert_eq!(
            db::pending_purges(&pool).await.expect("tombstones").len(),
            1,
            "a stopped wipe keeps the tombstone"
        );

        let report = resume_pending(
            &pool,
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &git_sync,
        )
        .await;
        assert_eq!(report.cleared, 1);
        assert!(db::pending_purges(&pool)
            .await
            .expect("tombstones")
            .is_empty());
        assert!(!crate::host::exec::work_root(&cfg)
            .join("projects")
            .join("aborted")
            .exists());
        pool.close().await;
    }

    /// F1: an S3 failure during the resume keeps the tombstone (nothing is
    /// lost) and the next pass, once the store answers again, finishes it.
    #[tokio::test]
    async fn an_s3_error_keeps_the_tombstone_for_the_next_pass() {
        let scratch = crate::testutil::TempDir::new("noite-purge-s3-retry");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = spawn_denied_s3().await;
        let (pool, _app) = tombstoned_slug(&cfg, "retried").await;
        let git_sync = ryuz_git::GitSync::default();
        let procs = crate::host::supervisor::new_procs();
        let logs = crate::host::logs::new_state();

        let failed = resume_pending(&pool, &cfg, &procs, &logs, &git_sync).await;
        assert_eq!(failed.failed, 1);
        assert_eq!(failed.cleared, 0);
        assert_eq!(
            db::pending_purges(&pool).await.expect("tombstones").len(),
            1,
            "a failed wipe must not clear its tombstone"
        );

        let mut healthy = cfg.clone();
        healthy.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let cleared = resume_pending(&pool, &healthy, &procs, &logs, &git_sync).await;
        assert_eq!(cleared.cleared, 1);
        assert_eq!(cleared.failed, 0);
        assert!(db::pending_purges(&pool)
            .await
            .expect("tombstones")
            .is_empty());
        pool.close().await;
    }

    /// The resume pass never wipes a prefix a live app owns: a create or rename
    /// that took the freed slug already wiped it under the same guard, so the
    /// tombstone is satisfied and cleared without touching anything.
    #[tokio::test]
    async fn a_resumed_tombstone_leaves_a_reowned_slug_alone() {
        let scratch = crate::testutil::TempDir::new("noite-purge-reowned");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = scratch.path().join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let (pool, _app) = tombstoned_slug(&cfg, "reowned").await;
        db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "successor",
                slug: "reowned",
                user_id: "local",
                subdomain: "reowned.localhost",
                listen: 30310,
                internal: 30311,
            },
        )
        .await
        .expect("successor row");
        let dir = crate::host::exec::work_root(&cfg)
            .join("projects")
            .join("reowned");
        std::fs::create_dir_all(&dir).expect("successor dir");

        let report = resume_pending(
            &pool,
            &cfg,
            &crate::host::supervisor::new_procs(),
            &crate::host::logs::new_state(),
            &ryuz_git::GitSync::default(),
        )
        .await;
        assert_eq!(report.cleared, 1);
        assert!(db::pending_purges(&pool)
            .await
            .expect("tombstones")
            .is_empty());
        assert!(dir.exists(), "the new owner's data must survive the resume");
        pool.close().await;
    }

    /// Write a container-CLI stand-in. It records every call, answers
    /// `volume ls` with `listing`, and `volume rm` with `status`/`stderr`.
    fn cli_stub(
        dir: &std::path::Path,
        listing: &[&str],
        status: i32,
        stderr: &str,
    ) -> (String, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let log = dir.join("cli.log");
        let bin = dir.join("container-cli");
        let echo_each: String = listing.iter().map(|n| format!("echo {n}\n")).collect();
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\necho \"$@\" >> {}\n\
                 if [ \"$1 $2\" = \"volume ls\" ]; then {}\n exit 0; fi\n\
                 echo {} >&2\nexit {}\n",
                log.display(),
                echo_each,
                stderr,
                status
            ),
        )
        .expect("write stub");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        (bin.to_string_lossy().into_owned(), log)
    }

    async fn app_with_slug(pool: &sqlx::SqlitePool, slug: &str) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        db::create_app(
            pool,
            &cfg,
            db::NewApp {
                name: slug,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30220,
                internal: 30221,
            },
        )
        .await
        .expect("app")
    }

    /// The sweep keeps a live app's id-keyed volume and removes the dead
    /// app's, but only inside this install's namespace: a pre-tag name and
    /// another install's tagged name are not ours to delete.
    #[tokio::test]
    async fn the_sweep_keeps_live_ids_and_removes_only_this_installs_volumes() {
        let base = std::env::temp_dir().join(format!("noite-ci-sweep-{}", crate::models::new_id()));
        std::fs::create_dir_all(&base).expect("temp dir");
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let live = app_with_slug(&pool, "live-app").await;
        let dead = app_with_slug(&pool, "dead-app").await;
        db::delete_app(&pool, &dead.id).await.expect("delete row");
        let mut cfg = crate::config::config_for_tests();
        let live_name = crate::host::deploy::ci_cache_volume(&cfg, &live.id);
        let dead_name = crate::host::deploy::ci_cache_volume(&cfg, &dead.id);
        let legacy = format!("{}old-slug", crate::host::deploy::ci_cache_volume_prefix());
        let mut other = crate::config::config_for_tests();
        other.s3_bucket = format!("{}-other", cfg.s3_bucket);
        let foreign = crate::host::deploy::ci_cache_volume(&other, &dead.id);
        let (bin, log) = cli_stub(
            &base,
            &[&live_name, &dead_name, &legacy, &foreign],
            1,
            "Error: no such volume",
        );
        cfg.ci_docker_bin = bin;

        let removed = reconcile_ci_caches(&cfg, &pool).await;
        assert_eq!(
            removed, 1,
            "only this install's dead volume goes; the live one and the foreign names stay"
        );
        let calls = std::fs::read_to_string(&log).expect("cli log");
        assert!(
            calls.contains(&format!("volume rm -f {dead_name}")),
            "{calls}"
        );
        for untouched in [&live_name, &legacy, &foreign] {
            assert!(
                !calls.contains(&format!("volume rm -f {untouched}")),
                "{untouched} is not ours to remove: {calls}"
            );
        }
        pool.close().await;
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The delete's fast path is best-effort: a failing CLI only logs, and the
    /// tombstone clear never waits on it.
    #[tokio::test]
    async fn a_failing_volume_cli_never_blocks_the_tombstone_clear() {
        let base = std::env::temp_dir().join(format!("noite-ci-sweep-{}", crate::models::new_id()));
        std::fs::create_dir_all(&base).expect("temp dir");
        let (bin, _log) = cli_stub(&base, &[], 1, "permission denied");
        let mut cfg = crate::config::config_for_tests();
        cfg.ci_docker_bin = bin;
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = app_with_slug(&pool, "stuck-slug").await;
        db::delete_app(&pool, &app.id).await.expect("delete row");

        let err = remove_ci_cache_volume(&cfg, &app.id)
            .await
            .expect_err("the refusal is reported to the caller, which only logs it");
        assert!(format!("{err:#}").contains("permission denied"), "{err:#}");
        db::clear_app_purges(&pool, "stuck-slug")
            .await
            .expect("the tombstone clears regardless of the volume");
        assert!(db::pending_purges(&pool)
            .await
            .expect("tombstones")
            .is_empty());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&base);
    }
}
