//! Ingest chunk planning, fleet globs and DuckDB query building: what window
//! to read, which Parquet files name it, and how to run the query.

use crate::config::Config;
use crate::host::{exec, stats};

use super::cpu::otel_flush_ms;
use super::MetricsState;

fn endpoint_host(endpoint: &str) -> String {
    endpoint
        .strip_prefix("http://")
        .or(endpoint.strip_prefix("https://"))
        .unwrap_or(endpoint)
        .to_string()
}

/// Coerce a DuckDB JSON field to i64 — the -json writer emits BIGINT sums as
/// STRINGS ("51644") and small integers as numbers (4). Handle both.
pub(super) fn json_i64(v: &serde_json::Value, key: &str) -> i64 {
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
pub(super) fn s3_setup(cfg: &Config, query: &str) -> String {
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

/// Bucket prefix one telemetry source writes under. Tenant fleets use their
/// celld `--bucket` (`fleets/<slug>`); the control fleet's `--bucket` is
/// `control`, so its traces and logs land at `control/telemetry/...` — the
/// control prefix, never `fleets/_control`.
pub(super) fn telemetry_prefix(slug: &str) -> String {
    if slug == crate::host::control::SLUG {
        "control".to_string()
    } else {
        format!("fleets/{slug}")
    }
}

/// How far behind the flush the ingest window stops. Derived as
/// `flush + 10 s` (spec T3.4): it must exceed the flush interval, or a late
/// file could land inside an already-counted minute.
pub(super) fn agg_lag_us(cfg: &Config) -> i64 {
    otel_flush_ms(cfg) as i64 * 1000 + 10_000_000
}

/// Microsecond timestamp floored to its hour — the granularity the ingest
/// works in (celld partitions files by hour, and a chunk is whole hours plus
/// the partial hour the cutoff falls in).
pub(super) fn floor_hour_us(us: i64) -> i64 {
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
pub(super) const MAX_CHUNKS_PER_PASS: usize = 2;

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
pub(super) fn ingest_after(
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
pub(super) fn back_off_ingest(state: &mut MetricsState, slug: &str, from: i64) {
    state.ingest_backoff.insert(
        (slug.to_string(), from),
        std::time::Instant::now() + INGEST_RETRY_BACKOFF,
    );
}

pub(super) fn ingest_backed_off(state: &MetricsState, slug: &str, from: i64) -> bool {
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
pub(super) fn plan_chunks(after_us: i64, cutoff_us: i64, floor_us: i64, max_chunks: usize) -> Vec<(i64, i64)> {
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

/// Parquet globs for one fleet's telemetry over `[from_us, to_us]`. celld
/// partitions the files by node and by hour
/// (`telemetry/{kind}/<node>/<yyyy>/<mm>/<dd>/<hh>/<id>.parquet`), and DuckDB
/// opens every file a glob names — so a tick names only the hours its window
/// touches instead of the whole retention (a 10 s window names one or two
/// hour directories). The node stays a wildcard so history written by an
/// earlier node id still aggregates.
pub(super) fn telemetry_globs(cfg: &Config, slug: &str, kind: &str, from_us: i64, to_us: i64) -> Vec<String> {
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

pub(super) async fn duckdb_json(sql: &str, purpose: &str) -> anyhow::Result<String> {
    stats::count_duckdb(purpose);
    exec::run_cmd(
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
pub(super) fn is_idle_telemetry_err(err: &anyhow::Error) -> bool {
    let msg = err.to_string();
    msg.contains("No files found") || msg.contains("needs at least one file")
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::now_us;

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
}
