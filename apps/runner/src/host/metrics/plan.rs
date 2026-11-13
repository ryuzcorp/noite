//! Ingest chunk planning: what window to read, which hour directories name it,
//! and how a failed fleet is backed off. The Parquet listing and decode live
//! in [`super::otel`].

use crate::config::Config;

use super::cpu::otel_flush_ms;
use super::MetricsState;

/// Bucket prefix one telemetry source writes under. The key is a fleet key:
/// a production slug maps to its celld `--bucket` (`fleets/<slug>`), an
/// environment's `{slug}.{label}` fleet key to its own `--bucket`
/// (`envs/<slug>/<label>`), and the control fleet's `--bucket` is `control`,
/// so its traces and logs land at `control/telemetry/...` — the control
/// prefix, never `fleets/_control`.
///
/// Slugs are runner-generated (`[a-z0-9-]`, never a dot), so the first dot
/// splits a fleet key into its environment. Environment telemetry lands at
/// `envs/<slug>/<label>/telemetry/...` and ingests exactly like production.
pub(super) fn telemetry_prefix(fleet_key: &str) -> String {
    if fleet_key == crate::host::control::SLUG {
        "control".to_string()
    } else if let Some((slug, label)) = fleet_key.split_once('.') {
        format!("envs/{slug}/{label}")
    } else {
        format!("fleets/{fleet_key}")
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
/// single read and its SQLite writes bounded; a 30-day backlog is ~30 chunks.
const CATCHUP_CHUNK_HOURS: i64 = 24;

/// Hour-chunks one ingest pass commits. Bounds how long an outage catch-up can
/// hold the reconcile loop: a pass runs once per flush interval (30 s by
/// default) and commits one chunk per fleet per iteration, so a 30-day gap
/// takes ~15 passes.
pub(super) const MAX_CHUNKS_PER_PASS: usize = 2;

/// How long a fleet whose chunk failed waits before the runner retries it.
/// Long enough that a persistently broken fleet does not fail the shared pass
/// every tick, short enough that a transient S3 error heals quickly.
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

/// Hour-aligned windows covering `[max(after_us, floor_us), cutoff_us)`, at
/// most `max_chunks` of them. Complete hours are `CATCHUP_CHUNK_HOURS` wide;
/// the hour the cutoff falls in is always last and may be partial (`until_us`
/// == cutoff_us). The ingest REPLACES every window it reads, so the tiling
/// only decides how much one pass reads — never what is counted.
pub(super) fn plan_chunks(
    after_us: i64,
    cutoff_us: i64,
    floor_us: i64,
    max_chunks: usize,
) -> Vec<(i64, i64)> {
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

/// The hour directories one fleet's window touches, as celld partitions them
/// (`telemetry/{kind}/<node>/<yyyy>/<mm>/<dd>/<hh>/`). A tick names only the
/// hours its window touches instead of the whole retention (a 30 s window
/// names one or two hour directories); the node stays a wildcard so history
/// written by an earlier node id still reads.
///
/// The walk and its clamps are the old glob expansion's, so a chunk covers
/// exactly the files the old glob named: start floored to the hour (a
/// window that starts mid-hour must still read its trailing partial hour),
/// clamped to the retention floor (celld has already deleted older objects),
/// and bounded to `retention_days * 24 + 1` hours so a stale watermark after
/// a long outage cannot name thousands of directories.
pub(super) fn telemetry_hours(cfg: &Config, from_us: i64, to_us: i64) -> Vec<String> {
    let Some(mut hour) = chrono::DateTime::from_timestamp_micros(from_us.max(0)) else {
        return Vec::new();
    };
    let Some(last) = chrono::DateTime::from_timestamp_micros(to_us.max(0)) else {
        return Vec::new();
    };
    let floor = chrono::Utc::now() - chrono::Duration::days(cfg.telemetry_retention_days);
    if hour < floor {
        hour = floor;
    }
    let truncated = hour.timestamp().div_euclid(3600) * 3600;
    if let Some(t) = chrono::DateTime::from_timestamp_secs(truncated) {
        hour = t;
    }
    let mut hours = Vec::new();
    let max_hours = (cfg.telemetry_retention_days * 24 + 1) as usize;
    while hour <= last && hours.len() < max_hours {
        hours.push(hour.format("%Y/%m/%d/%H").to_string());
        let Some(next) = hour.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        hour = next;
    }
    hours
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::super::now_us;

    const H: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z in micros
    const HOUR_US: i64 = 3_600_000_000;

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
        // An environment's `{slug}.{label}` fleet key is its own `--bucket`
        // (`envs/<slug>/<label>`), never production's.
        assert_eq!(telemetry_prefix("blog.preview"), "envs/blog/preview");
    }

    #[test]
    fn hour_walk_tiles_the_window_and_clamps_to_retention() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut cfg = crate::config::Config::from_env().expect("config");
        cfg.telemetry_retention_days = 30;
        let now = now_us();
        let (from, to) = (now - HOUR_US, now);
        let hours = telemetry_hours(&cfg, from, to);
        // Two hour directories: the one we started in and the current one.
        assert_eq!(hours.len(), 2, "{hours:?}");
        assert_eq!(
            hours[0],
            chrono::DateTime::from_timestamp_micros(from)
                .expect("hour")
                .format("%Y/%m/%d/%H")
                .to_string()
        );
        // A window that ends exactly on an hour boundary names that hour.
        let boundary = floor_hour_us(now);
        assert_eq!(telemetry_hours(&cfg, boundary - HOUR_US, boundary).len(), 2);
        // A window wholly inside one hour names one directory.
        assert_eq!(telemetry_hours(&cfg, boundary, boundary + 1).len(), 1);
        // Starting mid-hour still reaches the trailing partial hour: the walk
        // is hour-aligned, so a boundary-crossing window is never truncated.
        let mid = boundary + 60_000_000;
        assert_eq!(telemetry_hours(&cfg, mid, boundary + HOUR_US + 1).len(), 2);
        // A stale watermark older than retention clamps to the floor instead
        // of naming months of directories; the cap is retention*24+1.
        let ancient = now - 400 * 86_400_000_000;
        assert_eq!(
            telemetry_hours(&cfg, ancient, now).len(),
            (30 * 24 + 1) as usize
        );
        // A window wholly older than the floor names nothing: celld deleted
        // those objects already, and the old glob expansion returned no file
        // for the same reason.
        let old = now - 31 * 86_400_000_000;
        assert!(telemetry_hours(&cfg, old, old + HOUR_US).is_empty());
    }

    /// Preview environments write their telemetry under `envs/<slug>/<label>/`
    /// (their own `--bucket`), listed from the environment's own fleet key —
    /// so an environment's rows land on the environment, never on the app.
    #[test]
    fn telemetry_prefix_follows_the_source_bucket_for_every_kind() {
        assert_eq!(telemetry_prefix(crate::host::control::SLUG), "control");
        assert_eq!(telemetry_prefix("blog"), "fleets/blog");
        assert_eq!(telemetry_prefix("blog.preview"), "envs/blog/preview");
        // The hour walk itself is prefix-agnostic; the reader joins the two
        // (see `otel::chunk_files`) and a production fleet can never name an
        // environment's directory because `telemetry_prefix` never yields one.
        assert!(!telemetry_prefix("blog").contains("envs/"));
        assert!(telemetry_prefix("blog.preview").contains("envs/blog/preview"));
    }
}
