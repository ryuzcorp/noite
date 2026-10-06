//! Grouped errors as a live SSE stream (the unary reads stay on JSON-RPC).
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
};
use tokio_stream::wrappers::ReceiverStream;

use crate::api::rpc::{error_list, ERROR_STATUSES};
use crate::error::ApiError;
use crate::AppState;

#[derive(serde::Deserialize)]
pub struct ErrorsStreamQuery {
    status: Option<String>,
}

/// One status's issue list (the `errors.list` shape) as server-sent events:
/// a frame only when the list, a count or an hourly series changed (plus
/// keep-alive comments). Ends when the client disconnects.
pub async fn list_errors_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ErrorsStreamQuery>,
) -> impl IntoResponse {
    let status = q.status.unwrap_or_else(|| "open".into());
    if !ERROR_STATUSES.contains(&status.as_str()) {
        return ApiError::bad("status must be open, resolved or ignored").into_response();
    }
    let app_id = match crate::api::observe::telemetry_target_or_404(&state.pool, &id).await {
        Ok((app_id, _)) => app_id,
        Err(e) => return e.into_response(),
    };
    let pool = state.pool.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter("errors");
    tokio::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            if let Ok(list) = error_list(&pool, &app_id, &status).await {
                let data = list.to_string();
                if last.as_ref() != Some(&data) {
                    if tx
                        .send(Ok(Event::default().data(data.clone())))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    last = Some(data);
                }
            }
            // Transient DB errors retry on the next tick. Stop promptly when
            // the client leaves (T1.2), like the deploys stream.
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(2)) => {}
                () = tx.closed() => break,
            }
        }
        crate::host::stats::sse_exit("errors");
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
