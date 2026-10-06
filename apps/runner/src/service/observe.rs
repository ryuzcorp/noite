//! Observability: metrics, spans, devices, paths, refs, logs (the unary reads
//! plus the merged log view the log SSE stream tails).

use crate::api_error::ApiError;
use crate::db;
use crate::host::{logs, metrics};
use crate::AppState;

/// One observability target: the app id the metric tables key on and the slug
/// the in-memory log tail keys on. For a tenant app both come from its `app`
/// row; for the control fleet there is no row by design, so the reserved key
/// stands for both (see `host::control::SLUG`). Returning `None` is a 404 —
/// the routes stay identical for both kinds of source.
pub async fn telemetry_target(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> sqlx::Result<Option<(String, String)>> {
    if id == crate::host::control::SLUG {
        return Ok(Some((
            crate::host::control::SLUG.to_string(),
            crate::host::control::SLUG.to_string(),
        )));
    }
    Ok(db::get_app(pool, id).await?.map(|app| (app.id, app.slug)))
}

/// Resolve one telemetry target or the error to answer with (404 unknown app,
/// 500 database). Every observability route shares it, so a tenant app and the
/// control fleet take the same path.
pub async fn telemetry_target_or_404(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<(String, String), ApiError> {
    match telemetry_target(pool, id).await {
        Ok(Some(target)) => Ok(target),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// Merged log view: the ingested OTel ring (up to ~40 s behind live traffic)
/// plus the in-memory stdout tail (live). Chronological, oldest first.
pub async fn merged_lines(state: &AppState, app_id: &str, slug: &str) -> Vec<String> {
    let since = metrics::now_us() - 24 * 3_600_000_000;
    let mut lines: Vec<String> = db::list_app_logs(&state.pool, app_id, since, 500)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(_, body)| body)
        .collect();
    lines.extend(logs::tail(&state.logs, slug, 500).await);
    lines
}

fn hours_since(hours: Option<i64>, fmt: &str) -> String {
    let hours = hours.unwrap_or(24).clamp(1, 720);
    (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format(fmt)
        .to_string()
}

pub async fn metrics(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:%M:00Z");
    json_rows(db::list_app_metrics(&state.pool, &app_id, &since).await)
}

pub async fn devices(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_devices(&state.pool, &app_id, &since).await)
}

pub async fn paths(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_paths(&state.pool, &app_id, &since).await)
}

pub async fn refs(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_refs(&state.pool, &app_id, &since).await)
}

/// Ingested hourly span stats (spec T3.2): the 24 h default is one indexed
/// SQLite scan, like every other series (up to 720 h).
pub async fn spans(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_span_stats(&state.pool, &app_id, &since).await)
}

/// Per-app metrics version (spec T3.6): dashboard polls fetch this first and
/// skip their window queries when it hasn't moved.
pub async fn metrics_version(
    state: &AppState,
    id: &str,
) -> Result<serde_json::Value, ApiError> {
    let (app_id, _) = telemetry_target_or_404(&state.pool, id).await?;
    match db::get_metric_version(&state.pool, &app_id).await {
        Ok(v) => Ok(serde_json::json!({ "version": v })),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn logs_lines(
    state: &AppState,
    id: &str,
) -> Result<Vec<String>, ApiError> {
    let (app_id, slug) = telemetry_target_or_404(&state.pool, id).await?;
    Ok(merged_lines(state, &app_id, &slug).await)
}

fn json_rows<T: serde::Serialize>(rows: sqlx::Result<Vec<T>>) -> Result<serde_json::Value, ApiError> {
    let rows = rows.map_err(|e| ApiError::internal(e.to_string()))?;
    serde_json::to_value(rows).map_err(|e| ApiError::internal(e.to_string()))
}
