// Runtime fleet logs.
//
// Fleets previously inherited the runner's stdout (Stdio::inherit), so their
// output was lost. We now capture each celld's stdout+stderr into an
// in-memory ring buffer (per slug) and expose it via /v1/apps/{id}/logs.
// In-memory and bounded — a runner restart clears the buffer (mirrors the
// metrics watermark reset), so logs are recent activity only.
use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

pub type LogState = Arc<Mutex<HashMap<String, Vec<String>>>>;

const MAX_LINES: usize = 500;

pub fn new_state() -> LogState {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn append(state: &LogState, slug: &str, line: String) {
    let mut map = state.lock().await;
    let buf = map.entry(slug.to_string()).or_default();
    if buf.len() >= MAX_LINES {
        buf.remove(0);
    }
    buf.push(line);
}

/// Most recent `limit` lines for a fleet (chronological order).
pub async fn tail(state: &LogState, slug: &str, limit: usize) -> Vec<String> {
    let map = state.lock().await;
    let buf = map.get(slug).cloned().unwrap_or_default();
    let skip = buf.len().saturating_sub(limit);
    buf.into_iter().skip(skip).collect()
}

/// Drop the in-memory ring for a slug (app delete / purge).
pub async fn clear(state: &LogState, slug: &str) {
    state.lock().await.remove(slug);
}
