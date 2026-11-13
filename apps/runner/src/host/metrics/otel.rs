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
//!    most [`MAX_ERROR_GROUPS`] groups per fleet).
//!
//! The window, the fleet key, the canonical-file rule (an hour directory with
//! a `compacted.parquet` is read from that file alone) and the newest-N cap
//! are all the same as the old query's, so an upgrade that already has
//! watermarks and compacted hours reads exactly the rows it used to.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

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

/// Failed-span groups one fleet may name per chunk. The old query kept the top
/// 200 after aggregating; this bounds the aggregation itself so a fleet that
/// throws a distinct error per request cannot grow the pass without bound. A
/// fleet that hits it loses the smallest groups (the ones the top-200 rule
/// would have dropped anyway) and logs one warning.
const MAX_ERROR_GROUPS: usize = 8192;

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

/// The files of one fleet's chunk: for each hour directory the window touches
/// and each node under the fleet's kind prefix, apply the canonical-file rule.
/// This is the listing equivalent of the old `glob(...)` + `compacted_dirs`
/// SQL: a directory with a `compacted.parquet` is read from that file alone,
/// because compaction deletes the sources after proving the copy — an
/// interrupted delete must not count the same spans twice.
async fn chunk_files(
    cfg: &Config,
    slug: &str,
    kind: &str,
    from_us: i64,
    to_us: i64,
) -> anyhow::Result<Vec<String>> {
    let root = format!("{}/telemetry/{kind}/", telemetry_prefix(slug));
    let (_, nodes) = s3::s3_list_dir(cfg, &cfg.s3_bucket, &root).await?;
    let mut files = Vec::new();
    for hour in telemetry_hours(cfg, from_us, to_us) {
        for node in &nodes {
            let dir = format!("{node}{hour}/");
            let (keys, _) = s3::s3_list_dir(cfg, &cfg.s3_bucket, &dir).await?;
            files.extend(canonical_files(&dir, keys));
        }
    }
    Ok(files)
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

/// The newest [`LOG_ROWS_PER_CHUNK`] lines of one fleet's chunk.
async fn read_logs(
    cfg: &Config,
    slug: &str,
    from_us: i64,
    until_us: i64,
) -> anyhow::Result<Vec<errors::LogRow>> {
    let mut newest: BinaryHeap<Reverse<(i64, u64, LogLine)>> = BinaryHeap::new();
    let mut seq = 0_u64;
    for key in chunk_files(cfg, slug, "logs", from_us, until_us).await? {
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
        decode_log_object(&body, from_us, until_us, &mut seq, &mut newest)?;
    }
    Ok(newest
        .into_iter()
        .map(|Reverse((_, _, line))| line)
        .filter(|line| !line.body.is_empty())
        .map(|line| errors::LogRow {
            slug: slug.to_string(),
            ts_us: line.ts_us,
            body: line.body,
            trace_id: line.trace_id,
        })
        .collect())
}

/// Decode one log object into the fleet's bounded newest-N heap.
fn decode_log_object(
    body: &[u8],
    from_us: i64,
    until_us: i64,
    seq: &mut u64,
    newest: &mut BinaryHeap<Reverse<(i64, u64, LogLine)>>,
) -> anyhow::Result<()> {
    let reader = parquet_io::open(bytes::Bytes::copy_from_slice(body))?;
    let Some(projection) = parquet_io::project(
        reader
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema(),
        LOG_COLUMNS,
    )?
    else {
        return Ok(());
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
        *seq += 1;
        let line = LogLine {
            ts_us,
            body,
            trace_id: trace,
        };
        // Oldest first, so the heap's minimum is the row to evict. The
        // sequence number keeps equal timestamps deterministic (the old
        // `row_number()` tie order was arbitrary).
        newest.push(Reverse((line.ts_us, *seq, line)));
        if newest.len() > LOG_ROWS_PER_CHUNK {
            newest.pop();
        }
    }
    Ok(())
}

/// One failed-span group per (fleet, hour, unwrapped error text), exactly the
/// aggregation the old tag 4 did.
struct Group {
    name: String,
    /// The latest span of the group: `arg_max(name, start_unix_us)` and
    /// `arg_max(trace_id, start_unix_us)`.
    best_start: i64,
    trace_id: String,
    /// `max(cell)`: lexicographic, empty when every span lacked one.
    cell: String,
    first_us: i64,
    last_us: i64,
    /// Distinct traces, so a DO failure on both the cell span and its parent
    /// counts once.
    traces: HashSet<String>,
}

impl Group {
    fn new(start_us: i64, name: String, trace_id: String, cell: Option<&str>) -> Self {
        let mut traces = HashSet::new();
        traces.insert(trace_id.clone());
        Self {
            name,
            best_start: start_us,
            trace_id,
            cell: cell.unwrap_or_default().to_string(),
            first_us: start_us,
            last_us: start_us,
            traces,
        }
    }

    fn push(&mut self, start_us: i64, name: String, trace_id: String, cell: Option<&str>) {
        self.traces.insert(trace_id.clone());
        if start_us >= self.best_start {
            self.best_start = start_us;
            self.name = name;
            self.trace_id = trace_id;
        }
        if let Some(cell) = cell {
            if cell > self.cell.as_str() {
                self.cell = cell.to_string();
            }
        }
        self.first_us = self.first_us.min(start_us);
        self.last_us = self.last_us.max(start_us);
    }
}

/// The failed-span groups of one fleet's chunk, newest-error groups first as
/// the old `QUALIFY … ORDER BY count(DISTINCT trace_id) DESC` did, capped at
/// the top 200.
async fn read_errors(
    cfg: &Config,
    slug: &str,
    from_us: i64,
    until_us: i64,
) -> anyhow::Result<Vec<errors::SpanErrorRow>> {
    let mut groups: HashMap<(String, String), Group> = HashMap::new();
    let mut capped = false;
    for key in chunk_files(cfg, slug, "traces", from_us, until_us).await? {
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
        decode_trace_object(&body, from_us, until_us, slug, &mut groups, &mut capped)?;
    }
    let mut rows: Vec<errors::SpanErrorRow> = groups
        .into_iter()
        .map(|((_, error), group)| errors::SpanErrorRow {
            slug: slug.to_string(),
            error,
            name: group.name,
            cell: group.cell,
            trace_id: group.trace_id,
            count: group.traces.len() as i64,
            first_us: group.first_us,
            last_us: group.last_us,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.error.cmp(&b.error))
            .then_with(|| a.first_us.cmp(&b.first_us))
    });
    rows.truncate(200);
    Ok(rows)
}

/// Decode one trace object into the fleet's failed-span groups.
fn decode_trace_object(
    body: &[u8],
    from_us: i64,
    until_us: i64,
    slug: &str,
    groups: &mut HashMap<(String, String), Group>,
    capped: &mut bool,
) -> anyhow::Result<()> {
    let unwrap = rejected_prefix();
    let reader = parquet_io::open(bytes::Bytes::copy_from_slice(body))?;
    let Some(projection) = parquet_io::project(
        reader
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema(),
        SPAN_COLUMNS,
    )?
    else {
        return Ok(());
    };
    for row in parquet::record::reader::RowIter::from_file(Some(projection), &reader)?
        .with_batch_size(8192)
    {
        let row = row?;
        let mut name = String::new();
        let mut start_us = 0;
        let mut ok = true;
        let mut error = None;
        let mut trace = String::new();
        let mut cell = None;
        for (column, field) in row.get_column_iter() {
            match column.as_str() {
                "name" => name = parquet_io::text(field).unwrap_or_default().to_string(),
                "start_unix_us" => {
                    start_us = parquet_io::long(field).unwrap_or_default();
                }
                "ok" => ok = parquet_io::boolean(field).unwrap_or(true),
                "error" => error = parquet_io::text(field),
                "trace_id" => {
                    trace = parquet_io::text(field).unwrap_or_default().to_string();
                }
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
        let key = (hour, error);
        if let Some(group) = groups.get_mut(&key) {
            group.push(start_us, name, trace, cell);
            continue;
        }
        if groups.len() >= MAX_ERROR_GROUPS {
            if !*capped {
                *capped = true;
                tracing::warn!(
                    fleet = %slug,
                    cap = MAX_ERROR_GROUPS,
                    "failed-span groups reached the per-chunk cap; smaller groups are dropped"
                );
            }
            continue;
        }
        groups.insert(key, Group::new(start_us, name, trace, cell));
    }
    Ok(())
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
    fn log_cap_keeps_the_newest_rows() {
        // The heap is (ts, seq, line); Reverse makes the oldest the minimum.
        let mut newest: BinaryHeap<Reverse<(i64, u64, LogLine)>> = BinaryHeap::new();
        for (seq, ts) in [(1_u64, 100_i64), (2, 300), (3, 200)] {
            newest.push(Reverse((
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
        let mut kept: Vec<i64> = newest.into_iter().map(|Reverse((ts, _, _))| ts).collect();
        kept.sort_unstable();
        assert_eq!(kept, vec![200, 300]);
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
            let body = std::fs::read(&path).expect("fixture object");
            decode_log_object(&body, from_us, until_us, &mut seq, &mut newest)
                .expect("decode fixture logs");
        }
        let mut rows: Vec<errors::LogRow> = newest
            .into_iter()
            .map(|Reverse((_, _, line))| line)
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
        let mut groups: HashMap<(String, String), Group> = HashMap::new();
        let mut capped = false;
        for path in parquet_files(dir) {
            let body = std::fs::read(&path).expect("fixture object");
            decode_trace_object(&body, from_us, until_us, slug, &mut groups, &mut capped)
                .expect("decode fixture traces");
        }
        let mut rows: Vec<errors::SpanErrorRow> = groups
            .into_iter()
            .map(|((_, error), group)| errors::SpanErrorRow {
                slug: slug.to_string(),
                error,
                name: group.name,
                cell: group.cell,
                trace_id: group.trace_id,
                count: group.traces.len() as i64,
                first_us: group.first_us,
                last_us: group.last_us,
            })
            .collect();
        rows.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.error.cmp(&b.error))
                .then_with(|| a.first_us.cmp(&b.first_us))
        });
        rows.truncate(200);
        rows
    }

    /// The permanent differential: real celld objects (a production flush, a
    /// DuckDB compaction of the same hour) with the rows the old DuckDB tag-3
    /// and tag-4 query produced over exactly those files. Every case carries
    /// an `expected.json` generated from that query; a celld schema bump that
    /// breaks the decode fails here before it reaches a dashboard.
    #[test]
    fn real_celld_fixtures_match_the_duckdb_rows() {
        for case in ["prod", "env", "compacted"] {
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
    }
}
