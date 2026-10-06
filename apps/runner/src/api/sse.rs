//! Shared server-sent-events plumbing for the poll-driven streams (deploys,
//! errors, events): poll a snapshot on an interval, emit only when it changed,
//! stop promptly on disconnect, and track the live-stream counter.
//!
//! The logs stream is notify-driven (`log_notify`) and keeps its own loop; the
//! payloads of every stream are byte-identical to what each route served
//! before the helper existed.

use std::future::Future;
use std::time::Duration;

use axum::response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse, Response,
};
use tokio_stream::wrappers::ReceiverStream;

/// Spawn the poll loop for `scope` and return the SSE response. `snapshot`
/// yields `Some(json)` to consider sending (only sent when it changed since
/// the last frame) or `None` for a transient failure, which is simply retried
/// on the next tick.
pub(crate) fn poll_stream<S, F>(scope: &'static str, interval: Duration, snapshot: F) -> Response
where
    F: FnMut() -> S + Send + 'static,
    S: Future<Output = Option<String>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter(scope);
    let mut snapshot = snapshot;
    tokio::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            if let Some(data) = snapshot().await {
                if last.as_ref() != Some(&data) {
                    if tx.send(Ok(Event::default().data(data.clone()))).await.is_err() {
                        break;
                    }
                    last = Some(data);
                }
            }
            // Stop promptly when the client leaves (T1.2): the send-failure
            // check above only fires on change, so an idle stream would poll
            // SQLite forever after disconnect.
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = tx.closed() => break,
            }
        }
        crate::host::stats::sse_exit(scope);
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
