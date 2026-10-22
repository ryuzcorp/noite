//! Deploy history and the deploy/app status transitions it drives.
//!
//! A deploy targets production (`environment_id IS NULL`) or one preview
//! environment. The two never share state: a production deploy writes
//! `app.last_deploy_sha` and the app's status, an environment deploy writes
//! the environment's own row.

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::models::{new_id, now_iso, AppStatus, Deploy};

use super::apps::{record_app_deploy_sha, update_app_status_if_wanted};
use super::environments::{mark_environment_deployed, update_environment_status_if_wanted};

/// Columns every `deploy` query selects, in [`Deploy`] order.
const DEPLOY_COLS: &str = "id, app_id, environment_id, sha, status, log, created_at, updated_at";

/// Newest deploy rows without their build logs: what the reconcile loop
/// needs for the in-flight check (T1.6). `list_deploys` drags 20 full
/// build logs every 5 s per app just to answer "is a deploy running".
/// Production only: a preview build is never what "the app is deploying"
/// means, and the app's own status must not follow it.
pub async fn latest_deploy_status(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT status, updated_at FROM deploy
           WHERE app_id = ? AND environment_id IS NULL
           ORDER BY created_at DESC LIMIT 5"#,
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// The newest deploy row of one environment, if any (`sha` is what a tip
/// deploy dedupes against, `updated_at` its idle clock).
pub async fn latest_deploy_status_for_env(
    pool: &SqlitePool,
    environment_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT status, updated_at FROM deploy
           WHERE environment_id = ? ORDER BY created_at DESC LIMIT 5"#,
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await
}

/// One target clause for both cases, always bound once: SQLite's `IS` is
/// `=` for non-null values and `IS NULL` when the bound value is NULL, so
/// production (`None`) and one environment (`Some(id)`) share the statement
/// and its single parameter.
const TARGET_CLAUSE: &str = "environment_id IS ?";

/// Deploy history for the live stream (T1.7): same rows as `list_deploys`
/// but without build-log text, except the newest row when it is still in
/// flight (its live log is what the panel shows). Finished rows' logs come
/// from `get_deploy_log` on demand instead of riding every stream frame.
/// `environment_id` selects a preview's history; `None` is production.
pub async fn list_deploys_lean(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> sqlx::Result<Vec<Deploy>> {
    // Select the log only for the newest row, and only while it is in
    // flight: reading 20 full build logs to blank 19 of them costs the same
    // SQLite work as the fat query this replaced.
    let sql = format!(
        r#"SELECT id, app_id, environment_id, sha, status,
                  CASE WHEN rn = 1 AND status IN ('building', 'deploying') THEN log ELSE '' END AS log,
                  created_at, updated_at
           FROM (SELECT d.*, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
                 FROM deploy d WHERE d.app_id = ? AND d.{TARGET_CLAUSE}
                 ORDER BY created_at DESC LIMIT 20)
           ORDER BY created_at DESC"#,
    );
    sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(environment_id)
        .fetch_all(pool)
        .await
}

/// One deploy's build log, fetched on demand when its panel opens (T1.7).
/// Finished deploys never change, so callers may cache this forever.
pub async fn get_deploy_log(
    pool: &SqlitePool,
    app_id: &str,
    deploy_id: &str,
) -> sqlx::Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as::<_, (String,)>(r#"SELECT log FROM deploy WHERE id = ? AND app_id = ?"#)
            .bind(deploy_id)
            .bind(app_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(log,)| log))
}

/// Deploy history: `environment_id = None` is the app's production history,
/// `Some` is one preview environment's.
pub async fn list_deploys(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> sqlx::Result<Vec<Deploy>> {
    let sql = format!(
        "SELECT {DEPLOY_COLS} FROM deploy WHERE app_id = ? AND {TARGET_CLAUSE} \
         ORDER BY created_at DESC LIMIT 20",
    );
    sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(environment_id)
        .fetch_all(pool)
        .await
}

/// Restorable release pointer: a successful production deploy row for this
/// sha. Rollback re-runs the pipeline at the old sha — no separate state.
pub async fn get_success_deploy(
    pool: &SqlitePool,
    app_id: &str,
    sha: &str,
) -> sqlx::Result<Option<Deploy>> {
    let sql = format!(
        "SELECT {DEPLOY_COLS} FROM deploy \
         WHERE app_id = ? AND sha = ? AND status = 'success' AND environment_id IS NULL \
         ORDER BY created_at DESC LIMIT 1"
    );
    sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(sha)
        .fetch_optional(pool)
        .await
}

/// Create or continue one deploy row. `environment_id = None` keeps the
/// production transitions (app status + `app.last_deploy_sha`); a preview
/// deploy writes the environment's status, sha and error instead, so it can
/// never move the app's.
pub async fn upsert_deploy(
    pool: &SqlitePool,
    id: Option<&str>,
    app_id: &str,
    environment_id: Option<&str>,
    status: &str,
    sha: Option<&str>,
    append_log: &str,
) -> sqlx::Result<String> {
    let ts = now_iso();
    if let Some(id) = id {
        if let Some(existing) = sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(format!(
            "SELECT {DEPLOY_COLS} FROM deploy WHERE id = ?"
        )))
        .bind(id)
        .fetch_optional(pool)
        .await?
        {
            // Keep the tail — deploy logs grow with every push and the UI
            // collapsible must stay cheap.
            let combined = format!("{}{append_log}", existing.log);
            let log = crate::lifecycle::tail_utf8(&combined, 64 * 1024).to_string();
            sqlx::query(
                "UPDATE deploy SET status = ?, sha = COALESCE(?, sha), log = ?, updated_at = ? WHERE id = ?",
            )
            .bind(status)
            .bind(sha)
            .bind(&log)
            .bind(&ts)
            .bind(id)
            .execute(pool)
            .await?;
            apply_status(pool, app_id, environment_id, status, sha, append_log).await?;
            return Ok(id.to_string());
        }
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO deploy (id, app_id, environment_id, sha, status, log, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(app_id)
    .bind(environment_id)
    .bind(sha)
    .bind(status)
    .bind(append_log)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    apply_status(pool, app_id, environment_id, status, sha, append_log).await?;
    Ok(id)
}

/// The success transition of a deploy's target: the sha it now serves, and
/// `running` while it still wants to run (production: the app; a preview: its
/// environment). This is what makes the target routable at the edge
/// (`edge_table::serves`, `edge::env_live`), so a deploy calls it and pushes
/// the route table *before* its row reads `success`: a client that waits for
/// the row must find the edge already routing (the success upsert re-applies
/// it idempotently).
pub async fn mark_deploy_live(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    sha: &str,
) -> sqlx::Result<()> {
    match environment_id {
        // `mark_environment_deployed` records the sha unconditionally and
        // flips to running only while still wanted.
        Some(environment_id) => mark_environment_deployed(pool, environment_id, sha).await,
        None => {
            record_app_deploy_sha(pool, app_id, sha).await?;
            update_app_status_if_wanted(pool, app_id, AppStatus::Running.as_str(), None).await?;
            Ok(())
        }
    }
}

/// Where a deploy row's status lands: the app (production) or its
/// environment (preview). Every write is stop-race safe: the sha lands even
/// when a stop raced the deploy, but `running`/`failed`/in-flight only apply
/// while the target still wants to run — a stop (or delete) in the window
/// must win over the deploy's status flip.
async fn apply_status(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    status: &str,
    sha: Option<&str>,
    append_log: &str,
) -> sqlx::Result<()> {
    if status == "success" {
        return match sha {
            Some(sha) => mark_deploy_live(pool, app_id, environment_id, sha).await,
            None => match environment_id {
                Some(environment_id) => {
                    update_environment_status_if_wanted(pool, environment_id, "running", None)
                        .await
                        .map(|_| ())
                }
                None => Ok(()),
            },
        };
    }
    let Some(environment_id) = environment_id else {
        if status == "failed" {
            update_app_status_if_wanted(
                pool,
                app_id,
                AppStatus::Failed.as_str(),
                Some(append_log.trim()),
            )
            .await?;
        } else if status == "building" || status == "deploying" {
            update_app_status_if_wanted(pool, app_id, status, None).await?;
        }
        return Ok(());
    };
    match status {
        "failed" => {
            update_environment_status_if_wanted(
                pool,
                environment_id,
                AppStatus::Failed.as_str(),
                Some(append_log.trim()),
            )
            .await?;
        }
        other => {
            update_environment_status_if_wanted(pool, environment_id, other, None).await?;
        }
    }
    Ok(())
}

/// Sweep deploys whose row has not moved since `older_than_ms`, marking them
/// failed. A preview row marks its environment, never the app.
pub async fn fail_stuck_deploys(
    pool: &SqlitePool,
    older_than_ms: i64,
    skip_app_ids: &HashSet<String>,
) -> sqlx::Result<u64> {
    let rows = sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(format!(
        "SELECT {DEPLOY_COLS} FROM deploy ORDER BY updated_at DESC LIMIT 200"
    )))
    .fetch_all(pool)
    .await?;
    let cutoff = utc_cutoff(older_than_ms);
    let mut n = 0u64;
    for row in rows {
        if skip_app_ids.contains(&row.app_id) {
            continue;
        }
        let Some(st) = row.status_enum() else {
            continue;
        };
        if !st.is_in_flight() {
            continue;
        }
        let Some(updated) = crate::models::parse_time(&row.updated_at) else {
            continue;
        };
        if updated > cutoff {
            continue;
        }
        let log = format!(
            "{}ERROR: deploy stalled (host interrupted or timed out)\n",
            row.log
        );
        sqlx::query("UPDATE deploy SET status = 'failed', log = ?, updated_at = ? WHERE id = ?")
            .bind(&log)
            .bind(now_iso())
            .bind(&row.id)
            .execute(pool)
            .await?;
        match row.environment_id.as_deref() {
            Some(env_id) => {
                // The row still records the stall, but a stop in the window
                // keeps its status.
                update_environment_status_if_wanted(
                    pool,
                    env_id,
                    AppStatus::Failed.as_str(),
                    Some("deploy stalled (host interrupted or timed out)"),
                )
                .await?;
            }
            None => {
                update_app_status_if_wanted(
                    pool,
                    &row.app_id,
                    AppStatus::Failed.as_str(),
                    Some("deploy stalled (host interrupted or timed out)"),
                )
                .await?;
            }
        }
        n += 1;
    }
    Ok(n)
}

fn utc_cutoff(older_than_ms: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::milliseconds(older_than_ms)
}
