//! Error issue folding, occurrence storage, and counting.

use sqlx::SqlitePool;

use crate::models::{ErrorEvent, ErrorIssue};

use super::ISSUE_COLS;

/// Fold occurrences into their issue. The latest occurrence names the
/// issue (message, culprit); a resolved issue that fires after it was
/// resolved reopens as regressed. SET expressions read the pre-update row.
///
/// `count` is NOT accumulated here: on a replay the same occurrence would be
/// added again. It is derived from `app_error_hour` (which the tick replaces
/// per hour) by [`refresh_error_issue_count`]; the insert seeds it only for a
/// brand-new issue so a reader between the two never sees a missing count.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_error_issue(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
    kind: &str,
    message: &str,
    culprit: &str,
    handler: &str,
    source: &str,
    count: i64,
    first_us: i64,
    last_us: i64,
    sha: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_error_issue
           (app_id, fingerprint, kind, message, culprit, handler, source, count,
            first_seen_us, last_seen_us, first_sha, last_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, fingerprint) DO UPDATE SET
             kind = CASE WHEN excluded.last_seen_us >= last_seen_us THEN excluded.kind ELSE kind END,
             message = CASE WHEN excluded.last_seen_us >= last_seen_us THEN excluded.message ELSE message END,
             culprit = CASE WHEN excluded.last_seen_us >= last_seen_us THEN excluded.culprit ELSE culprit END,
             handler = CASE WHEN excluded.last_seen_us >= last_seen_us THEN excluded.handler ELSE handler END,
             source = CASE WHEN excluded.last_seen_us >= last_seen_us THEN excluded.source ELSE source END,
             last_sha = CASE WHEN excluded.last_seen_us >= last_seen_us
                             THEN COALESCE(excluded.last_sha, last_sha) ELSE last_sha END,
             first_seen_us = min(first_seen_us, excluded.first_seen_us),
             last_seen_us = max(last_seen_us, excluded.last_seen_us),
             regressed = CASE WHEN status = 'resolved' AND excluded.last_seen_us > COALESCE(status_at_us, 0)
                              THEN 1 ELSE regressed END,
             status_at_us = CASE WHEN status = 'resolved' AND excluded.last_seen_us > COALESCE(status_at_us, 0)
                                 THEN excluded.last_seen_us ELSE status_at_us END,
             status = CASE WHEN status = 'resolved' AND excluded.last_seen_us > COALESCE(status_at_us, 0)
                           THEN 'open' ELSE status END"#,
    )
    .bind(app_id)
    .bind(fingerprint)
    .bind(kind)
    .bind(message)
    .bind(culprit)
    .bind(handler)
    .bind(source)
    .bind(count)
    .bind(first_us)
    .bind(last_us)
    .bind(sha)
    .bind(sha)
    .execute(pool)
    .await?;
    Ok(())
}

/// Recompute an issue's displayed count from its retained hour buckets. The
/// ingest replaces one hour's bucket at a time, so this stays exact across
/// re-reads and replays.
pub async fn refresh_error_issue_count(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE metrics.app_error_issue SET count = COALESCE( \
           (SELECT SUM(n) FROM metrics.app_error_hour WHERE app_id = ? AND fingerprint = ?), 0) \
         WHERE app_id = ? AND fingerprint = ?",
    )
    .bind(app_id)
    .bind(fingerprint)
    .bind(app_id)
    .bind(fingerprint)
    .execute(pool)
    .await?;
    Ok(())
}

/// REPLACE one hour-bucket of an issue's occurrences. The ingest recomputes
/// the hour from its boundary, so replace, never accumulate.
pub async fn set_error_hour(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
    bucket_hour: &str,
    n: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_error_hour (app_id, fingerprint, bucket_hour, n)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, fingerprint, bucket_hour) DO UPDATE SET n = excluded.n"#,
    )
    .bind(app_id)
    .bind(fingerprint)
    .bind(bucket_hour)
    .bind(n)
    .execute(pool)
    .await?;
    Ok(())
}

pub struct NewErrorEvent<'a> {
    pub app_id: &'a str,
    pub fingerprint: &'a str,
    pub ts_us: i64,
    pub trace_id: &'a str,
    pub source: &'a str,
    pub handler: &'a str,
    pub cell: &'a str,
    pub kind: &'a str,
    pub message: &'a str,
    pub context: &'a str,
    pub frames: &'a str,
    pub logs: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub http_status: i64,
    pub browser: &'a str,
    pub os: &'a str,
    pub sha: &'a str,
}

/// Insert one occurrence unless the same one (issue + timestamp + trace) is
/// already stored. A re-read or replay of a window therefore adds only the
/// occurrences that were genuinely missing, and keeps the request context the
/// first ingest captured (the in-memory trace index is long gone on a replay).
pub async fn insert_error_event(pool: &SqlitePool, e: &NewErrorEvent<'_>) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_error_event
           (app_id, fingerprint, ts_us, trace_id, source, handler, cell, kind, message,
            context, frames, logs, method, path, http_status, browser, os, sha)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM metrics.app_error_event
              WHERE app_id = ? AND fingerprint = ? AND ts_us = ? AND trace_id = ?
           )"#,
    )
    .bind(e.app_id)
    .bind(e.fingerprint)
    .bind(e.ts_us)
    .bind(e.trace_id)
    .bind(e.source)
    .bind(e.handler)
    .bind(e.cell)
    .bind(e.kind)
    .bind(e.message)
    .bind(e.context)
    .bind(e.frames)
    .bind(e.logs)
    .bind(e.method)
    .bind(e.path)
    .bind(e.http_status)
    .bind(e.browser)
    .bind(e.os)
    .bind(e.sha)
    .bind(e.app_id)
    .bind(e.fingerprint)
    .bind(e.ts_us)
    .bind(e.trace_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Keep the newest `keep` occurrences of one issue.
pub async fn prune_error_events(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
    keep: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "DELETE FROM metrics.app_error_event WHERE app_id = ? AND fingerprint = ? AND rowid NOT IN \
         (SELECT rowid FROM metrics.app_error_event WHERE app_id = ? AND fingerprint = ? \
          ORDER BY ts_us DESC, rowid DESC LIMIT ?)",
    )
    .bind(app_id)
    .bind(fingerprint)
    .bind(app_id)
    .bind(fingerprint)
    .bind(keep)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Issues in one status, most recently seen first.
pub async fn list_error_issues(
    pool: &SqlitePool,
    app_id: &str,
    status: &str,
    limit: i64,
) -> sqlx::Result<Vec<ErrorIssue>> {
    sqlx::query_as::<_, ErrorIssue>(&format!(
        "SELECT {ISSUE_COLS} FROM metrics.app_error_issue \
         WHERE app_id = ? AND status = ? ORDER BY last_seen_us DESC LIMIT ?"
    ))
    .bind(app_id)
    .bind(status)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Issue counts per status (`open`, `resolved`, `ignored`).
pub async fn count_error_issues(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(String, i64)>> {
    sqlx::query_as(
        "SELECT status, count(*) FROM metrics.app_error_issue WHERE app_id = ? GROUP BY status",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

pub async fn get_error_issue(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
) -> sqlx::Result<Option<ErrorIssue>> {
    sqlx::query_as::<_, ErrorIssue>(&format!(
        "SELECT {ISSUE_COLS} FROM metrics.app_error_issue WHERE app_id = ? AND fingerprint = ?"
    ))
    .bind(app_id)
    .bind(fingerprint)
    .fetch_optional(pool)
    .await
}

pub async fn list_error_events(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
) -> sqlx::Result<Vec<ErrorEvent>> {
    sqlx::query_as::<_, ErrorEvent>(
        "SELECT ts_us, trace_id, source, handler, cell, kind, message, context, frames, logs, \
                method, path, http_status, browser, os, sha \
         FROM metrics.app_error_event WHERE app_id = ? AND fingerprint = ? \
         ORDER BY ts_us DESC, rowid DESC",
    )
    .bind(app_id)
    .bind(fingerprint)
    .fetch_all(pool)
    .await
}

/// Hourly counts since `since_hour` for every issue of an app:
/// (fingerprint, bucket_hour, n).
pub async fn list_error_hours(
    pool: &SqlitePool,
    app_id: &str,
    since_hour: &str,
) -> sqlx::Result<Vec<(String, String, i64)>> {
    sqlx::query_as(
        "SELECT fingerprint, bucket_hour, n FROM metrics.app_error_hour \
         WHERE app_id = ? AND bucket_hour >= ?",
    )
    .bind(app_id)
    .bind(since_hour)
    .fetch_all(pool)
    .await
}

/// Resolve, ignore or reopen. Clears `regressed`; `status_at_us` is the
/// point a resolved issue reopens after.
pub async fn set_error_status(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
    status: &str,
    at_us: i64,
) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "UPDATE metrics.app_error_issue SET status = ?, regressed = 0, status_at_us = ? \
         WHERE app_id = ? AND fingerprint = ?",
    )
    .bind(status)
    .bind(at_us)
    .bind(app_id)
    .bind(fingerprint)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Retention: occurrences and hour buckets past the window, and issues not
/// seen inside it.
pub async fn prune_errors(
    pool: &SqlitePool,
    cutoff_us: i64,
    cutoff_hour: &str,
) -> sqlx::Result<u64> {
    let mut n = sqlx::query("DELETE FROM metrics.app_error_event WHERE ts_us < ?")
        .bind(cutoff_us)
        .execute(pool)
        .await?
        .rows_affected();
    n += sqlx::query("DELETE FROM metrics.app_error_hour WHERE bucket_hour < ?")
        .bind(cutoff_hour)
        .execute(pool)
        .await?
        .rows_affected();
    n += sqlx::query("DELETE FROM metrics.app_error_issue WHERE last_seen_us < ?")
        .bind(cutoff_us)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(n)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::{SqliteConnection, SqlitePoolOptions};

    use super::*;

    #[tokio::test]
    async fn error_issue_folds_and_regresses_after_resolve() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .after_connect(|conn: &mut SqliteConnection, _| {
                Box::pin(async move {
                    crate::db::attach_metrics!(conn, ":memory:");
                    Ok::<_, sqlx::Error>(())
                })
            })
            .connect("sqlite::memory:")
            .await
            .expect("in-memory db");
        let up = |msg: &'static str, n: i64, at: i64, sha: &'static str| {
            let pool = pool.clone();
            async move {
                upsert_error_issue(
                    &pool,
                    "a",
                    "fp",
                    "TypeError",
                    msg,
                    "f (w.js:1)",
                    "fetch",
                    "uncaught",
                    n,
                    at,
                    at,
                    Some(sha),
                )
                .await
                .expect("upsert");
                // The displayed count is derived from the per-hour buckets the
                // ingest replaces, so seed a distinct bucket per call, as a
                // chunk would.
                set_error_hour(&pool, "a", "fp", &format!("{at}"), n)
                    .await
                    .expect("hour");
                refresh_error_issue_count(&pool, "a", "fp")
                    .await
                    .expect("count");
            }
        };
        up("first", 2, 100, "s1").await;
        up("second", 3, 200, "s2").await;
        // A late batch from before the newest occurrence must not rename it.
        up("stale", 1, 150, "s0").await;
        let issue = get_error_issue(&pool, "a", "fp")
            .await
            .expect("get")
            .expect("issue");
        assert_eq!(issue.count, 6);
        assert_eq!(issue.message, "second");
        assert_eq!((issue.first_seen_us, issue.last_seen_us), (100, 200));
        assert_eq!(issue.first_sha.as_deref(), Some("s1"));
        assert_eq!(issue.last_sha.as_deref(), Some("s2"));
        assert_eq!(issue.status, "open");

        set_error_status(&pool, "a", "fp", "resolved", 300)
            .await
            .expect("resolve");
        // An occurrence from before the resolve (ingest lag) keeps it resolved.
        up("second", 1, 250, "s2").await;
        let issue = get_error_issue(&pool, "a", "fp")
            .await
            .expect("get")
            .expect("issue");
        assert_eq!(
            (issue.status.as_str(), issue.regressed),
            ("resolved", false)
        );
        // One after it reopens the issue as a regression.
        up("second", 1, 400, "s3").await;
        let issue = get_error_issue(&pool, "a", "fp")
            .await
            .expect("get")
            .expect("issue");
        assert_eq!((issue.status.as_str(), issue.regressed), ("open", true));

        // Ignored stays ignored however often it fires.
        set_error_status(&pool, "a", "fp", "ignored", 500)
            .await
            .expect("ignore");
        up("second", 1, 600, "s3").await;
        let issue = get_error_issue(&pool, "a", "fp")
            .await
            .expect("get")
            .expect("issue");
        assert_eq!((issue.status.as_str(), issue.regressed), ("ignored", false));
        assert_eq!(issue.count, 9);
    }
}
