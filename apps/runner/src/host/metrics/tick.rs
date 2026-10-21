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
use crate::host::supervisor::{self, ProcMap};
use crate::models::{App, AppStatus, Environment};

use super::compact::{compact_fleet, hour_dir, mark_compacted, uncompacted_hours};
use super::cpu::{otel_flush_ms, sample_cpu};
use super::ingest::{collect_chunk_results, commit_chunk, DuckdbPass, FleetKeys};
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
    // A failed listing skips the tick (like a failed app listing): an empty
    // fallback would drop every environment-host access line past the
    // advancing log offset, and could clear a pending replay unrewound.
    let envs = db::list_all_environments(pool).await?;
    let (slug_id, slug_env) = telemetry_fleets(&apps, &envs);
    // Each fleet's own deploy sha (an environment's errors symbolicate
    // against the environment's deploy), keyed by fleet key like the bounds.
    let mut fleet_sha: HashMap<String, String> = HashMap::new();
    for app in &apps {
        if let Some(sha) = app.last_deploy_sha.clone() {
            fleet_sha.insert(app.slug.clone(), sha);
        }
    }
    for env in &envs {
        if let Some(sha) = env.last_deploy_sha.clone() {
            fleet_sha.insert(supervisor::env_fleet_key(&env.app_slug, &env.label), sha);
        }
    }
    let keys = FleetKeys {
        ids: slug_id,
        envs: slug_env,
        shas: fleet_sha,
    };
    // T1.3: aggregation only covers fleets with a live process. A stopped
    // app's sealed Parquet needs no re-scan every 10 s; its status mirrors
    // the supervisor (ensure_fleet marks Running, stop marks Stopped), and a
    // stopped environment's fleet drains the same tail through its own key.
    // The procs map confirms the process is actually there. The control node
    // is not in that map either, so its pid slot answers the same question.
    let live_slugs: HashSet<String> = procs.lock().await.keys().cloned().collect();

    let cpu = sample_cpu_step(procs, control_pid, state, &keys.ids, &keys.envs);
    let (mut touched, new_logs) =
        ingest_step(pool, cfg, state, &keys, &live_slugs, control_pid).await;
    accesslog_step(pool, cfg, &keys.ids, &keys.envs, state).await;
    compact_step(pool, cfg, state, &keys.ids).await;
    persist_step(pool, &cpu, &mut touched, new_logs, log_tx).await?;
    prune_step(pool, cfg, state).await;
    Ok(())
}

/// The fleets that have telemetry: deployed apps plus the control plane, plus
/// every deployed preview environment under its own `{slug}.{label}` fleet
/// key. The second map carries each fleet's environment id (`''` for
/// production and the control fleet).
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
fn telemetry_fleets(
    apps: &[App],
    envs: &[Environment],
) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut slug_id: HashMap<String, String> = apps
        .iter()
        .filter(|a| a.status == AppStatus::Running.as_str() || a.last_deploy_sha.is_some())
        .map(|a: &App| (a.slug.clone(), a.id.clone()))
        .collect();
    slug_id.insert(
        crate::host::control::SLUG.to_string(),
        crate::host::control::SLUG.to_string(),
    );
    let mut slug_env: HashMap<String, String> = HashMap::new();
    for env in envs
        .iter()
        .filter(|e| e.status == AppStatus::Running.as_str() || e.last_deploy_sha.is_some())
    {
        let key = supervisor::env_fleet_key(&env.app_slug, &env.label);
        slug_id.insert(key.clone(), env.app_id.clone());
        slug_env.insert(key, env.id.clone());
    }
    (slug_id, slug_env)
}

/// Step 1 — CPU deltas since the last sample (100 ticks/sec → *10 = ms). CPU is
/// sampled per tick and accumulates; telemetry usage is recomputed per chunk
/// and replaced, so the two never share a writer.
fn sample_cpu_step(
    procs: &ProcMap,
    control_pid: u32,
    state: &mut MetricsState,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
) -> HashMap<(String, String, String), i64> {
    // (id, environment_id, bucket) -> ms. The control fleet and production
    // carry `''`; an environment fleet its own id.
    let mut cpu: HashMap<(String, String, String), i64> = HashMap::new();
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
            let env = slug_env.get(slug).cloned().unwrap_or_default();
            *cpu.entry((id.clone(), env, cpu_bucket.clone()))
                .or_default() += ms;
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
/// lands in their buckets. Returns the (app id, environment id) pairs with
/// new rows and whether the log stream should wake.
async fn ingest_step(
    pool: &SqlitePool,
    cfg: &Config,
    state: &mut MetricsState,
    keys: &FleetKeys,
    live_slugs: &HashSet<String>,
    control_pid: u32,
) -> (HashSet<(String, String)>, bool) {
    state.tick += 1;
    let lag = agg_lag_us(cfg);
    let due = state
        .last_ingest
        .map(|t| t.elapsed().as_millis() >= otel_flush_ms(cfg) as u128)
        .unwrap_or(true);
    let mut touched: HashSet<(String, String)> = HashSet::new(); // (app, env) with new rows
    let mut new_logs = false;
    if !due {
        return (touched, new_logs);
    }
    state.last_ingest = Some(std::time::Instant::now());
    let floor_us = now_us() - cfg.telemetry_retention_days * 86_400_000_000;
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
                None => keys.ids.keys().cloned().collect(),
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
        for slug in keys.ids.keys() {
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
            if let Some((from, until)) = plan_chunks(after, cutoff, floor_us, 1).into_iter().next()
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
            match commit_chunk(pool, state, keys, &chunk, rows, cutoff - 86_400_000_000).await {
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
            Some(s) => {
                !keys.ids.contains_key(s) || state.watermark.get(s).is_none_or(|w| *w >= hour)
            }
            None => keys
                .ids
                .keys()
                .all(|s| state.watermark.get(s).is_none_or(|w| *w >= hour)),
        };
        if caught_up {
            match db::clear_telemetry_replay(pool).await {
                Ok(()) => tracing::info!(fleets = keys.ids.len(), "telemetry replay complete"),
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
    slug_env: &HashMap<String, String>,
    state: &mut MetricsState,
) {
    if let Err(e) = accesslog::tick(pool, cfg, slug_id, slug_env, &mut state.requests).await {
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
    cpu: &HashMap<(String, String, String), i64>,
    touched: &mut HashSet<(String, String)>,
    new_logs: bool,
    log_tx: &tokio::sync::watch::Sender<u64>,
) -> anyhow::Result<()> {
    for ((id, env, bucket), ms) in cpu {
        if *ms > 0 {
            db::add_app_metric_cpu(pool, id, env, bucket, *ms).await?;
            touched.insert((id.clone(), env.clone()));
        }
    }
    for (id, env) in touched.iter() {
        if let Err(e) = db::bump_metric_version(pool, id, env).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The ingest's fleet map covers deployed environments under their own
    /// `{slug}.{label}` fleet key (watermarks, compaction, globs and writers
    /// all key on it), while never-deployed apps and environments stay out.
    #[tokio::test]
    async fn telemetry_fleets_cover_deployed_environments_only() {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let cfg = crate::config::config_for_tests();
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "blog",
                slug: "blog",
                user_id: "local",
                subdomain: "blog.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");
        // Never-deployed: only the control fleet has telemetry.
        let (ids, envs) = telemetry_fleets(&db::list_apps(&pool).await.expect("apps"), &[]);
        assert_eq!(ids.len(), 1);
        assert_eq!(
            ids.get(crate::host::control::SLUG),
            Some(&crate::host::control::SLUG.to_string())
        );
        assert!(envs.is_empty());
        // Deploy the app and one environment; a second environment stays
        // never-deployed.
        db::update_app_status(&pool, &app.id, "running", None, Some("prodsha"))
            .await
            .expect("deploy app");
        let env = db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: &app.slug,
                label: "preview",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/preview",
                created_by: "local",
                listen: 30200,
                internal: 30201,
            },
        )
        .await
        .expect("seed env");
        db::environments::mark_environment_deployed(&pool, &env.id, "envsha")
            .await
            .expect("deploy env");
        let quiet = db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: &app.slug,
                label: "wip",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/wip",
                created_by: "local",
                listen: 30202,
                internal: 30203,
            },
        )
        .await
        .expect("seed quiet env");
        let apps = db::list_apps(&pool).await.expect("apps");
        let all_envs = db::list_all_environments(&pool).await.expect("envs");
        let (ids, env_map) = telemetry_fleets(&apps, &all_envs);
        assert_eq!(ids.get("blog"), Some(&app.id));
        assert_eq!(
            ids.get("blog.preview"),
            Some(&app.id),
            "a deployed environment is its own fleet"
        );
        assert_eq!(env_map.get("blog.preview"), Some(&env.id));
        assert!(
            !ids.contains_key("blog.wip"),
            "a never-deployed environment has no telemetry fleet"
        );
        assert!(!env_map.contains_key("blog.wip"));
        assert!(!env_map.contains_key("blog"));
        let _ = quiet;
    }
}
