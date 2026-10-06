//! One ingest chunk: the DuckDB query over every fleet's telemetry, the
//! replace-only writers, and the per-fleet fault isolation around a shared
//! pass.

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::errors;

use super::plan::{duckdb_json, is_idle_telemetry_err, json_i64, s3_setup, telemetry_globs};
use super::MetricsState;

/// One hourly span-stat row: slug, hour, name, kind, n, ms, err, qwait.
pub(super) type SpanRow = (String, String, String, i64, i64, i64, i64, i64);

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
pub(super) struct IngestRows {
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
pub(super) struct ChunkWrites {
    pub(super) touched: HashSet<String>,
    pub(super) new_logs: bool,
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
pub(super) async fn commit_chunk(
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
pub(super) trait ChunkPass {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows>;
}

pub(super) struct DuckdbPass<'a>(pub(super) &'a Config);

impl ChunkPass for DuckdbPass<'_> {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
        ingest_all(self.0, bounds).await
    }
}

/// One chunk's rows, per fleet group. A shared pass that fails is retried PER
/// FLEET, so a single broken fleet cannot hold every other fleet's watermark;
/// a fleet that then fails alone is reported as an error, and the caller backs
/// it off. "No files" stays a successful, empty chunk.
pub(super) async fn collect_chunk_results<P: ChunkPass>(
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

#[cfg(test)]
mod tests;
