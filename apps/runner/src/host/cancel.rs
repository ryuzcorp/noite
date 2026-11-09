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
    notify: tokio::sync::Notify,
}

pub type CancelHandle = Arc<Cancel>;

impl Cancel {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolve once the operator cancels; returns at once when it already
    /// happened.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
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
    /// A fresh token for `deploy_id`; the previous one (a finished run) is
    /// replaced.
    pub fn register(&self, deploy_id: &str) -> CancelHandle {
        let token: CancelHandle = Arc::new(Cancel::new());
        self.live
            .lock()
            .expect("cancel registry poisoned")
            .insert(deploy_id.to_string(), token.clone());
        token
    }

    /// Drop the token once the run ends: a later stop of the same row is
    /// then answered from the database, not by tripping a dead token.
    pub fn release(&self, deploy_id: &str) {
        self.live
            .lock()
            .expect("cancel registry poisoned")
            .remove(deploy_id);
    }

    /// Trip the live token for `deploy_id`. `false` = no run is registered
    /// (finished, or the runner restarted), so the caller decides from the
    /// row's status.
    pub fn cancel(&self, deploy_id: &str) -> bool {
        let token = self
            .live
            .lock()
            .expect("cancel registry poisoned")
            .get(deploy_id)
            .cloned();
        match token {
            Some(token) => {
                token.trip();
                true
            }
            None => false,
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
