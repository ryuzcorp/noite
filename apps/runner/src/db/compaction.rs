//! Durable compaction watermarks and per-app metrics versions (specs T3.5/T3.6).

use sqlx::SqlitePool;

use crate::models::now_iso;

/// Durable compaction watermark (spec T3.5): the last compacted hour per
/// slug, so an hour due while the runner was down is still folded later.
pub async fn get_compacted_hours(
    pool: &SqlitePool,
) -> sqlx::Result<std::collections::HashMap<String, String>> {
    // One row per (slug, hour); the max hour per slug is the watermark.
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT slug, MAX(hour) FROM metrics.metric_compaction GROUP BY slug")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

pub async fn mark_hour_compacted(pool: &SqlitePool, slug: &str, hour: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO metrics.metric_compaction (slug, hour, compacted_at) \
         VALUES (?, ?, ?) ON CONFLICT (slug, hour) DO NOTHING",
    )
    .bind(slug)
    .bind(hour)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn prune_compactions(pool: &SqlitePool, older_than_hour: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM metrics.metric_compaction WHERE hour < ?")
        .bind(older_than_hour)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Per-app metrics version (spec T3.6): bumped by the ingest tick whenever
/// it persists new rows, so dashboard polls can skip unchanged windows.
pub async fn bump_metric_version(pool: &SqlitePool, app_id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO metrics.metric_version (app_id, version) VALUES (?, 1) \
         ON CONFLICT (app_id) DO UPDATE SET version = version + 1",
    )
    .bind(app_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_metric_version(pool: &SqlitePool, app_id: &str) -> sqlx::Result<u64> {
    let v: Option<i64> =
        sqlx::query_scalar("SELECT version FROM metrics.metric_version WHERE app_id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await?;
    Ok(v.unwrap_or(0).max(0) as u64)
}
