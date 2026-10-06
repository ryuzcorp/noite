//! Encrypted per-app credential rows.

use sqlx::SqlitePool;

use crate::models::now_iso;

/// Encrypted per-app credential row (SPEC, Scoped credentials). Nonce +
/// AES-GCM ciphertext over JSON `{access_key, secret_key}`; the KEK derives
/// from RUNNER_TOKEN so the bucket snapshot is not a key dump.
pub async fn get_app_credential(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Option<(Vec<u8>, Vec<u8>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT nonce, ciphertext FROM app_credential WHERE app_id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await?;
    Ok(row)
}

pub async fn put_app_credential(
    pool: &SqlitePool,
    app_id: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> sqlx::Result<()> {
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
