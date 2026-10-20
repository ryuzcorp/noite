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

pub(crate) const TOKEN: &str = "test-token";

/// Shared by every `crate::api` test module (this one and
/// `super::env_gate_tests`): the same router, state and temp dir.
pub(crate) struct Harness {
    pub(crate) router: axum::Router,
    pub(crate) state: AppState,
    pub(crate) dir: std::path::PathBuf,
}

impl Harness {
    pub(crate) async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("noite-api-tests-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let s3 = crate::testutil::spawn_s3_stub().await;
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

    pub(crate) async fn seed_app(&self, slug: &str) -> crate::models::App {
        self.seed_app_named(slug, slug).await
    }

    pub(crate) async fn seed_app_named(&self, slug: &str, name: &str) -> crate::models::App {
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

    pub(crate) async fn rest(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
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
    pub(crate) async fn rpc(&self, method: &str, params: Value) -> Result<Value, (i64, String)> {
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

    pub(crate) async fn finish(&self) {
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
        .rpc(
            "apps.patch",
            json!({ "id": b.id, "desiredState": "stopped" }),
        )
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
        h.rpc(
            "env.set",
            json!({ "id": "missing", "name": "A", "value": "1" })
        )
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
        h.rpc("apps.rename", json!({ "id": b.id, "slug": "conflict-a" }))
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
        h.rpc(
            "apps.patch",
            json!({ "id": app.id, "desiredState": "bogus" })
        )
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
                h.rpc("domains.add", json!({ "id": app.id, "hostname": hostname }))
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
        .rest(
            "PUT",
            "/v1/admin/telemetry",
            Some(json!({ "enabled": true })),
        )
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

/// `source.bundle` reads a real push mirror at the requested ref, through the
/// REST mirror and the RPC, which must agree.
#[tokio::test]
async fn source_bundle_agrees() {
    let h = Harness::new().await;
    let app = h.seed_app("code-app").await;

    // A push mirror with one commit on `main`.
    let bare = crate::host::git_http::http_bare(&h.state.config, &app.slug);
    let work = h.dir.join("bundle-work");
    std::fs::create_dir_all(work.join("src")).expect("worktree");
    std::fs::write(work.join("src/index.ts"), "export const a = 1;\n").expect("source");
    git(&work, &["init", "-q", "--initial-branch=main", "."]).await;
    git(&work, &["add", "-A"]).await;
    git(&work, &["commit", "-qm", "init"]).await;
    let sha = git(&work, &["rev-parse", "HEAD"]).await.trim().to_string();
    std::fs::create_dir_all(bare.parent().expect("mirror parent")).expect("mirror parent");
    git(
        &h.dir,
        &[
            "init",
            "-q",
            "--bare",
            "--initial-branch=main",
            bare.to_str().expect("mirror path"),
        ],
    )
    .await;
    git(
        &work,
        &[
            "push",
            "-q",
            bare.to_str().expect("mirror path"),
            "main:main",
        ],
    )
    .await;

    let (status, rest) = h
        .rest("GET", &format!("/v1/apps/{}/bundle", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest["sha"], json!(sha));
    assert_eq!(
        rest["files"],
        json!([{ "path": "src/index.ts", "text": "export const a = 1;\n" }])
    );
    assert_eq!(rest["truncated"], json!(false));
    assert_eq!(
        h.rpc("source.bundle", json!({ "id": app.id }))
            .await
            .expect("source.bundle"),
        rest
    );
    // An explicit ref resolves like `source.tree`, and an empty one must not
    // 400 (the UI's "deployed" choice sends no ref at all).
    for query in ["?ref=main", "?ref="] {
        let (status, value) = h
            .rest("GET", &format!("/v1/apps/{}/bundle{query}", app.id), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{query}");
        assert_eq!(value, rest, "{query}");
    }

    h.finish().await;
}

/// A git command in `dir`, panicking with git's output on failure.
async fn git(dir: &std::path::Path, args: &[&str]) -> String {
    crate::host::exec::run_cmd(
        "git",
        args,
        Some(dir),
        &[
            ("GIT_AUTHOR_NAME", "Test"),
            ("GIT_AUTHOR_EMAIL", "test@example.com"),
            ("GIT_COMMITTER_NAME", "Test"),
            ("GIT_COMMITTER_EMAIL", "test@example.com"),
        ],
        std::time::Duration::from_secs(30),
    )
    .await
    .unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
}

/// Seed one preview environment of `app` directly (no mirror needed).
async fn seed_env(
    h: &Harness,
    app: &crate::models::App,
    label: &str,
    kind: crate::models::EnvironmentKind,
    git_ref: &str,
) -> crate::models::Environment {
    crate::db::create_environment(
        &h.state.pool,
        &h.state.config,
        crate::db::NewEnvironment {
            app_id: &app.id,
            slug: &app.slug,
            label,
            kind,
            git_ref,
            created_by: "user_1",
            listen: 31000,
            internal: 31001,
        },
    )
    .await
    .expect("seed environment")
}

/// An environment deploy someone is watching (its "queued" row already
/// exists) waits out the app's in-flight production deploy instead of failing
/// as skipped: creating an environment while production builds used to leave
/// it `failed` with nothing deployed.
#[tokio::test]
async fn a_watched_environment_deploy_waits_for_the_apps_other_deploy() {
    let h = Harness::new().await;
    let app = h.seed_app("env-wait").await;
    let env = seed_env(
        &h,
        &app,
        "feature",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/feature",
    )
    .await;
    let deploy_id = crate::db::upsert_deploy(
        &h.state.pool,
        None,
        &app.id,
        Some(&env.id),
        "building",
        Some("0123456789abcdef0123456789abcdef01234567"),
        "▸ queued\n",
    )
    .await
    .expect("queued row");
    // Production holds the app's lock.
    assert!(crate::host::deploy::claim(&h.state.deploying, &app.id).await);
    let state = h.state.clone();
    let (task_app, task_id) = (app.clone(), deploy_id.clone());
    let task = tokio::spawn(async move {
        crate::host::deploy::deploy_app(
            &state.pool,
            &state.config,
            &state.procs,
            &state.logs,
            &state.deploying,
            task_app,
            crate::host::deploy::DeployTarget::Environment(Box::new(env)),
            "git/env-wait/refs/heads/feature/missing.bundle",
            Some("0123456789abcdef0123456789abcdef01234567"),
            crate::host::deploy::DeployTrigger::Explicit,
            Some(&task_id),
        )
        .await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let waiting = crate::db::get_deploy_log(&h.state.pool, &app.id, &deploy_id)
        .await
        .expect("log")
        .expect("row");
    assert!(!task.is_finished(), "the deploy waits for the lock");
    assert!(!waiting.contains("skipped"), "{waiting}");
    // Production ends: the environment's deploy runs (and fails at fetch —
    // there is no bundle here — which is a real attempt, not a skip).
    crate::host::deploy::release(&h.state.deploying, &app.id).await;
    tokio::time::timeout(std::time::Duration::from_secs(30), task)
        .await
        .expect("deploy ran after the lock freed")
        .expect("task");
    let log = crate::db::get_deploy_log(&h.state.pool, &app.id, &deploy_id)
        .await
        .expect("log")
        .expect("row");
    assert!(!log.contains("skipped"), "{log}");
}

/// Environments agree across transports, and the role gates are real: a read
/// needs `view`, toggling public and deleting need `admin`.
#[tokio::test]
async fn environments_agree_and_gate_on_role() {
    let h = Harness::new().await;
    let app = h.seed_app("env-api").await;
    let branch = seed_env(
        &h,
        &app,
        "feature",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/feature",
    )
    .await;

    let (status, rest) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/environments?role=view", app.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let rpc = h
        .rpc("environments.list", json!({ "id": app.id, "role": "view" }))
        .await
        .expect("environments.list");
    assert_eq!(rest, rpc);
    assert_eq!(rest[0]["label"], json!("feature"));
    assert_eq!(rest[0]["kind"], json!("branch"));
    assert_eq!(rest[0]["public"], json!(false));
    assert_eq!(
        rest[0]["fleetBucket"],
        json!(format!(
            "s3://{}/envs/env-api/feature",
            h.state.config.s3_bucket
        ))
    );
    assert_eq!(rest[0]["appSlug"], json!("env-api"));

    // A read without a role is refused (never defaulted to view).
    assert_eq!(
        h.rpc("environments.list", json!({ "id": app.id }))
            .await
            .expect_err("role required")
            .0,
        403
    );

    // Public toggle: admin only.
    let (status, _) = h
        .rest(
            "PATCH",
            &format!("/v1/apps/{}/environments/{}", app.id, branch.id),
            Some(json!({ "public": true })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, updated) = h
        .rest(
            "PATCH",
            &format!("/v1/apps/{}/environments/{}", app.id, branch.id),
            Some(json!({ "public": true, "role": "admin" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["public"], json!(true));

    // Overrides: push may write them, view may read them.
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/environments/{}/env", app.id, branch.id),
            Some(json!({ "name": "SHARED", "value": "env", "role": "view" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/environments/{}/env", app.id, branch.id),
            Some(json!({ "name": "SHARED", "value": "env", "role": "push" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, vars) = h
        .rest(
            "GET",
            &format!(
                "/v1/apps/{}/environments/{}/env?role=view",
                app.id, branch.id
            ),
            None,
        )
        .await;
    assert_eq!(vars[0]["name"], json!("SHARED"));
    assert_eq!(vars[0]["value"], json!("env"));
    assert_eq!(
        h.rpc(
            "environments.vars.get",
            json!({ "id": app.id, "envId": branch.id, "role": "view" }),
        )
        .await
        .expect("vars.get"),
        vars
    );

    // Delete: admin only, and it takes the row with it.
    let (status, _) = h
        .rest(
            "DELETE",
            &format!("/v1/apps/{}/environments/{}?role=push", app.id, branch.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = h
        .rest(
            "DELETE",
            &format!("/v1/apps/{}/environments/{}?role=admin", app.id, branch.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(crate::db::list_environments(&h.state.pool, &app.id)
        .await
        .expect("list")
        .is_empty());
    h.finish().await;
}

/// An environment's deploy history is its own: the app's list stays
/// production-only, and the filter returns the environment's rows.
#[tokio::test]
async fn deploys_filter_by_environment() {
    let h = Harness::new().await;
    let app = h.seed_app("env-deploys").await;
    let env = seed_env(
        &h,
        &app,
        "staging",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/staging",
    )
    .await;
    let pool = &h.state.pool;
    crate::db::upsert_deploy(pool, None, &app.id, None, "success", Some("aaa1111"), "")
        .await
        .expect("production deploy");
    crate::db::upsert_deploy(
        pool,
        None,
        &app.id,
        Some(&env.id),
        "success",
        Some("bbb2222"),
        "",
    )
    .await
    .expect("environment deploy");

    let (_, rest) = h
        .rest("GET", &format!("/v1/apps/{}/deploys", app.id), None)
        .await;
    assert_eq!(rest.as_array().expect("array").len(), 1);
    assert_eq!(rest[0]["sha"], json!("aaa1111"));
    assert_eq!(rest[0]["environmentId"], Value::Null);

    let (_, rest) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/deploys?environmentId={}", app.id, env.id),
            None,
        )
        .await;
    let rpc = h
        .rpc(
            "deploys.list",
            json!({ "id": app.id, "environmentId": env.id }),
        )
        .await
        .expect("deploys.list");
    assert_eq!(rest, rpc);
    assert_eq!(rest[0]["sha"], json!("bbb2222"));
    assert_eq!(rest[0]["environmentId"], json!(env.id));

    // The environment deploy never wrote the app's own pointer: it still
    // carries the production sha, not the preview's.
    let fresh = crate::db::get_app(pool, &app.id)
        .await
        .expect("app")
        .expect("row");
    assert_eq!(fresh.last_deploy_sha.as_deref(), Some("aaa1111"));
    // And the app's production list is empty of environment rows.
    assert!(crate::db::list_deploys(pool, &app.id, None)
        .await
        .expect("list")
        .iter()
        .all(|d| d.environment_id.is_none()));

    // A snapshot of an environment JSON row carries the fields the UI needs.
    let (_, one) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/environments?role=view", app.id),
            None,
        )
        .await;
    assert_eq!(one[0]["desiredState"], json!("running"));
    // The environment's own deploy marked it live at its own sha.
    assert_eq!(one[0]["status"], json!("running"));
    assert_eq!(one[0]["lastDeploySha"], json!("bbb2222"));
    assert_eq!(one[0]["listenPort"], json!(31000));
    h.finish().await;
}

/// Per-app and instance caps are enforced before a row lands, and a workspace
/// preview's label carries its owner.
#[tokio::test]
async fn environment_caps_and_labels() {
    use crate::host::env_label;
    let h = Harness::new().await;
    let app = h.seed_app("env-caps").await;
    assert_eq!(h.state.config.max_environments_per_app, 5);
    for i in 0..5 {
        let label = env_label::unique_label(
            &env_label::sanitize_label(&format!("feature/{i}")),
            &crate::db::list_environments(&h.state.pool, &app.id)
                .await
                .expect("list")
                .iter()
                .map(|e| e.label.clone())
                .collect::<Vec<_>>(),
        );
        seed_env(
            &h,
            &app,
            &label,
            crate::models::EnvironmentKind::Branch,
            &format!("refs/heads/feature/{i}"),
        )
        .await;
    }
    // The cap is what `environments.create` checks; at the limit it refuses
    // with a conflict before any git work.
    let (status, body) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/environments", app.id),
            Some(json!({ "branch": "feature/9", "role": "push" })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    // A workspace preview of the same branch by two users is two labels.
    assert_ne!(
        env_label::workspace_label("feature/x", "user_1"),
        env_label::workspace_label("feature/x", "user_2")
    );
    h.finish().await;
}

/// The hidden-ref plumbing `source.preview` rides on: the ref shape, the
/// publishability rules, and ref-addressed environment lookup (the deploy
/// routing input).
#[tokio::test]
async fn preview_refs_are_hidden_and_ref_routed() {
    use crate::host::{forge, git_http};
    use crate::service::environments;
    let h = Harness::new().await;
    let app = h.seed_app("env-refs").await;
    let git_ref = environments::preview_ref("3f1a9c22-0000-4000-8000-000000000001", "feature/x");
    assert_eq!(
        git_ref, "refs/previews/3f1a9c22-0000-4000-8000-000000000001/feature/x",
        "a UUID survives sanitizing unchanged"
    );
    assert!(git_ref.len() <= 40 + "refs/previews/".len() + "/feature/x".len());
    // An exotic user id cannot escape the ref grammar either.
    let odd = environments::preview_ref("../../etc", "feature/x");
    assert!(forge::publishable_ref(&odd), "{odd}");
    assert!(!odd.contains(".."));
    assert!(forge::publishable_ref(&git_ref));
    assert!(forge::publishable_ref("refs/heads/feature"));
    assert!(!forge::publishable_ref("refs/tags/v1"));
    assert!(!forge::publishable_ref("refs/previews//feature"));
    assert!(git_http::PREVIEW_REF_PREFIX == "refs/previews/");

    let env = seed_env(
        &h,
        &app,
        &environments::preview_ref("user_1", "feature/x"),
        crate::models::EnvironmentKind::Workspace,
        &git_ref,
    )
    .await;
    assert_eq!(env.kind, "workspace");
    // Routing: only the environment that tracks the ref is found.
    let found = crate::db::get_environment_by_ref(&h.state.pool, &app.id, &git_ref)
        .await
        .expect("lookup")
        .expect("row");
    assert_eq!(found.id, env.id);
    assert!(crate::db::get_environment_by_ref(
        &h.state.pool,
        &app.id,
        "refs/previews/other/feature/x"
    )
    .await
    .expect("lookup")
    .is_none());
    h.finish().await;
}

/// Live logs follow the deploy target: the app's own ring by default, one
/// environment's ring when asked (and never production's lines), and an
/// environment of another app is a 404 rather than that app's slug key.
#[tokio::test]
async fn logs_scope_to_environment() {
    let h = Harness::new().await;
    let app = h.seed_app("env-logs").await;
    let env = seed_env(
        &h,
        &app,
        "staging",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/staging",
    )
    .await;
    // A sibling app with its own environment: its ring key must not cross.
    let other = h.seed_app("other-logs").await;
    let other_env = seed_env(
        &h,
        &other,
        "staging",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/staging",
    )
    .await;

    crate::host::logs::append(&h.state.logs, &app.slug, "prod line".into()).await;
    crate::host::logs::append(
        &h.state.logs,
        &crate::host::supervisor::env_fleet_key(&app.slug, &env.label),
        "env line".into(),
    )
    .await;

    let (status, rest) = h
        .rest("GET", &format!("/v1/apps/{}/logs", app.id), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest, json!(["prod line"]));

    let (status, rest) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/logs?environmentId={}", app.id, env.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rest, json!(["env line"]));
    assert_eq!(
        h.rpc("logs.get", json!({ "id": app.id, "environmentId": env.id }))
            .await
            .expect("logs.get"),
        rest
    );

    // Another app's environment is a 404, never its own (or production's) key.
    let (status, _) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/logs?environmentId={}", app.id, other_env.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // An unknown environment is a 404 too.
    let (status, _) = h
        .rest(
            "GET",
            &format!("/v1/apps/{}/logs?environmentId=nope", app.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    h.finish().await;
}

/// An SSE response body read frame by frame (keep-alive comments skipped).
struct SseReader {
    body: axum::body::BodyDataStream,
    buf: String,
}

impl SseReader {
    /// The next `data:` frame as JSON, within 10 s.
    async fn next_json(&mut self) -> Value {
        use futures::StreamExt;
        loop {
            while let Some(end) = self.buf.find("\n\n") {
                let event: String = self.buf.drain(..end + 2).collect();
                let data: Vec<&str> = event
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .map(str::trim_start)
                    .collect();
                if !data.is_empty() {
                    return serde_json::from_str(&data.join("\n")).expect("json frame");
                }
            }
            let chunk = tokio::time::timeout(std::time::Duration::from_secs(10), self.body.next())
                .await
                .expect("a frame within 10 s")
                .expect("stream still open")
                .expect("body chunk");
            self.buf
                .push_str(std::str::from_utf8(&chunk).expect("utf-8 frame"));
        }
    }
}

/// The state stream every status badge follows: the first frame carries the
/// app and its environments, a status change on either sends a fresh frame,
/// and an unknown app is a 404.
#[tokio::test]
async fn the_state_stream_resends_the_app_and_its_environments_on_change() {
    let h = Harness::new().await;
    let app = h.seed_app("state").await;
    let env = seed_env(
        &h,
        &app,
        "feature",
        crate::models::EnvironmentKind::Branch,
        "refs/heads/feature",
    )
    .await;
    let request = Request::builder()
        .uri(format!("/v1/apps/{}/state/stream", app.id))
        .header("authorization", format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .expect("build request");
    let response = h
        .router
        .clone()
        .oneshot(request)
        .await
        .expect("router call");
    assert_eq!(response.status(), StatusCode::OK);
    let mut frames = SseReader {
        body: response.into_body().into_data_stream(),
        buf: String::new(),
    };

    let first = frames.next_json().await;
    assert_eq!(first["app"]["id"], json!(app.id));
    assert_eq!(first["app"]["status"], json!(app.status));
    assert_eq!(first["environments"][0]["id"], json!(env.id));

    crate::db::update_app_status(&h.state.pool, &app.id, "running", None, Some("abc123"))
        .await
        .expect("app status");
    let deployed = frames.next_json().await;
    assert_eq!(deployed["app"]["status"], json!("running"));
    assert_eq!(deployed["app"]["lastDeploySha"], json!("abc123"));

    crate::db::update_environment_status(&h.state.pool, &env.id, "failed", Some("boom"))
        .await
        .expect("environment status");
    let failed = frames.next_json().await;
    assert_eq!(failed["environments"][0]["status"], json!("failed"));

    let (status, _) = h.rest("GET", "/v1/apps/nope/state/stream", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    h.finish().await;
}
