//! Scale to zero (SPEC, Scale to zero): a scheduled sweep parks apps that
//! served no request for `RUNNER_SLEEP_AFTER_MIN`/`RUNNER_SLEEP_AFTER_H`, and
//! the edge wakes them on the next request — Caddy holds that request
//! (`forward_auth` to `/v1/edge/wake`) until the fleet is healthy, then
//! proxies it as if the app had never slept.
//!
//! Every transition (sleep, wake) for one app runs under that app's lock, so
//! a request arriving while the sweep parks the app waits for the park to
//! finish and then wakes it, instead of racing the fleet shutdown.
//!
//! ## The scale-to-zero machine
//!
//! The persisted half of "is it up?" is one row plus one route flag; the
//! in-memory half is [`supervisor::FleetState`]. Both are written here in one
//! order, and only here:
//!
//! ```text
//! stateDiagram-v2
//!     Awake --> Parking: sweep / operator sleep / pressure
//!     Parking --> Asleep: routes wake-enabled, fleet stopped
//!     Asleep --> Waking: held request / deploy (lock, slot, spawn)
//!     Waking --> Awake: health gate 200 -> running, wake hop dropped
//!     Waking --> Asleep: any failure (row and route untouched)
//!     Awake --> Awake: request / deploy (activity)
//!
//! A parked fleet can carry a crash/OOM hold (`supervisor::FleetState::Asleep
//! { until }`). Every wake moves it into `Waking { until }` — the hold is the
//! fleet's, not the wake's — and nothing spawns through it: a request answers
//! the wake-failure status, and a deploy's fleet starts once the backoff has
//! lapsed instead of on the next reconcile tick.
//! ```
//!
//! `status = 'sleeping'` and `asleep_since` are written together (both db
//! helpers do), the flag is cleared only after the fleet answers, and the
//! route's `asleep` flag is derived from the row by `edge_table::build_table`.
//! A wake that fails therefore changes nothing at all.
use std::collections::HashMap;
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
    default_s: u64,
) -> Option<u64> {
    if own_sleep_after_s == Some(0) {
        return None;
    }
    if own_sleep_after_s.is_none() && has_scheduled_work(deployed_config) {
        return None;
    }
    Some(match own_sleep_after_s {
        Some(s) if s > 0 => s as u64,
        _ => default_s,
    })
}

/// Newest activity timestamps for an app, as `should_sleep` expects them.
async fn activity(pool: &SqlitePool, app: &App) -> Vec<Option<DateTime<Utc>>> {
    let last_request = db::last_request_us(pool, &app.id, "")
        .await
        .ok()
        .flatten()
        .and_then(DateTime::from_timestamp_micros);
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

/// The instant the access-log tail last had to drop a burst instead of
/// consuming it, if it ever did (`host::accesslog`).
async fn access_log_skip_at(pool: &SqlitePool) -> Option<DateTime<Utc>> {
    db::get_setting(pool, db::ACCESS_LOG_SKIP_AT)
        .await
        .ok()
        .flatten()
        .and_then(|value| parse_time(&value))
}

/// Whether a burst skip makes an idle decision untrustworthy: the tail lost
/// those lines, so a request they held should still keep the app awake when
/// the skip is inside the app's sleep window. An older skip cannot change the
/// decision — should the dropped requests be the newest activity, they are
/// already older than the window. Pure so it is testable.
fn skip_inside_window(skip_at: Option<DateTime<Utc>>, now: DateTime<Utc>, after_s: u64) -> bool {
    skip_at.is_some_and(|skip| now - skip < chrono::Duration::seconds(after_s as i64))
}

/// Whether the app may be parked at all right now (independent of idleness).
fn sleep_candidate(app: &App) -> bool {
    !app.is_stopped()
        && !app.is_asleep()
        && app.is_deployed()
        && app.listen_port.is_some()
        && app.status == AppStatus::Running
}

/// The same rule for an environment (ROADMAP: environments scale to zero like
/// apps).
fn sleep_candidate_env(env: &Environment) -> bool {
    !env.is_stopped()
        && !env.is_asleep()
        && env.is_deployed()
        && env.listen_port.is_some()
        && env.status == AppStatus::Running
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
    if cfg.sleep_after_s == 0 {
        return 0;
    }
    let limits = match db::list_app_limits(pool).await {
        Ok(limits) => limits,
        Err(error) => {
            // Without the overrides, an explicit "never" could be ignored and
            // an idle app parked. Skip this sweep; the next tick retries.
            tracing::warn!(error = %error, "sleep sweep: app limits unavailable");
            return 0;
        }
    };
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
    let skip_at = access_log_skip_at(pool).await;
    let mut parked = 0;
    for app in apps.iter().filter(|a| sleep_candidate(a)) {
        let own = own_of(&app.id);
        let Some(after_s) =
            auto_sleep_after_s(own, app.deployed_config.as_deref(), cfg.sleep_after_s)
        else {
            continue;
        };
        if skip_inside_window(skip_at, now, after_s) {
            tracing::debug!(
                slug = %app.slug,
                "sleep refused: the access log dropped a burst inside the sleep window"
            );
            continue;
        }
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
        let Some(after_s) = auto_sleep_after_s(own, owner_config, cfg.sleep_after_s) else {
            continue;
        };
        if skip_inside_window(skip_at, now, after_s) {
            tracing::debug!(
                fleet = %format!("{}.{}", env.app_slug, env.label),
                "sleep refused: the access log dropped a burst inside the sleep window"
            );
            continue;
        }
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

/// Idle signal for an environment: its own last request stamp keyed by
/// environment (like apps), with its own deploy, wake and creation clocks as
/// the floor. An environment nobody requested still parks on its deploy
/// clock; a busy one no longer parks just because its deploy is old.
async fn environment_activity(pool: &SqlitePool, env: &Environment) -> Vec<Option<DateTime<Utc>>> {
    let last_request = db::last_request_us(pool, &env.app_id, &env.id)
        .await
        .ok()
        .flatten()
        .and_then(DateTime::from_timestamp_micros);
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
        let own = db::get_app_limit(pool, &app.id).await?.sleep_after_s;
        // The platform `0` is a master off (see `sweep`): no override
        // re-enables it.
        if cfg.sleep_after_s == 0 {
            return Ok(false);
        }
        match auto_sleep_after_s(own, app.deployed_config.as_deref(), cfg.sleep_after_s) {
            Some(after_s) => Some(after_s),
            None => return Ok(false),
        }
    };
    if let Some(after_s) = after_s {
        let now = Utc::now();
        // A burst skip inside the window means the feed may be missing this
        // app's requests; idle-based parking must not act on that.
        if skip_inside_window(access_log_skip_at(pool).await, now, after_s) {
            tracing::debug!(
                slug = %app.slug,
                "sleep refused: the access log dropped a burst inside the sleep window"
            );
            return Ok(false);
        }
        if !should_sleep_s(now, &activity(pool, &app).await, after_s) {
            return Ok(false);
        }
    }
    // The write is the admission: a deploy that moved the app to `building`
    // after the recheck above refuses the park, and stopping its fleet then
    // would kill the build.
    if !db::set_app_asleep(pool, &app.id).await?.is_applied() {
        tracing::debug!(slug = %app.slug, "sleep refused: the app moved on");
        return Ok(false);
    }
    edge_table::push_routes(pool, cfg).await?;
    // The fleet map keeps the park (so a confirm in the window sees a parked
    // fleet rather than a missing one) and hands back the child, which is
    // stopped here: a parked fleet holding a live child is unrepresentable.
    if let Some((child, epoch)) = supervisor::park(procs, &app.slug).await {
        supervisor::stop_child(
            procs,
            &app.slug,
            child,
            supervisor::StopGrace::NORMAL,
            epoch,
        )
        .await;
    }
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
/// behind the gate; the fleet's own state decides the outcome, so a stop or a
/// park in the window wins — a confirm that raced a park can never flip a
/// parked row back to `running`.
pub async fn confirm_app_running(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    app_id: &str,
    fleet: &str,
    port: i64,
) {
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    if !supervisor::probe_started(procs, fleet, budget).await {
        return;
    }
    let healthy = wait_healthy(cfg, port, budget).await;
    if !healthy {
        // The probe reported "not yet": back to `Spawning` so the next tick
        // retries, instead of the status sticking at `building` forever.
        supervisor::probe_gave_up(procs, fleet).await;
        tracing::warn!(app_id, "fleet never passed its health gate; leaving status");
        return;
    }
    if !supervisor::confirmed(procs, fleet).await {
        tracing::info!(
            app_id,
            "health gate passed after the fleet was parked or stopped"
        );
        return;
    }
    // The park path holds this lock across "flag asleep → push routes → park".
    // Taking it is what makes a confirm that raced a park lose: either the
    // park finished (the fleet is gone, so the state re-check refuses the
    // write) or it has not started (and it re-reads a `running` row, which is
    // still parkable).
    let lock = lock_for(app_id);
    let _held = lock.lock().await;
    if !matches!(
        supervisor::state_of(procs, fleet).await,
        supervisor::FleetState::Healthy { .. }
    ) {
        return;
    }
    if let Err(e) = db::write_app_status(
        pool,
        app_id,
        AppStatus::Running,
        None,
        None,
        crate::models::WriteGuard::Wanted,
    )
    .await
    {
        tracing::warn!(app_id, error = %e, "mark running after its health gate");
    }
}

/// The same confirm for one preview environment.
pub async fn confirm_environment_running(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    env_id: &str,
    fleet: &str,
    port: i64,
) {
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    if !supervisor::probe_started(procs, fleet, budget).await {
        return;
    }
    let healthy = wait_healthy(cfg, port, budget).await;
    if !healthy {
        supervisor::probe_gave_up(procs, fleet).await;
        tracing::warn!(env_id, "fleet never passed its health gate; leaving status");
        return;
    }
    if !supervisor::confirmed(procs, fleet).await {
        tracing::info!(
            env_id,
            "health gate passed after the fleet was parked or stopped"
        );
        return;
    }
    let lock = lock_for(env_id);
    let _held = lock.lock().await;
    if !matches!(
        supervisor::state_of(procs, fleet).await,
        supervisor::FleetState::Healthy { .. }
    ) {
        return;
    }
    if let Err(e) = db::write_environment_status(
        pool,
        env_id,
        AppStatus::Running,
        None,
        crate::models::WriteGuard::Wanted,
    )
    .await
    {
        tracing::warn!(env_id, error = %e, "mark running after its health gate");
    }
}

/// Wake an app for a held request: spawn its fleet, wait for the health gate,
/// and only then clear the asleep flag and restore the plain proxy route.
///
/// That order is the whole point. The row and the route used to be flipped
/// awake *before* the spawn, so a wake that failed (no slot, a spawn error, a
/// health timeout) left an "awake" app with no fleet whose next reconcile tick
/// pushed a route straight at a dead port — every request hit the retrying 502
/// page instead of the wake hop. Now a failed wake leaves the app exactly as
/// parked as it was, and the next request simply tries again.
///
/// Concurrent callers queue on the app's lock; the first does the work, the
/// rest find it awake and only confirm health. Errors mean the request cannot
/// be served (503).
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
    // A fleet held after a crash or an OOM kill is not respawned on a
    // request: the whole point of the hold is that a crash-looping app does
    // not spawn once per request. The held request answers the wake-failure
    // status and the next one after the hold retries.
    if let Some(until) = supervisor::hold_until(procs, &app.slug).await {
        let now = std::time::Instant::now();
        if until > now {
            anyhow::bail!(
                "fleet is restarting after a crash; retry in {}s",
                (until - now).as_secs().max(1)
            );
        }
    }
    // One budget for queueing behind other apps' cold starts and for the
    // health gate: Caddy stops waiting at `wake_timeout_s` + 15 s.
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let deadline = tokio::time::Instant::now() + budget;
    let _slot = if was_asleep {
        match tokio::time::timeout(budget, wake_slots(cfg).acquire()).await {
            Ok(Ok(permit)) => Some(permit),
            Ok(Err(_)) => {
                supervisor::note_event(procs, &app.slug, supervisor::FleetEvent::Parked).await;
                anyhow::bail!("wake slots closed");
            }
            Err(_) => {
                supervisor::note_event(procs, &app.slug, supervisor::FleetEvent::Parked).await;
                anyhow::bail!(
                    "too many apps starting at once; waited {}s",
                    budget.as_secs()
                );
            }
        }
    } else {
        None
    };
    if was_asleep {
        // In memory only: the row keeps saying asleep until the gate opens.
        supervisor::note_event(
            procs,
            &app.slug,
            supervisor::FleetEvent::Woke {
                at: std::time::Instant::now(),
            },
        )
        .await;
        tracing::info!(slug = %app.slug, "waking app for a request");
    }
    // Spawn (or confirm) the fleet now rather than on the next reconcile
    // tick: the request is waiting.
    let app = db::get_app(pool, app_id).await?.unwrap_or(app);
    let woke = async {
        supervisor::ensure_fleet(pool, cfg, procs, logs, &app).await?;
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if !wait_healthy(cfg, port, left.max(Duration::from_secs(1))).await {
            anyhow::bail!("fleet not healthy within {}s", cfg.wake_timeout_s);
        }
        if !supervisor::confirmed(procs, &app.slug).await {
            anyhow::bail!("fleet stopped while waking");
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(e) = woke {
        // The app stays parked: row and route are untouched, so the next
        // request takes the wake path again instead of the edge proxying to a
        // port nothing serves. The same rollback as `wake_environment` — a
        // cold start that died keeps its crash/OOM hold.
        if was_asleep {
            park_after_failed_wake(pool, cfg, procs, &app.slug, &app.id).await;
        }
        return Err(e);
    }
    // "Running" means the fleet answered the gate above: the write lands
    // after it, and still loses to a stop in the window.
    if app.status != AppStatus::Running {
        db::write_app_status(
            pool,
            &app.id,
            AppStatus::Running,
            None,
            None,
            crate::models::WriteGuard::Wanted,
        )
        .await?;
    }
    if was_asleep {
        // The app serves now: clear the flag, then let the route table drop
        // the wake hop.
        db::set_app_awake(pool, &app.id).await?;
        crate::host::stats::record_wake();
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
        let own = db::get_app_limit(pool, &env.app_id).await?.sleep_after_s;
        // The platform `0` is a master off (see `sweep`): no override
        // re-enables it.
        if cfg.sleep_after_s == 0 {
            return Ok(false);
        }
        let owner_config = owner.as_ref().and_then(|a| a.deployed_config.as_deref());
        match auto_sleep_after_s(own, owner_config, cfg.sleep_after_s) {
            Some(after_s) => {
                if !should_sleep_s(Utc::now(), &environment_activity(pool, &env).await, after_s) {
                    return Ok(false);
                }
            }
            None => return Ok(false),
        }
    }
    // Same rule as `sleep_app`: a refused park means the environment moved on
    // (a deploy started), so its fleet must stay up.
    if !db::set_environment_asleep(pool, &env.id)
        .await?
        .is_applied()
    {
        tracing::debug!(
            fleet = %format!("{}.{}", env.app_slug, env.label),
            "sleep refused: the environment moved on"
        );
        return Ok(false);
    }
    edge_table::push_routes(pool, cfg).await?;
    let fleet = supervisor::env_fleet_key(&env.app_slug, &env.label);
    if let Some((child, epoch)) = supervisor::park(procs, &fleet).await {
        supervisor::stop_child(procs, &fleet, child, supervisor::StopGrace::NORMAL, epoch).await;
    }
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
    let fleet = supervisor::env_fleet_key(&env.app_slug, &env.label);
    // Same hold rule as `wake_app`: a crash-looping fleet is not respawned
    // once per request.
    if let Some(until) = supervisor::hold_until(procs, &fleet).await {
        let now = std::time::Instant::now();
        if until > now {
            anyhow::bail!(
                "fleet is restarting after a crash; retry in {}s",
                (until - now).as_secs().max(1)
            );
        }
    }
    let budget = Duration::from_secs(cfg.wake_timeout_s.max(1));
    let deadline = tokio::time::Instant::now() + budget;
    let _slot = if was_asleep {
        match tokio::time::timeout(budget, wake_slots(cfg).acquire()).await {
            Ok(Ok(permit)) => Some(permit),
            Ok(Err(_)) => {
                supervisor::note_event(procs, &fleet, supervisor::FleetEvent::Parked).await;
                anyhow::bail!("wake slots closed");
            }
            Err(_) => {
                supervisor::note_event(procs, &fleet, supervisor::FleetEvent::Parked).await;
                anyhow::bail!(
                    "too many fleets starting at once; waited {}s",
                    budget.as_secs()
                );
            }
        }
    } else {
        None
    };
    if was_asleep {
        // In memory only: the row keeps saying asleep until the gate opens,
        // so a failed wake leaves the environment as parked as it was.
        supervisor::note_event(
            procs,
            &fleet,
            supervisor::FleetEvent::Woke {
                at: std::time::Instant::now(),
            },
        )
        .await;
        tracing::info!(fleet = %fleet, "waking environment for a request");
    }
    let env = db::get_environment(pool, env_id).await?.unwrap_or(env);
    let woke = async {
        supervisor::ensure_environment_fleet(pool, cfg, procs, logs, &env).await?;
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if !wait_healthy(cfg, port, left.max(Duration::from_secs(1))).await {
            anyhow::bail!(
                "environment fleet not healthy within {}s",
                cfg.wake_timeout_s
            );
        }
        if !supervisor::confirmed(procs, &fleet).await {
            anyhow::bail!("environment fleet stopped while waking");
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(e) = woke {
        // Same rollback as `wake_app`: a fleet this wake started and left
        // running is stopped, and one that died keeps its crash/OOM hold.
        if was_asleep {
            park_after_failed_wake(pool, cfg, procs, &fleet, &env.app_id).await;
        }
        return Err(e);
    }
    // Same truthful order as `wake_app`: the row is only cleared once the
    // fleet answers, and the route keeps its wake hop until then.
    if env.status != AppStatus::Running {
        db::write_environment_status(
            pool,
            &env.id,
            AppStatus::Running,
            None,
            crate::models::WriteGuard::Wanted,
        )
        .await?;
    }
    if was_asleep {
        db::set_environment_awake(pool, &env.id).await?;
        crate::host::stats::record_wake();
        edge_table::push_routes(pool, cfg).await?;
    }
    Ok(())
}

/// Put a fleet back where a failed wake found it. Three outcomes, and the
/// difference matters:
///
/// - the cold start never spawned a child: nothing to do but record the park;
/// - the child it started is still running: stop it (nobody would confirm or
///   park a live child behind a parked row — the sweep only sees awake apps);
/// - the child it started has died: **keep the crash/OOM hold**, so the parked
///   app is not spawned again on the very next request. Stopping the chain
///   with `stop_fleet` here is what turned a board-boot crash loop into one
///   spawn per held request.
async fn park_after_failed_wake(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    fleet: &str,
    app_id: &str,
) {
    // The hold may already be in place — either from before the wake or from
    // the reaping `ensure_fleet` did while it looked for a child. Either way it
    // is what keeps the next request from spawning a crash loop again.
    let now = std::time::Instant::now();
    if supervisor::hold_until(procs, fleet)
        .await
        .is_some_and(|until| until > now)
    {
        return;
    }
    let memory_mb = supervisor::fleet_memory_mb(pool, cfg, app_id).await;
    match supervisor::note_exit(procs, fleet, memory_mb).await {
        Some(state) if state.hold_until().is_some() => {
            // It crashed on the way up: the hold is the park's memory of that.
            debug_assert!(!state.is_live(), "a held fleet has no child");
        }
        _ => {
            if let Some((child, epoch)) = supervisor::park(procs, fleet).await {
                // Graceful, not `FOR_DELETE`: this fleet is not being deleted,
                // its data stays, and a SIGKILL would leave the leases it holds
                // for the next wake to wait out.
                supervisor::stop_child(
                    procs,
                    fleet,
                    child,
                    supervisor::StopGrace::FAILED_WAKE,
                    epoch,
                )
                .await;
            }
        }
    }
}

/// A deploy is activity: wake an asleep environment before its pipeline runs,
/// so the reconcile loop spawns the fleet the new release lands in.
pub async fn wake_environment_for_deploy(pool: &SqlitePool, procs: &ProcMap, env: &Environment) {
    if !env.is_asleep() {
        return;
    }
    let lock = lock_for(&env.id);
    let _held = lock.lock().await;
    // The in-memory half has to wake too: leaving the entry `Asleep` makes the
    // deploy's own `ensure_environment_fleet` see a parked fleet and refuse to
    // spawn it. `Woke` keeps the hold a parked fleet inherited — a deploy is
    // why the fleet may spawn, not a reason to drop its crash/OOM backoff.
    supervisor::note_event(
        procs,
        &supervisor::env_fleet_key(&env.app_slug, &env.label),
        supervisor::FleetEvent::Woke {
            at: std::time::Instant::now(),
        },
    )
    .await;
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
pub async fn wake_for_deploy(pool: &SqlitePool, procs: &ProcMap, app: &App) {
    if !app.is_asleep() {
        return;
    }
    let lock = lock_for(&app.id);
    let _held = lock.lock().await;
    // Same as the environment: a deploy needs the fleet to spawn, so the
    // state machine must not still say `Asleep`. The wake carries any hold
    // the park inherited, so the spawn still waits it out.
    supervisor::note_event(
        procs,
        &app.slug,
        supervisor::FleetEvent::Woke {
            at: std::time::Instant::now(),
        },
    )
    .await;
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

    /// A burst skip inside an app's sleep window means the access-log feed
    /// may be missing that app's requests, so an idle decision must not be
    /// acted on; once the skip is older than the window it changes nothing.
    #[test]
    fn a_burst_skip_only_blocks_the_window_it_falls_in() {
        let now = at(48).unwrap();
        assert!(
            skip_inside_window(at(47), now, 2 * 3600),
            "a skip an hour ago is inside a two-hour window"
        );
        assert!(
            skip_inside_window(at(48), now, 3600),
            "a skip right now is inside the window"
        );
        assert!(
            !skip_inside_window(at(46), now, 3600),
            "a skip older than the window cannot hide newer activity"
        );
        assert!(
            !skip_inside_window(at(46), now, 2 * 3600),
            "and the boundary is the window's own end"
        );
        assert!(!skip_inside_window(at(48), now, 0), "0 disables sleeping");
        assert!(!skip_inside_window(None, now, 3600), "no skip, no block");
    }

    /// The sweep and the `force = false` recheck both refuse idle-based
    /// parking while a burst skip is inside the window; a forced park ignores
    /// the skip, and the sweep resumes once the window has passed.
    #[tokio::test]
    async fn a_burst_skip_blocks_idle_parking_until_the_window_passes() {
        let mut cfg = crate::config::config_for_tests();
        cfg.sleep_after_s = 3600;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let skipped = seed_idle_app(&pool, &cfg, "skipped").await;
        let older = seed_idle_app(&pool, &cfg, "older-skip").await;
        let procs = supervisor::new_procs();
        crate::db::set_setting(
            &pool,
            crate::db::ACCESS_LOG_SKIP_AT,
            &Utc::now().to_rfc3339(),
        )
        .await
        .expect("skip stamp");

        assert_eq!(
            sweep(&pool, &cfg, &procs).await,
            0,
            "a skip inside the window refuses the idle park"
        );
        let fresh = crate::db::get_app(&pool, &skipped.id)
            .await
            .expect("get")
            .expect("row");
        assert!(fresh.asleep_since.is_none(), "still awake");
        assert_eq!(fresh.status, AppStatus::Running);

        // An explicit park is not an idle decision: the operator's call stands.
        assert!(
            sleep_app(&pool, &cfg, &procs, &skipped.id, true)
                .await
                .expect("forced park"),
            "a forced park ignores the skip"
        );

        // The skip is now older than the window: parking resumes.
        crate::db::set_setting(
            &pool,
            crate::db::ACCESS_LOG_SKIP_AT,
            &(Utc::now() - chrono::Duration::hours(2)).to_rfc3339(),
        )
        .await
        .expect("old skip stamp");
        assert_eq!(
            sweep(&pool, &cfg, &procs).await,
            1,
            "a skip older than the window no longer blocks"
        );
        let parked = crate::db::get_app(&pool, &older.id)
            .await
            .expect("get")
            .expect("row");
        assert!(parked.asleep_since.is_some(), "the idle app parks");
        assert_eq!(parked.status, AppStatus::Sleeping);
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

    /// A parked app whose fleet is gone must never be flipped back to
    /// `running` by a health confirm: that is the confirm-vs-park race, which
    /// used to leave `status='running'` + `asleep_since` on the same row (a
    /// badge that says running while nothing serves, and a parked app the
    /// sweep no longer considers as sleeping). The confirm now asks the fleet
    /// state before it writes, so a park that won the race refuses the write.
    #[tokio::test]
    async fn a_park_that_won_the_race_is_never_flipped_back_to_running() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "raced").await;
        let procs = supervisor::new_procs();
        let fleet = app.slug.clone();
        // The park side, exactly as `sleep_app` leaves it: row asleep, fleet
        // stopped, fleet map parked.
        park_row(&pool, &app.id).await;
        supervisor::stop_fleet(&procs, &fleet, supervisor::StopGrace::NORMAL).await;
        supervisor::note_event(&procs, &fleet, supervisor::FleetEvent::Parked).await;

        // A healthy gate on a port that really serves: only the fleet state
        // can refuse the write below.
        confirm_app_running(&pool, &cfg, &procs, &app.id, &fleet, healthy_port().await).await;

        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert!(
            fresh.asleep_since.is_some(),
            "a parked app stays asleep after a late confirm"
        );
        assert_eq!(
            fresh.status,
            AppStatus::Sleeping,
            "and its badge keeps saying so: `running` + asleep is the bad state"
        );
    }

    /// The same invariant under the real interleaving: a confirm is mid-probe
    /// while the park runs, and the two are serialized by the app's lock.
    #[tokio::test]
    async fn a_confirm_in_flight_loses_to_a_park() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 5;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "inflight").await;
        let procs = supervisor::new_procs();
        let fleet = app.slug.clone();
        supervisor::note_event(
            &procs,
            &fleet,
            supervisor::FleetEvent::Spawned {
                at: std::time::Instant::now(),
            },
        )
        .await;
        let (port, release) = held_health().await;
        let (done, finished) = tokio::sync::oneshot::channel();
        let (pool2, cfg2, procs2, id) = (pool.clone(), cfg.clone(), procs.clone(), app.id.clone());
        let fleet2 = fleet.clone();
        tokio::spawn(async move {
            confirm_app_running(&pool2, &cfg2, &procs2, &id, &fleet2, port).await;
            let _ = done.send(());
        });
        // Park while the probe is still open, then let the gate answer.
        park_row(&pool, &app.id).await;
        supervisor::stop_fleet(&procs, &fleet, supervisor::StopGrace::NORMAL).await;
        supervisor::note_event(&procs, &fleet, supervisor::FleetEvent::Parked).await;
        let _ = release.send(());

        tokio::time::timeout(Duration::from_secs(10), finished)
            .await
            .expect("the confirm finishes")
            .expect("confirm task");
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert!(fresh.asleep_since.is_some(), "still parked");
        assert_eq!(
            fresh.status,
            AppStatus::Sleeping,
            "never flipped to running"
        );
    }

    /// A wake that fails changes nothing: the row keeps its asleep flag and
    /// the route keeps its wake hop, so the next request retries the wake
    /// instead of the edge proxying at a port nothing serves.
    #[tokio::test]
    async fn a_failed_wake_leaves_the_app_parked() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        // The spawn cannot succeed: no celld binary at this path.
        cfg.celld_bin = "/nonexistent/celld".into();
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "wake").await;
        park_row(&pool, &app.id).await;
        park_row(&pool, &app.id).await;
        let procs = supervisor::new_procs();
        let logs = crate::host::logs::new_state();

        let woke = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;

        assert!(woke.is_err(), "a fleet that cannot spawn does not wake");
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert!(
            fresh.asleep_since.is_some(),
            "the app is still parked: its route keeps the wake hop"
        );
        assert_eq!(fresh.status, AppStatus::Sleeping);
        assert_eq!(
            supervisor::state_of(&procs, &app.slug).await,
            supervisor::FleetState::Asleep { until: None },
            "the fleet state agrees with the row"
        );
    }

    /// Park the row the way a running app is parked: `set_app_asleep` only
    /// applies from `running` now (its `status IN (…)` guard), and a test that
    /// parks a `deploying` row would describe a state the runner cannot reach.
    async fn park_row(pool: &SqlitePool, id: &str) {
        crate::db::write_app_status(
            pool,
            id,
            AppStatus::Running,
            None,
            None,
            crate::models::WriteGuard::Table,
        )
        .await
        .expect("running row before the park");
        assert!(
            crate::db::set_app_asleep(pool, id)
                .await
                .expect("park")
                .is_applied(),
            "a running row parks"
        );
    }

    /// Leave `slug` in the state a crashed fleet reaches: a real child that has
    /// exited, observed through the supervisor's own exit path (no pre-seeded
    /// hold, no direct state poke).
    async fn crash_the_child(procs: &ProcMap, slug: &str) {
        let child = tokio::process::Command::new("true")
            .kill_on_drop(true)
            .spawn()
            .expect("a child that exits at once");
        procs
            .lock()
            .await
            .insert(slug.to_string(), supervisor::FleetEntry::test_entry(child));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if supervisor::note_exit(procs, slug, 256).await.is_some() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("the child never exited");
    }

    /// A fleet held after a crash is not respawned by a request: that hold is
    /// exactly what stops a crash-looping app from spawning once per held
    /// request. The request answers the wake-failure status instead.
    #[tokio::test]
    async fn a_wake_fails_fast_while_the_crash_hold_stands() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "held").await;
        park_row(&pool, &app.id).await;
        let procs = supervisor::new_procs();
        crash_the_child(&procs, &app.slug).await;
        assert!(supervisor::hold_until(&procs, &app.slug).await.is_some());
        let logs = crate::host::logs::new_state();

        let woke = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;

        let err = format!("{:#}", woke.expect_err("the hold refuses the wake"));
        assert!(
            err.contains("restarting after a crash"),
            "the failure names the hold: {err}"
        );
        assert!(
            supervisor::live_keys(&procs).await.is_empty(),
            "and nothing was spawned for the request"
        );
    }

    /// A failed wake stops the cold start it created gracefully, so celld can
    /// release the leases its cells hold. `FOR_DELETE` (SIGKILL) left the next
    /// wake waiting out the lease TTL and timing out again.
    #[tokio::test]
    async fn a_failed_wake_stops_its_cold_start_gracefully() {
        let dir = std::env::temp_dir().join(format!("noite-term-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let marker = dir.join("term");
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "graceful").await;
        park_row(&pool, &app.id).await;
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        // A child that records SIGTERM: only a graceful stop writes it.
        let script = format!(
            "trap 'echo term > {}; exit 0' TERM; while :; do sleep 0.02; done",
            marker.display()
        );
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .kill_on_drop(true)
            .spawn()
            .expect("child that traps SIGTERM");
        let procs = supervisor::new_procs();
        procs
            .lock()
            .await
            .insert(app.slug.clone(), supervisor::FleetEntry::test_entry(child));
        // A port nothing answers: the wake fails at its health gate.
        let dead = dead_port().await;
        sqlx::query("UPDATE app SET listen_port = ? WHERE id = ?")
            .bind(dead)
            .bind(&app.id)
            .execute(&pool)
            .await
            .expect("dead port");
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        let logs = crate::host::logs::new_state();

        let woke = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;

        assert!(woke.is_err(), "the gate never opens");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "the cold start was killed without its SIGTERM"
            );
            tokio::task::yield_now().await;
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A cold start that died on the way up keeps its hold instead of being
    /// stopped into a plain park: a board-boot crash loop must not respawn on
    /// every request.
    #[tokio::test]
    async fn a_died_cold_start_keeps_its_hold_instead_of_parking() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "died").await;
        park_row(&pool, &app.id).await;
        let procs = supervisor::new_procs();
        crash_the_child(&procs, &app.slug).await;

        park_after_failed_wake(&pool, &cfg, &procs, &app.slug, &app.id).await;

        let state = supervisor::state_of(&procs, &app.slug).await;
        assert!(
            matches!(state, supervisor::FleetState::CrashHeld { .. }),
            "the hold survives the park: {state:?}"
        );
        assert!(
            supervisor::hold_until(&procs, &app.slug).await.is_some(),
            "and the next request is still held off"
        );
    }

    /// A deploy wake has to move the fleet state out of `Asleep`, or the
    /// deploy's own `ensure_fleet` sees a parked fleet and refuses to spawn.
    #[tokio::test]
    async fn a_deploy_wake_leaves_no_asleep_entry_behind() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let cfg = crate::config::config_for_tests();
        let app = seed_confirm_app(&pool, &cfg, "deploywake").await;
        park_row(&pool, &app.id).await;
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        let procs = supervisor::new_procs();
        supervisor::note_event(&procs, &app.slug, supervisor::FleetEvent::Parked).await;
        assert_eq!(
            supervisor::state_of(&procs, &app.slug).await,
            supervisor::FleetState::Asleep { until: None }
        );

        wake_for_deploy(&pool, &procs, &app).await;

        assert!(
            matches!(
                supervisor::state_of(&procs, &app.slug).await,
                supervisor::FleetState::Waking { .. }
            ),
            "the state machine woke with the row"
        );
    }

    /// A deploy wake keeps the hold a parked fleet inherited. Dropping it made
    /// `Waking` look like a cold start that owes a spawn: the very next
    /// reconcile tick spawned a crash-looping fleet through its backoff (and
    /// reset the chain), and the next request no longer failed fast.
    #[tokio::test]
    async fn a_deploy_wake_keeps_the_parked_hold() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let cfg = crate::config::config_for_tests();
        let app = seed_confirm_app(&pool, &cfg, "deploywakehold").await;
        park_row(&pool, &app.id).await;
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        let procs = supervisor::new_procs();
        // The state a fleet that crashed and was then parked rests in: the
        // crash hold is the park's memory of the backoff.
        crash_the_child(&procs, &app.slug).await;
        supervisor::note_event(&procs, &app.slug, supervisor::FleetEvent::Parked).await;
        let hold = supervisor::hold_until(&procs, &app.slug)
            .await
            .expect("the park carries the crash hold");

        wake_for_deploy(&pool, &procs, &app).await;

        assert!(
            matches!(
                supervisor::state_of(&procs, &app.slug).await,
                supervisor::FleetState::Waking {
                    until: Some(until),
                    ..
                } if until == hold
            ),
            "the wake carries the hold: {:?}",
            supervisor::state_of(&procs, &app.slug).await
        );
        assert_eq!(
            supervisor::hold_until(&procs, &app.slug).await,
            Some(hold),
            "and the fleet still has to wait it out"
        );
    }

    /// The real cold start: a parked app (`Asleep`, no child anywhere) wakes
    /// and `ensure_fleet` spawns its fleet. No pre-inserted child, no poke at
    /// the state beyond the park the sleep path records — this is the path the
    /// e2e sleep spec drives, and the one a claim bug broke by making `Waking`
    /// look like a spawn already in flight.
    #[tokio::test]
    async fn a_parked_app_wakes_and_spawns_its_fleet() {
        let dir = std::env::temp_dir().join(format!("noite-wake-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        // A stand-in celld: the real binary is not in the test image, but the
        // spawn path only needs an executable that stays alive.
        let fake = dir.join("celld");
        std::fs::write(&fake, "#!/bin/sh\nsleep 60\n").expect("write fake celld");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 5;
        cfg.celld_bin = fake.to_string_lossy().into_owned();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        // Root keys: the spawn needs credentials, and this test is about the
        // wake → spawn path, not about the store's IAM.
        cfg.credentials = crate::host::credentials::Credentials::Root {
            reason: "test".into(),
        };
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "coldstart").await;
        park_row(&pool, &app.id).await;
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        let procs = supervisor::new_procs();
        // The park the sleep path records: Asleep, no child.
        supervisor::note_event(&procs, &app.slug, supervisor::FleetEvent::Parked).await;
        assert_eq!(
            supervisor::state_of(&procs, &app.slug).await,
            supervisor::FleetState::Asleep { until: None }
        );
        // The row points at a port that answers, so the wake's own gate opens.
        let port = healthy_port().await;
        sqlx::query("UPDATE app SET listen_port = ? WHERE id = ?")
            .bind(port)
            .bind(&app.id)
            .execute(&pool)
            .await
            .expect("listen port");
        let logs = crate::host::logs::new_state();

        wake_app(&pool, &cfg, &procs, &logs, &app.id)
            .await
            .expect("the parked app wakes");

        assert_eq!(
            supervisor::live_keys(&procs).await,
            vec![app.slug.clone()],
            "the wake spawned the fleet"
        );
        assert!(
            matches!(
                supervisor::state_of(&procs, &app.slug).await,
                supervisor::FleetState::Healthy { .. }
            ),
            "and it is healthy"
        );
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert!(fresh.asleep_since.is_none(), "and the row is awake");
        supervisor::stop_fleet(&procs, &app.slug, supervisor::StopGrace::FOR_DELETE).await;
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A child that dies *during* the wake keeps its hold: `wake_app`'s own
    /// rollback is what had been clearing it (through the deliberate-stop
    /// path), so a board that crashes on boot was respawned by every held
    /// request and never backed off.
    #[tokio::test]
    async fn a_child_that_dies_during_the_wake_keeps_its_hold() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "diedlive").await;
        park_row(&pool, &app.id).await;
        // The fleet's cold start is alive when the wake begins and dies while
        // the health gate waits: 50 ms inside the child, then exit 1.
        let child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("sleep 0.05; exit 1")
            .kill_on_drop(true)
            .spawn()
            .expect("a child that dies mid-wake");
        let procs = supervisor::new_procs();
        procs
            .lock()
            .await
            .insert(app.slug.clone(), supervisor::FleetEntry::test_entry(child));
        let logs = crate::host::logs::new_state();
        let dead = dead_port().await;
        sqlx::query("UPDATE app SET listen_port = ? WHERE id = ?")
            .bind(dead)
            .bind(&app.id)
            .execute(&pool)
            .await
            .expect("point the app at the dead port");
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");

        let woke = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;

        assert!(woke.is_err(), "the gate never opens");
        assert!(
            supervisor::hold_until(&procs, &app.slug).await.is_some(),
            "the crash hold survives the failed wake"
        );
        // And the next request does not spawn it again.
        let again = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;
        let err = format!("{:#}", again.expect_err("the hold refuses the wake"));
        assert!(
            err.contains("restarting after a crash"),
            "the next wake fails fast: {err}"
        );
    }

    /// A wake whose cold start succeeded but whose health gate never opened
    /// must not leave that fleets running behind a parked row: nothing would
    /// confirm it or park it again (the sweep only sees awake apps), so it
    /// would sit in memory until the next request.
    #[tokio::test]
    async fn a_wake_that_times_out_stops_the_fleet_it_started() {
        let mut cfg = crate::config::config_for_tests();
        cfg.wake_timeout_s = 1;
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let app = seed_confirm_app(&pool, &cfg, "timeout").await;
        park_row(&pool, &app.id).await;
        let procs = supervisor::new_procs();
        // A live child for the fleet, and a port nothing serves on: the spawn
        // side succeeds, the gate cannot.
        procs.lock().await.insert(
            app.slug.clone(),
            supervisor::FleetEntry::test_entry(
                tokio::process::Command::new("sleep")
                    .arg("60")
                    .kill_on_drop(true)
                    .spawn()
                    .expect("spawn a live child"),
            ),
        );
        supervisor::note_event(&procs, &app.slug, supervisor::FleetEvent::Parked).await;
        let dead = dead_port().await;
        // The row points at the port the test controls (a fileless `:memory:`
        // pool still shares one connection, so the update is visible).
        sqlx::query("UPDATE app SET listen_port = ? WHERE id = ?")
            .bind(dead)
            .bind(&app.id)
            .execute(&pool)
            .await
            .expect("point the app at the dead port");
        let app = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        let logs = crate::host::logs::new_state();

        let woke = wake_app(&pool, &cfg, &procs, &logs, &app.id).await;

        assert!(woke.is_err(), "the gate never opens");
        assert!(
            supervisor::live_keys(&procs).await.is_empty(),
            "the fleet this wake started is stopped again"
        );
        assert_eq!(
            supervisor::state_of(&procs, &app.slug).await,
            supervisor::FleetState::Asleep { until: None },
            "and the fleet state says parked"
        );
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert!(fresh.asleep_since.is_some(), "the row stays asleep");
    }

    /// An app row a confirm can act on: ports assigned, not asleep, deployed.
    async fn seed_confirm_app(pool: &SqlitePool, cfg: &Config, slug: &str) -> App {
        let app = crate::db::create_app(
            pool,
            cfg,
            crate::db::NewApp {
                name: slug,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");
        crate::db::write_app_status(
            pool,
            &app.id,
            AppStatus::Deploying,
            None,
            None,
            crate::models::WriteGuard::Table,
        )
        .await
        .expect("deploying");
        crate::db::get_app(pool, &app.id)
            .await
            .expect("get")
            .expect("row")
    }

    /// An app the sweep may park: running, deployed, and created long enough
    /// ago that only the timestamps decide idleness.
    async fn seed_idle_app(pool: &SqlitePool, cfg: &Config, slug: &str) -> App {
        let app = seed_confirm_app(pool, cfg, slug).await;
        crate::db::write_app_status(
            pool,
            &app.id,
            AppStatus::Running,
            None,
            None,
            crate::models::WriteGuard::Table,
        )
        .await
        .expect("running");
        sqlx::query("UPDATE app SET created_at = ? WHERE id = ?")
            .bind((Utc::now() - chrono::Duration::hours(3)).to_rfc3339())
            .bind(&app.id)
            .execute(pool)
            .await
            .expect("backdate the create");
        crate::db::get_app(pool, &app.id)
            .await
            .expect("get")
            .expect("row")
    }

    /// A health gate that accepts the probe and answers only once the test
    /// says so: the barrier the park/confirm race needs.
    async fn held_health() -> (i64, tokio::sync::oneshot::Sender<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (release, mut wait) = tokio::sync::oneshot::channel::<()>();
        let (arrived, arrived_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf).await;
            let _ = arrived.send(());
            let _ = (&mut wait).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await;
        });
        let _ = tokio::time::timeout(Duration::from_secs(5), arrived_rx).await;
        (i64::from(port), release)
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
        crate::db::write_app_status(
            &pool,
            &app.id,
            AppStatus::Deploying,
            None,
            None,
            crate::models::WriteGuard::Table,
        )
        .await
        .expect("deploying");
        let procs = supervisor::new_procs();
        let fleet = "confirm";
        supervisor::note_event(
            &procs,
            fleet,
            supervisor::FleetEvent::Spawned {
                at: std::time::Instant::now(),
            },
        )
        .await;

        confirm_app_running(&pool, &cfg, &procs, &app.id, fleet, healthy_port().await).await;
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(fresh.status, AppStatus::Running);

        crate::db::patch_app_desired(&pool, &app.id, crate::models::DesiredState::Stopped)
            .await
            .expect("stop");
        crate::db::write_app_status(
            &pool,
            &app.id,
            AppStatus::Building,
            None,
            None,
            crate::models::WriteGuard::Table,
        )
        .await
        .expect("building again");
        confirm_app_running(&pool, &cfg, &procs, &app.id, fleet, dead_port().await).await;
        let fresh = crate::db::get_app(&pool, &app.id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(fresh.status, AppStatus::Building);
    }
}

#[cfg(test)]
mod env_activity_tests {
    use super::*;
    use crate::host::metrics::hourly;

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
        // Traffic on the environment moves its clock, to the exact request
        // stamp: the hourly counters keep microseconds, so a busy hour cannot
        // look up to an hour older than it is.
        let stamp = Utc::now();
        let stamp_us = stamp.timestamp_micros();
        let hour = stamp.format("%Y-%m-%dT%H:00:00Z").to_string();
        let mut tx = pool.begin().await.expect("tx");
        hourly::record_request(
            &mut tx,
            hourly::Key {
                app_id: &app_id,
                environment_id: &env.id,
                bucket_hour: &hour,
            },
            stamp_us,
            Some(10),
            false,
        )
        .await
        .expect("env traffic");
        tx.commit().await.expect("commit");
        let active = environment_activity(&pool, &env).await;
        assert_eq!(
            active[0].map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string()),
            Some(stamp.format("%Y-%m-%dT%H:%M:%S").to_string()),
            "the environment's own request stamp is its newest activity"
        );
        assert!(
            !should_sleep_s(Utc::now(), &active, 3600),
            "a busy environment never parks"
        );
        // Production traffic on the same app does not move it: a sibling
        // environment stays quiet.
        let sibling = seed_env(&pool, &app, "other", "refs/heads/other").await;
        let mut tx = pool.begin().await.expect("tx");
        hourly::record_request(
            &mut tx,
            hourly::Key {
                app_id: &app_id,
                environment_id: "",
                bucket_hour: &hour,
            },
            stamp_us,
            Some(10),
            false,
        )
        .await
        .expect("prod traffic");
        tx.commit().await.expect("commit");
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
            auto_sleep_after_s(None, Some(CRON_CONFIG), 24 * 3600),
            None,
            "cron app without override skips"
        );
        assert_eq!(
            auto_sleep_after_s(None, Some(QUEUE_CONFIG), 24 * 3600),
            None,
            "queue app without override skips"
        );
        // An explicit override re-enables auto-sleep for scheduled apps.
        assert_eq!(
            auto_sleep_after_s(Some(3600), Some(CRON_CONFIG), 24 * 3600),
            Some(3600),
            "explicit override wins"
        );
        assert_eq!(
            auto_sleep_after_s(Some(0), Some(CRON_CONFIG), 24 * 3600),
            None,
            "0 means never, even with an override-shaped value"
        );
    }

    #[test]
    fn threshold_override_and_never() {
        // No override: the platform default in seconds.
        assert_eq!(
            auto_sleep_after_s(None, Some(PLAIN_CONFIG), 86_400),
            Some(86_400)
        );
        assert_eq!(auto_sleep_after_s(None, None, 6 * 3600), Some(21_600));
        // An explicit threshold overrides the global one in both directions.
        assert_eq!(
            auto_sleep_after_s(Some(60), Some(PLAIN_CONFIG), 86_400),
            Some(60),
            "shorter than default"
        );
        assert_eq!(
            auto_sleep_after_s(Some(2_592_000), Some(PLAIN_CONFIG), 86_400),
            Some(2_592_000),
            "longer than default"
        );
        // Explicit 0 is never, even for a plain app.
        assert_eq!(auto_sleep_after_s(Some(0), None, 86_400), None);
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
