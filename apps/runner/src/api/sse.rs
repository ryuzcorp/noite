//! Shared server-sent-events plumbing for the poll-driven streams (deploys,
//! errors, events): poll a snapshot on an interval, emit only when it changed,
//! stop promptly on disconnect, and track the live-stream counter.
//!
//! The logs stream is notify-driven (`log_notify`) and keeps its own loop; the
//! payloads of every stream are byte-identical to what each route served
//! before the helper existed.

use std::future::Future;
use std::time::Duration;

use tokio::time::Instant;

use axum::response::{
    sse::{Event, KeepAlive, Sse},
    IntoResponse, Response,
};
use tokio_stream::wrappers::ReceiverStream;

/// Bound every snapshot poll: snapshots are single local SQLite queries
/// (low milliseconds in tests and production), so 10 s is orders of
/// magnitude above a healthy poll while failing fast enough that the hub
/// reopens the topic (capped 30 s backoff) before a client stares at a
/// skeleton. Also the first-frame budget: a topic that produces no frame
/// within this long of its stream opening ends with an error, which the hub
/// and the client already treat as "retrying" and reopen.
pub(crate) const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(10);

/// Consecutive failed polls tolerated once a frame is flowing: three 2 s
/// ticks (6 s without fresh data) before warning. Before the first frame
/// there is no tolerance — the first failure warns and the budget above ends
/// the stream.
const MAX_QUIET_FAILURES: u32 = 3;

/// Spawn the poll loop for `scope` and return the SSE response. `snapshot`
/// yields `Some(json)` to consider sending (only sent when it changed since
/// the last frame) or `None` for a transient failure, which is retried on
/// the next tick. A snapshot that hangs longer than [`SNAPSHOT_TIMEOUT`]
/// counts as a failed poll; once frames flow, `MAX_QUIET_FAILURES` in a row
/// warn and keep retrying, but before the first frame the stream ends with
/// an error once the budget is spent, so a hung first snapshot surfaces as
/// a visible, self-healing retry instead of an open, frameless stall.
pub(crate) fn poll_stream<S, F>(scope: &'static str, interval: Duration, snapshot: F) -> Response
where
    F: FnMut() -> S + Send + 'static,
    S: Future<Output = Option<String>> + Send + 'static,
{
    poll_stream_with(scope, interval, SNAPSHOT_TIMEOUT, snapshot)
}

/// [`poll_stream`] with the snapshot bound explicit, so tests can drive a
/// wedged snapshot on paused time instead of waiting out the production
/// budget.
pub(crate) fn poll_stream_with<S, F>(
    scope: &'static str,
    interval: Duration,
    snapshot_timeout: Duration,
    snapshot: F,
) -> Response
where
    F: FnMut() -> S + Send + 'static,
    S: Future<Output = Option<String>> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter(scope);
    let mut snapshot = snapshot;
    tokio::spawn(async move {
        // `tokio::time::Instant` (not the wall clock): paused test time
        // advances it, so the budget below is drivable without sleeps.
        let started = Instant::now();
        let mut last: Option<String> = None;
        let mut sent_first = false;
        let mut failures: u32 = 0;
        loop {
            let failure: Option<&str> =
                match tokio::time::timeout(snapshot_timeout, snapshot()).await {
                    Ok(Some(data)) => {
                        failures = 0;
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
                        sent_first = true;
                        None
                    }
                    Ok(None) => Some("failed"),
                    Err(_) => Some("timed out"),
                };
            if let Some(kind) = failure {
                failures += 1;
                if !sent_first || failures == MAX_QUIET_FAILURES {
                    tracing::warn!(scope, failures, kind, "stream snapshot produced no frame");
                }
                if !sent_first && started.elapsed() >= snapshot_timeout {
                    let _ = tx
                        .send(Err(anyhow::anyhow!(
                            "{scope} stream: no first frame within {snapshot_timeout:?}"
                        )))
                        .await;
                    break;
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    const BUDGET: Duration = Duration::from_millis(50);
    const TICK: Duration = Duration::from_millis(10);

    /// Drain the body in the background; the test advances paused time past
    /// the budget, lets the spawned tasks settle, then asserts the drain
    /// finished (the stream ended) instead of sleeping on an open stream.
    async fn drained(response: Response) -> bool {
        let body = response.into_body();
        let drain = tokio::spawn(async move { axum::body::to_bytes(body, usize::MAX).await });
        for _ in 0..100 {
            tokio::time::advance(Duration::from_millis(10)).await;
            tokio::task::yield_now().await;
            if drain.is_finished() {
                let _ = drain.await.expect("drain joins");
                return true;
            }
        }
        false
    }

    #[tokio::test]
    async fn a_snapshot_that_never_answers_ends_the_stream() {
        tokio::time::pause();
        let response = poll_stream_with("test", TICK, BUDGET, || {
            std::future::pending::<Option<String>>()
        });
        assert!(
            drained(response).await,
            "a hung snapshot must end the stream within its bound, not stay open and silent"
        );
    }

    #[tokio::test]
    async fn snapshots_that_always_fail_end_the_stream() {
        tokio::time::pause();
        let response = poll_stream_with("test", TICK, BUDGET, || async { None });
        assert!(
            drained(response).await,
            "snapshots that fail every tick must end the stream once the budget is spent"
        );
    }

    #[tokio::test]
    async fn a_transient_failure_before_the_first_frame_still_delivers_it() {
        tokio::time::pause();
        let mut calls = 0;
        let response = poll_stream_with("test", TICK, BUDGET, move || {
            calls += 1;
            async move {
                if calls == 1 {
                    None
                } else {
                    Some("\"frame\"".to_owned())
                }
            }
        });
        let mut frames = response.into_body().into_data_stream();
        tokio::time::advance(BUDGET).await;
        let first = frames
            .next()
            .await
            .expect("a first chunk arrives")
            .expect("body chunk");
        let text = format!("{first:?}");
        assert!(
            text.contains("frame"),
            "the retried snapshot sends its frame: {text}"
        );
    }

    #[tokio::test]
    async fn failures_after_the_first_frame_keep_the_stream_open() {
        tokio::time::pause();
        let mut calls = 0;
        let response = poll_stream_with("test", TICK, BUDGET, move || {
            calls += 1;
            async move {
                if calls == 1 {
                    Some("\"frame\"".to_owned())
                } else {
                    None
                }
            }
        });
        let mut frames = response.into_body().into_data_stream();
        tokio::time::advance(BUDGET + Duration::from_millis(500)).await;
        let first = frames
            .next()
            .await
            .expect("the first frame arrives")
            .expect("body chunk");
        let text = format!("{first:?}");
        assert!(
            text.contains("frame"),
            "the first frame is delivered: {text}"
        );
    }
}
