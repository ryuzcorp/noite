//! Destructive work that must outlive its caller.
//!
//! The control plane times its runner calls out after 5 s, and an HTTP
//! handler whose client went away is dropped. A delete dropped halfway
//! leaves the row, the fleet or the scoped credentials behind, so the work
//! runs as its own task: dropping the caller only drops the waiter, and a
//! connected caller still gets the real outcome.

use std::future::Future;

use crate::api_error::ApiError;

/// Run `work` as its own task and await it. `task` names it in errors and
/// logs (`app:<id>`, `env:<id>`); tests wait on [`finished`] under the same
/// name, because a dropped caller has no other way to observe the end.
pub(crate) async fn run<T: Send + 'static>(
    task: String,
    work: impl Future<Output = Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError> {
    let name = task.clone();
    let handle = tokio::spawn(async move {
        let out = work.await;
        tracing::debug!(task = %name, ok = out.is_ok(), "detached work finished");
        #[cfg(test)]
        finished(&name).notify_one();
        out
    });
    match handle.await {
        Ok(out) => out,
        Err(join) => Err(ApiError::internal(format!("{task} task failed: {join}"))),
    }
}

/// Fired once when the detached work named `task` has finished, every
/// effect included. `notify_one` keeps a permit, so a test may start
/// waiting after the work already ended.
#[cfg(test)]
pub(crate) fn finished(task: &str) -> std::sync::Arc<tokio::sync::Notify> {
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex};
    static DONE: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    DONE.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entry(task.to_string())
        .or_default()
        .clone()
}
