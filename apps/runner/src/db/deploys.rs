//! Deploy history and the deploy/app status transitions it drives.
//!
//! A deploy targets production (`environment_id IS NULL`) or one preview
//! environment. The two never share state: a production deploy writes
//! `app.last_deploy_sha` and the app's status, an environment deploy writes
//! the environment's own row.
//!
//! One row's lifecycle is [`crate::models::DeployStatus`]:
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Queued: caller pre-creates the row (rollback, env deploy)
//!   [*] --> Building: a background tip deploy creates its own row
//!   Queued --> Building: the pipeline's first step
//!   Queued --> Deploying: a step that stages straight away
//!   Building --> Deploying: stage/activate phase
//!   Building --> Success: deploy live
//!   Deploying --> Success: deploy live
//!   Queued --> Failed: claim timeout, operator stop
//!   Building --> Failed: step failure, stall, operator stop
//!   Deploying --> Failed: step failure, stall, operator stop
//! ```
//!
//! `success` and `failed` are terminal: `upsert_deploy` carries the table as
//! `status IN (…)`, so a late log line, a stalled-sweep or a second stop is
//! refused instead of rewriting a finished row.

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::models::{
    new_id, now_iso, AppStatus, Deploy, DeployStatus, DeployWrite, StatusWrite, WriteGuard,
};

use super::apps::{record_app_deploy_sha, status_list, write_app_status};
use super::environments::{mark_environment_deployed, write_environment_status};

/// Columns every `deploy` query selects, in [`Deploy`] order.
const DEPLOY_COLS: &str = "id, app_id, environment_id, sha, status, log, created_at, updated_at";

/// The only states a running deploy can be closed from (the terminal writers:
/// stop endpoint, stall sweep, the run itself).
const IN_FLIGHT: &[DeployStatus] = &[
    DeployStatus::Queued,
    DeployStatus::Building,
    DeployStatus::Deploying,
];

/// Newest deploy rows without their build logs: what the reconcile loop
/// needs for the in-flight check (T1.6). `list_deploys` drags 20 full
/// build logs every 5 s per app just to answer "is a deploy running".
/// Production only: a preview build is never what "the app is deploying"
/// means, and the app's own status must not follow it.
pub async fn latest_deploy_status(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<(DeployStatus, String)>> {
    sqlx::query_as::<_, (DeployStatus, String)>(
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
) -> sqlx::Result<Vec<(DeployStatus, String)>> {
    sqlx::query_as::<_, (DeployStatus, String)>(
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

/// One deploy row of `app_id`: the stop endpoint's ownership check (a token is
/// only tripped for a row this app owns) and its status read.
pub async fn get_deploy(
    pool: &SqlitePool,
    app_id: &str,
    deploy_id: &str,
) -> sqlx::Result<Option<Deploy>> {
    let sql = format!("SELECT {DEPLOY_COLS} FROM deploy WHERE id = ? AND app_id = ? LIMIT 1");
    sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(sql))
        .bind(deploy_id)
        .bind(app_id)
        .fetch_optional(pool)
        .await
}

/// Close an in-flight row with the operator's line. `false` = the row was not
/// in flight (it finished between the read and this update), so nothing was
/// stopped.
pub async fn mark_deploy_cancelled(
    pool: &SqlitePool,
    app_id: &str,
    deploy_id: &str,
) -> sqlx::Result<bool> {
    let res = sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE deploy SET status = ?, log = log || ?, updated_at = ? \
         WHERE id = ? AND app_id = ? AND status IN ({})",
        status_list(IN_FLIGHT),
    )))
    .bind(DeployStatus::Failed.as_str())
    .bind(format!("ERROR: {}\n", crate::host::cancel::CANCELLED))
    .bind(now_iso())
    .bind(deploy_id)
    .bind(app_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
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

/// Restorable release pointer: a successful deploy row for this sha, in one
/// target (`environment_id = None` is production). Rollback re-runs the
/// pipeline at the old sha — no separate state.
pub async fn get_success_deploy(
    pool: &SqlitePool,
    app_id: &str,
    sha: &str,
    environment_id: Option<&str>,
) -> sqlx::Result<Option<Deploy>> {
    let sql = format!(
        "SELECT {DEPLOY_COLS} FROM deploy \
         WHERE app_id = ? AND sha = ? AND status = ? AND {TARGET_CLAUSE} \
         ORDER BY created_at DESC LIMIT 1"
    );
    sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(sha)
        .bind(DeployStatus::Success.as_str())
        .bind(environment_id)
        .fetch_optional(pool)
        .await
}

/// What one [`upsert_deploy`] did: the row's id, whether the write landed,
/// and — when it did not — the terminal status that closed the row first.
pub struct DeployUpsert {
    pub id: String,
    pub outcome: DeployWrite,
}

/// Create or continue one deploy row. `environment_id = None` keeps the
/// production transitions (app status + `app.last_deploy_sha`); a preview
/// deploy writes the environment's status, sha and error instead, so it can
/// never move the app's.
///
/// The status write carries [`DeployStatus::predecessors`] as
/// `status IN (…)`, so a run whose row was closed as `failed` by the stall
/// sweep or the stop endpoint cannot resurrect it as `building`: the write is
/// refused, the log line is not appended, and the caller learns which
/// terminal status won.
pub async fn upsert_deploy(
    pool: &SqlitePool,
    id: Option<&str>,
    app_id: &str,
    environment_id: Option<&str>,
    status: DeployStatus,
    sha: Option<&str>,
    append_log: &str,
) -> sqlx::Result<DeployUpsert> {
    let ts = now_iso();
    if let Some(id) = id {
        if let Some(existing) = sqlx::query_as::<_, Deploy>(sqlx::AssertSqlSafe(format!(
            "SELECT {DEPLOY_COLS} FROM deploy WHERE id = ? AND app_id = ?"
        )))
        .bind(id)
        .bind(app_id)
        .fetch_optional(pool)
        .await?
        {
            // Keep the tail — deploy logs grow with every push and the UI
            // collapsible must stay cheap.
            let combined = format!("{}{append_log}", existing.log);
            let log = crate::lifecycle::tail_utf8(&combined, 64 * 1024).to_string();
            let sql = format!(
                "UPDATE deploy SET status = ?, sha = COALESCE(?, sha), log = ?, updated_at = ? \
                 WHERE id = ? AND app_id = ? AND status IN ({})",
                status_list(status.predecessors()),
            );
            let done = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(status.as_str())
                .bind(sha)
                .bind(&log)
                .bind(&ts)
                .bind(id)
                .bind(app_id)
                .execute(pool)
                .await?;
            if done.rows_affected() == 0 {
                let current: Option<(DeployStatus,)> =
                    sqlx::query_as("SELECT status FROM deploy WHERE id = ?")
                        .bind(id)
                        .fetch_optional(pool)
                        .await?;
                let current = current.map(|(status,)| status).unwrap_or(existing.status);
                return Ok(DeployUpsert {
                    id: id.to_string(),
                    outcome: DeployWrite::Refused { current },
                });
            }
            apply_status(pool, app_id, environment_id, status, sha, append_log).await?;
            return Ok(DeployUpsert {
                id: id.to_string(),
                outcome: DeployWrite::Applied,
            });
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
    .bind(status.as_str())
    .bind(append_log)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    apply_status(pool, app_id, environment_id, status, sha, append_log).await?;
    Ok(DeployUpsert {
        id,
        outcome: DeployWrite::Applied,
    })
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
        Some(environment_id) => mark_environment_deployed(pool, environment_id, sha)
            .await
            .map(|_| ()),
        None => {
            record_app_deploy_sha(pool, app_id, sha).await?;
            write_app_status(
                pool,
                app_id,
                AppStatus::Running,
                None,
                Some(sha),
                WriteGuard::Wanted,
            )
            .await?;
            Ok(())
        }
    }
}

/// Where a deploy row's status lands: the app (production) or its
/// environment (preview). Every write is stop-race safe: the sha lands even
/// when a stop raced the deploy, but `running`/`failed`/in-flight only apply
/// while the target still wants to run — a stop (or delete) in the window
/// must win over the deploy's status flip. The status itself is still the
/// target machine's table, so an illegal move is refused there too.
async fn apply_status(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    status: DeployStatus,
    sha: Option<&str>,
    append_log: &str,
) -> sqlx::Result<StatusWrite> {
    match status {
        DeployStatus::Success => match (sha, environment_id) {
            (Some(sha), _) => mark_deploy_live(pool, app_id, environment_id, sha)
                .await
                .map(|()| StatusWrite::Applied),
            (None, Some(environment_id)) => {
                write_environment_status(
                    pool,
                    environment_id,
                    AppStatus::Running,
                    None,
                    WriteGuard::Wanted,
                )
                .await
            }
            (None, None) => Ok(StatusWrite::Applied),
        },
        DeployStatus::Failed => {
            write_target_status(
                pool,
                app_id,
                environment_id,
                AppStatus::Failed,
                Some(append_log.trim()),
            )
            .await
        }
        // A queued deploy is work in flight for the target: the chip says
        // building, exactly as the run that holds the claim does.
        DeployStatus::Queued | DeployStatus::Building => {
            write_target_status(pool, app_id, environment_id, AppStatus::Building, None).await
        }
        DeployStatus::Deploying => {
            write_target_status(pool, app_id, environment_id, AppStatus::Deploying, None).await
        }
    }
}

/// One chip write on the deploy's target: the app for production, the
/// environment for a preview, always guarded by "still wants to run".
async fn write_target_status(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    next: AppStatus,
    last_error: Option<&str>,
) -> sqlx::Result<StatusWrite> {
    match environment_id {
        Some(environment_id) => {
            write_environment_status(pool, environment_id, next, last_error, WriteGuard::Wanted)
                .await
        }
        None => write_app_status(pool, app_id, next, last_error, None, WriteGuard::Wanted).await,
    }
}

/// Sweep deploys whose row has not moved since `older_than_ms`, marking them
/// failed. A preview row marks its environment, never the app. The row write
/// is guarded by the transition table, so a row that another writer closed
/// between the read and the update is left alone (and does not touch the
/// target's status).
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
    let mut n = 0u64;
    for row in rows {
        if skip_app_ids.contains(&row.app_id) {
            continue;
        }
        let st = row.status;
        if !st.is_in_flight() {
            continue;
        }
        let Some(updated) = crate::models::parse_time(&row.updated_at) else {
            continue;
        };
        // A queued row is the bounded wait for the app's claim: it resolves
        // itself within `older_than_ms`, so only twice that is a stall.
        let limit = match st {
            DeployStatus::Queued => older_than_ms.saturating_mul(2),
            _ => older_than_ms,
        };
        if updated > utc_cutoff(limit) {
            continue;
        }
        let log = format!(
            "{}ERROR: deploy stalled (host interrupted or timed out)\n",
            row.log
        );
        let sql = format!(
            "UPDATE deploy SET status = ?, log = ?, updated_at = ? \
             WHERE id = ? AND status IN ({})",
            status_list(IN_FLIGHT),
        );
        let closed = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(DeployStatus::Failed.as_str())
            .bind(&log)
            .bind(now_iso())
            .bind(&row.id)
            .execute(pool)
            .await?;
        if closed.rows_affected() == 0 {
            // Another writer (the stop endpoint, the run itself) got there
            // first: its story stands, and the target keeps its status.
            continue;
        }
        write_target_status(
            pool,
            &row.app_id,
            row.environment_id.as_deref(),
            AppStatus::Failed,
            Some("deploy stalled (host interrupted or timed out)"),
        )
        .await?;
        n += 1;
    }
    Ok(n)
}

fn utc_cutoff(older_than_ms: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now() - chrono::Duration::milliseconds(older_than_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::App;

    async fn seed_app(pool: &SqlitePool, id: &str) -> App {
        let cfg = crate::config::config_for_tests();
        sqlx::query(
            "INSERT INTO app (id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket, \
             listen_port, internal_port, desired_state, created_at, updated_at) \
             VALUES (?, ?, ?, 'local', 'running', ?, ?, ?, 30000, 30001, 'running', \
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .bind(id)
        .bind(id)
        .bind(id)
        .bind(format!("{id}.{}", cfg.base_domain))
        .bind(format!("git/{id}/"))
        .bind(format!("s3://{}/fleets/{id}", cfg.s3_bucket))
        .execute(pool)
        .await
        .expect("seed app");
        crate::db::get_app(pool, id)
            .await
            .expect("read app")
            .expect("row")
    }

    /// A terminal row is final: the late log line, the stall sweep and the
    /// second stop are refused instead of rewriting a finished deploy — the
    /// bug that let a run resurrect a `failed` row as `building` (only the
    /// "live run owns the token" invariant stood in its way).
    #[tokio::test]
    async fn a_terminal_deploy_row_never_moves_again() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("db");
        let app = seed_app(&pool, "lifecycle").await;
        let queued = upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Queued,
            Some("abc1234"),
            "▸ queued\n",
        )
        .await
        .expect("queued row");
        assert!(queued.outcome.is_applied());

        let built = upsert_deploy(
            &pool,
            Some(&queued.id),
            &app.id,
            None,
            DeployStatus::Building,
            Some("abc1234"),
            "▸ build\n",
        )
        .await
        .expect("building");
        assert!(built.outcome.is_applied(), "queued -> building is legal");

        // The stop endpoint (no live token) closes the row.
        assert!(mark_deploy_cancelled(&pool, &app.id, &queued.id)
            .await
            .expect("cancel"));
        let failed = get_deploy(&pool, &app.id, &queued.id)
            .await
            .expect("read")
            .expect("row");
        assert_eq!(failed.status, DeployStatus::Failed);

        // A late step log now loses: nothing rewrites the row.
        let late = upsert_deploy(
            &pool,
            Some(&queued.id),
            &app.id,
            None,
            DeployStatus::Deploying,
            Some("abc1234"),
            "▸ late line\n",
        )
        .await
        .expect("late write");
        assert_eq!(
            late.outcome,
            DeployWrite::Refused {
                current: DeployStatus::Failed
            }
        );
        let after = get_deploy(&pool, &app.id, &queued.id)
            .await
            .expect("read")
            .expect("row");
        assert_eq!(after.status, DeployStatus::Failed);
        assert!(!after.log.contains("late line"), "{}", after.log);
        assert!(
            !mark_deploy_cancelled(&pool, &app.id, &queued.id)
                .await
                .expect("second cancel"),
            "a finished row is not in flight"
        );

        // Same for a success row.
        let live = upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Success,
            Some("abc1234"),
            "deploy complete\n",
        )
        .await
        .expect("success row");
        let reopened = upsert_deploy(
            &pool,
            Some(&live.id),
            &app.id,
            None,
            DeployStatus::Building,
            Some("abc1234"),
            "▸ rewrite\n",
        )
        .await
        .expect("reopen attempt");
        assert_eq!(
            reopened.outcome,
            DeployWrite::Refused {
                current: DeployStatus::Success
            }
        );
    }

    /// The stall sweep only closes rows that are still in flight, and only
    /// touches the target's status for a row it actually closed: a row the
    /// stop endpoint already failed keeps its own story.
    #[tokio::test]
    async fn the_stall_sweep_refuses_rows_another_writer_closed() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("db");
        let app = seed_app(&pool, "swept").await;
        let row = upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Building,
            Some("abc1234"),
            "▸ build\n",
        )
        .await
        .expect("row");
        // Age it past the bound.
        let old = (chrono::Utc::now() - chrono::Duration::hours(2))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        sqlx::query("UPDATE deploy SET updated_at = ? WHERE id = ?")
            .bind(&old)
            .bind(&row.id)
            .execute(&pool)
            .await
            .expect("age");
        assert!(mark_deploy_cancelled(&pool, &app.id, &row.id)
            .await
            .expect("cancel first"));
        let swept = fail_stuck_deploys(&pool, 60_000, &HashSet::new())
            .await
            .expect("sweep");
        assert_eq!(swept, 0, "the row was already closed");
        let fresh = get_deploy(&pool, &app.id, &row.id)
            .await
            .expect("read")
            .expect("row");
        assert!(
            fresh.log.contains(crate::host::cancel::CANCELLED),
            "the stop's line survives: {}",
            fresh.log
        );
        assert!(!fresh.log.contains("stalled"), "{}", fresh.log);
    }
}
