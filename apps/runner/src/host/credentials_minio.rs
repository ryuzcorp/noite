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
    /// on any answer the API itself gives (200 with an encrypted body).
    /// A 401/403 is the API answering that the keys are wrong: that fails
    /// the boot with a credential error rather than silently downgrading
    /// every fleet to root keys. Anything else (404, 501, transport) means
    /// no admin API here: `Ok(Err(..))`, and the caller runs root.
    pub async fn probe(&self) -> anyhow::Result<Result<(), String>> {
        // `info` is the current name; older MinIO answers `server-info`.
        for path in ["/minio/admin/v3/info", "/minio/admin/v3/server-info"] {
            match self.call("GET", path, "", b"").await {
                Ok((200, _)) => return Ok(Ok(())),
                Ok((status, body)) if status == 401 || status == 403 => {
                    return Err(anyhow::anyhow!(
                        "store refused the admin credentials (HTTP {status} {}): check the S3 keys",
                        String::from_utf8_lossy(&body)
                    ));
                }
                // Anything else (404, 501, transport): try the next path.
                Ok(_) | Err(_) => continue,
            }
        }
        Ok(Err("no MinIO admin API".into()))
    }
    /// The policy this provider attaches: the shared prefix policy, except
    /// on RustFS, whose 1.0.x policy engine rejects the
    /// `s3:CompleteMultipartUpload` name at create time (verified against
    /// 1.0.0 and 1.0.3). RustFS maps completion onto `s3:PutObject` instead,
    /// so its keys complete multipart uploads without the action; MinIO and
    /// AWS get the full policy.
    fn policy(&self, bucket: &str, prefix: &str) -> String {
        let full = super::prefix_policy(bucket, prefix);
        if self.label != "rustfs" {
            return full;
        }
        let mut policy: serde_json::Value =
            serde_json::from_str(&full).expect("prefix policy is valid json");
        for statement in policy["Statement"].as_array_mut().expect("statements") {
            if let Some(actions) = statement["Action"].as_array_mut() {
                actions.retain(|a| a != "s3:CompleteMultipartUpload");
            }
        }
        policy.to_string()
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
            // The policy is named per key, not per prefix: revoke only knows
            // the handle (the access key), so the name it deletes must be
            // derivable from the key alone.
            let policy_name = format!("noite-{}", sanitize(&access_key));
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
                    self.policy(bucket, prefix).as_bytes(),
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
    fn stub_store(endpoint: String) -> StoreAccess {
        StoreAccess {
            endpoint,
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        }
    }

    /// The RustFS variant drops exactly the action its policy engine
    /// rejects; everything else (including the multipart listing) stays.
    #[test]
    fn rustfs_policy_omits_unrecognized_complete_action() {
        let full: serde_json::Value =
            serde_json::from_str(&super::super::prefix_policy("noite", "fleets/shop/"))
                .expect("json");
        let reduced: serde_json::Value = serde_json::from_str(
            &MinioAdmin::rustfs(stub_store("http://rustfs:9000".into()))
                .policy("noite", "fleets/shop/"),
        )
        .expect("json");
        let actions = |v: &serde_json::Value| {
            v["Statement"]
                .as_array()
                .expect("statements")
                .iter()
                .flat_map(|s| s["Action"].as_array().expect("actions").iter().cloned())
                .collect::<Vec<_>>()
        };
        let (full_actions, reduced_actions) = (actions(&full), actions(&reduced));
        assert!(full_actions.contains(&serde_json::json!("s3:CompleteMultipartUpload")));
        assert!(!reduced_actions.contains(&serde_json::json!("s3:CompleteMultipartUpload")));
        assert!(reduced_actions.contains(&serde_json::json!("s3:ListBucketMultipartUploads")));
        assert_eq!(
            reduced_actions.len() + 1,
            full_actions.len(),
            "only the one action differs"
        );
    }

    async fn status_stub(status: u16) -> (tokio::task::JoinHandle<()>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let body = "<Error><Code>Denied</Code></Error>";
                    let resp = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        (handle, format!("http://127.0.0.1:{}", addr.port()))
    }

    fn stub_admin(endpoint: String) -> MinioAdmin {
        MinioAdmin::minio(stub_store(endpoint))
    }

    /// A store that refuses the keys fails the boot; a store without the
    /// admin API falls back to root. A silent downgrade on wrong keys
    /// would run every fleet with root keys and log only a reason.
    #[tokio::test]
    async fn probe_refused_keys_fail_and_missing_api_falls_back() {
        let (_handle, endpoint) = status_stub(403).await;
        let err = stub_admin(endpoint).probe().await.expect_err("403 fails");
        assert!(
            format!("{err:#}").contains("refused the admin credentials"),
            "{err:#}"
        );
        let (_handle, endpoint) = status_stub(404).await;
        let outcome = stub_admin(endpoint).probe().await.expect("404 probes");
        assert!(outcome.is_err(), "404 means no admin API: {outcome:?}");
    }

    /// A missing user or policy is already revoked: 404, or the store's
    /// `NoSuch*` error codes in the body.
    #[test]
    fn missing_user_or_policy_counts_as_revoked() {
        assert!(is_no_such(404, b""));
        assert!(is_no_such(400, b"<Code>NoSuchKey</Code>"));
        assert!(is_no_such(400, b"<Code>NoSuchEntity</Code>"));
        assert!(!is_no_such(400, b"<Code>AccessDenied</Code>"));
        assert!(!is_no_such(200, b""));
    }

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

    /// Mint then revoke hits the store with the exact policy name mint
    /// created: a per-key name, so no scope leaves an orphaned policy.
    #[tokio::test]
    async fn revoke_removes_the_policy_mint_created() {
        use std::sync::{Arc, Mutex};
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let seen = calls.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let seen = seen.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let line = req.lines().next().unwrap_or_default().to_string();
                    seen.lock().expect("calls lock").push(line);
                    let resp = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let store = StoreAccess {
            endpoint: format!("http://127.0.0.1:{}", addr.port()),
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let provider = MinioAdmin::minio(store);
        let minted = provider.mint("noite", "fleets/shop/").await.expect("mint");
        provider.revoke(&minted.handle).await.expect("revoke");
        handle.abort();
        let calls = calls.lock().expect("calls lock");
        let created = calls
            .iter()
            .find(|l| l.contains("add-canned-policy"))
            .expect("policy created");
        let created_name = created
            .split("name=")
            .nth(1)
            .expect("policy name")
            .split_whitespace()
            .next()
            .expect("policy name end");
        let removed = calls
            .iter()
            .find(|l| l.contains("remove-canned-policy"))
            .expect("policy removed");
        assert!(
            removed.contains(created_name),
            "revoke deletes {created_name}, the policy mint created: {removed}"
        );
        // And the name is per key: the access key, not the prefix.
        assert!(
            created_name.contains(&minted.access_key),
            "policy name derives from the key: {created_name}"
        );
    }
}
