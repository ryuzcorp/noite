//! Reconcile tick: desired_state → fleet processes, tip poll → deploy, Caddy, metrics.
//! Named `loop_` because `loop` is a Rust keyword.
use std::collections::HashSet;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::deploy::{self, Deploying};
use crate::host::edge_table;
use crate::host::logs::LogState;
use crate::host::metrics::{self, MetricsState};
use crate::host::supervisor::{self, ProcMap};
use crate::host::tips::{self, TipBundle};
use crate::host::tips::{TipNotify, TipReceiver};
use crate::lifecycle::{sha_same, DEPLOY_IN_FLIGHT_MS, DEPLOY_STUCK_MS};
use crate::models::{App, AppStatus, DesiredState};

#[allow(clippy::too_many_arguments)] // shared deps threaded by reference; matches deploy_app's existing allow
pub async fn run_forever(
    pool: SqlitePool,
    cfg: Config,
    procs: ProcMap,
    // Pid of the running control node (0 when none): the metrics ingest
    // samples its CPU and treats it as a live telemetry source.
    control_pid: Arc<std::sync::atomic::AtomicU32>,
    logs: LogState,
    deploying: Deploying,
    mut metrics: MetricsState,
    ready: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
    mut tip_rx: TipReceiver,
    log_tx: tokio::sync::watch::Sender<u64>,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(cfg.poll_ms));
    // None sweeps on the first tick: pushes that landed while the runner was
    // down must deploy instead of waiting a full sweep interval.
    let mut last_sweep: Option<Instant> = None;
    // Scale to zero (SPEC): first sleep sweep one full interval after boot,
    // so telemetry ingest has caught up before any app is judged idle.
    let mut last_sleep_sweep = Instant::now();
    let sleep_sweeping = Arc::new(AtomicBool::new(false));
    // Memory-pressure parking (SPEC, Scale to zero): one cheap sample per
    // `RUNNER_PRESSURE_SWEEP_S`, and a parked app only when the container is
    // near its limit. First check one interval after boot.
    let mut last_pressure_sweep = Instant::now();
    let pressure_sweeping = Arc::new(AtomicBool::new(false));
    // Scoped-key revocation retries (SPEC, Scoped credentials): a store
    // delete refused at revoke time stays marked until the store accepts.
    // One cheap SELECT per tick when nothing pends; a failed sweep backs
    // off a minute instead of hammering a struggling store.
    let mut last_cred_sweep: Option<Instant> = None;
    // Orphan scoped-key reconcile (SPEC, Scoped credentials): the store
    // listed against the DB, revoking what no row names. `None` runs on
    // the first tick, then every ten minutes — a full listing on every
    // tick would hammer the store's IAM.
    let mut last_orphan_sweep: Option<Instant> = None;
    loop {
        tick.tick().await;
        if shutdown.load(Ordering::Relaxed) {
            break;
        }
        // Off the tick: parking waits on a fleet's SIGTERM drain, which must
        // not stall reconciliation. One sweep at a time.
        if cfg.sleep_after_h > 0
            && last_sleep_sweep.elapsed() >= Duration::from_secs(cfg.sleep_sweep_s.max(60))
            && !sleep_sweeping.swap(true, Ordering::SeqCst)
        {
            last_sleep_sweep = Instant::now();
            let (pool2, cfg2, procs2, flag) = (
                pool.clone(),
                cfg.clone(),
                procs.clone(),
                sleep_sweeping.clone(),
            );
            tokio::spawn(async move {
                let parked = crate::host::sleep::sweep(&pool2, &cfg2, &procs2).await;
                if parked > 0 {
                    tracing::info!(parked, "sleep sweep");
                }
                flag.store(false, Ordering::SeqCst);
            });
        }
        // Last line before the kernel OOM-killer: at or above the configured
        // percentage, park the least-recently-active idle app. Off the tick,
        // like the sleep sweep (parking waits on a SIGTERM drain).
        if cfg.pressure_pct > 0
            && last_pressure_sweep.elapsed() >= Duration::from_secs(cfg.pressure_sweep_s.max(10))
            && !pressure_sweeping.swap(true, Ordering::SeqCst)
        {
            last_pressure_sweep = Instant::now();
            let (pool2, cfg2, procs2, deploying2, flag) = (
                pool.clone(),
                cfg.clone(),
                procs.clone(),
                deploying.clone(),
                pressure_sweeping.clone(),
            );
            tokio::spawn(async move {
                let parked =
                    crate::host::sleep::sweep_under_pressure(&pool2, &cfg2, &procs2, &deploying2)
                        .await;
                if parked > 0 {
                    tracing::info!(parked, "pressure sweep");
                }
                flag.store(false, Ordering::SeqCst);
            });
        }
        // Scoped-key revocation retries (SPEC, Scoped credentials): a store
        // delete refused at revoke time stays marked until the store accepts.
        if last_cred_sweep.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
            last_cred_sweep = Some(Instant::now());
            let left = crate::host::credentials::sweep(&pool, &cfg).await;
            if left > 0 {
                tracing::warn!(left, "scoped keys still awaiting revocation");
            }
        }
        if crate::host::credentials::orphan_sweep_due(
            last_orphan_sweep,
            Instant::now(),
            Duration::from_secs(10 * 60),
        ) {
            last_orphan_sweep = Some(Instant::now());
            let report = crate::host::credentials::orphan_sweep(&pool, &cfg).await;
            if let Some(error) = report.error {
                tracing::warn!(error = %error, "orphan credential sweep failed");
            } else if report.revoked > 0 {
                tracing::info!(
                    revoked = report.revoked,
                    listed = report.listed,
                    "orphan credential sweep"
                );
            }
        }
        if let Err(e) = reconcile_once(
            &pool,
            &cfg,
            &procs,
            control_pid.load(Ordering::Relaxed),
            &logs,
            &deploying,
            &mut metrics,
            &mut tip_rx,
            &mut last_sweep,
            &log_tx,
        )
        .await
        {
            tracing::error!(error = %e, "reconcile");
        } else {
            ready.store(true, Ordering::Relaxed);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn reconcile_once(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    control_pid: u32,
    logs: &LogState,
    deploying: &Deploying,
    metrics: &mut MetricsState,
    tip_rx: &mut TipReceiver,
    last_sweep: &mut Option<Instant>,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    let claimed = deploy::snapshot_claimed(deploying).await;
    let swept = db::fail_stuck_deploys(pool, DEPLOY_STUCK_MS, &claimed).await?;
    if !swept.is_empty() {
        tracing::info!(swept = swept.len(), "swept stalled deploys");
        // A stalled row spends the automatic-deploy budget like a failure.
        crate::host::auto_deploy::note_stalled(pool, &swept).await;
    }

    // Push-driven fast path (T2.2): every queued tip deploys this tick. The
    // sweep below only covers bundles written behind the runner's back.
    let mut pending: Vec<TipNotify> = Vec::new();
    while let Ok(notify) = tip_rx.try_recv() {
        pending.push(notify);
    }
    for notify in pending {
        drain_tip(pool, cfg, procs, logs, deploying, &claimed, notify).await;
    }

    // Fallback sweep, throttled to RUNNER_TIP_SWEEP_S (60 s): without it a
    // bundle written by another runner or by hand would never deploy.
    let sweep_due = last_sweep
        .map(|t| t.elapsed() >= Duration::from_secs(cfg.tip_sweep_s.max(1)))
        .unwrap_or(true);
    if sweep_due {
        *last_sweep = Some(Instant::now());
    }

    let apps = db::list_apps(pool).await?;
    let stopped_apps: HashSet<String> = apps
        .iter()
        .filter(|a| a.desired() == DesiredState::Stopped)
        .map(|a| a.id.clone())
        .collect();
    // Cold starts per pass (`RUNNER_FLEET_SPAWN_BATCH`): a boot or upgrade
    // must not stack every celld's initialization at once. Restarts of an
    // already-registered child are never batched — those wait on their own
    // backoff and deserve the next tick.
    let mut cold_starts: u32 = 0;
    for app in &apps {
        if app.desired() == DesiredState::Stopped {
            supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
            if app.status != AppStatus::Stopped {
                db::write_app_status(
                    pool,
                    &app.id,
                    AppStatus::Stopped,
                    None,
                    None,
                    crate::models::WriteGuard::Table,
                )
                .await?;
            }
            continue;
        }
        // Spawn celld only after a successful deploy — a fleet whose bucket
        // lacks deploy/current.json exits(1) immediately and would crash-loop.
        // Asleep apps stay parked: the next request wakes them through the
        // edge (host/sleep.rs), and respawning here would undo the sleep.
        if app.listen_port.is_some() && app.is_deployed() && !app.is_asleep() {
            // `apps` is a snapshot from the top of this tick: a delete (or a
            // rename) may have moved on since, and spawning from the stale row
            // would resurrect a fleet the delete already stopped — under a slug
            // it is about to free. Re-read immediately before the spawn.
            if !still_wanted(pool, &app.id).await? {
                continue;
            }
            let cold = !supervisor::has_process(procs, &app.slug).await;
            if cold {
                if cold_starts >= cfg.fleet_spawn_batch {
                    continue;
                }
                cold_starts += 1;
            }
            match supervisor::ensure_fleet(pool, cfg, procs, logs, app).await {
                Ok(()) => {
                    // "Running" means the fleet answers its health gate, not
                    // just that celld was spawned: confirm off the tick (the
                    // loop must never block behind one app's cold boot) and
                    // flip only while still wanted, so a stop in the window
                    // wins. Without any confirm, start/resume would leave the
                    // stop-time status stuck until the next deploy flips it.
                    if app.status != AppStatus::Running {
                        if let Some(port) = app.listen_port {
                            let (pool, cfg, procs) = (pool.clone(), cfg.clone(), procs.clone());
                            let (id, fleet) = (app.id.clone(), app.slug.clone());
                            tokio::spawn(async move {
                                crate::host::sleep::confirm_app_running(
                                    &pool, &cfg, &procs, &id, &fleet, port,
                                )
                                .await;
                            });
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(slug = %app.slug, error = %e, "ensure_fleet");
                    let msg = format!("{e:#}");
                    db::write_app_status(
                        pool,
                        &app.id,
                        app.status,
                        Some(&msg),
                        None,
                        crate::models::WriteGuard::Wanted,
                    )
                    .await?;
                }
            }
        }

        if !sweep_due {
            continue;
        }
        if app_has_in_flight(pool, &app.id).await || claimed.contains(&app.id) {
            continue;
        }

        match tips::head_main_bundle(cfg, &app.slug).await {
            Ok(Some(tip)) => {
                let target = deploy::DeployTarget::Production;
                if !sweep_needs_tip(pool, app, &target, &tip.sha).await? {
                    continue;
                }
                tracing::info!(slug = %app.slug, sha = %&tip.sha[..12.min(tip.sha.len())], "git tip changed");
                spawn_tip_deploy(pool, cfg, procs, logs, deploying, app.clone(), target, tip);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(slug = %app.slug, error = %e, "list tip"),
        }
    }

    // Preview environments are fleets of their own: same desired_state rule,
    // same wake-aware parking, and their own ref drives their deploys.
    let environments = db::list_all_environments(pool).await?;
    for env in &environments {
        let fleet = format!("{}.{}", env.app_slug, env.label);
        if env.is_stopped() || stopped_apps.contains(&env.app_id) {
            supervisor::stop_environment_fleet(procs, &env.app_slug, &env.label).await;
            if env.is_stopped() && env.status != AppStatus::Stopped {
                db::write_environment_status(
                    pool,
                    &env.id,
                    AppStatus::Stopped,
                    None,
                    crate::models::WriteGuard::Table,
                )
                .await?;
            }
            continue;
        }
        if env.listen_port.is_some() && env.is_deployed() && !env.is_asleep() {
            // Same stale-snapshot rule as the app branch: the row may be gone
            // (or being torn down) by the time this tick reaches it.
            if !env_still_wanted(pool, env).await? {
                continue;
            }
            let cold = !supervisor::has_process(procs, &fleet).await;
            if cold {
                if cold_starts >= cfg.fleet_spawn_batch {
                    continue;
                }
                cold_starts += 1;
            }
            match supervisor::ensure_environment_fleet(pool, cfg, procs, logs, env).await {
                Ok(()) => {
                    // Same truthful order as the app branch above.
                    if env.status != AppStatus::Running {
                        if let Some(port) = env.listen_port {
                            let (pool, cfg, procs) = (pool.clone(), cfg.clone(), procs.clone());
                            let (id, ring) = (env.id.clone(), fleet.clone());
                            tokio::spawn(async move {
                                crate::host::sleep::confirm_environment_running(
                                    &pool, &cfg, &procs, &id, &ring, port,
                                )
                                .await;
                            });
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(fleet = %fleet, error = %e, "ensure_environment_fleet");
                    let msg = format!("{e:#}");
                    db::write_environment_status(
                        pool,
                        &env.id,
                        env.status,
                        Some(&msg),
                        crate::models::WriteGuard::Wanted,
                    )
                    .await?;
                }
            }
        }

        if !sweep_due {
            continue;
        }
        if env_has_in_flight(pool, &env.id).await || claimed.contains(&env.app_id) {
            continue;
        }
        match tips::head_ref_bundle(cfg, &env.app_slug, &env.git_ref).await {
            Ok(Some(tip)) => {
                let Some(app) = apps.iter().find(|a| a.id == env.app_id).cloned() else {
                    continue;
                };
                let target = deploy::DeployTarget::Environment(Box::new(env.clone()));
                if !sweep_needs_tip(pool, &app, &target, &tip.sha).await? {
                    continue;
                }
                tracing::info!(fleet = %fleet, sha = %&tip.sha[..12.min(tip.sha.len())], "git tip changed");
                spawn_tip_deploy(pool, cfg, procs, logs, deploying, app, target, tip);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(fleet = %fleet, error = %e, "list tip"),
        }
    }

    if sweep_due {
        sweep_expired_environments(pool, cfg, procs, logs).await;
    }

    // Best-effort on the tick: a failed push must not abort the
    // reconcile (orphan sweeps, metrics) every tick while it persists.
    if let Err(e) = edge_table::push_routes(pool, cfg).await {
        tracing::warn!(error = %format!("{e:#}"), "edge push on tick");
    }
    // Backstop for a fleet left running after its app's (or environment's)
    // row was deleted.
    supervisor::stop_orphan_fleets(pool, procs).await;

    // A build is the largest tenant CPU/IO spike on a small box. Keep the
    // telemetry tick (DuckDB ingest/compaction, up to its own memory cap) out
    // of its way: spans stay in the bucket and the next tick after the build
    // catches up. The deploy loop itself never waits on the build.
    if deploy::snapshot_claimed(deploying).await.is_empty() {
        metrics::tick(pool, cfg, procs, control_pid, metrics, log_tx).await?;
    } else {
        tracing::debug!("build in flight; skipping the telemetry tick");
    }
    Ok(())
}

/// Remove workspace previews with no deploy for `RUNNER_ENVIRONMENT_TTL_H`
/// (ROADMAP: 7 days). Branch environments are never swept here — they live
/// until their branch or their owner deletes them.
async fn sweep_expired_environments(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
) {
    if cfg.environment_ttl_h == 0 {
        return;
    }
    let cutoff = (chrono::Utc::now() - chrono::Duration::hours(cfg.environment_ttl_h as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let Ok(expired) = db::expired_workspace_environments(pool, &cutoff).await else {
        return;
    };
    for env in expired {
        tracing::info!(
            fleet = %format!("{}.{}", env.app_slug, env.label),
            "workspace preview expired; removing"
        );
        if let Err(e) = crate::host::env_teardown::teardown(cfg, pool, procs, logs, &env).await {
            tracing::warn!(
                fleet = %format!("{}.{}", env.app_slug, env.label),
                error = %format!("{e:#}"),
                "expired environment teardown failed"
            );
        }
    }
}

/// Whether the row this tick snapshotted still wants a fleet: the app exists,
/// is not being deleted, and still desires to run. Re-read per spawn so a
/// delete that landed mid-tick is not undone by a stale snapshot.
async fn still_wanted(pool: &SqlitePool, app_id: &str) -> sqlx::Result<bool> {
    if crate::service::apps::deleting(app_id) {
        return Ok(false);
    }
    Ok(db::get_app(pool, app_id)
        .await?
        .is_some_and(|row| row.desired() == DesiredState::Running))
}

/// Same stale-snapshot rule for one preview environment: its own row is
/// the authority (a teardown removes it), and its app must still want a fleet.
async fn env_still_wanted(
    pool: &SqlitePool,
    env: &crate::models::Environment,
) -> sqlx::Result<bool> {
    if crate::service::apps::deleting(&env.app_id) {
        return Ok(false);
    }
    Ok(db::get_environment(pool, &env.id)
        .await?
        .is_some_and(|row| row.desired() == DesiredState::Running))
}

/// True while a recent deploy row is still in flight (T1.6's log-free check):
/// neither the channel drain nor the fallback sweep may start a second deploy
/// over it. DB errors read as "busy" — a deploy storm on a sick database is
/// worse than a delayed tip.
async fn app_has_in_flight(pool: &SqlitePool, app_id: &str) -> bool {
    let Ok(recent) = db::latest_deploy_status(pool, app_id).await else {
        return true;
    };
    recent.iter().any(|(status, updated_at)| {
        if !status.is_in_flight() {
            return false;
        }
        crate::models::parse_time(updated_at)
            .map(|t| (chrono::Utc::now() - t).num_milliseconds() < DEPLOY_IN_FLIGHT_MS)
            .unwrap_or(false)
    })
}

/// True while a recent deploy row of one environment is still in flight; the
/// same "busy on a sick database" rule as [`app_has_in_flight`].
async fn env_has_in_flight(pool: &SqlitePool, environment_id: &str) -> bool {
    let Ok(recent) = db::latest_deploy_status_for_env(pool, environment_id).await else {
        return true;
    };
    recent.iter().any(|(status, updated_at)| {
        if !status.is_in_flight() {
            return false;
        }
        crate::models::parse_time(updated_at)
            .map(|t| (chrono::Utc::now() - t).num_milliseconds() < DEPLOY_IN_FLIGHT_MS)
            .unwrap_or(false)
    })
}

/// One queued push notification: look the app up fresh (it may have stopped
/// since the push), resolve what the moved ref deploys, skip stale/in-flight
/// tips, and deploy the rest.
///
/// `refs/heads/main` is production; any other ref deploys the environment that
/// tracks it, and a ref nothing tracks is not a deploy at all (an ordinary
/// branch push without an environment must stay cheap). Stopped apps and
/// environments keep accumulating tips in the bucket for the sweep that runs
/// when they resume — the sweep compares against `last_deploy_sha`, so nothing
/// is lost by skipping here.
async fn drain_tip(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    claimed: &HashSet<String>,
    notify: TipNotify,
) {
    let Ok(Some(app)) = db::get_app(pool, &notify.app_id).await else {
        return;
    };
    if app.desired() == DesiredState::Stopped {
        return;
    }
    let target = if notify.git_ref == "refs/heads/main" {
        deploy::DeployTarget::Production
    } else {
        match db::get_environment_by_ref(pool, &app.id, &notify.git_ref).await {
            Ok(Some(env)) => {
                if env.is_stopped() {
                    return;
                }
                deploy::DeployTarget::Environment(Box::new(env))
            }
            // Nothing tracks this ref: a plain branch push deploys nothing.
            Ok(None) => return,
            Err(e) => {
                tracing::warn!(slug = %app.slug, error = %e, "environment lookup for tip");
                return;
            }
        }
    };
    if target
        .last_deploy_sha(&app)
        .as_deref()
        .is_some_and(|s| sha_same(s, &notify.tip.sha))
    {
        return;
    }
    // Builds are serialized per app, so one claim covers both targets; the
    // in-flight check is per target, because a preview's build must not block
    // production's (and vice versa) once the lock is free.
    if claimed.contains(&app.id) {
        return;
    }
    let busy = match target.environment_id() {
        Some(env_id) => env_has_in_flight(pool, env_id).await,
        None => app_has_in_flight(pool, &app.id).await,
    };
    if busy {
        return;
    }
    // A push of a sha whose automatic budget is spent (force-push of the same
    // commit) must not restart it; a push of a new sha is a new start.
    if let Ok(auto) =
        crate::host::auto_deploy::for_target(pool, &app.id, target.environment_id()).await
    {
        if auto.blocks(&notify.tip.sha) {
            tracing::info!(slug = %app.slug, sha = %&notify.tip.sha[..12.min(notify.tip.sha.len())], "automatic deploy paused");
            return;
        }
    }
    tracing::info!(slug = %app.slug, git_ref = %notify.git_ref, sha = %&notify.tip.sha[..12.min(notify.tip.sha.len())], "push notified tip");
    spawn_tip_deploy(pool, cfg, procs, logs, deploying, app, target, notify.tip);
}

/// Whether the fallback tip sweep must deploy `tip`: the target does not serve
/// it yet, and nothing here ever built it.
///
/// A sha the history holds a successful deploy for is not the out-of-band
/// write this sweep exists for: the live release moved off it on purpose — a
/// rollback, or a redeploy of an older release — and pulling the git tip back
/// would silently undo that within one sweep interval. Pushes and explicit
/// redeploys deploy on their own trigger, so only a tip nothing here built (a
/// bundle written by another runner or by hand) needs the sweep.
async fn sweep_needs_tip(
    pool: &SqlitePool,
    app: &App,
    target: &deploy::DeployTarget,
    tip_sha: &str,
) -> sqlx::Result<bool> {
    let live = target.last_deploy_sha(app);
    if live.as_deref().is_some_and(|s| sha_same(s, tip_sha)) {
        return Ok(false);
    }
    // The automatic-deploy budget (owner rule, 2026-11-10): two consecutive
    // failures of this sha pause the sweep until a new sha or an explicit
    // deploy. A stop counts too — it must not be retried behind the operator.
    let auto = crate::host::auto_deploy::for_target(pool, &app.id, target.environment_id()).await?;
    if auto.blocks(tip_sha) {
        return Ok(false);
    }

    Ok(
        db::get_success_deploy(pool, &app.id, tip_sha, target.environment_id())
            .await?
            .is_none(),
    )
}

/// Hand a fresh tip to the deploy pipeline on its own task: the loop must
/// never block behind a build. `deploy_tip` re-checks the sha, so a tip that
/// went stale between the check above and the spawn is still safe.
#[allow(clippy::too_many_arguments)] // the loop's shared deps plus the resolved target
fn spawn_tip_deploy(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    target: deploy::DeployTarget,
    tip: TipBundle,
) {
    let pool = pool.clone();
    let cfg = cfg.clone();
    let procs = procs.clone();
    let logs = logs.clone();
    let deploying = deploying.clone();
    tokio::spawn(async move {
        deploy::deploy_tip(&pool, &cfg, &procs, &logs, &deploying, app, target, tip).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::DeployStatus;

    /// A tick's `apps` snapshot can be older than the delete that landed in
    /// the middle of it: `still_wanted` re-reads the row (and the delete
    /// registry) right before the spawn, so a stale snapshot cannot resurrect
    /// a fleet the delete already stopped.
    #[tokio::test]
    async fn a_stale_row_snapshot_does_not_want_a_fleet() {
        let cfg = crate::config::config_for_tests();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "stale",
                slug: "stale",
                user_id: "local",
                subdomain: "stale.localhost",
                listen: 30400,
                internal: 30401,
            },
        )
        .await
        .expect("app");
        assert!(still_wanted(&pool, &app.id).await.expect("live row"));

        // A delete in progress (the row is still there for a moment).
        assert!(crate::service::apps::deleting_claim_for_test(&app.id));
        assert!(
            !still_wanted(&pool, &app.id).await.expect("deleting"),
            "a deleting app wants no fleet"
        );
        crate::service::apps::deleting_release_for_test(&app.id);

        // The row is gone.
        db::delete_app(&pool, &app.id).await.expect("delete");
        assert!(!still_wanted(&pool, &app.id).await.expect("gone"));

        // An operator stop.
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "parked",
                slug: "parked",
                user_id: "local",
                subdomain: "parked.localhost",
                listen: 30402,
                internal: 30403,
            },
        )
        .await
        .expect("app");
        db::patch_app_desired(&pool, &app.id, DesiredState::Stopped)
            .await
            .expect("stop");
        assert!(!still_wanted(&pool, &app.id).await.expect("stopped"));
    }

    /// The expiry sweep removes workspace previews with no deploy for the TTL
    /// and never touches a branch environment (ROADMAP, lifecycle).
    /// `expired_workspace_environments` is the query it drives; this proves the
    /// sweep wires it to a real teardown.
    #[tokio::test]
    async fn expiry_sweep_removes_only_stale_workspace_previews() {
        use crate::models::EnvironmentKind;
        let base =
            std::env::temp_dir().join(format!("noite-env-expiry-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        cfg.environment_ttl_h = 168;
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "ttl",
                slug: "ttl",
                user_id: "local",
                subdomain: "ttl.localhost",
                listen: 30300,
                internal: 30301,
            },
        )
        .await
        .expect("app");
        let workspace = db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "ttl",
                label: "wip-user",
                kind: EnvironmentKind::Workspace,
                git_ref: "refs/previews/user/wip",
                created_by: "user",
                listen: 30310,
                internal: 30311,
            },
        )
        .await
        .expect("workspace env");
        let branch = db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "ttl",
                label: "kept",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/kept",
                created_by: "user",
                listen: 30320,
                internal: 30321,
            },
        )
        .await
        .expect("branch env");
        // Age the workspace preview (and its deploy clock) past the TTL.
        sqlx::query(
            "UPDATE environment SET created_at = '2020-01-01T00:00:00.000Z', \
                     last_deployed_at = NULL WHERE id = ?",
        )
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();

        let procs = supervisor::new_procs();
        let logs = crate::host::logs::new_state();
        sweep_expired_environments(&pool, &cfg, &procs, &logs).await;

        assert!(
            db::get_environment(&pool, &workspace.id)
                .await
                .unwrap()
                .is_none(),
            "the stale workspace preview is gone"
        );
        assert!(db::get_environment(&pool, &branch.id)
            .await
            .unwrap()
            .is_some());

        // TTL 0 disables the sweep entirely.
        cfg.environment_ttl_h = 0;
        sqlx::query("UPDATE environment SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
            .bind(&branch.id)
            .execute(&pool)
            .await
            .unwrap();
        sweep_expired_environments(&pool, &cfg, &procs, &logs).await;
        assert!(db::get_environment(&pool, &branch.id)
            .await
            .unwrap()
            .is_some());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The fallback tip sweep must not undo a rollback. A sha the history holds
    /// a success for is a release the operator moved off on purpose; only a tip
    /// nothing here built (an out-of-band bundle write) needs the sweep, and a
    /// failed row is not a build to stand on.
    #[tokio::test]
    async fn sweep_skips_a_tip_that_is_already_built() {
        use crate::models::EnvironmentKind;
        let cfg = crate::config::config_for_tests();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "rollback",
                slug: "rollback",
                user_id: "local",
                subdomain: "rollback.localhost",
                listen: 30340,
                internal: 30341,
            },
        )
        .await
        .expect("app");
        // Deploy sha2, then roll production back to sha1: the app now serves
        // sha1 while the git tip is still sha2.
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Success,
            Some("sha2"),
            "",
        )
        .await
        .expect("sha2 deploy");
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Success,
            Some("sha1"),
            "",
        )
        .await
        .expect("sha1 rollback");
        let fresh = db::get_app(&pool, &app.id).await.unwrap().expect("app row");
        assert_eq!(fresh.last_deploy_sha.as_deref(), Some("sha1"));

        let production = deploy::DeployTarget::Production;
        assert!(
            !sweep_needs_tip(&pool, &fresh, &production, "sha2")
                .await
                .unwrap(),
            "the rollback target is still the built tip: the sweep must not undo it"
        );
        assert!(
            sweep_needs_tip(&pool, &fresh, &production, "sha3")
                .await
                .unwrap(),
            "a tip nothing built needs the fallback sweep"
        );

        // A failed attempt at the tip is not a release: the sweep retries it.
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Failed,
            Some("sha4"),
            "boom",
        )
        .await
        .expect("failed deploy");
        assert!(sweep_needs_tip(&pool, &fresh, &production, "sha4")
            .await
            .unwrap());

        // An environment's history is its own: production's success for sha2
        // says nothing about a preview's sha2.
        let env = db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "rollback",
                label: "wip",
                kind: EnvironmentKind::Workspace,
                git_ref: "refs/previews/user/wip",
                created_by: "user",
                listen: 30350,
                internal: 30351,
            },
        )
        .await
        .expect("environment");
        let preview = deploy::DeployTarget::Environment(Box::new(env.clone()));
        assert!(sweep_needs_tip(&pool, &fresh, &preview, "sha2")
            .await
            .unwrap());
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            Some(&env.id),
            DeployStatus::Success,
            Some("sha2"),
            "",
        )
        .await
        .expect("preview sha2 deploy");
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            Some(&env.id),
            DeployStatus::Success,
            Some("sha1"),
            "",
        )
        .await
        .expect("preview sha1 deploy");
        let fresh_env = db::get_environment(&pool, &env.id)
            .await
            .unwrap()
            .expect("env row");
        let preview = deploy::DeployTarget::Environment(Box::new(fresh_env));
        assert!(!sweep_needs_tip(&pool, &fresh, &preview, "sha2")
            .await
            .unwrap());
        pool.close().await;
    }

    /// The owner rule (2026-11-10): two consecutive failed deploys of the same
    /// sha pause the fallback sweep, a new sha is a new budget, and a cancel
    /// keeps the sweep off too.
    #[tokio::test]
    async fn sweep_pauses_automatic_deploys_after_two_failures() {
        let cfg = crate::config::config_for_tests();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "paused",
                slug: "paused",
                user_id: "local",
                subdomain: "paused.localhost",
                listen: 30360,
                internal: 30361,
            },
        )
        .await
        .expect("app");
        let production = deploy::DeployTarget::Production;
        let fail = |sha: &'static str| {
            let pool = pool.clone();
            let app_id = app.id.clone();
            async move {
                db::upsert_deploy(
                    &pool,
                    None,
                    &app_id,
                    None,
                    DeployStatus::Failed,
                    Some(sha),
                    "boom",
                )
                .await
                .expect("failed deploy");
            }
        };
        fail("sha1").await;
        assert!(
            sweep_needs_tip(&pool, &app, &production, "sha1")
                .await
                .unwrap(),
            "one failure is still retryable"
        );
        fail("sha1").await;
        assert!(
            !sweep_needs_tip(&pool, &app, &production, "sha1")
                .await
                .unwrap(),
            "the second consecutive failure pauses the sha"
        );
        assert!(
            sweep_needs_tip(&pool, &app, &production, "sha2")
                .await
                .unwrap(),
            "a new sha starts a new budget"
        );

        // A cancel is an operator stop: it never counts as a failure, but the
        // sweep must not retry the sha behind the operator's back.
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Cancelled,
            Some("sha3"),
            "stopped",
        )
        .await
        .expect("cancelled deploy");
        assert!(
            !sweep_needs_tip(&pool, &app, &production, "sha3")
                .await
                .unwrap(),
            "a stopped sha is not retried automatically"
        );

        // The newest row decides for the whole target: the stop is what the
        // UI reports as the pause.
        let state = crate::host::auto_deploy::for_target(&pool, &app.id, None)
            .await
            .expect("auto deploy");
        assert_eq!(
            state,
            crate::models::AutoDeploy::Stopped { sha: "sha3".into() }
        );

        pool.close().await;
    }
}
