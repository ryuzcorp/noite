//! The reconcile tick's telemetry pass, one named step per concern:
//! sample CPU (1), ingest chunks (2), access log (3), compaction (3b),
//! persist versions + wake the log stream (4), prune (5) — same order, same
//! error handling, same watermark semantics as the single-function original.
//! The idempotency rule lives in `ingest::commit_chunk`: a failed pass never
//! advances the watermark.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::accesslog;
use crate::host::supervisor::ProcMap;
use crate::models::{App, AppStatus};

use super::compact::{compact_fleet, hour_dir, mark_compacted, uncompacted_hours};
use super::cpu::{otel_flush_ms, sample_cpu};
use super::ingest::{collect_chunk_results, commit_chunk, DuckdbPass};
use super::plan::{
    agg_lag_us, back_off_ingest, floor_hour_us, ingest_after, ingest_backed_off, plan_chunks,
    MAX_CHUNKS_PER_PASS,
};
use super::{minute_bucket_now, now_us, MetricsState};

pub async fn tick(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    control_pid: u32,
    state: &mut MetricsState,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    let apps = db::list_apps(pool).await?;
    let slug_id = telemetry_fleets(&apps);
    // T1.3: aggregation only covers fleets with a live process. A stopped
    // app's sealed Parquet needs no re-scan every 10 s; its status mirrors
    // the supervisor (ensure_fleet marks Running, stop marks Stopped), and
    // the procs map confirms the process is actually there. The control node
    // is not in that map either, so its pid slot answers the same question.
    let live_slugs: HashSet<String> = procs.lock().await.keys().cloned().collect();

    let cpu = sample_cpu_step(procs, control_pid, state, &slug_id);
    let (mut touched, new_logs) =
        ingest_step(pool, cfg, state, &slug_id, &apps, &live_slugs, control_pid).await;
    accesslog_step(pool, cfg, &slug_id, state).await;
    compact_step(pool, cfg, state, &slug_id).await;
    persist_step(pool, &cpu, &mut touched, new_logs, log_tx).await?;
    prune_step(pool, cfg, state).await;
    Ok(())
}

/// The fleets that have telemetry: deployed apps plus the control plane.
///
/// Only deployed fleets have telemetry and a running celld — never-deployed
/// apps are excluded so we don't spawn duckdb (and sample CPU) for every
/// created-but-empty slug every cycle. The control fleet is a telemetry
/// source with no `app` row, on purpose: nothing that iterates apps
/// (reconcile, Caddy, sleep, purge, list_apps) may see the control plane, yet
/// its traces, logs and errors belong on the same dashboards. Its rows key on
/// the reserved slug (`host::control::SLUG`) and its Parquet lives under
/// `control/telemetry/...` (see `plan::telemetry_prefix`). Always present:
/// the access-log attribution and the error index read the same map, and a
/// dev image without a control celld simply has nothing to ingest
/// (`ingest_after` sees it as not live).
fn telemetry_fleets(apps: &[App]) -> HashMap<String, String> {
    let mut slug_id: HashMap<String, String> = apps
        .iter()
        .filter(|a| a.status == AppStatus::Running.as_str() || a.last_deploy_sha.is_some())
        .map(|a: &App| (a.slug.clone(), a.id.clone()))
        .collect();
    slug_id.insert(
        crate::host::control::SLUG.to_string(),
        crate::host::control::SLUG.to_string(),
    );
    slug_id
}

/// Step 1 — CPU deltas since the last sample (100 ticks/sec → *10 = ms). CPU is
/// sampled per tick and accumulates; telemetry usage is recomputed per chunk
/// and replaced, so the two never share a writer.
fn sample_cpu_step(
    procs: &ProcMap,
    control_pid: u32,
    state: &mut MetricsState,
    slug_id: &HashMap<String, String>,
) -> HashMap<(String, String), i64> {
    // (id, bucket) -> ms
    let mut cpu: HashMap<(String, String), i64> = HashMap::new();
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
    cpu
}

/// Step 2 — ingest in hour-chunks (spec T3.1), at most once per flush interval
/// (spec T3.4) — not every reconcile tick. Each chunk recomputes whole hours
/// (plus the partial current hour) and REPLACES their aggregates, so
/// re-reading is exact: a retry, a catch-up after downtime, and a replay are
/// all the same operation. The window stops agg_lag behind now so every
/// minute bucket it names has closed. Stopped apps are skipped: nothing new
/// lands in their buckets. Returns the app ids with new rows and whether the
/// log stream should wake.
async fn ingest_step(
    pool: &SqlitePool,
    cfg: &Config,
    state: &mut MetricsState,
    slug_id: &HashMap<String, String>,
    apps: &[App],
    live_slugs: &HashSet<String>,
    control_pid: u32,
) -> (HashSet<String>, bool) {
    state.tick += 1;
    let lag = agg_lag_us(cfg);
    let due = state
        .last_ingest
        .map(|t| t.elapsed().as_millis() >= otel_flush_ms(cfg) as u128)
        .unwrap_or(true);
    let mut touched: HashSet<String> = HashSet::new(); // app ids with new rows
    let mut new_logs = false;
    if !due {
        return (touched, new_logs);
    }
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
    let live = |slug: &str| {
        if slug == crate::host::control::SLUG {
            control_pid != 0
        } else {
            live_slugs.contains(slug)
        }
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
            match commit_chunk(pool, state, slug_id, &app_sha, &chunk, rows, cutoff - 86_400_000_000)
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
            Some(s) => !slug_id.contains_key(s) || state.watermark.get(s).is_none_or(|w| *w >= hour),
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
    (touched, new_logs)
}

/// Step 3 — Caddy access log → device families, plus the trace → request index the
/// error ingest joins on. Never fails the tick: a missing log (Caddy not yet
/// reloaded) or a corrupt line is a silent skip.
async fn accesslog_step(
    pool: &SqlitePool,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    state: &mut MetricsState,
) {
    if let Err(e) = accesslog::tick(pool, cfg, slug_id, &mut state.requests).await {
        tracing::warn!(error = %e, "access_log");
    }
}

/// Step 3b — durable compaction (spec T3.5): every completed hour since the durable
/// watermark, oldest first, bounded per pass so a long outage catches up
/// gradually. Never the current hour. Stopped fleets are covered the same way
/// — each of their hours compacts exactly once, including the hour they
/// stopped in — so no separate stopped set.
async fn compact_step(
    pool: &SqlitePool,
    cfg: &Config,
    state: &mut MetricsState,
    slug_id: &HashMap<String, String>,
) {
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
}

/// Step 4 — persist sampled CPU (telemetry usage was replaced per chunk above),
/// then dashboard versions (spec T3.6) and log wakeups (spec T3.3): polls
/// skip unchanged windows, the log stream wakes instead of re-scanning.
/// The watermarks advanced (and persisted) per committed chunk in
/// `commit_chunk`, so a restart resumes there; a crash before a chunk's writes
/// re-reads the chunk, which the replace writers make exact.
async fn persist_step(
    pool: &SqlitePool,
    cpu: &HashMap<(String, String), i64>,
    touched: &mut HashSet<String>,
    new_logs: bool,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    for ((id, bucket), ms) in cpu {
        if *ms > 0 {
            db::add_app_metric_cpu(pool, id, bucket, *ms).await?;
            touched.insert(id.clone());
        }
    }
    for id in touched.iter() {
        if let Err(e) = db::bump_metric_version(pool, id).await {
            tracing::warn!(error = %e, "version bump");
        }
    }
    if new_logs {
        log_tx.send_modify(|v| *v += 1);
    }
    Ok(())
}

/// Step 5 — prune old buckets, roughly every 100 ticks: expire the compaction
/// retry marks and ingest back-offs, then drop rows past the retention window
/// from every metrics table.
async fn prune_step(pool: &SqlitePool, cfg: &Config, state: &mut MetricsState) {
    if !state.tick.is_multiple_of(100) {
        return;
    }
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
