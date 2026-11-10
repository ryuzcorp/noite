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

/// A stall that lasts this long after frames have flowed ends the stream with
/// an error (the hub treats it as retrying and reopens). Without it a wedged
/// snapshot kept the topic open forever with no frames and no terminal state.
pub(crate) const STALL_BUDGET: Duration = Duration::from_secs(60);

/// The poll loop's explicit lifecycle. One event in, one transition out; the
/// loop never branches on loose counters.
///
/// stateDiagram-v2
///   [*] --> AwaitingFirst
///   AwaitingFirst --> Streaming: Frame
///   AwaitingFirst --> AwaitingFirst: PollFailed
///   AwaitingFirst --> Ended: first-frame budget spent
///   Streaming --> Streaming: Frame / PollFailed
///   Streaming --> Degraded: PollFailed (no frame for MAX_QUIET_FAILURES)
///   Degraded --> Streaming: Frame
///   Degraded --> Degraded: PollFailed
///   Degraded --> Ended: STALL_BUDGET spent with no frame
///   Ended --> [*]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StreamPhase {
    AwaitingFirst { started: Instant },
    Streaming,
    Degraded { since: Instant, failures: u32 },
    Ended,
}

#[derive(Debug)]
pub(crate) enum StreamEvent {
    Snapshot(Option<String>),
    PollFailed(&'static str),
    ClientGone,
}

/// What the loop does with one transition.
#[derive(Debug, Default)]
pub(crate) struct Step {
    pub(crate) frame: Option<String>,
    pub(crate) end: Option<anyhow::Error>,
    pub(crate) warn: Option<(u32, &'static str)>,
}

pub(crate) struct StreamMachine {
    phase: StreamPhase,
    last: Option<String>,
}

impl StreamMachine {
    pub(crate) fn new() -> Self {
        Self {
            phase: StreamPhase::AwaitingFirst {
                started: Instant::now(),
            },
            last: None,
        }
    }

    pub(crate) fn on(
        mut self,
        event: StreamEvent,
        now: Instant,
        first_budget: Duration,
        stall_budget: Duration,
    ) -> (Self, Step) {
        let mut step = Step::default();
        let phase = match event {
            StreamEvent::Snapshot(Some(data)) => {
                if self.last.as_ref() != Some(&data) {
                    step.frame = Some(data.clone());
                }
                self.last = Some(data);
                StreamPhase::Streaming
            }
            ev @ (StreamEvent::Snapshot(None) | StreamEvent::PollFailed(_)) => {
                let kind = match ev {
                    StreamEvent::PollFailed(kind) => kind,
                    _ => "failed",
                };
                match self.phase {
                    StreamPhase::AwaitingFirst { started } => {
                        step.warn = Some((1, kind));
                        if now.duration_since(started) >= first_budget {
                            step.end = Some(anyhow::anyhow!(
                                "stream: no first frame within {first_budget:?}"
                            ));
                            StreamPhase::Ended
                        } else {
                            StreamPhase::AwaitingFirst { started }
                        }
                    }
                    StreamPhase::Streaming => StreamPhase::Degraded {
                        since: now,
                        failures: 1,
                    },
                    StreamPhase::Degraded { since, failures } => {
                        let failures = failures.saturating_add(1);
                        step.warn = (failures == MAX_QUIET_FAILURES).then_some((failures, kind));
                        if now.duration_since(since) >= stall_budget {
                            step.end = Some(anyhow::anyhow!(
                                "stream: no frame for {stall_budget:?}; ending so the client reopens"
                            ));
                            StreamPhase::Ended
                        } else {
                            StreamPhase::Degraded { since, failures }
                        }
                    }
                    StreamPhase::Ended => StreamPhase::Ended,
                }
            }
            StreamEvent::ClientGone => StreamPhase::Ended,
        };
        (
            Self {
                phase,
                last: self.last,
            },
            step,
        )
    }

    pub(crate) fn ended(&self) -> bool {
        self.phase == StreamPhase::Ended
    }
}

/// Spawn the poll loop for `scope` and return the SSE response. `snapshot`
/// yields `Some(json)` to consider sending (only sent when it changed since
/// the last frame) or `None` for a transient failure, which is retried on
/// the next tick. A snapshot that hangs longer than [`SNAPSHOT_TIMEOUT`]
/// counts as a failed poll; a topic that produces no first frame within that
/// budget ends with an error, and a topic that stops producing frames for
/// [`STALL_BUDGET`] after the first one ends the same way — a visible,
/// self-healing retry instead of an open, frameless stall.
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
    poll_stream_with_stall(scope, interval, snapshot_timeout, STALL_BUDGET, snapshot)
}

/// [`poll_stream_with`] with the post-first-frame stall bound explicit.
pub(crate) fn poll_stream_with_stall<S, F>(
    scope: &'static str,
    interval: Duration,
    snapshot_timeout: Duration,
    stall_budget: Duration,
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
        // advances it, so the budgets below are drivable without sleeps.
        let mut machine = StreamMachine::new();
        loop {
            let event = match tokio::time::timeout(snapshot_timeout, snapshot()).await {
                Ok(Some(data)) => StreamEvent::Snapshot(Some(data)),
                Ok(None) => StreamEvent::PollFailed("failed"),
                Err(_) => StreamEvent::PollFailed("timed out"),
            };
            let (next, step) = machine.on(event, Instant::now(), snapshot_timeout, stall_budget);
            machine = next;
            if let Some((failures, kind)) = step.warn {
                tracing::warn!(scope, failures, kind, "stream snapshot produced no frame");
            }
            if let Some(data) = step.frame {
                // A failed send means the client left; the send error is the
                // only signal needed, so the loop ends without another event.
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
            // Stop promptly when the client leaves (T1.2): the send-failure
            // check above only fires on change, so an idle stream would poll
            // SQLite forever after disconnect.
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = tx.closed() => {
                    let _ = machine.on(
                        StreamEvent::ClientGone,
                        Instant::now(),
                        snapshot_timeout,
                        stall_budget,
                    );
                    break;
                }
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

    /// P1: a stream that delivered a first frame and then stops producing
    /// frames must reach a terminal state; the old loop retried forever, so
    /// the topic stayed open and silent.
    #[tokio::test]
    async fn a_stream_that_stops_delivering_ends_after_the_stall_budget() {
        tokio::time::pause();
        let mut calls = 0;
        let response =
            poll_stream_with_stall("test", TICK, BUDGET, Duration::from_millis(40), move || {
                calls += 1;
                async move {
                    if calls == 1 {
                        Some("\"frame\"".to_owned())
                    } else {
                        None
                    }
                }
            });
        assert!(
            drained(response).await,
            "a stream stuck after its first frame must end, not stay open and silent"
        );
    }

    /// A transient failure after the first frame is retried, not terminal:
    /// the stall budget has not been spent.
    #[tokio::test]
    async fn failures_after_the_first_frame_are_retried() {
        tokio::time::pause();
        let mut calls = 0;
        let response =
            poll_stream_with_stall("test", TICK, BUDGET, Duration::from_secs(60), move || {
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
        assert!(
            tokio::time::timeout(BUDGET * 10, frames.next())
                .await
                .is_err(),
            "a transient failure after the first frame must keep retrying"
        );
    }
}
