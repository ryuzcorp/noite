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
    watermark: HashMap<String, i64>, // slug -> last consumed start_unix_us
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
        .map(|s| s.split_whitespace().filter_map(|p| p.parse().ok()).collect())
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

fn sample_cpu(procs: &ProcMap) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
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

/// How far behind the flush the ingest window stops. Derived as
/// `flush + 10 s` (spec T3.4): it must exceed the flush interval, or a late
/// file could land inside an already-counted minute.
pub fn agg_lag_us(cfg: &Config) -> i64 {
    otel_flush_ms(cfg) as i64 * 1000 + 10_000_000
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
    let Some(mut hour) = chrono::DateTime::from_timestamp_micros(from_us.max(0)) else {
        return vec![format!(
            "s3://{}/fleets/{}/telemetry/{kind}/*/*/*/*/*/*.parquet",
            cfg.s3_bucket, slug
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
            "s3://{}/fleets/{}/telemetry/{kind}/*/{}/{}/{}/{}/*.parquet",
            cfg.s3_bucket,
            slug,
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
pub fn is_idle_telemetry_err(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains("No files found") || msg.contains("needs at least one file")
}

/// Whether a telemetry tick should advance the watermark for this result.
pub fn should_advance_watermark(agg_ok: bool, idle: bool) -> bool {
    agg_ok || idle
}

/// One hourly span-stat row: slug, hour, name, kind, n, ms, err, qwait.
pub type SpanRow = (String, String, String, i64, i64, i64, i64, i64);

/// One ingest pass over every live fleet (spec T3.1): a SINGLE DuckDB
/// invocation whose query unions four tagged result sets —
/// 1. minute buckets for `celld.fetch` (requests, duration, errors),
/// 2. hourly span stats for every span name (counts, ms, errors, queue wait),
/// 3. new OTel log lines (timestamp, body, trace id),
/// 4. failed spans grouped by their unwrapped `error` text (host/errors.rs),
///    counted per distinct trace so a Durable Object failure — reported on
///    the cell span and again on its parent — counts once; capped at 200
///    groups per fleet per pass.
///    The slug comes from the file path (`filename=true`, regex on
///    `fleets/<slug>/`), and each slug's exact watermark rides along in a
///    `VALUES` bounds table, so windows stay exact per fleet while every
///    Parquet file is read once.
pub struct IngestRows {
    pub minutes: Vec<(String, String, i64, i64, i64)>, // slug, bucket, n, dur_us, err
    pub spans: Vec<SpanRow>,
    pub logs: Vec<errors::LogRow>,
    pub errors: Vec<errors::SpanErrorRow>,
}

fn json_str(v: &serde_json::Value, key: &str) -> String {
    let path = format!("/{key}");
    v.pointer(path.as_str())
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

async fn ingest_all(
    cfg: &Config,
    bounds: &[(String, i64)],
    cutoff: i64,
) -> anyhow::Result<IngestRows> {
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
    for (slug, after) in bounds {
        traces.extend(telemetry_globs(cfg, slug, "traces", *after, cutoff));
        logs.extend(telemetry_globs(cfg, slug, "logs", *after, cutoff));
    }
    if traces.is_empty() && logs.is_empty() {
        return Ok(out);
    }
    // Per-slug watermark bounds: the window stays exact per fleet inside the
    // shared scan. Slugs are runner-generated (`[a-z0-9-]`) — the replace
    // keeps a quote from ending the literal.
    let values = bounds
        .iter()
        .map(|(s, a)| format!("('{}', {a})", s.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    // Expand the globs before reading. celld writes no file for an empty
    // batch, so an hour without traffic (or without a console line) has no
    // match, and `read_parquet` fails the whole list on one empty glob: a
    // single quiet fleet turned every pass into "idle" and the watermark
    // skipped everyone's rows. `glob()` returns nothing instead of failing.
    let globs = traces
        .iter()
        .chain(logs.iter())
        .map(|g| format!("SELECT file FROM glob('{g}')"))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
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
    let sql = s3_setup(
        cfg,
        &format!(
            "SET VARIABLE files = (SELECT coalesce(list(file), []) FROM ({globs})); \
             WITH files AS ( \
               SELECT regexp_extract(filename, 'fleets/([^/]+)/', 1) AS slug, \
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
             bounds(slug, after_us) AS (VALUES {values}) \
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
                AND f.start_unix_us > b.after_us AND f.start_unix_us <= {cutoff} \
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
              WHERE f.start_unix_us > b.after_us AND f.start_unix_us <= {cutoff} \
              GROUP BY f.slug, bucket, f.name, f.kind \
              UNION ALL \
             SELECT 3 AS tag, f.slug AS slug, \
                    CAST(NULL AS VARCHAR) AS bucket, CAST(NULL AS VARCHAR) AS name, \
                    CAST(0 AS BIGINT) AS kind, CAST(0 AS BIGINT) AS n, \
                    CAST(0 AS BIGINT) AS ms, CAST(0 AS BIGINT) AS e, \
                    CAST(0 AS BIGINT) AS q, f.time_unix_us AS ts, f.body AS body, \
                    f.trace_id AS trace, CAST(NULL AS VARCHAR) AS cell, \
                    CAST(0 AS BIGINT) AS first_ts \
               FROM files f JOIN bounds b ON f.slug = b.slug \
              WHERE f.time_unix_us > b.after_us AND f.time_unix_us <= {cutoff} \
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
                  AND f.start_unix_us > b.after_us AND f.start_unix_us <= {cutoff} \
                GROUP BY f.slug, f.err \
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
    let v: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|e| anyhow::anyhow!("duckdb json parse: {e}"))?;
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
/// exists, so a failed copy can never lose spans.
async fn compact_fleet(cfg: &Config, slug: &str, hour: &str) -> anyhow::Result<usize> {
    let mut compacted = 0_usize;
    for (kind, sort_col) in [("traces", "start_unix_us"), ("logs", "time_unix_us")] {
        let root = format!("fleets/{slug}/telemetry/{kind}/");
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
            let sources: Vec<String> = v
                .pointer("/Contents")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.pointer("/Key").and_then(|x| x.as_str()))
                        .filter(|k| k.ends_with(".parquet") && !k.ends_with("/compacted.parquet"))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            // One file is already one file; nothing to fold.
            if sources.len() < 2 {
                continue;
            }
            let target = format!("{dir}compacted.parquet");
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
    state: &mut MetricsState,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    let apps = db::list_apps(pool).await?;
    // Only deployed fleets have telemetry and a running celld — exclude
    // never-deployed apps so we don't spawn duckdb (and sample CPU) for
    // every created-but-empty slug every cycle.
    let slug_id: HashMap<String, String> = apps
        .iter()
        .filter(|a| a.status == AppStatus::Running.as_str() || a.last_deploy_sha.is_some())
        .map(|a: &App| (a.slug.clone(), a.id.clone()))
        .collect();
    // T1.3: aggregation only covers fleets with a live process. A stopped
    // app's sealed Parquet needs no re-scan every 10 s; its status mirrors
    // the supervisor (ensure_fleet marks Running, stop marks Stopped), and
    // the procs map confirms the process is actually there.
    let live_slugs: HashSet<String> = procs.lock().await.keys().cloned().collect();
    let live = |slug: &str| live_slugs.contains(slug);

    struct Acc {
        req: i64,
        err: i64,
        lat_ms: i64,
        cpu_ms: i64,
    }
    let mut acc: HashMap<(String, String), Acc> = HashMap::new(); // (id, bucket)

    // 1. CPU deltas since the last sample (100 ticks/sec → *10 = ms).
    let cpu_bucket = minute_bucket_now();
    let now_cpu = sample_cpu(procs);
    for (slug, (ut, st)) in &now_cpu {
        let Some(id) = slug_id.get(slug) else {
            continue;
        };
        let Some(prev) = state.last_cpu.get(slug) else {
            continue;
        };
        let ms = ((ut.saturating_sub(prev.0) + st.saturating_sub(prev.1)) * 10) as i64;
        if ms > 0 {
            let e = acc.entry((id.clone(), cpu_bucket.clone())).or_insert(
                Acc { req: 0, err: 0, lat_ms: 0, cpu_ms: 0 },
            );
            e.cpu_ms += ms;
        }
    }
    state.last_cpu = now_cpu;

    // 2. One ingest pass for all live fleets (spec T3.1), at most once per
    //    flush interval (spec T3.4) — not every reconcile tick. The window
    //    stops agg_lag behind now so every minute bucket in it has closed
    //    (never double-counted). Stopped apps are skipped: nothing new lands
    //    in their buckets.
    state.tick += 1;
    let lag = agg_lag_us(cfg);
    let due = state
        .last_ingest
        .map(|t| t.elapsed().as_millis() >= otel_flush_ms(cfg) as u128)
        .unwrap_or(true);
    let mut advanced: Vec<(String, i64)> = Vec::new();
    let mut touched: HashSet<String> = HashSet::new(); // app ids with new rows
    let mut new_logs = false;
    if due {
        state.last_ingest = Some(std::time::Instant::now());
        let bounds: Vec<(String, i64)> = slug_id
            .keys()
            .filter(|s| live(s))
            .map(|slug| {
                let after = state.watermark.get(slug).copied().unwrap_or(now_us() - lag);
                (slug.clone(), after)
            })
            .collect();
        let cutoff = now_us() - lag;
        match ingest_all(cfg, &bounds, cutoff).await {
            Ok(rows) => {
                for (slug, bucket, n, dur_us, err_n) in rows.minutes {
                    let Some(id) = slug_id.get(&slug) else {
                        continue;
                    };
                    if n > 0 || err_n > 0 {
                        let e = acc.entry((id.clone(), bucket)).or_insert(
                            Acc { req: 0, err: 0, lat_ms: 0, cpu_ms: 0 },
                        );
                        e.req += n;
                        e.err += err_n;
                        e.lat_ms += dur_us / 1000;
                        touched.insert(id.clone());
                    }
                }
                for (slug, hour, name, kind, n, ms, err, qwait) in rows.spans {
                    let Some(id) = slug_id.get(&slug) else {
                        continue;
                    };
                    if n > 0 || err > 0 {
                        db::add_span_stat(pool, id, &hour, &name, kind, n, ms, err, qwait)
                            .await?;
                        touched.insert(id.clone());
                    }
                }
                // Errors before the log ring takes the rows: an occurrence
                // keeps the log lines of its own trace.
                let app_sha: HashMap<String, String> = apps
                    .iter()
                    .filter_map(|a| a.last_deploy_sha.clone().map(|sha| (a.id.clone(), sha)))
                    .collect();
                match errors::ingest(pool, &slug_id, &app_sha, &rows.errors, &rows.logs, &state.requests).await {
                    Ok(ids) => touched.extend(ids),
                    Err(e) => tracing::warn!(error = %e, "error ingest"),
                }
                let mut log_groups: HashMap<String, Vec<(i64, String)>> = HashMap::new();
                for row in rows.logs {
                    if let Some(id) = slug_id.get(&row.slug) {
                        log_groups.entry(id.clone()).or_default().push((row.ts_us, row.body));
                    }
                }
                for (id, mut log_rows) in log_groups {
                    log_rows.sort_by_key(|(ts, _)| *ts);
                    if !log_rows.is_empty() {
                        db::append_app_logs(pool, &id, &log_rows).await?;
                        // Bounded ring per app: last 24 h AND last 2,000 lines.
                        let _ = db::prune_app_logs(pool, &id, cutoff - 86_400_000_000, 2000).await;
                        touched.insert(id);
                        new_logs = true;
                    }
                }
                if should_advance_watermark(true, false) {
                    for (slug, _) in &bounds {
                        state.watermark.insert(slug.clone(), cutoff);
                        advanced.push((slug.clone(), cutoff));
                    }
                }
            }
            Err(e) => {
                let idle = is_idle_telemetry_err(&e);
                if should_advance_watermark(false, idle) {
                    for (slug, _) in &bounds {
                        state.watermark.insert(slug.clone(), cutoff);
                        advanced.push((slug.clone(), cutoff));
                    }
                } else {
                    tracing::warn!(error = %e, "telemetry ingest");
                }
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

    // 4. Persist minute buckets.
    for ((id, bucket), a) in &acc {
        if a.req > 0 || a.err > 0 || a.cpu_ms > 0 {
            db::add_app_metric(pool, id, bucket, a.req, a.err, a.lat_ms, a.cpu_ms)
                .await?;
            touched.insert(id.clone());
        }
    }
    // 4b. Durable watermark: these rows live in metrics.sqlite on the data
    // volume, so restarts resume aggregation instead of resetting it.
    // Written only after the buckets above persist. A crash between the two
    // re-aggregates at most one window (upsert-accumulate may double-count
    // it) — narrow by construction.
    if !advanced.is_empty() {
        if let Err(e) = db::set_metric_watermarks(pool, &advanced).await {
            tracing::warn!(error = %e, "watermark persist");
        }
    }
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

async fn mark_compacted(
    pool: &SqlitePool,
    state: &mut MetricsState,
    slug: &str,
    hour: &str,
) {
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

    #[test]
    fn watermark_advances_on_ok_or_idle_only() {
        assert!(should_advance_watermark(true, false));
        assert!(should_advance_watermark(false, true));
        assert!(!should_advance_watermark(false, false));
    }

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
        let hours = uncompacted_hours(
            Some(&"2026/09/29/13".to_string()),
            "2026/09/29/15",
            &cfg,
        );
        assert_eq!(hours, vec!["2026/09/29/14".to_string()]);
        // Caught up: nothing pending, and garbage input compacts nothing.
        assert!(uncompacted_hours(Some(&"2026/09/29/15".to_string()), "2026/09/29/15", &cfg).is_empty());
        assert!(uncompacted_hours(None, "not-an-hour", &cfg).is_empty());
    }
}