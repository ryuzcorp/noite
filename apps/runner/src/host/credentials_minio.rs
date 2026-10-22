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
    tag: String,
    client: reqwest::Client,
}

impl MinioAdmin {
    /// The bundled image's own store. `bucket` feeds the install tag (see
    /// [`super::install_tag`]): the tag must survive DB loss, so it derives
    /// from the configured store, never from a row.
    pub fn rustfs(store: StoreAccess, bucket: &str) -> Self {
        Self {
            tag: super::install_tag(&store.endpoint, bucket, &store.region),
            store,
            label: "rustfs",
            client: reqwest::Client::new(),
        }
    }

    /// Any other MinIO-family store (MinIO itself, another RustFS).
    pub fn minio(store: StoreAccess, bucket: &str) -> Self {
        Self {
            tag: super::install_tag(&store.endpoint, bucket, &store.region),
            store,
            label: "minio",
            client: reqwest::Client::new(),
        }
    }

    /// The canned policy a minted key's permissions live under: per key and
    /// per install, so the sweep can require it back. Keys minted before
    /// tags used `noite-<handle>` (no tag); [`CredentialProvider::revoke`]
    /// deletes both names so old-format revokes keep working.
    fn policy_name(&self, handle: &str) -> String {
        format!("noite-{}-{}", self.tag, sanitize(handle))
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

    fn install_tag(&self) -> &str {
        &self.tag
    }

    fn mint<'a>(
        &'a self,
        bucket: &'a str,
        prefix: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<MintedKey>> {
        Box::pin(async move {
            let access_key = format!("noite{}", super::random_key(15));
            let secret_key = super::random_key(40);
            // The policy is named per key and per install, not per prefix:
            // revoke only knows the handle (the access key), so the name it
            // deletes must be derivable from the key alone, and the sweep
            // requires the tag back to tell installs apart.
            let policy_name = self.policy_name(&access_key);
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
            // The tagged name first, then the pre-tag legacy name
            // (`noite-<handle>`): revoke by handle must keep working for
            // keys minted before tags, policy leak included.
            for policy_name in [
                self.policy_name(handle),
                format!("noite-{}", sanitize(handle)),
            ] {
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
            }
            Ok(())
        })
    }

    fn manages(&self, handle: &str) -> bool {
        is_managed_key(handle) && handle != self.store.access_key
    }

    fn list_managed<'a>(&'a self) -> BoxFuture<'a, anyhow::Result<Vec<String>>> {
        Box::pin(async move {
            let (status, body) = self
                .call("GET", "/minio/admin/v3/list-users", "", b"")
                .await?;
            if status != 200 {
                return Err(Self::fail(status, &body, "list-users"));
            }
            // The answer carries secret keys, so the store seals it under
            // our own secret (same framing as `encrypt_admin_payload`).
            let plain = decrypt_admin_payload(&self.store.secret_key, &body)?;
            // The plaintext is a bare `{accessKey: {...}}` map; accept a
            // `{"users": ...}` wrapper too rather than fail the sweep on
            // shape. A key counts as managed only when it has this
            // install's shape AND the map value names exactly the policy
            // minting attaches: a shape-matching key with `consoleAdmin`
            // (or another install's tagged policy) is never listed. Array
            // items carry no policy proof and are skipped for the same
            // reason.
            let json: serde_json::Value = serde_json::from_slice(&plain)?;
            let users = json.get("users").unwrap_or(&json);
            let mut out = Vec::new();
            match users {
                serde_json::Value::Object(map) => {
                    for (handle, value) in map {
                        let policy_matches =
                            value.get("policyName").and_then(serde_json::Value::as_str)
                                == Some(self.policy_name(handle).as_str());
                        if self.manages(handle) && policy_matches {
                            out.push(handle.clone());
                        }
                    }
                }
                serde_json::Value::Array(_) => {}
                _ => {
                    return Err(anyhow::anyhow!("list-users: unexpected shape"));
                }
            }
            Ok(out)
        })
    }
}

/// Whether `handle` names a key this provider could have minted: `noite`
/// plus the 15 random chars [`super::random_key`] produces (a leading
/// lowercase letter, then alphanumerics). Anything else — the operator's
/// root key (`noiteaccess` on bundled installs), foreign users — is never
/// an orphan this sweep may revoke. The configured root key is excluded
/// again in [`MinioAdmin::manages`], in case it ever matches the shape.
fn is_managed_key(handle: &str) -> bool {
    let bytes = handle.as_bytes();
    bytes.len() == 20
        && handle.starts_with("noite")
        && bytes[5].is_ascii_lowercase()
        && bytes[6..].iter().all(|b| b.is_ascii_alphanumeric())
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

/// madmin `DecryptData`: inverse of [`encrypt_admin_payload`]. Responses
/// that carry secrets (`list-users` returns secret keys) arrive in the same
/// `salt | id | nonce | sio-DARE ciphertext` framing, sealed under a key
/// derived from the caller's own secret — which is why only the admin key
/// that listed can read the answer.
pub fn decrypt_admin_payload(secret: &str, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    // `pkg/madmin/encrypt.go`: the id byte selects the KDF — `0x00` is
    // Argon2id (what our own seals carry), `0x02` is PBKDF2-HMAC-SHA256
    // (what RustFS emits; madmin uses it in FIPS mode). The framing is
    // identical either way, and the GCM open below authenticates the body,
    // so the byte only selects the key and gates the shape error.
    if data.len() < 41 + 16 {
        return Err(anyhow::anyhow!("admin payload: unexpected shape"));
    }
    let (salt, rest) = data.split_at(32);
    let key = admin_seal_key(secret, data[32], salt)?;
    let nonce: &[u8; 8] = rest[1..9]
        .try_into()
        .map_err(|_| anyhow::anyhow!("admin payload: unexpected shape"))?;
    let chunk = &rest[9..];
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    // The ad tag is deterministic under the stream nonce, so recompute it
    // and open the final chunk: a wrong key or a corrupt body fails here.
    let mut seq0 = [0u8; 12];
    seq0[..8].copy_from_slice(nonce);
    let tag = cipher
        .encrypt(&Nonce::from(seq0), &[][..])
        .map_err(|_| anyhow::anyhow!("admin payload seal failed"))?;
    let mut ad = vec![0x80u8];
    ad.extend_from_slice(&tag);
    let mut seq1 = [0u8; 12];
    seq1[..8].copy_from_slice(nonce);
    seq1[8] = 1;
    cipher
        .decrypt(
            &Nonce::from(seq1),
            aes_gcm::aead::Payload {
                msg: chunk,
                aad: &ad,
            },
        )
        .map_err(|_| anyhow::anyhow!("admin payload: decrypt failed (wrong key?)"))
}

/// The seal key for a sealed admin payload (`pkg/madmin/encrypt.go`): the
/// id byte selects the KDF. `0x01` (ChaCha20) has no corresponding setup
/// here and is refused rather than guessed.
fn admin_seal_key(secret: &str, id: u8, salt: &[u8]) -> anyhow::Result<[u8; 32]> {
    match id {
        0x00 => Ok(argon2_key(secret, salt)),
        0x02 => Ok(pbkdf2_key(secret, salt)),
        other => Err(anyhow::anyhow!(
            "admin payload: unknown seal id {other:#04x}"
        )),
    }
}

/// PBKDF2-HMAC-SHA256 with 8192 iterations (madmin `pbkdf2Cost`), matching
/// `pbkdf2.Key` for the single block a 32-byte key needs.
fn pbkdf2_key(secret: &str, salt: &[u8]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut block = {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac key");
        mac.update(salt);
        mac.update(&[0, 0, 0, 1]);
        mac.finalize().into_bytes()
    };
    let mut out = block;
    for _ in 1..8192 {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac key");
        mac.update(&block);
        block = mac.finalize().into_bytes();
        for (o, b) in out.iter_mut().zip(block.iter()) {
            *o ^= *b;
        }
    }
    out.into()
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
            &MinioAdmin::rustfs(stub_store("http://rustfs:9000".into()), "noite")
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
        MinioAdmin::minio(stub_store(endpoint), "noite")
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
        let provider = MinioAdmin::minio(store, "noite");
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

    /// Only the mint shape counts as managed: the bundled default root key
    /// (`noiteaccess`) and foreign users are never sweep candidates, while
    /// the real mint shape round-trips.
    #[test]
    fn managed_shape_excludes_root_and_foreign_keys() {
        assert!(is_managed_key("noitea0123456789ABCD"));
        assert!(is_managed_key(&format!(
            "noite{}",
            super::super::random_key(15)
        )));
        assert!(
            !is_managed_key("noiteaccess"),
            "the bundled default root key"
        );
        assert!(!is_managed_key("minioadmin"));
        assert!(!is_managed_key("operator-root"));
        assert!(
            !is_managed_key("noiteA0123456789ABCD"),
            "sixth char is lowercase"
        );
        assert!(!is_managed_key("noitea0123456789ABC"), "too short");
        assert!(!is_managed_key("noitea0123456789ABCDE"), "too long");
        assert!(!is_managed_key("noitea0123456789ABC!"), "not alnum");
    }

    /// `manages` excludes the configured root key even if it ever matched
    /// the mint shape: the store's own admin must never be revoked.
    #[test]
    fn manages_excludes_the_configured_root_key() {
        let root = "noitea0123456789ABCD".to_string();
        let store = StoreAccess {
            endpoint: "http://rustfs:9000".into(),
            region: "us-east-1".into(),
            access_key: root.clone(),
            secret_key: "secret".into(),
        };
        assert!(!MinioAdmin::minio(store, "noite").manages(&root));
    }

    /// `list-users` answers sealed (it carries secret keys): the stub seals
    /// like the store. Only keys with this install's shape AND this
    /// install's attached policy are listed — the operator's root key,
    /// foreign users, a shape-matching key with `consoleAdmin`, and a
    /// shape-matching key with the pre-tag legacy policy are never listed —
    /// while a refused listing is an error (the sweep revokes nothing then).
    #[tokio::test]
    async fn list_users_returns_only_managed_keys() {
        async fn list_stub(
            status: u16,
            body: Vec<u8>,
        ) -> (
            tokio::task::JoinHandle<()>,
            String,
            std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        ) {
            use std::sync::{Arc, Mutex};
            let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let body: Arc<Vec<u8>> = Arc::new(body);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind stub");
            let addr = listener.local_addr().expect("stub addr");
            let seen_task = seen.clone();
            let handle = tokio::spawn(async move {
                loop {
                    let Ok((mut sock, _)) = listener.accept().await else {
                        break;
                    };
                    let seen_task = seen_task.clone();
                    let body = body.clone();
                    tokio::spawn(async move {
                        use tokio::io::{AsyncReadExt, AsyncWriteExt};
                        let mut buf = vec![0u8; 65536];
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                        seen_task
                            .lock()
                            .expect("calls lock")
                            .push(req.lines().next().unwrap_or_default().to_string());
                        let head = format!(
                            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                    });
                }
            });
            (handle, format!("http://127.0.0.1:{}", addr.port()), seen)
        }
        // The tag depends on the stub endpoint, so bind first, then seal a
        // map whose expected policy embeds this install's tag.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let endpoint = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().expect("addr").port()
        );
        let provider = stub_admin(endpoint.clone());
        let own = "noitea0123456789ABCD";
        let plain = serde_json::json!({
            own: {"policyName": provider.policy_name(own), "status": "enabled"},
            "noiteaccess": {"policyName": "consoleAdmin", "status": "enabled"},
            "operator-root": {"policyName": "consoleAdmin", "status": "enabled"},
            "noiteb0123456789ABCD": {"policyName": "consoleAdmin", "status": "enabled"},
            "noitec0123456789ABCD": {"policyName": "noite-noitec0123456789ABCD", "status": "enabled"},
        });
        // The stub seals under the stub secret, like the store seals under
        // the caller's: `stub_store`'s secret is `SK`.
        let sealed =
            encrypt_admin_payload("SK", &serde_json::to_vec(&plain).expect("json")).expect("seal");
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_task = seen.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let seen_task = seen_task.clone();
                let sealed = sealed.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    seen_task
                        .lock()
                        .expect("calls lock")
                        .push(req.lines().next().unwrap_or_default().to_string());
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        sealed.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&sealed).await;
                });
            }
        });
        let listed = provider.list_managed().await.expect("list");
        handle.abort();
        assert_eq!(
            listed,
            vec![own.to_string()],
            "only the key with this install's policy lists: {listed:?}"
        );
        {
            let seen = seen.lock().expect("calls lock");
            assert!(
                seen.iter().any(|l| l.contains("list-users")),
                "lists through list-users: {seen:?}"
            );
        }
        let (_handle, endpoint, _) = list_stub(403, b"denied".to_vec()).await;
        let err = stub_admin(endpoint)
            .list_managed()
            .await
            .expect_err("refused listing");
        assert!(format!("{err:#}").contains("list-users"), "{err:#}");
    }

    /// Revoke by handle deletes the tagged policy and the pre-tag legacy
    /// policy: revoke paths keep working for keys minted before tags.
    #[tokio::test]
    async fn revoke_by_handle_deletes_the_legacy_policy_too() {
        use std::sync::{Arc, Mutex};
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        let seen_task = seen.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let seen_task = seen_task.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let line = req.lines().next().unwrap_or_default().to_string();
                    let query = line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_string();
                    seen_task.lock().expect("seen lock").push(query);
                    let resp = "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        let provider = stub_admin(format!("http://127.0.0.1:{}", addr.port()));
        let legacy = "noitea0123456789ABCD";
        provider.revoke(legacy).await.expect("revoke");
        handle.abort();
        let seen = seen.lock().expect("seen lock");
        assert!(
            seen.iter()
                .any(|q| q.contains("remove-user") && q.contains(legacy)),
            "the user is deleted: {seen:?}"
        );
        for policy in [provider.policy_name(legacy), format!("noite-{legacy}")] {
            assert!(
                seen.iter()
                    .any(|q| q.contains("remove-canned-policy") && q.contains(&policy)),
                "policy {policy} is deleted: {seen:?}"
            );
        }
    }

    /// End to end at the sweep: a stub store shared by two installs (same
    /// endpoint and keys, different buckets, hence different tags) holds
    /// this install's live key (row present), this install's orphan (no
    /// row), the other install's live key, a pre-tag legacy key, and a
    /// privileged shape-matching key. The sweep revokes exactly the orphan.
    #[tokio::test]
    async fn cross_install_sweep_revokes_only_own_orphans() {
        use crate::config::config_for_tests;
        use crate::host::credentials::{orphan_sweep, Credentials};
        use std::sync::Arc;
        let store = || StoreAccess {
            endpoint: String::new(),
            region: "us-east-1".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let endpoint = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().expect("addr").port()
        );
        let mut store_a = store();
        store_a.endpoint.clone_from(&endpoint);
        let store_b = store_a.clone();
        let provider_a = MinioAdmin::minio(store_a, "bucket-a");
        let provider_b = MinioAdmin::minio(store_b, "bucket-b");
        assert_ne!(provider_a.install_tag(), provider_b.install_tag());
        let (own, orphan) = ("noitea0123456789ABCD", "noiteo0123456789ABCD");
        let (live_b, legacy, privileged) = (
            "noiteb0123456789ABCD",
            "noitec0123456789ABCD",
            "noited0123456789ABCD",
        );
        let plain = serde_json::json!({
            own: {"policyName": provider_a.policy_name(own), "status": "enabled"},
            orphan: {"policyName": provider_a.policy_name(orphan), "status": "enabled"},
            live_b: {"policyName": provider_b.policy_name(live_b), "status": "enabled"},
            legacy: {"policyName": format!("noite-{legacy}"), "status": "enabled"},
            privileged: {"policyName": "consoleAdmin", "status": "enabled"},
        });
        let sealed =
            encrypt_admin_payload("SK", &serde_json::to_vec(&plain).expect("json")).expect("seal");
        let removed: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let removed_task = removed.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let removed_task = removed_task.clone();
                let sealed = sealed.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 65536];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let line = req.lines().next().unwrap_or_default().to_string();
                    if line.contains("remove-user") {
                        let key = line
                            .split("accessKey=")
                            .nth(1)
                            .unwrap_or_default()
                            .split_whitespace()
                            .next()
                            .unwrap_or_default()
                            .to_string();
                        removed_task.lock().expect("removed lock").push(key);
                    }
                    let body: &[u8] = if line.contains("list-users") {
                        &sealed
                    } else {
                        b""
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                });
            }
        });
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        sqlx::query(include_str!("../../schema.sql"))
            .execute(&pool)
            .await
            .expect("test schema");
        // This install's live key has a row; everything else rowless.
        let (nonce, ciphertext) = (b"nonce12bytes".as_slice(), b"ct".as_slice());
        crate::db::insert_scoped_credential(
            &pool,
            &crate::db::NewScopedCredential {
                app_id: "app-1",
                ciphertext,
                handle: own,
                nonce,
                prefix: "fleets/shop/",
                scope: "app:app-1",
                store: "test-store",
            },
        )
        .await
        .expect("row");
        let mut cfg = config_for_tests();
        cfg.credentials = Credentials::Scoped(Arc::new(provider_a));
        let report = orphan_sweep(&pool, &cfg).await;
        handle.abort();
        pool.close().await;
        assert!(
            report.error.is_none(),
            "unexpected error: {:?}",
            report.error
        );
        assert_eq!(
            report.listed, 2,
            "only this install's keys list: {report:?}"
        );
        assert_eq!(report.revoked, 1, "exactly the orphan revokes: {report:?}");
        assert_eq!(
            removed.lock().expect("removed lock").as_slice(),
            &[orphan.to_string()],
            "the other install's key, the legacy key and the privileged key survive"
        );
    }

    /// Seal then open round-trips, and the wrong secret fails to open.
    #[test]
    fn admin_payload_seal_open_round_trip() {
        let sealed = encrypt_admin_payload("secret", b"{\"a\":1}").expect("seal");
        assert_eq!(
            decrypt_admin_payload("secret", &sealed).expect("open"),
            b"{\"a\":1}"
        );
        assert!(decrypt_admin_payload("wrong", &sealed).is_err());
        assert!(decrypt_admin_payload("secret", b"{}").is_err());
    }

    /// The PBKDF2 leg matches an independent implementation at the exact
    /// production parameters (HMAC-SHA256, 8192 iterations, 32-byte key;
    /// cross-checked with Python's `hashlib.pbkdf2_hmac`).
    #[test]
    fn pbkdf2_matches_reference_at_production_cost() {
        let hex = |key: [u8; 32]| super::super::hex_encode(&key);
        assert_eq!(
            hex(pbkdf2_key("password", b"salt")),
            "59ac909f3fe671dd3800be131dec3098461a3582419ce121d149f8cf573b6260"
        );
    }

    /// Against real rustfs (the image pin): a minted key shows up in
    /// `list-users`, and the listing never names the operator's root key.
    /// Gated like the lifecycle rustfs test: `NOITE_TEST_RUSTFS_ENDPOINT`.
    #[tokio::test]
    async fn list_users_names_minted_keys_on_real_rustfs() {
        let Some(endpoint) = std::env::var("NOITE_TEST_RUSTFS_ENDPOINT")
            .ok()
            .filter(|v| !v.is_empty())
        else {
            eprintln!("skip: NOITE_TEST_RUSTFS_ENDPOINT unset (CI provides the rustfs service)");
            return;
        };
        let (root_access, root_secret) = match std::env::var("NOITE_TEST_RUSTFS_KEYS").ok() {
            Some(pair) => {
                let (a, s) = pair
                    .split_once(':')
                    .expect("NOITE_TEST_RUSTFS_KEYS is access:secret");
                (a.to_string(), s.to_string())
            }
            None => (
                "noiteaccess".to_string(),
                "noitesecretnoitesecretnoite12".to_string(),
            ),
        };
        let provider = MinioAdmin::rustfs(
            StoreAccess {
                endpoint,
                region: "us-east-1".into(),
                access_key: root_access.clone(),
                secret_key: root_secret,
            },
            "noite",
        );
        let minted = provider
            .mint("noite", "fleets/orphan-sweep-probe/")
            .await
            .expect("mint");
        let listed = provider.list_managed().await.expect("list");
        assert!(
            listed.contains(&minted.access_key),
            "minted key is listed: {listed:?}"
        );
        assert!(
            !listed.contains(&root_access),
            "the root key is never a sweep candidate: {listed:?}"
        );
        provider.revoke(&minted.handle).await.expect("revoke");
        let listed = provider.list_managed().await.expect("list again");
        assert!(
            !listed.contains(&minted.access_key),
            "revoked key is gone: {listed:?}"
        );
    }
}
