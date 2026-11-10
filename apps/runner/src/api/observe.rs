//! Observability: metrics, spans, logs (thin adapters over
//! `service::observe`) + the notify-driven live log tail.
use std::time::Duration;

use tokio::time::Instant;

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

use crate::api::sse::{StreamEvent, StreamMachine, SNAPSHOT_TIMEOUT, STALL_BUDGET};
use crate::service;
use crate::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsQuery {
    pub hours: Option<i64>,
    #[serde(default)]
    pub environment_id: Option<String>,
}

pub async fn app_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::metrics(&state, &id, q.hours, q.environment_id.as_deref())
        .await
        .map(Json)
}

pub async fn app_devices(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::devices(&state, &id, q.hours, q.environment_id.as_deref())
        .await
        .map(Json)
}

pub async fn app_paths(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::paths(&state, &id, q.hours, q.environment_id.as_deref())
        .await
        .map(Json)
}

pub async fn app_refs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::refs(&state, &id, q.hours, q.environment_id.as_deref())
        .await
        .map(Json)
}

pub async fn app_spans(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::spans(&state, &id, q.hours, q.environment_id.as_deref())
        .await
        .map(Json)
}
/// Per-app metrics version (spec T3.6): dashboard polls fetch this first and
/// skip their window queries when it hasn't moved.
pub async fn app_metrics_version(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    service::observe::metrics_version(&state, &id, q.environment_id.as_deref())
        .await
        .map(Json)
}

/// `?environmentId=` — one preview environment's live log; absent is the
/// app's own fleet (production, or the control fleet).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsQuery {
    #[serde(default)]
    pub environment_id: Option<String>,
}

pub async fn app_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> impl IntoResponse {
    service::observe::logs_lines(&state, &id, q.environment_id.as_deref())
        .await
        .map(Json)
}

/// Live log tail as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Wakes on the
/// ingest tick's "new logs" signal (spec T3.3) instead of polling DuckDB, and
/// ends when the client disconnects. `?environmentId=` serves that
/// environment's own ring and its ingested OTel logs, never production's.
///
/// The loop shares [`StreamMachine`] with the poll-driven streams: a snapshot
/// that hangs past the first-frame budget (or a run of failures past the
/// stall budget) ends the stream with an error, which the hub reports as
/// retrying, instead of leaving an open, frameless topic.
pub async fn app_logs_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> Response {
    let source = match service::observe::log_source(&state, &id, q.environment_id.as_deref()).await
    {
        Ok(source) => source,
        Err(e) => return e.into_response(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter("logs");
    let mut notify = state.log_notify.subscribe();
    // Mark seen so snapshots that predate the subscription don't replay.
    let _ = notify.borrow_and_update();
    tokio::spawn(async move {
        let mut machine = StreamMachine::new();
        loop {
            let event = match tokio::time::timeout(SNAPSHOT_TIMEOUT, source.lines(&state)).await {
                Ok(lines) => match serde_json::to_string(&lines) {
                    Ok(data) => StreamEvent::Snapshot(Some(data)),
                    Err(e) => {
                        tracing::warn!(error = %e, "logs stream: dropping unserializable snapshot");
                        StreamEvent::PollFailed("unserializable")
                    }
                },
                Err(_) => StreamEvent::PollFailed("timed out"),
            };
            let (next, step) = machine.on(event, Instant::now(), SNAPSHOT_TIMEOUT, STALL_BUDGET);
            machine = next;
            if let Some((failures, kind)) = step.warn {
                tracing::warn!(
                    scope = "logs",
                    failures,
                    kind,
                    "logs stream produced no frame"
                );
            }
            if let Some(data) = step.frame {
                if tx.send(Ok(Event::default().data(data))).await.is_err() {
                    break;
                }
            }
            if let Some(error) = step.end {
                let _ = tx.send(Err(error)).await;
                break;
            }
            if machine.ended() {
                break;
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
