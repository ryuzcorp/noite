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

pub async fn app_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let hours = q.hours.unwrap_or(24).clamp(1, 336);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:%M:00Z")
        .to_string();
    match db::list_app_metrics(&state.pool, &id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_devices(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let hours = q.hours.unwrap_or(24).clamp(1, 336);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_devices(&state.pool, &id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_paths(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let hours = q.hours.unwrap_or(24).clamp(1, 336);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_paths(&state.pool, &id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_refs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let hours = q.hours.unwrap_or(24).clamp(1, 336);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    match db::list_app_refs(&state.pool, &id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_spans(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => {
            let hours = q.hours.unwrap_or(1).clamp(1, 24);
            let since = metrics::now_us_pub() - hours * 3_600_000_000;
            let spans = metrics::top_spans(&state.config, &app.slug, since).await;
            Json(spans).into_response()
        }
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let mut lines = metrics::recent_logs(&state.config, &app.slug, 500).await;
    lines.extend(logs::tail(&state.logs, &app.slug, 500).await);
    Json(lines).into_response()
}

/// Live log tail as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Ends when the
/// client disconnects.
pub async fn app_logs_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    let cfg = state.config.clone();
    let log_state = state.logs.clone();
    let slug = app.slug.clone();
    tokio::spawn(async move {
        let mut last: Option<Vec<String>> = None;
        loop {
            let mut lines = metrics::recent_logs(&cfg, &slug, 500).await;
            lines.extend(logs::tail(&log_state, &slug, 500).await);
            if last.as_ref() != Some(&lines) {
                let data = serde_json::to_string(&lines).unwrap_or_default();
                if tx.send(Ok(Event::default().data(data))).await.is_err() {
                    break;
                }
                last = Some(lines);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
