//! App rows, custom domains, edge limits, and app lifecycle state.

use sqlx::SqlitePool;

use crate::models::{new_id, now_iso, App, AppDomain, AppLimit, AppStatus};

use super::APP_COLS;

/// Record the Wrangler config (JSON) the last successful deploy uploaded.
pub async fn set_deployed_config(
    pool: &SqlitePool,
    app_id: &str,
    config: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query("UPDATE app SET deployed_config = ? WHERE id = ?")
        .bind(config)
        .bind(app_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_apps(pool: &SqlitePool) -> sqlx::Result<Vec<App>> {
    let sql = format!("SELECT {APP_COLS} FROM app ORDER BY created_at DESC");
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

/// Every registered custom hostname (the Caddyfile writer and the on-demand
/// TLS gate read this once per reconcile).
pub async fn list_app_domains(pool: &SqlitePool) -> sqlx::Result<Vec<AppDomain>> {
    sqlx::query_as::<_, AppDomain>(
        "SELECT app_id, hostname, created_at FROM app_domain ORDER BY hostname",
    )
    .fetch_all(pool)
    .await
}

pub async fn list_domains_for(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<AppDomain>> {
    sqlx::query_as::<_, AppDomain>(
        "SELECT app_id, hostname, created_at FROM app_domain WHERE app_id = ? ORDER BY hostname",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// Resolve a request by custom hostname (edge fallback page).
pub async fn get_app_by_domain(pool: &SqlitePool, hostname: &str) -> sqlx::Result<Option<App>> {
    let sql = format!(
        "SELECT {APP_COLS} FROM app WHERE id = (SELECT app_id FROM app_domain WHERE hostname = ?)"
    );
    sqlx::query_as::<_, App>(&sql)
        .bind(hostname)
        .fetch_optional(pool)
        .await
}

/// The app that already owns a hostname, if any (hostname is the primary key,
/// so this is the collision check the API runs before inserting).
pub async fn domain_owner(pool: &SqlitePool, hostname: &str) -> sqlx::Result<Option<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT app_id FROM app_domain WHERE hostname = ?")
        .bind(hostname)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(id,)| id).next())
}

/// Every app's own edge limits (the Caddyfile writer reads these once per
/// reconcile, next to the custom domains).
pub async fn list_app_limits(pool: &SqlitePool) -> sqlx::Result<Vec<AppLimit>> {
    sqlx::query_as::<_, AppLimit>("SELECT app_id, client_rpm, app_rpm FROM app_limit")
        .fetch_all(pool)
        .await
}

/// One app's edge limits; both `None` when it has never set any.
pub async fn get_app_limit(pool: &SqlitePool, app_id: &str) -> sqlx::Result<AppLimit> {
    let row = sqlx::query_as::<_, AppLimit>(
        "SELECT app_id, client_rpm, app_rpm FROM app_limit WHERE app_id = ?",
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or_else(|| AppLimit {
        app_id: app_id.to_string(),
        ..AppLimit::default()
    }))
}

/// Replace an app's edge limits. Both `None` drops the row: back to the
/// platform defaults.
pub async fn set_app_limit(pool: &SqlitePool, limit: &AppLimit) -> sqlx::Result<()> {
    if limit.client_rpm.is_none() && limit.app_rpm.is_none() {
        sqlx::query("DELETE FROM app_limit WHERE app_id = ?")
            .bind(&limit.app_id)
            .execute(pool)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO app_limit (app_id, client_rpm, app_rpm, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT(app_id) DO UPDATE SET client_rpm = excluded.client_rpm, \
         app_rpm = excluded.app_rpm, updated_at = excluded.updated_at",
    )
    .bind(&limit.app_id)
    .bind(limit.client_rpm)
    .bind(limit.app_rpm)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn add_domain(pool: &SqlitePool, app_id: &str, hostname: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO app_domain (app_id, hostname, created_at) VALUES (?, ?, ?)")
        .bind(app_id)
        .bind(hostname)
        .bind(now_iso())
        .execute(pool)
        .await
        .map(|_| ())
}

pub async fn remove_domain(pool: &SqlitePool, app_id: &str, hostname: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM app_domain WHERE app_id = ? AND hostname = ?")
        .bind(app_id)
        .bind(hostname)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Apps a given owner already has. The per-account quota is enforced here so
/// an API key cannot slip past the UI's check.
pub async fn count_apps_for_user(pool: &SqlitePool, user_id: &str) -> sqlx::Result<i64> {
    let rows: Vec<(i64,)> = sqlx::query_as("SELECT count(*) FROM app WHERE user_id = ?")
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(n,)| n).next().unwrap_or(0))
}

/// Everything a new app row needs. A struct keeps the call sites readable now
/// that the owner is part of the row.
pub struct NewApp<'a> {
    pub name: &'a str,
    pub slug: &'a str,
    pub user_id: &'a str,
    pub subdomain: &'a str,
    pub listen: i64,
    pub internal: i64,
}

pub async fn create_app(
    pool: &SqlitePool,
    cfg: &crate::config::Config,
    new: NewApp<'_>,
) -> sqlx::Result<App> {
    let id = new_id();
    let ts = now_iso();
    sqlx::query(
        r#"INSERT INTO app (
            id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
            listen_port, internal_port, desired_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)"#,
    )
    .bind(&id)
    .bind(new.slug)
    .bind(new.name)
    .bind(new.user_id)
    .bind(AppStatus::Provisioned.as_str())
    .bind(new.subdomain)
    .bind(crate::config::Config::git_prefix(new.slug))
    .bind(cfg.fleets_uri(new.slug))
    .bind(new.listen)
    .bind(new.internal)
    .bind(&ts)
    .bind(&ts)
    .execute(pool)
    .await?;
    get_app(pool, &id).await.map(|a| a.expect("just inserted"))
}

/// Owner start/stop. Either way the app is no longer asleep, and a start
/// resets the idle clock so a manually started app gets a full window before
/// the sleep sweep may park it again (SPEC, Scale to zero).
pub async fn patch_app_desired(pool: &SqlitePool, id: &str, desired: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        r#"UPDATE app SET desired_state = ?, asleep_since = NULL,
           woke_at = CASE WHEN ? = 'running' THEN ? ELSE woke_at END,
           updated_at = ? WHERE id = ?"#,
    )
    .bind(desired)
    .bind(desired)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Park an app (scale to zero): flag it asleep and show `sleeping`.
pub async fn set_app_asleep(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE app SET asleep_since = ?, status = 'sleeping', updated_at = ? WHERE id = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Wake an app: clear the flag and restart the idle clock. `status` is set
/// by whoever spawns the fleet (wake handler or reconcile).
pub async fn set_app_awake(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query("UPDATE app SET asleep_since = NULL, woke_at = ?, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(&now)
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
