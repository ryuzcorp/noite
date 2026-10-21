//! App observability.
//!
//! Requests + latency come from celld's OpenTelemetry (CELLD_OTEL=1, bucket
//! sink): each fleet writes Parquet spans into its fleet bucket under
//! `telemetry/traces/...`, and we aggregate them with the DuckDB CLI — the
//! documented query path, no collector service.
//!
//! CPU time celld executes code: OTel has no metrics signal yet (spans carry
//! durations), so CPU is sampled from `/proc/<celld-pid>/stat` (+ descendants)
//! — visible because the runner spawns celld in its own PID namespace.
//!
//! One ingest pass per tick, all live fleets (spec T3.1): a single DuckDB
//! invocation over the hour globs of every live fleet reads each Parquet file
//! once and yields minute buckets, hourly span stats and new log lines at
//! once. Every dashboard then serves from SQLite — no DuckDB on any request
//! path.

use std::collections::{HashMap, HashSet};

use chrono::Utc;

use crate::host::errors;

mod compact;
mod cpu;
mod ingest;
mod plan;
mod tick;

pub use cpu::otel_env;
pub use tick::tick;

pub struct MetricsState {
    last_cpu: HashMap<String, (u64, u64)>, // slug -> (utime, stime) in ticks
    watermark: HashMap<String, i64>,       // slug -> last consumed start_unix_us
    /// slug -> newest durably compacted hour (`yyyy/mm/dd/hh`), loaded from
    /// `metric_compaction` at boot (spec T3.5).
    compacted: HashMap<String, String>,
    /// (slug, hour) pairs whose compaction attempt failed: skipped until the
    /// next pass boundary instead of retrying every tick.
    attempted: HashSet<(String, String)>,
    /// Last ingest pass: the DuckDB ingest runs at most once per
    /// `cfg.otel_flush_ms` (spec T3.4), not every reconcile tick.
    last_ingest: Option<std::time::Instant>,
    /// Trace id → edge request, from the access log; read when an error's
    /// span lands one flush later (host/errors.rs).
    requests: errors::RequestIndex,
    /// `requested_at` of the telemetry replay already rewound into
    /// `watermark`. The request row outlives it until every fleet catches up,
    /// so this stops a later pass from rewinding an already-progressing fleet
    /// back to the floor.
    replay_seen: Option<String>,
    /// (slug, chunk start) → retry time after that fleet failed an ingest
    /// pass. A broken fleet is skipped until then: it neither holds the other
    /// fleets (the shared pass falls back per fleet) nor spins every tick.
    ingest_backoff: HashMap<(String, i64), std::time::Instant>,
    tick: u64,
}

pub fn new_state() -> MetricsState {
    MetricsState {
        last_cpu: HashMap::new(),
        watermark: HashMap::new(),
        compacted: HashMap::new(),
        attempted: HashSet::new(),
        last_ingest: None,
        requests: errors::RequestIndex::default(),
        replay_seen: None,
        ingest_backoff: HashMap::new(),
        tick: 0,
    }
}

/// Restore a persisted compaction-watermark map into fresh state (boot only).
pub fn set_compacted(state: &mut MetricsState, marks: HashMap<String, String>) {
    state.compacted = marks;
}

/// Restore a persisted watermark map into fresh state (boot only).
pub fn set_watermarks(state: &mut MetricsState, marks: HashMap<String, i64>) {
    state.watermark = marks;
}

/// Fleet keys whose persisted telemetry state was deleted (an environment
/// teardown) and whose in-memory copies the tick must drop before its next
/// pass. The tick owns `MetricsState` and teardown runs elsewhere, so the
/// handoff is this set: a label reused right after a teardown must start
/// from the floor, not inherit the dead fleet's watermark or "already
/// compacted" marks.
static FORGOTTEN: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashSet::new()));

/// Ask the tick to drop every in-memory trace of `fleet_key`.
pub fn forget_fleet(fleet_key: &str) {
    FORGOTTEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(fleet_key.to_string());
}

/// Drop the in-memory state of every forgotten fleet key (start of a tick).
fn drain_forgotten(state: &mut MetricsState) {
    let keys: Vec<String> = FORGOTTEN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain()
        .collect();
    for key in keys {
        state.watermark.remove(&key);
        state.compacted.remove(&key);
        state.last_cpu.remove(&key);
        state.attempted.retain(|(slug, _)| slug != &key);
        state.ingest_backoff.retain(|(slug, _), _| slug != &key);
    }
}

#[cfg(test)]
mod forget_tests {
    use super::*;

    /// A torn-down environment's in-memory marks are dropped before the next
    /// pass, so a label reused in the same process starts from the floor
    /// instead of inheriting the dead fleet's watermark and "already
    /// compacted" hour. Other fleets keep theirs.
    #[test]
    fn forgetting_a_fleet_drops_only_its_in_memory_marks() {
        let gone = "forget-test-app.feature";
        let kept = "forget-test-app";
        let mut state = new_state();
        for key in [gone, kept] {
            state.watermark.insert(key.to_string(), 42);
            state
                .compacted
                .insert(key.to_string(), "2026/10/22/01".to_string());
            state.last_cpu.insert(key.to_string(), (1, 1));
            state
                .attempted
                .insert((key.to_string(), "2026/10/22/02".to_string()));
            state
                .ingest_backoff
                .insert((key.to_string(), 7), std::time::Instant::now());
        }
        forget_fleet(gone);
        drain_forgotten(&mut state);
        assert!(!state.watermark.contains_key(gone));
        assert!(!state.compacted.contains_key(gone));
        assert!(!state.last_cpu.contains_key(gone));
        assert!(state.attempted.iter().all(|(slug, _)| slug != gone));
        assert!(state.ingest_backoff.keys().all(|(slug, _)| slug != gone));
        assert_eq!(state.watermark.get(kept), Some(&42));
        assert!(state.compacted.contains_key(kept));
        assert!(state.attempted.iter().any(|(slug, _)| slug == kept));
        // Drained once: a second pass forgets nothing more.
        state.watermark.insert(gone.to_string(), 7);
        drain_forgotten(&mut state);
        assert_eq!(state.watermark.get(gone), Some(&7));
    }
}

fn minute_bucket_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:00Z").to_string()
}

/// Current time as unix microseconds. Also used by endpoints that window the
/// ingested SQLite rings.
pub fn now_us() -> i64 {
    // Epoch-relative time via the loop_.rs pattern (chrono DateTime math,
    // num_milliseconds).
    // Static invariant: the epoch is a hard-coded RFC 3339 literal, so parsing never fails.
    let epoch = chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .expect("epoch literal");
    (Utc::now() - epoch).num_milliseconds() * 1000
}
