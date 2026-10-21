//! Prefix-scoped keys through the MinIO admin API (MinIO and RustFS).
//!
//! Verified against the real `rustfs:1.0.3` image (and 1.0.0): it answers
//! the MinIO admin paths with SigV4 `s3`-service signatures, encrypts and
//! decrypts admin payloads with the madmin scheme (argon2id KDF + sio-DARE
//! stream framing), and enforces the attached policy on S3 calls. Adding a
//! user is one encrypted `PUT add-user`, attaching its policy one raw `PUT
//! add-canned-policy` plus `PUT set-user-or-group-policy`; deleting is
//! `DELETE remove-user` plus `DELETE remove-canned-policy`.

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use argon2::Argon2;
use futures::future::BoxFuture;
use sha2::{Digest, Sha256};

use super::{sigv4_now, CredentialProvider, MintedKey, SigV4, StoreAccess};

/// Admin client for a MinIO-family store.
pub struct MinioAdmin {
    store: StoreAccess,
    label: &'static str,
    client: reqwest::Client,
}

impl MinioAdmin {
    /// The bundled image's own store.
    pub fn rustfs(store: StoreAccess) -> Self {
        Self {
            store,
            label: "rustfs",
            client: reqwest::Client::new(),
        }
    }

    /// Any other MinIO-family store (MinIO itself, another RustFS).
    pub fn minio(store: StoreAccess) -> Self {
        Self {
            store,
            label: "minio",
            client: reqwest::Client::new(),
        }
    }

    fn host(&self) -> String {
        reqwest::Url::parse(&self.store.endpoint)
            .ok()
            .and_then(|u| {
                u.host_str().map(|h| {
                    if let Some(port) = u.port() {
                        format!("{h}:{port}")
                    } else {
                        h.to_string()
                    }
                })
            })
            .unwrap_or_default()
    }

    fn url(&self, path_qs: &str) -> anyhow::Result<String> {
        Ok(format!(
            "{}{}",
            self.store.endpoint.trim_end_matches('/'),
            path_qs
        ))
    }
    fn fail(status: u16, body: &[u8], op: &str) -> anyhow::Error {
        anyhow::anyhow!("{op}: HTTP {status} {}", String::from_utf8_lossy(body))
    }

    /// One signed admin call. `query` is the raw (unsorted) query string;
    /// the signer sorts it. Returns the raw body on 200.
    async fn call(
        &self,
        method: &str,
        path: &str,
        query: &str,
        body: &[u8],
    ) -> anyhow::Result<(u16, Vec<u8>)> {
        let payload_hash = super::hex_encode(Sha256::digest(body).as_slice());
        let (amz_date, date_stamp) = sigv4_now();
        let host = self.host();
        let auth = SigV4 {
            method,
            uri: path,
            query,
            host: &host,
            region: &self.store.region,
            service: "s3",
            access_key: &self.store.access_key,
            secret_key: &self.store.secret_key,
            payload_hash: &payload_hash,
            amz_date: &amz_date,
            date_stamp: &date_stamp,
        }
        .authorization();
        let url = self.url(path)?;
        let url = if query.is_empty() {
            url
        } else {
            format!("{url}?{query}")
        };
        let resp = self
            .client
            .request(method.parse()?, &url)
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header("authorization", auth)
            .body(body.to_vec())
            .send()
            .await?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await?.to_vec();
        Ok((status, bytes))
    }

    /// Does this store speak the MinIO admin API with these keys? `Ok(())`
    /// on any answer the API itself gives (200 with an encrypted body);
    /// `Err(why)` when the store definitely does not (wrong path, wrong
    /// signature scheme, wrong keys).
    pub async fn probe(&self) -> anyhow::Result<Result<(), String>> {
        // `info` is the current name; older MinIO answers `server-info`.
        for path in ["/minio/admin/v3/info", "/minio/admin/v3/server-info"] {
            match self.call("GET", path, "", b"").await {
                Ok((200, _)) => return Ok(Ok(())),
                // A signed-shaped refusal means the API is there but the
                // keys are wrong: definite, not transient.
                Ok((status, body)) if status == 401 || status == 403 => {
                    return Ok(Err(format!(
                        "HTTP {status} {}",
                        String::from_utf8_lossy(&body)
                    )));
                }
                // Anything else (404, 501, transport): try the next path.
                Ok(_) | Err(_) => continue,
            }
        }
        Ok(Err("no MinIO admin API".into()))
    }
}

impl CredentialProvider for MinioAdmin {
    fn name(&self) -> &'static str {
        self.label
    }

    fn mint<'a>(
        &'a self,
        bucket: &'a str,
        prefix: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<MintedKey>> {
        Box::pin(async move {
            let access_key = format!("noite{}", super::random_key(15));
            let secret_key = super::random_key(40);
            let policy_name = format!("noite-{}", sanitize(prefix));
            // The request body is JSON the API encrypts (madmin `SetUserReq`):
            // the raw secret alone is refused with "failed to decrypt".
            let user_body = serde_json::json!({
                "secretKey": secret_key,
                "status": "enabled",
            });
            let enc =
                encrypt_admin_payload(&self.store.secret_key, &serde_json::to_vec(&user_body)?)?;
            let (status, body) = self
                .call(
                    "PUT",
                    "/minio/admin/v3/add-user",
                    &format!("accessKey={access_key}"),
                    &enc,
                )
                .await?;
            if status != 200 {
                return Err(Self::fail(status, &body, "add-user"));
            }
            // The policy itself travels raw (madmin `AddCannedPolicy`).
            let (status, body) = self
                .call(
                    "PUT",
                    "/minio/admin/v3/add-canned-policy",
                    &format!("name={policy_name}"),
                    super::prefix_policy(bucket, prefix).as_bytes(),
                )
                .await?;
            if status != 200 {
                let _ = self.revoke(&access_key).await;
                return Err(Self::fail(status, &body, "add-canned-policy"));
            }
            let (status, body) = self
                .call(
                    "PUT",
                    "/minio/admin/v3/set-user-or-group-policy",
                    &format!("policyName={policy_name}&userOrGroup={access_key}&isGroup=false"),
                    b"",
                )
                .await?;
            if status != 200 {
                let _ = self.revoke(&access_key).await;
                return Err(Self::fail(status, &body, "set-user-or-group-policy"));
            }
            Ok(MintedKey {
                handle: access_key.clone(),
                access_key,
                secret_key,
            })
        })
    }

    fn revoke<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            // Best effort on both halves: a half-minted key (user without
            // policy, or policy without user) still stops working once its
            // half is gone, and a missing half is success, not an error.
            let (status, body) = self
                .call(
                    "DELETE",
                    "/minio/admin/v3/remove-user",
                    &format!("accessKey={handle}"),
                    b"",
                )
                .await?;
            if status != 200 && !is_no_such(status, &body) {
                return Err(Self::fail(status, &body, "remove-user"));
            }
            let policy_name = format!("noite-{}", sanitize(handle));
            let (status, body) = self
                .call(
                    "DELETE",
                    "/minio/admin/v3/remove-canned-policy",
                    &format!("name={policy_name}"),
                    b"",
                )
                .await?;
            if status != 200 && !is_no_such(status, &body) {
                return Err(Self::fail(status, &body, "remove-canned-policy"));
            }
            Ok(())
        })
    }
}

/// A missing user or policy is already revoked.
fn is_no_such(status: u16, body: &[u8]) -> bool {
    status == 404
        || body.windows(9).any(|w| w == b"NoSuchKey")
        || body.windows(12).any(|w| w == b"NoSuchEntity")
        || body.windows(13).any(|w| w == b"XMinioAdminNo")
}

fn sanitize(prefix: &str) -> String {
    prefix
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// madmin `EncryptData`: `salt(32) | id(1) | nonce(8) | sio-DARE ciphertext`.
/// The DARE framing is one 16 KiB-chunk stream (admin payloads are small):
/// an ad tag sealed under the stream nonce with sequence 0, then the single
/// final chunk (`0x80` prefix) sealed under sequence 1. Byte-checked against
/// sio-go's own test vectors.
pub fn encrypt_admin_payload(secret: &str, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut salt = [0u8; 32];
    let mut nonce = [0u8; 8];
    use rand::TryRng;
    rand::rngs::SysRng
        .try_fill_bytes(&mut salt)
        .map_err(|e| anyhow::anyhow!("os randomness: {e}"))?;
    rand::rngs::SysRng
        .try_fill_bytes(&mut nonce)
        .map_err(|e| anyhow::anyhow!("os randomness: {e}"))?;
    let key = argon2_key(secret, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    // ad = 0x00 || Seal(nonce || seq 0, empty) — authenticates the stream.
    let mut seq0 = [0u8; 12];
    seq0[..8].copy_from_slice(&nonce);
    let tag = cipher
        .encrypt(&Nonce::from(seq0), &[][..])
        .map_err(|_| anyhow::anyhow!("admin payload seal failed"))?;
    let mut ad = vec![0x80u8];
    ad.extend_from_slice(&tag);
    // The single chunk is also the last: sequence 1, `0x80` ad prefix.
    let mut seq1 = [0u8; 12];
    seq1[..8].copy_from_slice(&nonce);
    seq1[8] = 1;
    let chunk = cipher
        .encrypt(
            &Nonce::from(seq1),
            aes_gcm::aead::Payload {
                msg: data,
                aad: &ad,
            },
        )
        .map_err(|_| anyhow::anyhow!("admin payload seal failed"))?;
    let mut out = salt.to_vec();
    out.push(0x00); // argon2id + AES-GCM
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&chunk);
    Ok(out)
}

fn argon2_key(secret: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        argon2::Params::new(65536, 1, 4, Some(32)).expect("argon2 params"),
    )
    .hash_password_into(secret.as_bytes(), salt, &mut key)
    .expect("argon2 kdf");
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    /// sio-go's own stream test vectors (AES-128-GCM, bufsize 16): our
    /// framing must seal the identical final chunk, or every admin write
    /// fails closed at the store.
    #[test]
    fn dare_framing_matches_sio_vectors() {
        use aes_gcm::Aes128Gcm;
        fn seal(key: &[u8], nonce8: &[u8; 8], ad_param: &[u8], data: &[u8]) -> Vec<u8> {
            use aes_gcm::aead::Payload;
            let cipher = Aes128Gcm::new_from_slice(key).expect("key len");
            let mut seq0 = [0u8; 12];
            seq0[..8].copy_from_slice(nonce8);
            // The stream tag seals the empty plaintext with the caller's ad.
            let tag = cipher
                .encrypt(
                    &Nonce::from(seq0),
                    Payload {
                        msg: &[][..],
                        aad: ad_param,
                    },
                )
                .expect("seal");
            let mut ad = vec![0x80u8];
            ad.extend_from_slice(&tag);
            let mut seq1 = [0u8; 12];
            seq1[..8].copy_from_slice(nonce8);
            seq1[8] = 1;
            cipher
                .encrypt(
                    &Nonce::from(seq1),
                    aes_gcm::aead::Payload {
                        msg: data,
                        aad: &ad,
                    },
                )
                .expect("seal")
        }
        fn hexd(s: &str) -> Vec<u8> {
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
                .collect()
        }
        let zero = [0u8; 16];
        assert_eq!(
            super::super::hex_encode(&seal(&zero, &[0u8; 8], &[], &[])),
            "e0247a864e783cecb1f7996c13cd3f64"
        );
        let key = hexd("10000000000000000000000000000000");
        let nonce = hexd("1000000000000000");
        assert_eq!(
            super::super::hex_encode(&seal(
                &key,
                nonce.as_slice().try_into().expect("nonce len"),
                &[0x00],
                &[0x00]
            )),
            "61ed193d12a2adf6f1c41f31de4ead6c5c"
        );
    }
}
