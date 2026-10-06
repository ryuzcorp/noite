//! Deploy history and the deploy/app status transitions it drives.

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::models::{new_id, now_iso, AppStatus, Deploy, DeployStatus};

use super::apps::update_app_status;

/// Newest deploy rows without their build logs: what the reconcile loop
/// needs for the in-flight check (T1.6). `list_deploys` drags 20 full
/// build logs every 5 s per app just to answer "is a deploy running".
pub async fn latest_deploy_status(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(String, String)>> {
    sqlx::query_as::<_, (String, String)>(
        r#"SELECT status, updated_at FROM deploy
           WHERE app_id = ? ORDER BY created_at DESC LIMIT 5"#,
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// Deploy history for the live stream (T1.7): same rows as `list_deploys`
/// but without build-log text, except the newest row when it is still in
/// flight (its live log is what the panel shows). Finished rows' logs come
/// from `get_deploy_log` on demand instead of riding every stream frame.
pub async fn list_deploys_lean(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<Deploy>> {
    // Select the log only for the newest row, and only while it is in
    // flight: reading 20 full build logs to blank 19 of them costs the same
    // SQLite work as the fat query this replaced.
    sqlx::query_as::<_, Deploy>(
        r#"SELECT id, app_id, sha, status,
                  CASE WHEN rn = 1 AND status IN ('building', 'deploying') THEN log ELSE '' END AS log,
                  created_at, updated_at
           FROM (SELECT d.*, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
                 FROM deploy d WHERE app_id = ? ORDER BY created_at DESC LIMIT 20)
           ORDER BY created_at DESC"#,
    )
    .bind(app_id)
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

pub async fn list_deploys(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<Deploy>> {
    sqlx::query_as::<_, Deploy>(
        r#"SELECT id, app_id, sha, status, log, created_at, updated_at
           FROM deploy WHERE app_id = ? ORDER BY created_at DESC LIMIT 20"#,
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// Restorable release pointer: a successful deploy row for this sha.
/// Rollback re-runs the pipeline at the old sha — no separate state.
pub async fn get_success_deploy(
    pool: &SqlitePool,
    app_id: &str,
    sha: &str,
) -> sqlx::Result<Option<Deploy>> {
    sqlx::query_as::<_, Deploy>(
        r#"SELECT id, app_id, sha, status, log, created_at, updated_at
           FROM deploy WHERE app_id = ? AND sha = ? AND status = 'success'
           ORDER BY created_at DESC LIMIT 1"#,
    )
    .bind(app_id)
    .bind(sha)
    .fetch_optional(pool)
    .await
}

pub async fn upsert_deploy(
    pool: &SqlitePool,
    id: Option<&str>,
    app_id: &str,
    status: &str,
    sha: Option<&str>,
    append_log: &str,
) -> sqlx::Result<String> {
    let ts = now_iso();
    if let Some(id) = id {
        if let Some(existing) = sqlx::query_as::<_, Deploy>(
            "SELECT id, app_id, sha, status, log, created_at, updated_at FROM deploy WHERE id = ?",
        )
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
            if status == "success" {
                if let Some(sha) = sha.or(existing.sha.as_deref()) {
                    update_app_status(pool, app_id, AppStatus::Running.as_str(), None, Some(sha))
                        .await?;
                }
            } else if status == "failed" {
                update_app_status(
                    pool,
                    app_id,
                    AppStatus::Failed.as_str(),
                    Some(append_log.trim()),
                    None,
                )
                .await?;
            } else if status == "building" || status == "deploying" {
                update_app_status(pool, app_id, status, None, None).await?;
            }
            return Ok(id.to_string());
        }
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO deploy (id, app_id, sha, status, log, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(app_id)
    .bind(sha)
    .bind(status)
    .bind(append_log)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    let app_status = if status == DeployStatus::Deploying.as_str() {
        AppStatus::Deploying.as_str()
    } else if status == DeployStatus::Failed.as_str() {
        AppStatus::Failed.as_str()
    } else {
        AppStatus::Building.as_str()
    };
    update_app_status(pool, app_id, app_status, None, None).await?;
    Ok(id)
}

pub async fn fail_stuck_deploys(
    pool: &SqlitePool,
    older_than_ms: i64,
    skip_app_ids: &HashSet<String>,
) -> sqlx::Result<u64> {
    let rows = sqlx::query_as::<_, Deploy>(
        "SELECT id, app_id, sha, status, log, created_at, updated_at FROM deploy ORDER BY updated_at DESC LIMIT 200",
    )
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
        update_app_status(
            pool,
            &row.app_id,
            AppStatus::Failed.as_str(),
            Some("deploy stalled (host interrupted or timed out)"),
            None,
        )
        .await?;
        n += 1;
    }
    Ok(n)
}

fn utc_cutoff(older_than_ms: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::milliseconds(older_than_ms)
}
