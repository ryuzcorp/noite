//! Scale to zero (SPEC, Scale to zero): a scheduled sweep parks apps that
//! served no request for `RUNNER_SLEEP_AFTER_H`, and the edge wakes them on
//! the next request — Caddy holds that request (`forward_auth` to
//! `/v1/edge/wake`) until the fleet is healthy, then proxies it as if the app
//! had never slept.
//!
//! Every transition (sleep, wake) for one app runs under that app's lock, so
//! a request arriving while the sweep parks the app waits for the park to
//! finish and then wakes it, instead of racing the fleet shutdown.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, Semaphore};

use crate::config::Config;
use crate::db;
use crate::host::caddy;
use crate::host::logs::LogState;
use crate::host::supervisor::{self, ProcMap};
use crate::models::{parse_time, App, AppStatus};

/// Per-app transition locks (keyed by app id, which survives renames).
fn locks() -> &'static std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Host-wide bound on apps cold-starting for a request at once
/// (`RUNNER_WAKE_CONCURRENCY`). Each app's own wakes already coalesce on its
/// lock; this stops a flood aimed at many asleep apps from starting all
/// their fleets together. Sized by the first wake (config is fixed at boot).
fn wake_slots(cfg: &Config) -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(cfg.edge.wake_concurrency.max(1) as usize))
}

fn lock_for(app_id: &str) -> Arc<Mutex<()>> {
    let mut map = locks().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    map.entry(app_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// The idle decision, pure so it is testable: an app sleeps when its newest
/// activity (last request, last wake, last deploy, creation) is older than
/// `after_h` hours. `after_h == 0` disables sleeping.
pub fn should_sleep(now: DateTime<Utc>, activity: &[Option<DateTime<Utc>>], after_h: u64) -> bool {
    if after_h == 0 {
        return false;
    }
    let Some(newest) = activity.iter().flatten().max() else {
        // No timestamp at all: never guess an app idle.
        return false;
    };
    now - *newest >= chrono::Duration::hours(after_h as i64)
}

/// Newest activity timestamps for an app, as `should_sleep` expects them.
async fn activity(pool: &SqlitePool, app: &App) -> Vec<Option<DateTime<Utc>>> {
    let last_request = db::last_request_bucket(pool, &app.id)
        .await
        .ok()
        .flatten()
        .and_then(|b| parse_time(&b));
    let last_deploy = db::latest_deploy_status(pool, &app.id)
        .await
        .ok()
        .and_then(|rows| rows.into_iter().next())
        .and_then(|(_, updated_at)| parse_time(&updated_at));
    vec![
        last_request,
        last_deploy,
        app.woke_at.as_deref().and_then(parse_time),
        parse_time(&app.created_at),
    ]
}

/// Whether the app may be parked at all right now (independent of idleness).
fn sleep_candidate(app: &App) -> bool {
    !app.is_stopped()
        && !app.is_asleep()
        && app.is_deployed()
        && app.listen_port.is_some()
        && app.status == AppStatus::Running.as_str()
}

/// The scheduled sweep: park every running app idle past the threshold.
/// Returns how many apps went to sleep.
pub async fn sweep(pool: &SqlitePool, cfg: &Config, procs: &ProcMap) -> usize {
    if cfg.sleep_after_h == 0 {
        return 0;
    }
    let Ok(apps) = db::list_apps(pool).await else {
        return 0;
    };
    let now = Utc::now();
    let mut parked = 0;
    for app in apps.iter().filter(|a| sleep_candidate(a)) {
        if !should_sleep(now, &activity(pool, app).await, cfg.sleep_after_h) {
            continue;
        }
        match sleep_app(pool, cfg, procs, &app.id, false).await {
            Ok(true) => parked += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(slug = %app.slug, error = %e, "sleep app"),
        }
    }
    parked
}

async fn rewrite_edge(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<()> {
    let apps = db::list_apps(pool).await?;
    let domains = db::list_app_domains(pool).await.unwrap_or_default();
    let limits = db::list_app_limits(pool).await.unwrap_or_default();
    caddy::rewrite_caddy(cfg, &apps, &domains, &limits).await
}

/// Park one app. Order matters: flag it asleep, switch its sites to the
/// wake-on-request route, *then* stop the fleet — a request arriving
/// mid-transition already takes the wake path (and waits on this lock).
/// Returns false when the app no longer qualifies (re-checked under the lock).
/// `force` skips the idle check (operator `POST /v1/apps/{id}/sleep`).
pub async fn sleep_app(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    app_id: &str,
    force: bool,
) -> anyhow::Result<bool> {
    let lock = lock_for(app_id);
    let _held = lock.lock().await;
    let Some(app) = db::get_app(pool, app_id).await? else {
        return Ok(false);
    };
    // Re-check under the lock: a request may have woken it, or its owner
    // stopped it, since the sweep read the list.
    if !sleep_candidate(&app)
        || (!force
            && !should_sleep(Utc::now(), &activity(pool, &app).await, cfg.sleep_after_h))
    {
        return Ok(false);
    }
    db::set_app_asleep(pool, &app.id).await?;
    rewrite_edge(pool, cfg).await?;
    supervisor::stop_fleet(procs, &app.slug).await;
    crate::host::stats::record_sleep();
    tracing::info!(slug = %app.slug, force, after_h = cfg.sleep_after_h, "app asleep");
    Ok(true)
}

/// Poll the fleet's public health route until celld's ready gate opens.
async fn wait_healthy(cfg: &Config, port: i64, timeout: Duration) -> bool {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default()
    });
    let url = format!(
        "http://{}:{}/.well-known/celld/health",
        cfg.caddy_upstream_host, port
    );
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Wake an app for a held request: clear the flag, spawn its fleet, wait for
/// the health gate, restore the plain proxy route. Concurrent callers queue
/// on the app's lock; the first does the work, the rest find it awake and
/// only confirm health. Errors mean the request cannot be served (503).
pub async fn wake_app(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app_id: &str,
) -> anyhow::Result<()> {
    let lock = lock_for(app_id);
    let _held = lock.lock().await;
    let Some(app) = db::get_app(pool, app_id).await? else {
        anyhow::bail!("app not found");
    };
    if app.is_stopped() {
        anyhow::bail!("app is stopped");
    }
    let Some(port) = app.listen_port else {
        anyhow::bail!("app has no port");
    };
    let was_asleep = app.is_asleep();
    // One budget for queueing behind other apps' cold starts and for the
    // health gate: Caddy stops waiting at `wake_timeout_s` + 15 s.
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let deadline = tokio::time::Instant::now() + budget;
    let _slot = if was_asleep {
        match tokio::time::timeout(budget, wake_slots(cfg).acquire()).await {
            Ok(Ok(permit)) => Some(permit),
            Ok(Err(_)) => anyhow::bail!("wake slots closed"),
            Err(_) => anyhow::bail!("too many apps starting at once; waited {}s", budget.as_secs()),
        }
    } else {
        None
    };
    if was_asleep {
        db::set_app_awake(pool, &app.id).await?;
        crate::host::stats::record_wake();
        tracing::info!(slug = %app.slug, "waking app for a request");
    }
    // Spawn (or confirm) the fleet now rather than on the next reconcile
    // tick: the request is waiting.
    let app = db::get_app(pool, app_id).await?.unwrap_or(app);
    supervisor::ensure_fleet(pool, cfg, procs, logs, &app).await?;
    if app.status != AppStatus::Running.as_str() {
        db::update_app_status(pool, &app.id, AppStatus::Running.as_str(), None, None).await?;
    }
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    if !wait_healthy(cfg, port, left.max(Duration::from_secs(1))).await {
        anyhow::bail!("fleet not healthy within {}s", cfg.wake_timeout_s);
    }
    if was_asleep {
        // Back to the plain proxy route: later requests skip the wake hop.
        rewrite_edge(pool, cfg).await?;
    }
    Ok(())
}

/// A deploy is activity: wake an asleep app before its pipeline runs so the
/// reconcile loop spawns the fleet the new release lands in.
pub async fn wake_for_deploy(pool: &SqlitePool, app: &App) {
    if !app.is_asleep() {
        return;
    }
    let lock = lock_for(&app.id);
    let _held = lock.lock().await;
    if let Err(e) = db::set_app_awake(pool, &app.id).await {
        tracing::warn!(slug = %app.slug, error = %e, "wake for deploy");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(h: i64) -> Option<DateTime<Utc>> {
        Some(DateTime::parse_from_rfc3339("2026-09-29T00:00:00Z").unwrap().with_timezone(&Utc) + chrono::Duration::hours(h))
    }

    #[test]
    fn sleeps_only_past_the_threshold() {
        let now = at(48).unwrap();
        assert!(should_sleep(now, &[at(0), None], 24));
        assert!(should_sleep(now, &[at(24)], 24), "exactly 24h idle sleeps");
        assert!(!should_sleep(now, &[at(0), at(30)], 24), "newest activity wins");
    }

    #[test]
    fn disabled_or_unknown_never_sleeps() {
        let now = at(1000).unwrap();
        assert!(!should_sleep(now, &[at(0)], 0), "0 disables");
        assert!(!should_sleep(now, &[None, None], 24), "no timestamps: never guess idle");
    }
}
