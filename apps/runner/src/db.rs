use std::collections::HashSet;

use anyhow::Context;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use sqlx::sqlite::SqliteConnection;

use crate::models::{
    now_iso, new_id, App, AppDeviceStat, AppDomain, AppEnv, AppEvent, AppInsight, AppMetric, AppPathStat, AppRefStat, AppSpanStat, AppStatus, AppUserProps, Deploy, DeployStatus,
};

const APP_COLS: &str = r#"id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
                  listen_port, internal_port, last_deploy_sha, last_error, desired_state,
                  created_at, updated_at, asleep_since, woke_at"#;

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    if let Some(path) = database_url
        .strip_prefix("sqlite:")
        .map(|s| s.split('?').next().unwrap_or(s))
    {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    // High-churn telemetry lives in metrics.sqlite, ATTACHed as `metrics`
    // (spec T4.1): every pooled connection attaches it, so all queries below
    // can name `metrics.*` on any connection. One statement per query call:
    // a multi-statement script would borrow a local across the executor in a
    // way the pooled-connection hook rejects.
    let attach = std::sync::Arc::new(attach_metrics_statements(&metrics_db_path(database_url)));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        // Deploy log streaming writes constantly while reads serve the UI;
        // without a busy timeout every writer collision fails immediately.
        .after_connect(move |conn: &mut SqliteConnection, _| {
            let attach = attach.clone();
            Box::pin(async move {
                sqlx::query("PRAGMA busy_timeout = 5000;")
                    .execute(&mut *conn)
                    .await?;
                for stmt in attach.iter() {
                    sqlx::query(stmt).execute(&mut *conn).await?;
                }
                Ok::<_, sqlx::Error>(())
            })
        })
        .connect(database_url)
        .await
        .with_context(|| format!("connect {database_url}"))?;
    // WAL persists on the file: readers never block writers after first boot.
    sqlx::query("PRAGMA journal_mode = WAL;")
        .execute(&pool)
        .await?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&pool)
        .await?;
    // Move rows out of the snapshotted file BEFORE schema.sql drops the old
    // main tables (a fresh database has nothing to move: this is a no-op).
    migrate_metrics_to_attached(&pool).await?;
    // One idempotent file (embedded at compile time), applied on every boot:
    // it creates whatever is missing and drops what earlier versions retired,
    // so there is no ledger to migrate and no ordering to keep in sync.
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(include_str!("../schema.sql"))
        .execute(&mut *tx)
        .await
        .context("apply schema")?;
    tx.commit().await?;
    // Columns added after the table shipped (SQLite has no ADD COLUMN IF NOT
    // EXISTS): scale-to-zero state (SPEC, Scale to zero).
    ensure_column(&pool, "app", "asleep_since", "asleep_since TEXT").await?;
    ensure_column(&pool, "app", "woke_at", "woke_at TEXT").await?;
    Ok(pool)
}

/// Sibling file holding the high-churn telemetry tables (`metrics.sqlite`
/// next to the live database). `:memory:` for in-memory URLs (tests), where
/// each connection attaches its own scratch database.
pub fn metrics_db_path(database_url: &str) -> String {
    if let Some(rest) = database_url.strip_prefix("sqlite:") {
        let path = rest.split('?').next().unwrap_or(rest);
        if !path.is_empty() && path != ":memory:" {
            let dir = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            return dir.join("metrics.sqlite").to_string_lossy().into_owned();
        }
    }
    ":memory:".to_string()
}

/// High-churn, rebuildable telemetry tables (spec T4.1): minute buckets,
/// edge analytics, hourly span stats, the log ring, ingest watermarks,
/// compaction marks and per-app metrics versions. Derived from bucket
/// telemetry and Caddy logs — losing the volume loses at most the retention
/// window of dashboard history, never control-plane state. Column order of
/// the moved tables matches the old main-file DDL exactly, so the one-time
/// `INSERT INTO metrics.* SELECT * FROM main.*` migration lines up.
pub const METRICS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS metrics.app_metric (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_metric_app_bucket ON app_metric(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_device_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, browser, os)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_device_stat_app_bucket ON app_device_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_path_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  path TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, path)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_path_stat_app_bucket ON app_path_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_ref_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  source TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, source)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_ref_stat_app_bucket ON app_ref_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.metric_watermark (
  slug TEXT PRIMARY KEY NOT NULL,
  after_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics.app_span_stat (
  app_id TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  err INTEGER NOT NULL DEFAULT 0,
  qwait_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_hour, name, kind)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_span_stat_app_hour ON app_span_stat(app_id, bucket_hour);
CREATE TABLE IF NOT EXISTS metrics.app_log (
  app_id TEXT NOT NULL,
  ts_us INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_log_app_ts ON app_log(app_id, ts_us);
CREATE TABLE IF NOT EXISTS metrics.metric_compaction (
  slug TEXT NOT NULL,
  hour TEXT NOT NULL,
  compacted_at TEXT NOT NULL,
  PRIMARY KEY (slug, hour)
);
CREATE TABLE IF NOT EXISTS metrics.metric_version (
  app_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
"#;

fn attach_metrics_statements(metrics_path: &str) -> Vec<String> {
    let mut stmts = vec![
        format!(
            "ATTACH DATABASE '{}' AS metrics",
            metrics_path.replace('\'', "''")
        ),
        "PRAGMA metrics.journal_mode=WAL".to_string(),
    ];
    for part in METRICS_SCHEMA.split(';') {
        let stmt = part.trim();
        if !stmt.is_empty() {
            stmts.push(stmt.to_string());
        }
    }
    stmts
}

/// One-time move of telemetry rows from the snapshotted main file into the
/// attached metrics database. Runs before schema.sql drops the old tables.
async fn migrate_metrics_to_attached(pool: &SqlitePool) -> anyhow::Result<()> {
    const MOVED: &[&str] = &[
        "app_metric",
        "app_device_stat",
        "app_path_stat",
        "app_ref_stat",
        "metric_watermark",
    ];
    for table in MOVED {
        let exists: Option<String> = sqlx::query_scalar(
            "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_optional(pool)
        .await?;
        if exists.is_none() {
            continue;
        }
        let copy = format!("INSERT OR IGNORE INTO metrics.{table} SELECT * FROM main.{table}");
        sqlx::query(&copy).execute(pool).await?;
        let drop = format!("DROP TABLE main.{table}");
        sqlx::query(&drop).execute(pool).await?;
        tracing::info!(table, "migrated telemetry table to metrics.sqlite");
    }
    Ok(())
}

/// Consistent copy of the runner database, written by `VACUUM INTO` next to
/// the live file (inside the same volume, so `make backup` picks it up with
/// the volume tar). One copy per run: the caller removes the previous one.
pub fn snapshot_path(cfg: &crate::config::Config) -> std::path::PathBuf {
    let live = local_db_path(cfg).unwrap_or_else(|| std::path::PathBuf::from("/data/noite.sqlite"));
    let dir = live.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    dir.join("noite-snapshot.sqlite")
}

/// Local path of the live database, parsed from `database_url`
/// (`sqlite:{path}?mode=rwc`). None when the URL is not a file path.
pub fn local_db_path(cfg: &crate::config::Config) -> Option<std::path::PathBuf> {
    let stripped = cfg.database_url.strip_prefix("sqlite:")?;
    let path = stripped.split('?').next().unwrap_or(stripped);
    if path.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(path))
}

/// Additive schema change. SQLite has no `ADD COLUMN IF NOT EXISTS`, so a new
/// column on an existing table cannot live in `schema.sql` (whose
/// `CREATE TABLE IF NOT EXISTS` only ever covers whole tables). Guard with
/// `pragma_table_info` instead: this is the supported path for the next column,
/// and it is a no-op once applied.
/// Add a column to an existing table once (guarded by `pragma_table_info`,
/// a no-op after the first boot). See SPEC, Runner schema evolution.
pub async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    ddl: &str,
) -> anyhow::Result<bool> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT name FROM pragma_table_info(?)")
        .bind(table)
        .fetch_all(pool)
        .await?;
    if rows.iter().any(|(name,)| name == column) {
        return Ok(false);
    }
    sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {ddl}"))
        .execute(pool)
        .await?;
    Ok(true)
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
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT app_id FROM app_domain WHERE hostname = ?")
            .bind(hostname)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).next())
}

pub async fn add_domain(
    pool: &SqlitePool,
    app_id: &str,
    hostname: &str,
) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO app_domain (app_id, hostname, created_at) VALUES (?, ?, ?)")
        .bind(app_id)
        .bind(hostname)
        .bind(now_iso())
        .execute(pool)
        .await
        .map(|_| ())
}

pub async fn remove_domain(
    pool: &SqlitePool,
    app_id: &str,
    hostname: &str,
) -> sqlx::Result<u64> {
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
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT count(*) FROM app WHERE user_id = ?")
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
    sqlx::query("UPDATE app SET asleep_since = ?, status = 'sleeping', updated_at = ? WHERE id = ?")
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

/// Newest minute bucket with at least one request (celld `celld.fetch`
/// spans), or None when the app never served within retention.
pub async fn last_request_bucket(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar::<_, String>(
        r#"SELECT bucket_ts FROM metrics.app_metric
           WHERE app_id = ? AND requests > 0 ORDER BY bucket_ts DESC LIMIT 1"#,
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await
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
    let row: Option<(String,)> = sqlx::query_as::<_, (String,)>(
        r#"SELECT log FROM deploy WHERE id = ? AND app_id = ?"#,
    )
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
        r#"INSERT INTO metrics.app_metric (app_id, bucket_ts, requests, errors, latency_ms, cpu_ms)
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
           FROM metrics.app_metric WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
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

/// Telemetry watermark persistence (slug -> last consumed start_unix_us).
/// Written after bucket persist each tick; the runner SQLite lives on the
/// data volume, so restarts resume instead of resetting.
pub async fn get_metric_watermarks(
    pool: &SqlitePool,
) -> sqlx::Result<std::collections::HashMap<String, i64>> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT slug, after_us FROM metrics.metric_watermark")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

pub async fn set_metric_watermarks(
    pool: &SqlitePool,
    marks: &[(String, i64)],
) -> sqlx::Result<()> {
    for (slug, after_us) in marks {
        sqlx::query(
            r#"INSERT INTO metrics.metric_watermark (slug, after_us) VALUES (?, ?)
               ON CONFLICT (slug) DO UPDATE SET after_us = excluded.after_us"#,
        )
        .bind(slug)
        .bind(after_us)
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Accumulate one device hit into its hour bucket. Called from the
/// access-log tick; only the classified pair is stored, never IPs or
/// raw user-agents.
pub async fn add_app_device(
    pool: &SqlitePool,
    app_id: &str,
    bucket_ts: &str,
    browser: &str,
    os: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_device_stat (app_id, bucket_ts, browser, os, requests)
           VALUES (?, ?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, browser, os) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
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
    since_ts: &str,
) -> sqlx::Result<Vec<AppDeviceStat>> {
    sqlx::query_as::<_, AppDeviceStat>(
        r#"SELECT app_id, bucket_ts, browser, os, requests
           FROM metrics.app_device_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
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
    bucket_ts: &str,
    path: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_path_stat (app_id, bucket_ts, path, requests)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, path) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(path)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_paths(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppPathStat>> {
    sqlx::query_as::<_, AppPathStat>(
        r#"SELECT app_id, bucket_ts, path, requests
           FROM metrics.app_path_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
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
    bucket_ts: &str,
    source: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_ref_stat (app_id, bucket_ts, source, requests)
           VALUES (?, ?, ?, 1)
           ON CONFLICT (app_id, bucket_ts, source) DO UPDATE SET
             requests = requests + 1"#,
    )
    .bind(app_id)
    .bind(bucket_ts)
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_refs(
    pool: &SqlitePool,
    app_id: &str,
    since_ts: &str,
) -> sqlx::Result<Vec<AppRefStat>> {
    sqlx::query_as::<_, AppRefStat>(
        r#"SELECT app_id, bucket_ts, source, requests
           FROM metrics.app_ref_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
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

/// Accumulate one hour-bucket of span stats (spec T3.2), filled by the
/// ingest tick. Retention matches the other metric tables.
#[allow(clippy::too_many_arguments)]
pub async fn add_span_stat(
    pool: &SqlitePool,
    app_id: &str,
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
           (app_id, bucket_hour, name, kind, n, ms, err, qwait_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, bucket_hour, name, kind) DO UPDATE SET
             n = n + excluded.n,
             ms = ms + excluded.ms,
             err = err + excluded.err,
             qwait_ms = qwait_ms + excluded.qwait_ms"#,
    )
    .bind(app_id)
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
    since_hour: &str,
) -> sqlx::Result<Vec<AppSpanStat>> {
    sqlx::query_as::<_, AppSpanStat>(
        r#"SELECT name, kind,
             SUM(n) AS n, SUM(ms) AS ms, SUM(err) AS err, SUM(qwait_ms) AS qwait_ms
           FROM metrics.app_span_stat
           WHERE app_id = ? AND bucket_hour >= ?
           GROUP BY name, kind ORDER BY ms DESC LIMIT 8"#,
    )
    .bind(app_id)
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

/// Append ingested OTel log rows to the per-app ring (spec T3.3).
pub async fn append_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    rows: &[(i64, String)],
) -> sqlx::Result<()> {
    for (ts_us, body) in rows {
        sqlx::query("INSERT INTO metrics.app_log (app_id, ts_us, body) VALUES (?, ?, ?)")
            .bind(app_id)
            .bind(ts_us)
            .bind(body)
            .execute(pool)
            .await?;
    }
    Ok(())
}

/// Ring contents in chronological order (oldest first), like the old
/// DuckDB `recent_logs` return.
pub async fn list_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    since_us: i64,
    limit: i64,
) -> sqlx::Result<Vec<(i64, String)>> {
    sqlx::query_as(
        "SELECT ts_us, body FROM metrics.app_log \
         WHERE app_id = ? AND ts_us >= ? ORDER BY ts_us ASC LIMIT ?",
    )
    .bind(app_id)
    .bind(since_us)
    .bind(limit)
    .fetch_all(pool)
    .await
}

/// Cap the ring per app: last 24 h AND last 2,000 lines, whichever is
/// smaller (spec T3.3).
pub async fn prune_app_logs(
    pool: &SqlitePool,
    app_id: &str,
    cutoff_us: i64,
    keep: i64,
) -> sqlx::Result<u64> {
    let mut n = sqlx::query("DELETE FROM metrics.app_log WHERE app_id = ? AND ts_us < ?")
        .bind(app_id)
        .bind(cutoff_us)
        .execute(pool)
        .await?
        .rows_affected();
    // rowid is the insertion order: everything outside the newest `keep`.
    n += sqlx::query(
        "DELETE FROM metrics.app_log WHERE app_id = ? AND rowid NOT IN \
         (SELECT rowid FROM metrics.app_log WHERE app_id = ? \
          ORDER BY ts_us DESC, rowid DESC LIMIT ?)",
    )
    .bind(app_id)
    .bind(app_id)
    .bind(keep)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n)
}

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

pub async fn mark_hour_compacted(
    pool: &SqlitePool,
    slug: &str,
    hour: &str,
) -> sqlx::Result<()> {
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

/// Encrypted per-app credential row (SPEC, Scoped credentials). Nonce +
/// AES-GCM ciphertext over JSON `{access_key, secret_key}`; the KEK derives
/// from RUNNER_TOKEN so the bucket snapshot is not a key dump.
pub async fn get_app_credential(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT nonce, ciphertext FROM app_credential WHERE app_id = ?",
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn put_app_credential(pool: &SqlitePool, app_id: &str, nonce: &[u8], ciphertext: &[u8]) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_credential (app_id, nonce, ciphertext, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id) DO UPDATE SET nonce = excluded.nonce,
           ciphertext = excluded.ciphertext, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(nonce)
    .bind(ciphertext)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_app_credential(pool: &SqlitePool, app_id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM app_credential WHERE app_id = ?")
        .bind(app_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Tenant env vars (CF `.dev.vars` model: local file for dev, fleet env in
/// prod). Plaintext in SQLite like the other single-operator secrets — no
/// vault. Names are validated at the API layer; values capped at 32 KiB.
pub async fn list_env(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<AppEnv>> {
    sqlx::query_as::<_, AppEnv>(
        "SELECT app_id, name, value, updated_at FROM app_env WHERE app_id = ? ORDER BY name",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

pub async fn set_env(
    pool: &SqlitePool,
    app_id: &str,
    name: &str,
    value: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_env (app_id, name, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, name) DO UPDATE SET value = excluded.value,
           updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(name)
    .bind(value)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_env(pool: &SqlitePool, app_id: &str, name: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM app_env WHERE app_id = ? AND name = ?")
        .bind(app_id)
        .bind(name)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reserved prefixes/names the platform owns — tenant values for these are
/// dropped (logged) rather than injected into fleet/build/release env.
fn env_reserved(name: &str) -> bool {
    name == "PORT"
        || name == "HOST"
        || name.starts_with("AWS_")
        || name.starts_with("S3_")
        || name.starts_with("CELLD_")
        || name.starts_with("RUNNER_")
        || name.starts_with("NOITE_")
        || name.starts_with("BETTER_AUTH_")
        || name.starts_with("CADDY_")
        || name.starts_with("LD_")
        || name == "NODE_OPTIONS"
        || (name.starts_with("BUN_") && name != "BUN_INSTALL_CACHE_DIR")
}

/// Tenant env ready to inject, minus reserved names. Feature flags are
/// plain `FLAG_<NAME>` rows (`1`/`0`) and flow through like any other var.
pub async fn tenant_env(pool: &SqlitePool, app_id: &str) -> Vec<(String, String)> {
    match list_env(pool, app_id).await {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|r| {
                if env_reserved(&r.name) {
                    tracing::warn!(app_id, name = %r.name, "tenant env reserved; skipping");
                    None
                } else {
                    Some((r.name, r.value))
                }
            })
            .collect(),
        Err(e) => {
            tracing::warn!(app_id, error = %e, "tenant env list failed; deploying without");
            Vec::new()
        }
    }
}

/// Range-bounded allocator (SPEC, Ports): new fleets come from the
/// configured range. Exhaustion errors instead of wandering past max into
/// ephemeral ports.
pub async fn next_ports_in(pool: &SqlitePool, min: u16, max: u16) -> sqlx::Result<(i64, i64)> {
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
    let mut listen = min;
    loop {
        if listen.saturating_add(1) > max {
            return Err(sqlx::Error::RowNotFound);
        }
        if !used.contains(&listen) && !used.contains(&(listen + 1)) {
            return Ok((listen as i64, (listen + 1) as i64));
        }
        listen = listen.saturating_add(2);
    }
}

/// Insert one tenant event. Caller validates shapes; tags arrive serialized.
// Ten args mirror the INSERT column list 1:1 (single caller) — grouping
// would add indirection without removing a parameter.
#[allow(clippy::too_many_arguments)]
pub async fn insert_app_event(
    pool: &SqlitePool,
    id: &str,
    app_id: &str,
    channel: &str,
    event: &str,
    description: &str,
    icon: &str,
    tags: &str,
    user_id: &str,
    ts: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_event (id, app_id, channel, event, description, icon, tags, user_id, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(id)
    .bind(app_id)
    .bind(channel)
    .bind(event)
    .bind(description)
    .bind(icon)
    .bind(tags)
    .bind(user_id)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_events(
    pool: &SqlitePool,
    app_id: &str,
    channel: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<AppEvent>> {
    match channel {
        Some(c) => {
            sqlx::query_as::<_, AppEvent>(
                r#"SELECT id, app_id, channel, event, description, icon, tags, user_id, ts
                   FROM app_event WHERE app_id = ? AND channel = ?
                   ORDER BY ts DESC, rowid DESC LIMIT ?"#,
            )
            .bind(app_id)
            .bind(c)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        None => {
            sqlx::query_as::<_, AppEvent>(
                r#"SELECT id, app_id, channel, event, description, icon, tags, user_id, ts
                   FROM app_event WHERE app_id = ?
                   ORDER BY ts DESC, rowid DESC LIMIT ?"#,
            )
            .bind(app_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}

pub async fn list_app_channels(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT channel FROM app_event WHERE app_id = ? ORDER BY channel ASC",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// Shallow-merge identify properties (last write wins per key).
pub async fn upsert_app_user_props(
    pool: &SqlitePool,
    app_id: &str,
    user_id: &str,
    properties: &str,
) -> sqlx::Result<()> {
    let now = now_iso();
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT properties FROM app_user_prop WHERE app_id = ? AND user_id = ?",
    )
    .bind(app_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    let merged = match existing {
        Some(prev) => {
            let mut map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&prev).unwrap_or_default();
            let next: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(properties).unwrap_or_default();
            map.extend(next);
            serde_json::Value::Object(map).to_string()
        }
        None => properties.to_string(),
    };
    sqlx::query(
        r#"INSERT INTO app_user_prop (app_id, user_id, properties, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, user_id) DO UPDATE SET
             properties = excluded.properties, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(user_id)
    .bind(merged)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_app_user_props(
    pool: &SqlitePool,
    app_id: &str,
    user_id: &str,
) -> sqlx::Result<Option<AppUserProps>> {
    sqlx::query_as::<_, AppUserProps>(
        "SELECT app_id, user_id, properties, updated_at FROM app_user_prop WHERE app_id = ? AND user_id = ?",
    )
    .bind(app_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Set an insight widget value (string or number).
pub async fn set_app_insight(
    pool: &SqlitePool,
    app_id: &str,
    title: &str,
    value: &str,
    num: Option<f64>,
    icon: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_insight (app_id, title, value, num, icon, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, title) DO UPDATE SET
             value = excluded.value, num = excluded.num,
             icon = excluded.icon, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(title)
    .bind(value)
    .bind(num)
    .bind(icon)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomic increment of an insight (creates at delta when missing).
pub async fn inc_app_insight(
    pool: &SqlitePool,
    app_id: &str,
    title: &str,
    delta: f64,
    icon: Option<&str>,
) -> sqlx::Result<AppInsight> {
    let now = now_iso();
    let current: Option<(Option<f64>, String)> = sqlx::query_as(
        "SELECT num, icon FROM app_insight WHERE app_id = ? AND title = ?",
    )
    .bind(app_id)
    .bind(title)
    .fetch_optional(pool)
    .await?;
    let (next, icon_out) = match current {
        Some((n, old_icon)) => (
            n.unwrap_or(0.0) + delta,
            icon.unwrap_or(&old_icon).to_string(),
        ),
        None => (delta, icon.unwrap_or("").to_string()),
    };
    let text = if next.fract() == 0.0 {
        format!("{}", next as i64)
    } else {
        format!("{next}")
    };
    sqlx::query(
        r#"INSERT INTO app_insight (app_id, title, value, num, icon, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, title) DO UPDATE SET
             value = excluded.value, num = excluded.num,
             icon = excluded.icon, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(title)
    .bind(&text)
    .bind(next)
    .bind(&icon_out)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(AppInsight {
        app_id: app_id.to_string(),
        title: title.to_string(),
        value: text,
        num: Some(next),
        icon: icon_out,
        updated_at: now,
    })
}

pub async fn list_app_insights(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<AppInsight>> {
    sqlx::query_as::<_, AppInsight>(
        "SELECT app_id, title, value, num, icon, updated_at FROM app_insight WHERE app_id = ? ORDER BY title ASC",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ensure_column_adds_once() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory db");
        sqlx::query("CREATE TABLE sample (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&pool)
            .await
            .expect("create");
        // Added the first time, a no-op afterwards — the guard is the point of
        // the helper, because SQLite has no ADD COLUMN IF NOT EXISTS.
        assert!(ensure_column(&pool, "sample", "note", "note TEXT")
            .await
            .expect("first add"));
        assert!(!ensure_column(&pool, "sample", "note", "note TEXT")
            .await
            .expect("second add"));
        let rows: Vec<(String,)> = sqlx::query_as("SELECT name FROM pragma_table_info('sample')")
            .fetch_all(&pool)
            .await
            .expect("pragma");
        assert!(rows.iter().any(|(name,)| name == "note"));
        // Existing rows survive with the column's default.
        sqlx::query("INSERT INTO sample (id, note) VALUES ('a', 'kept')")
            .execute(&pool)
            .await
            .expect("insert");
        let (note,): (String,) = sqlx::query_as("SELECT note FROM sample WHERE id = 'a'")
            .fetch_one(&pool)
            .await
            .expect("read");
        assert_eq!(note, "kept");
        // And the snapshot helper resolves next to the live file.
    }

    #[test]
    fn snapshot_sits_beside_the_database() {
        let mut cfg = crate::config::Config::from_env().expect("config");
        cfg.database_url = "sqlite:/data/noite.sqlite?mode=rwc".into();
        assert_eq!(
            snapshot_path(&cfg),
            std::path::PathBuf::from("/data/noite-snapshot.sqlite")
        );
    }
}
