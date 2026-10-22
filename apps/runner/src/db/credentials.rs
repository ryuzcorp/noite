//! Encrypted scoped-credential rows (SPEC, Scoped credentials).
//!
//! One row per tenant scope (`app:<app_id>`, `env:<env_id>`): the nonce and
//! AES-GCM ciphertext over JSON `{access_key, secret_key}`, plus the plaintext
//! the runner needs without decrypting (the store handle for revocation, the
//! prefix the key reaches, which store minted it, and whether the row is
//! still handed out). The KEK derives from RUNNER_TOKEN so the bucket
//! snapshot is not a key dump.

use sqlx::SqlitePool;

/// One `scoped_credential` row, as the two SELECTs below return it.
type ScopedRow = (String, String, String, String, String, Vec<u8>, Vec<u8>);

/// One `scoped_credential` row.
pub struct ScopedCredential {
    pub scope: String,
    pub app_id: String,
    pub handle: String,
    pub prefix: String,
    pub store: String,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// A row to insert: all fields but the timestamp.
pub struct NewScopedCredential<'a> {
    pub scope: &'a str,
    pub app_id: &'a str,
    pub handle: &'a str,
    pub prefix: &'a str,
    pub store: &'a str,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
}

fn assemble(
    scope: String,
    app_id: String,
    handle: String,
    prefix: String,
    store: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
) -> ScopedCredential {
    ScopedCredential {
        scope,
        app_id,
        handle,
        prefix,
        store,
        nonce,
        ciphertext,
    }
}

/// The row the runner still hands out for `scope`, if any.
pub async fn live_scoped_credential(
    pool: &SqlitePool,
    scope: &str,
) -> sqlx::Result<Option<ScopedCredential>> {
    let row: Option<ScopedRow> = sqlx::query_as(
        "SELECT scope, app_id, handle, prefix, store, nonce, ciphertext \
             FROM main.scoped_credential WHERE scope = ? AND state = 'live'",
    )
    .bind(scope)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(scope, app_id, handle, prefix, store, nonce, ciphertext)| {
            assemble(scope, app_id, handle, prefix, store, nonce, ciphertext)
        },
    ))
}

pub async fn insert_scoped_credential(
    pool: &SqlitePool,
    row: &NewScopedCredential<'_>,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO main.scoped_credential \
         (scope, app_id, handle, prefix, store, state, nonce, ciphertext, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'live', ?, ?, datetime('now'))",
    )
    .bind(row.scope)
    .bind(row.app_id)
    .bind(row.handle)
    .bind(row.prefix)
    .bind(row.store)
    .bind(row.nonce)
    .bind(row.ciphertext)
    .execute(pool)
    .await?;
    Ok(())
}

/// Stop handing out the key `handle` names; [`super::mark`] sweeps retry the
/// store delete until it accepts.
pub async fn mark_scoped_credential_revoking(pool: &SqlitePool, handle: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE main.scoped_credential SET state = 'revoking', updated_at = datetime('now') \
         WHERE handle = ? AND state = 'live'",
    )
    .bind(handle)
    .execute(pool)
    .await?;
    Ok(())
}

/// Every live key of one app and its environments: delete and rename (whose
/// prefixes moved) call it; the next spawn mints fresh keys.
pub async fn mark_app_scoped_credentials_revoking(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE main.scoped_credential SET state = 'revoking', updated_at = datetime('now') \
         WHERE app_id = ? AND state = 'live'",
    )
    .bind(app_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Every key still awaiting its store delete.
pub async fn revoking_scoped_credentials(pool: &SqlitePool) -> sqlx::Result<Vec<ScopedCredential>> {
    let rows: Vec<ScopedRow> = sqlx::query_as(
        "SELECT scope, app_id, handle, prefix, store, nonce, ciphertext \
             FROM main.scoped_credential WHERE state = 'revoking' ORDER BY updated_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(scope, app_id, handle, prefix, store, nonce, ciphertext)| {
                assemble(scope, app_id, handle, prefix, store, nonce, ciphertext)
            },
        )
        .collect())
}

pub async fn delete_scoped_credential(pool: &SqlitePool, handle: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM main.scoped_credential WHERE handle = ?")
        .bind(handle)
        .execute(pool)
        .await?;
    Ok(())
}

/// Every `scoped_credential` handle, live or revoking: the orphan sweep
/// keeps any listed principal one of these names.
pub async fn all_scoped_credential_handles(pool: &SqlitePool) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT handle FROM main.scoped_credential")
        .fetch_all(pool)
        .await
}

/// Whether any `scoped_credential` row names `handle`: the orphan sweep's
/// per-key re-check under `MUTATE` (see `host::credentials::orphan_sweep`).
pub async fn scoped_credential_handle_exists(
    pool: &SqlitePool,
    handle: &str,
) -> sqlx::Result<bool> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT handle FROM main.scoped_credential WHERE handle = ? LIMIT 1")
            .bind(handle)
            .fetch_optional(pool)
            .await?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::connect;

    fn new_row<'a>(scope: &'a str, app_id: &'a str, handle: &'a str) -> NewScopedCredential<'a> {
        NewScopedCredential {
            scope,
            app_id,
            handle,
            prefix: "fleets/a/",
            store: "minio|http://rustfs:9000|noite",
            nonce: b"nonce-12-bytes",
            ciphertext: b"ciphertext",
        }
    }
    #[tokio::test]
    async fn lifecycle_marks_then_deletes() {
        let pool = connect("sqlite::memory:").await.expect("memory db");
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS main.scoped_credential (scope TEXT PRIMARY KEY NOT NULL, \
             app_id TEXT NOT NULL, handle TEXT NOT NULL, prefix TEXT NOT NULL, \
             store TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'live', nonce BLOB NOT NULL, \
             ciphertext BLOB NOT NULL, updated_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("test table");
        insert_scoped_credential(&pool, &new_row("app:a", "a", "h1"))
            .await
            .expect("insert");
        assert!(live_scoped_credential(&pool, "app:a")
            .await
            .expect("read")
            .is_some());
        mark_app_scoped_credentials_revoking(&pool, "a")
            .await
            .expect("mark");
        assert!(live_scoped_credential(&pool, "app:a")
            .await
            .expect("read")
            .is_none());
        assert_eq!(
            revoking_scoped_credentials(&pool)
                .await
                .expect("pending")
                .len(),
            1
        );
        delete_scoped_credential(&pool, "h1").await.expect("delete");
        assert!(revoking_scoped_credentials(&pool)
            .await
            .expect("pending")
            .is_empty());
        pool.close().await;
    }
}
