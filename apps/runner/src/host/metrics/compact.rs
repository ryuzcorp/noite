//! Durable compaction (spec T3.5) of completed hours, and the watermark that
//! keeps it from running twice.

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::{exec, s3, stats};

use super::plan::{s3_setup, telemetry_prefix};
use super::MetricsState;

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
            // A previous run wrote the compacted file but its source delete
            // did not finish. The compacted file was copied from every source,
            // and the ingest reads an hour from the compacted file alone when
            // it exists, so dropping the leftovers is safe and leaves the
            // directory in its stable one-file shape.
            let (has_target, sources) = compaction_plan(&keys, &target);
            if has_target {
                if !sources.is_empty() {
                    s3::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
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
            exec::run_cmd(
                "/usr/local/bin/duckdb",
                &["-c", &sql],
                None,
                &[],
                std::time::Duration::from_secs(120),
            )
            .await?;
            if !s3::s3_object_exists(cfg, &cfg.s3_bucket, &target).await {
                anyhow::bail!("compacted object missing after copy: {target}");
            }
            s3::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
            compacted += 1;
        }
    }
    Ok(compacted)
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

pub(super) async fn mark_compacted(pool: &SqlitePool, state: &mut MetricsState, slug: &str, hour: &str) {
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
        // An interrupted source delete leaves both: the compacted file is
        // authoritative and the leftovers are removed, never read.
        let (has, sources) = compaction_plan(&[target.clone(), src("a")], &target);
        assert!(has);
        assert_eq!(sources, vec![src("a")]);
    }
}
