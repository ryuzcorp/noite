//! Per-app public error-ingest credentials (ROADMAP, Error tracking phase 2).
//!
//! One row per app: the stable numeric project id the DSN and the envelope
//! path carry, plus the public key that authenticates envelope posts. The
//! row is created lazily on first read (no backfill for installs that predate
//! phase 2, and `apps.create` stays untouched) and dies with the app through
//! `ON DELETE CASCADE`. `project_id` is AUTOINCREMENT: a deleted app's number
//! is never reused, and rotation rewrites only the key.

use sqlx::SqlitePool;

use crate::models::now_iso;

/// An app's ingest identity: the number in its DSN and the key that signs it.
pub struct IngestKey {
    pub project_id: i64,
    pub key: String,
}

/// Mint a fresh public key: 20 random bytes as lowercase hex (the DSN's
/// `publicKey` slot only accepts `\w`, so no base64url `-`/`_`).
pub fn mint_key() -> String {
    let bytes: [u8; 20] = rand::random();
    let mut out = String::with_capacity(40);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The app's row, if it has one yet.
pub async fn get_ingest_key(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Option<IngestKey>> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT project_id, key FROM app_ingest_key WHERE app_id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(project_id, key)| IngestKey { project_id, key }))
}

/// Which app a project number belongs to, with its key (one lookup for the
/// envelope path: unknown numbers and wrong keys share the caller's refusal).
pub async fn app_for_project(
    pool: &SqlitePool,
    project_id: i64,
) -> sqlx::Result<Option<(String, String)>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT app_id, key FROM app_ingest_key WHERE project_id = ?")
            .bind(project_id)
            .fetch_optional(pool)
            .await?;
    Ok(row)
}

/// Get the app's row, creating it (key + number together) when missing.
pub async fn get_or_create_ingest_key(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<IngestKey> {
    if let Some(existing) = get_ingest_key(pool, app_id).await? {
        return Ok(existing);
    }
    let key = mint_key();
    let now = now_iso();
    sqlx::query("INSERT INTO app_ingest_key (app_id, key, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(app_id)
        .bind(&key)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    let row: (i64,) = sqlx::query_as("SELECT project_id FROM app_ingest_key WHERE app_id = ?")
        .bind(app_id)
        .fetch_one(pool)
        .await?;
    Ok(IngestKey {
        project_id: row.0,
        key,
    })
}

/// Mint a replacement key, keeping the project number. Returns the new key.
pub async fn rotate_ingest_key(pool: &SqlitePool, app_id: &str) -> sqlx::Result<IngestKey> {
    let key = mint_key();
    let now = now_iso();
    let res = sqlx::query("UPDATE app_ingest_key SET key = ?, updated_at = ? WHERE app_id = ?")
        .bind(&key)
        .bind(&now)
        .bind(app_id)
        .execute(pool)
        .await?;
    if res.rows_affected() == 0 {
        return get_or_create_ingest_key(pool, app_id).await;
    }
    let row: (i64,) = sqlx::query_as("SELECT project_id FROM app_ingest_key WHERE app_id = ?")
        .bind(app_id)
        .fetch_one(pool)
        .await?;
    Ok(IngestKey {
        project_id: row.0,
        key,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db::connect;
    use crate::models::new_id;

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("noite-ingest-key-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}/noite.sqlite?mode=rwc", dir.display());
        connect(&url).await.expect("connect")
    }

    async fn seed_app(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO app (id, slug, name, user_id, status, subdomain, git_prefix, fleet_bucket, created_at, updated_at) \
             VALUES (?, ?, ?, 'u1', 'running', ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(id)
        .bind(id)
        .bind(id)
        .bind(format!("{id}.localhost"))
        .bind(format!("git/{id}"))
        .bind(format!("fleets/{id}"))
        .execute(pool)
        .await
        .expect("seed app");
    }

    #[tokio::test]
    async fn creates_key_and_number_together_then_reads_them_back() {
        let pool = pool().await;
        seed_app(&pool, "app-one").await;
        assert!(get_ingest_key(&pool, "app-one").await.expect("get").is_none());
        let created = get_or_create_ingest_key(&pool, "app-one").await.expect("create");
        assert!(created.project_id >= 1);
        assert_eq!(created.key.len(), 40);
        let again = get_or_create_ingest_key(&pool, "app-one").await.expect("again");
        assert_eq!(again.project_id, created.project_id);
        assert_eq!(again.key, created.key);
        let (app_id, key) = app_for_project(&pool, created.project_id)
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(app_id, "app-one");
        assert_eq!(key, created.key);
        assert!(app_for_project(&pool, created.project_id + 1000).await.expect("missing").is_none());
    }

    #[tokio::test]
    async fn rotation_keeps_the_number_and_invalidates_the_old_key() {
        let pool = pool().await;
        seed_app(&pool, "app-two").await;
        let before = get_or_create_ingest_key(&pool, "app-two").await.expect("create");
        let after = rotate_ingest_key(&pool, "app-two").await.expect("rotate");
        assert_eq!(after.project_id, before.project_id);
        assert_ne!(after.key, before.key);
        let (_, live) = app_for_project(&pool, before.project_id)
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(live, after.key);
    }

    #[tokio::test]
    async fn numbers_are_never_reused_after_delete() {
        let pool = pool().await;
        seed_app(&pool, "app-gone").await;
        let gone = get_or_create_ingest_key(&pool, "app-gone").await.expect("create");
        crate::db::delete_app(&pool, "app-gone").await.expect("delete");
        assert!(app_for_project(&pool, gone.project_id).await.expect("lookup").is_none());
        seed_app(&pool, "app-next").await;
        let next = get_or_create_ingest_key(&pool, "app-next").await.expect("create");
        assert_ne!(next.project_id, gone.project_id);
    }
}
