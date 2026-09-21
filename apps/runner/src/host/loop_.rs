//! Reconcile tick: desired_state → fleet processes, tip poll → deploy, Caddy, metrics.
//! Named `loop_` because `loop` is a Rust keyword.
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::caddy;
use crate::host::cmd;
use crate::host::deploy::{self, Deploying};
use crate::host::logs::LogState;
use crate::host::metrics::{self, MetricsState};
use crate::host::supervisor::{self, ProcMap};
use crate::lifecycle::{sha_same, DEPLOY_IN_FLIGHT_MS, DEPLOY_STUCK_MS};
use crate::models::{AppStatus, DesiredState};

pub async fn run_forever(
    pool: SqlitePool,
    cfg: Config,
    procs: ProcMap,
    logs: LogState,
    deploying: Deploying,
    mut metrics: MetricsState,
    ready: Arc<AtomicBool>,
) {
    let mut tick = tokio::time::interval(Duration::from_millis(cfg.poll_ms));
    loop {
        tick.tick().await;
        if let Err(e) = reconcile_once(&pool, &cfg, &procs, &logs, &deploying, &mut metrics).await
        {
            tracing::error!(error = %e, "reconcile");
        } else {
            ready.store(true, Ordering::Relaxed);
        }
    }
}

async fn reconcile_once(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    metrics: &mut MetricsState,
) -> anyhow::Result<()> {
    let claimed = deploy::snapshot_claimed(deploying).await;
    let swept = db::fail_stuck_deploys(pool, DEPLOY_STUCK_MS, &claimed).await?;
    if swept > 0 {
        tracing::info!(swept, "swept stalled deploys");
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
        if app.listen_port.is_some() && app.is_deployed() {
            match supervisor::ensure_fleet(pool, cfg, procs, logs, app).await {
                Ok(()) => {
                    // Mirror the stopped branch: a spawned fleet is running.
                    // Without this, start/resume leaves the stop-time status
                    // stuck until the next deploy flips it.
                    if app.status != AppStatus::Running.as_str() {
                        db::update_app_status(pool, &app.id, AppStatus::Running.as_str(), None, None)
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

        let recent = db::list_deploys(pool, &app.id).await?;
        let in_flight = recent.iter().any(|d| {
            let Some(st) = d.status_enum() else {
                return false;
            };
            if !st.is_in_flight() {
                return false;
            }
            crate::models::parse_time(&d.updated_at)
                .map(|t| (chrono::Utc::now() - t).num_milliseconds() < DEPLOY_IN_FLIGHT_MS)
                .unwrap_or(false)
        });
        if in_flight || claimed.contains(&app.id) {
            continue;
        }

        match cmd::head_main_bundle(cfg, &app.slug).await {
            Ok(Some(tip)) => {
                let already = app
                    .last_deploy_sha
                    .as_ref()
                    .is_some_and(|s| sha_same(s, &tip.sha));
                if already {
                    continue;
                }
                tracing::info!(slug = %app.slug, sha = %&tip.sha[..12.min(tip.sha.len())], "git tip changed");
                let app2 = app.clone();
                let tip2 = tip.clone();
                let pool2 = pool.clone();
                let cfg2 = cfg.clone();
                let procs2 = procs.clone();
                let logs2 = logs.clone();
                let deploying2 = deploying.clone();
                tokio::spawn(async move {
                    deploy::deploy_tip(&pool2, &cfg2, &procs2, &logs2, &deploying2, app2, tip2)
                        .await;
                });
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(slug = %app.slug, error = %e, "list tip"),
        }
    }

    let visible = db::list_apps(pool).await?;
    caddy::rewrite_caddy(cfg, &visible).await?;

    metrics::tick(pool, cfg, procs, metrics).await?;
    Ok(())
}
