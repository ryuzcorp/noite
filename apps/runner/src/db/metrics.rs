//! High-churn telemetry tables (spec T4.1): minute buckets, edge analytics,
//! hourly span stats, the log ring, ingest watermarks, and replay requests.
//! All rows live in the ATTACHed `metrics` database.
//!
//! Every per-environment table keys on `(app_id, environment_id, …)` where
//! `environment_id` is `''` for production (the brief's NULL/none is `''`:
//! SQLite allows duplicate NULLs in PKs, so NULL cannot be the none value).

use sqlx::SqlitePool;

use crate::models::{now_iso, AppDeviceStat, AppMetric, AppPathStat, AppRefStat, AppSpanStat};

/// Newest minute bucket with at least one request (celld `celld.fetch`
/// spans), or None when the app never served within retention.
pub async fn last_request_bucket(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT bucket_ts FROM metrics.app_metric
           WHERE app_id = ? AND environment_id = ? AND requests > 0 ORDER BY bucket_ts DESC LIMIT 1"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    bucket_ts: &str,
    requests: i64,
    errors: i64,
    latency_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_metric (app_id, environment_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
           VALUES (?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (app_id, environment_id, bucket_ts) DO UPDATE SET
             requests = excluded.requests,
             errors = excluded.errors,
             latency_ms = excluded.latency_ms"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    bucket_ts: &str,
    cpu_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_metric (app_id, environment_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
           VALUES (?, ?, ?, 0, 0, 0, ?)
           ON CONFLICT (app_id, environment_id, bucket_ts) DO UPDATE SET cpu_ms = cpu_ms + excluded.cpu_ms"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_ts)
    .bind(cpu_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_metrics(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppMetric>> {
    sqlx::query_as::<_, AppMetric>(
        r#"SELECT app_id, bucket_ts, requests, errors, latency_ms, cpu_ms
           FROM metrics.app_metric WHERE app_id = ? AND environment_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
///
/// The key is a fleet key: a production slug, or `{slug}.{label}` for a
/// preview environment (each environment is its own fleet for watermarks).
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
            "INSERT INTO metrics.metric_watermark (slug, after_us) VALUES (?, ?) \
             ON CONFLICT (slug) DO UPDATE SET after_us = excluded.after_us",
        )
        .bind(slug)
        .bind(after_us)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Drop one fleet's watermark (environment delete: labels can be reused, so a
/// deleted environment must not leave a watermark behind for its successor).
pub async fn delete_metric_watermarks_for(pool: &SqlitePool, slug: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.metric_watermark WHERE slug = ?")
        .bind(slug)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
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
    let row: Option<(i64, Option<String>, String)> =
        sqlx::query_as("SELECT floor_us, slug, requested_at FROM main.telemetry_replay LIMIT 1")
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
    sqlx::query("DELETE FROM main.telemetry_replay")
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO main.telemetry_replay (id, floor_us, slug, requested_at) VALUES (1, ?, ?, ?)",
    )
    .bind(floor_us)
    .bind(slug)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_telemetry_replay(pool: &SqlitePool) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM main.telemetry_replay")
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
    environment_id: &str,
    bucket_ts: &str,
    browser: &str,
    os: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_device_stat (app_id, environment_id, bucket_ts, browser, os, requests)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT (app_id, environment_id, bucket_ts, browser, os) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppDeviceStat>> {
    sqlx::query_as::<_, AppDeviceStat>(
        r#"SELECT app_id, bucket_ts, browser, os, requests
           FROM metrics.app_device_stat WHERE app_id = ? AND environment_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    bucket_ts: &str,
    path: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_path_stat (app_id, environment_id, bucket_ts, path, requests)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (app_id, environment_id, bucket_ts, path) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_ts)
    .bind(path)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_paths(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppPathStat>> {
    sqlx::query_as::<_, AppPathStat>(
        r#"SELECT app_id, bucket_ts, path, requests
           FROM metrics.app_path_stat WHERE app_id = ? AND environment_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    bucket_ts: &str,
    source: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_ref_stat (app_id, environment_id, bucket_ts, source, requests)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (app_id, environment_id, bucket_ts, source) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_ts)
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_refs(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppRefStat>> {
    sqlx::query_as::<_, AppRefStat>(
        r#"SELECT app_id, bucket_ts, source, requests
           FROM metrics.app_ref_stat WHERE app_id = ? AND environment_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
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
           (app_id, environment_id, bucket_hour, name, kind, n, ms, err, qwait_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, environment_id, bucket_hour, name, kind) DO UPDATE SET
             n = excluded.n,
             ms = excluded.ms,
             err = excluded.err,
             qwait_ms = excluded.qwait_ms"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    since_hour: &str,
) -> sqlx::Result<Vec<AppSpanStat>> {
    sqlx::query_as::<_, AppSpanStat>(
        r#"SELECT name, kind,
             SUM(n) AS n, SUM(ms) AS ms, SUM(err) AS err, SUM(qwait_ms) AS qwait_ms
           FROM metrics.app_span_stat
           WHERE app_id = ? AND environment_id = ? AND bucket_hour >= ?
           GROUP BY name, kind ORDER BY ms DESC LIMIT 8"#,
    )
    .bind(app_id)
    .bind(environment_id)
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
    environment_id: &str,
    from_us: i64,
    to_us: i64,
    rows: &[(i64, String)],
) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "DELETE FROM metrics.app_log WHERE app_id = ? AND environment_id = ? AND ts_us >= ? AND ts_us < ?",
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(from_us)
    .bind(to_us)
    .execute(&mut *tx)
    .await?;
    for (ts_us, body) in rows {
        sqlx::query(
            "INSERT INTO metrics.app_log (app_id, environment_id, ts_us, body) VALUES (?, ?, ?, ?)",
        )
        .bind(app_id)
        .bind(environment_id)
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
    environment_id: &str,
    since_us: i64,
    limit: i64,
) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(
        "SELECT ts_us, body FROM metrics.app_log \
         WHERE app_id = ? AND environment_id = ? AND ts_us >= ? ORDER BY ts_us ASC LIMIT ?",
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(since_us)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Cap the ring per app and environment: last 24 h AND last 2,000 lines,
/// whichever is smaller (spec T3.3).
pub async fn prune_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
    cutoff_us: i64,
    keep: i64,
) -> sqlx::Result<u64> {
    let mut n = sqlx::query(
        "DELETE FROM metrics.app_log WHERE app_id = ? AND environment_id = ? AND ts_us < ?",
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(cutoff_us)
    .execute(pool)
    .await?
    .rows_affected();
    // rowid is the insertion order: everything outside the newest `keep`.
    n += sqlx::query(
        "DELETE FROM metrics.app_log WHERE app_id = ? AND environment_id = ? AND rowid NOT IN \
         (SELECT rowid FROM metrics.app_log WHERE app_id = ? AND environment_id = ? \
          ORDER BY ts_us DESC, rowid DESC LIMIT ?)",
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(app_id)
    .bind(environment_id)
    .bind(keep)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n)
}

/// Drop every telemetry row of one environment: metrics, analytics, spans,
/// the log ring, error issues/events/hours, and its metrics version. Labels
/// can be reused after a delete, so nothing may survive for a successor.
pub async fn delete_environment_telemetry(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
) -> sqlx::Result<u64> {
    let mut n = 0;
    for table in [
        "metrics.app_metric",
        "metrics.app_device_stat",
        "metrics.app_path_stat",
        "metrics.app_ref_stat",
        "metrics.app_span_stat",
        "metrics.app_log",
        "metrics.app_error_issue",
        "metrics.app_error_event",
        "metrics.app_error_hour",
        "metrics.metric_version",
    ] {
        let res = sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE app_id = ? AND environment_id = ?"
        )))
        .bind(app_id)
        .bind(environment_id)
        .execute(pool)
        .await?;
        n += res.rows_affected();
    }
    Ok(n)
}

/// Shape upgrade for pre-existing `metrics.sqlite` files: add
/// `environment_id` (`''` = production) to every per-environment table and
/// extend the PKs and indexes to include it.
///
/// Fresh databases already carry the new shape (`schema.metrics.sql`), so
/// every step below is a guarded no-op for them. Upgraded databases get
/// `ALTER TABLE … ADD COLUMN` first (existing rows keep their values;
/// `DEFAULT ''` keeps them production), then — only when the live PK still
/// excludes the column, checked via `pragma_table_info` so a second boot
/// never rebuilds twice — the table is rebuilt under the new PK with every
/// row copied. Production history is preserved: the copy is a plain
/// `INSERT … SELECT`, and a duplicate would fail the boot loudly instead of
/// losing rows silently. Runs once in `connect`, not per pooled connection.
pub async fn ensure_environment_telemetry(pool: &SqlitePool) -> anyhow::Result<()> {
    struct Table {
        name: &'static str,
        /// New-shape column list: the rebuild target and the copy order.
        columns: &'static str,
        /// New-shape `CREATE TABLE` body (the parenthesised column list).
        /// Must match `schema.metrics.sql`; the index statements below too.
        create_body: &'static str,
        /// Index names to drop before recreating (same names, new columns).
        index_names: &'static [&'static str],
        /// New-shape index statements for this table.
        indexes: &'static [&'static str],
        /// Whether the new PK includes `environment_id` and the table must
        /// be rebuilt when the live PK still excludes it (`app_log` and
        /// `app_error_event` carry no PK and need no rebuild).
        rebuild_pk: bool,
    }
    const TABLES: &[Table] = &[
        Table {
            name: "app_metric",
            columns: "app_id, environment_id, bucket_ts, requests, errors, latency_ms, cpu_ms",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', bucket_ts TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, cpu_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, bucket_ts))",
            index_names: &["idx_app_metric_app_bucket"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_metric_app_bucket ON app_metric(app_id, environment_id, bucket_ts)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_device_stat",
            columns: "app_id, environment_id, bucket_ts, browser, os, requests",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', bucket_ts TEXT NOT NULL, browser TEXT NOT NULL, os TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, bucket_ts, browser, os))",
            index_names: &["idx_app_device_stat_app_bucket"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_device_stat_app_bucket ON app_device_stat(app_id, environment_id, bucket_ts)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_path_stat",
            columns: "app_id, environment_id, bucket_ts, path, requests",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', bucket_ts TEXT NOT NULL, path TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, bucket_ts, path))",
            index_names: &["idx_app_path_stat_app_bucket"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_path_stat_app_bucket ON app_path_stat(app_id, environment_id, bucket_ts)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_ref_stat",
            columns: "app_id, environment_id, bucket_ts, source, requests",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', bucket_ts TEXT NOT NULL, source TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, bucket_ts, source))",
            index_names: &["idx_app_ref_stat_app_bucket"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_ref_stat_app_bucket ON app_ref_stat(app_id, environment_id, bucket_ts)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_span_stat",
            columns: "app_id, environment_id, bucket_hour, name, kind, n, ms, err, qwait_ms",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', bucket_hour TEXT NOT NULL, name TEXT NOT NULL, kind INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, err INTEGER NOT NULL DEFAULT 0, qwait_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, bucket_hour, name, kind))",
            index_names: &["idx_app_span_stat_app_hour"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_span_stat_app_hour ON app_span_stat(app_id, environment_id, bucket_hour)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_log",
            columns: "app_id, environment_id, ts_us, body",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', ts_us INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '')",
            index_names: &["idx_app_log_app_ts"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_log_app_ts ON app_log(app_id, environment_id, ts_us)"],
            rebuild_pk: false,
        },
        Table {
            name: "app_error_issue",
            columns: "app_id, environment_id, fingerprint, kind, message, culprit, handler, source, count, first_seen_us, last_seen_us, first_sha, last_sha, status, regressed, status_at_us",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, culprit TEXT NOT NULL DEFAULT '', handler TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'uncaught', count INTEGER NOT NULL DEFAULT 0, first_seen_us INTEGER NOT NULL, last_seen_us INTEGER NOT NULL, first_sha TEXT, last_sha TEXT, status TEXT NOT NULL DEFAULT 'open', regressed INTEGER NOT NULL DEFAULT 0, status_at_us INTEGER, PRIMARY KEY (app_id, environment_id, fingerprint))",
            index_names: &["idx_app_error_issue_app_last"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_error_issue_app_last ON app_error_issue(app_id, environment_id, last_seen_us)"],
            rebuild_pk: true,
        },
        Table {
            name: "app_error_event",
            columns: "app_id, environment_id, fingerprint, ts_us, trace_id, source, handler, cell, kind, message, context, frames, logs, method, path, http_status, browser, os, sha, url, release, environment",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, ts_us INTEGER NOT NULL, trace_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'uncaught', handler TEXT NOT NULL DEFAULT '', cell TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, message TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', frames TEXT NOT NULL DEFAULT '[]', logs TEXT NOT NULL DEFAULT '[]', method TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', http_status INTEGER NOT NULL DEFAULT 0, browser TEXT NOT NULL DEFAULT '', os TEXT NOT NULL DEFAULT '', sha TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', release TEXT NOT NULL DEFAULT '', environment TEXT NOT NULL DEFAULT '')",
            index_names: &["idx_app_error_event_issue_ts"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_error_event_issue_ts ON app_error_event(app_id, environment_id, fingerprint, ts_us)"],
            rebuild_pk: false,
        },
        Table {
            name: "app_error_hour",
            columns: "app_id, environment_id, fingerprint, bucket_hour, n",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, bucket_hour TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id, fingerprint, bucket_hour))",
            index_names: &["idx_app_error_hour_app_hour"],
            indexes: &["CREATE INDEX IF NOT EXISTS metrics.idx_app_error_hour_app_hour ON app_error_hour(app_id, environment_id, bucket_hour)"],
            rebuild_pk: true,
        },
        Table {
            name: "metric_version",
            columns: "app_id, environment_id, version",
            create_body: "(app_id TEXT NOT NULL, environment_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (app_id, environment_id))",
            index_names: &[],
            indexes: &[],
            rebuild_pk: true,
        },
    ];
    for t in TABLES {
        // Table names are internal constants, never user input.
        let live: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT name, pk FROM pragma_table_info('{}', 'metrics')",
            t.name
        )))
        .fetch_all(pool)
        .await?;
        let mut changed = false;
        if !live.iter().any(|(name, _)| name == "environment_id") {
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "ALTER TABLE metrics.{0} ADD COLUMN environment_id TEXT NOT NULL DEFAULT ''",
                t.name
            )))
            .execute(pool)
            .await?;
            changed = true;
        }
        if t.rebuild_pk {
            let live: Vec<(String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT name, pk FROM pragma_table_info('{}', 'metrics')",
                t.name
            )))
            .fetch_all(pool)
            .await?;
            let env_pk = live
                .iter()
                .find(|(name, _)| name == "environment_id")
                .map(|(_, pk)| *pk)
                .unwrap_or(0);
            if env_pk == 0 {
                let mut tx = pool.begin().await?;
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "CREATE TABLE metrics.{0}__new {1}",
                    t.name, t.create_body
                )))
                .execute(&mut *tx)
                .await?;
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "INSERT INTO metrics.{0}__new ({1}) SELECT {1} FROM metrics.{0}",
                    t.name, t.columns
                )))
                .execute(&mut *tx)
                .await?;
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "DROP TABLE metrics.{}",
                    t.name
                )))
                .execute(&mut *tx)
                .await?;
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "ALTER TABLE metrics.{0}__new RENAME TO {0}",
                    t.name
                )))
                .execute(&mut *tx)
                .await?;
                tx.commit().await?;
                changed = true;
            }
        }
        // Drop the old-shape indexes only after a rebuild, but always
        // (re)create the new ones: the rebuild commits before these run, so a
        // crash in between leaves a table whose PK is already rebuilt
        // (`changed` false on the next boot) and that never got its index.
        if changed {
            for index in t.index_names {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "DROP INDEX IF EXISTS metrics.{index}"
                )))
                .execute(pool)
                .await?;
            }
        }
        for create in t.indexes {
            sqlx::query(*create).execute(pool).await?;
        }
    }
    Ok(())
}
