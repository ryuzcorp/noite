//! Durable compaction (spec T3.5) of completed hours, and the watermark that
//! keeps it from running twice.

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::{exec, s3, stats};

use super::plan::{s3_setup, telemetry_prefix};
use super::MetricsState;

/// Split one hour directory's keys into `(already_compacted, foldable
/// sources)`. A compacted file plus extra sources means a flush landed after
/// (or during) the last compaction: the extras are late arrivals, not
/// leftovers, and must be folded in — never deleted unread.
fn compaction_plan(keys: &[String], target: &str) -> (bool, Vec<String>) {
    let has_target = keys.iter().any(|k| k == target);
    let sources = keys
        .iter()
        .filter(|k| k.as_str() != target)
        .cloned()
        .collect();
    (has_target, sources)
}

/// What one pass over an hour directory must do: `None` when there is nothing
/// to fold, otherwise the exact input list for the re-COPY. The existing
/// target always leads the inputs when it exists, so a flush that landed
/// between COPY and delete — or after a completed compaction — is folded
/// into the compacted file instead of being destroyed unread.
fn compaction_inputs(keys: &[String], target: &str) -> Option<Vec<String>> {
    let (has_target, sources) = compaction_plan(keys, target);
    if has_target {
        if sources.is_empty() {
            return None;
        }
        let mut inputs = Vec::with_capacity(sources.len() + 1);
        inputs.push(target.to_string());
        inputs.extend(sources);
        Some(inputs)
    } else if sources.len() < 2 {
        None
    } else {
        Some(sources)
    }
}

/// `yyyy/mm/dd/hh` for a timestamp, as celld partitions telemetry.
pub(super) fn hour_dir(us: i64) -> String {
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
pub(super) async fn compact_fleet(cfg: &Config, slug: &str, hour: &str) -> anyhow::Result<usize> {
    let mut compacted = 0_usize;
    let prefix = telemetry_prefix(slug);
    for (kind, sort_col) in [("traces", "start_unix_us"), ("logs", "time_unix_us")] {
        let root = format!("{prefix}/telemetry/{kind}/");
        let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &root).await?;
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
            let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &dir).await?;
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
            // Nothing to fold: a lone compacted file is stable, and one
            // source is already one file.
            let Some(inputs) = compaction_inputs(&keys, &target) else {
                continue;
            };
            copy_union(cfg, &dir, &target, &inputs, sort_col).await?;
            s3::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
            compacted += 1;
        }
    }
    Ok(compacted)
}

/// COPY the union of `inputs` into `target`, proved with a HEAD before the
/// caller deletes anything. When `target` is itself one of the inputs (a
/// re-fold of late arrivals), the COPY goes to a staging key first: DuckDB
/// streams the read, so writing the file it reads would corrupt the hour.
/// The staging key never ends in `.parquet`, so neither the ingest globs
/// (`*.parquet`) nor another compact pass can see it mid-write; the final
/// `rm_dir_except` (keep `compacted.parquet`) removes it along with the
/// folded sources.
async fn copy_union(
    cfg: &Config,
    dir: &str,
    target: &str,
    inputs: &[String],
    sort_col: &str,
) -> anyhow::Result<()> {
    let refold = inputs.iter().any(|k| k == target);
    let dest = if refold {
        format!("{dir}compacted.staging-{}", uuid::Uuid::new_v4())
    } else {
        target.to_string()
    };
    let list = inputs
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
            cfg.s3_bucket, dest,
        ),
    );
    stats::count_duckdb("compact");
    exec::run_cmd(
        "/usr/local/bin/duckdb",
        &["-c", &sql],
        None,
        &[],
        std::time::Duration::from_secs(120),
    )
    .await?;
    if !s3::s3_object_exists(cfg, &cfg.s3_bucket, &dest).await {
        anyhow::bail!("compacted object missing after copy: {dest}");
    }
    if refold {
        // Publish complete-over-complete: the staging object is whole (HEAD
        // proved), so promoting it keeps a compacted file in the hour at
        // every instant — a crash leaves the old target plus staging, which
        // the next pass re-folds instead of deleting.
        s3::s3_copy_key(cfg, &cfg.s3_bucket, &dest, target).await?;
        if !s3::s3_object_exists(cfg, &cfg.s3_bucket, target).await {
            anyhow::bail!("compacted object missing after promote: {target}");
        }
    }
    Ok(())
}

/// Completed, uncompacted hours in `(done, current)`, oldest first.
/// `done` is the durable watermark (exclusive), `current` the running hour
/// (exclusive — never compact it). Bounded so one pass cannot name the whole
/// retention after a long outage; unparseable input compacts nothing.
pub(super) fn uncompacted_hours(done: Option<&String>, current: &str, cfg: &Config) -> Vec<String> {
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

pub(super) async fn mark_compacted(
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
    fn uncompacted_hours_never_names_the_running_hour() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
        // A flush that landed after (or during) the last compaction leaves
        // both: the extras are late arrivals, folded back in — never deleted
        // unread.
        let (has, sources) = compaction_plan(&[target.clone(), src("a")], &target);
        assert!(has);
        assert_eq!(sources, vec![src("a")]);
    }

    /// Late sources are re-folded, never dropped: a pass over
    /// `[compacted, late]` must COPY both into the target. The old code
    /// deleted `late` here, so spans flushed mid-pass were destroyed unread —
    /// this test fails on that behavior (no inputs to copy).
    #[test]
    fn late_sources_are_refolded_not_deleted() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // A flush landing between COPY and delete, or after a completed
        // compaction: the target leads the COPY inputs, the late source
        // follows — every byte stays in the hour.
        let inputs = compaction_inputs(&[target.clone(), src("late")], &target)
            .expect("late source must be folded");
        assert_eq!(inputs, vec![target.clone(), src("late")]);
        // Stable hour: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&target), &target).is_none());
        // One source is already one file: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&src("only")), &target).is_none());
        // Fresh hour: every source is folded.
        let inputs = compaction_inputs(&[src("a"), src("b")], &target).expect("fresh fold");
        assert_eq!(inputs, vec![src("a"), src("b")]);
    }
}
