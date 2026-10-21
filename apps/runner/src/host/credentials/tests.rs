//! Lifecycle tests with an injectable provider (no store, no network).
//!
//! A `FakeProvider` records mints and revokes in memory, so every lifecycle
//! rule is observable: create mints once, rename/delete/environment revoke at
//! the provider, and fleet env carries the scoped key — never root.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;

use super::{
    decrypt, encrypt, ensure, fleet_credentials, prefix_policy, revoke_app, revoke_environment,
    sweep, tenant_process_credentials, AppCredentials, CredentialProvider, Credentials, MintedKey,
    ProviderSetting, Scope, StoreAccess,
};
use crate::config::{config_for_tests, Config, Tenancy};
use crate::db;

#[derive(Debug, Default)]
struct FakeState {
    minted: Vec<(String, String)>,
    revoked: Vec<String>,
    fail_mint: bool,
    fail_revoke: bool,
    next: u64,
}

#[derive(Clone, Debug)]
struct FakeProvider {
    state: Arc<Mutex<FakeState>>,
}

impl FakeProvider {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(FakeState::default())),
        }
    }

    fn mint_count(&self) -> usize {
        self.state.lock().expect("fake lock").minted.len()
    }

    fn revoked(&self) -> Vec<String> {
        self.state.lock().expect("fake lock").revoked.clone()
    }
}

impl CredentialProvider for FakeProvider {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn mint<'a>(
        &'a self,
        bucket: &'a str,
        prefix: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<MintedKey>> {
        Box::pin(async move {
            let mut state = self.state.lock().expect("fake lock");
            if state.fail_mint {
                return Err(anyhow::anyhow!("mint refused"));
            }
            state.next += 1;
            let n = state.next;
            state.minted.push((bucket.to_string(), prefix.to_string()));
            Ok(MintedKey {
                handle: format!("user-{n}"),
                access_key: format!("AK-{n}-{prefix}"),
                secret_key: format!("SK-{n}"),
            })
        })
    }

    fn revoke<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
        let handle = handle.to_string();
        Box::pin(async move {
            let mut state = self.state.lock().expect("fake lock");
            if state.fail_revoke {
                return Err(anyhow::anyhow!("revoke refused"));
            }
            state.revoked.push(handle);
            Ok(())
        })
    }
}

fn test_config(provider: FakeProvider) -> (Config, FakeProvider) {
    let mut cfg = config_for_tests();
    cfg.credentials = Credentials::Scoped(Arc::new(provider.clone()));
    (cfg, provider)
}

fn app_scope() -> Scope {
    Scope::App {
        app_id: "app-1".into(),
        slug: "shop".into(),
    }
}

fn env_scope() -> Scope {
    Scope::Environment {
        env_id: "env-1".into(),
        app_id: "app-1".into(),
        slug: "shop".into(),
        label: "preview".into(),
    }
}

async fn memory_db() -> sqlx::SqlitePool {
    let pool = crate::db::connect("sqlite::memory:")
        .await
        .expect("memory db");
    sqlx::query(include_str!("../../../schema.sql"))
        .execute(&pool)
        .await
        .expect("test schema");
    pool
}

/// Create mints once; the second call reuses the stored row without
/// touching the provider.
#[tokio::test]
async fn create_mints_once_then_reuses() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    let first = ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("mint");
    assert_eq!(provider.mint_count(), 1);
    assert!(first.access_key.contains("fleets/shop/"));
    let second = ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("reuse");
    assert_eq!(provider.mint_count(), 1);
    assert_eq!(first, second);
    pool.close().await;
}

/// Fleet env carries the scoped key; the environment prefix never reaches
/// production's and the two scopes hold different keys.
#[tokio::test]
async fn fleet_and_environment_keys_are_scoped_apart() {
    let pool = memory_db().await;
    let (cfg, _) = test_config(FakeProvider::new());
    let app = fleet_credentials(&pool, &cfg, &app_scope())
        .await
        .expect("app key");
    let env = fleet_credentials(&pool, &cfg, &env_scope())
        .await
        .expect("env key");
    assert!(app.access_key.contains("fleets/shop/"));
    assert!(env.access_key.contains("envs/shop/preview/"));
    assert_ne!(app.access_key, env.access_key);
    pool.close().await;
}

/// Rename (prefix moved) supersedes the row: the next call mints a fresh
/// key and the old one is revoked at the provider.
#[tokio::test]
async fn rename_mints_fresh_and_revokes_old() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    let before = ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("mint");
    // The slug moved: the stored prefix no longer matches.
    revoke_app(&pool, &cfg, "app-1").await.expect("revoke");
    assert_eq!(provider.revoked(), vec!["user-1".to_string()]);
    let renamed = Scope::App {
        app_id: "app-1".into(),
        slug: "store".into(),
    };
    let after = ensure(&pool, &cfg, &provider, &renamed)
        .await
        .expect("re-mint");
    assert_ne!(before.access_key, after.access_key);
    assert!(after.access_key.contains("fleets/store/"));
    assert_eq!(provider.mint_count(), 2);
    pool.close().await;
}

/// Delete revokes the app's key and every environment key; the sweep
/// retries a refused store delete and succeeds on the next pass.
#[tokio::test]
async fn delete_revokes_app_and_environments_with_retry() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("app mint");
    ensure(&pool, &cfg, &provider, &env_scope())
        .await
        .expect("env mint");
    provider.state.lock().expect("fake lock").fail_revoke = true;
    revoke_app(&pool, &cfg, "app-1").await.expect("revoke");
    assert!(provider.revoked().is_empty());
    assert_eq!(sweep(&pool, &cfg).await, 2);
    provider.state.lock().expect("fake lock").fail_revoke = false;
    assert_eq!(sweep(&pool, &cfg).await, 0);
    assert_eq!(provider.revoked().len(), 2);
    pool.close().await;
}

/// Environment teardown revokes only the environment key; the app key
/// stays live.
#[tokio::test]
async fn environment_teardown_revokes_only_its_key() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("app mint");
    ensure(&pool, &cfg, &provider, &env_scope())
        .await
        .expect("env mint");
    revoke_environment(&pool, &cfg, "env-1")
        .await
        .expect("revoke");
    assert_eq!(provider.revoked(), vec!["user-2".to_string()]);
    let app = fleet_credentials(&pool, &cfg, &app_scope())
        .await
        .expect("app key");
    assert!(app.access_key.contains("fleets/shop/"));
    assert_eq!(provider.mint_count(), 2);
    pool.close().await;
}

/// A recreated slug never shares a prefix with an unrevoked key: minting
/// blocks until the pending revoke lands.
#[tokio::test]
async fn recreated_slug_blocks_until_old_key_revoked() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("mint");
    db::mark_scoped_credential_revoking(&pool, "user-1")
        .await
        .expect("mark");
    provider.state.lock().expect("fake lock").fail_revoke = true;
    let blocked = ensure(&pool, &cfg, &provider, &app_scope()).await;
    assert!(
        blocked.is_err(),
        "must not mint over an unrevoked prefix key"
    );
    provider.state.lock().expect("fake lock").fail_revoke = false;
    let fresh = ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("mint after revoke");
    assert!(fresh.access_key.contains("fleets/shop/"));
    pool.close().await;
}

/// A row that no longer decrypts (rotated RUNNER_TOKEN) is superseded, not
/// reused; the unreadable secret is replaced at the next call.
#[tokio::test]
async fn rotated_token_mints_fresh_key() {
    let pool = memory_db().await;
    let (cfg, provider) = test_config(FakeProvider::new());
    ensure(&pool, &cfg, &provider, &app_scope())
        .await
        .expect("mint");
    let mut rotated = cfg.clone();
    rotated.runner_token = "rotated-token".into();
    let fresh = ensure(&pool, &rotated, &provider, &app_scope())
        .await
        .expect("re-mint");
    assert!(fresh.access_key.contains("fleets/shop/"));
    assert_eq!(provider.mint_count(), 2);
    assert_eq!(provider.revoked(), vec!["user-1".to_string()]);
    pool.close().await;
}

/// A provider that hands back the root access key is refused: the write
/// path never stores root keys.
#[tokio::test]
async fn root_key_from_provider_is_refused() {
    struct RootCrook;
    impl CredentialProvider for RootCrook {
        fn name(&self) -> &'static str {
            "crook"
        }
        fn mint<'a>(
            &'a self,
            _bucket: &'a str,
            _prefix: &'a str,
        ) -> BoxFuture<'a, anyhow::Result<MintedKey>> {
            Box::pin(async move {
                Ok(MintedKey {
                    handle: "root".into(),
                    access_key: "key".into(),
                    secret_key: "secret".into(),
                })
            })
        }
        fn revoke<'a>(&'a self, _handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async move { Ok(()) })
        }
    }
    let pool = memory_db().await;
    let mut cfg = config_for_tests();
    cfg.aws_access_key_id = "key".into();
    let err = ensure(&pool, &cfg, &RootCrook, &app_scope())
        .await
        .expect_err("crook mint");
    assert!(format!("{err:#}").contains("root access key"));
    pool.close().await;
}

/// Root mode: fleets keep the root keys exactly as before; release commands
/// run only in `single` tenancy.
#[tokio::test]
async fn root_mode_keeps_root_keys_for_fleets_only_in_single() {
    let pool = memory_db().await;
    let mut single = config_for_tests();
    single.credentials = Credentials::Root {
        reason: "test".into(),
    };
    single.tenancy = Tenancy::Single;
    let fleet = fleet_credentials(&pool, &single, &app_scope())
        .await
        .expect("fleet");
    assert_eq!(fleet.access_key, "key");
    let release = tenant_process_credentials(&pool, &single, &app_scope())
        .await
        .expect("release")
        .expect("single allows root");
    assert_eq!(release.access_key, "key");
    let mut multi = single.clone();
    multi.tenancy = Tenancy::Multi;
    let fleet = fleet_credentials(&pool, &multi, &app_scope())
        .await
        .expect("fleet");
    assert_eq!(fleet.access_key, "key");
    assert!(
        tenant_process_credentials(&pool, &multi, &app_scope())
            .await
            .expect("release")
            .is_none(),
        "multi release runs only with scoped keys"
    );
    pool.close().await;
}

/// The shared policy reaches exactly one prefix: objects under it, a
/// `prefix`-conditioned list, and the location call — no bucket-wide
/// listing, no bucket HEAD.
#[test]
fn prefix_policy_scopes_to_one_prefix() {
    let policy: serde_json::Value =
        serde_json::from_str(&prefix_policy("noite", "fleets/shop/")).expect("valid json");
    let statements = policy["Statement"].as_array().expect("statements");
    assert_eq!(statements.len(), 3);
    let by_sid: HashMap<&str, &serde_json::Value> = statements
        .iter()
        .map(|s| (s["Sid"].as_str().expect("sid"), s))
        .collect();
    let objects = &by_sid["PrefixObjects"];
    assert_eq!(objects["Effect"], "Allow");
    assert_eq!(
        objects["Resource"],
        serde_json::json!(["arn:aws:s3:::noite/fleets/shop/*"])
    );
    let actions: Vec<&str> = objects["Action"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|a| a.as_str().expect("action"))
        .collect();
    assert!(
        !actions.contains(&"s3:ListBucket"),
        "listing is conditioned, not object-scoped"
    );
    let list = &by_sid["PrefixList"];
    assert_eq!(
        list["Condition"]["StringLike"]["s3:prefix"],
        serde_json::json!(["fleets/shop/*"])
    );
    assert_eq!(list["Resource"], serde_json::json!(["arn:aws:s3:::noite"]));
    assert!(by_sid.contains_key("BucketLocation"));
    // Multipart uploads complete under the prefix: the object-level complete
    // call and the bucket-level in-progress listing (under the same prefix
    // condition, so other apps' uploads stay hidden).
    let list_actions: Vec<&str> = list["Action"]
        .as_array()
        .expect("actions")
        .iter()
        .map(|a| a.as_str().expect("action"))
        .collect();
    assert!(actions.contains(&"s3:CompleteMultipartUpload"));
    assert!(list_actions.contains(&"s3:ListBucketMultipartUploads"));
    // The neighbour's prefix and the environment cross-prefix appear nowhere.
    let text = serde_json::to_string(&policy).expect("json");
    assert!(!text.contains("other"));
    assert!(!text.contains("envs/"));
}

/// Secrets never reach logs: `Debug` redacts them on both credential types.
#[test]
fn debug_redacts_secrets() {
    let creds = AppCredentials {
        access_key: "AK".into(),
        secret_key: "TOPSECRET".into(),
    };
    let minted = MintedKey {
        handle: "user-1".into(),
        access_key: "AK".into(),
        secret_key: "TOPSECRET".into(),
    };
    for rendered in [format!("{creds:?}"), format!("{minted:?}")] {
        assert!(!rendered.contains("TOPSECRET"), "{rendered}");
        assert!(rendered.contains("[redacted]"), "{rendered}");
    }
    assert!(
        format!("{creds:?}").contains("AK"),
        "access key stays visible"
    );
}

/// Encrypted rows round-trip and bind to their scope; a row copied onto
/// another scope refuses to decrypt.
#[test]
fn credential_rows_round_trip_and_bind_to_their_scope() {
    let (nonce, ct) = encrypt("token", "app:a", "secret").expect("encrypt");
    assert_eq!(
        decrypt("token", "app:a", &nonce, &ct).expect("decrypt"),
        "secret"
    );
    assert!(decrypt("token", "app:b", &nonce, &ct).is_err());
    let (nonce2, _) = encrypt("token", "app:a", "secret").expect("encrypt");
    assert_ne!(nonce, nonce2);
}

/// The KEK derivation (HKDF-SHA256 `noite-app-credential-v1`) and the
/// AES-GCM shape are unchanged from the pre-scoped implementation, so the
/// golden vector still decrypts. (The associated data is now the scope key,
/// e.g. `app:<id>`; the vector passes the same `app-golden` string as both.)
#[test]
fn kek_and_row_format_are_stable() {
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
    let token = "noite-golden-token-v1";
    let app_id = "app-golden";
    let nonce = unhex("07132a03ff00804009c80b4d");
    let ct = unhex(
        "6aaaffc0eef1009cbfe6f07e917190f41f1acafdb54ef0f955dc09e7199c0016db09be1c3881fc576c35113\
         4c1425e4e17379a205d4ec649be6032a98a4539e67c84",
    );
    let pt = r#"{"access_key":"AKGOLDEN","secret_key":"sk-golden"}"#;
    assert_eq!(
        decrypt(token, app_id, &nonce, &ct).expect("golden decrypt"),
        pt
    );
}

/// `NOITE_CREDENTIAL_PROVIDER` parsing: unset is auto, unknown is a boot
/// problem that keeps the safe default.
#[test]
fn provider_setting_parses_with_problems() {
    let mut problems = Vec::new();
    assert_eq!(
        ProviderSetting::parse(None, &mut problems),
        ProviderSetting::Auto
    );
    assert_eq!(
        ProviderSetting::parse(Some(""), &mut problems),
        ProviderSetting::Auto
    );
    assert_eq!(
        ProviderSetting::parse(Some("minio"), &mut problems),
        ProviderSetting::Minio
    );
    assert_eq!(
        ProviderSetting::parse(Some("aws"), &mut problems),
        ProviderSetting::Aws
    );
    assert_eq!(
        ProviderSetting::parse(Some("root"), &mut problems),
        ProviderSetting::Root
    );
    assert_eq!(
        ProviderSetting::parse(Some("bogus"), &mut problems),
        ProviderSetting::Auto
    );
    assert_eq!(problems.len(), 1);
    assert!(problems[0].contains("NOITE_CREDENTIAL_PROVIDER"));
}

/// Auto-resolution: the bundled endpoint is scoped, R2 and AWS stay root
/// with the operator action in the reason, anything else waits for the
/// boot probe.
#[test]
fn auto_resolution_matrix() {
    let store = StoreAccess {
        endpoint: "http://rustfs:9000".into(),
        region: "us-east-1".into(),
        access_key: "a".into(),
        secret_key: "b".into(),
    };
    let summary = Credentials::configure(ProviderSetting::Auto, &store).summary();
    assert_eq!(summary, "scoped (rustfs)");
    let mut r2 = store.clone();
    r2.endpoint = "https://abc.r2.cloudflarestorage.com".into();
    let summary = Credentials::configure(ProviderSetting::Auto, &r2).summary();
    assert!(
        summary.starts_with("root ("),
        "R2 has no scoped keys: {summary}"
    );
    let mut aws = store.clone();
    aws.endpoint = "https://s3.us-east-1.amazonaws.com".into();
    let summary = Credentials::configure(ProviderSetting::Auto, &aws).summary();
    assert!(
        summary.contains("NOITE_CREDENTIAL_PROVIDER=aws"),
        "{summary}"
    );
    let mut other = store.clone();
    other.endpoint = "http://minio.internal:9000".into();
    assert_eq!(
        Credentials::configure(ProviderSetting::Auto, &other).summary(),
        "undetected"
    );
    assert_eq!(
        Credentials::configure(ProviderSetting::Root, &other).summary(),
        "root (NOITE_CREDENTIAL_PROVIDER=root)"
    );
    assert!(Credentials::configure(ProviderSetting::Minio, &other).is_scoped());
    assert!(Credentials::configure(ProviderSetting::Aws, &other).is_scoped());
}

/// The store really enforces the minted key: against `rustfs:1.0.3` (the
/// image pin) a scoped key reads and writes its own prefix and is refused
/// another app's prefix and the environment/production cross-prefixes.
/// Runs only with `NOITE_TEST_RUSTFS_ENDPOINT` (a rustfs whose root keys are
/// `NOITE_TEST_RUSTFS_KEYS=access:secret`, defaulting to the compose dev
/// pair): CI's `rust` job provides it as a service container, so a missing
/// endpoint skips instead of failing a laptop run.
#[tokio::test]
async fn scoped_key_enforced_by_rustfs() {
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
    let store = StoreAccess {
        endpoint: endpoint.clone(),
        region: "us-east-1".into(),
        access_key: root_access.clone(),
        secret_key: root_secret.clone(),
    };
    let client = reqwest::Client::new();
    // Signed S3 call with an arbitrary key pair (proves enforcement, not
    // just minting): PUT/GET bodies are small, LIST is one page. Returns the
    // status, body, and the ETag / version-id response headers multipart
    // and versioning assertions need.
    async fn s3(
        client: &reqwest::Client,
        endpoint: &str,
        keys: (&str, &str),
        method: &str,
        path_qs: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> (u16, String, Option<String>, Option<String>) {
        use sha2::{Digest, Sha256};
        let (path, qs) = path_qs.split_once('?').unwrap_or((path_qs, ""));
        // SigV4 signs `name=` for valueless subresources (`?uploads`,
        // `?versioning`): the raw form signs a different string than the
        // store verifies. Normalize before signing and sending.
        let qs: String = {
            let mut parts: Vec<&str> = qs.split('&').filter(|p| !p.is_empty()).collect();
            parts.sort_unstable();
            parts
                .iter()
                .map(|p| {
                    if p.contains('=') {
                        (*p).to_string()
                    } else {
                        format!("{p}=")
                    }
                })
                .collect::<Vec<_>>()
                .join("&")
        };
        let path_qs = if qs.is_empty() {
            path.to_string()
        } else {
            format!("{path}?{qs}")
        };
        let payload_hash = super::hex_encode(Sha256::digest(body).as_slice());
        let (amz_date, date_stamp) = super::sigv4_now();
        let url = reqwest::Url::parse(endpoint).expect("endpoint");
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().expect("host")),
            None => url.host_str().expect("host").to_string(),
        };
        let auth = super::SigV4 {
            method,
            uri: path,
            query: qs.as_str(),
            host: &host,
            region: "us-east-1",
            service: "s3",
            access_key: keys.0,
            secret_key: keys.1,
            payload_hash: &payload_hash,
            amz_date: &amz_date,
            date_stamp: &date_stamp,
        }
        .authorization();
        let mut req = client
            .request(
                method.parse().expect("method"),
                format!("{endpoint}{path_qs}"),
            )
            .header("x-amz-date", amz_date)
            .header("x-amz-content-sha256", payload_hash)
            .header("authorization", auth);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let resp = req.body(body.to_vec()).send().await.expect("s3 call");
        let status = resp.status().as_u16();
        let etag = resp
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let version = resp
            .headers()
            .get("x-amz-version-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = resp.text().await.unwrap_or_default();
        (status, text, etag, version)
    }

    fn tag(text: &str, name: &str) -> Option<String> {
        let open = format!("<{name}>");
        let close = format!("</{name}>");
        let start = text.find(&open)? + open.len();
        let end = text[start..].find(&close)?;
        Some(text[start..start + end].to_string())
    }
    let bucket = format!("noite-scope-test-{}", std::process::id());
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&root_access, &root_secret),
        "PUT",
        &format!("/{bucket}"),
        &[],
        b"",
    )
    .await;
    assert!((200..300).contains(&status), "mkbucket: {status}");
    let provider = super::MinioAdmin::rustfs(store);
    let minted = provider.mint(&bucket, "fleets/shop/").await.expect("mint");
    let (access, secret) = (minted.access_key.clone(), minted.secret_key.clone());
    // Its own prefix: write, read, list.
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "PUT",
        &format!("/{bucket}/fleets/shop/a.txt"),
        &[],
        b"hi",
    )
    .await;
    assert_eq!(status, 200, "scoped key writes its own prefix");
    let (status, body, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/fleets/shop/a.txt"),
        &[],
        b"",
    )
    .await;
    assert_eq!(
        (status, body.as_str()),
        (200, "hi"),
        "scoped key reads its own prefix"
    );
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/?list-type=2&prefix=fleets%2Fshop%2F"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 200, "scoped key lists its own prefix");
    // Another app, the environment prefix and the bucket root: refused.
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "PUT",
        &format!("/{bucket}/fleets/other/e.txt"),
        &[],
        b"hi",
    )
    .await;
    assert_eq!(status, 403, "scoped key cannot write another app");
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/envs/shop/preview/d.txt"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 403, "app key cannot read the environment prefix");
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/?list-type=2&delimiter=%2F"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 403, "scoped key cannot list the bucket root");
    // The trailing slash is the boundary: `fleets/shop` without it, and the
    // neighbour prefix under a delimiter, are both refused.
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/?list-type=2&prefix=fleets%2Fshop"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 403, "prefix without trailing slash is refused");
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/?delimiter=%2F&list-type=2&prefix=fleets%2Fother%2F"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 403, "neighbour prefix under a delimiter is refused");
    // Copying from outside the prefix is refused even though the destination
    // is inside it.
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "PUT",
        &format!("/{bucket}/fleets/shop/copied.txt"),
        &[(
            "x-amz-copy-source",
            &format!("/{bucket}/fleets/other/secret.txt"),
        )],
        b"",
    )
    .await;
    assert_eq!(status, 403, "copy from outside the prefix is refused");
    // Versioned reads and deletes outside the prefix are refused. The runner
    // enables bucket versioning, so version ids exist here.
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&root_access, &root_secret),
        "PUT",
        &format!("/{bucket}?versioning"),
        &[],
        br#"<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>"#,
    )
    .await;
    assert!((200..300).contains(&status), "enable versioning: {status}");
    let (status, _, _, version) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "PUT",
        &format!("/{bucket}/fleets/shop/v.txt"),
        &[],
        b"v",
    )
    .await;
    assert_eq!(status, 200, "versioned write under the prefix");
    let version = version.expect("version id");
    for (method, path, what) in [
        (
            "GET",
            format!("/{bucket}/fleets/other/x.txt?versionId={version}"),
            "GetObjectVersion",
        ),
        (
            "GET",
            format!("/{bucket}/?prefix=fleets%2Fother%2F&versions="),
            "ListVersions",
        ),
        (
            "DELETE",
            format!("/{bucket}/fleets/other/x.txt?versionId={version}"),
            "DeleteObjectVersion",
        ),
    ] {
        let (status, ..) = s3(
            &client,
            &endpoint,
            (&access, &secret),
            method,
            &path,
            &[],
            b"",
        )
        .await;
        assert_eq!(status, 403, "{what} outside the prefix is refused");
    }
    // A multipart upload completes inside the prefix (the policy's
    // CompleteMultipartUpload + ListBucketMultipartUploadParts exist for
    // exactly this).
    let (status, body, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "POST",
        &format!("/{bucket}/fleets/shop/big.bin?uploads"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 200, "initiate multipart upload: {body}");
    let upload = tag(&body, "UploadId").expect("upload id");
    let (status, _, etag, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "PUT",
        &format!("/{bucket}/fleets/shop/big.bin?partNumber=1&uploadId={upload}"),
        &[],
        b"hello-mpu",
    )
    .await;
    assert_eq!(status, 200, "upload part");
    let etag = etag.expect("part etag");
    let complete = format!(
        "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>{etag}</ETag></Part></CompleteMultipartUpload>"
    );
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "POST",
        &format!("/{bucket}/fleets/shop/big.bin?uploadId={upload}"),
        &[],
        complete.as_bytes(),
    )
    .await;
    assert_eq!(status, 200, "complete multipart upload");
    let (status, body, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/fleets/shop/big.bin"),
        &[],
        b"",
    )
    .await;
    assert_eq!(
        (status, body.as_str()),
        (200, "hello-mpu"),
        "multipart object reads back"
    );
    // Revoked: the store forgets the key entirely.
    provider.revoke(&minted.handle).await.expect("revoke");
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&access, &secret),
        "GET",
        &format!("/{bucket}/fleets/shop/a.txt"),
        &[],
        b"",
    )
    .await;
    assert_ne!(status, 200, "revoked key is refused");
    // Tidy the bucket; the provider rows are the caller's business.
    for key in [
        "fleets/shop/a.txt",
        "fleets/shop/v.txt",
        "fleets/shop/big.bin",
    ] {
        let (status, ..) = s3(
            &client,
            &endpoint,
            (&root_access, &root_secret),
            "DELETE",
            &format!("/{bucket}/{key}"),
            &[],
            b"",
        )
        .await;
        assert!(
            (200..300).contains(&status) || status == 404,
            "cleanup object {key}: {status}"
        );
    }
    // Versioning is on: plain deletes leave versions and delete markers
    // behind, so remove every version of every key before dropping the bucket.
    let (status, body, ..) = s3(
        &client,
        &endpoint,
        (&root_access, &root_secret),
        "GET",
        &format!("/{bucket}/?prefix=fleets%2Fshop%2F&versions="),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 200, "list versions: {body}");
    let mut cleaned = 0;
    for chunk in body
        .split("<Version>")
        .skip(1)
        .chain(body.split("<DeleteMarker>").skip(1))
    {
        let (Some(key), Some(version)) = (tag(chunk, "Key"), tag(chunk, "VersionId")) else {
            continue;
        };
        let (status, ..) = s3(
            &client,
            &endpoint,
            (&root_access, &root_secret),
            "DELETE",
            &format!("/{bucket}/{key}?versionId={version}"),
            &[],
            b"",
        )
        .await;
        assert!(
            (200..300).contains(&status) || status == 404,
            "delete version of {key}: {status}"
        );
        cleaned += 1;
    }
    assert!(cleaned > 0, "expected versioned objects to clean");
    let (status, ..) = s3(
        &client,
        &endpoint,
        (&root_access, &root_secret),
        "DELETE",
        &format!("/{bucket}"),
        &[],
        b"",
    )
    .await;
    assert!((200..300).contains(&status), "cleanup bucket: {status}");
}
