// App observability.
//
// Requests + latency come from celld's OpenTelemetry (CELLD_OTEL=1, bucket
// sink): each fleet writes Parquet spans into its fleet bucket under
// `telemetry/traces/...`, and we aggregate them with the DuckDB CLI — the
// documented query path, no collector service.
//
// CPU time celld executes code: OTel has no metrics signal yet (spans carry
// durations), so CPU is sampled from `/proc/<celld-pid>/stat` (+ descendants)
// — visible because the runner spawns celld in its own PID namespace.
//
// Ticks every poll_ms; minute buckets land in app_metric (upsert-accumulate).
use std::collections::HashMap;

use serde::Serialize;
use chrono::Utc;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::accesslog;
use crate::host::cmd;
use crate::host::supervisor::ProcMap;
use crate::models::{App, AppStatus};

pub struct MetricsState {
    last_cpu: HashMap<String, (u64, u64)>, // slug -> (utime, stime) in ticks
    watermark: HashMap<String, i64>, // slug -> last consumed start_unix_us
    tick: u64,
}

pub fn new_state() -> MetricsState {
    MetricsState {
        last_cpu: HashMap::new(),
        watermark: HashMap::new(),
        tick: 0,
    }
}

/// Restore a persisted watermark map into fresh state (boot only).
pub fn set_watermarks(state: &mut MetricsState, marks: HashMap<String, i64>) {
    state.watermark = marks;
}

fn minute_bucket_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:00Z").to_string()
}

fn now_us() -> i64 {
    // Epoch-relative time via the loop_.rs pattern (chrono DateTime math,
    // num_milliseconds).
    let epoch = chrono::DateTime::parse_from_rfc3339("1970-01-01T00:00:00Z")
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .expect("epoch literal");
    (Utc::now() - epoch).num_milliseconds() * 1000
}
pub fn now_us_pub() -> i64 {
    now_us()
}

// ---------------------------------------------------------------------------
// CPU sampling from /proc (UTIME + STIME, subtree-wise)
// ---------------------------------------------------------------------------

fn read_proc_stat(pid: u32) -> Option<(u64, u64)> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = s.rfind(')')?;
    let rest = s[close + 2..].trim();
    // After "pid (comm) ": 0=state 1=ppid 2=pgrp 3=session 4=tty 5=tpgid
    // 6=flags 7=minflt 8=cminflt 9=majflt 10=cmajflt 11=utime 12=stime
    let mut it = rest.split_whitespace();
    for _ in 0..11 {
        it.next()?;
    }
    let utime: u64 = it.next()?.parse().ok()?;
    let stime: u64 = it.next()?.parse().ok()?;
    Some((utime, stime))
}

fn proc_children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .map(|s| s.split_whitespace().filter_map(|p| p.parse().ok()).collect())
        .unwrap_or_default()
}

/// celld may run isolates in descendants — sum the process subtree.
fn proc_cpu_recursive(pid: u32, depth: u32) -> (u64, u64) {
    let mut total = read_proc_stat(pid).unwrap_or((0, 0));
    if depth == 0 {
        return total;
    }
    for child in proc_children(pid) {
        let (u, s) = proc_cpu_recursive(child, depth - 1);
        total.0 += u;
        total.1 += s;
    }
    total
}

fn sample_cpu(procs: &ProcMap) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    let Ok(map) = procs.try_lock() else {
        return out;
    };
    for (slug, child) in map.iter() {
        if let Some(pid) = child.id() {
            out.insert(slug.clone(), proc_cpu_recursive(pid, 3));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// DuckDB aggregation over celld telemetry Parquet in the fleet bucket
// ---------------------------------------------------------------------------

fn endpoint_host(endpoint: &str) -> String {
    endpoint
        .strip_prefix("http://")
        .or(endpoint.strip_prefix("https://"))
        .unwrap_or(endpoint)
        .to_string()
}

/// Aggregated rows (bucket, requests, duration_us) for one fleet's telemetry
/// window strictly after `after_us` and at least 15 s behind now (a flush
/// lag — keeps minute buckets closed, so nothing is ever double-counted).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanStat {
    pub name: String,
    pub kind: i64,
    pub n: i64,
    pub ms: i64,
    pub err: i64,
    pub qwait_ms: i64,
}

/// Coerce a DuckDB JSON field to i64 — the -json writer emits BIGINT sums as
/// STRINGS ("51644") and small integers as numbers (4). Handle both.
fn json_i64(v: &serde_json::Value, key: &str) -> i64 {
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
/// no CREATE SECRET, so the -json output carries no DDL glue lines.
fn s3_setup(cfg: &Config, query: &str) -> String {
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

async fn duckdb_json(sql: &str) -> anyhow::Result<String> {
    cmd::run_cmd(
        "/usr/local/bin/duckdb",
        &["-json", "-c", sql],
        None,
        &[],
        std::time::Duration::from_secs(30),
    )
    .await
}

/// True when duckdb failed only because the fleet has no parquet yet (idle).
pub fn is_idle_telemetry_err(err: &anyhow::Error) -> bool {
    err.to_string().contains("No files found")
}

/// Whether a telemetry tick should advance the watermark for this result.
pub fn should_advance_watermark(agg_ok: bool, idle: bool) -> bool {
    agg_ok || idle
}

/// Aggregate one fleet's telemetry window into rows:
/// (bucket, requests, duration_us, errors). Only `celld.fetch` spans count
/// as requests (verified 1:1 against traffic); the trace `ok` flag feeds the
/// error count.
async fn telemetry_agg(cfg: &Config, slug: &str, after_us: i64) -> anyhow::Result<Vec<(String, i64, i64, i64)>> {
    // 5 s behind the flush — celld flushes every 2 s, and this keeps minute
    // buckets closed so nothing is ever double-counted.
    let cutoff = now_us() - 5_000_000;
    let sql = s3_setup(
        cfg,
        &format!(
            "SELECT strftime('%Y-%m-%dT%H:%M:00Z', to_timestamp(start_unix_us / 1000000)) AS b, \
                    count(*) AS n, sum(duration_us) AS dur, \
                    sum(CASE WHEN NOT ok THEN 1 ELSE 0 END) AS e \
               FROM read_parquet('s3://{}/fleets/{}/telemetry/traces/*/*/*/*/*/*.parquet') \
              WHERE name = 'celld.fetch' AND start_unix_us > {} AND start_unix_us <= {} \
              GROUP BY b ORDER BY b",
            cfg.s3_bucket,
            slug,
            after_us,
            cutoff,
        ),
    );
    let out = match duckdb_json(&sql).await {
        Ok(o) => o,
        Err(e) if is_idle_telemetry_err(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut rows = Vec::new();
    if out.trim().is_empty() || out.trim() == "[]" {
        return Ok(rows);
    }
    let v: serde_json::Value = serde_json::from_str(out.trim())
        .map_err(|e| anyhow::anyhow!("duckdb json parse: {e}"))?;
    let Some(arr) = v.as_array() else {
        return Ok(rows);
    };
    for obj in arr {
        let bucket = obj.pointer("/b").and_then(|x| x.as_str()).unwrap_or("");
        if bucket.is_empty() {
            continue;
        }
        rows.push((
            bucket.to_string(),
            json_i64(obj, "n"),
            json_i64(obj, "dur"),
            json_i64(obj, "e"),
        ));
    }
    Ok(rows)
}

/// What the fleet is doing in the last `hours`: top spans by total duration,
/// with counts, error counts, and the queue wait celld records per span.
pub async fn top_spans(cfg: &Config, slug: &str, since_us: i64) -> Vec<SpanStat> {
    // CAST to BIGINT: DuckDB `/` is floating division, and the -json writer
    // emits BIGINT/DOUBLE as strings/decimals — coerce at the source.
    let sql = s3_setup(
        cfg,
        &format!(
            "SELECT name, kind, count(*) AS n, \
                    CAST(sum(duration_us) / 1000 AS BIGINT) AS ms, \
                    sum(CASE WHEN NOT ok THEN 1 ELSE 0 END) AS e, \
                    CAST(sum(coalesce(queue_wait_us, 0)) / 1000 AS BIGINT) AS q \
               FROM read_parquet('s3://{}/fleets/{}/telemetry/traces/*/*/*/*/*/*.parquet') \
              WHERE start_unix_us > {} GROUP BY name, kind ORDER BY ms DESC LIMIT 8",
            cfg.s3_bucket,
            slug,
            since_us,
        ),
    );
    let out = duckdb_json(&sql).await.unwrap_or_default();
    let mut rows = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) else {
        return rows;
    };
    let Some(arr) = v.as_array() else {
        return rows;
    };
    for obj in arr {
        let name = obj.pointer("/name").and_then(|x| x.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        rows.push(SpanStat {
            name: name.to_string(),
            kind: json_i64(obj, "kind"),
            n: json_i64(obj, "n"),
            ms: json_i64(obj, "ms"),
            err: json_i64(obj, "e"),
            qwait_ms: json_i64(obj, "q"),
        });
    }
    rows
}

/// Recent app `console.log` lines from celld's telemetry/logs Parquet (bucket
/// sink) — the same sink `/spans` reads for traces. Each captured console line
/// is a row here; returns chronological bodies, newest last. `No files found`
/// (idle / nothing logged yet) reads as empty.
pub async fn recent_logs(cfg: &Config, slug: &str, limit: i64) -> Vec<String> {
    // 5 s behind the flush, like spans — celld flushes every 2 s.
    let since = now_us() - 60 * 3_600_000_000;
    let sql = s3_setup(
        cfg,
        &format!(
            "SELECT body FROM read_parquet('s3://{}/fleets/{}/telemetry/logs/*/*/*/*/*/*.parquet') \
              WHERE time_unix_us > {} ORDER BY time_unix_us DESC LIMIT {}",
            cfg.s3_bucket, slug, since, limit
        ),
    );
    let out = duckdb_json(&sql).await.unwrap_or_default();
    let mut rows = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(out.trim()) else {
        return rows;
    };
    let Some(arr) = v.as_array() else {
        return rows;
    };
    // DESC order from SQL; reverse to chronological (oldest first).
    for obj in arr.iter().rev() {
        if let Some(b) = obj.pointer("/body").and_then(|x| x.as_str()) {
            rows.push(b.to_string());
        }
    }
    rows
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

pub async fn tick(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    state: &mut MetricsState,
) -> anyhow::Result<()> {
    let apps = db::list_apps(pool).await?;
    // Only deployed fleets have telemetry and a running celld — exclude
    // never-deployed apps so we don't spawn duckdb (and sample CPU) for
    // every created-but-empty slug every cycle.
    let slug_id: HashMap<String, String> = apps
        .iter()
        .filter(|a| a.status == AppStatus::Running.as_str() || a.last_deploy_sha.is_some())
        .map(|a: &App| (a.slug.clone(), a.id.clone()))
        .collect();

    struct Acc {
        req: i64,
        err: i64,
        lat_ms: i64,
        cpu_ms: i64,
    }
    let mut acc: HashMap<(String, String), Acc> = HashMap::new(); // (id, bucket)

    // 1. CPU deltas since the last sample (100 ticks/sec → *10 = ms).
    let cpu_bucket = minute_bucket_now();
    let now_cpu = sample_cpu(procs);
    for (slug, (ut, st)) in &now_cpu {
        let Some(id) = slug_id.get(slug) else {
            continue;
        };
        let Some(prev) = state.last_cpu.get(slug) else {
            continue;
        };
        let ms = ((ut.saturating_sub(prev.0) + st.saturating_sub(prev.1)) * 10) as i64;
        if ms > 0 {
            let e = acc.entry((id.clone(), cpu_bucket.clone())).or_insert(
                Acc { req: 0, err: 0, lat_ms: 0, cpu_ms: 0 },
            );
            e.cpu_ms += ms;
        }
    }
    state.last_cpu = now_cpu;

    // 2. Telemetry aggregation every ~2 ticks (10 s at a 5 s poll; 2 s flush)
    //    for near-real-time request counts.
    state.tick += 1;
    let mut advanced: Vec<(String, i64)> = Vec::new();
    if state.tick.is_multiple_of(2) {
        for (slug, id) in &slug_id {
            let after = state.watermark.get(slug).copied().unwrap_or(now_us() - 5_000_000);
            match telemetry_agg(cfg, slug, after).await {
                Ok(rows) => {
                    for (bucket, n, dur_us, err_n) in rows {
                        if n > 0 || err_n > 0 {
                            let e = acc.entry((id.clone(), bucket.to_string())).or_insert(
                                Acc { req: 0, err: 0, lat_ms: 0, cpu_ms: 0 },
                            );
                            e.req += n;
                            e.err += err_n;
                            e.lat_ms += dur_us / 1000;
                        }
                    }
                    if should_advance_watermark(true, false) {
                        let wm = now_us() - 5_000_000;
                        state.watermark.insert(slug.clone(), wm);
                        advanced.push((slug.clone(), wm));
                    }
                }
                Err(e) => {
                    let idle = is_idle_telemetry_err(&e);
                    if should_advance_watermark(false, idle) {
                        let wm = now_us() - 5_000_000;
                        state.watermark.insert(slug.clone(), wm);
                        advanced.push((slug.clone(), wm));
                    } else {
                        tracing::warn!(slug = %slug, error = %e, "telemetry_agg");
                    }
                }
            }
        }
    }
    // 3. Caddy access log → device families. Never fails the tick: a missing
    //    log (Caddy not yet reloaded) or a corrupt line is a silent skip.
    if let Err(e) = accesslog::tick(pool, cfg, &slug_id).await {
        tracing::warn!(error = %e, "access_log");
    }

    // 4. Persist minute buckets.
    for ((id, bucket), a) in &acc {
        if a.req > 0 || a.err > 0 || a.cpu_ms > 0 {
            db::add_app_metric(pool, id, bucket, a.req, a.err, a.lat_ms, a.cpu_ms)
                .await?;
        }
    }

    // 4b. Durable watermark: these rows ride the same SQLite snapshot the R2
    // relay carries, so restarts resume aggregation instead of resetting it.
    // Written only after the buckets above persist. A crash between the two
    // re-aggregates at most one window (upsert-accumulate may double-count
    // it) — narrow by construction.
    if !advanced.is_empty() {
        if let Err(e) = db::set_metric_watermarks(pool, &advanced).await {
            tracing::warn!(error = %e, "watermark persist");
        }
    }

    // 5. Prune old buckets occasionally (~every 100 ticks).
    if state.tick.is_multiple_of(100) {
        let cutoff = (Utc::now() - chrono::Duration::days(14))
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
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watermark_advances_on_ok_or_idle_only() {
        assert!(should_advance_watermark(true, false));
        assert!(should_advance_watermark(false, true));
        assert!(!should_advance_watermark(false, false));
    }

    #[test]
    fn idle_err_detects_no_files() {
        let e = anyhow::anyhow!("duckdb: No files found that match the pattern");
        assert!(is_idle_telemetry_err(&e));
        let e2 = anyhow::anyhow!("connection refused");
        assert!(!is_idle_telemetry_err(&e2));
    }
}