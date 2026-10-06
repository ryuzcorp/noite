//! Handler-level REST↔RPC parity tests: drive the real `api::router::router`
//! over a temporary SQLite state and assert both transports (`/v1/...` and
//! `/rpc`) return the same result for the same operation, including the
//! not-found / conflict / validation statuses.
//!
//! S3 is stubbed with an in-process LIST-only server: purge, rename and
//! source-rev resolution answer "nothing there" instead of dialing RustFS.
//! Paths that shell out to celld (storage inventory/D1/R2) or Caddy
//! (`sleep`) are deliberately not exercised here.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::models::new_id;
use crate::AppState;

const TOKEN: &str = "test-token";

/// In-process S3 stand-in: every LIST answers an empty `ListObjectsV2` page,
/// so the S3 side of purge/rename is a no-op. Object bodies and deletes are
/// never reached by these tests (empty listings short-circuit both).
async fn spawn_s3_stub() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind s3 stub");
    let addr = listener.local_addr().expect("stub addr");
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let body = concat!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                    "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                    "<Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                    "</ListBucketResult>"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

struct Harness {
    router: axum::Router,
    state: AppState,
    dir: std::path::PathBuf,
}

impl Harness {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("noite-api-tests-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let s3 = spawn_s3_stub().await;
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.s3_endpoint = s3.clone();
        cfg.s3_public_endpoint = s3;
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        cfg.caddyfile_path = dir.join("Caddyfile").to_string_lossy().into_owned();
        cfg.caddy_access_log = dir.join("access.log").to_string_lossy().into_owned();
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        let state = AppState {
            pool,
            config,
            procs: crate::host::supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify,
            git_sync: crate::host::git_manifest::GitSync::default(),
            tip_tx,
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
        };
        let router = crate::api::router::router(state.clone());
        Self { router, state, dir }
    }

    async fn seed_app(&self, slug: &str) -> crate::models::App {
        self.seed_app_named(slug, slug).await
    }

    async fn seed_app_named(&self, slug: &str, name: &str) -> crate::models::App {
        crate::db::create_app(
            &self.state.pool,
            &self.state.config,
            crate::db::NewApp {
                name,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    async fn rest(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("authorization", format!("Bearer {TOKEN}"));
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
        };
        let request = builder.body(body).expect("build request");
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("router call");
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body");
        (status, parse_body(&bytes))
    }

    /// One JSON-RPC call: `Ok(result)` or `Err((code, message))`.
    async fn rpc(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
        let payload = json!({ "id": 1, "jsonrpc": "2.0", "method": method, "params": params });
        let (status, value) = self.rest("POST", "/rpc", Some(payload)).await;
        assert_eq!(status, StatusCode::OK, "rpc {method} transport");
        if let Some(error) = value.get("error") {
            return Err((
                error["code"].as_i64().unwrap_or_default(),
                error["message"].as_str().unwrap_or_default().to_string(),
            ));
        }
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn finish(&self) {
        self.state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn parse_body(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice(bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(bytes).into_owned()))
}

/// Blanks the per-app fields that legitimately differ between two rows
/// (identity, derived bucket/subdomain, allocated ports, timestamps) so two
/// apps seeded with the same name compare equal.
fn normalize_app(mut app: Value) -> Value {
    let Some(obj) = app.as_object_mut() else {
        return app;
    };
    for key in [
        "id",
        "slug",
        "subdomain",
        "gitPrefix",
        "fleetBucket",
        "listenPort",
        "internalPort",
        "createdAt",
        "updatedAt",
    ] {
        if obj.contains_key(key) {
            obj.insert(key.into(), Value::String("<volatile>".into()));
        }
    }
    app
}

#[tokio::test]
async fn apps_create_agrees() {
    let h = Harness::new().await;
    let (status, rest_app) = h
        .rest(
            "POST",
            "/v1/apps",
            Some(json!({ "name": "App", "slug": "rest-app" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(rest_app["slug"], "rest-app");

    let rpc_app = h
        .rpc("apps.create", json!({ "name": "App", "slug": "rpc-app" }))
        .await
        .expect("apps.create");
    assert_eq!(rpc_app["slug"], "rpc-app");
    assert_eq!(normalize_app(rest_app), normalize_app(rpc_app));
    h.finish().await;
}

#[tokio::test]
async fn apps_get_agrees() {
    let h = Harness::new().await;
    let app = h.seed_app("read-app").await;
    let (status, rest_app) = h.rest("GET", &format!("/v1/apps/{}", app.id), None).await;
    assert_eq!(status, StatusCode::OK);
    let rpc_app = h
        .rpc("apps.get", json!({ "id": app.id }))
        .await
        .expect("apps.get");
    assert_eq!(rest_app, rpc_app);
    h.finish().await;
}

#[tokio::test]
async fn apps_patch_agrees() {
    let h = Harness::new().await;
    let a = h.seed_app_named("patch-a", "Patch App").await;
    let b = h.seed_app_named("patch-b", "Patch App").await;

    let (status, rest_app) = h
        .rest(
            "PATCH",
            &format!("/v1/apps/{}", a.id),
            Some(json!({ "desiredState": "stopped" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest_app["desiredState"], "stopped");

    let rpc_app = h
        .rpc("apps.patch", json!({ "id": b.id, "desiredState": "stopped" }))
        .await
        .expect("apps.patch");
    assert_eq!(rpc_app["desiredState"], "stopped");
    assert_eq!(normalize_app(rest_app), normalize_app(rpc_app));
    h.finish().await;
}

#[tokio::test]
async fn apps_rename_agrees() {
    let h = Harness::new().await;
    let a = h.seed_app("rename-a").await;
    let b = h.seed_app("rename-b").await;

    let (status, rest_app) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/rename", a.id),
            Some(json!({ "name": "Renamed", "slug": "rest-renamed" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest_app["slug"], "rest-renamed");

    let rpc_app = h
        .rpc(
            "apps.rename",
            json!({ "id": b.id, "name": "Renamed", "slug": "rpc-renamed" }),
        )
        .await
        .expect("apps.rename");
    assert_eq!(rpc_app["slug"], "rpc-renamed");
    assert_eq!(normalize_app(rest_app), normalize_app(rpc_app));
    h.finish().await;
}

#[tokio::test]
async fn apps_delete_agrees() {
    let h = Harness::new().await;
    let a = h.seed_app("delete-a").await;
    let b = h.seed_app("delete-b").await;

    let (status, body) = h.rest("DELETE", &format!("/v1/apps/{}", a.id), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, Value::Null);

    let rpc_body = h
        .rpc("apps.delete", json!({ "id": b.id }))
        .await
        .expect("apps.delete");
    assert_eq!(rpc_body, json!({ "ok": true }));

    assert!(crate::db::get_app(&h.state.pool, &a.id)
        .await
        .expect("lookup a")
        .is_none());
    assert!(crate::db::get_app(&h.state.pool, &b.id)
        .await
        .expect("lookup b")
        .is_none());
    h.finish().await;
}

#[tokio::test]
async fn domains_agree() {
    let h = Harness::new().await;
    let app = h.seed_app("dom-app").await;

    let (status, listed) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/domains", app.id),
            Some(json!({ "hostname": "one.example.com" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().map(Vec::len), Some(1));
    assert_eq!(
        h.rpc("domains.list", json!({ "id": app.id }))
            .await
            .expect("domains.list"),
        listed
    );

    let added = h
        .rpc(
            "domains.add",
            json!({ "id": app.id, "hostname": "two.example.com" }),
        )
        .await
        .expect("domains.add");
    let (status, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/domains", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest_list, added);

    let (status, after_rest_remove) = h
        .rest(
            "DELETE",
            &format!("/v1/apps/{}/domains/one.example.com", app.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.rpc("domains.list", json!({ "id": app.id }))
            .await
            .expect("domains.list"),
        after_rest_remove
    );

    let after_rpc_remove = h
        .rpc(
            "domains.remove",
            json!({ "id": app.id, "hostname": "two.example.com" }),
        )
        .await
        .expect("domains.remove");
    let (status, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/domains", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest_list, after_rpc_remove);
    h.finish().await;
}

#[tokio::test]
async fn env_agrees() {
    let h = Harness::new().await;
    let app = h.seed_app("env-app").await;

    let (status, set) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/env", app.id),
            Some(json!({ "name": "API_KEY", "value": "1" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(set, json!({ "ok": true, "name": "API_KEY" }));

    let (status, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/env", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.rpc("env.list", json!({ "id": app.id }))
            .await
            .expect("env.list"),
        rest_list
    );

    let _ = h
        .rpc(
            "env.set",
            json!({ "id": app.id, "name": "TOKEN", "value": "2" }),
        )
        .await
        .expect("env.set");
    let (_, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/env", app.id), None)
        .await;
    assert_eq!(
        h.rpc("env.list", json!({ "id": app.id }))
            .await
            .expect("env.list"),
        rest_list
    );

    let _ = h
        .rpc("env.delete", json!({ "id": app.id, "name": "TOKEN" }))
        .await
        .expect("env.delete");
    let (_, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/env", app.id), None)
        .await;
    assert_eq!(
        h.rpc("env.list", json!({ "id": app.id }))
            .await
            .expect("env.list"),
        rest_list
    );

    let (status, _) = h
        .rest("DELETE", &format!("/v1/apps/{}/env/API_KEY", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/env", app.id), None)
        .await;
    assert_eq!(
        h.rpc("env.list", json!({ "id": app.id }))
            .await
            .expect("env.list"),
        rest_list
    );
    h.finish().await;
}

#[tokio::test]
async fn git_remote_agrees_and_drops_the_duplicate_field() {
    let h = Harness::new().await;
    let app = h.seed_app("git-app").await;

    let (status, rest_info) = h
        .rest("POST", &format!("/v1/apps/{}/git-remote", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest_info["url"], "https://git.localhost/git-app");
    assert!(
        rest_info.get("remote").is_none(),
        "`remote` duplicates `url` and must be gone: {rest_info}"
    );

    let rpc_info = h
        .rpc("git.remote", json!({ "id": app.id }))
        .await
        .expect("git.remote");
    assert_eq!(rest_info, rpc_info);
    h.finish().await;
}

#[tokio::test]
async fn not_found_statuses_agree() {
    let h = Harness::new().await;

    let (status, _) = h.rest("GET", "/v1/apps/missing", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        h.rpc("apps.get", json!({ "id": "missing" })).await,
        Err((404, "app not found".into()))
    );

    let (status, _) = h
        .rest(
            "POST",
            "/v1/apps/missing/env",
            Some(json!({ "name": "A", "value": "1" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        h.rpc("env.set", json!({ "id": "missing", "name": "A", "value": "1" }))
            .await,
        Err((404, "app not found".into()))
    );

    let (status, _) = h.rest("DELETE", "/v1/apps/missing", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        h.rpc("apps.delete", json!({ "id": "missing" })).await,
        Err((404, "app not found".into()))
    );
    h.finish().await;
}

#[tokio::test]
async fn conflict_statuses_agree() {
    let h = Harness::new().await;
    let _taken = h.seed_app("taken-slug").await;

    let (status, _) = h
        .rest(
            "POST",
            "/v1/apps",
            Some(json!({ "name": "Other", "slug": "taken-slug" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        h.rpc(
            "apps.create",
            json!({ "name": "Other", "slug": "taken-slug" })
        )
        .await,
        Err((409, "slug already taken".into()))
    );

    let a = h.seed_app("conflict-a").await;
    let b = h.seed_app("conflict-b").await;
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/rename", a.id),
            Some(json!({ "slug": "conflict-b" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        h.rpc(
            "apps.rename",
            json!({ "id": b.id, "slug": "conflict-a" })
        )
        .await,
        Err((409, "slug already taken".into()))
    );

    // A hostname belongs to exactly one app.
    let _ = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/domains", a.id),
            Some(json!({ "hostname": "shared.example.com" })),
        )
        .await;
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/domains", b.id),
            Some(json!({ "hostname": "shared.example.com" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(matches!(
        h.rpc(
            "domains.add",
            json!({ "id": b.id, "hostname": "shared.example.com" })
        )
        .await,
        Err((409, _))
    ));
    h.finish().await;
}

#[tokio::test]
async fn validation_statuses_agree() {
    let h = Harness::new().await;
    let app = h.seed_app("valid-app").await;

    // Invalid create slug.
    let (status, _) = h
        .rest(
            "POST",
            "/v1/apps",
            Some(json!({ "name": "x", "slug": "Bad Slug" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.rpc("apps.create", json!({ "name": "x", "slug": "Bad Slug" }))
            .await,
        Err((400, "invalid name/slug".into()))
    );

    // Invalid desired state.
    let (status, _) = h
        .rest(
            "PATCH",
            &format!("/v1/apps/{}", app.id),
            Some(json!({ "desiredState": "bogus" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.rpc("apps.patch", json!({ "id": app.id, "desiredState": "bogus" }))
            .await,
        Err((400, "desiredState must be running|stopped".into()))
    );

    // Rename needs at least one field.
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/rename", app.id),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        h.rpc("apps.rename", json!({ "id": app.id })).await,
        Err((400, "name or slug required".into()))
    );

    // Env name grammar.
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/env", app.id),
            Some(json!({ "name": "1bad", "value": "x" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(matches!(
        h.rpc(
            "env.set",
            json!({ "id": app.id, "name": "1bad", "value": "x" })
        )
        .await,
        Err((400, _))
    ));

    // Hostname grammar, then a platform hostname.
    for hostname in ["bad host", "app.localhost"] {
        let (status, _) = h
            .rest(
                "POST",
                &format!("/v1/apps/{}/domains", app.id),
                Some(json!({ "hostname": hostname })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "rest {hostname}");
        assert!(
            matches!(
                h.rpc(
                    "domains.add",
                    json!({ "id": app.id, "hostname": hostname })
                )
                .await,
                Err((400, _))
            ),
            "rpc {hostname}"
        );
    }
    h.finish().await;
}

#[tokio::test]
async fn patch_rejects_unknown_keys_on_both_transports() {
    let h = Harness::new().await;
    let app = h.seed_app("strict-patch").await;

    // A misspelled key must never silently no-op (it did on REST before).
    let (rest_status, _) = h
        .rest(
            "PATCH",
            &format!("/v1/apps/{}", app.id),
            Some(json!({ "desiredState": "stopped", "desired_state": "stopped" })),
        )
        .await;
    assert!(
        rest_status.is_client_error(),
        "REST must reject unknown patch keys, got {rest_status}"
    );
    assert!(
        h.rpc(
            "apps.patch",
            json!({ "id": app.id, "desiredState": "stopped", "extra": true })
        )
        .await
        .is_err(),
        "RPC must reject unknown patch keys"
    );

    // The stored state is untouched by the rejected requests.
    let stored = crate::db::get_app(&h.state.pool, &app.id)
        .await
        .expect("lookup")
        .expect("app");
    assert_eq!(stored.desired_state, "running");
    h.finish().await;
}

#[tokio::test]
async fn deploys_list_agrees() {
    let h = Harness::new().await;
    let app = h.seed_app("deploys-app").await;
    let (status, rest_list) = h
        .rest("GET", &format!("/v1/apps/{}/deploys", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        h.rpc("deploys.list", json!({ "id": app.id }))
            .await
            .expect("deploys.list"),
        rest_list
    );
    h.finish().await;
}

#[tokio::test]
async fn source_without_a_mirror_is_not_found_on_both_transports() {
    let h = Harness::new().await;
    let app = h.seed_app("source-app").await;

    let (status, _) = h
        .rest("GET", &format!("/v1/apps/{}/tree", app.id), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(matches!(
        h.rpc("source.tree", json!({ "id": app.id })).await,
        Err((404, _))
    ));
    assert_eq!(
        h.rpc("source.tree", json!({ "id": "missing" })).await,
        Err((404, "app not found".into()))
    );
    h.finish().await;
}

/// Blanks the volatile preview timestamp: each status call builds the payload
/// at its own `now`.
fn normalize_telemetry(mut value: Value) -> Value {
    if let Some(ts) = value
        .get_mut("preview")
        .and_then(|preview| preview.get_mut("timestamp"))
    {
        *ts = Value::String("<volatile>".into());
    }
    value
}

/// Instance telemetry over both transports: same status, the kill switch locks
/// the effective state while the stored preference still moves (the test
/// harness runs on `localhost`, a local domain), and the preview is the
/// contract payload.
#[tokio::test]
async fn telemetry_status_agrees() {
    let h = Harness::new().await;

    let (status, rest) = h.rest("GET", "/v1/admin/telemetry", None).await;
    assert_eq!(status, StatusCode::OK);
    let rpc = h
        .rpc("telemetry.get", json!({}))
        .await
        .expect("telemetry.get");
    assert_eq!(
        normalize_telemetry(rest.clone()),
        normalize_telemetry(rpc),
        "REST and RPC must agree"
    );

    // localhost is a local domain: locked off, preference still on.
    assert_eq!(rest["enabled"], json!(false));
    assert_eq!(rest["setting"], json!(true));
    assert_eq!(rest["locked"], json!(true));
    assert_eq!(rest["lockReason"], json!("local domain"));
    assert!(rest["lastSentAt"].is_null());

    let install_id = rest["installId"].as_str().unwrap_or_default();
    assert!(!install_id.is_empty(), "install id is bootstrapped");
    assert_eq!(rest["preview"]["event"], json!("instance_heartbeat"));
    assert_eq!(rest["preview"]["distinct_id"], json!(install_id));
    assert_eq!(rest["preview"]["properties"]["$geoip_disable"], json!(true));
    assert_eq!(
        rest["preview"]["properties"]["$process_person_profile"],
        json!(false)
    );
    assert!(!rest["preview"]["api_key"]
        .as_str()
        .unwrap_or_default()
        .is_empty());
    let users = rest["preview"]["properties"]["users"]
        .as_str()
        .unwrap_or_default();
    assert!(
        matches!(users, "1" | "2-5" | "6-20" | "21+" | "unknown"),
        "{users}"
    );

    // The preference moves through either transport while the lock holds.
    let (status, put) = h
        .rest("PUT", "/v1/admin/telemetry", Some(json!({ "enabled": true })))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(put["setting"], json!(true));
    assert_eq!(put["enabled"], json!(false), "still locked");

    let rpc = h
        .rpc("telemetry.set", json!({ "enabled": false }))
        .await
        .expect("telemetry.set");
    assert_eq!(rpc["setting"], json!(false));
    let (status, rest) = h.rest("GET", "/v1/admin/telemetry", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest["setting"], json!(false));
    assert_eq!(
        crate::db::get_setting(&h.state.pool, crate::db::TELEMETRY_ENABLED)
            .await
            .expect("read setting"),
        Some("0".to_string())
    );
    h.finish().await;
}
