//! Instance-level settings (`instance_setting`): key/value rows the runner owns
//! about *this install*, not about a tenant.
//!
//! The install identity (`install_id`, `installed_at`) is written on first boot
//! and lives in the snapshotted runner database, so it survives container
//! recreation. `telemetry_enabled` (absent = enabled) and
//! `telemetry_last_sent_at` back the opt-out instance heartbeat
//! (`host::telemetry_report`).

use sqlx::SqlitePool;

use crate::models::{new_id, now_iso};

pub const INSTALL_ID: &str = "install_id";
pub const INSTALLED_AT: &str = "installed_at";
pub const TELEMETRY_ENABLED: &str = "telemetry_enabled";
pub const TELEMETRY_LAST_SENT_AT: &str = "telemetry_last_sent_at";

/// One setting's value; `None` when the row has never been written.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT value FROM instance_setting WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
}

/// Write one setting (insert or replace).
pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT OR REPLACE INTO instance_setting (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .map(|_| ())
}

/// The install identity, creating both rows on first call: a random UUIDv4 and
/// an RFC3339 `installed_at`. `INSERT OR IGNORE` keeps boot and a concurrent
/// status request agreeing on one identity; a restored snapshot keeps the
/// original rows untouched. Returns `(install_id, installed_at)`.
pub async fn ensure_identity(pool: &SqlitePool) -> sqlx::Result<(String, String)> {
    sqlx::query("INSERT OR IGNORE INTO instance_setting (key, value) VALUES (?, ?)")
        .bind(INSTALL_ID)
        .bind(new_id())
        .execute(pool)
        .await?;
    sqlx::query("INSERT OR IGNORE INTO instance_setting (key, value) VALUES (?, ?)")
        .bind(INSTALLED_AT)
        .bind(now_iso())
        .execute(pool)
        .await?;
    let install_id = get_setting(pool, INSTALL_ID).await?.unwrap_or_default();
    let installed_at = get_setting(pool, INSTALLED_AT).await?.unwrap_or_default();
    Ok((install_id, installed_at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[tokio::test]
    async fn identity_is_created_once_and_stable() {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let (first_id, first_at) = ensure_identity(&pool).await.expect("identity");
        assert!(!first_id.is_empty(), "install_id is set");
        assert!(!first_at.is_empty(), "installed_at is set");
        let (again_id, again_at) = ensure_identity(&pool).await.expect("identity again");
        assert_eq!(again_id, first_id, "the install id is stable");
        assert_eq!(again_at, first_at, "installed_at is stable");
        pool.close().await;
    }

    #[tokio::test]
    async fn settings_round_trip_and_absent_is_none() {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        assert_eq!(get_setting(&pool, TELEMETRY_ENABLED).await.expect("read"), None);
        set_setting(&pool, TELEMETRY_ENABLED, "0").await.expect("write");
        assert_eq!(
            get_setting(&pool, TELEMETRY_ENABLED).await.expect("read"),
            Some("0".to_string())
        );
        set_setting(&pool, TELEMETRY_ENABLED, "1").await.expect("overwrite");
        assert_eq!(
            get_setting(&pool, TELEMETRY_ENABLED).await.expect("read"),
            Some("1".to_string())
        );
        pool.close().await;
    }
}
