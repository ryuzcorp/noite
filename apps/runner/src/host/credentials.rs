//! Scoped fleet credentials (SPEC, Scoped credentials).
//!
//! Model: every app gets keys that can read/write only
//! `s3://{bucket}/fleets/{slug}/`. Keys are minted at app create, stored
//! encrypted in the runner SQLite (`app_credential`; AES-GCM with a key
//! derived from `RUNNER_TOKEN` via HKDF, so the bucket snapshot is not a key
//! dump), rotated on rename, revoked on delete.
//!
//! Providers (4.2): RustFS IAM (verify), MinIO (supported), AWS STS
//! (supported), R2/Tigris bucket-per-app (optional/verify). No scoped
//! provider exists yet, so no row is minted today: `mint` is only for a real
//! per-prefix key pair. Two consumers, two rules:
//!
//! - **Tenant processes** (release scripts run tenant code with the key in
//!   their env): scoped keys only; root keys only with `NOITE_TENANCY=single`.
//!   See [`tenant_process_credentials`].
//! - **Fleets** (celld holds the key in its own process; Worker code cannot
//!   read the process env): scoped keys when minted, else root in both modes
//!   until Phase 4 lands. See [`fleet_credentials`].

use std::future::Future;

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::config::{Config, Tenancy};
use crate::db;

/// Keys scoped to one app prefix.
#[derive(Clone, Debug)]
pub struct AppCredentials {
    pub access_key: String,
    pub secret_key: String,
}

pub trait CredentialProvider: Send + Sync {
    /// Keys that can read/write only `s3://{bucket}/fleets/{slug}/`.
    fn app_credentials(
        &self,
        pool: &sqlx::SqlitePool,
        cfg: &Config,
        slug: &str,
    ) -> impl Future<Output = anyhow::Result<Option<AppCredentials>>> + Send;
    #[allow(dead_code)]
    fn revoke(
        &self,
        pool: &sqlx::SqlitePool,
        slug: &str,
    ) -> impl Future<Output = anyhow::Result<()>> + Send;
}

/// Root keys (today). Allowed only in `single` tenancy.
pub struct RootProvider;

impl CredentialProvider for RootProvider {
    async fn app_credentials(
        &self,
        _pool: &sqlx::SqlitePool,
        cfg: &Config,
        _slug: &str,
    ) -> anyhow::Result<Option<AppCredentials>> {
        if cfg.tenancy == Tenancy::Multi {
            return Ok(None);
        }
        Ok(Some(AppCredentials {
            access_key: cfg.aws_access_key_id.clone(),
            secret_key: cfg.aws_secret_access_key.clone(),
        }))
    }

    async fn revoke(
        &self,
        _pool: &sqlx::SqlitePool,
        _slug: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

fn kek(runner_token: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, runner_token.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(b"noite-app-credential-v1", &mut out)
        .expect("hkdf expand");
    out
}

fn encrypt(runner_token: &str, app_id: &str, plaintext: &str) -> (Vec<u8>, Vec<u8>) {
    let key = kek(runner_token);
    let cipher = Aes256Gcm::new_from_slice(&key).expect("kek len");
    // Random 96-bit nonce per encryption: GCM breaks outright on a repeated
    // (key, nonce) pair, and every row shares one key.
    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    // The app id is associated data: a row copied onto another app fails to
    // decrypt instead of handing that app someone else's keys.
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                aad: app_id.as_bytes(),
                msg: plaintext.as_bytes(),
            },
        )
        .expect("encrypt");
    (nonce_bytes.to_vec(), ct)
}

fn decrypt(runner_token: &str, app_id: &str, nonce: &[u8], ct: &[u8]) -> anyhow::Result<String> {
    let key = kek(runner_token);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let nonce = Nonce::from_slice(nonce);
    let pt = cipher
        .decrypt(
            nonce,
            Payload {
                aad: app_id.as_bytes(),
                msg: ct,
            },
        )
        .map_err(|_| anyhow::anyhow!("app credential decrypt failed"))?;
    Ok(String::from_utf8(pt)?)
}

/// Real per-prefix keys for one app (the encrypted row). Never root keys.
pub async fn scoped_credentials(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    slug: &str,
) -> anyhow::Result<Option<AppCredentials>> {
    let Some(app) = db::get_app_by_slug(pool, slug).await? else {
        return Ok(None);
    };
    if let Some((nonce, ct)) = db::get_app_credential(pool, &app.id).await? {
        let json = decrypt(&cfg.runner_token, &app.id, &nonce, &ct)?;
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            if let (Some(a), Some(s)) = (
                v.get("access_key").and_then(|x| x.as_str()),
                v.get("secret_key").and_then(|x| x.as_str()),
            ) {
                return Ok(Some(AppCredentials {
                    access_key: a.to_string(),
                    secret_key: s.to_string(),
                }));
            }
        }
    }
    Ok(None)
}

/// Keys for a process that runs tenant code (the release command): scoped
/// keys, or root only in `single` tenancy. `None` = no safe key exists and
/// the caller must not run the tenant process with bucket access.
pub async fn tenant_process_credentials(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    slug: &str,
) -> anyhow::Result<Option<AppCredentials>> {
    if let Some(scoped) = scoped_credentials(pool, cfg, slug).await? {
        return Ok(Some(scoped));
    }
    RootProvider.app_credentials(pool, cfg, slug).await
}

/// Keys for a tenant fleet's celld process: scoped when minted, else root.
/// Root is acceptable here until Phase 4 because celld keeps the key in its
/// own process and Worker code has no access to the process env; the risk
/// is a celld bug, which scoped keys (Phase 4) contain.
pub async fn fleet_credentials(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    slug: &str,
) -> anyhow::Result<AppCredentials> {
    if let Some(scoped) = scoped_credentials(pool, cfg, slug).await? {
        return Ok(scoped);
    }
    if cfg.tenancy == Tenancy::Multi {
        tracing::debug!(slug, "fleet runs with root bucket keys until a scoped provider lands (SPEC, Scoped credentials)");
    }
    Ok(AppCredentials {
        access_key: cfg.aws_access_key_id.clone(),
        secret_key: cfg.aws_secret_access_key.clone(),
    })
}

/// Store a scoped key pair for an app. Only a real per-prefix provider may
/// call this: a row here is trusted as scoped by tenant processes, so
/// storing root keys would hand them to tenant release scripts.
#[allow(dead_code)] // first caller is the Phase 4 provider
pub async fn mint(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    app_id: &str,
    access_key: &str,
    secret_key: &str,
) -> anyhow::Result<()> {
    let payload = serde_json::json!({ "access_key": access_key, "secret_key": secret_key }).to_string();
    let (nonce, ct) = encrypt(&cfg.runner_token, app_id, &payload);
    db::put_app_credential(pool, app_id, &nonce, &ct).await?;
    Ok(())
}

pub async fn revoke(pool: &sqlx::SqlitePool, app_id: &str) -> anyhow::Result<()> {
    db::delete_app_credential(pool, app_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decrypt, encrypt};

    #[test]
    fn credential_rows_round_trip_and_bind_to_their_app() {
        let (nonce, ct) = encrypt("token", "app-a", "secret");
        assert_eq!(decrypt("token", "app-a", &nonce, &ct).unwrap(), "secret");
        // Copied onto another app's row: refuses instead of decrypting.
        assert!(decrypt("token", "app-b", &nonce, &ct).is_err());
        // Nonces are random: two encryptions of the same row differ.
        let (nonce2, _) = encrypt("token", "app-a", "secret");
        assert_ne!(nonce, nonce2);
    }
}
