//! Observability: metrics, spans, logs (+ live SSE tail).
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use serde::Deserialize;
use tokio_stream::wrappers::ReceiverStream;

use crate::db;
use crate::error::ApiError;
use crate::host::logs;
use crate::host::metrics;
use crate::AppState;

#[derive(Deserialize)]
pub struct MetricsQuery {
    pub hours: Option<i64>,
}

/// One observability target: the app id the metric tables key on and the slug
/// the in-memory log tail keys on. For a tenant app both come from its `app`
/// row; for the control fleet there is no row by design, so the reserved key
/// stands for both (see `host::control::SLUG`). Returning `None` is a 404 —
/// the routes stay identical for both kinds of source.
pub(crate) async fn telemetry_target(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> sqlx::Result<Option<(String, String)>> {
    if id == crate::host::control::SLUG {
        return Ok(Some((
            crate::host::control::SLUG.to_string(),
            crate::host::control::SLUG.to_string(),
        )));
    }
    Ok(db::get_app(pool, id)
        .await?
        .map(|app| (app.id, app.slug)))
}

/// Resolve one telemetry target or the error to answer with (404 unknown app,
/// 500 database). Every observability route shares it, so a tenant app and the
/// control fleet take the same path.
pub(crate) async fn telemetry_target_or_404(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<(String, String), ApiError> {
    match telemetry_target(pool, id).await {
        Ok(Some(target)) => Ok(target),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn app_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    let hours = q.hours.unwrap_or(24).clamp(1, 720);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:%M:00Z")
        .to_string();
    match db::list_app_metrics(&state.pool, &app_id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_devices(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    let hours = q.hours.unwrap_or(24).clamp(1, 720);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_devices(&state.pool, &app_id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_paths(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    let hours = q.hours.unwrap_or(24).clamp(1, 720);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_paths(&state.pool, &app_id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_refs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    let hours = q.hours.unwrap_or(24).clamp(1, 720);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_refs(&state.pool, &app_id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_spans(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    // Ingested hourly stats (spec T3.2): the 24 h default is one indexed
    // SQLite scan, like every other series (up to 720 h).
    let hours = q.hours.unwrap_or(24).clamp(1, 720);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_span_stats(&state.pool, &app_id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// Per-app metrics version (spec T3.6): dashboard polls fetch this first and
/// skip their window queries when it hasn't moved.
pub async fn app_metrics_version(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let (app_id, _) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    match db::get_metric_version(&state.pool, &app_id).await {
        Ok(v) => Json(serde_json::json!({ "version": v })).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// Merged log view: the ingested OTel ring (up to ~40 s behind live traffic)
/// plus the in-memory stdout tail (live). Chronological, oldest first.
pub(crate) async fn merged_lines(state: &AppState, app_id: &str, slug: &str) -> Vec<String> {
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

pub async fn app_logs(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let (app_id, slug) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    Json(merged_lines(&state, &app_id, &slug).await).into_response()
}

/// Live log tail as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Wakes on the
/// ingest tick's "new logs" signal (spec T3.3) instead of polling DuckDB, and
/// ends when the client disconnects.
pub async fn app_logs_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let (app_id, slug) = match telemetry_target_or_404(&state.pool, &id).await {
        Ok(target) => target,
        Err(e) => return e.into_response(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter("logs");
    let mut notify = state.log_notify.subscribe();
    // Mark seen so snapshots that predate the subscription don't replay.
    let _ = notify.borrow_and_update();
    tokio::spawn(async move {
        let mut last: Option<Vec<String>> = None;
        loop {
            let lines = merged_lines(&state, &app_id, &slug).await;
            if last.as_ref() != Some(&lines) {
                let data = serde_json::to_string(&lines).unwrap_or_default();
                if tx.send(Ok(Event::default().data(data))).await.is_err() {
                    break;
                }
                last = Some(lines);
            }
            // Wake on new ingested logs, on a 30 s heartbeat cadence, or stop
            // promptly when the client leaves (T1.2): the send-failure check
            // above only fires on change, so an idle tail would sleep forever
            // after disconnect.
            tokio::select! {
                _ = notify.changed() => {}
                () = tokio::time::sleep(Duration::from_secs(30)) => {}
                () = tx.closed() => break,
            }
        }
        crate::host::stats::sse_exit("logs");
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
