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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The operator's stop, in the log and the app summary alike.
pub const CANCELLED: &str = "cancelled by the operator";

tokio::task_local! {
    static CURRENT: CancelHandle;
}

/// One deploy's cancellation state. `flag` makes repeated checks cheap and
/// idempotent; `notify` wakes the waiting child process the moment the
/// operator asks.
pub struct Cancel {
    flag: AtomicBool,
    /// Set once the run moved the staged generation onto the fleet: the
    /// release now serves it, so a stop cannot un-do it (the endpoint
    /// answers 409 instead of pretending).
    committed: AtomicBool,
    notify: tokio::sync::Notify,
}

/// What a stop request found for its deploy id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// A live run was told to stop.
    Signalled,
    /// The run is past its point of no return (it activated its generation).
    Committed,
    /// No live run holds this id: the caller decides from the row's status.
    Missing,
}

pub type CancelHandle = Arc<Cancel>;

impl Cancel {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            committed: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolve once the operator cancels; returns at once when it already
    /// happened.
    pub async fn cancelled(&self) {
        // Register the waiter *before* re-reading the flag: a trip between
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

    /// Mark the run past the point where a stop can change its outcome.
    pub fn commit(&self) {
        self.committed.store(true, Ordering::SeqCst);
    }

    pub fn is_committed(&self) -> bool {
        self.committed.load(Ordering::SeqCst)
    }

    fn trip(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // `notify_waiters` wakes everyone already parked; the flag covers
        // every waiter that arrives after this line.
        self.notify.notify_waiters();
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

    /// A fresh token for `deploy_id`; the previous one (a finished run) is
    /// replaced.
    pub fn register(&self, deploy_id: &str) -> CancelHandle {
        let token: CancelHandle = Arc::new(Cancel::new());
        self.guard_map()
            .insert(deploy_id.to_string(), token.clone());
        token
    }

    /// Drop the token once the run ends: a later stop of the same row is
    /// then answered from the database, not by tripping a dead token.
    pub fn release(&self, deploy_id: &str) {
        self.guard_map().remove(deploy_id);
    }

    /// Trip the live token for `deploy_id`, unless its run already committed
    /// (it activated a generation: nothing is left to stop).
    pub fn cancel(&self, deploy_id: &str) -> CancelOutcome {
        let token = self.guard_map().get(deploy_id).cloned();
        match token {
            Some(token) if token.is_committed() => CancelOutcome::Committed,
            Some(token) => {
                token.trip();
                CancelOutcome::Signalled
            }
            None => CancelOutcome::Missing,
        }
    }
}

/// Releases a deploy's token when the run ends, however it ends (a panic
/// included): a stop of the finished row is then answered from its status.
pub struct ReleaseGuard {
    id: String,
}

impl Drop for ReleaseGuard {
    fn drop(&mut self) {
        CANCELS.release(&self.id);
    }
}

impl Cancels {
    /// The token lifetime guard for one run.
    pub fn guard(&self, deploy_id: &str) -> ReleaseGuard {
        ReleaseGuard {
            id: deploy_id.to_string(),
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
