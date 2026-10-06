// App observability.
//
// Requests + latency come from celld's OpenTelemetry (CELLD_OTEL=1, bucket
// sink): each fleet writes Parquet spans into its fleet bucket under
// `telemetry/traces/...`, and we aggregate them with the DuckDB CLI — the
// documented query path, no collector service.
//
// CPU time celld executes code: OTel has no metrics signal yet (spans carry
// durations), so CPU is sampled from `/proc/<celld-pid>/stat` (+ descendants)
// — visible because the runner spawns celld in its own PID namespace.
//
// One ingest pass per tick, all live fleets (spec T3.1): a single DuckDB
// invocation over the hour globs of every live fleet reads each Parquet file
// once and yields minute buckets, hourly span stats and new log lines at
// once. Every dashboard then serves from SQLite — no DuckDB on any request
// path.
use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::accesslog;
use crate::host::cmd;
use crate::host::errors;
use crate::host::stats;
use crate::host::supervisor::ProcMap;
use crate::models::{App, AppStatus};

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

fn minute_bucket_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:00Z").to_string()
}

/// Current time as unix microseconds. Also used by endpoints that window the
/// ingested SQLite rings.
pub fn now_us() -> i64 {
    // Epoch-relative time via the loop_.rs pattern (chrono DateTime math,
    // num_milliseconds).
    let epoch = chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .expect("epoch literal");
    (Utc::now() - epoch).num_milliseconds() * 1000
}
// Dashboards read ingested SQLite (see `tick`); nothing queries Parquet
// outside ingest and the hourly compaction below.

// ---------------------------------------------------------------------------
// CPU sampling from /proc (UTIME + STIME, subtree-wise)
// ---------------------------------------------------------------------------

fn read_proc_stat(pid: u32) -> Option<(u64, u64)> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = s.rfind(')')?;
    let rest = s[close + 2..].trim();
    // After "pid (comm) ": 0=state 1=ppid 2=pgrp 3=session 4=tty 5=tpgid
    // 6=flags 7=minflt 8=cminflt 9=majflt 10=cmajflt 11=utime 12=stime
    let mut it = rest.split_whitespace();
    for _ in 0..11 {
        it.next()?;
    }
    let utime: u64 = it.next()?.parse().ok()?;
    let stime: u64 = it.next()?.parse().ok()?;
    Some((utime, stime))
}

fn proc_children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .map(|s| {
            s.split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// celld may run isolates in descendants — sum the process subtree.
fn proc_cpu_recursive(pid: u32, depth: u32) -> (u64, u64) {
    let mut total = read_proc_stat(pid).unwrap_or((0, 0));
    if depth == 0 {
        return total;
    }
    for child in proc_children(pid) {
        let (u, s) = proc_cpu_recursive(child, depth - 1);
        total.0 += u;
        total.1 += s;
    }
    total
}

/// CPU samples for the tenant fleets plus the control node. The control
/// celld is not in the `procs` map (it is a `children::Supervised`, not an
/// app), so its pid is handed in by the caller.
fn sample_cpu(procs: &ProcMap, control_pid: u32) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    if control_pid != 0 {
        out.insert(
            crate::host::control::SLUG.to_string(),
            proc_cpu_recursive(control_pid, 3),
        );
    }
    let Ok(map) = procs.try_lock() else {
        return out;
    };
    for (slug, child) in map.iter() {
        if let Some(pid) = child.id() {
            out.insert(slug.clone(), proc_cpu_recursive(pid, 3));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// DuckDB aggregation over celld telemetry Parquet in the fleet bucket
// ---------------------------------------------------------------------------

fn endpoint_host(endpoint: &str) -> String {
    endpoint
        .strip_prefix("http://")
        .or(endpoint.strip_prefix("https://"))
        .unwrap_or(endpoint)
        .to_string()
}

/// Coerce a DuckDB JSON field to i64 — the -json writer emits BIGINT sums as
/// STRINGS ("51644") and small integers as numbers (4). Handle both.
fn json_i64(v: &serde_json::Value, key: &str) -> i64 {
    let path = format!("/{key}");
    let Some(f) = v.pointer(path.as_str()) else {
        return 0;
    };
    if let Some(n) = f.as_i64() {
        return n;
    }
    f.as_str().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0)
}

/// S3 connection options (PATH style, plain HTTP) as DuckDB SET statements —
/// no CREATE SECRET, so the -json output carries no DDL glue lines. The docs
/// prescribe exactly these two for an S3-compatible plain-HTTP endpoint.
fn s3_setup(cfg: &Config, query: &str) -> String {
    format!(
        "SET s3_region='{}'; SET s3_endpoint='{}'; SET s3_url_style='path'; \
         SET s3_access_key_id='{}'; SET s3_secret_access_key='{}'; SET s3_use_ssl=false; {}",
        cfg.aws_region,
        endpoint_host(&cfg.s3_endpoint),
        cfg.aws_access_key_id,
        cfg.aws_secret_access_key,
        query,
    )
}

/// Telemetry flush interval celld runs with (`CELLD_OTEL_FLUSH_MS`, from
/// `RUNNER_OTEL_FLUSH_MS`, spec T3.4). 30 s by default: short enough for
/// minute-bucket pricing, 6x fewer PUTs/files than the old 5 s, and only safe
/// because the runner also runs the documented compaction job. Dashboards lag
/// live traffic by up to ~40 s instead of ~15 s (accepted trade-off).
pub fn otel_flush_ms(cfg: &Config) -> u64 {
    cfg.otel_flush_ms.max(1000)
}

/// The celld telemetry environment every node runs with — tenant fleets
/// (`host::supervisor::ensure_fleet`) and the control fleet
/// (`main::supervise_control`) alike, so the bucket sink, the flush the ingest
/// cadence assumes and the retention the prune uses can never drift between
/// them. celld writes under `telemetry/` relative to its `--bucket`, so a
/// fleet's files land at `<bucket>/telemetry/...` (see
/// [`telemetry_prefix`] for what that prefix is per source).
pub fn otel_env(cfg: &Config) -> [(&'static str, String); 3] {
    [
        ("CELLD_OTEL", "1".to_string()),
        ("CELLD_OTEL_FLUSH_MS", cfg.otel_flush_ms.to_string()),
        (
            "CELLD_OTEL_RETENTION",
            format!("{}d", cfg.telemetry_retention_days),
        ),
    ]
}

/// Bucket prefix one telemetry source writes under. Tenant fleets use their
/// celld `--bucket` (`fleets/<slug>`); the control fleet's `--bucket` is
/// `control`, so its traces and logs land at `control/telemetry/...` — the
/// control prefix, never `fleets/_control`.
fn telemetry_prefix(slug: &str) -> String {
    if slug == crate::host::control::SLUG {
        "control".to_string()
    } else {
        format!("fleets/{slug}")
    }
}

/// How far behind the flush the ingest window stops. Derived as
/// `flush + 10 s` (spec T3.4): it must exceed the flush interval, or a late
/// file could land inside an already-counted minute.
pub fn agg_lag_us(cfg: &Config) -> i64 {
    otel_flush_ms(cfg) as i64 * 1000 + 10_000_000
}

/// Microsecond timestamp floored to its hour — the granularity the ingest
/// works in (celld partitions files by hour, and a chunk is whole hours plus
/// the partial hour the cutoff falls in).
fn floor_hour_us(us: i64) -> i64 {
    us.div_euclid(3_600_000_000) * 3_600_000_000
}

/// Hours of complete history one catch-up chunk names. Small enough to keep a
/// single DuckDB scan and its SQLite writes bounded; a 30-day backlog is ~30
/// chunks.
const CATCHUP_CHUNK_HOURS: i64 = 24;

/// Hour-chunks one ingest pass commits. Bounds how long an outage catch-up can
/// hold the reconcile loop: a pass runs once per flush interval (30 s by
/// default) and commits one chunk per fleet per iteration, so a 30-day gap
/// takes ~15 passes.
const MAX_CHUNKS_PER_PASS: usize = 2;

/// How long a fleet whose chunk failed waits before the runner retries it.
/// Long enough that a persistently broken fleet does not fail the shared pass
/// every tick, short enough that a transient S3/DuckDB error heals quickly.
const INGEST_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(120);

/// The watermark a fleet's next chunk should start from, or `None` when the
/// fleet has nothing to do this pass.
///
/// A live fleet (a running celld) always runs, including the partial current
/// hour. A stopped fleet is scanned only while a WHOLE hour before the cutoff
/// is still unprocessed: that drains its tail once the hour it stopped in
/// completes (within an hour), without re-reading a parked fleet's bucket
/// every pass forever. A fleet never ingested and not running has nothing to
/// read.
fn ingest_after(
    is_live: bool,
    replaying: bool,
    watermark: Option<i64>,
    cutoff_us: i64,
) -> Option<i64> {
    match watermark {
        Some(w) => {
            if !is_live && !replaying && floor_hour_us(w) >= floor_hour_us(cutoff_us) {
                None
            } else {
                Some(w)
            }
        }
        None if is_live || replaying => Some(floor_hour_us(cutoff_us)),
        None => None,
    }
}

/// Park a fleet until [`INGEST_RETRY_BACKOFF`] has passed since its last
/// failure on this chunk.
fn back_off_ingest(state: &mut MetricsState, slug: &str, from: i64) {
    state.ingest_backoff.insert(
        (slug.to_string(), from),
        std::time::Instant::now() + INGEST_RETRY_BACKOFF,
    );
}

fn ingest_backed_off(state: &MetricsState, slug: &str, from: i64) -> bool {
    state
        .ingest_backoff
        .get(&(slug.to_string(), from))
        .is_some_and(|at| *at > std::time::Instant::now())
}

/// Hour-aligned windows covering `[max(after_us, floor_us), cutoff_us)`, at
/// most `max_chunks` of them. Complete hours are `CATCHUP_CHUNK_HOURS` wide;
/// the hour the cutoff falls in is always last and may be partial (`until_us`
/// == cutoff_us). The ingest REPLACES every window it reads, so the tiling
/// only decides how much one DuckDB query touches — never what is counted.
fn plan_chunks(after_us: i64, cutoff_us: i64, floor_us: i64, max_chunks: usize) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    let mut start = floor_hour_us(after_us.max(floor_us));
    let complete_end = floor_hour_us(cutoff_us);
    while start < complete_end && out.len() < max_chunks {
        let end = (start + CATCHUP_CHUNK_HOURS * 3_600_000_000).min(complete_end);
        out.push((start, end));
        start = end;
    }
    if out.len() < max_chunks && start < cutoff_us {
        out.push((start, cutoff_us));
    }
    out
}

// Retention celld prunes telemetry at (`CELLD_OTEL_RETENTION`), and the bound
// on how many hour directories one catch-up query may name. One knob
// (RUNNER_TELEMETRY_RETENTION_DAYS, `cfg.telemetry_retention_days`); there is
// no const, so the env and the queries cannot drift apart.

/// Parquet globs for one fleet's telemetry over `[from_us, to_us]`. celld
/// partitions the files by node and by hour
/// (`telemetry/{kind}/<node>/<yyyy>/<mm>/<dd>/<hh>/<id>.parquet`), and DuckDB
/// opens every file a glob names — so a tick names only the hours its window
/// touches instead of the whole retention (a 10 s window names one or two
/// hour directories). The node stays a wildcard so history written by an
/// earlier node id still aggregates.
fn telemetry_globs(cfg: &Config, slug: &str, kind: &str, from_us: i64, to_us: i64) -> Vec<String> {
    let prefix = telemetry_prefix(slug);
    let Some(mut hour) = chrono::DateTime::from_timestamp_micros(from_us.max(0)) else {
        return vec![format!(
            "s3://{}/{prefix}/telemetry/{kind}/*/*/*/*/*/*.parquet",
            cfg.s3_bucket
        )];
    };
    let Some(last) = chrono::DateTime::from_timestamp_micros(to_us.max(0)) else {
        return Vec::new();
    };
    let floor = chrono::Utc::now() - chrono::Duration::days(cfg.telemetry_retention_days);
    if hour < floor {
        // Older than retention: celld has deleted those objects already.
        hour = floor;
    }
    // Truncate to the hour: the walk below steps whole hours, so starting
    // mid-hour would skip the trailing partial hour when a window crosses
    // a boundary (and its files would never aggregate — the watermark still
    // advances past them).
    let truncated = hour.timestamp().div_euclid(3600) * 3600;
    if let Some(t) = chrono::DateTime::from_timestamp_secs(truncated) {
        hour = t;
    }
    let mut globs = Vec::new();
    // Bound the expansion: callers pass narrow windows, but a stale
    // watermark after a long outage must not name thousands of hours.
    let max_hours = (cfg.telemetry_retention_days * 24 + 1) as usize;
    while hour <= last && globs.len() < max_hours {
        globs.push(format!(
            "s3://{}/{prefix}/telemetry/{kind}/*/{}/{}/{}/{}/*.parquet",
            cfg.s3_bucket,
            hour.format("%Y"),
            hour.format("%m"),
            hour.format("%d"),
            hour.format("%H"),
        ));
        let Some(next) = hour.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        hour = next;
    }
    globs
}

async fn duckdb_json(sql: &str, purpose: &str) -> anyhow::Result<String> {
    stats::count_duckdb(purpose);
    cmd::run_cmd(
        "/usr/local/bin/duckdb",
        &["-json", "-c", sql],
        None,
        &[],
        std::time::Duration::from_secs(30),
    )
    .await
}

/// True when duckdb failed only because the window has no parquet (idle):
/// a glob that matched nothing, or an expanded file list that came up empty.
/// The tick distinguishes this from a real error: idle completes the chunk
/// (there is nothing to read), a real error holds the watermark for a retry.
pub fn is_idle_telemetry_err(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains("No files found") || msg.contains("needs at least one file")
}

/// One hourly span-stat row: slug, hour, name, kind, n, ms, err, qwait.
pub type SpanRow = (String, String, String, i64, i64, i64, i64, i64);

/// Log rows a chunk may return per fleet. The ring keeps the newest 2,000 (and
/// 24 h), so older lines would be pruned anyway: dropping them in SQL bounds a
/// day-long catch-up chunk's memory and SQLite writes while leaving the ring's
/// contents exact (the newest 2,000 are always inside the newest
/// `LOG_ROWS_PER_CHUNK`). Error occurrences take their trace context from these
/// same rows.
const LOG_ROWS_PER_CHUNK: i64 = 5000;

/// The four tagged sets one ingest chunk returns: minute buckets, hourly span
/// stats, log lines, and failed-span groups.
#[derive(Clone)]
pub struct IngestRows {
    pub minutes: Vec<(String, String, i64, i64, i64)>, // slug, bucket, n, dur_us, err
    pub spans: Vec<SpanRow>,
    pub logs: Vec<errors::LogRow>,
    pub errors: Vec<errors::SpanErrorRow>,
}

impl IngestRows {
    fn empty() -> Self {
        IngestRows {
            minutes: Vec::new(),
            spans: Vec::new(),
            logs: Vec::new(),
            errors: Vec::new(),
        }
    }
}

fn json_str(v: &serde_json::Value, key: &str) -> String {
    let path = format!("/{key}");
    v.pointer(path.as_str())
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// SQL that builds a chunk's file list: expand the globs, then keep only the
/// canonical file of any hour directory that holds a `compacted.parquet`.
/// Compaction writes the compacted file, proves it with a HEAD, then deletes
/// the sources; if that delete is interrupted, a plain glob would match both
/// and count the same spans twice on the re-read.
fn canonical_file_list_sql(globs: &str) -> String {
    format!(
        "WITH listed AS ({globs}), \
              compacted_dirs AS ( \
                SELECT DISTINCT regexp_replace(file, '[^/]+$', '') AS dir \
                  FROM listed WHERE file LIKE '%/compacted.parquet') \
         SELECT coalesce(list(file), []) FROM listed \
          WHERE file LIKE '%/compacted.parquet' \
             OR regexp_replace(file, '[^/]+$', '') NOT IN (SELECT dir FROM compacted_dirs)"
    )
}

/// Split one hour directory's keys into `(already_compacted, foldable
/// sources)`. A compacted file is authoritative: every other key in its
/// directory is a leftover from an interrupted source delete.
fn compaction_plan(keys: &[String], target: &str) -> (bool, Vec<String>) {
    let has_target = keys.iter().any(|k| k == target);
    let sources = keys
        .iter()
        .filter(|k| k.as_str() != target)
        .cloned()
        .collect();
    (has_target, sources)
}

/// One ingest chunk over every fleet it names (spec T3.1): a SINGLE DuckDB
/// invocation whose query unions four tagged result sets —
/// 1. minute buckets for `celld.fetch` (requests, duration, errors),
/// 2. hourly span stats for every span name (counts, ms, errors, queue wait),
/// 3. new OTel log lines (timestamp, body, trace id),
/// 4. failed spans grouped by their unwrapped `error` text (host/errors.rs),
///    counted per distinct trace so a Durable Object failure — reported on
///    the cell span and again on its parent — counts once; capped at 200
///    groups per fleet per chunk.
///    The slug comes from the file path (`filename=true`: `fleets/<slug>/`
///    for a tenant fleet, the control prefix for the control fleet), and each
///    slug's exact `[from_us, until_us)` chunk
///    rides along in a `VALUES` bounds table, so windows stay exact per fleet
///    while every Parquet file is read once. Chunks are hour-aligned (whole
///    hours, then the partial current hour), which is what lets the writers
///    replace whole minute/span/hour buckets instead of accumulating them.
async fn ingest_all(cfg: &Config, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
    let mut out = IngestRows {
        minutes: Vec::new(),
        spans: Vec::new(),
        logs: Vec::new(),
        errors: Vec::new(),
    };
    if bounds.is_empty() {
        return Ok(out);
    }
    let mut traces = Vec::new();
    let mut logs = Vec::new();
    for (slug, from, until) in bounds {
        traces.extend(telemetry_globs(cfg, slug, "traces", *from, *until));
        logs.extend(telemetry_globs(cfg, slug, "logs", *from, *until));
    }
    if traces.is_empty() && logs.is_empty() {
        return Ok(out);
    }
    // Per-slug chunk bounds: the window stays exact per fleet inside the
    // shared scan. Slugs are runner-generated (`[a-z0-9-]`) — the replace
    // keeps a quote from ending the literal.
    let values = bounds
        .iter()
        .map(|(s, from, until)| format!("('{}', {from}, {until})", s.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    // Expand the globs before reading. celld writes no file for an empty
    // batch, so an hour without traffic (or without a console line) has no
    // match, and `read_parquet` fails the whole list on one empty glob: a
    // single quiet fleet turned every pass into "idle" and the watermark
    // skipped everyone's rows. `glob()` returns nothing instead of failing.
    // The bucket and slug ride in the glob, so escape it like `values`.
    let globs = traces
        .iter()
        .chain(logs.iter())
        .map(|g| format!("SELECT file FROM glob('{}')", g.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    // An hour directory holding a `compacted.parquet` is read from that file
    // alone: compaction writes the compacted file, proves it with a HEAD, then
    // deletes the sources; if that delete is interrupted both would otherwise
    // match the glob and the same spans would be counted twice on the re-read.
    let files = canonical_file_list_sql(&globs);
    // CAST to BIGINT: DuckDB `/` is floating division, and the -json writer
    // emits BIGINT sums as STRINGS and small integers as numbers — coerce at
    // the source, parse with `json_i64`. Tag 4's `err` is the error text with
    // celld's `rejected: ` / `Error: rejected: ` wrappers removed, so a cell
    // span and its parent land in one group (host/errors.rs strips the same).
    // Since celld 0.6.1 a log body carries only the message and the level is
    // `severity_text`; the ingest puts back the `ERROR `/`WARN ` prefix of
    // the console line, so stored logs and `errors::parse_log_error` read the
    // same text as 0.6.0's. The empty `UNION ALL BY NAME` arm declares every
    // column the query reads, so a pass with only trace files, only log
    // files, or only pre-0.6.1 logs (no severity column) still binds.
    let control_slug = crate::host::control::SLUG;
    let sql = s3_setup(
        cfg,
        &format!(
            "SET VARIABLE files = ({files}); \
             WITH files AS ( \
               SELECT CASE WHEN filename LIKE '%/control/telemetry/%' THEN '{control_slug}' \
                           ELSE regexp_extract(filename, 'fleets/([^/]+)/', 1) END AS slug, \
                      name, kind, start_unix_us, duration_us, ok, \
                      coalesce(queue_wait_us, 0) AS qwait, time_unix_us, \
                      CASE WHEN severity_text IN ('ERROR', 'WARN') \
                           THEN severity_text || ' ' || body ELSE body END AS body, \
                      trace_id, cell, \
                      regexp_replace(error, '^rejected: (Error: rejected: )*', '') AS err \
                 FROM (SELECT * FROM read_parquet(getvariable('files'), union_by_name = true, filename = true) \
                       UNION ALL BY NAME \
                       SELECT CAST(NULL AS VARCHAR) AS name, CAST(NULL AS BIGINT) AS kind, \
                              CAST(NULL AS BIGINT) AS start_unix_us, CAST(NULL AS BIGINT) AS duration_us, \
                              CAST(NULL AS BOOLEAN) AS ok, CAST(NULL AS BIGINT) AS queue_wait_us, \
                              CAST(NULL AS BIGINT) AS time_unix_us, CAST(NULL AS VARCHAR) AS severity_text, \
                              CAST(NULL AS VARCHAR) AS body, CAST(NULL AS VARCHAR) AS trace_id, \
                              CAST(NULL AS VARCHAR) AS cell, CAST(NULL AS VARCHAR) AS error \
                        WHERE false)), \
             bounds(slug, from_us, until_us) AS (VALUES {values}) \
             SELECT 1 AS tag, f.slug AS slug, \
                    strftime('%Y-%m-%dT%H:%M:00Z', to_timestamp(f.start_unix_us / 1000000)) AS bucket, \
                    CAST(NULL AS VARCHAR) AS name, CAST(0 AS BIGINT) AS kind, \
                    count(*) AS n, CAST(sum(f.duration_us) AS BIGINT) AS ms, \
                    sum(CASE WHEN NOT f.ok THEN 1 ELSE 0 END) AS e, \
                    CAST(0 AS BIGINT) AS q, CAST(0 AS BIGINT) AS ts, \
                    CAST(NULL AS VARCHAR) AS body, CAST(NULL AS VARCHAR) AS trace, \
                    CAST(NULL AS VARCHAR) AS cell, CAST(0 AS BIGINT) AS first_ts \
               FROM files f JOIN bounds b ON f.slug = b.slug \
              WHERE f.name = 'celld.fetch' \
                AND f.start_unix_us >= b.from_us AND f.start_unix_us < b.until_us \
              GROUP BY f.slug, bucket \
              UNION ALL \
             SELECT 2 AS tag, f.slug AS slug, \
                    strftime('%Y-%m-%dT%H:00:00Z', to_timestamp(f.start_unix_us / 1000000)) AS bucket, \
                    f.name AS name, f.kind AS kind, \
                    count(*) AS n, CAST(sum(f.duration_us) / 1000 AS BIGINT) AS ms, \
                    sum(CASE WHEN NOT f.ok THEN 1 ELSE 0 END) AS e, \
                    CAST(sum(f.qwait) / 1000 AS BIGINT) AS q, CAST(0 AS BIGINT) AS ts, \
                    CAST(NULL AS VARCHAR) AS body, CAST(NULL AS VARCHAR) AS trace, \
                    CAST(NULL AS VARCHAR) AS cell, CAST(0 AS BIGINT) AS first_ts \
               FROM files f JOIN bounds b ON f.slug = b.slug \
              WHERE f.start_unix_us >= b.from_us AND f.start_unix_us < b.until_us \
              GROUP BY f.slug, bucket, f.name, f.kind \
              UNION ALL \
             SELECT * FROM ( \
               SELECT 3 AS tag, f.slug AS slug, \
                      CAST(NULL AS VARCHAR) AS bucket, CAST(NULL AS VARCHAR) AS name, \
                      CAST(0 AS BIGINT) AS kind, CAST(0 AS BIGINT) AS n, \
                      CAST(0 AS BIGINT) AS ms, CAST(0 AS BIGINT) AS e, \
                      CAST(0 AS BIGINT) AS q, f.time_unix_us AS ts, f.body AS body, \
                      f.trace_id AS trace, CAST(NULL AS VARCHAR) AS cell, \
                      CAST(0 AS BIGINT) AS first_ts \
                 FROM files f JOIN bounds b ON f.slug = b.slug \
                WHERE f.time_unix_us >= b.from_us AND f.time_unix_us < b.until_us \
               QUALIFY row_number() OVER (PARTITION BY f.slug ORDER BY f.time_unix_us DESC) \
                       <= {LOG_ROWS_PER_CHUNK}) \
              UNION ALL \
             SELECT * FROM ( \
               SELECT 4 AS tag, f.slug AS slug, CAST(NULL AS VARCHAR) AS bucket, \
                      arg_max(f.name, f.start_unix_us) AS name, CAST(0 AS BIGINT) AS kind, \
                      count(DISTINCT f.trace_id) AS n, CAST(0 AS BIGINT) AS ms, \
                      CAST(0 AS BIGINT) AS e, CAST(0 AS BIGINT) AS q, \
                      max(f.start_unix_us) AS ts, f.err AS body, \
                      arg_max(f.trace_id, f.start_unix_us) AS trace, max(f.cell) AS cell, \
                      min(f.start_unix_us) AS first_ts \
                 FROM files f JOIN bounds b ON f.slug = b.slug \
                WHERE NOT f.ok AND f.err IS NOT NULL AND f.err <> '' \
                  AND f.start_unix_us >= b.from_us AND f.start_unix_us < b.until_us \
                GROUP BY f.slug, f.err, \
                         strftime('%Y-%m-%dT%H:00:00Z', to_timestamp(f.start_unix_us / 1000000)) \
               QUALIFY row_number() OVER (PARTITION BY f.slug ORDER BY count(DISTINCT f.trace_id) DESC) <= 200)",
        ),
    );
    let raw = match duckdb_json(&sql, "ingest").await {
        Ok(o) => o,
        Err(e) if is_idle_telemetry_err(&e) => return Ok(out),
        Err(e) => return Err(e),
    };
    if raw.trim().is_empty() || raw.trim() == "[]" {
        return Ok(out);
    }
    let v: serde_json::Value =
        serde_json::from_str(raw.trim()).map_err(|e| anyhow::anyhow!("duckdb json parse: {e}"))?;
    let Some(arr) = v.as_array() else {
        return Ok(out);
    };
    for obj in arr {
        let slug = json_str(obj, "slug");
        if slug.is_empty() {
            continue;
        }
        match json_i64(obj, "tag") {
            1 => {
                let bucket = json_str(obj, "bucket");
                if bucket.is_empty() {
                    continue;
                }
                out.minutes.push((
                    slug,
                    bucket,
                    json_i64(obj, "n"),
                    json_i64(obj, "ms"),
                    json_i64(obj, "e"),
                ));
            }
            2 => {
                let bucket = json_str(obj, "bucket");
                let name = json_str(obj, "name");
                if bucket.is_empty() || name.is_empty() {
                    continue;
                }
                out.spans.push((
                    slug,
                    bucket,
                    name,
                    json_i64(obj, "kind"),
                    json_i64(obj, "n"),
                    json_i64(obj, "ms"),
                    json_i64(obj, "e"),
                    json_i64(obj, "q"),
                ));
            }
            3 => {
                let body = json_str(obj, "body");
                if body.is_empty() {
                    continue;
                }
                out.logs.push(errors::LogRow {
                    slug,
                    ts_us: json_i64(obj, "ts"),
                    body,
                    trace_id: json_str(obj, "trace"),
                });
            }
            4 => {
                let error = json_str(obj, "body");
                if error.is_empty() {
                    continue;
                }
                out.errors.push(errors::SpanErrorRow {
                    slug,
                    error,
                    name: json_str(obj, "name"),
                    cell: json_str(obj, "cell"),
                    trace_id: json_str(obj, "trace"),
                    count: json_i64(obj, "n"),
                    first_us: json_i64(obj, "first_ts"),
                    last_us: json_i64(obj, "ts"),
                });
            }
            _ => {}
        }
    }
    Ok(out)
}

/// What a committed chunk changed: app ids whose dashboards must re-read, and
/// whether the log stream should wake.
struct ChunkWrites {
    touched: HashSet<String>,
    new_logs: bool,
}

/// Persist one ingest chunk with replace semantics, then report what the tick
/// still has to do. Every table is rewritten for the chunk's window: a re-read
/// — a retry after a failure, or a replay — leaves the same rows instead of
/// doubling them, which is exactly why the caller may advance the watermarks
/// only after this returns `Ok`.
async fn write_ingest_rows(
    pool: &SqlitePool,
    slug_id: &HashMap<String, String>,
    app_sha: &HashMap<String, String>,
    bounds: &[(String, i64, i64)],
    rows: IngestRows,
    requests: &errors::RequestIndex,
    prune_logs_before_us: i64,
) -> anyhow::Result<ChunkWrites> {
    let mut touched: HashSet<String> = HashSet::new();
    for (slug, bucket, n, dur_us, err_n) in rows.minutes {
        let Some(id) = slug_id.get(&slug) else {
            continue;
        };
        if n == 0 && err_n == 0 {
            continue;
        }
        db::replace_app_metric_usage(pool, id, &bucket, n, err_n, dur_us / 1000).await?;
        touched.insert(id.clone());
    }
    for (slug, hour, name, kind, n, ms, err, qwait) in rows.spans {
        let Some(id) = slug_id.get(&slug) else {
            continue;
        };
        if n == 0 && err == 0 {
            continue;
        }
        db::replace_span_stat(pool, id, &hour, &name, kind, n, ms, err, qwait).await?;
        touched.insert(id.clone());
    }
    // Errors before the log ring takes the rows: an occurrence keeps the log
    // lines of its own trace (host/errors.rs).
    touched
        .extend(errors::ingest(pool, slug_id, app_sha, &rows.errors, &rows.logs, requests).await?);
    // Replace each app's window in the log ring. The window is that app's
    // chunk; a slug appears at most once in `bounds`.
    let mut log_groups: HashMap<String, Vec<(i64, String)>> = HashMap::new();
    for row in rows.logs {
        log_groups
            .entry(row.slug)
            .or_default()
            .push((row.ts_us, row.body));
    }
    let mut new_logs = false;
    for (slug, mut log_rows) in log_groups {
        let Some(id) = slug_id.get(&slug) else {
            continue;
        };
        let Some((_, from, until)) = bounds.iter().find(|(s, _, _)| s == &slug) else {
            continue;
        };
        log_rows.sort_by_key(|(ts, _)| *ts);
        if log_rows.is_empty() {
            continue;
        }
        // A window entirely older than the 24 h ring would be written only to
        // be pruned in the same pass (a deep catch-up or replay); skip it.
        if *until <= prune_logs_before_us {
            continue;
        }
        db::replace_app_logs(pool, id, *from, *until, &log_rows).await?;
        // Bounded ring per app: last 24 h AND last 2,000 lines.
        let _ = db::prune_app_logs(pool, id, prune_logs_before_us, 2000).await;
        touched.insert(id.clone());
        new_logs = true;
    }
    Ok(ChunkWrites { touched, new_logs })
}

/// Persist one chunk, then advance and persist the fleets' watermarks. The
/// watermark moves only when every write succeeded: a failure returns `Err`
/// with the watermarks untouched, so the chunk is retried — exact, because the
/// writers replace. Kept as one call so the "failed pass never advances the
/// watermark" rule is testable without DuckDB.
async fn commit_chunk(
    pool: &SqlitePool,
    state: &mut MetricsState,
    slug_id: &HashMap<String, String>,
    app_sha: &HashMap<String, String>,
    bounds: &[(String, i64, i64)],
    rows: IngestRows,
    prune_logs_before_us: i64,
) -> anyhow::Result<ChunkWrites> {
    let writes = write_ingest_rows(
        pool,
        slug_id,
        app_sha,
        bounds,
        rows,
        &state.requests,
        prune_logs_before_us,
    )
    .await?;
    let advanced: Vec<(String, i64)> = bounds
        .iter()
        .map(|(slug, _, until)| (slug.clone(), *until))
        .collect();
    db::set_metric_watermarks(pool, &advanced).await?;
    for (slug, until) in &advanced {
        state.watermark.insert(slug.clone(), *until);
    }
    Ok(writes)
}

/// One DuckDB chunk pass. Abstracted so the fault-isolation policy — a broken
/// fleet must not hold the other fleets' watermarks — is testable without
/// DuckDB on the dev host.
trait ChunkPass {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows>;
}

struct DuckdbPass<'a>(&'a Config);

impl ChunkPass for DuckdbPass<'_> {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
        ingest_all(self.0, bounds).await
    }
}

/// One chunk's rows, per fleet group. A shared pass that fails is retried PER
/// FLEET, so a single broken fleet cannot hold every other fleet's watermark;
/// a fleet that then fails alone is reported as an error, and the caller backs
/// it off. "No files" stays a successful, empty chunk.
async fn collect_chunk_results<P: ChunkPass>(
    pass: &P,
    bounds: &[(String, i64, i64)],
) -> Vec<(Vec<(String, i64, i64)>, anyhow::Result<IngestRows>)> {
    match pass.pass(bounds).await {
        Ok(rows) => vec![(bounds.to_vec(), Ok(rows))],
        Err(e) if is_idle_telemetry_err(&e) => vec![(bounds.to_vec(), Ok(IngestRows::empty()))],
        Err(e) if bounds.len() == 1 => vec![(bounds.to_vec(), Err(e))],
        Err(e) => {
            tracing::warn!(
                error = %e,
                fleets = bounds.len(),
                "telemetry ingest failed; retrying per fleet"
            );
            let mut out = Vec::with_capacity(bounds.len());
            for bound in bounds {
                let one = std::slice::from_ref(bound);
                let result = match pass.pass(one).await {
                    Err(e) if is_idle_telemetry_err(&e) => Ok(IngestRows::empty()),
                    other => other,
                };
                out.push((vec![bound.clone()], result));
            }
            out
        }
    }
}

// ---------------------------------------------------------------------------
// Compaction (the documented companion to a short flush)
// ---------------------------------------------------------------------------

/// `yyyy/mm/dd/hh` for a timestamp, as celld partitions telemetry.
fn hour_dir(us: i64) -> String {
    chrono::DateTime::from_timestamp_micros(us.max(0))
        .map(|t| t.format("%Y/%m/%d/%H").to_string())
        .unwrap_or_default()
}

/// Rewrite the last completed hour of one fleet's telemetry into one zstd file
/// per node directory, exactly as the docs prescribe ("Run a compaction job on
/// a maintenance node... Run the job once an hour, for the hour that just
/// ended. Do not compact the current hour... Delete the source files after
/// DuckDB writes the compacted file"). celld never compacts its own files and
/// we flush every `otel_flush_ms`, so without this job DuckDB opens thousands
/// of tiny files per query and reads grow slow within hours.
///
/// Sources are deleted only after `head-object` proves the compacted file
/// exists, so a failed copy can never lose spans. The root comes from
/// [`telemetry_prefix`], so the control fleet's `control/telemetry/...` is
/// compacted exactly like a tenant fleet's.
async fn compact_fleet(cfg: &Config, slug: &str, hour: &str) -> anyhow::Result<usize> {
    let mut compacted = 0_usize;
    let prefix = telemetry_prefix(slug);
    for (kind, sort_col) in [("traces", "start_unix_us"), ("logs", "time_unix_us")] {
        let root = format!("{prefix}/telemetry/{kind}/");
        let listing = cmd::s3_list_delimited(cfg, &cfg.s3_bucket, &root).await?;
        let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
        let nodes: Vec<String> = v
            .pointer("/CommonPrefixes")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.pointer("/Prefix").and_then(|x| x.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for node in nodes {
            let dir = format!("{node}{hour}/");
            let listing = cmd::s3_list_delimited(cfg, &cfg.s3_bucket, &dir).await?;
            let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
            let keys: Vec<String> = v
                .pointer("/Contents")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.pointer("/Key").and_then(|x| x.as_str()))
                        .filter(|k| k.ends_with(".parquet"))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let target = format!("{dir}compacted.parquet");
            // A previous run wrote the compacted file but its source delete
            // did not finish. The compacted file was copied from every source,
            // and the ingest reads an hour from the compacted file alone when
            // it exists, so dropping the leftovers is safe and leaves the
            // directory in its stable one-file shape.
            let (has_target, sources) = compaction_plan(&keys, &target);
            if has_target {
                if !sources.is_empty() {
                    cmd::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
                    compacted += 1;
                }
                continue;
            }
            // One file is already one file; nothing to fold.
            if sources.len() < 2 {
                continue;
            }
            let list = sources
                .iter()
                .map(|k| format!("'s3://{}/{}'", cfg.s3_bucket, k))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = s3_setup(
                cfg,
                &format!(
                    // union_by_name: the docs call the telemetry schema
                    // `v0-unstable`, so an hour that spans a node upgrade can
                    // hold two shapes — merge them instead of refusing the
                    // whole hour (sources are only deleted after the copy).
                    "COPY (SELECT * FROM read_parquet([{list}], union_by_name=true) ORDER BY {sort_col}) \
                       TO 's3://{}/{}' (FORMAT parquet, COMPRESSION zstd);",
                    cfg.s3_bucket, target,
                ),
            );
            stats::count_duckdb("compact");
            cmd::run_cmd(
                "/usr/local/bin/duckdb",
                &["-c", &sql],
                None,
                &[],
                std::time::Duration::from_secs(120),
            )
            .await?;
            if !cmd::s3_object_exists(cfg, &cfg.s3_bucket, &target).await {
                anyhow::bail!("compacted object missing after copy: {target}");
            }
            cmd::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
            compacted += 1;
        }
    }
    Ok(compacted)
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

pub async fn tick(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    control_pid: u32,
    state: &mut MetricsState,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    let apps = db::list_apps(pool).await?;
    // Only deployed fleets have telemetry and a running celld — exclude
    // never-deployed apps so we don't spawn duckdb (and sample CPU) for
    // every created-but-empty slug every cycle.
    let mut slug_id: HashMap<String, String> = apps
        .iter()
        .filter(|a| a.status == AppStatus::Running.as_str() || a.last_deploy_sha.is_some())
        .map(|a: &App| (a.slug.clone(), a.id.clone()))
        .collect();
    // The control fleet is a telemetry source with no `app` row, on purpose:
    // nothing that iterates apps (reconcile, Caddy, sleep, purge, list_apps)
    // may see the control plane, yet its traces, logs and errors belong on the
    // same dashboards. Its rows key on the reserved slug (`host::control::SLUG`)
    // and its Parquet lives under `control/telemetry/...` (see
    // `telemetry_prefix`). Always present: the access-log attribution and the
    // error index read the same map, and a dev image without a control celld
    // simply has nothing to ingest (`ingest_after` sees it as not live).
    slug_id.insert(
        crate::host::control::SLUG.to_string(),
        crate::host::control::SLUG.to_string(),
    );
    // T1.3: aggregation only covers fleets with a live process. A stopped
    // app's sealed Parquet needs no re-scan every 10 s; its status mirrors
    // the supervisor (ensure_fleet marks Running, stop marks Stopped), and
    // the procs map confirms the process is actually there. The control node
    // is not in that map either, so its pid slot answers the same question.
    let live_slugs: HashSet<String> = procs.lock().await.keys().cloned().collect();
    let live = |slug: &str| {
        if slug == crate::host::control::SLUG {
            control_pid != 0
        } else {
            live_slugs.contains(slug)
        }
    };

    // CPU is sampled per tick and accumulates; telemetry usage is recomputed
    // per chunk and replaced, so the two never share a writer.
    let mut cpu: HashMap<(String, String), i64> = HashMap::new(); // (id, bucket) -> ms

    // 1. CPU deltas since the last sample (100 ticks/sec → *10 = ms).
    let cpu_bucket = minute_bucket_now();
    let now_cpu = sample_cpu(procs, control_pid);
    for (slug, (ut, st)) in &now_cpu {
        let Some(id) = slug_id.get(slug) else {
            continue;
        };
        let Some(prev) = state.last_cpu.get(slug) else {
            continue;
        };
        let ms = ((ut.saturating_sub(prev.0) + st.saturating_sub(prev.1)) * 10) as i64;
        if ms > 0 {
            *cpu.entry((id.clone(), cpu_bucket.clone())).or_default() += ms;
        }
    }
    state.last_cpu = now_cpu;

    // 2. Ingest in hour-chunks (spec T3.1), at most once per flush interval
    //    (spec T3.4) — not every reconcile tick. Each chunk recomputes whole
    //    hours (plus the partial current hour) and REPLACES their aggregates,
    //    so re-reading is exact: a retry, a catch-up after downtime, and a
    //    replay are all the same operation. The window stops agg_lag behind
    //    now so every minute bucket it names has closed. Stopped apps are
    //    skipped: nothing new lands in their buckets.
    state.tick += 1;
    let lag = agg_lag_us(cfg);
    let due = state
        .last_ingest
        .map(|t| t.elapsed().as_millis() >= otel_flush_ms(cfg) as u128)
        .unwrap_or(true);
    let mut touched: HashSet<String> = HashSet::new(); // app ids with new rows
    let mut new_logs = false;
    if due {
        state.last_ingest = Some(std::time::Instant::now());
        let floor_us = now_us() - cfg.telemetry_retention_days * 86_400_000_000;
        let app_sha: HashMap<String, String> = apps
            .iter()
            .filter_map(|a| a.last_deploy_sha.clone().map(|sha| (a.id.clone(), sha)))
            .collect();
        // A replay request (written by `noite-runner telemetry reingest`, or by
        // the migration that ships this ingest) rewinds every target fleet to
        // the floor exactly once. The row stays until all of them have reached
        // the current hour, so the rewind survives a restart and a slow pass
        // cannot lose it.
        let replay = match db::get_telemetry_replay(pool).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "telemetry replay read");
                None
            }
        };
        if let Some(r) = &replay {
            if state.replay_seen.as_deref() != Some(r.requested_at.as_str()) {
                let floor = if r.floor_us <= 0 {
                    floor_us
                } else {
                    r.floor_us.max(floor_us)
                };
                let targets: Vec<String> = match &r.slug {
                    Some(s) => vec![s.clone()],
                    None => slug_id.keys().cloned().collect(),
                };
                for slug in &targets {
                    state.watermark.insert(slug.clone(), floor);
                }
                tracing::info!(
                    floor_us = floor,
                    fleets = targets.len(),
                    requested_at = %r.requested_at,
                    "telemetry replay started"
                );
                state.replay_seen = Some(r.requested_at.clone());
            }
        }
        let replay_slug = replay.as_ref().and_then(|r| r.slug.as_deref());
        let replay_target = |slug: &str| match replay_slug {
            Some(s) => s == slug,
            None => replay.is_some(),
        };
        // One chunk per fleet per iteration, oldest first; caught-up fleets
        // still get the partial current hour once. Stopped fleets are drained
        // through the last complete hour (`ingest_after`). A chunk's watermark
        // advances only after every write of it succeeded, so a failure (or a
        // crash) re-reads the chunk — which is safe because the writers
        // replace, never accumulate.
        let mut done_this_pass: HashSet<String> = HashSet::new();
        for _ in 0..MAX_CHUNKS_PER_PASS {
            let cutoff = now_us() - lag;
            let mut bounds: Vec<(String, i64, i64)> = Vec::new();
            for slug in slug_id.keys() {
                if done_this_pass.contains(slug) {
                    continue;
                }
                let Some(after) = ingest_after(
                    live(slug),
                    replay_target(slug),
                    state.watermark.get(slug).copied(),
                    cutoff,
                ) else {
                    continue;
                };
                if let Some((from, until)) =
                    plan_chunks(after, cutoff, floor_us, 1).into_iter().next()
                {
                    if ingest_backed_off(state, slug, from) {
                        continue;
                    }
                    if until >= cutoff {
                        // The partial current hour is this pass's last chunk
                        // for the fleet; re-reading it within the pass is
                        // useless work.
                        done_this_pass.insert(slug.clone());
                    }
                    bounds.push((slug.clone(), from, until));
                }
            }
            if bounds.is_empty() {
                break;
            }
            let results = collect_chunk_results(&DuckdbPass(cfg), &bounds).await;
            for (chunk, result) in results {
                let rows = match result {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!(error = %e, fleets = chunk.len(), "telemetry ingest; watermark held");
                        for (slug, from, _) in &chunk {
                            back_off_ingest(state, slug, *from);
                        }
                        continue;
                    }
                };
                match commit_chunk(
                    pool,
                    state,
                    &slug_id,
                    &app_sha,
                    &chunk,
                    rows,
                    cutoff - 86_400_000_000,
                )
                .await
                {
                    Ok(w) => {
                        touched.extend(w.touched);
                        new_logs |= w.new_logs;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, fleets = chunk.len(), "telemetry ingest write; watermark held");
                        for (slug, from, _) in &chunk {
                            back_off_ingest(state, slug, *from);
                        }
                    }
                }
            }
        }
        // A replay is done once every target fleet has reached the hour the
        // cutoff is in (the partial hour then runs normally every pass).
        if let Some(r) = &replay {
            let hour = floor_hour_us(now_us() - lag);
            let caught_up = match &r.slug {
                Some(s) => {
                    !slug_id.contains_key(s) || state.watermark.get(s).is_none_or(|w| *w >= hour)
                }
                None => slug_id
                    .keys()
                    .all(|s| state.watermark.get(s).is_none_or(|w| *w >= hour)),
            };
            if caught_up {
                match db::clear_telemetry_replay(pool).await {
                    Ok(()) => tracing::info!(fleets = slug_id.len(), "telemetry replay complete"),
                    Err(e) => tracing::warn!(error = %e, "telemetry replay clear"),
                }
                state.replay_seen = None;
            }
        }
    }
    // 3. Caddy access log → device families, plus the trace → request index
    //    the error ingest joins on. Never fails the tick: a missing log
    //    (Caddy not yet reloaded) or a corrupt line is a silent skip.
    if let Err(e) = accesslog::tick(pool, cfg, &slug_id, &mut state.requests).await {
        tracing::warn!(error = %e, "access_log");
    }

    // 3b. Durable compaction (spec T3.5): every completed hour since the
    //     durable watermark, oldest first, bounded per pass so a long outage
    //     catches up gradually. Never the current hour. Stopped fleets are
    //     covered the same way — each of their hours compacts exactly once,
    //     including the hour they stopped in — so no separate stopped set.
    let cur_hour = hour_dir(now_us());
    let mut pending: Vec<(String, String)> = Vec::new();
    for slug in slug_id.keys() {
        for h in uncompacted_hours(state.compacted.get(slug), &cur_hour, cfg) {
            if state.attempted.contains(&(slug.clone(), h.clone())) {
                continue;
            }
            pending.push((slug.clone(), h));
        }
    }
    pending.sort();
    pending.truncate(6);
    for (slug, hour) in pending {
        match compact_fleet(cfg, &slug, &hour).await {
            Ok(0) => {
                // Already one file (or nothing written): sealed all the same.
                mark_compacted(pool, state, &slug, &hour).await;
            }
            Ok(n) => {
                tracing::info!(slug = %slug, dirs = n, hour = %hour, "compacted telemetry");
                mark_compacted(pool, state, &slug, &hour).await;
            }
            Err(e) => {
                tracing::warn!(slug = %slug, hour = %hour, error = %e, "telemetry compaction");
                state.attempted.insert((slug, hour));
            }
        }
    }

    // 4. Persist sampled CPU (telemetry usage was replaced per chunk above).
    for ((id, bucket), ms) in &cpu {
        if *ms > 0 {
            db::add_app_metric_cpu(pool, id, bucket, *ms).await?;
            touched.insert(id.clone());
        }
    }
    // 4b. The watermarks advanced (and persisted) per committed chunk in
    // `commit_chunk`, so a restart resumes there; a crash before a chunk's
    // writes re-reads the chunk, which the replace writers make exact.
    // 4c. Dashboard versions (spec T3.6) + log wakeups (spec T3.3): polls
    // skip unchanged windows; the log stream wakes instead of re-scanning.
    for id in &touched {
        if let Err(e) = db::bump_metric_version(pool, id).await {
            tracing::warn!(error = %e, "version bump");
        }
    }
    if new_logs {
        log_tx.send_modify(|v| *v += 1);
    }

    // 5. Prune old buckets occasionally (~every 100 ticks).
    if state.tick.is_multiple_of(100) {
        state.attempted.clear();
        state
            .ingest_backoff
            .retain(|_, at| *at > std::time::Instant::now());
        let cutoff = (Utc::now() - chrono::Duration::days(cfg.telemetry_retention_days))
            .format("%Y-%m-%dT%H:%M:00Z")
            .to_string();
        if let Ok(n) = db::prune_app_metrics(pool, &cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old app metrics");
            }
        }
        if let Ok(n) = db::prune_app_devices(pool, &cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old device stats");
            }
        }
        if let Ok(n) = db::prune_app_paths(pool, &cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old path stats");
            }
        }
        if let Ok(n) = db::prune_app_refs(pool, &cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old ref stats");
            }
        }
        let hour_cutoff = (Utc::now() - chrono::Duration::days(cfg.telemetry_retention_days))
            .format("%Y-%m-%dT%H:00:00Z")
            .to_string();
        if let Ok(n) = db::prune_span_stats(pool, &hour_cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old span stats");
            }
        }
        let cutoff_us = now_us() - cfg.telemetry_retention_days * 86_400_000_000;
        if let Ok(n) = db::prune_errors(pool, cutoff_us, &hour_cutoff).await {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old errors");
            }
        }
        if let Ok(n) = db::prune_compactions(
            pool,
            &hour_dir(now_us() - cfg.telemetry_retention_days * 86_400_000_000),
        )
        .await
        {
            if n > 0 {
                tracing::info!(pruned = n, "pruned old compaction marks");
            }
        }
    }
    Ok(())
}

/// Completed, uncompacted hours in `(done, current)`, oldest first.
/// `done` is the durable watermark (exclusive), `current` the running hour
/// (exclusive — never compact it). Bounded so one pass cannot name the whole
/// retention after a long outage; unparseable input compacts nothing.
fn uncompacted_hours(done: Option<&String>, current: &str, cfg: &Config) -> Vec<String> {
    let parse = |h: &str| {
        chrono::NaiveDateTime::parse_from_str(&format!("{h}:00:00"), "%Y/%m/%d/%H:%M:%S").ok()
    };
    let Some(current_dt) = parse(current) else {
        return Vec::new();
    };
    let floor =
        chrono::Utc::now().naive_utc() - chrono::Duration::days(cfg.telemetry_retention_days);
    let mut start = match done.and_then(|d| parse(d)) {
        Some(d) => d + chrono::Duration::hours(1),
        // No watermark: only the recent past, not the whole retention.
        None => current_dt - chrono::Duration::hours(25),
    };
    if start < floor {
        start = floor;
    }
    let mut hours = Vec::new();
    while start < current_dt && hours.len() < 48 {
        hours.push(start.format("%Y/%m/%d/%H").to_string());
        let Some(next) = start.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        start = next;
    }
    hours
}

async fn mark_compacted(pool: &SqlitePool, state: &mut MetricsState, slug: &str, hour: &str) {
    if let Err(e) = db::mark_hour_compacted(pool, slug, hour).await {
        tracing::warn!(error = %e, "compaction mark");
        return;
    }
    let newer = state
        .compacted
        .get(slug)
        .map(|h| h.as_str() < hour)
        .unwrap_or(true);
    if newer {
        state.compacted.insert(slug.to_string(), hour.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z in micros
    const HOUR_US: i64 = 3_600_000_000;

    #[test]
    fn idle_err_detects_no_files() {
        let e = anyhow::anyhow!("duckdb: No files found that match the pattern");
        assert!(is_idle_telemetry_err(&e));
        let e = anyhow::anyhow!("IO Error: read_parquet needs at least one file to read");
        assert!(is_idle_telemetry_err(&e));
        let e2 = anyhow::anyhow!("connection refused");
        assert!(!is_idle_telemetry_err(&e2));
    }

    #[test]
    fn uncompacted_hours_never_names_the_running_hour() {
        let cfg = crate::config::Config::from_env().expect("config");
        // Watermarked through 13:00, now 15:xx → only 14:00 is pending.
        let hours = uncompacted_hours(Some(&"2026/09/29/13".to_string()), "2026/09/29/15", &cfg);
        assert_eq!(hours, vec!["2026/09/29/14".to_string()]);
        // Caught up: nothing pending, and garbage input compacts nothing.
        assert!(
            uncompacted_hours(Some(&"2026/09/29/15".to_string()), "2026/09/29/15", &cfg).is_empty()
        );
        assert!(uncompacted_hours(None, "not-an-hour", &cfg).is_empty());
    }

    #[test]
    fn chunks_tile_the_gap_in_bounded_hours() {
        // A catch-up chunk is whole hours; the hour the cutoff falls in is
        // last and partial. Windows are contiguous and non-overlapping.
        let cutoff = H + 5 * HOUR_US + 900_000_000; // 05:15:00
        assert_eq!(
            plan_chunks(H, cutoff, 0, usize::MAX),
            vec![(H, H + 5 * HOUR_US), (H + 5 * HOUR_US, cutoff)],
        );
        // The per-pass cap stops after one chunk; the watermark is the end.
        assert_eq!(plan_chunks(H, cutoff, 0, 1), vec![(H, H + 5 * HOUR_US)]);
        // A 30-hour gap is folded into 24-hour chunks plus the partial hour.
        let cutoff = H + 30 * HOUR_US + 60_000_000;
        assert_eq!(
            plan_chunks(H, cutoff, 0, usize::MAX),
            vec![
                (H, H + 24 * HOUR_US),
                (H + 24 * HOUR_US, H + 30 * HOUR_US),
                (H + 30 * HOUR_US, cutoff),
            ],
        );
        // The retention floor clamps a watermark older than what is kept.
        assert_eq!(
            plan_chunks(0, H + HOUR_US + 1, H + HOUR_US, usize::MAX),
            vec![(H + HOUR_US, H + HOUR_US + 1)],
        );
        // Caught up: only the partial current hour, once.
        assert_eq!(
            plan_chunks(H + 10 * 60_000_000, H + 20 * 60_000_000, 0, usize::MAX),
            vec![(H, H + 20 * 60_000_000)],
        );
    }

    #[test]
    fn compaction_plan_prefers_the_compacted_file() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // Nothing compacted yet: every file is a source.
        let (has, sources) = compaction_plan(&[src("a"), src("b")], &target);
        assert!(!has);
        assert_eq!(sources.len(), 2);
        // A finished compaction leaves exactly the compacted file.
        let (has, sources) = compaction_plan(std::slice::from_ref(&target), &target);
        assert!(has);
        assert!(sources.is_empty());
        // An interrupted source delete leaves both: the compacted file is
        // authoritative and the leftovers are removed, never read.
        let (has, sources) = compaction_plan(&[target.clone(), src("a")], &target);
        assert!(has);
        assert_eq!(sources, vec![src("a")]);
    }

    #[test]
    fn canonical_file_list_prefers_compacted_directories() {
        let sql = canonical_file_list_sql("SELECT file FROM glob('s3://b/x/*.parquet')");
        assert!(sql.contains("compacted.parquet"), "{sql}");
        assert!(sql.contains("NOT IN"), "{sql}");
        assert!(sql.contains("compacted_dirs"), "{sql}");
    }

    // -----------------------------------------------------------------------
    // Write-layer tests. DuckDB is not on the dev host, so these drive
    // `commit_chunk` directly with the rows `ingest_all` would return: the
    // aggregation itself is exercised by the e2e lanes, the idempotency and
    // watermark rules here.
    // -----------------------------------------------------------------------

    async fn test_pool(name: &str) -> (SqlitePool, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("noite-metrics-{name}-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = db::connect(&url).await.expect("connect");
        (pool, dir)
    }

    fn slug_id() -> HashMap<String, String> {
        HashMap::from([("blog".to_string(), "app1".to_string())])
    }

    fn log_row(ts_us: i64, body: &str, trace: &str) -> errors::LogRow {
        errors::LogRow {
            slug: "blog".to_string(),
            ts_us,
            body: body.to_string(),
            trace_id: trace.to_string(),
        }
    }

    fn rows_hour1() -> IngestRows {
        IngestRows {
            minutes: vec![
                (
                    "blog".to_string(),
                    "2026-01-01T00:05:00Z".to_string(),
                    10,
                    5_000,
                    0,
                ),
                (
                    "blog".to_string(),
                    "2026-01-01T00:06:00Z".to_string(),
                    4,
                    2_000,
                    1,
                ),
            ],
            spans: vec![(
                "blog".to_string(),
                "2026-01-01T00:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                14,
                7_000,
                1,
                300,
            )],
            logs: vec![log_row(H + 5 * 60_000_000, "hello", "t1")],
            errors: Vec::new(),
        }
    }

    fn rows_hour2() -> IngestRows {
        IngestRows {
            minutes: vec![(
                "blog".to_string(),
                "2026-01-01T01:10:00Z".to_string(),
                7,
                3_000,
                0,
            )],
            spans: vec![(
                "blog".to_string(),
                "2026-01-01T01:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                7,
                3_000,
                0,
                100,
            )],
            logs: vec![log_row(H + HOUR_US + 10 * 60_000_000, "world", "t2")],
            errors: vec![errors::SpanErrorRow {
                slug: "blog".to_string(),
                error: "rejected: TypeError: boom [at f (worker.js:1:1)]".to_string(),
                name: "celld.fetch".to_string(),
                cell: String::new(),
                trace_id: "t-err".to_string(),
                count: 1,
                first_us: H + HOUR_US + 1_000_000,
                last_us: H + HOUR_US + 1_000_000,
            }],
        }
    }

    /// A chunk of the control fleet's own telemetry, keyed on the reserved
    /// slug exactly as the ingest emits it (`ingest_all` derives the slug from
    /// the `control/telemetry/...` path).
    fn rows_control_hour() -> IngestRows {
        let control = crate::host::control::SLUG.to_string();
        IngestRows {
            minutes: vec![(control.clone(), "2026-01-01T00:05:00Z".to_string(), 9, 4_500, 0)],
            spans: vec![(
                control.clone(),
                "2026-01-01T00:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                9,
                4_500,
                0,
                200,
            )],
            logs: vec![errors::LogRow {
                slug: control.clone(),
                ts_us: H + 5 * 60_000_000,
                body: "control plane log".to_string(),
                trace_id: "ct-1".to_string(),
            }],
            errors: vec![errors::SpanErrorRow {
                slug: control,
                error: "rejected: TypeError: boom [at handler (worker.js:3:1)]".to_string(),
                name: "celld.fetch".to_string(),
                cell: String::new(),
                trace_id: "ct-err".to_string(),
                count: 2,
                first_us: H + 1_000_000,
                last_us: H + 2_000_000,
            }],
        }
    }

    fn combined(a: IngestRows, b: IngestRows) -> IngestRows {
        IngestRows {
            minutes: [a.minutes, b.minutes].concat(),
            spans: [a.spans, b.spans].concat(),
            logs: [a.logs, b.logs].concat(),
            errors: [a.errors, b.errors].concat(),
        }
    }

    /// Deterministic dump of every table the ingest writes.
    async fn dump(pool: &SqlitePool) -> Vec<String> {
        let mut out = Vec::new();
        let metrics: Vec<(String, String, i64, i64, i64, i64)> = sqlx::query_as(
            "SELECT app_id, bucket_ts, requests, errors, latency_ms, cpu_ms FROM metrics.app_metric ORDER BY bucket_ts",
        )
        .fetch_all(pool)
        .await
        .expect("app_metric");
        out.extend(metrics.iter().map(|r| format!("metric {r:?}")));
        let spans: Vec<SpanRow> = sqlx::query_as(
            "SELECT app_id, bucket_hour, name, kind, n, ms, err, qwait_ms FROM metrics.app_span_stat ORDER BY bucket_hour, name, kind",
        )
        .fetch_all(pool)
        .await
        .expect("span");
        out.extend(spans.iter().map(|r| format!("span {r:?}")));
        let logs: Vec<(String, i64, String)> =
            sqlx::query_as("SELECT app_id, ts_us, body FROM metrics.app_log ORDER BY ts_us, body")
                .fetch_all(pool)
                .await
                .expect("log");
        out.extend(logs.iter().map(|r| format!("log {r:?}")));
        let hours: Vec<(String, String, String, i64)> = sqlx::query_as(
            "SELECT app_id, fingerprint, bucket_hour, n FROM metrics.app_error_hour ORDER BY fingerprint, bucket_hour",
        )
        .fetch_all(pool)
        .await
        .expect("error_hour");
        out.extend(hours.iter().map(|r| format!("errhour {r:?}")));
        let events: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT app_id, fingerprint, ts_us, trace_id FROM metrics.app_error_event ORDER BY fingerprint, ts_us",
        )
        .fetch_all(pool)
        .await
        .expect("error_event");
        out.extend(events.iter().map(|r| format!("errevent {r:?}")));
        let issues: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
            "SELECT app_id, fingerprint, count, first_seen_us, last_seen_us FROM metrics.app_error_issue ORDER BY fingerprint",
        )
        .fetch_all(pool)
        .await
        .expect("error_issue");
        out.extend(issues.iter().map(|r| format!("issue {r:?}")));
        out
    }

    #[test]
    fn ingest_selection_covers_live_replay_and_stopped_tails() {
        let cutoff = H + 30 * 60_000_000; // 00:30
                                          // Live with no watermark: the partial current hour.
        assert_eq!(ingest_after(true, false, None, cutoff), Some(H));
        // Live with a watermark: from where it left off.
        assert_eq!(
            ingest_after(true, false, Some(H + 3_600_000), cutoff),
            Some(H + 3_600_000)
        );
        // A stopped fleet whose watermark is inside the cutoff hour has
        // nothing pending yet; its tail is picked up once the hour completes.
        assert_eq!(
            ingest_after(false, false, Some(H + 10 * 60_000_000), cutoff),
            None
        );
        // A stopped fleet with a whole hour behind: drain it.
        assert_eq!(
            ingest_after(false, false, Some(H - 3_600_000), cutoff),
            Some(H - 3_600_000)
        );
        // A replay target is scanned even while stopped.
        assert_eq!(
            ingest_after(false, true, Some(H + 10 * 60_000_000), cutoff),
            Some(H + 10 * 60_000_000)
        );
        // Never ingested and not running: nothing to read.
        assert_eq!(ingest_after(false, false, None, cutoff), None);
    }

    /// A chunk pass whose behaviour per call is scripted: a fleet in `fail`
    /// fails alone, `idle` returns the no-files error.
    struct FakePass {
        fail: HashSet<String>,
        idle: bool,
    }

    impl ChunkPass for FakePass {
        async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
            if self.idle {
                anyhow::bail!("duckdb: No files found that match the pattern");
            }
            if bounds
                .iter()
                .any(|(slug, _, _)| self.fail.contains(slug.as_str()))
            {
                anyhow::bail!("simulated telemetry ingest error");
            }
            let mut rows = IngestRows::empty();
            for (slug, _, _) in bounds {
                rows.minutes.push((
                    slug.clone(),
                    "2026-01-01T00:05:00Z".to_string(),
                    1,
                    1_000,
                    0,
                ));
            }
            Ok(rows)
        }
    }

    #[tokio::test]
    async fn a_healthy_shared_pass_is_one_result() {
        let pass = FakePass {
            fail: HashSet::new(),
            idle: false,
        };
        let bounds = vec![
            ("a".to_string(), H, H + HOUR_US),
            ("b".to_string(), H, H + HOUR_US),
        ];
        let results = collect_chunk_results(&pass, &bounds).await;
        assert_eq!(results.len(), 1);
        assert!(results[0].1.is_ok());
    }

    #[tokio::test]
    async fn an_empty_window_is_a_successful_chunk() {
        let pass = FakePass {
            fail: HashSet::new(),
            idle: true,
        };
        let results = collect_chunk_results(&pass, &[("a".to_string(), H, H + HOUR_US)]).await;
        assert_eq!(results.len(), 1);
        assert!(
            results[0].1.is_ok(),
            "no files means nothing to read, not an error"
        );
    }

    #[tokio::test]
    async fn a_broken_fleet_does_not_hold_the_healthy_one() {
        let (pool, dir) = test_pool("isolation").await;
        let mut state = new_state();
        let slug_id = HashMap::from([
            ("good".to_string(), "app-good".to_string()),
            ("bad".to_string(), "app-bad".to_string()),
        ]);
        let bounds = vec![
            ("good".to_string(), H, H + HOUR_US),
            ("bad".to_string(), H, H + HOUR_US),
        ];
        let pass = FakePass {
            fail: HashSet::from(["bad".to_string()]),
            idle: false,
        };
        let results = collect_chunk_results(&pass, &bounds).await;
        // The shared pass failed, so it was retried per fleet: one result each.
        assert_eq!(results.len(), 2);
        for (chunk, result) in results {
            match result {
                Ok(rows) => {
                    commit_chunk(
                        &pool,
                        &mut state,
                        &slug_id,
                        &HashMap::new(),
                        &chunk,
                        rows,
                        0,
                    )
                    .await
                    .expect("commit the healthy fleet");
                }
                Err(_) => {
                    for (slug, from, _) in &chunk {
                        back_off_ingest(&mut state, slug, *from);
                    }
                }
            }
        }
        assert_eq!(
            state.watermark.get("good"),
            Some(&(H + HOUR_US)),
            "the healthy fleet must advance"
        );
        assert_eq!(
            state.watermark.get("bad"),
            None,
            "the broken fleet must hold"
        );
        assert!(
            ingest_backed_off(&state, "bad", H),
            "the broken fleet backs off"
        );
        let written: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, requests FROM metrics.app_metric ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_metric");
        assert_eq!(written, vec![("app-good".to_string(), 1)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn reingesting_a_window_is_idempotent_and_a_partial_retry_converges() {
        let full = rows_hour1();
        let bounds = vec![("blog".to_string(), H, H + HOUR_US)];
        let sha = HashMap::new();

        // A: the chunk written once.
        let (pool_a, dir_a) = test_pool("idem-a").await;
        let mut state_a = new_state();
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &bounds,
            full.clone(),
            0,
        )
        .await
        .expect("write");
        let once = dump(&pool_a).await;
        assert!(!once.is_empty(), "the chunk must have written rows");
        // Re-reading the same window changes nothing.
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &bounds,
            full.clone(),
            0,
        )
        .await
        .expect("re-read");
        assert_eq!(dump(&pool_a).await, once, "re-read must be a no-op");

        // B: a partial write (half the rows, no logs) that is retried with the
        // whole chunk — the failure mode a crash mid-pass leaves behind.
        let (pool_b, dir_b) = test_pool("idem-b").await;
        let mut state_b = new_state();
        let mut partial = full.clone();
        partial.minutes.truncate(1);
        partial.logs.clear();
        commit_chunk(&pool_b, &mut state_b, &slug_id(), &sha, &bounds, partial, 0)
            .await
            .expect("partial");
        commit_chunk(&pool_b, &mut state_b, &slug_id(), &sha, &bounds, full, 0)
            .await
            .expect("retry");
        assert_eq!(
            dump(&pool_b).await,
            once,
            "a retry must converge on the single write"
        );

        // The watermark moved to the chunk's end, not the cutoff.
        assert_eq!(state_a.watermark.get("blog"), Some(&(H + HOUR_US)));
        for dir in [dir_a, dir_b] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn catch_up_in_hour_chunks_equals_one_continuous_pass() {
        let sha = HashMap::new();
        // A: both hours in one window.
        let (pool_a, dir_a) = test_pool("catchup-a").await;
        let mut state_a = new_state();
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H, H + 2 * HOUR_US)],
            combined(rows_hour1(), rows_hour2()),
            0,
        )
        .await
        .expect("continuous");
        // B: hour by hour, the way the tick catches up.
        let (pool_b, dir_b) = test_pool("catchup-b").await;
        let mut state_b = new_state();
        commit_chunk(
            &pool_b,
            &mut state_b,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H, H + HOUR_US)],
            rows_hour1(),
            0,
        )
        .await
        .expect("hour 1");
        commit_chunk(
            &pool_b,
            &mut state_b,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H + HOUR_US, H + 2 * HOUR_US)],
            rows_hour2(),
            0,
        )
        .await
        .expect("hour 2");
        assert_eq!(dump(&pool_b).await, dump(&pool_a).await);
        for dir in [dir_a, dir_b] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn telemetry_prefix_follows_the_source_bucket() {
        // celld writes `telemetry/` relative to its `--bucket`: tenant fleets
        // are `fleets/<slug>`, the control node is `control` — never
        // `fleets/_control`, which no fleet writes and purge/rename own.
        assert_eq!(telemetry_prefix(crate::host::control::SLUG), "control");
        assert_eq!(telemetry_prefix("blog"), "fleets/blog");
    }

    #[test]
    fn telemetry_globs_name_each_sources_prefix() {
        let cfg = crate::config::Config::from_env().expect("config");
        let now = now_us();
        let (from, to) = (now - HOUR_US, now);
        let control = telemetry_globs(&cfg, crate::host::control::SLUG, "traces", from, to);
        assert!(!control.is_empty());
        let control_root = format!("s3://{}/control/telemetry/traces/", cfg.s3_bucket);
        assert!(
            control.iter().all(|g| g.starts_with(&control_root)),
            "{control:?}"
        );
        let tenant = telemetry_globs(&cfg, "blog", "traces", from, to);
        assert!(!tenant.is_empty());
        let tenant_root = format!("s3://{}/fleets/blog/telemetry/traces/", cfg.s3_bucket);
        assert!(
            tenant.iter().all(|g| g.starts_with(&tenant_root)),
            "{tenant:?}"
        );
    }

    #[test]
    fn cpu_sampling_includes_the_control_node_when_it_runs() {
        // The control celld is not in the procs map; its pid slot is sampled
        // too, so its CPU lands in the same `app_metric.cpu_ms` accumulator.
        let procs = crate::host::supervisor::new_procs();
        assert!(
            !sample_cpu(&procs, 0).contains_key(crate::host::control::SLUG),
            "no control process means no sample"
        );
        assert!(
            sample_cpu(&procs, std::process::id()).contains_key(crate::host::control::SLUG),
            "a running control node is sampled"
        );
    }

    #[tokio::test]
    async fn control_telemetry_is_keyed_on_the_reserved_slug_without_an_app_row() {
        let (pool, dir) = test_pool("control").await;
        let mut state = new_state();
        let slug_id = HashMap::from([(
            crate::host::control::SLUG.to_string(),
            crate::host::control::SLUG.to_string(),
        )]);
        let bounds = vec![(crate::host::control::SLUG.to_string(), H, H + HOUR_US)];
        let sha = HashMap::new();
        commit_chunk(
            &pool,
            &mut state,
            &slug_id,
            &sha,
            &bounds,
            rows_control_hour(),
            0,
        )
        .await
        .expect("commit the control chunk");
        let once = dump(&pool).await;
        assert!(!once.is_empty(), "control telemetry must be written");
        let metrics: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, requests FROM metrics.app_metric ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_metric");
        assert_eq!(metrics, vec![(crate::host::control::SLUG.to_string(), 9)]);
        let issues: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, count FROM metrics.app_error_issue ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_error_issue");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].0, crate::host::control::SLUG);
        // The reserved key has NO app row: every path that iterates apps
        // (reconcile, Caddy, sleep, purge, list_apps) stays blind to it.
        assert!(db::list_apps(&pool).await.expect("list_apps").is_empty());
        assert!(!crate::lifecycle::slug_ok(crate::host::control::SLUG));
        // A replay (the retry/reingest path) is exact, never additive.
        commit_chunk(
            &pool,
            &mut state,
            &slug_id,
            &sha,
            &bounds,
            rows_control_hour(),
            0,
        )
        .await
        .expect("replay the control chunk");
        assert_eq!(dump(&pool).await, once, "a re-read must be a no-op");
        assert_eq!(
            state.watermark.get(crate::host::control::SLUG),
            Some(&(H + HOUR_US))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_failed_write_holds_the_watermark() {
        let (pool, dir) = test_pool("fail").await;
        let mut state = new_state();
        state.watermark.insert("blog".to_string(), H);
        // A dead pool makes every writer inside commit_chunk fail.
        pool.close().await;
        let result = commit_chunk(
            &pool,
            &mut state,
            &slug_id(),
            &HashMap::new(),
            &[("blog".to_string(), H, H + HOUR_US)],
            rows_hour1(),
            0,
        )
        .await;
        assert!(result.is_err(), "the failed pass must report an error");
        assert_eq!(
            state.watermark.get("blog"),
            Some(&H),
            "a failed pass must not advance the watermark"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
