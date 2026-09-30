use std::collections::HashSet;

use anyhow::Context;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use sqlx::sqlite::SqliteConnection;

use crate::models::{
    now_iso, new_id, App, AppDeviceStat, AppDomain, AppEnv, AppEvent, AppInsight, AppMetric, AppPathStat, AppRefStat, AppSpanStat, AppStatus, AppUserProps, Deploy, DeployStatus, ErrorEvent, ErrorIssue,
};

const APP_COLS: &str = r#"id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
                  listen_port, internal_port, last_deploy_sha, last_error, desired_state,
                  created_at, updated_at, asleep_since, woke_at, deployed_config"#;

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
    // One idempotent file (embedded at compile time), applied on every boot:
    // it creates whatever is missing, so there is no ledger and no ordering.
    // No upgrade paths — installs are wiped, not migrated.
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(include_str!("../schema.sql"))
        .execute(&mut *tx)
        .await
        .context("apply schema")?;
    tx.commit().await?;
    Ok(pool)
}

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
/// window of dashboard history, never control-plane state.
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
CREATE TABLE IF NOT EXISTS metrics.app_error_issue (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  culprit TEXT NOT NULL DEFAULT '',
  handler TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'uncaught',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_us INTEGER NOT NULL,
  last_seen_us INTEGER NOT NULL,
  first_sha TEXT,
  last_sha TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  regressed INTEGER NOT NULL DEFAULT 0,
  status_at_us INTEGER,
  PRIMARY KEY (app_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_issue_app_last ON app_error_issue(app_id, last_seen_us);
CREATE TABLE IF NOT EXISTS metrics.app_error_event (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ts_us INTEGER NOT NULL,
  trace_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'uncaught',
  handler TEXT NOT NULL DEFAULT '',
  cell TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  frames TEXT NOT NULL DEFAULT '[]',
  logs TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  http_status INTEGER NOT NULL DEFAULT 0,
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  sha TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_event_issue_ts ON app_error_event(app_id, fingerprint, ts_us);
CREATE TABLE IF NOT EXISTS metrics.app_error_hour (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, fingerprint, bucket_hour)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_hour_app_hour ON app_error_hour(app_id, bucket_hour);
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

// ---------------------------------------------------------------------------
// Errors (host/errors.rs)
// ---------------------------------------------------------------------------

const ISSUE_COLS: &str = "fingerprint, kind, message, culprit, handler, source, count, \
     first_seen_us, last_seen_us, first_sha, last_sha, status, regressed, status_at_us";

/// Fold occurrences into their issue. The latest occurrence names the
/// issue (message, culprit); a resolved issue that fires after it was
/// resolved reopens as regressed. SET expressions read the pre-update row.
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
             count = count + excluded.count,
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

pub async fn add_error_hour(
    pool: &SqlitePool,
    app_id: &str,
    fingerprint: &str,
    bucket_hour: &str,
    n: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_error_hour (app_id, fingerprint, bucket_hour, n)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, fingerprint, bucket_hour) DO UPDATE SET n = n + excluded.n"#,
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

pub async fn insert_error_event(pool: &SqlitePool, e: &NewErrorEvent<'_>) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO metrics.app_error_event
           (app_id, fingerprint, ts_us, trace_id, source, handler, cell, kind, message,
            context, frames, logs, method, path, http_status, browser, os, sha)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
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

    /// Boot applies schema.sql on every connect, with metrics.sqlite
    /// attached. A bare `DROP TABLE` there once fell through to the attached
    /// database and wiped the metric history and ingest watermark on every
    /// restart; a reboot must leave telemetry alone.
    #[tokio::test]
    async fn telemetry_survives_a_reconnect() {
        let dir = std::env::temp_dir().join(format!("noite-db-reconnect-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        {
            let pool = connect(&url).await.expect("first boot");
            add_app_metric(&pool, "a", "2026-09-30T12:36:00Z", 5, 4, 10, 1)
                .await
                .expect("metric");
            set_metric_watermarks(&pool, &[("test".to_string(), 42)])
                .await
                .expect("watermark");
            add_app_path(&pool, "a", "2026-09-30T12:00:00Z", "/")
                .await
                .expect("path");
            pool.close().await;
        }
        let pool = connect(&url).await.expect("second boot");
        let marks = get_metric_watermarks(&pool).await.expect("watermarks readable");
        assert_eq!(marks.get("test"), Some(&42));
        let rows = list_app_metrics(&pool, "a", "2026-09-30T00:00:00Z")
            .await
            .expect("metrics readable");
        assert_eq!(rows.len(), 1);
        let paths = list_app_paths(&pool, "a", "2026-09-30T00:00:00Z")
            .await
            .expect("paths readable");
        assert_eq!(paths.len(), 1);
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn error_issue_folds_and_regresses_after_resolve() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .after_connect(|conn: &mut SqliteConnection, _| {
                Box::pin(async move {
                    for stmt in attach_metrics_statements(":memory:") {
                        sqlx::query(&stmt).execute(&mut *conn).await?;
                    }
                    Ok::<_, sqlx::Error>(())
                })
            })
            .connect("sqlite::memory:")
            .await
            .expect("in-memory db");
        let up = |msg: &'static str, n: i64, at: i64, sha: &'static str| {
            let pool = pool.clone();
            async move {
                upsert_error_issue(&pool, "a", "fp", "TypeError", msg, "f (w.js:1)", "fetch", "uncaught", n, at, at, Some(sha))
                    .await
                    .expect("upsert");
            }
        };
        up("first", 2, 100, "s1").await;
        up("second", 3, 200, "s2").await;
        // A late batch from before the newest occurrence must not rename it.
        up("stale", 1, 150, "s0").await;
        let issue = get_error_issue(&pool, "a", "fp").await.expect("get").expect("issue");
        assert_eq!(issue.count, 6);
        assert_eq!(issue.message, "second");
        assert_eq!((issue.first_seen_us, issue.last_seen_us), (100, 200));
        assert_eq!(issue.first_sha.as_deref(), Some("s1"));
        assert_eq!(issue.last_sha.as_deref(), Some("s2"));
        assert_eq!(issue.status, "open");

        set_error_status(&pool, "a", "fp", "resolved", 300).await.expect("resolve");
        // An occurrence from before the resolve (ingest lag) keeps it resolved.
        up("second", 1, 250, "s2").await;
        let issue = get_error_issue(&pool, "a", "fp").await.expect("get").expect("issue");
        assert_eq!((issue.status.as_str(), issue.regressed), ("resolved", false));
        // One after it reopens the issue as a regression.
        up("second", 1, 400, "s3").await;
        let issue = get_error_issue(&pool, "a", "fp").await.expect("get").expect("issue");
        assert_eq!((issue.status.as_str(), issue.regressed), ("open", true));

        // Ignored stays ignored however often it fires.
        set_error_status(&pool, "a", "fp", "ignored", 500).await.expect("ignore");
        up("second", 1, 600, "s3").await;
        let issue = get_error_issue(&pool, "a", "fp").await.expect("get").expect("issue");
        assert_eq!((issue.status.as_str(), issue.regressed), ("ignored", false));
        assert_eq!(issue.count, 9);
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
