//! Durable compaction (spec T3.5) of completed hours, and the watermark that
//! keeps it from running twice.

use std::collections::HashMap;

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
        .map(|k| super::plan::sql_lit(&format!("s3://{}/{}", cfg.s3_bucket, k)))
        .collect::<Vec<_>>()
        .join(", ");
    let destination = super::plan::sql_lit(&format!("s3://{}/{}", cfg.s3_bucket, dest));
    let sql = s3_setup(
        cfg,
        &format!(
            // union_by_name: the docs call the telemetry schema
            // `v0-unstable`, so an hour that spans a node upgrade can
            // hold two shapes — merge them instead of refusing the
            // whole hour (sources are only deleted after the copy).
            "COPY (SELECT * FROM read_parquet([{list}], union_by_name=true) ORDER BY {sort_col}) \
               TO {destination} (FORMAT parquet, COMPRESSION zstd);",
        ),
    );
    stats::count_duckdb("compact");
    // SQL on stdin, never argv: it carries the store secret.
    let copied = exec::run_cmd_stdin(
        "/usr/local/bin/duckdb",
        &[],
        sql.as_bytes(),
        None,
        &[],
        std::time::Duration::from_secs(120),
    )
    .await;
    if let Err(error) = copied {
        // A killed copy leaves its spill behind; stale bytes count against
        // the cap and would wedge later passes.
        super::plan::sweep_spill(cfg, super::plan::SPILL_SWEEP_AGE);
        return Err(super::plan::redact_store_keys(error, cfg));
    }
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

/// One completed hour's durable compaction state. The unit of progress is the
/// hour, not a per-fleet high-water mark: a failed hour can never be skipped,
/// because only *that hour* is marked when its fold succeeds.
///
/// stateDiagram-v2
///   [*] --> Pending
///   Pending --> Compacted: fold ok
///   Pending --> Failed: fold error
///   Failed --> Pending: retry window elapsed
///   Failed --> Compacted: fold ok on retry
#[derive(Debug, Clone, Default)]
pub(super) struct CompactionState {
    hours: HashMap<String, HourState>,
    /// The newest hour of the contiguous compacted run. Compaction schedules
    /// from `done + 1` and stops at the first hour that is not ready, so a
    /// failure can never be jumped over.
    done: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HourState {
    Compacted,
    /// The fold failed; retried once this instant has passed. An hour in this
    /// state is never treated as done.
    Failed {
        retry_at: std::time::Instant,
    },
}

/// How long a failed hour waits before the next attempt. Same shape as the
/// ingest backoff: long enough that a broken bucket does not burn every pass,
/// short enough that a transient S3/DuckDB error heals within minutes.
const COMPACTION_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(120);

impl CompactionState {
    /// Restore the durable per-hour marks loaded at boot.
    pub(super) fn restored(hours: impl IntoIterator<Item = String>) -> Self {
        let hours: HashMap<String, HourState> = hours
            .into_iter()
            .map(|hour| (hour, HourState::Compacted))
            .collect();
        let done = hours.keys().max().cloned();
        Self { hours, done }
    }

    fn next_after(done: &str) -> Option<String> {
        chrono::NaiveDateTime::parse_from_str(&format!("{done}:00:00"), "%Y/%m/%d/%H:%M:%S")
            .ok()
            .and_then(|at| at.checked_add_signed(chrono::Duration::hours(1)))
            .map(|at| at.format("%Y/%m/%d/%H").to_string())
    }

    fn is_due(&self, hour: &str, now: std::time::Instant) -> bool {
        match self.hours.get(hour) {
            None => true,
            Some(HourState::Compacted) => false,
            Some(HourState::Failed { retry_at }) => retry_at <= &now,
        }
    }

    /// Transition `Pending -> Compacted`. The cursor advances only when the
    /// folded hour is exactly the next one, so a write can never skip an
    /// earlier hour.
    fn folded(&mut self, hour: &str) {
        let earlier = self.hours.keys().any(|h| h.as_str() < hour);
        self.hours.insert(hour.to_string(), HourState::Compacted);
        let advances = match &self.done {
            Some(done) => Self::next_after(done).as_deref() == Some(hour),
            // A first fold only opens the cursor when nothing earlier is
            // still tracked (a failed earlier hour must stay ahead of it).
            None => !earlier,
        };
        if advances {
            self.done = Some(hour.to_string());
        }
    }

    /// Transition `Pending -> Failed`. A failed hour is retried after
    /// [`COMPACTION_RETRY_BACKOFF`]; it never becomes `Compacted`.
    fn failed(&mut self, hour: &str, now: std::time::Instant) {
        self.hours.insert(
            hour.to_string(),
            HourState::Failed {
                retry_at: now + COMPACTION_RETRY_BACKOFF,
            },
        );
    }

    /// Drop marks older than the retention window (they can never be due).
    fn prune_before(&mut self, hour: &str) {
        self.hours.retain(|h, _| h.as_str() >= hour);
        if self.done.as_deref().is_some_and(|done| done < hour) {
            self.done = Some(hour.to_string());
        }
    }
}

/// Completed hours that still need a fold, oldest first. Scheduling starts
/// after the contiguous `done` cursor (or the last 25 hours on a fresh fleet)
/// and stops at the first non-ready hour: a failed hour blocks the hours
/// behind it until its retry, so the cursor can never skip it. Bounded so one
/// pass cannot name the whole retention; unparseable input compacts nothing.
pub(super) fn uncompacted_hours(
    state: &CompactionState,
    current: &str,
    cfg: &Config,
) -> Vec<String> {
    let parse = |h: &str| {
        chrono::NaiveDateTime::parse_from_str(&format!("{h}:00:00"), "%Y/%m/%d/%H:%M:%S").ok()
    };
    let Some(current_dt) = parse(current) else {
        return Vec::new();
    };
    let floor =
        chrono::Utc::now().naive_utc() - chrono::Duration::days(cfg.telemetry_retention_days);
    let mut start = match state.done.as_deref().and_then(parse) {
        Some(done) => done + chrono::Duration::hours(1),
        // No mark: only the recent past, not the whole retention.
        None => current_dt - chrono::Duration::hours(25),
    };
    if start < floor {
        start = floor;
    }
    let now = std::time::Instant::now();
    let mut hours = Vec::new();
    while start < current_dt && hours.len() < 48 {
        let hour = start.format("%Y/%m/%d/%H").to_string();
        if state.hours.get(&hour) == Some(&HourState::Compacted) {
            // Already folded (only possible below a restored cursor).
        } else if state.is_due(&hour, now) {
            hours.push(hour);
        } else {
            // A failed hour is backing off: later hours wait their turn.
            break;
        }
        let Some(next) = start.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        start = next;
    }
    hours
}

/// Transition `Pending -> Failed` for one hour: it is retried after the
/// backoff and, crucially, is not marked compacted.
pub(super) fn mark_failed(state: &mut MetricsState, slug: &str, hour: &str) {
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .failed(hour, std::time::Instant::now());
}

/// Drop in-memory marks that fell out of the retention window.
pub(super) fn prune_marks(state: &mut MetricsState, oldest_hour: &str) {
    for fleet in state.compacted.values_mut() {
        fleet.prune_before(oldest_hour);
    }
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
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .folded(hour);
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
        // Hours relative to now: the retention floor (`Utc::now() - retention`)
        // moves with the wall clock, so fixed dates rot — the hardcoded
        // 2026/09/29 started failing exactly 30 days later (2026-10-29).
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let done = hour(now - chrono::Duration::hours(2));
        let mut state = CompactionState::default();
        state.folded(&done);
        // Compacted two hours back → only the previous hour is pending; a
        // marked hour is never named again.
        assert_eq!(
            uncompacted_hours(&state, &current, &cfg),
            vec![hour(now - chrono::Duration::hours(1))]
        );
        state.folded(&hour(now - chrono::Duration::hours(1)));
        assert!(uncompacted_hours(&state, &current, &cfg).is_empty());
        // Garbage input compacts nothing.
        assert!(uncompacted_hours(&state, "not-an-hour", &cfg).is_empty());
    }

    /// P1: a failed hour must never be skipped because a later hour folded.
    /// The old per-fleet watermark advanced past the failure, so `h` was
    /// never revisited. Per-hour state keeps `h` due and only marks `h + 1`.
    #[test]
    fn a_failed_hour_stays_due_when_a_later_hour_folds() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let failed = hour(now - chrono::Duration::hours(2));
        let later = hour(now - chrono::Duration::hours(1));
        let mut state = CompactionState::default();
        state.failed(&failed, std::time::Instant::now());
        state.folded(&later);
        // The failed hour is retried once its backoff elapses; the folded
        // hour is never named.
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(!pending.contains(&later), "{pending:?}");
        // Backoff elapses (injected by rebuilding the failure with a past
        // retry instant through the same transition).
        state.hours.insert(
            failed.clone(),
            HourState::Failed {
                retry_at: std::time::Instant::now(),
            },
        );
        assert!(uncompacted_hours(&state, &current, &cfg).contains(&failed));
    }

    /// Folding an hour only marks that hour: an older failed hour is still
    /// pending, and a gap below the newest mark is revisited.
    #[test]
    fn folding_never_advances_a_watermark_past_a_gap() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let gap = hour(now - chrono::Duration::hours(3));
        let older = hour(now - chrono::Duration::hours(4));
        let mut state = CompactionState::default();
        state.folded(&older);
        state.folded(&hour(now - chrono::Duration::hours(2)));
        state.folded(&hour(now - chrono::Duration::hours(1)));
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(
            pending.contains(&gap),
            "the hole below the newest mark is due"
        );
        assert!(
            !pending.contains(&hour(now - chrono::Duration::hours(1))),
            "a compacted hour is never scheduled again"
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
