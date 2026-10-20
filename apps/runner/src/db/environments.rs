//! Preview environment rows: the model the deploy pipeline, the fleet
//! supervisor, the edge and the Caddyfile writer all read.
//!
//! An environment is a second deploy target beside production: its own celld
//! fleet, its own bucket prefix (`envs/<slug>/<label>`) and its own ports, so
//! nothing here ever writes `app.fleet_bucket`, `app.*_port` or
//! `app.last_deploy_sha`.

use sqlx::SqlitePool;

use crate::models::{new_id, now_iso, AppEnv, Environment, EnvironmentKind};

/// Columns every `environment` query selects, in [`Environment`] order. Every
/// query joins `app` for the slug (the host shape `<label>.<slug>.<base>` and
/// the fleet's local state dir both need it), aliased as `e`/`a`.
pub(super) const ENV_COLS: &str = r#"e.id, e.app_id, e.label, e.kind, e.git_ref, e.created_by,
    e.fleet_bucket, e.listen_port, e.internal_port, e.status, e.desired_state, e.asleep_since,
    e.woke_at, e.last_deploy_sha, e.last_deployed_at, e.public, e.last_error, e.created_at,
    e.updated_at, a.slug AS app_slug"#;

/// What the edge and the Caddyfile writer need about one environment, from one
/// query: identity, host label, fleet ports and whether it should be routed.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnvironmentRoute {
    pub id: String,
    pub app_id: String,
    pub app_slug: String,
    pub label: String,
    pub listen_port: Option<i64>,
    pub public: bool,
    pub desired_state: String,
    pub asleep_since: Option<String>,
    pub last_deployed_at: Option<String>,
}

const ROUTE_COLS: &str = r#"e.id, e.app_id, a.slug AS app_slug, e.label, e.listen_port,
    e.public, e.desired_state, e.asleep_since, e.last_deployed_at"#;

/// Everything a new environment row needs.
pub struct NewEnvironment<'a> {
    pub app_id: &'a str,
    /// The owning app's slug: the bucket prefix is `envs/<slug>/<label>`.
    pub slug: &'a str,
    pub label: &'a str,
    pub kind: EnvironmentKind,
    pub git_ref: &'a str,
    pub created_by: &'a str,
    pub listen: i64,
    pub internal: i64,
}

pub async fn create_environment(
    pool: &SqlitePool,
    cfg: &crate::config::Config,
    new: NewEnvironment<'_>,
) -> sqlx::Result<Environment> {
    let id = new_id();
    let ts = now_iso();
    sqlx::query(
        r#"INSERT INTO environment (
            id, app_id, label, kind, git_ref, created_by, fleet_bucket,
            listen_port, internal_port, desired_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)"#,
    )
    .bind(&id)
    .bind(new.app_id)
    .bind(new.label)
    .bind(new.kind.as_str())
    .bind(new.git_ref)
    .bind(new.created_by)
    .bind(cfg.envs_uri(new.slug, new.label))
    .bind(new.listen)
    .bind(new.internal)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    get_environment(pool, &id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

/// The bucket of one environment: `s3://<bucket>/envs/<slug>/<label>`. Built by
/// `Config::envs_uri` where the row is created; a live row carries it in
/// `fleet_bucket`.
pub async fn get_environment(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id WHERE e.id = ?"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get_environment_by_label(
    pool: &SqlitePool,
    app_id: &str,
    label: &str,
) -> sqlx::Result<Option<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         WHERE e.app_id = ? AND e.label = ?"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(label)
        .fetch_optional(pool)
        .await
}

/// The environment tracking one git ref in an app (a branch, or one user's
/// workspace preview of it). At most one row exists per ref.
pub async fn get_environment_by_ref(
    pool: &SqlitePool,
    app_id: &str,
    git_ref: &str,
) -> sqlx::Result<Option<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         WHERE e.app_id = ? AND e.git_ref = ?"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .bind(git_ref)
        .fetch_optional(pool)
        .await
}

pub async fn list_environments(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         WHERE e.app_id = ? ORDER BY e.created_at DESC"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql))
        .bind(app_id)
        .fetch_all(pool)
        .await
}

/// Every environment of every app: what the reconcile loop walks to spawn
/// fleets, route the edge and sweep expired workspace previews.
pub async fn list_all_environments(pool: &SqlitePool) -> sqlx::Result<Vec<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         ORDER BY e.created_at ASC"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql)).fetch_all(pool).await
}

/// Every environment the edge should route (the Caddyfile writer and the TLS
/// gate read these once per reconcile).
pub async fn list_environment_routes(pool: &SqlitePool) -> sqlx::Result<Vec<EnvironmentRoute>> {
    let sql = format!(
        "SELECT {ROUTE_COLS} FROM environment e JOIN app a ON a.id = e.app_id ORDER BY e.label"
    );
    sqlx::query_as::<_, EnvironmentRoute>(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await
}

/// One environment by host: `<label>.<slug>` is the routing identity, so this
/// is what `tls_ask` and the access gate resolve a request host with.
pub async fn environment_route(
    pool: &SqlitePool,
    slug: &str,
    label: &str,
) -> sqlx::Result<Option<EnvironmentRoute>> {
    let sql = format!(
        "SELECT {ROUTE_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         WHERE a.slug = ? AND e.label = ?"
    );
    sqlx::query_as::<_, EnvironmentRoute>(sqlx::AssertSqlSafe(sql))
        .bind(slug)
        .bind(label)
        .fetch_optional(pool)
        .await
}

/// Remove one environment's row and return it (its bucket and fleet key are
/// what the caller needs to wipe). `None` when there was no such row.
pub async fn delete_environment(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Environment>> {
    let Some(row) = get_environment(pool, id).await? else {
        return Ok(None);
    };
    sqlx::query("DELETE FROM environment WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(Some(row))
}

/// Toggle members-only/public. Returns the updated row.
pub async fn set_environment_public(
    pool: &SqlitePool,
    id: &str,
    public: bool,
) -> sqlx::Result<Option<Environment>> {
    sqlx::query("UPDATE environment SET public = ?, updated_at = ? WHERE id = ?")
        .bind(i64::from(public))
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await?;
    get_environment(pool, id).await
}

/// Park an environment (scale to zero), like `set_app_asleep`.
pub async fn set_environment_asleep(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE environment SET asleep_since = ?, status = 'sleeping', updated_at = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_environment_awake(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE environment SET asleep_since = NULL, woke_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_environment_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    last_error: Option<&str>,
) -> sqlx::Result<()> {
    let ts = now_iso();
    match last_error {
        Some(message) => {
            sqlx::query(
                "UPDATE environment SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
            )
            .bind(status)
            .bind(message)
            .bind(&ts)
            .bind(id)
            .execute(pool)
            .await?;
        }
        None => {
            sqlx::query("UPDATE environment SET status = ?, updated_at = ? WHERE id = ?")
                .bind(status)
                .bind(&ts)
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

/// A successful deploy: the environment is live at this sha. `last_deploy_sha`
/// is the environment's own, never the app's. The sha lands even when a stop
/// raced the deploy (tip dedup); `running` (and the error/asleep clearing)
/// only applies while the environment still wants to run, in one statement
/// so the stop cannot slip between the two.
pub async fn mark_environment_deployed(pool: &SqlitePool, id: &str, sha: &str) -> sqlx::Result<()> {
    let ts = now_iso();
    sqlx::query(
        "UPDATE environment SET status = CASE WHEN desired_state = 'running' THEN 'running' ELSE status END, \
         last_deploy_sha = ?, last_deployed_at = ?, \
         last_error = CASE WHEN desired_state = 'running' THEN NULL ELSE last_error END, \
         asleep_since = CASE WHEN desired_state = 'running' THEN NULL ELSE asleep_since END, \
         updated_at = ? WHERE id = ?",
    )
    .bind(sha)
    .bind(&ts)
    .bind(&ts)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Write the observed status only while the environment still wants to run
/// (same stop-race rule as [`crate::db::update_app_status_if_wanted`]).
/// Returns whether the row was updated.
pub async fn update_environment_status_if_wanted(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    last_error: Option<&str>,
) -> sqlx::Result<bool> {
    let ts = now_iso();
    let done = match last_error {
        Some(message) => {
            sqlx::query(
                "UPDATE environment SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND desired_state = 'running'",
            )
            .bind(status)
            .bind(message)
            .bind(&ts)
            .bind(id)
            .execute(pool)
            .await?
        }
        None => {
            sqlx::query(
                "UPDATE environment SET status = ?, updated_at = ? WHERE id = ? AND desired_state = 'running'",
            )
            .bind(status)
            .bind(&ts)
            .bind(id)
            .execute(pool)
            .await?
        }
    };
    Ok(done.rows_affected() > 0)
}

/// Instance-wide environment count: the `RUNNER_MAX_ENVIRONMENTS` cap.
pub async fn count_environments(pool: &SqlitePool) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM environment")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

/// Environments one app already has: the `RUNNER_MAX_ENVIRONMENTS_PER_APP`
/// cap, enforced at create so an API key cannot slip past the UI's check.
pub async fn count_environments_for_app(pool: &SqlitePool, app_id: &str) -> sqlx::Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM environment WHERE app_id = ?")
        .bind(app_id)
        .fetch_one(pool)
        .await?;
    Ok(n)
}

/// Workspace previews with no deploy since `older_than_iso` (ISO-8601, the
/// format stored above): the reconcile sweep deletes these — ROADMAP, seven
/// days without a deploy. Branch environments are never returned.
pub async fn expired_workspace_environments(
    pool: &SqlitePool,
    older_than_iso: &str,
) -> sqlx::Result<Vec<Environment>> {
    let sql = format!(
        "SELECT {ENV_COLS} FROM environment e JOIN app a ON a.id = e.app_id \
         WHERE e.kind = 'workspace' \
           AND coalesce(e.last_deployed_at, e.created_at) < ? \
         ORDER BY e.created_at ASC"
    );
    sqlx::query_as::<_, Environment>(sqlx::AssertSqlSafe(sql))
        .bind(older_than_iso)
        .fetch_all(pool)
        .await
}

/// One environment's overrides only (`environment_env` rows).
pub async fn list_env_override(
    pool: &SqlitePool,
    environment_id: &str,
) -> sqlx::Result<Vec<AppEnv>> {
    sqlx::query_as::<_, AppEnv>(
        "SELECT environment_id AS app_id, name, value, updated_at FROM environment_env \
         WHERE environment_id = ? ORDER BY name",
    )
    .bind(environment_id)
    .fetch_all(pool)
    .await
}

pub async fn set_env_override(
    pool: &SqlitePool,
    environment_id: &str,
    name: &str,
    value: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO environment_env (environment_id, name, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (environment_id, name) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at"#,
    )
    .bind(environment_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_env_override(
    pool: &SqlitePool,
    environment_id: &str,
    name: &str,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM environment_env WHERE environment_id = ? AND name = ?")
        .bind(environment_id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// The app's variables with this environment's overrides applied — what the
/// fleet, the build and the release command see. Reserved names are filtered
/// exactly as `db::tenant_env` does, overrides included.
pub async fn environment_tenant_env(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: &str,
) -> Vec<(String, String)> {
    let mut merged = std::collections::BTreeMap::new();
    for (name, value) in crate::db::env::tenant_env(pool, app_id).await {
        merged.insert(name, value);
    }
    for row in list_env_override(pool, environment_id)
        .await
        .unwrap_or_default()
    {
        if crate::db::env::env_reserved(&row.name) {
            tracing::warn!(
                environment_id,
                name = %row.name,
                "tenant env reserved; skipping environment override"
            );
            continue;
        }
        merged.insert(row.name, row.value);
    }
    merged.into_iter().collect()
}

/// Re-point an environment's bucket after an app rename (the prefix is
/// `envs/<slug>/<label>`, so it moves with the slug).
pub async fn set_environment_bucket(pool: &SqlitePool, id: &str, bucket: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE environment SET fleet_bucket = ?, updated_at = ? WHERE id = ?")
        .bind(bucket)
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect;
    use crate::models::new_id;

    async fn seed(pool: &SqlitePool) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "env-app",
                slug: "env-app",
                user_id: "local",
                subdomain: "env-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    fn new<'a>(app_id: &'a str, label: &'a str, git_ref: &'a str) -> NewEnvironment<'a> {
        NewEnvironment {
            app_id,
            slug: "env-app",
            label,
            kind: EnvironmentKind::Branch,
            git_ref,
            created_by: "user_1",
            listen: 30010,
            internal: 30011,
        }
    }

    #[tokio::test]
    async fn environment_rows_isolate_production_columns() {
        let dir = std::env::temp_dir().join(format!("noite-env-db-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = connect(&url).await.expect("boot");
        let cfg = crate::config::config_for_tests();
        let app = seed(&pool).await;
        let env = create_environment(&pool, &cfg, new(&app.id, "feature", "refs/heads/feat"))
            .await
            .expect("create environment");
        assert_eq!(env.app_slug, "env-app");
        assert_eq!(env.kind, "branch");
        assert_eq!(
            env.fleet_bucket,
            format!("s3://{}/envs/env-app/feature", cfg.s3_bucket)
        );
        // A live environment deploy never writes the app's own columns.
        mark_environment_deployed(&pool, &env.id, "abc1234")
            .await
            .unwrap();
        let fresh = get_environment(&pool, &env.id).await.unwrap().unwrap();
        assert_eq!(fresh.last_deploy_sha.as_deref(), Some("abc1234"));
        assert_eq!(fresh.status, "running");
        let app_after = crate::db::get_app(&pool, &app.id).await.unwrap().unwrap();
        assert_eq!(app_after.last_deploy_sha, None);
        // Lookups: by label, by ref, by route (host shape).
        assert!(get_environment_by_label(&pool, &app.id, "feature")
            .await
            .unwrap()
            .is_some());
        assert!(get_environment_by_ref(&pool, &app.id, "refs/heads/feat")
            .await
            .unwrap()
            .is_some());
        let route = environment_route(&pool, "env-app", "feature")
            .await
            .unwrap()
            .expect("route");
        assert_eq!(route.listen_port, Some(30010));
        assert!(!route.public);
        assert_eq!(list_environment_routes(&pool).await.unwrap().len(), 1);
        assert_eq!(count_environments(&pool).await.unwrap(), 1);
        assert_eq!(count_environments_for_app(&pool, &app.id).await.unwrap(), 1);
        // Same label twice is refused by the unique index.
        assert!(
            create_environment(&pool, &cfg, new(&app.id, "feature", "refs/heads/other"))
                .await
                .is_err()
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn overrides_win_over_app_variables_and_delete_with_the_row() {
        let pool = connect("sqlite::memory:").await.expect("boot");
        let cfg = crate::config::config_for_tests();
        let app = seed(&pool).await;
        crate::db::set_env(&pool, &app.id, "SHARED", "app")
            .await
            .unwrap();
        crate::db::set_env(&pool, &app.id, "ONLY_APP", "yes")
            .await
            .unwrap();
        let env = create_environment(&pool, &cfg, new(&app.id, "staging", "refs/heads/staging"))
            .await
            .expect("env");
        set_env_override(&pool, &env.id, "SHARED", "env")
            .await
            .unwrap();
        set_env_override(&pool, &env.id, "ONLY_ENV", "here")
            .await
            .unwrap();
        // Reserved names never reach a fleet, override or not.
        set_env_override(&pool, &env.id, "RUNNER_TOKEN", "nope")
            .await
            .unwrap();
        let vars = environment_tenant_env(&pool, &app.id, &env.id).await;
        assert_eq!(
            vars,
            vec![
                ("ONLY_APP".to_string(), "yes".to_string()),
                ("ONLY_ENV".to_string(), "here".to_string()),
                ("SHARED".to_string(), "env".to_string()),
            ]
        );
        assert_eq!(list_env_override(&pool, &env.id).await.unwrap().len(), 3);
        delete_env_override(&pool, &env.id, "ONLY_ENV")
            .await
            .unwrap();
        assert_eq!(list_env_override(&pool, &env.id).await.unwrap().len(), 2);
        // Deleting the environment takes its overrides with it.
        delete_environment(&pool, &env.id)
            .await
            .unwrap()
            .expect("row");
        assert!(list_env_override(&pool, &env.id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn expiry_returns_only_stale_workspace_previews() {
        let pool = connect("sqlite::memory:").await.expect("boot");
        let cfg = crate::config::config_for_tests();
        let app = seed(&pool).await;
        let workspace = create_environment(
            &pool,
            &cfg,
            NewEnvironment {
                app_id: &app.id,
                slug: "env-app",
                label: "feat-user1",
                kind: EnvironmentKind::Workspace,
                git_ref: "refs/previews/user_1/feat",
                created_by: "user_1",
                listen: 30010,
                internal: 30011,
            },
        )
        .await
        .expect("workspace env");
        let branch = create_environment(&pool, &cfg, new(&app.id, "feat", "refs/heads/feat"))
            .await
            .expect("branch env");
        sqlx::query(
            "UPDATE environment SET created_at = '2020-01-01T00:00:00.000Z', \
                     last_deployed_at = NULL WHERE id = ?",
        )
        .bind(&workspace.id)
        .execute(&pool)
        .await
        .unwrap();
        let stale = expired_workspace_environments(&pool, "2026-01-01T00:00:00.000Z")
            .await
            .unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].id, workspace.id);
        // A branch environment twice that old is never swept.
        assert!(
            expired_workspace_environments(&pool, "2030-01-01T00:00:00.000Z")
                .await
                .unwrap()
                .iter()
                .all(|e| e.id != branch.id)
        );
        // A workspace preview that deployed recently has not expired, and a
        // recent deploy re-arms the clock for a stale row.
        let fresh = create_environment(
            &pool,
            &cfg,
            NewEnvironment {
                app_id: &app.id,
                slug: "env-app",
                label: "feat-user2",
                kind: EnvironmentKind::Workspace,
                git_ref: "refs/previews/user_2/feat",
                created_by: "user_2",
                listen: 30020,
                internal: 30021,
            },
        )
        .await
        .expect("fresh workspace env");
        mark_environment_deployed(&pool, &workspace.id, "abc1234")
            .await
            .unwrap();
        let stale = expired_workspace_environments(&pool, "2026-01-01T00:00:00.000Z")
            .await
            .unwrap();
        assert!(stale.iter().all(|e| e.id != fresh.id));
        assert!(
            stale.iter().all(|e| e.id != workspace.id),
            "a deploy re-arms the clock"
        );
    }
}
