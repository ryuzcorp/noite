//! Scale to zero (SPEC, Scale to zero): a scheduled sweep parks apps that
//! served no request for `RUNNER_SLEEP_AFTER_H`, and the edge wakes them on
//! the next request — Caddy holds that request (`forward_auth` to
//! `/v1/edge/wake`) until the fleet is healthy, then proxies it as if the app
//! had never slept.
//!
//! Every transition (sleep, wake) for one app runs under that app's lock, so
//! a request arriving while the sweep parks the app waits for the park to
//! finish and then wakes it, instead of racing the fleet shutdown.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::{Mutex, Semaphore};

use crate::config::Config;
use crate::db;
use crate::host::edge_table;
use crate::host::logs::LogState;
use crate::host::supervisor::{self, ProcMap};
use crate::models::{parse_time, App, AppStatus, Environment};

/// Fleets with a running-status confirm in flight (`app:{id}` / `env:{id}`):
/// the reconcile loop spawns one confirm per transitioning fleet instead of
/// blocking behind a health gate, and the set keeps one tick from piling a
/// second confirm onto the first.
pub type Confirming = Arc<Mutex<HashSet<String>>>;

/// Per-app transition locks (keyed by app id, which survives renames).
static LOCKS: LazyLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Host-wide bound on apps cold-starting for a request at once
/// (`RUNNER_WAKE_CONCURRENCY`). Each app's own wakes already coalesce on its
/// lock; this stops a flood aimed at many asleep apps from starting all
/// their fleets together. Sized by the first wake (config is fixed at boot).
fn wake_slots(cfg: &Config) -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(cfg.edge.wake_concurrency.max(1) as usize))
}

fn lock_for(app_id: &str) -> Arc<Mutex<()>> {
    let mut map = LOCKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.entry(app_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// The idle decision, pure so it is testable: an app sleeps when its newest
/// activity (last request, last wake, last deploy, creation) is older than
/// `after_s` seconds. `after_s == 0` disables sleeping.
pub fn should_sleep_s(
    now: DateTime<Utc>,
    activity: &[Option<DateTime<Utc>>],
    after_s: u64,
) -> bool {
    if after_s == 0 {
        return false;
    }
    let Some(newest) = activity.iter().flatten().max() else {
        // No timestamp at all: never guess an app idle.
        return false;
    };
    now - *newest >= chrono::Duration::seconds(after_s as i64)
}

/// Whether the app runs scheduled work: a non-empty `triggers.crons` or
/// `queues.consumers` in its last deployed config (the stored Wrangler
/// JSON). Pure so it is testable; unparseable or missing config means no
/// scheduled work.
pub fn has_scheduled_work(deployed_config: Option<&str>) -> bool {
    let Some(raw) = deployed_config else {
        return false;
    };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let non_empty = |parent: &str, key: &str| {
        cfg.get(parent)
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_array())
            .is_some_and(|a| !a.is_empty())
    };
    non_empty("triggers", "crons") || non_empty("queues", "consumers")
}

/// An app's auto-sleep threshold in seconds, or `None` when it never
/// auto-sleeps: an explicit `0` override, or scheduled work without an
/// explicit override (a sleeping scheduler would silently miss its
/// triggers). `force` (operator sleep, memory-pressure parking) bypasses
/// this. Pure so it is testable.
pub fn auto_sleep_after_s(
    own_sleep_after_s: Option<i64>,
    deployed_config: Option<&str>,
    default_h: u64,
) -> Option<u64> {
    if own_sleep_after_s == Some(0) {
        return None;
    }
    if own_sleep_after_s.is_none() && has_scheduled_work(deployed_config) {
        return None;
    }
    Some(match own_sleep_after_s {
        Some(s) if s > 0 => s as u64,
        _ => default_h.saturating_mul(3600),
    })
}

/// Newest activity timestamps for an app, as `should_sleep` expects them.
async fn activity(pool: &SqlitePool, app: &App) -> Vec<Option<DateTime<Utc>>> {
    let last_request = db::last_request_bucket(pool, &app.id, "")
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

/// The same rule for an environment (ROADMAP: environments scale to zero like
/// apps).
fn sleep_candidate_env(env: &Environment) -> bool {
    !env.is_stopped()
        && !env.is_asleep()
        && env.is_deployed()
        && env.listen_port.is_some()
        && env.status == AppStatus::Running.as_str()
}

/// The scheduled sweep: park every running app — and every running preview
/// environment — idle past its threshold. An app's explicit `sleep_after_s`
/// override wins over the platform default (`0` means never); environments
/// use their owning app's override. Apps running scheduled work (crons,
/// queue consumers) skip auto-sleep unless overridden. Returns how many
/// fleets slept.
pub async fn sweep(pool: &SqlitePool, cfg: &Config, procs: &ProcMap) -> usize {
    // The platform `0` is a master off: no app override re-enables a
    // feature the operator disabled outright.
    if cfg.sleep_after_h == 0 {
        return 0;
    }
    let limits = db::list_app_limits(pool).await.unwrap_or_default();
    let own_of = |app_id: &str| {
        limits
            .iter()
            .find(|l| l.app_id == app_id)
            .and_then(|l| l.sleep_after_s)
    };
    let Ok(apps) = db::list_apps(pool).await else {
        return 0;
    };
    let now = Utc::now();
    let mut parked = 0;
    for app in apps.iter().filter(|a| sleep_candidate(a)) {
        let own = own_of(&app.id);
        let Some(after_s) =
            auto_sleep_after_s(own, app.deployed_config.as_deref(), cfg.sleep_after_h)
        else {
            continue;
        };
        if !should_sleep_s(now, &activity(pool, app).await, after_s) {
            continue;
        }
        match sleep_app(pool, cfg, procs, &app.id, false).await {
            Ok(true) => parked += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(slug = %app.slug, error = %e, "sleep app"),
        }
    }
    let Ok(envs) = db::list_all_environments(pool).await else {
        return parked;
    };
    for env in envs.iter().filter(|e| sleep_candidate_env(e)) {
        let own = own_of(&env.app_id);
        let owner_config = apps
            .iter()
            .find(|a| a.id == env.app_id)
            .and_then(|a| a.deployed_config.as_deref());
        let Some(after_s) = auto_sleep_after_s(own, owner_config, cfg.sleep_after_h) else {
            continue;
        };
        if !should_sleep_s(now, &environment_activity(pool, env).await, after_s) {
            continue;
        }
        match sleep_environment(pool, cfg, procs, &env.id, false).await {
            Ok(true) => parked += 1,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(fleet = %format!("{}.{}", env.app_slug, env.label), error = %e, "sleep environment");
            }
        }
    }
    parked
}

/// Idle signal for an environment: its own last request bucket keyed by
/// environment (like apps), with its own deploy, wake and creation clocks as
/// the floor. An environment nobody requested still parks on its deploy
/// clock; a busy one no longer parks just because its deploy is old.
async fn environment_activity(pool: &SqlitePool, env: &Environment) -> Vec<Option<DateTime<Utc>>> {
    let last_request = db::last_request_bucket(pool, &env.app_id, &env.id)
        .await
        .ok()
        .flatten()
        .and_then(|b| parse_time(&b));
    vec![
        last_request,
        env.last_deployed_at.as_deref().and_then(parse_time),
        env.asleep_since.as_deref().and_then(parse_time),
        env.woke_at.as_deref().and_then(parse_time),
        parse_time(&env.created_at),
    ]
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
    // Re-check under the lock: a request may have woken it, its owner may
    // have stopped it, or its sleep override may have changed, since the
    // sweep read the list.
    if !sleep_candidate(&app) {
        return Ok(false);
    }
    let after_s = if force {
        None
    } else {
        let own = db::get_app_limit(pool, &app.id)
            .await
            .ok()
            .and_then(|l| l.sleep_after_s);
        // The platform `0` is a master off (see `sweep`).
        if cfg.sleep_after_h == 0 && own.is_none() {
            return Ok(false);
        }
        match auto_sleep_after_s(own, app.deployed_config.as_deref(), cfg.sleep_after_h) {
            Some(after_s) => Some(after_s),
            None => return Ok(false),
        }
    };
    if let Some(after_s) = after_s {
        if !should_sleep_s(Utc::now(), &activity(pool, &app).await, after_s) {
            return Ok(false);
        }
    }
    db::set_app_asleep(pool, &app.id).await?;
    edge_table::push_routes(pool, cfg).await?;
    supervisor::stop_fleet(procs, &app.slug, supervisor::StopGrace::NORMAL).await;
    crate::host::stats::record_sleep();
    tracing::info!(slug = %app.slug, force, after_s = after_s.unwrap_or(0), "app asleep");
    Ok(true)
}

/// Memory-pressure parking (SPEC, Scale to zero): when the box is at or above
/// `RUNNER_PRESSURE_PCT` of its memory (the container's cgroup limit when it
/// has one, otherwise the host — the bundled RustFS lives outside this
/// container), park the least-recently-active app that has been idle for
/// `RUNNER_PRESSURE_IDLE_S`. A parked app wakes
/// transparently on its next request, so this trades one cold start for the
/// whole box staying up; an app with an in-flight deploy is never a victim.
pub async fn sweep_under_pressure(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    deploying: &crate::host::deploy::Deploying,
) -> usize {
    if cfg.pressure_pct == 0 {
        return 0;
    }
    let Some((current, limit)) = crate::host::memory::pressure_sample() else {
        return 0;
    };
    if limit == 0 || current.saturating_mul(100) < limit * u64::from(cfg.pressure_pct) {
        return 0;
    }
    // Stop once the box is back under the low watermark, so one sweep does
    // not park every idle app just because the first park left it close.
    let target = u64::from(cfg.pressure_pct.saturating_sub(10));
    let claimed = crate::host::deploy::snapshot_claimed(deploying).await;
    let Ok(apps) = db::list_apps(pool).await else {
        return 0;
    };
    let now = Utc::now();
    let mut idle: Vec<(DateTime<Utc>, String)> = Vec::new();
    for app in apps
        .iter()
        .filter(|app| sleep_candidate(app) && !claimed.contains(&app.id))
    {
        let Some(newest) = activity(pool, app).await.into_iter().flatten().max() else {
            continue;
        };
        if now - newest < chrono::Duration::seconds(cfg.pressure_idle_s as i64) {
            continue;
        }
        idle.push((newest, app.id.clone()));
    }
    idle.sort_by_key(|(newest, _)| *newest);
    let mut parked = 0;
    for (_, id) in idle {
        match sleep_app(pool, cfg, procs, &id, true).await {
            Ok(true) => {
                parked += 1;
                tracing::info!(
                    percent = current.saturating_mul(100) / limit,
                    "app parked under memory pressure"
                );
                record_parked(pool, &id, current, limit).await;
            }
            Ok(false) => {}
            Err(error) => tracing::warn!(error = %error, "pressure park"),
        }
        let Some((now_used, now_limit)) = crate::host::memory::pressure_sample() else {
            break;
        };
        if now_used.saturating_mul(100) < now_limit * target {
            return parked;
        }
    }
    // Preview fleets are residents too; park their idle ones with the same
    // rule and the same event (scoped to the owning app).
    let Ok(envs) = db::list_all_environments(pool).await else {
        return parked;
    };
    let mut idle_envs: Vec<(DateTime<Utc>, String, String)> = Vec::new();
    for env in envs
        .iter()
        .filter(|env| sleep_candidate_env(env) && !claimed.contains(&env.app_id))
    {
        let Some(newest) = environment_activity(pool, env)
            .await
            .into_iter()
            .flatten()
            .max()
        else {
            continue;
        };
        if now - newest < chrono::Duration::seconds(cfg.pressure_idle_s as i64) {
            continue;
        }
        idle_envs.push((newest, env.id.clone(), env.app_id.clone()));
    }
    idle_envs.sort_by_key(|(newest, _, _)| *newest);
    for (_, id, app_id) in idle_envs {
        match sleep_environment(pool, cfg, procs, &id, true).await {
            Ok(true) => {
                parked += 1;
                tracing::info!(
                    percent = current.saturating_mul(100) / limit,
                    "environment parked under memory pressure"
                );
                record_parked(pool, &app_id, current, limit).await;
            }
            Ok(false) => {}
            Err(error) => tracing::warn!(error = %error, "pressure park environment"),
        }
        let Some((now_used, now_limit)) = crate::host::memory::pressure_sample() else {
            break;
        };
        if now_used.saturating_mul(100) < now_limit * target {
            break;
        }
    }
    parked
}

/// Tenant-visible reason for a pressure park: the app event the UI shows.
async fn record_parked(pool: &SqlitePool, app_id: &str, current: u64, limit: u64) {
    let detail = format!(
        "parked to free memory at {}% of the limit; the next request wakes it",
        current.saturating_mul(100) / limit
    );
    let _ = db::insert_app_event(
        pool,
        &crate::models::new_id(),
        app_id,
        "fleet",
        "fleet parked",
        &detail,
        "😴",
        "{}",
        "",
        &crate::models::now_iso(),
    )
    .await;
}

/// Poll the fleet's public health route until celld's ready gate opens.
pub(crate) async fn wait_healthy(cfg: &Config, port: i64, timeout: Duration) -> bool {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_default()
    });
    let client = &*CLIENT;
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

/// Mark one app running once its fleet answers the health gate. The
/// reconcile loop spawns this per transitioning fleet instead of blocking
/// behind the gate; a stop or delete in the window wins through the
/// conditional write, and an unhealthy fleet simply never flips (its deploy
/// row says why).
pub async fn confirm_app_running(
    pool: &SqlitePool,
    cfg: &Config,
    confirming: &Confirming,
    app_id: &str,
    port: i64,
) {
    let key = format!("app:{}", app_id);
    if !confirming.lock().await.insert(key.clone()) {
        return;
    }
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let healthy = wait_healthy(cfg, port, budget).await;
    confirming.lock().await.remove(&key);
    if !healthy {
        tracing::warn!(app_id, "fleet never passed its health gate; leaving status");
        return;
    }
    if let Err(e) =
        db::update_app_status_if_wanted(pool, app_id, AppStatus::Running.as_str(), None).await
    {
        tracing::warn!(app_id, error = %e, "mark running after its health gate");
    }
}

/// The same confirm for one preview environment.
pub async fn confirm_environment_running(
    pool: &SqlitePool,
    cfg: &Config,
    confirming: &Confirming,
    env_id: &str,
    port: i64,
) {
    let key = format!("env:{}", env_id);
    if !confirming.lock().await.insert(key.clone()) {
        return;
    }
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let healthy = wait_healthy(cfg, port, budget).await;
    confirming.lock().await.remove(&key);
    if !healthy {
        tracing::warn!(env_id, "fleet never passed its health gate; leaving status");
        return;
    }
    if let Err(e) =
        db::update_environment_status_if_wanted(pool, env_id, AppStatus::Running.as_str(), None)
            .await
    {
        tracing::warn!(env_id, error = %e, "mark running after its health gate");
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
            Err(_) => anyhow::bail!(
                "too many apps starting at once; waited {}s",
                budget.as_secs()
            ),
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
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    if !wait_healthy(cfg, port, left.max(Duration::from_secs(1))).await {
        anyhow::bail!("fleet not healthy within {}s", cfg.wake_timeout_s);
    }
    // "Running" means the fleet answered the gate above: the write lands
    // after it, and still loses to a stop in the window.
    if app.status != AppStatus::Running.as_str() {
        db::update_app_status_if_wanted(pool, &app.id, AppStatus::Running.as_str(), None).await?;
    }
    if was_asleep {
        // Back to the plain proxy route: later requests skip the wake hop.
        edge_table::push_routes(pool, cfg).await?;
    }
    Ok(())
}

/// Park one environment. Same order as `sleep_app`: flag it asleep, switch its
/// site to the wake-on-request route, *then* stop the fleet. `false` when it
/// no longer qualifies (re-checked under the lock); `force` skips the idle
/// check.
pub async fn sleep_environment(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    env_id: &str,
    force: bool,
) -> anyhow::Result<bool> {
    let lock = lock_for(env_id);
    let _held = lock.lock().await;
    let Some(env) = db::get_environment(pool, env_id).await? else {
        return Ok(false);
    };
    if !sleep_candidate_env(&env) {
        return Ok(false);
    }
    // Environments use their owning app's override and scheduled-work rule;
    // the config lives on the app row, not the environment.
    if !force {
        let owner = db::get_app(pool, &env.app_id).await?;
        let own = db::get_app_limit(pool, &env.app_id)
            .await
            .ok()
            .and_then(|l| l.sleep_after_s);
        if cfg.sleep_after_h == 0 && own.is_none() {
            return Ok(false);
        }
        let owner_config = owner.as_ref().and_then(|a| a.deployed_config.as_deref());
        match auto_sleep_after_s(own, owner_config, cfg.sleep_after_h) {
            Some(after_s) => {
                if !should_sleep_s(Utc::now(), &environment_activity(pool, &env).await, after_s) {
                    return Ok(false);
                }
            }
            None => return Ok(false),
        }
    }
    db::set_environment_asleep(pool, &env.id).await?;
    edge_table::push_routes(pool, cfg).await?;
    supervisor::stop_environment_fleet(procs, &env.app_slug, &env.label).await;
    crate::host::stats::record_sleep();
    tracing::info!(
        fleet = %format!("{}.{}", env.app_slug, env.label),
        force,
        "environment asleep"
    );
    Ok(true)
}

/// Wake one environment for a held request (the edge's env gate and public env
/// sites call this): clear the flag, spawn its fleet, wait for its health
/// gate, then restore the plain proxy route. Concurrent callers queue on the
/// environment's lock.
pub async fn wake_environment(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    env_id: &str,
) -> anyhow::Result<()> {
    let lock = lock_for(env_id);
    let _held = lock.lock().await;
    let Some(env) = db::get_environment(pool, env_id).await? else {
        anyhow::bail!("environment not found");
    };
    if env.is_stopped() {
        anyhow::bail!("environment is stopped");
    }
    let Some(port) = env.listen_port else {
        anyhow::bail!("environment has no port");
    };
    let was_asleep = env.is_asleep();
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let deadline = tokio::time::Instant::now() + budget;
    let _slot = if was_asleep {
        match tokio::time::timeout(budget, wake_slots(cfg).acquire()).await {
            Ok(Ok(permit)) => Some(permit),
            Ok(Err(_)) => anyhow::bail!("wake slots closed"),
            Err(_) => anyhow::bail!(
                "too many fleets starting at once; waited {}s",
                budget.as_secs()
            ),
        }
    } else {
        None
    };
    if was_asleep {
        db::set_environment_awake(pool, &env.id).await?;
        crate::host::stats::record_wake();
        tracing::info!(
            fleet = %format!("{}.{}", env.app_slug, env.label),
            "waking environment for a request"
        );
    }
    let env = db::get_environment(pool, env_id).await?.unwrap_or(env);
    supervisor::ensure_environment_fleet(pool, cfg, procs, logs, &env).await?;
    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
    if !wait_healthy(cfg, port, left.max(Duration::from_secs(1))).await {
        anyhow::bail!(
            "environment fleet not healthy within {}s",
            cfg.wake_timeout_s
        );
    }
    // Same truthful order as `wake_app`.
    if env.status != AppStatus::Running.as_str() {
        db::update_environment_status_if_wanted(pool, &env.id, AppStatus::Running.as_str(), None)
            .await?;
    }
    if was_asleep {
        edge_table::push_routes(pool, cfg).await?;
    }
    Ok(())
}

/// A deploy is activity: wake an asleep environment before its pipeline runs,
/// so the reconcile loop spawns the fleet the new release lands in.
pub async fn wake_environment_for_deploy(pool: &SqlitePool, env: &Environment) {
    if !env.is_asleep() {
        return;
    }
    let lock = lock_for(&env.id);
    let _held = lock.lock().await;
    if let Err(e) = db::set_environment_awake(pool, &env.id).await {
        tracing::warn!(
            fleet = %format!("{}.{}", env.app_slug, env.label),
            error = %e,
            "wake environment for deploy"
        );
    }
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
        Some(
            DateTime::parse_from_rfc3339("2026-09-29T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc)
                + chrono::Duration::hours(h),
        )
    }

    #[test]
    fn sleeps_only_past_the_threshold() {
        let now = at(48).unwrap();
        assert!(should_sleep_s(now, &[at(0), None], 24 * 3600));
        assert!(
            should_sleep_s(now, &[at(24)], 24 * 3600),
            "exactly 24h idle sleeps"
        );
        assert!(
            !should_sleep_s(now, &[at(0), at(30)], 24 * 3600),
            "newest activity wins"
        );
    }

    #[test]
    fn disabled_or_unknown_never_sleeps() {
        let now = at(1000).unwrap();
        assert!(!should_sleep_s(now, &[at(0)], 0), "0 disables");
        assert!(
            !should_sleep_s(now, &[None, None], 24 * 3600),
            "no timestamps: never guess idle"
        );
    }

    /// Minimal celld health gate: 200 on `/.well-known/celld/health`.
    async fn serve_health(listener: tokio::net::TcpListener) {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 4096];
                let mut req = Vec::new();
                while !req.ends_with(b"\r\n\r\n") {
                    let Ok(n) = stream.read(&mut buf).await else {
                        return;
                    };
                    if n == 0 || req.len() > 8192 {
                        return;
                    }
                    req.extend_from_slice(&buf[..n]);
                }
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
                    .await;
            });
        }
    }

    async fn healthy_port() -> i64 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(serve_health(listener));
        i64::from(port)
    }

    async fn dead_port() -> i64 {
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("probe");
        let port = probe.local_addr().expect("addr").port();
        drop(probe);
        i64::from(port)
    }

    /// The gate opens for a serving fleet and stays shut for a dead one.
    #[tokio::test]
    async fn health_gate_tracks_the_fleet() {
        let cfg = crate::config::config_for_tests();
        let port = healthy_port().await;
        assert!(wait_healthy(&cfg, port, Duration::from_secs(5)).await);
        let dead = dead_port().await;
        assert!(!wait_healthy(&cfg, dead, Duration::from_millis(600)).await);
    }

    /// A confirm flips a wanted fleet to running once the gate opens, and
    /// leaves a stopped one alone — the Stop/Start race, pinned.
    #[tokio::test]
    async fn confirm_marks_running_only_while_wanted() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "confirm",
                slug: "confirm",
                user_id: "local",
                subdomain: "confirm.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");
        crate::db::update_app_status(&pool, &app.id, "deploying", None, None)
            .await
            .expect("deploying");
        let confirming: Confirming = Arc::new(Mutex::new(std::collections::HashSet::new()));

        confirm_app_running(&pool, &cfg, &confirming, &app.id, healthy_port().await).await;
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(fresh.status, "running");

        crate::db::patch_app_desired(&pool, &app.id, "stopped")
            .await
            .expect("stop");
        crate::db::update_app_status(&pool, &app.id, "deploying", None, None)
            .await
            .expect("deploying again");
        confirm_app_running(&pool, &cfg, &confirming, &app.id, dead_port().await).await;
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(fresh.status, "deploying");
    }
}

#[cfg(test)]
mod env_activity_tests {
    use super::*;

    async fn seed_app(pool: &SqlitePool) -> App {
        let cfg = crate::config::config_for_tests();
        db::create_app(
            pool,
            &cfg,
            db::NewApp {
                name: "envapp",
                slug: "envapp",
                user_id: "local",
                subdomain: "envapp.localhost",
                listen: 30300,
                internal: 30301,
            },
        )
        .await
        .expect("seed app")
    }

    async fn seed_env(pool: &SqlitePool, app: &App, label: &str, git_ref: &str) -> Environment {
        let cfg = crate::config::config_for_tests();
        db::create_environment(
            pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: &app.slug,
                label,
                kind: crate::models::EnvironmentKind::Branch,
                git_ref,
                created_by: "local",
                listen: 30400,
                internal: 30401,
            },
        )
        .await
        .expect("seed env")
    }

    /// An environment's idle clock reads its own request bucket: traffic
    /// on the environment moves it, production traffic (and a sibling
    /// environment's) does not, and a quiet environment falls back to its
    /// deploy/wake/creation floor instead of sleeping blind.
    #[tokio::test]
    async fn environment_activity_reads_the_environments_own_bucket() {
        // A file-backed database: the metrics tables live in an ATTACHed
        // sibling file, and one pooled `:memory:` connection cannot see
        // another's ATTACH.
        let dir = std::env::temp_dir().join(format!("noite-sleep-env-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("temp db");
        let app = seed_app(&pool).await;
        let env = seed_env(&pool, &app, "preview", "refs/heads/preview").await;
        let app_id = env.app_id.clone();
        // Quiet: no request bucket, but the creation floor is still there.
        let quiet = environment_activity(&pool, &env).await;
        assert_eq!(quiet[0], None, "no traffic yet");
        assert!(
            quiet.iter().any(|t| t.is_some()),
            "the creation clock is the floor"
        );
        // Traffic on the environment moves its clock.
        let bucket = Utc::now().format("%Y-%m-%dT%H:%M:00Z").to_string();
        db::replace_app_metric_usage(&pool, &app_id, &env.id, &bucket, 3, 0, 10)
            .await
            .expect("env traffic");
        let active = environment_activity(&pool, &env).await;
        assert_eq!(
            active[0].map(|t| t.format("%Y-%m-%dT%H:%M:00Z").to_string()),
            Some(bucket.clone()),
            "the environment's own bucket is its newest activity"
        );
        assert!(
            !should_sleep_s(Utc::now(), &active, 3600),
            "a busy environment never parks"
        );
        // Production traffic on the same app does not move it: a sibling
        // environment stays quiet.
        let sibling = seed_env(&pool, &app, "other", "refs/heads/other").await;
        db::replace_app_metric_usage(&pool, &app_id, "", &bucket, 9, 0, 10)
            .await
            .expect("prod traffic");
        let still_quiet = environment_activity(&pool, &sibling).await;
        assert_eq!(
            still_quiet[0], None,
            "production traffic must not count for the environment"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    const CRON_CONFIG: &str = r#"{"triggers":{"crons":["*/5 * * * *"]},"name":"worker"}"#;
    const QUEUE_CONFIG: &str = r#"{"queues":{"consumers":[{"queue":"jobs"}]}}"#;
    const PLAIN_CONFIG: &str = r#"{"name":"worker"}"#;
    const EMPTY_CRON_CONFIG: &str = r#"{"triggers":{"crons":[]}}"#;

    #[test]
    fn scheduled_work_detection() {
        assert!(has_scheduled_work(Some(CRON_CONFIG)), "cron config");
        assert!(has_scheduled_work(Some(QUEUE_CONFIG)), "queue config");
        assert!(!has_scheduled_work(Some(PLAIN_CONFIG)), "plain config");
        assert!(
            !has_scheduled_work(Some(EMPTY_CRON_CONFIG)),
            "empty crons is not scheduled work"
        );
        assert!(!has_scheduled_work(None), "missing config");
        assert!(!has_scheduled_work(Some("not json")), "unparseable config");
    }

    #[test]
    fn explicit_override_wins_over_scheduled_work() {
        // Scheduled work without an override never auto-sleeps.
        assert_eq!(
            auto_sleep_after_s(None, Some(CRON_CONFIG), 24),
            None,
            "cron app without override skips"
        );
        assert_eq!(
            auto_sleep_after_s(None, Some(QUEUE_CONFIG), 24),
            None,
            "queue app without override skips"
        );
        // An explicit override re-enables auto-sleep for scheduled apps.
        assert_eq!(
            auto_sleep_after_s(Some(3600), Some(CRON_CONFIG), 24),
            Some(3600),
            "explicit override wins"
        );
        assert_eq!(
            auto_sleep_after_s(Some(0), Some(CRON_CONFIG), 24),
            None,
            "0 means never, even with an override-shaped value"
        );
    }

    #[test]
    fn threshold_override_and_never() {
        // No override: the platform default in seconds.
        assert_eq!(
            auto_sleep_after_s(None, Some(PLAIN_CONFIG), 24),
            Some(86_400)
        );
        assert_eq!(auto_sleep_after_s(None, None, 6), Some(21_600));
        // An explicit threshold overrides the global one in both directions.
        assert_eq!(
            auto_sleep_after_s(Some(60), Some(PLAIN_CONFIG), 24),
            Some(60),
            "shorter than default"
        );
        assert_eq!(
            auto_sleep_after_s(Some(2_592_000), Some(PLAIN_CONFIG), 24),
            Some(2_592_000),
            "longer than default"
        );
        // Explicit 0 is never, even for a plain app.
        assert_eq!(auto_sleep_after_s(Some(0), None, 24), None);
    }

    #[test]
    fn seconds_threshold_matches_hours() {
        let now = DateTime::parse_from_rfc3339("2026-09-29T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let old = Some(
            DateTime::parse_from_rfc3339("2026-09-28T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        );
        assert!(should_sleep_s(now, &[old], 86_400));
        assert!(!should_sleep_s(now, &[old], 86_401));
        assert!(!should_sleep_s(now, &[old], 0), "0 disables");
    }
}
