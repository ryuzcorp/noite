//! Grouped errors: the unary reads (REST route + `errors.*` RPC) and the
//! hourly/series shaping the errors SSE stream also consumes.

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::db;
use crate::host::errors::Frame;
use crate::models::ErrorIssue;
use crate::AppState;

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
