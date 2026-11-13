//! The DuckDB-free telemetry read: the two result sets the Errors and Logs
//! tabs still need, decoded straight from celld's Parquet objects.
//!
//! The old ingest was one DuckDB query unioning four tagged sets. The minute
//! counters (tag 1) and hourly span stats (tag 2) are gone with their API —
//! requests/errors/latency/CPU come from the access-log tail and the hourly
//! counters ([`super::hourly`]) — so only two sets remain:
//!
//! 1. **newest log lines** per fleet (`time_unix_us` in the chunk window,
//!    `ERROR `/`WARN ` put back in front of the body, at most
//!    [`LOG_ROWS_PER_CHUNK`] newest per fleet), and
//! 2. **failed-span groups** per fleet and hour (`NOT ok`, non-empty `error`,
//!    unwrapped `rejected:` prefix, counted per distinct trace so a Durable
//!    Object failure reported on a cell span and its parent counts once, at
//!    most [`TOP_ERROR_GROUPS`] groups per fleet).
//!
//! The window, the fleet key, the canonical-file rule (an hour directory with
//! a `compacted.parquet` is read from that file alone), the top-200 rule and
//! the newest-N cap are all the same as the old query's, so an upgrade that
//! already has watermarks and compacted hours reads exactly the rows it used
//! to.
//!
//! # Bounded failed-span aggregation
//!
//! The old tag 4 aggregated the whole window inside DuckDB, with a
//! `memory_limit` and a spill directory. The reader runs on the runner's own
//! heap, so it keeps the same *result* with a bounded working set instead:
//!
//! - Groups are keyed by `(hour, error)` anyway, so one **event hour** is
//!   aggregated at a time and finalized as soon as no later object can carry
//!   a span of that hour. celld partitions objects by *flush* hour
//!   (`telemetry::object_key`), so an object in directory `H` only holds
//!   events stamped at or before the flush instant; a flush that straddles
//!   the boundary lands in `H + 1` with events still stamped in `H`. An event
//!   hour is therefore final once the *following* directory has been read.
//!   An empty directory hour (a quiet fleet) defers that finalisation, so the
//!   next non-empty directory can absorb spans stamped in the skipped hour and
//!   the one before it: at most three hours' groups can be live at any moment.
//!   (A span flushed
//!   more than an hour after it started — a request held open across the
//!   boundary, e.g. a long SSE stream — would be folded into a second row for
//!   its hour instead of the old query's single one. The error tables sum
//!   both by `(hour, fingerprint)`, so the hour's count is unchanged; only
//!   such a span's own row split is visible, and only inside a catch-up
//!   chunk whose window still contains its start.)
//! - Each group stores its distinct trace ids compactly: the 32-hex id is
//!   decoded to `[u8; 16]` (16 bytes inline in the set instead of a `String`'s
//!   24-byte header plus a heap allocation). An id that is not 32 hex chars
//!   falls back to the string, so a foreign object still counts exactly.
//! - A group that exceeds [`MAX_TRACES_PER_GROUP`] distinct ids stops storing
//!   ids (the span aggregates — name, cell, first/last, latest trace — stay
//!   exact) and logs one warning. This is the hard memory ceiling: the old
//!   `HashSet<String>` for one hot error string grew with the window (~8.6M
//!   ids for a 100 span/s loop over 24 h), which is what put the runner at
//!   risk; the ceiling makes that bounded and keeps the group.
//! - Finalized hours feed a 200-entry min-heap instead of a full row list, so
//!   the top-200 rule keeps the same groups with O(200) memory no matter how
//!   many hours or distinct errors the chunk holds. The tie-break is the old
//!   `ORDER BY count(DISTINCT trace_id) DESC` made total: higher distinct
//!   count wins, then the lexicographically smaller error text, then the
//!   earlier first sighting.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};

use bytes::Bytes;
use parquet::file::reader::FileReader;

use crate::config::Config;
use crate::host::errors;
use crate::host::s3;

use super::ingest::IngestRows;
use super::parquet_io::{self, Fetched};
use super::plan::{telemetry_hours, telemetry_prefix};

/// Log rows one chunk returns per fleet. The ring keeps the newest 2,000 (and
/// 24 h), so older lines would be pruned anyway: capping the read bounds a
/// day-long catch-up chunk's memory while leaving the ring's contents exact
/// (the newest 2,000 are always inside the newest 5,000). Error occurrences
/// take their trace context from these same rows.
const LOG_ROWS_PER_CHUNK: usize = 5000;

/// Failed-span groups one fleet may name per chunk: the old query's
/// `QUALIFY row_number() … ORDER BY count(DISTINCT trace_id) DESC <= 200`.
const TOP_ERROR_GROUPS: usize = 200;

/// Distinct trace ids one `(fleet, hour, error)` group stores. A hot loop
/// stores one id per span: at 100 failed spans/s that is ~360k ids per hour
/// (a 24 h chunk used to hold ~8.6M `String`s ≈ 1 GB on a 2 GB box). With
/// `[u8; 16]` ids a set costs ~20 bytes per entry (16 payload + hashbrown's
/// load factor), so this ceiling is ~20 MB per saturated group, and at most
/// three hours are live while a chunk is read — a small fraction of the 2 GB
/// the runner shares with its fleets. It takes >278 spans/s of one identical
/// error to saturate it, i.e. only the pathological case the old query would
/// have made the runner OOM on.
const MAX_TRACES_PER_GROUP: usize = 1_000_000;

/// Columns the log read needs. `severity_text` is absent from pre-0.6.1
/// objects — the projection then simply omits it and the body is stored as-is,
/// exactly like the old query's `CASE WHEN severity_text IN (…)`.
const LOG_COLUMNS: &[&str] = &["time_unix_us", "severity_text", "body", "trace_id"];

/// Columns the failed-span read needs.
const SPAN_COLUMNS: &[&str] = &["name", "start_unix_us", "ok", "error", "trace_id", "cell"];

/// Every log line and failed-span group one chunk names, across its fleets.
pub(super) async fn ingest_all(
    cfg: &Config,
    bounds: &[(String, i64, i64)],
) -> anyhow::Result<IngestRows> {
    let mut out = IngestRows::empty();
    for (slug, from, until) in bounds {
        out.logs.extend(read_logs(cfg, slug, *from, *until).await?);
        out.errors
            .extend(read_errors(cfg, slug, *from, *until).await?);
    }
    Ok(out)
}

/// The canonical files of one fleet's chunk, grouped by the hour directory
/// they were flushed in, in ascending hour order. For each hour directory the
/// window touches and each node under the fleet's kind prefix, the
/// canonical-file rule applies. This is the listing equivalent of the old
/// `glob(...)` + `compacted_dirs` SQL: a directory with a `compacted.parquet`
/// is read from that file alone, because compaction deletes the sources after
/// proving the copy — an interrupted delete must not count the same spans
/// twice.
async fn chunk_hours(
    cfg: &Config,
    slug: &str,
    kind: &str,
    from_us: i64,
    to_us: i64,
) -> anyhow::Result<Vec<(String, Vec<String>)>> {
    let root = format!("{}/telemetry/{kind}/", telemetry_prefix(slug));
    let (_, nodes) = s3::s3_list_dir(cfg, &cfg.s3_bucket, &root).await?;
    let mut out = Vec::new();
    for hour in telemetry_hours(cfg, from_us, to_us) {
        let mut files = Vec::new();
        for node in &nodes {
            let dir = format!("{node}{hour}/");
            let (keys, _) = s3::s3_list_dir(cfg, &cfg.s3_bucket, &dir).await?;
            files.extend(canonical_files(&dir, keys));
        }
        if !files.is_empty() {
            out.push((hour, files));
        }
    }
    Ok(out)
}

/// Keep only the canonical file(s) of one hour directory.
fn canonical_files(dir: &str, keys: Vec<String>) -> Vec<String> {
    let target = format!("{dir}compacted.parquet");
    let mut sources: Vec<String> = keys
        .into_iter()
        .filter(|key| key.ends_with(".parquet"))
        .collect();
    if sources.iter().any(|key| key == &target) {
        return vec![target];
    }
    sources.sort();
    sources
}

/// One log line before the newest-N cap and the empty-body filter.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct LogLine {
    ts_us: i64,
    body: String,
    trace_id: String,
}

/// One object's decode result: a corrupt, foreign or unsupported-codec object
/// is skipped with a warning (its key and the reason, never a signed URL) so
/// it cannot fail the fleet's chunk — and hold its watermark — forever. Only
/// the decoder's own error on a complete body reaches this; a missing object
/// is handled by the caller as an idle file, and a `spawn_blocking` join
/// failure (a decoder panic) fails the chunk before the call.
fn decoded_or_skipped<T>(key: &str, kind: &str, decoded: anyhow::Result<T>) -> Option<T> {
    match decoded {
        Ok(value) => Some(value),
        Err(error) => {
            tracing::warn!(
                file = %key,
                kind = %kind,
                error = %error,
                "telemetry object skipped: decode failed"
            );
            None
        }
    }
}

/// The newest [`LOG_ROWS_PER_CHUNK`] lines of one fleet's chunk.
async fn read_logs(
    cfg: &Config,
    slug: &str,
    from_us: i64,
    until_us: i64,
) -> anyhow::Result<Vec<errors::LogRow>> {
    let mut newest: BinaryHeap<std::cmp::Reverse<(i64, u64, LogLine)>> = BinaryHeap::new();
    let mut seq = 0_u64;
    for (_, keys) in chunk_hours(cfg, slug, "logs", from_us, until_us).await? {
        for key in keys {
            let body = match parquet_io::fetch(cfg, &key).await? {
                Fetched::Body(body) => body,
                Fetched::Missing => continue,
                Fetched::TooLarge(size) => {
                    tracing::warn!(
                        file = %key,
                        bytes = size,
                        cap = parquet_io::MAX_OBJECT_BYTES,
                        "telemetry log object skipped: over the decode cap"
                    );
                    continue;
                }
            };
            // Parquet decode is CPU work: keep it off the async runtime, like
            // the compaction fold. Each object decodes into its own bounded
            // heap, so a corrupt object leaves nothing half-merged behind.
            // A join error is a decoder panic — a bug, not a corrupt object —
            // so it fails the fleet's chunk (the watermark is held and the
            // chunk retried) instead of silently dropping the object.
            let decoded =
                tokio::task::spawn_blocking(move || decode_log_object(body, from_us, until_us))
                    .await
                    .map_err(|e| anyhow::anyhow!("telemetry log decode task: {e}"))?;
            let Some(local) = decoded_or_skipped(&key, "logs", decoded) else {
                continue;
            };
            for std::cmp::Reverse((ts_us, _, line)) in local {
                seq += 1;
                newest.push(std::cmp::Reverse((ts_us, seq, line)));
                if newest.len() > LOG_ROWS_PER_CHUNK {
                    newest.pop();
                }
            }
        }
    }
    Ok(newest
        .into_iter()
        .map(|std::cmp::Reverse((_, _, line))| line)
        .filter(|line| !line.body.is_empty())
        .map(|line| errors::LogRow {
            slug: slug.to_string(),
            ts_us: line.ts_us,
            body: line.body,
            trace_id: line.trace_id,
        })
        .collect())
}

/// Decode one log object into its own bounded newest-N heap. Blocking: the
/// caller runs it on a blocking task and merges the heap only on success.
fn decode_log_object(
    body: Bytes,
    from_us: i64,
    until_us: i64,
) -> anyhow::Result<BinaryHeap<std::cmp::Reverse<(i64, u64, LogLine)>>> {
    let mut newest: BinaryHeap<std::cmp::Reverse<(i64, u64, LogLine)>> = BinaryHeap::new();
    let mut seq = 0_u64;
    let reader = parquet_io::open(body)?;
    let Some(projection) = parquet_io::project(
        reader
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema(),
        LOG_COLUMNS,
    )?
    else {
        return Ok(newest);
    };
    for row in parquet::record::reader::RowIter::from_file(Some(projection), &reader)?
        .with_batch_size(8192)
    {
        let row = row?;
        let mut ts_us = 0;
        let mut severity = None;
        let mut text = None;
        let mut trace = String::new();
        for (name, field) in row.get_column_iter() {
            match name.as_str() {
                "time_unix_us" => ts_us = parquet_io::long(field).unwrap_or_default(),
                "severity_text" => severity = parquet_io::text(field).map(str::to_string),
                "body" => text = parquet_io::text(field).map(str::to_string),
                "trace_id" => trace = parquet_io::text(field).unwrap_or_default().to_string(),
                _ => {}
            }
        }
        // The old SQL applied its 5,000-row cap before dropping NULL bodies,
        // so a NULL body consumed a slot; skipping it here is unreachable with
        // celld output (`body` is required) and is the intended difference.
        let Some(body) = text else { continue };
        if ts_us < from_us || ts_us >= until_us {
            continue;
        }
        // celld 0.6.1+ stores only the message and puts the level in
        // `severity_text`; the ring stores the console form, so the level goes
        // back in front — the text `errors::parse_log_error` reads.
        let body = match severity.as_deref() {
            Some(level @ ("ERROR" | "WARN")) => format!("{level} {body}"),
            _ => body,
        };
        seq += 1;
        let line = LogLine {
            ts_us,
            body,
            trace_id: trace,
        };
        // Oldest first, so the heap's minimum is the row to evict. The
        // sequence number keeps equal timestamps deterministic (the old
        // `row_number()` tie order was arbitrary).
        newest.push(std::cmp::Reverse((line.ts_us, seq, line)));
        if newest.len() > LOG_ROWS_PER_CHUNK {
            newest.pop();
        }
    }
    Ok(newest)
}

/// The distinct trace ids of one group, bounded and compact.
///
/// celld writes trace ids as 32 lowercase hex chars, so the common case is
/// `[u8; 16]`: the set stores the 16 bytes inline instead of a `String`
/// (24-byte header + heap allocation + the 32 bytes of text). An id that is
/// not 32 hex chars goes into `text` unchanged — the old query counted
/// whatever the column held, so a foreign object must not be dropped.
#[derive(Default)]
struct TraceIds {
    hex: HashSet<[u8; 16]>,
    text: HashSet<String>,
    len: usize,
    /// The ceiling was reached: further ids are not stored (and not counted).
    saturated: bool,
}

impl TraceIds {
    /// Store `id` unless the group already holds `limit` distinct ids.
    /// Returns whether the id was newly stored.
    fn insert(&mut self, id: &str, limit: usize) -> bool {
        match trace_bytes(id) {
            Some(bytes) => self.insert_bytes(bytes, limit),
            None => self.insert_text(id.to_string(), limit),
        }
    }

    fn insert_bytes(&mut self, id: [u8; 16], limit: usize) -> bool {
        if self.len >= limit {
            self.saturated = true;
            return false;
        }
        if self.hex.insert(id) {
            self.len += 1;
            true
        } else {
            false
        }
    }

    fn insert_text(&mut self, id: String, limit: usize) -> bool {
        if self.len >= limit {
            self.saturated = true;
            return false;
        }
        if self.text.insert(id) {
            self.len += 1;
            true
        } else {
            false
        }
    }

    /// Merge another object's set in, honouring the same ceiling. Returns true
    /// when the set just saturated.
    fn absorb(&mut self, other: TraceIds, limit: usize) -> bool {
        let was_saturated = self.saturated;
        for id in other.hex {
            self.insert_bytes(id, limit);
        }
        for id in other.text {
            self.insert_text(id, limit);
        }
        !was_saturated && self.saturated
    }

    fn len(&self) -> usize {
        self.len
    }
}

/// A 32-hex-character trace id as its 16 bytes; `None` for anything else.
fn trace_bytes(id: &str) -> Option<[u8; 16]> {
    let text = id.as_bytes();
    if text.len() != 32 {
        return None;
    }
    let mut out = [0_u8; 16];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = (hex_nibble(text[index * 2])? << 4) | hex_nibble(text[index * 2 + 1])?;
    }
    Some(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// One failed-span group per (fleet, hour, unwrapped error text), exactly the
/// aggregation the old tag 4 did.
struct Group {
    name: String,
    /// The latest span of the group: `arg_max(name, start_unix_us)`.
    best_start: i64,
    /// `arg_max(trace_id, start_unix_us)`: DuckDB's `arg_max` skips NULL
    /// arguments, so this is the trace id of the latest span that *had* one.
    trace_id: String,
    trace_start: Option<i64>,
    /// `max(cell)`: lexicographic, empty when every span lacked one.
    cell: String,
    first_us: i64,
    last_us: i64,
    /// Distinct non-NULL traces, so a DO failure on both the cell span and its
    /// parent counts once. `count(DISTINCT trace_id)` ignores NULL, so a span
    /// with no trace id contributes nothing here.
    traces: TraceIds,
}

impl Group {
    fn new(start_us: i64, name: String, trace_id: Option<String>, cell: Option<&str>) -> Self {
        let mut traces = TraceIds::default();
        let mut trace_out = String::new();
        let mut trace_start = None;
        if let Some(id) = trace_id {
            traces.insert(&id, MAX_TRACES_PER_GROUP);
            trace_out = id;
            trace_start = Some(start_us);
        }
        Self {
            name,
            best_start: start_us,
            trace_id: trace_out,
            trace_start,
            cell: cell.unwrap_or_default().to_string(),
            first_us: start_us,
            last_us: start_us,
            traces,
        }
    }

    /// Fold one failed span in. Returns true when the trace-id set just hit
    /// its ceiling, so the caller logs it once.
    fn push(
        &mut self,
        start_us: i64,
        name: String,
        trace_id: Option<String>,
        cell: Option<&str>,
    ) -> bool {
        let was_saturated = self.traces.saturated;
        if let Some(id) = &trace_id {
            self.traces.insert(id, MAX_TRACES_PER_GROUP);
        }
        if start_us >= self.best_start {
            self.best_start = start_us;
            self.name = name;
        }
        if let Some(id) = trace_id {
            if self.trace_start.is_none_or(|at| start_us >= at) {
                self.trace_start = Some(start_us);
                self.trace_id = id;
            }
        }
        if let Some(cell) = cell {
            if cell > self.cell.as_str() {
                self.cell = cell.to_string();
            }
        }
        self.first_us = self.first_us.min(start_us);
        self.last_us = self.last_us.max(start_us);
        !was_saturated && self.traces.saturated
    }

    /// Merge another object's group for the same `(hour, error)`. Returns true
    /// when the trace-id set just hit its ceiling.
    fn absorb(&mut self, other: Group) -> bool {
        let Group {
            name,
            best_start,
            trace_id,
            trace_start,
            cell,
            first_us,
            last_us,
            traces,
        } = other;
        let saturated = self.traces.absorb(traces, MAX_TRACES_PER_GROUP);
        // `arg_max` ties are arbitrary in DuckDB; keeping the earlier object's
        // value on a tie keeps this merge deterministic.
        if best_start > self.best_start {
            self.best_start = best_start;
            self.name = name;
        }
        match (self.trace_start, trace_start) {
            (None, Some(_)) => {
                self.trace_start = trace_start;
                self.trace_id = trace_id;
            }
            (Some(mine), Some(theirs)) if theirs > mine => {
                self.trace_start = trace_start;
                self.trace_id = trace_id;
            }
            _ => {}
        }
        if cell > self.cell {
            self.cell = cell;
        }
        self.first_us = self.first_us.min(first_us);
        self.last_us = self.last_us.max(last_us);
        saturated
    }
}

/// Merge one object's per-hour groups into the chunk's open hours.
fn absorb_hours(
    open: &mut HashMap<String, HourGroups>,
    decoded: HashMap<String, HourGroups>,
    slug: &str,
) {
    for (hour, incoming) in decoded {
        let target = open.entry(hour).or_default();
        for (error, group) in incoming.groups {
            match target.groups.get_mut(&error) {
                Some(existing) => {
                    if existing.absorb(group) {
                        tracing::warn!(
                            fleet = %slug,
                            error = %error,
                            cap = MAX_TRACES_PER_GROUP,
                            "failed-span group reached the distinct-trace ceiling; its count stops at the cap"
                        );
                    }
                }
                None => {
                    target.groups.insert(error, group);
                }
            }
        }
    }
}

/// The failed-span groups of one event hour, keyed by unwrapped error text.
#[derive(Default)]
struct HourGroups {
    groups: HashMap<String, Group>,
}

/// A group competing for the chunk's top-[`TOP_ERROR_GROUPS`]. `Ord` ranks the
/// *worst* candidate greatest, so the heap's `pop` drops the group the old
/// `ORDER BY count(DISTINCT trace_id) DESC` dropped first: fewer distinct
/// traces, then the lexicographically larger error text, then the later first
/// sighting. `(hour, error)` is unique and `first_us` falls inside its hour,
/// so this order is total and the kept set is deterministic.
struct Candidate(errors::SpanErrorRow);

impl PartialEq for Candidate {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Candidate {}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Candidate {
    fn cmp(&self, other: &Self) -> Ordering {
        let (mine, theirs) = (&self.0, &other.0);
        theirs
            .count
            .cmp(&mine.count)
            .then_with(|| mine.error.cmp(&theirs.error))
            .then_with(|| theirs.first_us.cmp(&mine.first_us))
    }
}

/// The best [`TOP_ERROR_GROUPS`] finalized groups of a chunk.
struct TopGroups {
    limit: usize,
    worst: BinaryHeap<Candidate>,
}

impl TopGroups {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            worst: BinaryHeap::with_capacity(limit.saturating_add(1)),
        }
    }

    fn offer(&mut self, row: errors::SpanErrorRow) {
        self.worst.push(Candidate(row));
        if self.worst.len() > self.limit {
            self.worst.pop();
        }
    }

    /// The kept groups, best first — the old `ORDER BY count DESC`.
    fn finish(self) -> Vec<errors::SpanErrorRow> {
        let mut rows: Vec<errors::SpanErrorRow> = self
            .worst
            .into_iter()
            .map(|candidate| candidate.0)
            .collect();
        rows.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.error.cmp(&b.error))
                .then_with(|| a.first_us.cmp(&b.first_us))
        });
        rows
    }
}

/// The failed-span groups of one fleet's chunk, highest distinct-trace counts
/// first, capped at [`TOP_ERROR_GROUPS`] — the old tag 4 result.
async fn read_errors(
    cfg: &Config,
    slug: &str,
    from_us: i64,
    until_us: i64,
) -> anyhow::Result<Vec<errors::SpanErrorRow>> {
    let mut open: HashMap<String, HourGroups> = HashMap::new();
    let mut top = TopGroups::new(TOP_ERROR_GROUPS);
    for (dir_hour, keys) in chunk_hours(cfg, slug, "traces", from_us, until_us).await? {
        for key in keys {
            let body = match parquet_io::fetch(cfg, &key).await? {
                Fetched::Body(body) => body,
                Fetched::Missing => continue,
                Fetched::TooLarge(size) => {
                    tracing::warn!(
                        file = %key,
                        bytes = size,
                        cap = parquet_io::MAX_OBJECT_BYTES,
                        "telemetry trace object skipped: over the decode cap"
                    );
                    continue;
                }
            };
            let fleet = slug.to_string();
            // Each object decodes into its own map, so a corrupt object leaves
            // nothing half-merged behind. A join error is a decoder panic and
            // fails the chunk (see the log loop above).
            let decoded = tokio::task::spawn_blocking(move || {
                decode_trace_object(body, from_us, until_us, &fleet)
            })
            .await
            .map_err(|e| anyhow::anyhow!("telemetry trace decode task: {e}"))?;
            let Some(local) = decoded_or_skipped(&key, "traces", decoded) else {
                continue;
            };
            absorb_hours(&mut open, local, slug);
        }
        // An object in directory `H` holds only events stamped at or before
        // its flush instant, so every event hour below `H` is complete once
        // this directory has been read. Events stamped in `H` itself can still
        // arrive from the next directory's flush, so `H` stays open.
        if let Some(bucket) = dir_hour_bucket(&dir_hour) {
            finalize_before(&mut open, &bucket, &mut top, slug);
        }
    }
    let mut remaining: Vec<String> = open.keys().cloned().collect();
    remaining.sort_unstable();
    for hour in remaining {
        if let Some(groups) = open.remove(&hour) {
            finalize_hour(groups, &hour, &mut top, slug);
        }
    }
    Ok(top.finish())
}

/// The hour bucket of a `yyyy/mm/dd/hh` partition directory, in the same
/// `%Y-%m-%dT%H:00:00Z` form [`hour_bucket`] gives a span.
fn dir_hour_bucket(dir_hour: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(&format!("{dir_hour}:00:00"), "%Y/%m/%d/%H:%M:%S")
        .ok()
        .map(|at| hour_bucket(at.and_utc().timestamp_micros()))
}

/// Finalize every open event hour older than `before` into the top heap.
fn finalize_before(
    open: &mut HashMap<String, HourGroups>,
    before: &str,
    top: &mut TopGroups,
    slug: &str,
) {
    let mut done: Vec<String> = open
        .keys()
        .filter(|hour| hour.as_str() < before)
        .cloned()
        .collect();
    done.sort_unstable();
    for hour in done {
        if let Some(groups) = open.remove(&hour) {
            finalize_hour(groups, &hour, top, slug);
        }
    }
}

/// Turn one hour's groups into candidate rows and drop their trace sets.
fn finalize_hour(groups: HourGroups, _hour: &str, top: &mut TopGroups, slug: &str) {
    for (error, group) in groups.groups {
        top.offer(errors::SpanErrorRow {
            slug: slug.to_string(),
            error,
            name: group.name,
            cell: group.cell,
            trace_id: group.trace_id,
            count: group.traces.len() as i64,
            first_us: group.first_us,
            last_us: group.last_us,
        });
    }
}

/// Decode one trace object into its own per-event-hour groups. Blocking: the
/// caller runs it on a blocking task and merges only on success.
fn decode_trace_object(
    body: Bytes,
    from_us: i64,
    until_us: i64,
    slug: &str,
) -> anyhow::Result<HashMap<String, HourGroups>> {
    let mut hours: HashMap<String, HourGroups> = HashMap::new();
    let unwrap = rejected_prefix();
    let reader = parquet_io::open(body)?;
    let Some(projection) = parquet_io::project(
        reader
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema(),
        SPAN_COLUMNS,
    )?
    else {
        return Ok(hours);
    };
    for row in parquet::record::reader::RowIter::from_file(Some(projection), &reader)?
        .with_batch_size(8192)
    {
        let row = row?;
        let mut name = String::new();
        let mut start_us = 0;
        let mut ok = true;
        let mut error = None;
        let mut trace = None;
        let mut cell = None;
        for (column, field) in row.get_column_iter() {
            match column.as_str() {
                "name" => name = parquet_io::text(field).unwrap_or_default().to_string(),
                "start_unix_us" => {
                    start_us = parquet_io::long(field).unwrap_or_default();
                }
                "ok" => ok = parquet_io::boolean(field).unwrap_or(true),
                "error" => error = parquet_io::text(field),
                // A NULL trace id stays NULL: `count(DISTINCT …)` and
                // `arg_max(…)` both ignore it (an empty string would not).
                "trace_id" => trace = parquet_io::text(field).map(str::to_string),
                "cell" => cell = parquet_io::text(field),
                _ => {}
            }
        }
        if ok || start_us < from_us || start_us >= until_us {
            continue;
        }
        let Some(error) = error else { continue };
        let error = unwrap.replace(error, "").into_owned();
        if error.is_empty() {
            continue;
        }
        let hour = hour_bucket(start_us);
        let groups = &mut hours.entry(hour).or_default().groups;
        match groups.get_mut(&error) {
            Some(group) => {
                if group.push(start_us, name, trace, cell) {
                    tracing::warn!(
                        fleet = %slug,
                        error = %error,
                        cap = MAX_TRACES_PER_GROUP,
                        "failed-span group reached the distinct-trace ceiling; its count stops at the cap"
                    );
                }
            }
            None => {
                groups.insert(error, Group::new(start_us, name, trace, cell));
            }
        }
    }
    Ok(hours)
}

/// `strftime('%Y-%m-%dT%H:00:00Z', …)`: the hour bucket the error writers key
/// on.
fn hour_bucket(us: i64) -> String {
    chrono::DateTime::from_timestamp_micros(us.max(0))
        .map(|at| at.format("%Y-%m-%dT%H:00:00Z").to_string())
        .unwrap_or_default()
}

/// The old query's `regexp_replace(error, '^rejected: (Error: rejected: )*',
/// '')`: celld wraps a rejected handler's error text, and the same failure
/// must land in one group whether it was reported on the cell span or its
/// parent.
fn rejected_prefix() -> &'static regex::Regex {
    use std::sync::LazyLock;
    static REJECTED: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^rejected: (Error: rejected: )*")
            .expect("static rejected-prefix pattern")
    });
    &REJECTED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_files_prefers_a_compacted_directory() {
        let dir = "b/fleets/a/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        // A compacted hour is read from that file alone, even when an
        // interrupted delete left sources behind.
        assert_eq!(
            canonical_files(dir, vec![format!("{dir}a.parquet"), target.clone()]),
            vec![target.clone()]
        );
        // An hour without one reads every source, in stable order.
        assert_eq!(
            canonical_files(
                dir,
                vec![format!("{dir}b.parquet"), format!("{dir}a.parquet")]
            ),
            vec![format!("{dir}a.parquet"), format!("{dir}b.parquet")]
        );
        // Compaction's staging object never ends in `.parquet`, and a
        // non-parquet key is never read.
        assert_eq!(
            canonical_files(dir, vec![format!("{dir}a.parquet.tmp")]),
            Vec::<String>::new()
        );
    }

    #[test]
    fn rejected_prefix_matches_the_old_sql() {
        let unwrap = rejected_prefix();
        assert_eq!(
            unwrap.replace("rejected: TypeError: boom", ""),
            "TypeError: boom"
        );
        assert_eq!(
            unwrap.replace("rejected: Error: rejected: TypeError: boom", ""),
            "TypeError: boom"
        );
        assert_eq!(
            unwrap.replace("rejected: Error: rejected: Error: rejected: X", ""),
            "X"
        );
        // The loop does not eat a bare second `rejected:` — same as DuckDB.
        assert_eq!(unwrap.replace("rejected: rejected: X", ""), "rejected: X");
        assert_eq!(unwrap.replace("plain", ""), "plain");
    }

    #[test]
    fn trace_ids_are_stored_as_their_sixteen_bytes() {
        assert_eq!(
            trace_bytes("6594a4344ae64659a4fab28b5fe59094"),
            Some([
                0x65, 0x94, 0xa4, 0x34, 0x4a, 0xe6, 0x46, 0x59, 0xa4, 0xfa, 0xb2, 0x8b, 0x5f, 0xe5,
                0x90, 0x94
            ])
        );
        // Upper case is the same id.
        assert_eq!(
            trace_bytes("6594A4344AE64659A4FAB28B5FE59094"),
            trace_bytes("6594a4344ae64659a4fab28b5fe59094")
        );
        // Anything that is not exactly 32 hex chars falls back to the string.
        assert_eq!(trace_bytes("t0"), None);
        assert_eq!(trace_bytes(&"a".repeat(31)), None);
        assert_eq!(trace_bytes(&"a".repeat(33)), None);
        assert_eq!(trace_bytes(&format!("{}g", "a".repeat(31))), None);
        // The whole point of the representation.
        assert_eq!(std::mem::size_of::<[u8; 16]>(), 16);
    }

    /// One error string thrown once per span: the group stores a bounded
    /// number of ids instead of growing with the chunk. At 100 failed
    /// spans/s a 24 h window is ~8.6M distinct ids, which the old
    /// `HashSet<String>` kept (~1 GB); the ceiling keeps the pass inside the
    /// runner's budget.
    #[test]
    fn a_hot_error_group_stores_a_bounded_number_of_trace_ids() {
        let mut traces = TraceIds::default();
        for index in 0..(MAX_TRACES_PER_GROUP + 4096) {
            traces.insert(&format!("{index:032x}"), MAX_TRACES_PER_GROUP);
        }
        assert_eq!(traces.len(), MAX_TRACES_PER_GROUP);
        assert!(traces.saturated);
        assert_eq!(traces.hex.len(), MAX_TRACES_PER_GROUP);
        assert!(traces.text.is_empty());
        // The bounded set is ~16 bytes per id plus hashbrown overhead, i.e.
        // tens of megabytes — not the gigabytes a String set reached.
        assert!(traces.len() * std::mem::size_of::<[u8; 16]>() < parquet_io::MAX_OBJECT_BYTES);
    }

    #[test]
    fn log_cap_keeps_the_newest_rows() {
        // The heap is (ts, seq, line); Reverse makes the oldest the minimum.
        let mut newest: BinaryHeap<std::cmp::Reverse<(i64, u64, LogLine)>> = BinaryHeap::new();
        for (seq, ts) in [(1_u64, 100_i64), (2, 300), (3, 200)] {
            newest.push(std::cmp::Reverse((
                ts,
                seq,
                LogLine {
                    ts_us: ts,
                    body: format!("line-{ts}"),
                    trace_id: String::new(),
                },
            )));
            if newest.len() > 2 {
                newest.pop();
            }
        }
        let mut kept: Vec<i64> = newest
            .into_iter()
            .map(|std::cmp::Reverse((ts, _, _))| ts)
            .collect();
        kept.sort_unstable();
        assert_eq!(kept, vec![200, 300]);
    }

    /// One trace object: `errors[i]` becomes a failed span at
    /// `start_us + i` with trace id `t{i}`.
    fn trace_object(start_us: i64, errors: &[String]) -> Bytes {
        let rows: Vec<(String, Option<String>)> = errors
            .iter()
            .enumerate()
            .map(|(index, error)| (error.clone(), Some(format!("t{index}"))))
            .collect();
        trace_object_rows(start_us, &rows)
    }

    /// One trace object from `(error, trace_id)` rows; a `None` trace id is a
    /// NULL, which celld never writes but the old SQL handled. The schema is
    /// the subset of celld's `celld_span` the failed-span read projects, so
    /// `project()` sees exactly what a real object carries.
    fn trace_object_rows(start_us: i64, rows: &[(String, Option<String>)]) -> Bytes {
        use parquet::basic::Compression;
        use parquet::data_type::{BoolType, ByteArray, ByteArrayType, Int64Type};
        use parquet::file::properties::WriterProperties;
        use parquet::file::writer::SerializedFileWriter;
        use parquet::schema::parser::parse_message_type;
        use std::sync::Arc;

        const SCHEMA: &str = "
        message celld_span {
          required binary name (STRING);
          required int64 start_unix_us;
          required boolean ok;
          optional binary error (STRING);
          optional binary trace_id (STRING);
          optional binary cell (STRING);
        }";
        let schema = Arc::new(parse_message_type(SCHEMA).expect("schema"));
        let properties = Arc::new(
            WriterProperties::builder()
                .set_compression(Compression::UNCOMPRESSED)
                .build(),
        );
        let mut writer = SerializedFileWriter::new(Vec::new(), schema, properties).expect("writer");
        let mut group = writer.next_row_group().expect("row group");
        let text = |value: &str| ByteArray::from(value.as_bytes().to_vec());
        let count = rows.len();

        let mut column = group.next_column().expect("name").expect("column");
        column
            .typed::<ByteArrayType>()
            .write_batch(
                &(0..count).map(|_| text("celld.fetch")).collect::<Vec<_>>(),
                None,
                None,
            )
            .expect("name");
        column.close().expect("name close");

        let mut column = group.next_column().expect("start").expect("column");
        column
            .typed::<Int64Type>()
            .write_batch(
                &(0..count).map(|i| start_us + i as i64).collect::<Vec<_>>(),
                None,
                None,
            )
            .expect("start");
        column.close().expect("start close");

        let mut column = group.next_column().expect("ok").expect("column");
        column
            .typed::<BoolType>()
            .write_batch(&vec![false; count], None, None)
            .expect("ok");
        column.close().expect("ok close");

        let mut column = group.next_column().expect("error").expect("column");
        column
            .typed::<ByteArrayType>()
            .write_batch(
                &rows
                    .iter()
                    .map(|(error, _)| text(error))
                    .collect::<Vec<_>>(),
                Some(&vec![1_i16; count]),
                None,
            )
            .expect("error");
        column.close().expect("error close");

        let mut column = group.next_column().expect("trace").expect("column");
        let mut traces = Vec::new();
        let mut trace_levels = Vec::with_capacity(count);
        for (_, trace) in rows {
            match trace {
                Some(id) => {
                    trace_levels.push(1_i16);
                    traces.push(text(id));
                }
                None => trace_levels.push(0),
            }
        }
        column
            .typed::<ByteArrayType>()
            .write_batch(&traces, Some(&trace_levels), None)
            .expect("trace");
        column.close().expect("trace close");

        let mut column = group.next_column().expect("cell").expect("column");
        column
            .typed::<ByteArrayType>()
            .write_batch(&Vec::new(), Some(&vec![0_i16; count]), None)
            .expect("cell");
        column.close().expect("cell close");

        group.close().expect("row group close");
        Bytes::from(writer.into_inner().expect("file bytes"))
    }

    /// The old `QUALIFY row_number() … ORDER BY count(DISTINCT trace_id) DESC`
    /// kept the 200 largest groups of the whole window, so a burst of distinct
    /// errors in an older hour could never hide a later hour's failures. A
    /// first-seen group cap (the pre-review reader admitted 8,192 keys and
    /// dropped every key seen afterwards) did exactly that: this burst fills
    /// the old cap, and the newest hour's group must still survive.
    #[test]
    fn a_burst_in_an_old_hour_never_hides_the_newest_hours_groups() {
        let from_us = 1_767_225_600_000_000_i64; // 2026-01-01T00:00:00Z
        let hour = 3_600_000_000_i64;
        let until_us = from_us + 2 * hour;
        let mut open: HashMap<String, HourGroups> = HashMap::new();
        let mut top = TopGroups::new(TOP_ERROR_GROUPS);
        // The oldest hour alone exceeds the old 8,192-key cap, one distinct
        // error per span.
        let burst: Vec<String> = (0..8_193).map(|i| format!("TypeError: boom {i}")).collect();
        let local = decode_trace_object(trace_object(from_us, &burst), from_us, until_us, "app")
            .expect("old hour");
        absorb_hours(&mut open, local, "app");
        finalize_before(&mut open, &hour_bucket(from_us + hour), &mut top, "app");
        assert!(open.is_empty(), "the old hour's sets are dropped");
        // Three failures in the newest hour: a count the top-200 rule keeps
        // whatever the tie-break.
        let local = decode_trace_object(
            trace_object(
                from_us + hour,
                &[
                    "SyntaxError: late".to_string(),
                    "SyntaxError: late".to_string(),
                    "SyntaxError: late".to_string(),
                ],
            ),
            from_us,
            until_us,
            "app",
        )
        .expect("new hour");
        absorb_hours(&mut open, local, "app");
        finalize_before(&mut open, &hour_bucket(from_us + 2 * hour), &mut top, "app");
        let rows = top.finish();
        assert_eq!(rows.len(), TOP_ERROR_GROUPS, "the top-200 cap holds");
        assert_eq!(
            rows[0].error, "SyntaxError: late",
            "the newest hour's group is kept"
        );
        assert_eq!(rows[0].count, 3);
    }

    /// `count(DISTINCT trace_id)` and `arg_max(trace_id, …)` ignore NULL, so
    /// a span without a trace id neither counts nor can win the latest-trace
    /// pick. The all-NULL group keeps the old row shape (count 0, empty
    /// trace). celld never writes a NULL trace id, but the old SQL handled it
    /// and the reader must not invent a distinct `""`.
    #[test]
    fn null_trace_ids_neither_count_nor_win_arg_max() {
        let from_us = 1_767_225_600_000_000_i64;
        let rows = vec![
            (
                "rejected: mixed-trace-err".to_string(),
                Some("tm".to_string()),
            ),
            // The NULL span is the later one: `arg_max` must still pick `tm`.
            ("rejected: mixed-trace-err".to_string(), None),
            ("rejected: null-trace-err".to_string(), None),
            ("rejected: null-trace-err".to_string(), None),
        ];
        let mut open: HashMap<String, HourGroups> = HashMap::new();
        let local = decode_trace_object(trace_object_rows(from_us, &rows), 0, i64::MAX, "app")
            .expect("decode");
        absorb_hours(&mut open, local, "app");
        let mut top = TopGroups::new(TOP_ERROR_GROUPS);
        let mut hours: Vec<String> = open.keys().cloned().collect();
        hours.sort_unstable();
        for hour in hours {
            if let Some(groups) = open.remove(&hour) {
                finalize_hour(groups, &hour, &mut top, "app");
            }
        }
        let rows = top.finish();
        assert_eq!(rows.len(), 2);
        let mixed = rows
            .iter()
            .find(|row| row.error == "mixed-trace-err")
            .expect("mixed group");
        assert_eq!(mixed.count, 1, "the NULL does not add a distinct trace");
        assert_eq!(mixed.trace_id, "tm", "arg_max skips the NULL trace");
        let null = rows
            .iter()
            .find(|row| row.error == "null-trace-err")
            .expect("null group");
        assert_eq!(null.count, 0);
        assert_eq!(null.trace_id, "");
    }

    /// A corrupt or foreign object is skipped, never fatal: the fleet's
    /// watermark advances past it instead of holding the chunk forever.
    #[test]
    fn a_corrupt_object_is_skipped_not_fatal() {
        let corrupt = decoded_or_skipped::<()>(
            "fleets/a/telemetry/logs/node/x.parquet",
            "logs",
            Err(anyhow::anyhow!("parquet open: bad magic")),
        );
        assert!(corrupt.is_none());
        assert_eq!(decoded_or_skipped("k", "logs", Ok(7)), Some(7));
        // The skip path is reachable: a non-Parquet body fails to open.
        let error = match decode_trace_object(
            Bytes::from_static(b"not a parquet file"),
            0,
            i64::MAX,
            "app",
        ) {
            Ok(_) => panic!("a foreign object cannot decode"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("parquet open"), "{error}");
    }

    #[test]
    fn the_top_cap_drops_the_smallest_groups_and_orders_the_rest() {
        let mut top = TopGroups::new(2);
        for (error, count, first) in [
            ("alpha", 5, 10),
            ("beta", 9, 20),
            ("gamma", 5, 5),
            ("delta", 1, 1),
        ] {
            top.offer(errors::SpanErrorRow {
                slug: "app".to_string(),
                error: error.to_string(),
                name: "celld.fetch".to_string(),
                cell: String::new(),
                trace_id: String::new(),
                count,
                first_us: first,
                last_us: first,
            });
        }
        let rows = top.finish();
        // Highest count first; ties broken by the smaller error text.
        assert_eq!(
            rows.iter()
                .map(|row| row.error.as_str())
                .collect::<Vec<_>>(),
            vec!["beta", "alpha"]
        );
    }

    /// The canonical `*.parquet` files directly under `dir`: the same rule the
    /// bucket read applies (a `compacted.parquet` shadows its sources), sorted
    /// by name like an S3 listing.
    fn parquet_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let prefix = format!("{}/", dir.display());
        let keys: Vec<String> = std::fs::read_dir(dir)
            .expect("fixture directory")
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "parquet"))
            .map(|entry| format!("{prefix}{}", entry.file_name().to_string_lossy()))
            .collect();
        canonical_files(&prefix, keys)
            .into_iter()
            .map(|key| std::path::PathBuf::from(key.rsplit('/').next().unwrap_or(&key)))
            .map(|name| dir.join(name))
            .collect()
    }

    fn decode_logs_in(
        dir: &std::path::Path,
        slug: &str,
        from_us: i64,
        until_us: i64,
    ) -> Vec<errors::LogRow> {
        let mut newest = BinaryHeap::new();
        let mut seq = 0_u64;
        for path in parquet_files(dir) {
            let body = Bytes::from(std::fs::read(&path).expect("fixture object"));
            let local = decode_log_object(body, from_us, until_us).expect("decode logs");
            for std::cmp::Reverse((ts_us, _, line)) in local {
                seq += 1;
                newest.push(std::cmp::Reverse((ts_us, seq, line)));
                if newest.len() > LOG_ROWS_PER_CHUNK {
                    newest.pop();
                }
            }
        }
        let mut rows: Vec<errors::LogRow> = newest
            .into_iter()
            .map(|std::cmp::Reverse((_, _, line))| line)
            .filter(|line| !line.body.is_empty())
            .map(|line| errors::LogRow {
                slug: slug.to_string(),
                ts_us: line.ts_us,
                body: line.body,
                trace_id: line.trace_id,
            })
            .collect();
        rows.sort_by(|a, b| {
            a.ts_us
                .cmp(&b.ts_us)
                .then_with(|| a.body.cmp(&b.body))
                .then_with(|| a.trace_id.cmp(&b.trace_id))
        });
        rows
    }

    fn decode_errors_in(
        dir: &std::path::Path,
        slug: &str,
        from_us: i64,
        until_us: i64,
    ) -> Vec<errors::SpanErrorRow> {
        let mut open: HashMap<String, HourGroups> = HashMap::new();
        let mut top = TopGroups::new(TOP_ERROR_GROUPS);
        for path in parquet_files(dir) {
            let body = Bytes::from(std::fs::read(&path).expect("fixture object"));
            let local = decode_trace_object(body, from_us, until_us, slug).expect("decode traces");
            absorb_hours(&mut open, local, slug);
        }
        let mut remaining: Vec<String> = open.keys().cloned().collect();
        remaining.sort_unstable();
        for hour in remaining {
            if let Some(groups) = open.remove(&hour) {
                finalize_hour(groups, &hour, &mut top, slug);
            }
        }
        top.finish()
    }

    /// The permanent differential: real celld objects with the rows the old
    /// DuckDB tag-3 and tag-4 query produced over exactly those files. Every
    /// case carries an `expected.json` generated from that query; a celld
    /// schema bump that breaks the decode fails here before it reaches a
    /// dashboard. `folded` is the compaction output this crate writes
    /// (`compact::fold_files`), so the new writer's union-by-name file is read
    /// back against the old query — the other compacted case was written by
    /// DuckDB.
    #[test]
    fn real_celld_fixtures_match_the_duckdb_rows() {
        for case in ["prod", "env", "compacted", "folded"] {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/otel")
                .join(case);
            let expected: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(root.join("expected.json"))
                    .unwrap_or_else(|e| panic!("{case} expected rows: {e}")),
            )
            .expect("expected json");
            let slug = expected["slug"].as_str().expect("slug").to_string();
            let from_us = expected["from"].as_i64().expect("from");
            let until_us = expected["until"].as_i64().expect("until");
            let logs: Vec<serde_json::Value> =
                decode_logs_in(&root.join("logs"), &slug, from_us, until_us)
                    .into_iter()
                    .map(|row| {
                        serde_json::json!({
                            "ts": row.ts_us,
                            "body": row.body,
                            "trace": row.trace_id,
                        })
                    })
                    .collect();
            assert_eq!(
                serde_json::Value::Array(logs),
                expected["logs"],
                "{case}: log rows"
            );
            let errors: Vec<serde_json::Value> =
                decode_errors_in(&root.join("traces"), &slug, from_us, until_us)
                    .into_iter()
                    .map(|row| {
                        serde_json::json!({
                            "error": row.error,
                            "name": row.name,
                            "cell": row.cell,
                            "trace": row.trace_id,
                            "count": row.count,
                            "first": row.first_us,
                            "last": row.last_us,
                        })
                    })
                    .collect();
            assert_eq!(
                serde_json::Value::Array(errors),
                expected["errors"],
                "{case}: failed-span groups"
            );
        }
    }

    /// A compacted hour is read from `compacted.parquet` alone: the fixture
    /// case keeps a leftover source beside it, and decoding the source
    /// directly yields a row the compacted canonical file does not.
    #[test]
    fn a_compacted_fixture_shadows_its_leftover_source() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/otel/compacted/logs");
        let files = parquet_files(&dir);
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(
            files[0]
                .file_name()
                .is_some_and(|name| name == "compacted.parquet"),
            "{files:?}"
        );
    }

    #[test]
    fn hours_are_utc_and_floored() {
        assert_eq!(hour_bucket(1_767_225_600_000_000), "2026-01-01T00:00:00Z");
        assert_eq!(
            hour_bucket(1_767_225_600_000_000 + 3_599_999_999),
            "2026-01-01T00:00:00Z"
        );
        assert_eq!(
            hour_bucket(1_767_225_600_000_000 + 3_600_000_000),
            "2026-01-01T01:00:00Z"
        );
        // A partition directory names the same bucket its spans fall in.
        assert_eq!(
            dir_hour_bucket("2026/01/01/00").as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(dir_hour_bucket("not-an-hour"), None);
    }
}
