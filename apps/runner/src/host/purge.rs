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

/// The background purges in flight, by slug. One per slug: a purge is only
/// ever reusable through [`begin`], and [`RegisteredPurge`] removes the entry
/// however the wipe ends (a panic included).
static RUNNING: LazyLock<Mutex<HashMap<String, Arc<PurgeStop>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn running() -> std::sync::MutexGuard<'static, HashMap<String, Arc<PurgeStop>>> {
    RUNNING.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Register a background purge for `slug`. The returned guard must live for
/// the wipe's whole life: dropping it unregisters the handle.
pub fn begin(slug: &str) -> RegisteredPurge {
    let stop = Arc::new(PurgeStop::default());
    running().insert(slug.to_string(), stop.clone());
    RegisteredPurge {
        slug: slug.to_string(),
        stop,
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
        // Only our own handle goes: a later purge of the same slug must keep
        // its own entry.
        if map
            .get(&self.slug)
            .is_some_and(|live| Arc::ptr_eq(live, &self.stop))
        {
            map.remove(&self.slug);
        }
    }
}

/// Ask a background purge of `slug` to end. `true` when one was running.
pub fn stop(slug: &str) -> bool {
    let live = running().get(slug).cloned();
    match live {
        Some(stop) => {
            stop.stop();
            true
        }
        None => false,
    }
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
pub async fn purge_slug(
    cfg: &Config,
    procs: &ProcMap,
    log_state: &LogState,
    git_sync: &ryuz_git::GitSync,
    slug: &str,
    grace: supervisor::StopGrace,
    stop: Option<&PurgeStop>,
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
    let had_fleet = supervisor::has_process(procs, slug).await;
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
        )
        .await
        .expect("purge");
        assert_eq!(ended, Purged::Stopped);
        let _ = std::fs::remove_dir_all(&cfg.work_dir);
    }

    /// One registered handle per slug: a create's stop reaches the running
    /// wipe, a finished wipe unregisters, and a later wipe's handle is not
    /// removed by an earlier guard.
    #[test]
    fn the_purge_registry_tracks_one_live_handle_per_slug() {
        let first = begin("registry-slug");
        assert!(stop("registry-slug"));
        assert!(first.stop().stopped());
        // A second registration replaces the handle; the first guard must not
        // unregister it when it goes.
        let second = begin("registry-slug");
        drop(first);
        assert!(!second.stop().stopped(), "a fresh handle starts unstopped");
        assert!(stop("registry-slug"), "the live handle is still registered");
        assert!(second.stop().stopped());
        drop(second);
        assert!(!stop("registry-slug"), "nothing left to stop");
    }
}
