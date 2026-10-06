//! Observability: metrics, spans, logs (thin adapters over
//! `service::observe`) + the notify-driven live log tail.
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use serde::Deserialize;
use tokio_stream::wrappers::ReceiverStream;

use crate::service;
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
    service::observe::metrics(&state, &id, q.hours).await.map(Json)
}

pub async fn app_devices(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::devices(&state, &id, q.hours).await.map(Json)
}

pub async fn app_paths(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::paths(&state, &id, q.hours).await.map(Json)
}

pub async fn app_refs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::refs(&state, &id, q.hours).await.map(Json)
}

pub async fn app_spans(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::spans(&state, &id, q.hours).await.map(Json)
}

/// Per-app metrics version (spec T3.6): dashboard polls fetch this first and
/// skip their window queries when it hasn't moved.
pub async fn app_metrics_version(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::observe::metrics_version(&state, &id)
        .await
        .map(Json)
}

pub async fn app_logs(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::observe::logs_lines(&state, &id).await.map(Json)
}

/// Live log tail as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Wakes on the
/// ingest tick's "new logs" signal (spec T3.3) instead of polling DuckDB, and
/// ends when the client disconnects.
pub async fn app_logs_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let (app_id, slug) =
        match service::observe::telemetry_target_or_404(&state.pool, &id).await {
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
            let lines = service::observe::merged_lines(&state, &app_id, &slug).await;
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
