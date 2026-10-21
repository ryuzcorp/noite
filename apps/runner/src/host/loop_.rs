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
    // Scoped-key revocation retries (SPEC, Scoped credentials): a store
    // delete refused at revoke time stays marked until the store accepts.
    // One cheap SELECT per tick when nothing pends; a failed sweep backs
    // off a minute instead of hammering a struggling store.
    let mut last_cred_sweep: Option<Instant> = None;
    // Fleets with a running-status confirm in flight (host/sleep.rs): one
    // confirm per transitioning fleet, never blocking the tick.
    let confirming: crate::host::sleep::Confirming =
        Arc::new(tokio::sync::Mutex::new(HashSet::new()));
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
        // Scoped-key revocation retries (SPEC, Scoped credentials): a store
        // delete refused at revoke time stays marked until the store accepts.
        if last_cred_sweep.is_none_or(|at| at.elapsed() >= Duration::from_secs(60)) {
            last_cred_sweep = Some(Instant::now());
            let left = crate::host::credentials::sweep(&pool, &cfg).await;
            if left > 0 {
                tracing::warn!(left, "scoped keys still awaiting revocation");
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
            &confirming,
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
    confirming: &crate::host::sleep::Confirming,
) -> anyhow::Result<()> {
    let claimed = deploy::snapshot_claimed(deploying).await;
    let swept = db::fail_stuck_deploys(pool, DEPLOY_STUCK_MS, &claimed).await?;
    if swept > 0 {
        tracing::info!(swept, "swept stalled deploys");
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
    for app in &apps {
        if app.desired() == DesiredState::Stopped {
            supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
            if app.status != AppStatus::Stopped.as_str() {
                db::update_app_status(pool, &app.id, AppStatus::Stopped.as_str(), None, None)
                    .await?;
            }
            continue;
        }
        // Spawn celld only after a successful deploy — a fleet whose bucket
        // lacks deploy/current.json exits(1) immediately and would crash-loop.
        // Asleep apps stay parked: the next request wakes them through the
        // edge (host/sleep.rs), and respawning here would undo the sleep.
        if app.listen_port.is_some() && app.is_deployed() && !app.is_asleep() {
            match supervisor::ensure_fleet(pool, cfg, procs, logs, app).await {
                Ok(()) => {
                    // "Running" means the fleet answers its health gate, not
                    // just that celld was spawned: confirm off the tick (the
                    // loop must never block behind one app's cold boot) and
                    // flip only while still wanted, so a stop in the window
                    // wins. Without any confirm, start/resume would leave the
                    // stop-time status stuck until the next deploy flips it.
                    if app.status != AppStatus::Running.as_str() {
                        if let Some(port) = app.listen_port {
                            let (pool, cfg, confirming) =
                                (pool.clone(), cfg.clone(), confirming.clone());
                            let id = app.id.clone();
                            tokio::spawn(async move {
                                crate::host::sleep::confirm_app_running(
                                    &pool,
                                    &cfg,
                                    &confirming,
                                    &id,
                                    port,
                                )
                                .await;
                            });
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(slug = %app.slug, error = %e, "ensure_fleet");
                    let msg = format!("{e:#}");
                    db::update_app_status_if_wanted(pool, &app.id, &app.status, Some(&msg)).await?;
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
                let already = target
                    .last_deploy_sha(app)
                    .as_deref()
                    .is_some_and(|s| sha_same(s, &tip.sha));
                if already {
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
            if env.is_stopped() && env.status != AppStatus::Stopped.as_str() {
                db::update_environment_status(pool, &env.id, AppStatus::Stopped.as_str(), None)
                    .await?;
            }
            continue;
        }
        if env.listen_port.is_some() && env.is_deployed() && !env.is_asleep() {
            match supervisor::ensure_environment_fleet(pool, cfg, procs, logs, env).await {
                Ok(()) => {
                    // Same truthful order as the app branch above.
                    if env.status != AppStatus::Running.as_str() {
                        if let Some(port) = env.listen_port {
                            let (pool, cfg, confirming) =
                                (pool.clone(), cfg.clone(), confirming.clone());
                            let id = env.id.clone();
                            tokio::spawn(async move {
                                crate::host::sleep::confirm_environment_running(
                                    &pool,
                                    &cfg,
                                    &confirming,
                                    &id,
                                    port,
                                )
                                .await;
                            });
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(fleet = %fleet, error = %e, "ensure_environment_fleet");
                    let msg = format!("{e:#}");
                    db::update_environment_status_if_wanted(pool, &env.id, &env.status, Some(&msg))
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
                let already = target
                    .last_deploy_sha(&app)
                    .as_deref()
                    .is_some_and(|s| sha_same(s, &tip.sha));
                if already {
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

    metrics::tick(pool, cfg, procs, control_pid, metrics, log_tx).await?;
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

/// True while a recent deploy row is still in flight (T1.6's log-free check):
/// neither the channel drain nor the fallback sweep may start a second deploy
/// over it. DB errors read as "busy" — a deploy storm on a sick database is
/// worse than a delayed tip.
async fn app_has_in_flight(pool: &SqlitePool, app_id: &str) -> bool {
    let Ok(recent) = db::latest_deploy_status(pool, app_id).await else {
        return true;
    };
    recent.iter().any(|(status, updated_at)| {
        let Some(st) = crate::models::DeployStatus::parse(status) else {
            return false;
        };
        if !st.is_in_flight() {
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
        let Some(st) = crate::models::DeployStatus::parse(status) else {
            return false;
        };
        if !st.is_in_flight() {
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
    tracing::info!(slug = %app.slug, git_ref = %notify.git_ref, sha = %&notify.tip.sha[..12.min(notify.tip.sha.len())], "push notified tip");
    spawn_tip_deploy(pool, cfg, procs, logs, deploying, app, target, notify.tip);
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
}
