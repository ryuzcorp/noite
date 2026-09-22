use std::collections::HashSet;

use anyhow::Context;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use sqlx::sqlite::SqliteConnection;

use crate::models::{
    now_iso, new_id, App, AppDeviceStat, AppEnv, AppEvent, AppInsight, AppMetric, AppPathStat, AppRefStat, AppSecret, AppStatus, AppUserProps, Deploy, DeployStatus,
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
        // Deploy log streaming writes constantly while reads serve the UI;
        // without a busy timeout every writer collision fails immediately.
        .after_connect(|conn: &mut SqliteConnection, _| {
            Box::pin(async move {
                sqlx::query("PRAGMA busy_timeout = 5000;")
                    .execute(&mut *conn)
                    .await?;
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
        r#"INSERT INTO app_device_stat (app_id, bucket_ts, browser, os, requests)
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
           FROM app_device_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_devices(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM app_device_stat WHERE bucket_ts < ?")
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
        r#"INSERT INTO app_path_stat (app_id, bucket_ts, path, requests)
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
           FROM app_path_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_paths(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM app_path_stat WHERE bucket_ts < ?")
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
        r#"INSERT INTO app_ref_stat (app_id, bucket_ts, source, requests)
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
           FROM app_ref_stat WHERE app_id = ? AND bucket_ts >= ?
           ORDER BY bucket_ts ASC"#,
    )
    .bind(app_id)
    .bind(since_ts)
    .fetch_all(pool)
    .await
}

pub async fn prune_app_refs(pool: &SqlitePool, older_than_ts: &str) -> sqlx::Result<u64> {
    let res = sqlx::query("DELETE FROM app_ref_stat WHERE bucket_ts < ?")
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
