//! Grouped errors: the unary reads (REST route + `errors.*` RPC) and the
//! hourly/series shaping the errors SSE stream also consumes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::db;
use crate::host::errors::{ingest_sdk, Frame, SdkEvent};
use crate::models::ErrorIssue;
use crate::AppState;

use super::environments::role_ok;
use super::observe::telemetry_target_or_404;

pub const ERROR_STATUSES: &[&str] = &["open", "resolved", "ignored"];

/// Per-status issue counts.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ErrorCounts {
    pub open: i64,
    pub resolved: i64,
    pub ignored: i64,
}

/// One issue plus its 24-hour series (the `hourly` field the RPC inlines).
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorIssueView {
    #[serde(flatten)]
    pub issue: ErrorIssue,
    pub hourly: Vec<i64>,
}

/// The `errors.list` result and the errors stream frame.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ErrorIssueList {
    pub issues: Vec<ErrorIssueView>,
    pub counts: ErrorCounts,
}

/// One stored occurrence with its frames/logs parsed from their JSON text.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorEventView {
    pub ts_us: i64,
    pub trace_id: String,
    pub source: String,
    pub handler: String,
    pub cell: String,
    pub kind: String,
    pub message: String,
    pub context: String,
    pub frames: Vec<Frame>,
    pub logs: Vec<String>,
    pub method: String,
    pub path: String,
    pub http_status: i64,
    pub browser: String,
    pub os: String,
    pub sha: String,
    /// SDK extras (phase 2): the page URL with its query stripped, and the
    /// release/environment the SDK reported. Empty on telemetry occurrences.
    pub url: String,
    pub release: String,
    pub environment: String,
}

/// The `errors.get` result: the issue plus its recent events.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
pub struct ErrorIssueDetail {
    pub issue: ErrorIssueView,
    pub events: Vec<ErrorEventView>,
}

/// The last 24 UTC hour buckets, oldest first (`app_error_hour` keys).
fn error_hour_keys() -> Vec<String> {
    let now = chrono::Utc::now();
    (0..24)
        .rev()
        .map(|h| {
            (now - chrono::Duration::hours(h))
                .format("%Y-%m-%dT%H:00:00Z")
                .to_string()
        })
        .collect()
}

/// Hour rows → a 24-slot series per fingerprint, aligned to `error_hour_keys`.
fn error_series(
    keys: &[String],
    rows: &[(String, String, i64)],
) -> std::collections::HashMap<String, Vec<i64>> {
    let mut out: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for (fp, hour, n) in rows {
        if let Some(i) = keys.iter().position(|k| k == hour) {
            out.entry(fp.clone()).or_insert_with(|| vec![0; 24])[i] += n;
        }
    }
    out
}

fn with_hourly(issue: ErrorIssue, hourly: Vec<i64>) -> ErrorIssueView {
    ErrorIssueView { issue, hourly }
}

/// One status's issues (newest first, each with its 24 h series) plus the
/// per-status counts: the `errors.list` result and the errors stream frame.
/// Takes the pool so the SSE poller can call it without an `AppState`.
pub async fn list(
    pool: &sqlx::SqlitePool,
    app_id: &str,
    status: &str,
) -> sqlx::Result<ErrorIssueList> {
    let keys = error_hour_keys();
    let (issues, counts, hours) = tokio::try_join!(
        db::list_error_issues(pool, app_id, status, 200),
        db::count_error_issues(pool, app_id),
        db::list_error_hours(pool, app_id, &keys[0]),
    )?;
    let mut series = error_series(&keys, &hours);
    let issues: Vec<ErrorIssueView> = issues
        .into_iter()
        .map(|issue| {
            let hourly = series
                .remove(&issue.fingerprint)
                .unwrap_or_else(|| vec![0; 24]);
            with_hourly(issue, hourly)
        })
        .collect();
    let count = |s: &str| counts.iter().find(|(k, _)| k == s).map_or(0, |(_, n)| *n);
    Ok(ErrorIssueList {
        issues,
        counts: ErrorCounts {
            open: count("open"),
            resolved: count("resolved"),
            ignored: count("ignored"),
        },
    })
}

fn validate_status(status: &str) -> Result<(), ApiError> {
    if ERROR_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(ApiError::bad("status must be open, resolved or ignored"))
    }
}

/// `errors.list`: validate, resolve the telemetry target, then shape.
pub async fn list_for(
    state: &AppState,
    id: &str,
    status: &str,
) -> Result<ErrorIssueList, ApiError> {
    validate_status(status)?;
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    list(&state.pool, &app_id, status)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// `errors.get`: the issue plus its recent events (frames/logs parsed from
/// their stored JSON).
pub async fn get(
    state: &AppState,
    id: &str,
    fingerprint: &str,
) -> Result<ErrorIssueDetail, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let issue = match db::get_error_issue(&state.pool, &app_id, fingerprint).await {
        Ok(Some(issue)) => issue,
        Ok(None) => return Err(ApiError::not_found("error not found")),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    let keys = error_hour_keys();
    let (events, hours) = tokio::try_join!(
        db::list_error_events(&state.pool, &app_id, fingerprint),
        db::list_error_hours(&state.pool, &app_id, &keys[0]),
    )
    .map_err(|e| ApiError::internal(e.to_string()))?;
    let hourly = error_series(&keys, &hours)
        .remove(&issue.fingerprint)
        .unwrap_or_else(|| vec![0; 24]);
    let events: Vec<ErrorEventView> = events
        .into_iter()
        .map(|e| ErrorEventView {
            ts_us: e.ts_us,
            trace_id: e.trace_id,
            source: e.source,
            handler: e.handler,
            cell: e.cell,
            kind: e.kind,
            message: e.message,
            context: e.context,
            frames: serde_json::from_str(&e.frames).unwrap_or_default(),
            logs: serde_json::from_str(&e.logs).unwrap_or_default(),
            method: e.method,
            path: e.path,
            http_status: e.http_status,
            browser: e.browser,
            os: e.os,
            sha: e.sha,
            url: e.url,
            release: e.release,
            environment: e.environment,
        })
        .collect();
    Ok(ErrorIssueDetail {
        issue: with_hourly(issue, hourly),
        events,
    })
}

/// `errors.set_status`: 404 when the fingerprint is unknown for the target.
pub async fn set_status(
    state: &AppState,
    id: &str,
    fingerprint: &str,
    status: &str,
) -> Result<(), ApiError> {
    validate_status(status)?;
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let now = crate::host::metrics::now_us();
    match db::set_error_status(&state.pool, &app_id, fingerprint, status, now).await {
        Ok(0) => Err(ApiError::not_found("error not found")),
        Ok(_) => Ok(()),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// An app's public error-ingest identity: the stable numeric project id in
/// its DSN and envelope path, plus the key that authenticates envelope posts.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IngestKeyView {
    pub project_id: i64,
    pub key: String,
}

/// `errors.ingest_key`: read the app's ingest identity, creating the row
/// (key + number together) on first view. The key is public by design — it
/// ships in the app's client bundle — so viewing needs only the app role.
/// The row is created lazily: installs that predate phase 2 gain it without
/// a backfill, and `apps.create` stays untouched.
pub async fn ingest_key(
    state: &AppState,
    id: &str,
    role: Option<&str>,
) -> Result<IngestKeyView, ApiError> {
    let Some(role) = role else {
        return Err(ApiError::forbidden("the view role is required for this operation"));
    };
    if !role_ok(role, "view") {
        return Err(ApiError::forbidden(format!(
            "role {role:?} may not view this app's error reporting"
        )));
    }
    let app = db::get_app(&state.pool, id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(app) = app else {
        return Err(ApiError::not_found("app not found"));
    };
    let key = db::get_or_create_ingest_key(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(IngestKeyView {
        project_id: key.project_id,
        key: key.key,
    })
}

/// `errors.rotate_ingest_key`: mint a replacement key, keeping the project
/// number (deployed SDKs keep their DSN path; only the key changes). Admin
/// only; the old key stops working immediately.
pub async fn rotate_ingest_key(
    state: &AppState,
    id: &str,
    role: Option<&str>,
) -> Result<IngestKeyView, ApiError> {
    let Some(role) = role else {
        return Err(ApiError::forbidden("the admin role is required for this operation"));
    };
    if !role_ok(role, "admin") {
        return Err(ApiError::forbidden(format!(
            "role {role:?} may not rotate this app's ingest key"
        )));
    }
    let app = db::get_app(&state.pool, id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(app) = app else {
        return Err(ApiError::not_found("app not found"));
    };
    let key = db::rotate_ingest_key(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(IngestKeyView {
        project_id: key.project_id,
        key: key.key,
    })
}

/// One envelope's worth of Sentry events, as the UI parsed and mapped them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkIngestBatch {
    pub project_id: i64,
    pub key: String,
    #[serde(default)]
    pub events: Vec<SdkEvent>,
}

/// `errors.ingest`: record one envelope's events under the app the project
/// number resolves to. An unknown number and a wrong key share one refusal,
/// so the response never reveals which apps exist. Returns the fingerprints
/// that gained occurrences (empty when the envelope held no events). The
/// protocol allows at most one event per envelope; more is an invalid-params
/// refusal before any database work, so a direct RPC caller cannot multiply
/// writes with one fat batch.
pub async fn ingest(state: &AppState, batch: SdkIngestBatch) -> Result<Vec<String>, ApiError> {
    if batch.events.len() > 1 {
        return Err(ApiError::bad("at most one event per envelope"));
    }
    let row = db::app_for_project(&state.pool, batch.project_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some((app_id, live)) = row else {
        return Err(ApiError::not_found("unknown project or key"));
    };
    if batch.key != live {
        return Err(ApiError::not_found("unknown project or key"));
    }
    if batch.events.is_empty() {
        return Ok(Vec::new());
    }
    let sha = db::get_app(&state.pool, &app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .and_then(|app| app.last_deploy_sha);
    ingest_sdk(&state.pool, &app_id, sha.as_deref(), &batch.events)
        .await
        .map_err(ApiError::from_anyhow)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    async fn test_state() -> AppState {
        let dir =
            std::env::temp_dir().join(format!("noite-ingest-cap-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        AppState {
            pool,
            config,
            procs: crate::host::supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify,
            git_sync: crate::host::git_manifest::GitSync::default(),
            tip_tx,
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
        }
    }

    fn event(message: &str) -> SdkEvent {
        SdkEvent {
            kind: "Error".into(),
            message: message.into(),
            frames: Vec::new(),
            url: String::new(),
            release: String::new(),
            environment: String::new(),
            user_agent: String::new(),
            trace_id: String::new(),
            timestamp_us: 0,
            source: "browser".into(),
        }
    }

    #[tokio::test]
    async fn ingest_rejects_more_than_one_event() {
        let state = test_state().await;
        let batch = SdkIngestBatch {
            project_id: 1,
            key: "k".into(),
            events: vec![event("one"), event("two")],
        };
        let err = ingest(&state, batch)
            .await
            .expect_err("two events must be refused");
        assert!(
            matches!(err, ApiError::BadRequest(_)),
            "unexpected: {err:?}"
        );
    }
}
