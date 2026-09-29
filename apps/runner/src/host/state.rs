//! Runner SQLite held in the bucket (SPEC, Runner state).
//!
//! Goal: losing `runner-data` loses nothing; backups are bucket versioning.
//! Key: `s3://{bucket}/runner/state/noite.sqlite.zst` (+ `noite.sqlite.meta.json`
//! with `{ generation, written_at, codec, sha256, bytes, raw_bytes }`).
//!
//! Write path: a background task holds its own SQLite connection and polls
//! `PRAGMA data_version`, which changes whenever *another* connection
//! commits, so every write counts (REST, RPC, deploys, the reconcile loop),
//! not just the API calls someone remembered to mark. Once dirty, it waits
//! 10 s for bursts to settle and uploads at most once a minute:
//! `VACUUM INTO` a temp file, skip when its hash matches the last upload
//! (T4.3), else zstd-compress (T4.2) and upload, then `meta`. Only the main
//! database is snapshotted — metrics.sqlite is attached, not copied (T4.1).
//! Also on graceful shutdown (2.1). Loss window on a crash: about 70 s of writes.
//!
//! Fencing: the store's conditional writes are not reachable through the aws
//! CLI we ship, so instead each runner claims `runner/state/owner.json` at
//! boot and re-reads it before every upload; a runner that no longer owns the
//! claim stops uploading and says so. The newest runner wins. There is a
//! small race between the read and the upload; it only matters when two
//! installs share one bucket, which is a misconfiguration this surfaces.
//!
//! Boot path: if `NOITE_DB` does not exist, download the snapshot before
//! `db::connect`. "No snapshot" (404) starts fresh; any other error fails the
//! boot, because starting with an empty database would upload it over the
//! good snapshot on the next write. If both exist, keep the local file.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::cmd;

const STATE_KEY: &str = "runner/state/noite.sqlite.zst";
/// Pre-compression key: written before snapshots gained zstd (spec T4.2).
/// Restore still reads it; nothing writes it anymore.
const STATE_KEY_LEGACY: &str = "runner/state/noite.sqlite";
const META_KEY: &str = "runner/state/noite.sqlite.meta.json";
const OWNER_KEY: &str = "runner/state/owner.json";
/// Snapshot cadence: poll data_version every 10 s, wait 10 s for bursts to
/// settle, upload at most once a minute.
const POLL: Duration = Duration::from_secs(10);
const DEBOUNCE: Duration = Duration::from_secs(10);
const MIN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
pub struct StateSync {
    dirty: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    /// This runner's claim on the bucket state (see module docs).
    instance: Arc<String>,
    /// False once another runner took the claim; uploads stop.
    owner: Arc<AtomicBool>,
    /// sha256 of the last uploaded snapshot (spec T4.3): an identical
    /// `VACUUM INTO` output skips the upload entirely.
    last_hash: Arc<std::sync::Mutex<Option<String>>>,
}

impl StateSync {
    pub fn new() -> Self {
        Self {
            dirty: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            instance: Arc::new(uuid::Uuid::new_v4().to_string()),
            owner: Arc::new(AtomicBool::new(true)),
            last_hash: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Mark dirty explicitly (API mutations; the poller catches the rest).
    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty.load(Ordering::Relaxed)
    }

    /// Whether this runner still owns the bucket state (for /ready detail).
    pub fn is_owner(&self) -> bool {
        self.owner.load(Ordering::Relaxed)
    }

    /// Claim the bucket state for this runner (boot). Continues the stored
    /// generation so it stays monotonic across restarts.
    pub async fn claim(&self, cfg: &Config) -> anyhow::Result<()> {
        if let Ok(text) = download_text(cfg, META_KEY).await {
            let v: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            if let Some(g) = v.get("generation").and_then(serde_json::Value::as_u64) {
                self.generation.store(g, Ordering::Relaxed);
            }
            // Seed the identical-skip (T4.3) so the first pass after a
            // restart doesn't re-upload an unchanged snapshot.
            if let Some(h) = v.get("sha256").and_then(|x| x.as_str()) {
                *self.last_hash.lock().unwrap_or_else(|e| e.into_inner()) = Some(h.to_string());
            }
        }
        let claim = serde_json::json!({
            "instance": self.instance.as_str(),
            "claimed_at": chrono::Utc::now().to_rfc3339(),
        });
        upload_text(cfg, OWNER_KEY, &claim.to_string()).await?;
        tracing::info!(instance = %self.instance, "claimed runner state in the bucket");
        Ok(())
    }

    async fn still_owner(&self, cfg: &Config) -> bool {
        let current = download_text(cfg, OWNER_KEY)
            .await
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("instance").and_then(|i| i.as_str().map(str::to_owned)));
        let mine = match current {
            Some(instance) => instance == *self.instance,
            // Unreadable claim: keep uploading rather than silently stop.
            None => true,
        };
        if !mine && self.owner.swap(false, Ordering::Relaxed) {
            tracing::error!(
                instance = %self.instance,
                "another runner claimed this bucket's state; this runner stops uploading snapshots (two installs share one bucket?)"
            );
        }
        mine
    }

    /// Snapshot now: VACUUM INTO a temp file, upload, update meta.
    pub async fn snapshot_now(&self, pool: &SqlitePool, cfg: &Config) -> anyhow::Result<u64> {
        if !self.still_owner(cfg).await {
            anyhow::bail!("runner state is owned by another runner; not uploading");
        }
        // Clear first: a write that lands while we snapshot sets it again and
        // is picked up by the next pass instead of being lost.
        self.dirty.store(false, Ordering::Relaxed);
        let result = self.upload_snapshot(pool, cfg).await;
        if result.is_err() {
            self.dirty.store(true, Ordering::Relaxed);
        }
        result
    }

    async fn upload_snapshot(&self, pool: &SqlitePool, cfg: &Config) -> anyhow::Result<u64> {
        let live = db::local_db_path(cfg)
            .unwrap_or_else(|| std::path::PathBuf::from("/data/noite.sqlite"));
        let dir = live.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let tmp = dir.join(".snapshot.sqlite");
        let _ = tokio::fs::remove_file(&tmp).await;
        let Some(target) = tmp.to_str() else {
            anyhow::bail!("snapshot path is not valid UTF-8");
        };
        // `VACUUM INTO` copies only the main database: metrics.sqlite rides
        // along on the volume but is never snapshotted (spec T4.1).
        let sql = format!("VACUUM INTO '{}'", target.replace('\'', "''"));
        sqlx::query(&sql).execute(pool).await?;
        let raw = tokio::fs::read(&tmp).await?;
        let _ = tokio::fs::remove_file(&tmp).await;
        // Skip identical snapshots (spec T4.3): writes that don't change
        // bytes (e.g. an upsert of the same row) upload nothing.
        let hash = {
            use sha2::Digest;
            let mut h = sha2::Sha256::new();
            h.update(&raw);
            format!("{:x}", h.finalize())
        };
        let unchanged = self
            .last_hash
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .as_deref()
            == Some(hash.as_str());
        if unchanged {
            tracing::debug!(hash = %hash, "runner state unchanged; skipping snapshot upload");
            return Ok(0);
        }
        // zstd level 3 (spec T4.2): saves bucket storage and upload bytes.
        let packed = zstd::encode_all(&raw[..], 3)?;
        let packed_len = packed.len() as u64;
        let src = dir.join(".snapshot.sqlite.zst");
        tokio::fs::write(&src, &packed).await?;
        cmd::s3_cp_upload(cfg, &src, STATE_KEY).await?;
        let _ = tokio::fs::remove_file(&src).await;
        *self.last_hash.lock().unwrap_or_else(|e| e.into_inner()) = Some(hash.clone());
        crate::host::stats::count_snapshot(packed_len);
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        let meta = serde_json::json!({
            "generation": generation,
            "written_at": chrono::Utc::now().to_rfc3339(),
            "codec": "zstd",
            "sha256": hash,
            "bytes": packed_len,
            "raw_bytes": raw.len(),
            "instance": self.instance.as_str(),
        });
        upload_text(cfg, META_KEY, &serde_json::to_string_pretty(&meta)?).await?;
        tracing::info!(bytes = packed_len, raw_bytes = raw.len(), generation, "runner state snapshot uploaded");
        Ok(packed_len)
    }
}

async fn download_text(cfg: &Config, key: &str) -> anyhow::Result<String> {
    let dest = std::env::temp_dir().join(format!("noite-state-{}", uuid::Uuid::new_v4()));
    let uri = format!("s3://{}/{key}", cfg.s3_bucket);
    let result = cmd::s3_cp_download(cfg, &uri, &dest).await;
    let text = tokio::fs::read_to_string(&dest).await;
    let _ = tokio::fs::remove_file(&dest).await;
    result?;
    Ok(text?)
}

async fn upload_text(cfg: &Config, key: &str, text: &str) -> anyhow::Result<()> {
    let src = std::env::temp_dir().join(format!("noite-state-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&src, text).await?;
    let result = cmd::s3_cp_upload(cfg, &src, key).await;
    let _ = tokio::fs::remove_file(&src).await;
    result
}

/// Boot path: if NOITE_DB does not exist, download the snapshot before
/// `db::connect`. Returns Ok(false) only when the bucket has no snapshot; any
/// other failure is an error the caller must not start past (see module
/// docs). Retries a few times first: the store may still be starting.
pub async fn restore_if_missing(cfg: &Config) -> anyhow::Result<bool> {
    let live = db::local_db_path(cfg)
        .unwrap_or_else(|| std::path::PathBuf::from("/data/noite.sqlite"));
    if live.exists() {
        return Ok(false);
    }
    if let Some(parent) = live.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    // New form first (zstd, spec T4.2), then the legacy raw database.
    match download_snapshot(cfg, &live).await {
        Ok(restored) => Ok(restored),
        Err(e) => Err(e.context("runner state restore failed; refusing to start with an empty database")),
    }
}

async fn download_snapshot(cfg: &Config, live: &std::path::Path) -> anyhow::Result<bool> {
    let partial = live.with_extension("sqlite.restoring");
    let mut last_err = None;
    for attempt in 1..=5u64 {
        match try_restore_once(cfg, live, &partial).await {
            Ok(restored) => {
                let _ = tokio::fs::remove_file(&partial).await;
                return Ok(restored);
            }
            Err(e) if cmd::is_not_found(&e) => {
                tracing::info!("no runner state snapshot in the bucket; starting fresh");
                return Ok(false);
            }
            Err(e) => {
                tracing::warn!(attempt, error = %e, "runner state restore failed; retrying");
                last_err = Some(e);
                tokio::time::sleep(Duration::from_secs(attempt * 3)).await;
            }
        }
    }
    let _ = tokio::fs::remove_file(&partial).await;
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("restore failed")))
}

/// One restore attempt: the compressed snapshot, falling back to the legacy
/// raw key. Only "both keys missing" counts as no-snapshot — a transport
/// error must never read as "start fresh".
async fn try_restore_once(
    cfg: &Config,
    live: &std::path::Path,
    partial: &std::path::Path,
) -> anyhow::Result<bool> {
    let uri = format!("s3://{}/{STATE_KEY}", cfg.s3_bucket);
    match cmd::s3_cp_download(cfg, &uri, partial).await {
        Ok(()) => {
            let packed = tokio::fs::read(partial).await?;
            // The main database is control-plane rows only now (metrics live
            // in metrics.sqlite), so a whole-file decode is bounded.
            let raw = zstd::decode_all(&packed[..])?;
            tokio::fs::write(live, raw).await?;
            tracing::info!(path = %live.display(), "runner state restored from bucket (zstd)");
            return Ok(true);
        }
        Err(e) if !cmd::is_not_found(&e) => return Err(e),
        Err(_) => {}
    }
    let legacy_uri = format!("s3://{}/{STATE_KEY_LEGACY}", cfg.s3_bucket);
    match cmd::s3_cp_download(cfg, &legacy_uri, partial).await {
        Ok(()) => {
            // Rename into place only once complete: a crash mid-download
            // must not leave a truncated database that "exists".
            tokio::fs::rename(partial, live).await?;
            tracing::info!(path = %live.display(), "runner state restored from bucket (legacy raw)");
            Ok(true)
        }
        Err(e) => Err(e),
    }
}

/// Background sync: poll `data_version` on a dedicated connection, then
/// snapshot on the debounce / min-interval schedule from the module docs.
pub fn spawn_sync_task(sync: StateSync, pool: SqlitePool, cfg: Config) {
    tokio::spawn(async move {
        let mut conn = match pool.acquire().await {
            Ok(c) => c.detach(),
            Err(e) => {
                tracing::error!(error = %e, "state sync: no dedicated connection; snapshots disabled");
                return;
            }
        };
        let mut last_version: Option<i64> = None;
        let mut dirty_since: Option<Instant> = None;
        let mut last_upload = Instant::now() - MIN_INTERVAL;
        loop {
            tokio::time::sleep(POLL).await;
            if let Ok(v) = sqlx::query_scalar::<_, i64>("PRAGMA data_version")
                .fetch_one(&mut conn)
                .await
            {
                if last_version.is_some_and(|prev| prev != v) {
                    sync.mark_dirty();
                }
                last_version = Some(v);
            }
            if !sync.is_dirty() {
                dirty_since = None;
                continue;
            }
            let since = *dirty_since.get_or_insert_with(Instant::now);
            if since.elapsed() < DEBOUNCE || last_upload.elapsed() < MIN_INTERVAL {
                continue;
            }
            match sync.snapshot_now(&pool, &cfg).await {
                Ok(_) => {
                    last_upload = Instant::now();
                    dirty_since = None;
                }
                Err(e) => tracing::warn!(error = %e, "state snapshot failed"),
            }
        }
    });
}

/// Final snapshot on graceful shutdown (2.1).
pub async fn final_snapshot(sync: &StateSync, pool: &SqlitePool, cfg: &Config) {
    if let Err(e) = sync.snapshot_now(pool, cfg).await {
        tracing::warn!(error = %e, "final state snapshot failed");
    }
}

#[cfg(test)]
mod tests {
    use crate::host::cmd::is_not_found;

    #[test]
    fn only_a_missing_object_counts_as_no_snapshot() {
        let missing = anyhow::anyhow!("aws exit 1\nfatal error: An error occurred (404) when calling the HeadObject operation: Key \"x\" does not exist");
        assert!(is_not_found(&missing));
        let down = anyhow::anyhow!("aws exit 255\nCould not connect to the endpoint URL: \"http://rustfs:9000/noite\"");
        assert!(!is_not_found(&down));
    }
}
