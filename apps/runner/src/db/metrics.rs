//! High-churn telemetry tables (spec T4.1): minute buckets, edge analytics,
//! hourly span stats, the log ring, ingest watermarks, and replay requests.
//! All rows live in the ATTACHed `metrics` database.

use sqlx::SqlitePool;

use crate::models::{now_iso, AppDeviceStat, AppMetric, AppPathStat, AppRefStat, AppSpanStat};

/// Newest minute bucket with at least one request (celld `celld.fetch`
/// spans), or None when the app never served within retention.
pub async fn last_request_bucket(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT bucket_ts FROM metrics.app_metric
           WHERE app_id = ? AND requests > 0 ORDER BY bucket_ts DESC LIMIT 1"#,
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await
}

/// REPLACE one minute-bucket's telemetry columns. The metrics tick recomputes
/// a whole hour-chunk from its hour boundary every pass, so the values it
/// carries include everything already stored: replacing (not accumulating)
/// is what makes a re-read and a replay exact instead of double counting.
/// `cpu_ms` is left alone — it is sampled, not replayed, and accumulates.
pub async fn replace_app_metric_usage(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    requests: i64,
    errors: i64,
    latency_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_metric (app_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
           VALUES (?, ?, ?, ?, ?, 0)
           ON CONFLICT (app_id, bucket_ts) DO UPDATE SET
             requests = excluded.requests,
             errors = excluded.errors,
             latency_ms = excluded.latency_ms"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(requests)
    .bind(errors)
    .bind(latency_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Accumulate one minute-bucket of sampled CPU into the same row. CPU is a
/// per-tick delta from `/proc`, so it adds; telemetry usage replaces.
pub async fn add_app_metric_cpu(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    cpu_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_metric (app_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
           VALUES (?, ?, 0, 0, 0, ?)
           ON CONFLICT (app_id, bucket_ts) DO UPDATE SET cpu_ms = cpu_ms + excluded.cpu_ms"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(cpu_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_metrics(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppMetric>> {
    sqlx::query_as::<_, AppMetric>(
        r#"SELECT app_id, bucket_ts, requests, errors, latency_ms, cpu_ms
           FROM metrics.app_metric WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_metrics(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.app_metric WHERE bucket_ts < ?")
        .bind(older_than_ts)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Telemetry watermark persistence: slug -> the START of the last hour-chunk
/// committed (the ingest recomputes a whole hour from its boundary, so the
/// value is an hour mark, not a consumed microsecond). Written after a chunk's
/// rows persist; the runner SQLite lives on the data volume, so restarts
/// resume instead of resetting.
pub async fn get_metric_watermarks(
    pool: &SqlitePool,
) -> sqlx::Result<std::collections::HashMap<String, i64>> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT slug, after_us FROM metrics.metric_watermark")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

pub async fn set_metric_watermarks(pool: &SqlitePool, marks: &[(String, i64)]) -> sqlx::Result<()> {
    for (slug, after_us) in marks {
        sqlx::query(
            r#"INSERT INTO metrics.metric_watermark (slug, after_us) VALUES (?, ?)
               ON CONFLICT (slug) DO UPDATE SET after_us = excluded.after_us"#,
        )
        .bind(slug)
        .bind(after_us)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// One pending telemetry replay request (`main.telemetry_replay`, one row).
/// `floor_us` 0 means the retention floor; `slug` None means every fleet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayRequest {
    pub floor_us: i64,
    pub slug: Option<String>,
    pub requested_at: String,
}

pub async fn get_telemetry_replay(pool: &SqlitePool) -> sqlx::Result<Option<ReplayRequest>> {
    let row: Option<(i64, Option<String>, String)> = sqlx::query_as(
        "SELECT floor_us, slug, requested_at FROM main.telemetry_replay WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(floor_us, slug, requested_at)| ReplayRequest {
        floor_us,
        slug,
        requested_at,
    }))
}

pub async fn set_telemetry_replay(
    pool: &SqlitePool,
    floor_us: i64,
    slug: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO main.telemetry_replay (id, floor_us, slug, requested_at) VALUES (1, ?, ?, ?) \
         ON CONFLICT (id) DO UPDATE SET floor_us = excluded.floor_us, slug = excluded.slug, \
           requested_at = excluded.requested_at",
    )
    .bind(floor_us)
    .bind(slug)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_telemetry_replay(pool: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM main.telemetry_replay WHERE id = 1")
        .execute(pool)
        .await?;
    Ok(())
}

/// Accumulate one device hit into its hour bucket. Called from the
/// access-log tick; only the classified pair is stored, never IPs or
/// raw user-agents.
pub async fn add_app_device(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    browser: &str,
    os: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_device_stat (app_id, bucket_ts, browser, os, requests)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, browser, os) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(browser)
    .bind(os)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_devices(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppDeviceStat>> {
    sqlx::query_as::<_, AppDeviceStat>(
        r#"SELECT app_id, bucket_ts, browser, os, requests
           FROM metrics.app_device_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_devices(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.app_device_stat WHERE bucket_ts < ?")
        .bind(older_than_ts)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Accumulate one pathname hit into its hour bucket. Query strings are
/// stripped before storing; over-long paths are skipped upstream.
pub async fn add_app_path(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    path: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_path_stat (app_id, bucket_ts, path, requests)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, path) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(path)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_paths(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppPathStat>> {
    sqlx::query_as::<_, AppPathStat>(
        r#"SELECT app_id, bucket_ts, path, requests
           FROM metrics.app_path_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_paths(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.app_path_stat WHERE bucket_ts < ?")
        .bind(older_than_ts)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Accumulate one referrer hit into its hour bucket. Only the classified
/// source (network/engine name or bare host) is stored — never full URLs.
pub async fn add_app_ref(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    source: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_ref_stat (app_id, bucket_ts, source, requests)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, source) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_refs(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppRefStat>> {
    sqlx::query_as::<_, AppRefStat>(
        r#"SELECT app_id, bucket_ts, source, requests
           FROM metrics.app_ref_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_refs(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.app_ref_stat WHERE bucket_ts < ?")
        .bind(older_than_ts)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// REPLACE one hour-bucket of span stats (spec T3.2), filled by the ingest
/// tick. The tick recomputes the whole hour from its boundary, so the values
/// already include what was stored — replace, never accumulate. Retention
/// matches the other metric tables.
#[allow(clippy::too_many_arguments)]
pub async fn replace_span_stat(
    pool: &SqlitePool,
    app_id: &str,
    bucket_hour: &str,
    name: &str,
    kind: i64,
    n: i64,
    ms: i64,
    err: i64,
    qwait_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_span_stat
           (app_id, bucket_hour, name, kind, n, ms, err, qwait_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, bucket_hour, name, kind) DO UPDATE SET
             n = excluded.n,
             ms = excluded.ms,
             err = excluded.err,
             qwait_ms = excluded.qwait_ms"#,
    )
    .bind(app_id)
    .bind(bucket_hour)
    .bind(name)
    .bind(kind)
    .bind(n)
    .bind(ms)
    .bind(err)
    .bind(qwait_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Top spans over `[since_hour, now]`, summed across hour buckets
/// (spec T3.2). A 24 h (or 7 d) window is one indexed SQLite scan.
pub async fn list_span_stats(
    pool: &SqlitePool,
    app_id: &str,
    since_hour: &str,
) -> sqlx::Result<Vec<AppSpanStat>> {
    sqlx::query_as::<_, AppSpanStat>(
        r#"SELECT name, kind,
             SUM(n) AS n, SUM(ms) AS ms, SUM(err) AS err, SUM(qwait_ms) AS qwait_ms
           FROM metrics.app_span_stat
           WHERE app_id = ? AND bucket_hour >= ?
           GROUP BY name, kind ORDER BY ms DESC LIMIT 8"#,
    )
    .bind(app_id)
    .bind(since_hour)
    .fetch_all(pool)
    .await
}

pub async fn prune_span_stats(pool: &SqlitePool, older_than_hour: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.app_span_stat WHERE bucket_hour < ?")
        .bind(older_than_hour)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// REPLACE the ingested OTel log rows of one `[from_us, to_us)` window in the
/// per-app ring (spec T3.3). The tick recomputes a whole hour-chunk each pass,
/// so it deletes the window before inserting: a re-read or a replay leaves the
/// same lines instead of appending duplicates. `rows` must lie inside the
/// window.
pub async fn replace_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    from_us: i64,
    to_us: i64,
    rows: &[(i64, String)],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM metrics.app_log WHERE app_id = ? AND ts_us >= ? AND ts_us < ?")
        .bind(app_id)
        .bind(from_us)
        .bind(to_us)
        .execute(&mut *tx)
        .await?;
    for (ts_us, body) in rows {
        sqlx::query("INSERT INTO metrics.app_log (app_id, ts_us, body) VALUES (?, ?, ?)")
            .bind(app_id)
            .bind(ts_us)
            .bind(body)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Ring contents in chronological order (oldest first), like the old
/// DuckDB `recent_logs` return.
pub async fn list_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    since_us: i64,
    limit: i64,
) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(
        "SELECT ts_us, body FROM metrics.app_log \
         WHERE app_id = ? AND ts_us >= ? ORDER BY ts_us ASC LIMIT ?",
    )
    .bind(app_id)
    .bind(since_us)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Cap the ring per app: last 24 h AND last 2,000 lines, whichever is
/// smaller (spec T3.3).
pub async fn prune_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    cutoff_us: i64,
    keep: i64,
) -> sqlx::Result<u64> {
    let mut n = sqlx::query("DELETE FROM metrics.app_log WHERE app_id = ? AND ts_us < ?")
        .bind(app_id)
        .bind(cutoff_us)
        .execute(pool)
        .await?
        .rows_affected();
    // rowid is the insertion order: everything outside the newest `keep`.
    n += sqlx::query(
        "DELETE FROM metrics.app_log WHERE app_id = ? AND rowid NOT IN \
         (SELECT rowid FROM metrics.app_log WHERE app_id = ? \
          ORDER BY ts_us DESC, rowid DESC LIMIT ?)",
    )
    .bind(app_id)
    .bind(app_id)
    .bind(keep)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n)
}
