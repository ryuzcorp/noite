use std::collections::HashSet;

use anyhow::Context;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

use crate::models::{
    now_iso, new_id, App, AppMetric, AppSecret, AppStatus, Deploy, DeployStatus,
};

const APP_COLS: &str = r#"id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
                  listen_port, internal_port, last_deploy_sha, last_error, desired_state,
                  created_at, updated_at"#;

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    if let Some(path) = database_url
        .strip_prefix("sqlite:")
        .map(|s| s.split('?').next().unwrap_or(s))
    {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await
        .with_context(|| format!("connect {database_url}"))?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}

pub async fn list_apps(pool: &SqlitePool) -> sqlx::Result<Vec<App>> {
    // Hard DELETE is the only remove path; leftover soft-delete rows are
    // reclaimed on boot (see main) and excluded here so the UI never sees them.
    let sql = format!(
        "SELECT {APP_COLS} FROM app \
         WHERE desired_state NOT IN ('deleted') AND status NOT IN ('deleting', 'gone') \
         ORDER BY created_at DESC"
    );
    sqlx::query_as::<_, App>(&sql).fetch_all(pool).await
}

pub async fn list_all_apps(pool: &SqlitePool) -> sqlx::Result<Vec<App>> {
    let sql = format!("SELECT {APP_COLS} FROM app ORDER BY created_at ASC");
    sqlx::query_as::<_, App>(&sql).fetch_all(pool).await
}

pub async fn get_app(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<App>> {
    let sql = format!("SELECT {APP_COLS} FROM app WHERE id = ?");
    sqlx::query_as::<_, App>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get_app_by_slug(pool: &SqlitePool, slug: &str) -> sqlx::Result<Option<App>> {
    let sql = format!("SELECT {APP_COLS} FROM app WHERE slug = ?");
    sqlx::query_as::<_, App>(&sql)
        .bind(slug)
        .fetch_optional(pool)
        .await
}

pub async fn create_app(
    pool: &SqlitePool,
    cfg: &crate::config::Config,
    name: &str,
    slug: &str,
    subdomain: &str,
    listen: i64,
    internal: i64,
) -> sqlx::Result<App> {
    let id = new_id();
    let ts = now_iso();
    sqlx::query(
        r#"INSERT INTO app (
            id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
            listen_port, internal_port, desired_state, created_at, updated_at
          ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, 'running', ?, ?)"#,
    )
    .bind(&id)
    .bind(slug)
    .bind(name)
    .bind(AppStatus::Provisioned.as_str())
    .bind(subdomain)
    .bind(crate::config::Config::git_prefix(slug))
    .bind(cfg.fleets_uri(slug))
    .bind(listen)
    .bind(internal)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    let _ = ensure_git_push_secret(pool, &id).await?;
    get_app(pool, &id).await.map(|a| a.expect("just inserted"))
}

pub async fn patch_app_desired(pool: &SqlitePool, id: &str, desired: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE app SET desired_state = ?, updated_at = ? WHERE id = ?")
        .bind(desired)
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn rename_app(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    slug: &str,
    subdomain: &str,
    git_prefix: &str,
    fleet_bucket: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE app SET name = ?, slug = ?, subdomain = ?,
           git_prefix = ?, fleet_bucket = ?, updated_at = ? WHERE id = ?"#,
    )
    .bind(name)
    .bind(slug)
    .bind(subdomain)
    .bind(git_prefix)
    .bind(fleet_bucket)
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_app(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM app WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update_app_status(
    pool: &SqlitePool,
    id: &str,
    status: &str,
    last_error: Option<&str>,
    last_sha: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE app SET status = ?, last_error = ?, last_deploy_sha = COALESCE(?, last_deploy_sha),
           updated_at = ? WHERE id = ?"#,
    )
    .bind(status)
    .bind(last_error)
    .bind(last_sha)
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
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
            let log = if combined.len() > 64 * 1024 {
                combined[combined.len() - 64 * 1024..].to_string()
            } else {
                combined
            };
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

/// Accumulate one minute-bucket of app usage. Called from the metrics tick.
pub async fn add_app_metric(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    requests: i64,
    errors: i64,
    latency_ms: i64,
    cpu_ms: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_metric (app_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, bucket_ts) DO UPDATE SET
             requests = requests + excluded.requests,
             errors = errors + excluded.errors,
             latency_ms = latency_ms + excluded.latency_ms,
             cpu_ms = cpu_ms + excluded.cpu_ms"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(requests)
    .bind(errors)
    .bind(latency_ms)
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
           FROM app_metric WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_metrics(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM app_metric WHERE bucket_ts < ?")
        .bind(older_than_ts)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

pub async fn get_secret(
    pool: &SqlitePool,
    app_id: &str,
    kind: &str,
) -> sqlx::Result<Option<AppSecret>> {
    sqlx::query_as::<_, AppSecret>(
        "SELECT id, app_id, kind, access_key, secret_key, revealed, created_at FROM app_secret WHERE app_id = ? AND kind = ?",
    )
    .bind(app_id)
    .bind(kind)
    .fetch_optional(pool)
    .await
}

/// Mint (or return existing) HTTP Basic password for Git smart-HTTP pushes.
pub async fn ensure_git_push_secret(pool: &SqlitePool, app_id: &str) -> sqlx::Result<AppSecret> {
    if let Some(existing) = get_secret(pool, app_id, "git_push").await? {
        return Ok(existing);
    }
    let id = new_id();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let ts = now_iso();
    sqlx::query(
        r#"INSERT INTO app_secret (id, app_id, kind, access_key, secret_key, revealed, created_at)
           VALUES (?, ?, 'git_push', 'git', ?, 0, ?)"#,
    )
    .bind(&id)
    .bind(app_id)
    .bind(&token)
    .bind(&ts)
    .execute(pool)
    .await?;
    get_secret(pool, app_id, "git_push")
        .await
        .map(|o| o.expect("just inserted"))
}

pub async fn next_ports(pool: &SqlitePool, base: u16) -> sqlx::Result<(i64, i64)> {
    let apps = list_all_apps(pool).await?;
    let mut used = std::collections::HashSet::new();
    for a in apps {
        if let Some(p) = a.listen_port {
            used.insert(p as u16);
        }
        if let Some(p) = a.internal_port {
            used.insert(p as u16);
        }
    }
    let mut listen = base;
    while used.contains(&listen) || used.contains(&(listen + 1)) {
        listen += 2;
    }
    Ok((listen as i64, (listen + 1) as i64))
}
