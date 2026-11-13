//! High-churn telemetry tables (spec T4.1): hourly counters, the log ring,
//! ingest watermarks, error rows and replay requests. All rows live in the
//! ATTACHed `metrics` database.
//!
//! Every per-environment table keys on `(app_id, environment_id, …)` where
//! `environment_id` is `''` for production (the brief's NULL/none is `''`:
//! SQLite allows duplicate NULLs in PKs, so NULL cannot be the none value).

use sqlx::{Sqlite, SqliteConnection, SqlitePool};

use crate::models::{new_id, now_iso, AppMetric};

/// Newest request of one fleet as epoch microseconds (the hourly counters keep
/// the exact stamp, not just the bucket), or None when it never served within
/// retention. The scale-to-zero sweep reads this: hour granularity would have
/// loosened idle detection by up to an hour.
pub async fn last_request_us(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar::<_, Option<i64>>(
        r#"SELECT MAX(last_request_us) FROM metrics.app_hour
           WHERE app_id = ? AND environment_id = ? AND requests > 0"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .fetch_one(pool)
    .await
}

/// One fleet's hourly counters at or after `since_hour`, oldest first: one
/// indexed scan serves the whole dashboard window.
pub async fn list_app_metrics(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
    since_hour: &str,
) -> sqlx::Result<Vec<AppMetric>> {
    sqlx::query_as::<_, AppMetric>(
        r#"SELECT app_id, bucket_hour AS bucket_ts, requests, errors, p50_ms, p95_ms,
                  mem_max_bytes AS memory_max_bytes,
                  CASE WHEN mem_samples > 0 THEN mem_sum_bytes / mem_samples ELSE 0 END
                    AS memory_avg_bytes,
                  cpu_ms
           FROM metrics.app_hour WHERE app_id = ? AND environment_id = ? AND bucket_hour >= ?
           ORDER BY bucket_hour ASC"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(since_hour)
    .fetch_all(pool)
    .await
}

/// The counters one `app_hour` write carries. A whole-row replace (never an
/// increment): the caller owns the hour's state and writes it back every time
/// it changes, so a retried line cannot double count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, sqlx::FromRow)]
pub struct AppHourValues {
    pub requests: i64,
    pub errors: i64,
    pub p50_ms: i64,
    pub p95_ms: i64,
    pub mem_max_bytes: i64,
    /// The hour's cgroup samples as an exact (sum, count) pair. The mean is
    /// derived where it is read (`sum / count`): a stored average cannot be
    /// restored exactly, and every write here is a restore-then-rewrite.
    pub mem_sum_bytes: i64,
    pub mem_samples: i64,
    pub last_request_us: i64,
    pub cpu_ms: i64,
}

/// Column list of one `app_hour` row, in `AppHourValues` order.
const APP_HOUR_COLS: &str = "requests, errors, p50_ms, p95_ms, mem_max_bytes, \
     mem_sum_bytes, mem_samples, last_request_us, cpu_ms";

/// REPLACE one hour of counters. The replacement is the whole row from the
/// caller's accumulator, so writing the same state twice is exact.
pub async fn replace_app_hour(
    conn: &mut SqliteConnection,
    app_id: &str,
    environment_id: &str,
    bucket_hour: &str,
    v: &AppHourValues,
) -> sqlx::Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "INSERT INTO metrics.app_hour (app_id, environment_id, bucket_hour, {APP_HOUR_COLS}) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT (app_id, environment_id, bucket_hour) DO UPDATE SET \
           requests = excluded.requests, errors = excluded.errors, \
           p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms, \
           mem_max_bytes = excluded.mem_max_bytes, \
           mem_sum_bytes = excluded.mem_sum_bytes, mem_samples = excluded.mem_samples, \
           last_request_us = excluded.last_request_us, cpu_ms = excluded.cpu_ms"
    )))
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_hour)
    .bind(v.requests)
    .bind(v.errors)
    .bind(v.p50_ms)
    .bind(v.p95_ms)
    .bind(v.mem_max_bytes)
    .bind(v.mem_sum_bytes)
    .bind(v.mem_samples)
    .bind(v.last_request_us)
    .bind(v.cpu_ms)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// REPLACE one latency histogram bucket's count (same replace rule as the row
/// it feeds).
pub async fn replace_app_hour_lat(
    conn: &mut SqliteConnection,
    app_id: &str,
    environment_id: &str,
    bucket_hour: &str,
    bucket: i64,
    n: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_hour_lat (app_id, environment_id, bucket_hour, bucket, n)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (app_id, environment_id, bucket_hour, bucket) DO UPDATE SET n = excluded.n"#,
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_hour)
    .bind(bucket)
    .bind(n)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The stored counters of one hour, for re-seeding an accumulator after a
/// restart or an eviction.
pub async fn get_app_hour(
    conn: &mut SqliteConnection,
    app_id: &str,
    environment_id: &str,
    bucket_hour: &str,
) -> sqlx::Result<Option<AppHourValues>> {
    sqlx::query_as::<_, AppHourValues>(sqlx::AssertSqlSafe(format!(
        "SELECT {APP_HOUR_COLS} FROM metrics.app_hour \
         WHERE app_id = ? AND environment_id = ? AND bucket_hour = ?"
    )))
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_hour)
    .fetch_optional(&mut *conn)
    .await
}

/// The stored histogram of one hour, as `(bucket, n)`.
pub async fn app_hour_lat(
    conn: &mut SqliteConnection,
    app_id: &str,
    environment_id: &str,
    bucket_hour: &str,
) -> sqlx::Result<Vec<(i64, i64)>> {
    sqlx::query_as(
        "SELECT bucket, n FROM metrics.app_hour_lat \
         WHERE app_id = ? AND environment_id = ? AND bucket_hour = ?",
    )
    .bind(app_id)
    .bind(environment_id)
    .bind(bucket_hour)
    .fetch_all(&mut *conn)
    .await
}

/// Drop hourly counters past retention: the rows and every histogram bucket
/// that fed them.
pub async fn prune_app_hours(pool: &SqlitePool, older_than_hour: &str) -> sqlx::Result<u64> {
    let mut n = sqlx::query("DELETE FROM metrics.app_hour WHERE bucket_hour < ?")
        .bind(older_than_hour)
        .execute(pool)
        .await?
        .rows_affected();
    n += sqlx::query("DELETE FROM metrics.app_hour_lat WHERE bucket_hour < ?")
        .bind(older_than_hour)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(n)
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

/// Queue a replay. `requested_at` is the request's identity for one tick: it
/// carries a random suffix on top of the timestamp so two requests (even in
/// the same millisecond) are never conflated when the tick decides what it
/// has already rewound.
pub async fn set_telemetry_replay(
    pool: &SqlitePool,
    floor_us: i64,
    slug: Option<&str>,
) -> sqlx::Result<()> {
    let request = format!("{}#{}", now_iso(), &new_id()[..8]);
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM main.telemetry_replay")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO main.telemetry_replay (id, floor_us, slug, requested_at) VALUES (1, ?, ?, ?)",
    )
    .bind(floor_us)
    .bind(slug)
    .bind(&request)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Clear the replay row only when it still holds `requested_at`: a request
/// queued after the tick read the row is left in place for the next pass
/// instead of being deleted unapplied. Returns whether this request's row
/// was the one removed.
pub async fn clear_telemetry_replay_if(
    pool: &SqlitePool,
    requested_at: &str,
) -> sqlx::Result<bool> {
    let res = sqlx::query("DELETE FROM main.telemetry_replay WHERE id = 1 AND requested_at = ?")
        .bind(requested_at)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() == 1)
}

/// The trace → request join carried by an access-log line. `backfill` is set
/// when the error ingest stored an occurrence before the line landed.
pub struct AccessTrace<'a> {
    pub trace_id: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub http_status: i64,
    pub browser: &'a str,
    pub os: &'a str,
    pub backfill: bool,
}

/// Backfill a pending error occurrence with the request context its
/// access-log line carried, inside the caller's transaction (which also
/// carries the fleet's hourly counters and commits once). The tail persists
/// its log offset only after that commit: a failure leaves the line unread
/// instead of half-counted.
pub async fn backfill_trace_request(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    app_id: &str,
    environment_id: &str,
    trace: &AccessTrace<'_>,
) -> sqlx::Result<()> {
    if !trace.backfill {
        return Ok(());
    }
    crate::db::errors::backfill_error_request(
        tx,
        app_id,
        environment_id,
        trace.trace_id,
        &crate::db::ErrorRequest {
            method: trace.method,
            path: trace.path,
            http_status: trace.http_status,
            browser: trace.browser,
            os: trace.os,
        },
    )
    .await?;
    Ok(())
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
/// `recent_logs` return.
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

/// Drop every telemetry row of one environment: the hourly counters, the log
/// ring, error issues/events/hours, and its metrics version. Labels can be
/// reused after a delete, so nothing may survive for a successor.
pub async fn delete_environment_telemetry(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
) -> sqlx::Result<u64> {
    let mut n = 0;
    for table in [
        "metrics.app_hour",
        "metrics.app_hour_lat",
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

#[cfg(test)]
mod tests {
    use super::*;

    /// P1: a replay queued while the tick was reading the row must not be
    /// deleted by the tick's later clear. The old unconditional `DELETE` did
    /// exactly that; the conditional clear only removes the request it ran.
    #[tokio::test]
    async fn a_replay_queued_between_read_and_clear_survives() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        set_telemetry_replay(&pool, 100, None)
            .await
            .expect("first replay");
        let first = get_telemetry_replay(&pool)
            .await
            .expect("readable")
            .expect("queued");
        // The CLI queues a second replay after the tick read `first`.
        set_telemetry_replay(&pool, 200, Some("blog"))
            .await
            .expect("second replay");
        let cleared = clear_telemetry_replay_if(&pool, &first.requested_at)
            .await
            .expect("conditional clear");
        assert!(!cleared, "the row now holds a different request");
        let pending = get_telemetry_replay(&pool)
            .await
            .expect("readable")
            .expect("the queued replay survives");
        assert_eq!(pending.floor_us, 200);
        assert_eq!(pending.slug.as_deref(), Some("blog"));
        assert_ne!(pending.requested_at, first.requested_at);
        // The request that did run settles normally.
        assert!(clear_telemetry_replay_if(&pool, &pending.requested_at)
            .await
            .expect("clear"));
        assert!(get_telemetry_replay(&pool).await.expect("read").is_none());
    }

    /// Two requests in the same millisecond are still distinct identities.
    #[tokio::test]
    async fn replay_requests_have_unique_identities() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        set_telemetry_replay(&pool, 1, None).await.expect("first");
        let first = get_telemetry_replay(&pool)
            .await
            .expect("read")
            .expect("row");
        set_telemetry_replay(&pool, 2, None).await.expect("second");
        let second = get_telemetry_replay(&pool)
            .await
            .expect("read")
            .expect("row");
        assert_ne!(first.requested_at, second.requested_at);
    }
}
