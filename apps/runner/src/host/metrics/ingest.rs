//! One ingest chunk: the replace-only writers and the per-fleet fault
//! isolation around a shared read. The read itself (celld's Parquet, decoded
//! in-process) lives in [`super::otel`].

use std::collections::{HashMap, HashSet};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::errors;

use super::MetricsState;

/// The two result sets one ingest chunk carries: the fleet's newest log lines
/// and its failed-span groups. The minute counters and hourly span stats the
/// old four-tag query also produced are gone — nothing reads them since
/// the hourly counters replaced the Metrics tab.
#[derive(Clone)]
pub(super) struct IngestRows {
    pub logs: Vec<errors::LogRow>,
    pub errors: Vec<errors::SpanErrorRow>,
}

impl IngestRows {
    pub(super) fn empty() -> Self {
        IngestRows {
            logs: Vec::new(),
            errors: Vec::new(),
        }
    }
}

/// Fleet identity maps for one tick, built once by `telemetry_fleets` (plus
/// the deploy SHAs): fleet key -> app id, fleet key -> environment id
/// (absent means production), fleet key -> last deploy sha.
pub(super) struct FleetKeys {
    pub(super) ids: HashMap<String, String>,
    pub(super) envs: HashMap<String, String>,
    pub(super) shas: HashMap<String, String>,
}

/// What a committed chunk changed: the (app id, environment id) pairs whose
/// dashboards must re-read, and whether the log stream should wake.
pub(super) struct ChunkWrites {
    pub(super) touched: HashSet<(String, String)>,
    pub(super) new_logs: bool,
}

/// Persist one ingest chunk with replace semantics, then report what the tick
/// still has to do. Every table is rewritten for the chunk's window: a re-read
/// — a retry after a failure, or a replay — leaves the same rows instead of
/// doubling them, which is exactly why the caller may advance the watermarks
/// only after this returns `Ok`.
async fn write_ingest_rows(
    pool: &SqlitePool,
    keys: &FleetKeys,
    bounds: &[(String, i64, i64)],
    rows: IngestRows,
    requests: &mut errors::RequestIndex,
    prune_logs_before_us: i64,
) -> anyhow::Result<ChunkWrites> {
    let slug_id = &keys.ids;
    let env_of = |slug: &str| -> &str { keys.envs.get(slug).map(String::as_str).unwrap_or("") };
    let mut touched: HashSet<(String, String)> = HashSet::new();
    // Errors before the log ring takes the rows: an occurrence keeps the log
    // lines of its own trace (host/errors.rs).
    touched.extend(
        errors::ingest(
            pool,
            &keys.ids,
            &keys.envs,
            &keys.shas,
            &rows.errors,
            &rows.logs,
            requests,
        )
        .await?,
    );
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
        let env_id = env_of(&slug);
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
        db::replace_app_logs(pool, id, env_id, *from, *until, &log_rows).await?;
        // Bounded ring per app and environment: last 24 h AND last 2,000 lines.
        let _ = db::prune_app_logs(pool, id, env_id, prune_logs_before_us, 2000).await;
        touched.insert((id.clone(), env_id.to_string()));
        new_logs = true;
    }
    Ok(ChunkWrites { touched, new_logs })
}

/// Persist one chunk, then advance and persist the fleets' watermarks. The
/// watermark moves only when every write succeeded: a failure returns `Err`
/// with the watermarks untouched, so the chunk is retried — exact, because the
/// writers replace. Kept as one call so the "failed pass never advances the
/// watermark" rule is testable without a Parquet read.
pub(super) async fn commit_chunk(
    pool: &SqlitePool,
    state: &mut MetricsState,
    keys: &FleetKeys,
    bounds: &[(String, i64, i64)],
    rows: IngestRows,
    prune_logs_before_us: i64,
) -> anyhow::Result<ChunkWrites> {
    let writes = write_ingest_rows(
        pool,
        keys,
        bounds,
        rows,
        &mut state.requests,
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

/// One chunk pass: list the chunk's hour directories, decode the objects and
/// aggregate them. Abstracted so the fault-isolation policy — a broken fleet
/// must not hold the other fleets' watermarks — stays testable without S3.
pub(super) trait ChunkPass {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows>;
}

pub(super) struct ParquetPass<'a>(pub(super) &'a Config);

impl ChunkPass for ParquetPass<'_> {
    async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
        super::otel::ingest_all(self.0, bounds).await
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
                out.push((vec![bound.clone()], pass.pass(one).await));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests;
