//! App observability.
//!
//! Errors and logs come from celld's OpenTelemetry (CELLD_OTEL=1, bucket
//! sink): each fleet writes Parquet spans and console lines into its fleet
//! bucket under `telemetry/{traces,logs}/...`, and the runner decodes them
//! itself (`otel`) — no collector service and no CLI subprocess.
//!
//! CPU time celld executes code: OTel has no metrics signal yet (spans carry
//! durations), so CPU is sampled from `/proc/<celld-pid>/stat` (+ descendants)
//! — visible because the runner spawns celld in its own PID namespace.
//!
//! One ingest pass per tick, all live fleets (spec T3.1): the hour
//! directories of every fleet in the chunk are listed through the S3 client
//! and each object is decoded once, projected to the columns the Errors and
//! Logs tabs need. Every dashboard then serves from SQLite — no Parquet read
//! on any request path.
//!
//! Alongside that ingest, `hourly` keeps the hourly counters:
//! `metrics.app_hour`, one row per fleet per hour with requests, errors,
//! p50/p95 latency, memory and CPU. Requests/errors/latency come from the
//! edge access log (the one request sample that is not Parquet), memory from
//! each fleet's cgroup leaf, CPU from the `/proc` sampler.

use std::collections::{HashMap, HashSet};

use chrono::Utc;

use crate::host::errors;

mod compact;
mod cpu;
pub mod hourly;
mod ingest;
mod otel;
mod parquet_io;
mod plan;
mod tick;

pub use cpu::otel_env;
pub use tick::tick;

pub struct MetricsState {
    last_cpu: HashMap<String, (u64, u64)>, // slug -> (utime, stime) in ticks
    watermark: HashMap<String, i64>,       // slug -> last consumed start_unix_us
    /// slug -> per-hour durable compaction state (`yyyy/mm/dd/hh`), loaded
    /// from `metric_compaction` at boot (spec T3.5). Progress is per hour, so
    /// a failed fold can never be skipped by a later success.
    compacted: HashMap<String, compact::CompactionState>,
    /// Last ingest pass: the telemetry read runs at most once per
    /// `cfg.otel_flush_ms` (spec T3.4), not every reconcile tick.
    last_ingest: Option<std::time::Instant>,
    /// Trace id → edge request, from the access log; a span ingested before
    /// its line was tailed stores its occurrence pending, and the tail
    /// backfills the row when the line lands (host/errors.rs).
    requests: errors::RequestIndex,
    /// The pending replay request this pass already rewound into `watermark`,
    /// identified by its unique `requested_at`. The request row outlives it
    /// until every fleet catches up, so this stops a later pass from
    /// rewinding an already-progressing fleet back to the floor.
    replay: ReplayState,
    /// (slug, chunk start) → retry time after that fleet failed an ingest
    /// pass. A broken fleet is skipped until then: it neither holds the other
    /// fleets (the shared pass falls back per fleet) nor spins every tick.
    ingest_backoff: HashMap<(String, i64), std::time::Instant>,
    tick: u64,
}

/// One fleet's ingest position, derived from the two maps the tick keeps.
/// `BackedOff` still carries the watermark to resume from: a failure never
/// moves it.
///
/// stateDiagram-v2
///   [*] --> Never
///   Never --> At: first chunk committed
///   At --> At: chunk committed
///   At --> BackedOff: chunk failed
///   BackedOff --> At: retry window elapsed and a chunk commits
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IngestCursor {
    Never,
    At {
        after_us: i64,
    },
    BackedOff {
        after_us: i64,
        retry_at: std::time::Instant,
    },
}

impl IngestCursor {
    pub(super) fn after_us(self) -> Option<i64> {
        match self {
            Self::Never => None,
            Self::At { after_us } | Self::BackedOff { after_us, .. } => Some(after_us),
        }
    }

    pub(super) fn backing_off(self, now: std::time::Instant) -> bool {
        matches!(self, Self::BackedOff { retry_at, .. } if retry_at > now)
    }
}

impl MetricsState {
    /// The fleet's ingest cursor. At most one chunk per fleet is backed off,
    /// so the first entry for the slug is the cursor's retry instant.
    pub(super) fn ingest_cursor(&self, slug: &str) -> IngestCursor {
        let after_us = self.watermark.get(slug).copied();
        let retry_at = self
            .ingest_backoff
            .iter()
            .find(|((backed_off, _), _)| backed_off == slug)
            .map(|(_, at)| *at);
        match (after_us, retry_at) {
            (after, Some(retry_at)) => IngestCursor::BackedOff {
                after_us: after.unwrap_or(0),
                retry_at,
            },
            (Some(after_us), None) => IngestCursor::At { after_us },
            (None, None) => IngestCursor::Never,
        }
    }
}

/// Progress through the single pending replay request (`main.telemetry_replay`).
/// The request is identified by its unique `requested_at` token, so clearing
/// the row can only settle *that* request: a replay queued while the tick was
/// reading must survive.
///
/// stateDiagram-v2
///   [*] --> Idle
///   Idle --> Rewound: RequestSeen(id)
///   Rewound --> Rewound: RequestSeen(same id)
///   Rewound --> Rewound: RequestSeen(new id) — rewind again
///   Rewound --> Idle: Cleared(id)
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(super) enum ReplayState {
    #[default]
    Idle,
    Rewound {
        request: String,
    },
}

impl ReplayState {
    /// The request has not been rewound yet: the watermarks must move to its
    /// floor.
    pub(super) fn needs_rewind(&self, request: &str) -> bool {
        match self {
            Self::Idle => true,
            Self::Rewound { request: seen } => seen != request,
        }
    }

    /// Record the rewind so later passes do not repeat it.
    pub(super) fn rewound(self, request: &str) -> Self {
        Self::Rewound {
            request: request.to_string(),
        }
    }

    /// The row was deleted by *our* conditional clear: settle. A clear that
    /// removed a different (newer) request leaves the machine untouched, so
    /// the next pass rewinds it.
    pub(super) fn cleared(self, request: &str) -> Self {
        match self {
            Self::Rewound { request: seen } if seen == request => Self::Idle,
            other => other,
        }
    }
}

pub fn new_state() -> MetricsState {
    MetricsState {
        last_cpu: HashMap::new(),
        watermark: HashMap::new(),
        compacted: HashMap::new(),
        last_ingest: None,
        requests: errors::RequestIndex::default(),
        replay: ReplayState::Idle,
        ingest_backoff: HashMap::new(),
        tick: 0,
    }
}

/// Restore the persisted per-hour compaction marks into fresh state (boot
/// only). Every row in `metric_compaction` is an hour that folded, so a hole
/// left by an old failure is visible and gets retried.
pub fn set_compacted(state: &mut MetricsState, marks: HashMap<String, Vec<String>>) {
    state.compacted = marks
        .into_iter()
        .map(|(slug, hours)| (slug, compact::CompactionState::restored(hours)))
        .collect();
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
        state.ingest_backoff.retain(|(slug, _), _| slug != &key);
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
            state.compacted.insert(
                key.to_string(),
                compact::CompactionState::restored(["2026/10/22/01".to_string()]),
            );
            state.last_cpu.insert(key.to_string(), (1, 1));

            state
                .ingest_backoff
                .insert((key.to_string(), 7), std::time::Instant::now());
        }
        forget_fleet(gone);
        drain_forgotten(&mut state);
        assert!(!state.watermark.contains_key(gone));
        assert!(!state.compacted.contains_key(gone));
        assert!(!state.last_cpu.contains_key(gone));
        assert!(state.ingest_backoff.keys().all(|(slug, _)| slug != gone));
        assert_eq!(state.watermark.get(kept), Some(&42));
        assert!(state.compacted.contains_key(kept));
        // Drained once: a second pass forgets nothing more.
        state.watermark.insert(gone.to_string(), 7);
        drain_forgotten(&mut state);
        assert_eq!(state.watermark.get(gone), Some(&7));
    }
}
