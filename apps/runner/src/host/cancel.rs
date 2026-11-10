//! Operator deploy cancellation.
//!
//! An in-flight deploy's row is visible in the UI, so the operator can stop
//! it: the API trips a token keyed by deploy id, the pipeline checks it at
//! every step boundary and every child process races it (see
//! [`exec::run_cmd_output_stdin`](super::exec) and
//! [`exec::run_sandboxed`](super::exec)), so a build dies with its whole
//! process group instead of running to its step timeout after the row already
//! says failed.
//!
//! The token reaches the exec helpers through a task-local: `deploy_app` runs
//! the pipeline inside [`with`], so everything the pipeline spawns — including
//! the celld and migrate helpers that never see a `Progress` — races the same
//! token without a parameter threaded through every signature.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

/// The operator's stop, in the log and the app summary alike.
pub const CANCELLED: &str = "cancelled by the operator";

tokio::task_local! {
    static CURRENT: CancelHandle;
}

/// One live deploy's admission state: whether a stop can still change the
/// outcome, and whether one already has.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Live: the run registers its deploy id
///   Live --> Cancelled: operator stop (answers 200)
///   Live --> Committed: activation starts (point of no return)
///   Cancelled --> [*]: the run aborts before it activates
///   Committed --> [*]: the run finishes; later stops answer 409
/// ```
///
/// `Cancelled` and `Committed` are terminal and mutually exclusive, and the
/// move out of `Live` is one compare-and-swap: a stop and an activation
/// cannot both win, so a 200 always means the generation never activates and
/// the run can never abort after committing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunState {
    Live = 0,
    Cancelled = 1,
    Committed = 2,
}

impl RunState {
    fn load(value: u8) -> Self {
        match value {
            1 => Self::Cancelled,
            2 => Self::Committed,
            _ => Self::Live,
        }
    }
}

/// One deploy's cancellation state as one value. `notify` wakes the waiting
/// child process the moment the operator asks.
pub struct Cancel {
    /// The [`RunState`], as its discriminant: one atomic compare-and-swap
    /// decides every race the old `flag`/`committed` pair could lose.
    state: AtomicU8,
    notify: tokio::sync::Notify,
}

/// What a stop request found for its deploy id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// A live run was told to stop (or already had been).
    Signalled,
    /// The run is past its point of no return (it started activating).
    Committed,
    /// No live run holds this id: the caller decides from the row's status.
    Missing,
}

pub type CancelHandle = Arc<Cancel>;

impl Cancel {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(RunState::Live as u8),
            notify: tokio::sync::Notify::new(),
        }
    }

    fn state(&self) -> RunState {
        RunState::load(self.state.load(Ordering::SeqCst))
    }

    /// Whether the operator has stopped this run *and* it can still be
    /// stopped: a committed run is never "cancelled" again.
    pub fn is_cancelled(&self) -> bool {
        self.state() == RunState::Cancelled
    }

    /// Resolve once the operator cancels; returns at once when it already
    /// happened.
    pub async fn cancelled(&self) {
        // Register the waiter *before* re-reading the state: a trip between
        // the old check and `notified()` would find no waiter and never wake
        // this future, so the stop would wait out the step instead of
        // killing it.
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    /// Enter the point of no return: from here a stop is refused (409).
    /// `false` means the operator's stop won the race instead — the caller
    /// MUST NOT activate, and must fail the run with [`CANCELLED`]. The
    /// compare-and-swap makes "stop then commit" and "commit then stop"
    /// mutually exclusive, which is what closes the activate→commit window.
    pub fn commit(&self) -> bool {
        match self.state.compare_exchange(
            RunState::Live as u8,
            RunState::Committed as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(current) => RunState::load(current) == RunState::Committed,
        }
    }

    /// Whether the run is past its point of no return.
    pub fn is_committed(&self) -> bool {
        self.state() == RunState::Committed
    }

    /// Stop the run, unless it already committed. `false` = the stop lost to
    /// an activation that has started.
    fn trip(&self) -> bool {
        match self.state.compare_exchange(
            RunState::Live as u8,
            RunState::Cancelled as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {
                // `notify_waiters` wakes everyone already parked; the state
                // covers every waiter that arrives after this line.
                self.notify.notify_waiters();
                true
            }
            Err(_) => false,
        }
    }
}

/// The live tokens, one per in-flight deploy row. Process-wide: the API and
/// the pipeline are the same process, and the deploy id is a UUID, so there
/// is nothing to scope per app.
#[derive(Clone, Default)]
pub struct Cancels {
    live: Arc<Mutex<HashMap<String, CancelHandle>>>,
}

impl Cancels {
    /// The map, surviving a poisoned lock: a panic while holding this tiny
    /// section must not turn every later stop into a 500 (and a guard's drop
    /// panicking during unwinding would abort the process), exactly like
    /// `AppLock` in `deploy.rs`.
    fn guard_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancelHandle>> {
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Drop a token, as a finished run does. Production goes through
    /// [`ReleaseGuard`] (which only removes its own token); tests use this to
    /// simulate a run that already ended.
    #[cfg(test)]
    pub fn release(&self, deploy_id: &str) {
        self.guard_map().remove(deploy_id);
    }

    /// A fresh token for `deploy_id`; the previous one (a finished run) is
    /// replaced.
    pub fn register(&self, deploy_id: &str) -> CancelHandle {
        let token: CancelHandle = Arc::new(Cancel::new());
        self.guard_map()
            .insert(deploy_id.to_string(), token.clone());
        token
    }

    /// Trip the live token for `deploy_id`, unless its run already committed
    /// (it started activating: nothing is left to stop).
    pub fn cancel(&self, deploy_id: &str) -> CancelOutcome {
        let token = self.guard_map().get(deploy_id).cloned();
        match token {
            Some(token) if token.is_committed() => CancelOutcome::Committed,
            Some(token) => {
                // `trip` loses to a commit that landed between the read above
                // and this line; the caller must still answer 409 then.
                if token.trip() || token.is_cancelled() {
                    CancelOutcome::Signalled
                } else {
                    CancelOutcome::Committed
                }
            }
            None => CancelOutcome::Missing,
        }
    }
}

/// Releases a deploy's token when the run ends, however it ends (a panic
/// included): a stop of the finished row is then answered from its status.
pub struct ReleaseGuard {
    /// The registry that registered the token (the process-wide `CANCELS` in
    /// production): the guard releases into the one that made it.
    registry: Cancels,
    id: String,
    /// The token this run registered, if any: a guard never releases a
    /// token another run registered for the same id (a re-used row id).
    token: Option<CancelHandle>,
}

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        let mut live = self.registry.guard_map();
        if let (Some(ours), Some(current)) = (&self.token, live.get(&self.id)) {
            if Arc::ptr_eq(ours, current) {
                live.remove(&self.id);
            }
        }
    }
}

impl Cancels {
    /// The token lifetime guard for one run: it releases the token it was
    /// made for, and only while that token is still the registered one.
    pub fn guard(&self, deploy_id: &str) -> ReleaseGuard {
        let token = self.guard_map().get(deploy_id).cloned();
        ReleaseGuard {
            registry: self.clone(),
            id: deploy_id.to_string(),
            token,
        }
    }
}

/// One registry for the whole process (API handlers and every deploy task).
pub static CANCELS: std::sync::LazyLock<Cancels> = std::sync::LazyLock::new(Cancels::default);

/// The token of the deploy this task belongs to, when it is a deploy task.
pub fn current() -> Option<CancelHandle> {
    CURRENT.try_with(Clone::clone).ok()
}

/// Run `fut` as part of `token`'s deploy.
pub async fn with<T>(token: CancelHandle, fut: impl Future<Output = T>) -> T {
    CURRENT.scope(token, fut).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The race the old two-flag token lost: a stop arriving between the last
    /// cancel check and `commit_cancel` tripped the flag, the run committed
    /// anyway (the flags were independent), activated the generation and then
    /// failed the row — while the stop had already answered 200. A stop and a
    /// commit can now never both win, so 200 always means "nothing
    /// activates".
    #[test]
    fn a_stop_and_a_commit_cannot_both_win() {
        let stopped_first = Cancel::new();
        assert!(stopped_first.trip(), "the first stop trips a live run");
        assert!(
            !stopped_first.commit(),
            "a stopped run must refuse the commit, so it cannot activate"
        );
        assert!(stopped_first.is_cancelled());
        assert!(!stopped_first.is_committed());

        let committed_first = Cancel::new();
        assert!(committed_first.commit(), "activation commits a live run");
        assert!(
            !committed_first.trip(),
            "a committed run refuses the stop (the endpoint answers 409)"
        );
        assert!(committed_first.is_committed());
        assert!(
            !committed_first.is_cancelled(),
            "every later cancel check stays satisfied past the point of no return"
        );
    }

    /// A late release from an earlier run can never drop a newer run's token
    /// for the same id: only the token the guard was made for is removed.
    #[test]
    fn a_release_guard_never_frees_another_runs_token() {
        let cancels = Cancels::default();
        let _first = cancels.register("reused-id");
        let stale = cancels.guard("reused-id");
        let second = cancels.register("reused-id");
        drop(stale);
        assert_eq!(
            cancels.cancel("reused-id"),
            CancelOutcome::Signalled,
            "the live run's token survives the old run's release"
        );
        assert!(second.is_cancelled());
        drop(cancels.guard("reused-id"));
        assert_eq!(cancels.cancel("reused-id"), CancelOutcome::Missing);
    }

    /// Repeated stops are idempotent, and a released token stops being a
    /// stop target (the endpoint answers from the row instead).
    #[test]
    fn repeated_stops_are_idempotent_and_release_ends_the_token() {
        let cancels = Cancels::default();
        let token = cancels.register("d1");
        assert_eq!(cancels.cancel("d1"), CancelOutcome::Signalled);
        assert_eq!(cancels.cancel("d1"), CancelOutcome::Signalled);
        assert!(token.is_cancelled());

        assert!(!token.commit(), "a stopped run cannot commit afterwards");
        cancels.release("d1");
        assert_eq!(cancels.cancel("d1"), CancelOutcome::Missing);

        let committed = cancels.register("d2");
        assert!(committed.commit());
        assert_eq!(cancels.cancel("d2"), CancelOutcome::Committed);
    }
}
