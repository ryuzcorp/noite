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
use crate::host::caddy;
use crate::host::tips::{self, TipBundle};
use crate::host::deploy::{self, Deploying};
use crate::host::logs::LogState;
use crate::host::metrics::{self, MetricsState};
use crate::host::supervisor::{self, ProcMap};
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
    for app in &apps {
        if app.desired() == DesiredState::Stopped {
            supervisor::stop_fleet(procs, &app.slug).await;
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
                    // Mirror the stopped branch: a spawned fleet is running.
                    // Without this, start/resume leaves the stop-time status
                    // stuck until the next deploy flips it.
                    if app.status != AppStatus::Running.as_str() {
                        db::update_app_status(
                            pool,
                            &app.id,
                            AppStatus::Running.as_str(),
                            None,
                            None,
                        )
                        .await?;
                    }
                }
                Err(e) => {
                    tracing::warn!(slug = %app.slug, error = %e, "ensure_fleet");
                    let msg = format!("{e:#}");
                    db::update_app_status(pool, &app.id, &app.status, Some(&msg), None).await?;
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
                let already = app
                    .last_deploy_sha
                    .as_ref()
                    .is_some_and(|s| sha_same(s, &tip.sha));
                if already {
                    continue;
                }
                tracing::info!(slug = %app.slug, sha = %&tip.sha[..12.min(tip.sha.len())], "git tip changed");
                spawn_tip_deploy(pool, cfg, procs, logs, deploying, app.clone(), tip);
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(slug = %app.slug, error = %e, "list tip"),
        }
    }

    let visible = db::list_apps(pool).await?;
    let domains = db::list_app_domains(pool).await.unwrap_or_default();
    let limits = db::list_app_limits(pool).await.unwrap_or_default();
    caddy::rewrite_caddy(cfg, &visible, &domains, &limits).await?;

    metrics::tick(pool, cfg, procs, control_pid, metrics, log_tx).await?;
    Ok(())
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

/// One queued push notification: look the app up fresh (it may have stopped
/// since the push), skip stale/in-flight tips, and deploy the rest. Stopped
/// apps keep accumulating tips in the bucket for the sweep that runs when
/// they resume — the sweep compares against `last_deploy_sha`, so nothing is
/// lost by skipping here.
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
    if app
        .last_deploy_sha
        .as_ref()
        .is_some_and(|s| sha_same(s, &notify.tip.sha))
    {
        return;
    }
    if claimed.contains(&app.id) || app_has_in_flight(pool, &app.id).await {
        return;
    }
    tracing::info!(slug = %app.slug, sha = %&notify.tip.sha[..12.min(notify.tip.sha.len())], "push notified tip");
    spawn_tip_deploy(pool, cfg, procs, logs, deploying, app, notify.tip);
}

/// Hand a fresh tip to the deploy pipeline on its own task: the loop must
/// never block behind a build. `deploy_tip` re-checks the sha, so a tip that
/// went stale between the check above and the spawn is still safe.
fn spawn_tip_deploy(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    tip: TipBundle,
) {
    let pool = pool.clone();
    let cfg = cfg.clone();
    let procs = procs.clone();
    let logs = logs.clone();
    let deploying = deploying.clone();
    tokio::spawn(async move {
        deploy::deploy_tip(&pool, &cfg, &procs, &logs, &deploying, app, tip).await;
    });
}
