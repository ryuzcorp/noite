//! The instance heartbeat: one anonymous, opt-out event per day, POSTed by the
//! runner straight to PostHog's HTTP capture API — no SDK, no browser, no
//! per-request work.
//!
//! Deliberately *not* the fleet ingest telemetry (`host::metrics`, the
//! `crate::telemetry` CLI): this module only ever sends the fixed
//! [`TelemetryEvent`] below, and only ever counts. Nothing here is on the boot
//! critical path — the scheduler is spawned after the REST listener binds.
//!
//! The decision inputs are pure and testable with no network (`should_send`,
//! `Config::telemetry_lock_reason`, `build_event`, `users_bucket`,
//! `storage_kind`); the two network legs — the control worker's user count and
//! PostHog itself — have hard timeouts and never fail anything.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::config::{Config, CONTROL_UPSTREAM_URL};
use crate::db;

/// PostHog EU capture endpoint (`POST` JSON).
const POSTHOG_CAPTURE_URL: &str = "https://eu.i.posthog.com/i/v0/e/";
/// Write-only, public-safe ingestion key (PostHog project keys ship in clients).
const POSTHOG_API_KEY: &str = "phc_tK7beVmX5qMx6tsBxVQdWATWMQcPpEV4iSYGu8nrNHyG";
const EVENT_NAME: &str = "instance_heartbeat";
/// The image's own RustFS: anything else is an operator-supplied store.
const BUNDLED_S3_ENDPOINT: &str = "http://rustfs:9000";
/// Hard bounds on the two network legs.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// First attempt ten minutes after boot, then hourly checks.
const FIRST_ATTEMPT_DELAY: Duration = Duration::from_secs(10 * 60);
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How stale the last successful send must be for the next one.
const RESEND_AFTER_HOURS: i64 = 24;

/// The exact PostHog capture body. `api_key`/`distinct_id` are PostHog's own
/// snake_case body keys, and `properties` carries the heartbeat facts plus the
/// two `$`-prefixed PostHog controls. Serialized as-is into the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct TelemetryEvent {
    pub api_key: String,
    pub event: String,
    pub distinct_id: String,
    pub timestamp: String,
    pub properties: TelemetryProperties,
}

/// The heartbeat facts. Property names are the contract's, exactly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct TelemetryProperties {
    pub version: String,
    pub celld_version: String,
    pub arch: String,
    pub tenancy: String,
    pub storage: String,
    pub apps: i64,
    pub apps_running: i64,
    pub apps_sleeping: i64,
    pub deploys_24h: i64,
    pub deploys_failed_24h: i64,
    /// Bucket string (`"1"`, `"2-5"`, `"6-20"`, `"21+"`), never the count;
    /// `"unknown"` when the control worker could not be reached.
    pub users: String,
    pub install_age_days: i64,
    pub uptime_hours: i64,
    /// PostHog: never geolocate the sender's IP.
    #[serde(rename = "$geoip_disable")]
    pub geoip_disable: bool,
    /// PostHog: never build a person profile for the install id.
    #[serde(rename = "$process_person_profile")]
    pub process_person_profile: bool,
}

/// `telemetry.get` / `GET /v1/admin/telemetry` and the `set` reply. `enabled`
/// is the effective state (stored preference AND not locked); `setting` is
/// what the operator stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TelemetryStatus {
    pub enabled: bool,
    pub setting: bool,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub last_sent_at: Option<String>,
    pub install_id: String,
    /// The exact body a send right now would POST (`api_key` included).
    pub preview: TelemetryEvent,
}

/// Everything the heartbeat reports, gathered at send/preview time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    /// RFC3339 UTC, the moment the payload was built.
    pub timestamp: String,
    pub install_id: String,
    pub version: String,
    pub celld_version: String,
    pub arch: String,
    pub tenancy: String,
    pub storage: String,
    pub apps: i64,
    pub apps_running: i64,
    pub apps_sleeping: i64,
    pub deploys_24h: i64,
    pub deploys_failed_24h: i64,
    /// The control worker's user count; `None` = unreachable (→ `"unknown"`).
    pub users: Option<i64>,
    pub install_age_days: i64,
    pub uptime_hours: i64,
}

/// Bucket a raw user count: the magnitude, never the number. A count of zero
/// or one is the `1` bucket (there is no zero bucket in the contract).
pub fn users_bucket(n: i64) -> &'static str {
    match n {
        ..=1 => "1",
        2..=5 => "2-5",
        6..=20 => "6-20",
        _ => "21+",
    }
}

/// `"bundled"` when the endpoint is the image's own RustFS, `"external"` for
/// anything else (the endpoint string itself never leaves the container).
pub fn storage_kind(s3_endpoint: &str) -> &'static str {
    if s3_endpoint.trim_end_matches('/') == BUNDLED_S3_ENDPOINT {
        "bundled"
    } else {
        "external"
    }
}

/// Whether a tick at `now` should send: the preference is on, nothing locks it,
/// and the last successful send is absent or at least a day old. Locked beats
/// everything, including a due window.
pub fn should_send(
    now: DateTime<Utc>,
    last_sent: Option<DateTime<Utc>>,
    enabled: bool,
    locked: bool,
) -> bool {
    if locked || !enabled {
        return false;
    }
    match last_sent {
        None => true,
        Some(at) => now.signed_duration_since(at) >= chrono::Duration::hours(RESEND_AFTER_HOURS),
    }
}

/// The Noite version baked into the image (`NOITE_BUILD_VERSION` ENV, set by
/// the Dockerfile from a build arg); `"dev"` for a source checkout.
pub fn build_version() -> String {
    non_empty_env("NOITE_BUILD_VERSION").unwrap_or_else(|| "dev".to_string())
}

/// The celld version the image ships (`CELLD_VERSION` ENV); `"unknown"` when
/// unset (a bare `cargo run`).
pub fn celld_version() -> String {
    non_empty_env("CELLD_VERSION").unwrap_or_else(|| "unknown".to_string())
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Format the measured facts as the exact capture body.
pub fn build_event(facts: &Facts) -> TelemetryEvent {
    TelemetryEvent {
        api_key: POSTHOG_API_KEY.to_string(),
        event: EVENT_NAME.to_string(),
        distinct_id: facts.install_id.clone(),
        timestamp: facts.timestamp.clone(),
        properties: TelemetryProperties {
            version: facts.version.clone(),
            celld_version: facts.celld_version.clone(),
            arch: facts.arch.clone(),
            tenancy: facts.tenancy.clone(),
            storage: facts.storage.clone(),
            apps: facts.apps,
            apps_running: facts.apps_running,
            apps_sleeping: facts.apps_sleeping,
            deploys_24h: facts.deploys_24h,
            deploys_failed_24h: facts.deploys_failed_24h,
            users: facts.users.map_or_else(|| "unknown".to_string(), |n| users_bucket(n).to_string()),
            install_age_days: facts.install_age_days,
            uptime_hours: facts.uptime_hours,
            geoip_disable: true,
            process_person_profile: false,
        },
    }
}

/// Whether a tick at `now` is due: the stored preference, the env/local-domain
/// lock, and the last successful send. No network.
pub async fn due(pool: &SqlitePool, cfg: &Config, now: DateTime<Utc>) -> sqlx::Result<bool> {
    let stored = db::get_setting(pool, db::TELEMETRY_ENABLED).await?;
    let enabled = stored.as_deref() != Some("0");
    let last_sent = db::get_setting(pool, db::TELEMETRY_LAST_SENT_AT)
        .await?
        .and_then(|raw| parse_iso(&raw));
    Ok(should_send(
        now,
        last_sent,
        enabled,
        cfg.telemetry_lock_reason().is_some(),
    ))
}

/// Gather the heartbeat facts: SQLite counts, the clocks, and the env/domain
/// descriptors. `users` is the control worker's count (already fetched, or
/// `None`); this function itself never touches the network.
pub async fn gather(
    pool: &SqlitePool,
    cfg: &Config,
    started_at: DateTime<Utc>,
    now: DateTime<Utc>,
    users: Option<i64>,
) -> anyhow::Result<Facts> {
    let (install_id, installed_at) = db::ensure_identity(pool).await?;
    let counts = counts(pool, now).await?;
    let install_age_days = parse_iso(&installed_at)
        .map(|installed| now.signed_duration_since(installed).num_days().max(0))
        .unwrap_or(0);
    Ok(Facts {
        timestamp: now.to_rfc3339_opts(SecondsFormat::Millis, true),
        install_id,
        version: build_version(),
        celld_version: celld_version(),
        arch: std::env::consts::ARCH.to_string(),
        tenancy: cfg.tenancy.as_str().to_string(),
        storage: storage_kind(&cfg.s3_endpoint).to_string(),
        apps: counts.apps,
        apps_running: counts.apps_running,
        apps_sleeping: counts.apps_sleeping,
        deploys_24h: counts.deploys_24h,
        deploys_failed_24h: counts.deploys_failed_24h,
        users,
        install_age_days,
        uptime_hours: now.signed_duration_since(started_at).num_hours().max(0),
    })
}

/// The control worker's `GET /internal/telemetry-facts`: runner-token gated like
/// `/internal/recovery`, 5 s. Anything but a valid `{"users": n}` — unreachable,
/// error status, malformed body — is `None`, which the payload reports as
/// `"unknown"`.
pub async fn control_users(cfg: &Config) -> Option<i64> {
    let client = reqwest::Client::builder()
        .timeout(CONTROL_TIMEOUT)
        .build()
        .ok()?;
    let response = client
        .get(format!("{CONTROL_UPSTREAM_URL}/internal/telemetry-facts"))
        .bearer_auth(&cfg.runner_token)
        .send()
        .await
        .map_err(|e| tracing::debug!(error = %e, "telemetry: control user count unreachable"))
        .ok()?;
    if !response.status().is_success() {
        tracing::debug!(status = %response.status(), "telemetry: control user count refused");
        return None;
    }
    #[derive(Deserialize)]
    struct Users {
        users: i64,
    }
    match response.json::<Users>().await {
        Ok(users) => Some(users.users),
        Err(e) => {
            tracing::debug!(error = %e, "telemetry: control user count unreadable");
            None
        }
    }
}

/// POST the event to PostHog. Failure is the caller's to log and retry; the
/// heartbeat never fails anything.
pub async fn send(client: &reqwest::Client, event: &TelemetryEvent) -> anyhow::Result<()> {
    let response = client
        .post(POSTHOG_CAPTURE_URL)
        .json(event)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("posthog send failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("posthog answered {status}: {body}");
    }
    Ok(())
}

/// The heartbeat task: first attempt ten minutes after boot, then hourly
/// checks. Spawned after the REST listener binds, so it is never on the boot
/// critical path; a failed send is retried at the next tick and nothing about
/// it is fatal.
pub async fn run_scheduler(pool: SqlitePool, cfg: Arc<Config>, started_at: DateTime<Utc>) {
    let client = match reqwest::Client::builder().timeout(SEND_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(error = %e, "instance heartbeat: http client");
            return;
        }
    };
    tokio::time::sleep(FIRST_ATTEMPT_DELAY).await;
    loop {
        let now = Utc::now();
        match due(&pool, &cfg, now).await {
            Ok(true) => {
                let users = control_users(&cfg).await;
                match gather(&pool, &cfg, started_at, now, users).await {
                    Ok(facts) => {
                        let event = build_event(&facts);
                        match send(&client, &event).await {
                            Ok(()) => record_sent(&pool, now).await,
                            Err(e) => tracing::debug!(error = %e, "instance heartbeat send failed; retrying next tick"),
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, "instance heartbeat: facts"),
                }
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(error = %e, "instance heartbeat: state"),
        }
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

async fn record_sent(pool: &SqlitePool, now: DateTime<Utc>) {
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    match db::set_setting(pool, db::TELEMETRY_LAST_SENT_AT, &stamp).await {
        Ok(()) => tracing::debug!("instance heartbeat sent"),
        Err(e) => tracing::warn!(error = %e, "instance heartbeat: could not record the send"),
    }
}

#[derive(sqlx::FromRow)]
struct Counts {
    apps: i64,
    apps_running: i64,
    apps_sleeping: i64,
    deploys_24h: i64,
    deploys_failed_24h: i64,
}

/// Counts in one round trip. "Awake" is `asleep_since IS NULL`; "asleep" is the
/// parked flag on an app its owner has not stopped.
async fn counts(pool: &SqlitePool, now: DateTime<Utc>) -> sqlx::Result<Counts> {
    let cutoff = (now - chrono::Duration::hours(24)).to_rfc3339_opts(SecondsFormat::Millis, true);
    sqlx::query_as::<_, Counts>(
        r#"SELECT
             (SELECT COUNT(*) FROM app) AS apps,
             (SELECT COUNT(*) FROM app WHERE desired_state = 'running' AND asleep_since IS NULL) AS apps_running,
             (SELECT COUNT(*) FROM app WHERE asleep_since IS NOT NULL AND desired_state <> 'stopped') AS apps_sleeping,
             (SELECT COUNT(*) FROM deploy WHERE created_at >= ?) AS deploys_24h,
             (SELECT COUNT(*) FROM deploy WHERE created_at >= ? AND status = 'failed') AS deploys_failed_24h"#,
    )
    .bind(&cutoff)
    .bind(&cutoff)
    .fetch_one(pool)
    .await
}

/// An RFC3339 stamp as UTC; an unparsable one (hand-edited row) reads as never.
fn parse_iso(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            timestamp: "2026-10-06T00:00:00.000Z".to_string(),
            install_id: "11111111-1111-4111-8111-111111111111".to_string(),
            version: "0.1.0-alpha.3".to_string(),
            celld_version: "0.6.1".to_string(),
            arch: std::env::consts::ARCH.to_string(),
            tenancy: "single".to_string(),
            storage: "bundled".to_string(),
            apps: 3,
            apps_running: 2,
            apps_sleeping: 1,
            deploys_24h: 5,
            deploys_failed_24h: 1,
            users: Some(7),
            install_age_days: 4,
            uptime_hours: 10,
        }
    }

    #[test]
    fn users_are_bucketed_never_reported() {
        assert_eq!(users_bucket(0), "1");
        assert_eq!(users_bucket(1), "1");
        assert_eq!(users_bucket(2), "2-5");
        assert_eq!(users_bucket(5), "2-5");
        assert_eq!(users_bucket(6), "6-20");
        assert_eq!(users_bucket(20), "6-20");
        assert_eq!(users_bucket(21), "21+");
        assert_eq!(users_bucket(10_000), "21+");
    }

    #[test]
    fn storage_kind_distinguishes_bundled_rustfs() {
        assert_eq!(storage_kind("http://rustfs:9000"), "bundled");
        assert_eq!(storage_kind("http://rustfs:9000/"), "bundled");
        assert_eq!(storage_kind("https://s3.example.com"), "external");
        assert_eq!(storage_kind("http://127.0.0.1:9000"), "external");
    }

    #[test]
    fn should_send_honours_opt_out_lock_and_the_day_window() {
        let now = DateTime::parse_from_rfc3339("2026-10-06T12:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let hours = |h: i64| now - chrono::Duration::hours(h);

        assert!(should_send(now, None, true, false), "never sent, enabled");
        assert!(
            should_send(now, Some(hours(24)), true, false),
            "24 h is due"
        );
        assert!(
            should_send(now, Some(hours(30)), true, false),
            "past the window is due"
        );
        assert!(!should_send(now, Some(hours(23)), true, false), "too soon");
        assert!(!should_send(now, Some(hours(1)), true, false), "much too soon");
        assert!(!should_send(now, None, false, false), "opt-out never sends");
        assert!(!should_send(now, None, true, true), "locked never sends");
        // The lock beats a due window.
        assert!(!should_send(now, Some(hours(48)), true, true));
    }

    /// The body must match the contract's property keys exactly, including the
    /// two `$`-prefixed PostHog controls. This is also the preview JSON the
    /// account page shows.
    #[test]
    fn build_event_matches_the_contract_json() {
        let event = build_event(&facts());
        let value = serde_json::to_value(&event).expect("serialize");
        let expected = serde_json::json!({
            "api_key": POSTHOG_API_KEY,
            "event": "instance_heartbeat",
            "distinct_id": "11111111-1111-4111-8111-111111111111",
            "timestamp": "2026-10-06T00:00:00.000Z",
            "properties": {
                "version": "0.1.0-alpha.3",
                "celld_version": "0.6.1",
                "arch": std::env::consts::ARCH,
                "tenancy": "single",
                "storage": "bundled",
                "apps": 3,
                "apps_running": 2,
                "apps_sleeping": 1,
                "deploys_24h": 5,
                "deploys_failed_24h": 1,
                "users": "6-20",
                "install_age_days": 4,
                "uptime_hours": 10,
                "$geoip_disable": true,
                "$process_person_profile": false,
            }
        });
        assert_eq!(value, expected);
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("pretty")
        );
    }

    /// An unreachable control worker must not turn into a count.
    #[test]
    fn unreachable_control_reports_unknown_users() {
        let mut f = facts();
        f.users = None;
        let event = build_event(&f);
        assert_eq!(event.properties.users, "unknown");
    }

    #[test]
    fn due_reads_the_store_and_the_lock_without_network() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let pool = db::connect("sqlite::memory:").await.expect("memory db");
            let now = Utc::now();
            let mut cfg = crate::config::config_for_tests();
            // localhost: locked, never due.
            assert!(!due(&pool, &cfg, now).await.expect("due"));

            cfg.base_domain = "noite.now".to_string();
            assert!(due(&pool, &cfg, now).await.expect("due"), "never sent, open");

            let recent = (now - chrono::Duration::hours(2)).to_rfc3339_opts(SecondsFormat::Millis, true);
            db::set_setting(&pool, db::TELEMETRY_LAST_SENT_AT, &recent)
                .await
                .expect("last sent");
            assert!(!due(&pool, &cfg, now).await.expect("due"), "sent 2 h ago");

            let old = (now - chrono::Duration::hours(25)).to_rfc3339_opts(SecondsFormat::Millis, true);
            db::set_setting(&pool, db::TELEMETRY_LAST_SENT_AT, &old)
                .await
                .expect("last sent");
            assert!(due(&pool, &cfg, now).await.expect("due"), "sent 25 h ago");

            db::set_setting(&pool, db::TELEMETRY_ENABLED, "0")
                .await
                .expect("opt out");
            assert!(!due(&pool, &cfg, now).await.expect("due"), "opted out");

            cfg.do_not_track = true;
            db::set_setting(&pool, db::TELEMETRY_ENABLED, "1")
                .await
                .expect("opt in");
            assert!(!due(&pool, &cfg, now).await.expect("due"), "DO_NOT_TRACK");

            pool.close().await;
        });
    }

    /// Gathering counts, the clocks and the descriptors, with no network: the
    /// assembled payload must not carry any domain or endpoint string.
    #[test]
    fn gathered_payload_carries_no_domain_or_host() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let pool = db::connect("sqlite::memory:").await.expect("memory db");
            let mut cfg = crate::config::config_for_tests();
            cfg.base_domain = "secret.example.com".to_string();
            cfg.s3_endpoint = "https://storage.example.com".to_string();

            for slug in ["one", "two"] {
                db::create_app(
                    &pool,
                    &cfg,
                    db::NewApp {
                        name: slug,
                        slug,
                        user_id: "local",
                        subdomain: &format!("{slug}.secret.example.com"),
                        listen: 20100,
                        internal: 20101,
                    },
                )
                .await
                .expect("seed app");
            }
            let apps = db::list_apps(&pool).await.expect("list");
            db::set_app_asleep(&pool, &apps[0].id).await.expect("sleep");
            db::upsert_deploy(&pool, None, &apps[0].id, "success", Some("sha1"), "")
                .await
                .expect("deploy");
            db::upsert_deploy(&pool, None, &apps[1].id, "failed", Some("sha2"), "")
                .await
                .expect("deploy");

            let now = DateTime::parse_from_rfc3339("2026-10-06T12:00:00Z")
                .expect("now")
                .with_timezone(&Utc);
            let started = now - chrono::Duration::hours(30);
            let gathered = gather(&pool, &cfg, started, now, None)
                .await
                .expect("gather");

            assert_eq!(gathered.apps, 2);
            assert_eq!(gathered.apps_running, 1);
            assert_eq!(gathered.apps_sleeping, 1);
            assert_eq!(gathered.deploys_24h, 2);
            assert_eq!(gathered.deploys_failed_24h, 1);
            assert_eq!(gathered.storage, "external");
            assert_eq!(gathered.tenancy, "single");
            assert_eq!(gathered.uptime_hours, 30);
            assert_eq!(gathered.users, None);
            assert!(!gathered.install_id.is_empty(), "identity bootstrapped");

            let text = serde_json::to_string(&build_event(&gathered)).expect("serialize");
            for leak in [
                "example.com",
                "storage.example.com",
                "secret",
                "localhost",
                "127.0.0.1",
                "rustfs",
                &cfg.runner_token,
            ] {
                assert!(!text.contains(leak), "payload leaked {leak:?}: {text}");
            }
            assert!(text.contains("\"unknown\""), "users unknown: {text}");

            pool.close().await;
        });
    }
}
