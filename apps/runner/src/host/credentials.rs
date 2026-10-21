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
//! provider exists yet, so no row is minted today; the Phase 4 provider
//! (SPEC, Scoped credentials) re-adds the write path. Two consumers, two rules:
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

    async fn revoke(&self, _pool: &sqlx::SqlitePool, _slug: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

fn kek(runner_token: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, runner_token.as_bytes());
    let mut out = [0u8; 32];
    // Static invariant: a 32-byte output never exceeds the HKDF length limit,
    // so expansion cannot fail.
    hk.expand(b"noite-app-credential-v1", &mut out)
        .expect("hkdf expand");
    out
}

fn decrypt(runner_token: &str, app_id: &str, nonce: &[u8], ct: &[u8]) -> anyhow::Result<String> {
    let key = kek(runner_token);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let nonce =
        Nonce::try_from(nonce).map_err(|_| anyhow::anyhow!("app credential decrypt failed"))?;
    let pt = cipher
        .decrypt(
            &nonce,
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

pub async fn revoke(pool: &sqlx::SqlitePool, app_id: &str) -> anyhow::Result<()> {
    db::delete_app_credential(pool, app_id).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decrypt, kek};
    use aes_gcm::{
        aead::{Aead, Payload},
        Aes256Gcm, KeyInit, Nonce,
    };

    /// Test-only row writer: production no longer mints rows (Phase 4
    /// re-adds the write path), but the round-trip below still guards the
    /// live read path (`decrypt` + app binding).
    fn encrypt(runner_token: &str, app_id: &str, plaintext: &str) -> (Vec<u8>, Vec<u8>) {
        let key = kek(runner_token);
        let cipher = Aes256Gcm::new_from_slice(&key).expect("kek len");
        // Random 96-bit nonce per encryption: GCM breaks outright on a repeated
        // (key, nonce) pair, and every row shares one key.
        let mut nonce_bytes = [0u8; 12];
        use rand::TryRng;
        rand::rngs::SysRng
            .try_fill_bytes(&mut nonce_bytes)
            .expect("os randomness");
        let nonce = Nonce::from(nonce_bytes);
        // The app id is associated data: a row copied onto another app fails to
        // decrypt instead of handing that app someone else's keys.
        let ct = cipher
            .encrypt(
                &nonce,
                Payload {
                    aad: app_id.as_bytes(),
                    msg: plaintext.as_bytes(),
                },
            )
            .expect("encrypt");
        (nonce_bytes.to_vec(), ct)
    }

    fn unhex(s: &str) -> Vec<u8> {
        let b = s.as_bytes();
        let digit = |c: u8| match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("bad hex"),
        };
        (0..b.len())
            .step_by(2)
            .map(|i| (digit(b[i]) << 4) | digit(b[i + 1]))
            .collect()
    }

    /// The encrypted-credential pipeline is byte-stable: a row written by an
    /// older build (HKDF-SHA256 KEK `noite-app-credential-v1`, AES-256-GCM
    /// with the app id as associated data) decrypts identically, and the
    /// same inputs re-encrypt to the same bytes. The vector below was
    /// produced by the pre-bump implementation; a crypto upgrade that
    /// silently changed outputs would strand every stored credential and
    /// every env token in the field.
    #[test]
    fn encrypted_rows_are_byte_stable() {
        let token = "noite-golden-token-v1";
        let app_id = "app-golden";
        let nonce = unhex("07132a03ff00804009c80b4d");
        let ct = unhex(
            "6aaaffc0eef1009cbfe6f07e917190f41f1acafdb54ef0f955dc09e7199c0016db09be1c3881fc576c35113\
             4c1425e4e17379a205d4ec649be6032a98a4539e67c84",
        );
        let pt = r#"{"access_key":"AKGOLDEN","secret_key":"sk-golden"}"#;
        assert_eq!(decrypt(token, app_id, &nonce, &ct).unwrap(), pt);
        // Same key, nonce, associated data and plaintext: same bytes out.
        let cipher = Aes256Gcm::new_from_slice(&kek(token)).expect("kek len");
        let again = cipher
            .encrypt(
                &Nonce::try_from(nonce.as_slice()).expect("golden nonce len"),
                Payload {
                    aad: app_id.as_bytes(),
                    msg: pt.as_bytes(),
                },
            )
            .expect("encrypt");
        assert_eq!(again, ct);
    }

    /// The primitives underneath are byte-stable against their published
    /// test vectors (independent of our code): NIST GCM test case 2,
    /// RFC 5869 HKDF-SHA256 case 1, RFC 4231 HMAC-SHA256 case 1, and
    /// SHA-256("abc").
    #[test]
    fn crypto_primitives_are_byte_stable() {
        use aes_gcm::Aes128Gcm;
        use hkdf::Hkdf;
        use hmac::{Hmac, Mac};
        use sha2::{Digest, Sha256};

        let zero16 = [0u8; 16];
        let cipher = Aes128Gcm::new_from_slice(&zero16).expect("key len");
        let gcm = cipher
            .encrypt(
                &Nonce::from([0u8; 12]),
                Payload {
                    msg: &zero16[..],
                    aad: b"",
                },
            )
            .expect("encrypt");
        assert_eq!(
            gcm,
            unhex("0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf")
        );

        let hk = Hkdf::<Sha256>::new(
            Some(&unhex("000102030405060708090a0b0c")[..]),
            &[0x0bu8; 22],
        );
        let mut okm = [0u8; 42];
        hk.expand(&unhex("f0f1f2f3f4f5f6f7f8f9"), &mut okm)
            .expect("hkdf expand");
        assert_eq!(
            okm,
            unhex(
                "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
            )[..]
        );

        let mut mac =
            <Hmac<Sha256> as hmac::KeyInit>::new_from_slice(&[0x0bu8; 20]).expect("hmac key");
        mac.update(b"Hi There");
        assert_eq!(
            mac.finalize().into_bytes()[..],
            unhex("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")[..]
        );

        let mut h = Sha256::new();
        h.update(b"abc");
        assert_eq!(
            h.finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
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
