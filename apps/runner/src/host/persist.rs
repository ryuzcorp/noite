//! Ephemeral-disk survival: SQLite snapshot to the bucket + restore on boot.
//!
//! Container disk dies on move/restart/reset, so the runner keeps a
//! consistent copy at `s3://{bucket}/control/runner.sqlite`:
//! - restore runs once before `db::connect` when the local file is missing.
//! - snapshot runs synchronously after app/collab mutations (best-effort,
//!   warn-only so a slow S3 never fails the request) and on every reconcile
//! - tick for metrics (seconds RPO).
use std::path::PathBuf;
use std::time::Duration;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::host::cmd;

/// Bucket key for the runner SQLite snapshot (under the shared bucket).
pub const SNAPSHOT_KEY: &str = "control/runner.sqlite";

/// Local filesystem path of the SQLite file, parsed from `database_url`
/// (`sqlite:{path}?mode=rwc`). None when the URL is not a file path.
pub fn local_db_path(cfg: &Config) -> Option<PathBuf> {
    let stripped = cfg.database_url.strip_prefix("sqlite:")?;
    let path = stripped.split('?').next().unwrap_or(stripped);
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Restore the local SQLite file from the bucket snapshot when the local
/// disk is fresh (missing or empty). Runs before `db::connect`; missing
/// snapshot (fresh install) is success with `false`.
pub async fn restore_from_bucket(cfg: &Config) -> anyhow::Result<bool> {
    let Some(local) = local_db_path(cfg) else {
        return Ok(false);
    };
    if let Ok(meta) = tokio::fs::metadata(&local).await {
        if meta.len() > 0 {
            return Ok(false);
        }
    }
    if let Some(parent) = local.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let uri = cfg.s3_uri(SNAPSHOT_KEY);
    match cmd::s3_cp_download(cfg, &uri, &local).await {
        Ok(()) => {
            // A restored copy may reference -wal/-shm siblings that did not
            // travel; drop them so sqlite opens the snapshot cleanly.
            let wal = local.with_extension("sqlite-wal");
            let shm = local.with_extension("sqlite-shm");
            let _ = tokio::fs::remove_file(wal).await;
            let _ = tokio::fs::remove_file(shm).await;
            tracing::info!(key = SNAPSHOT_KEY, path = %local.display(), "restored runner db from bucket");
            Ok(true)
        }
        Err(e) => {
            let msg = format!("{e:#}");
            // Fresh installs have no snapshot yet — stay quiet-ish there.
            if msg.contains("NoSuchKey") || msg.contains("404") || msg.contains("No such file") {
                tracing::info!(key = SNAPSHOT_KEY, "no runner db snapshot yet (fresh start)");
            } else {
                tracing::warn!(key = SNAPSHOT_KEY, error = %e, "runner db restore failed; starting fresh");
            }
            Ok(false)
        }
    }
}

/// Write a consistent snapshot (`VACUUM INTO` a temp file) and upload it.
/// Best-effort: callers log; never fail the mutation that triggered it.
pub async fn snapshot_to_bucket(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join("noite-runner-snapshot.sqlite");
    let tmp_str = tmp.to_str().unwrap_or("/tmp/noite-runner-snapshot.sqlite").to_string();
    // VACUUM INTO gives a consistent copy without blocking writers long.
    let vacuum = format!("VACUUM INTO '{}'", tmp_str.replace('\'', "''"));
    if let Err(e) = sqlx::query(&vacuum).execute(pool).await {
        anyhow::bail!("vacuum into snapshot failed: {e:#}");
    }
    cmd::s3_cp_upload(cfg, &tmp, SNAPSHOT_KEY).await?;
    let _ = tokio::fs::remove_file(&tmp).await;
    return Ok(());
}

/// Fire-and-forget snapshot for hot paths (reconcile tick, API writes):
/// warns on failure, never propagates.
pub async fn snapshot_best_effort(pool: &SqlitePool, cfg: &Config) {
    // Bound the upload so a wedged S3 never stalls reconcile.
    match tokio::time::timeout(Duration::from_secs(75), snapshot_to_bucket(pool, cfg)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "runner db snapshot failed"),
        Err(_) => tracing::warn!("runner db snapshot timed out"),
    }
}
