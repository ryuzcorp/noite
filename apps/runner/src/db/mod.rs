//! SQLite data layer.
//!
//! `connect` owns the pool, the per-connection metrics ATTACH, and schema
//! application; the queries live in cohesive submodules (apps, deploys,
//! metrics, errors, events, env, credentials, compaction). The public API is
//! re-exported here so call sites keep reading `db::list_apps`.

use anyhow::Context;
use sqlx::sqlite::{SqliteConnection, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::schema_version;

pub mod alloc;
mod apps;
mod compaction;
mod credentials;
mod deploys;
mod env;
mod errors;
mod events;
mod instance_setting;
mod metrics;

pub use apps::{
    add_domain, count_apps_for_user, create_app, delete_app, domain_owner, get_app,
    get_app_by_domain, get_app_by_slug, get_app_limit, list_all_apps, list_app_domains,
    list_app_limits, list_apps, list_domains_for, patch_app_desired, remove_domain, rename_app,
    set_app_awake, set_app_asleep, set_app_limit, set_deployed_config, update_app_status, NewApp,
};
pub use compaction::{
    bump_metric_version, get_compacted_hours, get_metric_version, mark_hour_compacted,
    prune_compactions,
};
pub use credentials::{delete_app_credential, get_app_credential, put_app_credential};
pub use deploys::{
    fail_stuck_deploys, get_deploy_log, get_success_deploy, latest_deploy_status, list_deploys,
    list_deploys_lean, upsert_deploy,
};
pub use env::{delete_env, list_env, set_env, tenant_env};
pub use errors::{
    count_error_issues, get_error_issue, insert_error_event, list_error_events, list_error_hours,
    list_error_issues, prune_error_events, prune_errors, refresh_error_issue_count,
    set_error_hour, set_error_status, upsert_error_issue, NewErrorEvent,
};
pub use events::{
    get_app_user_props, inc_app_insight, insert_app_event, list_app_channels, list_app_events,
    list_app_insights, set_app_insight, upsert_app_user_props,
};
pub use instance_setting::{
    ensure_identity, get_setting, set_setting, TELEMETRY_ENABLED, TELEMETRY_LAST_SENT_AT,
};
pub use metrics::{
    add_app_device, add_app_metric_cpu, add_app_path, add_app_ref, clear_telemetry_replay,
    get_metric_watermarks, get_telemetry_replay, last_request_bucket, list_app_devices,
    list_app_logs, list_app_metrics, list_app_paths, list_app_refs, list_span_stats,
    prune_app_devices, prune_app_logs, prune_app_metrics, prune_app_paths, prune_app_refs,
    prune_span_stats, replace_app_logs, replace_app_metric_usage, replace_span_stat,
    set_metric_watermarks, set_telemetry_replay,
};

/// Columns every `app`-row query selects, in struct order.
pub(super) const APP_COLS: &str = r#"id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket,
                  listen_port, internal_port, last_deploy_sha, last_error, desired_state,
                  created_at, updated_at, asleep_since, woke_at, deployed_config"#;

/// Columns every error-issue query selects, in struct order.
pub(super) const ISSUE_COLS: &str = "fingerprint, kind, message, culprit, handler, source, count, \
     first_seen_us, last_seen_us, first_sha, last_sha, status, regressed, status_at_us";

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
    // can name `metrics.*` on any connection.
    let metrics_path = std::sync::Arc::new(metrics_db_path(database_url));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        // Deploy log streaming writes constantly while reads serve the UI;
        // without a busy timeout every writer collision fails immediately.
        .after_connect(move |conn: &mut SqliteConnection, _| {
            let metrics_path = metrics_path.clone();
            Box::pin(async move {
                sqlx::query("PRAGMA busy_timeout = 5000;")
                    .execute(&mut *conn)
                    .await?;
                attach_metrics!(conn, &metrics_path);
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
    // The shape of a fresh database is one idempotent file (embedded at
    // compile time). A database that already has data is first brought up by
    // the numbered steps in `schema_version::MIGRATIONS`, and one stamped by a
    // newer build is refused.
    let mut tx = pool.begin().await?;
    schema_version::apply(
        &mut tx,
        include_str!("../../schema.sql"),
        schema_version::SCHEMA_VERSION,
        schema_version::MIGRATIONS,
    )
    .await?;
    tx.commit().await?;
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

/// Attach the sibling metrics database and apply the telemetry schema
/// (`schema.metrics.sql`, embedded at compile time) on one connection.
/// Idempotent and run on every connection, so any query can name `metrics.*`.
///
/// A macro rather than an async fn: the pool's `after_connect` hook must be
/// generic over the connection lifetime, and a nested async fn borrowing
/// `&mut SqliteConnection` is not "general enough" for the `Executor` bound.
macro_rules! attach_metrics {
    ($conn:expr, $metrics_path:expr) => {{
        sqlx::query(&format!(
            "ATTACH DATABASE '{}' AS metrics",
            $metrics_path.replace('\'', "''")
        ))
        .execute(&mut *$conn)
        .await?;
        sqlx::query("PRAGMA metrics.journal_mode=WAL")
            .execute(&mut *$conn)
            .await?;
        // One script, like `schema_version::apply` for the main schema,
        // instead of a hand-rolled `split(';')`.
        sqlx::Executor::execute(
            &mut *$conn,
            sqlx::raw_sql(include_str!("../../schema.metrics.sql")),
        )
        .await?;
    }};
}
pub(crate) use attach_metrics;

/// Consistent copy of the runner database, written by `VACUUM INTO` next to
/// the live file (inside the same volume, so `make backup` picks it up with
/// the volume tar). One copy per run: the caller removes the previous one.
pub fn snapshot_path(cfg: &crate::config::Config) -> std::path::PathBuf {
    let live = local_db_path(cfg).unwrap_or_else(|| std::path::PathBuf::from("/data/noite.sqlite"));
    let dir = live
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::new_id;

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
            replace_app_metric_usage(&pool, "a", "2026-09-30T12:36:00Z", 5, 4, 10)
                .await
                .expect("metric");
            add_app_metric_cpu(&pool, "a", "2026-09-30T12:36:00Z", 1)
                .await
                .expect("cpu");
            set_metric_watermarks(&pool, &[("test".to_string(), 42)])
                .await
                .expect("watermark");
            add_app_path(&pool, "a", "2026-09-30T12:00:00Z", "/")
                .await
                .expect("path");
            pool.close().await;
        }
        let pool = connect(&url).await.expect("second boot");
        let marks = get_metric_watermarks(&pool)
            .await
            .expect("watermarks readable");
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
