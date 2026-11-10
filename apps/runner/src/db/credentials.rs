//! Encrypted scoped-credential rows (SPEC, Scoped credentials).
//!
//! One row per tenant scope (`app:<app_id>`, `env:<env_id>`): the nonce and
//! AES-GCM ciphertext over JSON `{access_key, secret_key}`, plus the plaintext
//! the runner needs without decrypting (the store handle for revocation, the
//! prefix the key reaches, which store minted it, and whether the row is
//! still handed out). The KEK derives from RUNNER_TOKEN so the bucket
//! snapshot is not a key dump.

use sqlx::SqlitePool;

/// A scoped key's lifecycle. `live` is handed to the tenant fleet; `revoking`
/// is no longer handed out and waits for the store delete (`sweep` retries it
/// on every pass). The row is deleted when the store accepts the delete, or
/// immediately when it was minted in a store this runner no longer
/// administers.
///
/// ```text
/// (none) --mint--> live --supersede/teardown--> revoking --store delete--> (gone)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(rename_all = "lowercase")]
pub enum ScopedCredentialState {
    Live,
    Revoking,
}

impl ScopedCredentialState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Revoking => "revoking",
        }
    }
}

/// One `scoped_credential` row, as the two SELECTs below return it.
type ScopedRow = (
    String,
    String,
    String,
    String,
    String,
    ScopedCredentialState,
    Vec<u8>,
    Vec<u8>,
);

/// One `scoped_credential` row.
pub struct ScopedCredential {
    pub scope: String,
    pub app_id: String,
    pub handle: String,
    pub prefix: String,
    pub store: String,
    pub state: ScopedCredentialState,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

/// A row to insert: all fields but the timestamp and state (always `live`).
pub struct NewScopedCredential<'a> {
    pub scope: &'a str,
    pub app_id: &'a str,
    pub handle: &'a str,
    pub prefix: &'a str,
    pub store: &'a str,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
}

impl ScopedCredential {
    fn from_row(row: ScopedRow) -> Self {
        let (scope, app_id, handle, prefix, store, state, nonce, ciphertext) = row;
        Self {
            scope,
            app_id,
            handle,
            prefix,
            store,
            state,
            nonce,
            ciphertext,
        }
    }
}

/// The row the runner still hands out for `scope`, if any.
pub async fn live_scoped_credential(
    pool: &SqlitePool,
    scope: &str,
) -> sqlx::Result<Option<ScopedCredential>> {
    let row: Option<ScopedRow> = sqlx::query_as(
        "SELECT scope, app_id, handle, prefix, store, state, nonce, ciphertext \
             FROM main.scoped_credential WHERE scope = ? AND state = ?",
    )
    .bind(scope)
    .bind(ScopedCredentialState::Live)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(ScopedCredential::from_row))
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
        "UPDATE main.scoped_credential SET state = ?, updated_at = datetime('now') \
         WHERE handle = ? AND state = ?",
    )
    .bind(ScopedCredentialState::Revoking)
    .bind(handle)
    .bind(ScopedCredentialState::Live)
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
        "UPDATE main.scoped_credential SET state = ?, updated_at = datetime('now') \
         WHERE app_id = ? AND state = ?",
    )
    .bind(ScopedCredentialState::Revoking)
    .bind(app_id)
    .bind(ScopedCredentialState::Live)
    .execute(pool)
    .await?;
    Ok(())
}

/// Every key still awaiting its store delete.
pub async fn revoking_scoped_credentials(pool: &SqlitePool) -> sqlx::Result<Vec<ScopedCredential>> {
    let rows: Vec<ScopedRow> = sqlx::query_as(
        "SELECT scope, app_id, handle, prefix, store, state, nonce, ciphertext \
             FROM main.scoped_credential WHERE state = ? ORDER BY updated_at",
    )
    .bind(ScopedCredentialState::Revoking)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(ScopedCredential::from_row).collect())
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

/// The stored token row for `scope` (`app:<id>`, `env:<id>`, `control`),
/// as nonce + ciphertext over the token, if any. The KEK derives from
/// RUNNER_TOKEN (see `host::credentials`), so the bucket snapshot is not a
/// token dump.
pub async fn get_operator_token(
    pool: &SqlitePool,
    scope: &str,
) -> sqlx::Result<Option<(Vec<u8>, Vec<u8>)>> {
    sqlx::query_as("SELECT nonce, ciphertext FROM main.fleet_operator_token WHERE scope = ?")
        .bind(scope)
        .fetch_optional(pool)
        .await
}

/// Store a freshly minted token row. The caller holds `host` `MUTATE`, so a
/// primary-key conflict means a second runner owns this database (the
/// `owner.json` fence forbids that) — it surfaces as an error, never a
/// silent overwrite.
pub async fn insert_operator_token(
    pool: &SqlitePool,
    scope: &str,
    app_id: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO main.fleet_operator_token (scope, app_id, nonce, ciphertext, updated_at) \
         VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(scope)
    .bind(app_id)
    .bind(nonce)
    .bind(ciphertext)
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop one fleet's token row. The caller (`host::credentials`) must also
/// evict the process cache, or a live caller keeps presenting a dead token.
pub async fn remove_operator_token_row(pool: &SqlitePool, scope: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM main.fleet_operator_token WHERE scope = ?")
        .bind(scope)
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop every token row of one app and its environments (app delete).
pub async fn remove_app_operator_token_rows(pool: &SqlitePool, app_id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM main.fleet_operator_token WHERE app_id = ?")
        .bind(app_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// The scopes whose token rows belong to `app_id`: the cache keys the app
/// delete has to evict alongside the rows.
pub async fn operator_token_scopes_for_app(
    pool: &SqlitePool,
    app_id: &str,
) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar("SELECT scope FROM main.fleet_operator_token WHERE app_id = ?")
        .bind(app_id)
        .fetch_all(pool)
        .await
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
