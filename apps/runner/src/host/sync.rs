//! Worker-relayed durability sync (R2 side of the sidecar).
//!
//! In `sidecar_s3` mode the runner's object store is a loopback sidecar the
//! worker cannot see — but the worker CAN fetch this runner, so durability
//! flows through these endpoints instead of direct S3:
//!
//! - `GET /v1/sync/manifest` → `{imported, objects: [{key, etag, size}]}` for
//!   every sidecar key except tenant telemetry (re-derivable, excluded to
//!   keep relay bandwidth proportional to state, not spans).
//!   `?include_telemetry=1` lists telemetry too — the nightly backup's copy
//!   path (telemetry is the only keyspace the relay doesn't carry).
//! - `GET /v1/sync/get?key=` → raw object bytes (bounded).
//! - `POST /v1/sync/put?key=` → store raw body bytes (bounded).
//! - `POST /v1/sync/complete` → end the boot import window; the main server
//!   and reconcile start only after this (or a timeout).
//!
//! Served on a dedicated loopback-facing port (`SYNC_BIND`), separate from
//! the main API, so the boot import window needs no pool, no 503 gating, and
//! no handler changes: the main server simply starts later. Bearer-gated
//! like the rest of the API; the port is only reachable node→container
//! through the owning DO.
use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use crate::config::Config;
use crate::host::cmd;

/// Sync API bind (all interfaces: the node dials the bridge address).
pub const SYNC_BIND: &str = "0.0.0.0:18080";

/// Largest single object the relay moves (bundles + sqlite + fleet files fit
/// with headroom; larger means something is wrong, fail loudly instead of
/// OOMing the runner).
const MAX_SYNC_BYTES: u64 = 512 * 1024 * 1024;

/// Prefixes never relayed: celld OTel telemetry re-derives nothing durable —
/// the watermark now persists in the SQLite snapshot (see `metric_watermark`),
/// so moves resume aggregation instead of resetting it, and the nightly
/// backup copies spans separately. Keep them out of the relay to hold relay
/// bandwidth proportional to state, not spans.
fn relayable(key: &str) -> bool {
    !key.contains("/telemetry/")
}

/// Keys are worker-supplied: reject traversal, absolute paths, and odd bytes.
fn valid_key(key: &str) -> bool {
    if key.is_empty() || key.len() > 1024 || key.starts_with('/') {
        return false;
    }
    if key.split('/').any(|s| s == "..") {
        return false;
    }
    key.chars().all(|c| {
        c.is_ascii_alphanumeric() || "-_.~/".contains(c)
    })
}

#[derive(Clone)]
pub struct SyncState {
    pub cfg: Arc<Config>,
    pub imported: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncObject {
    key: String,
    etag: String,
    size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    imported: bool,
    objects: Vec<SyncObject>,
}

#[derive(Debug, Deserialize)]
struct KeyQuery {
    key: String,
}

async fn require_bearer(
    State(state): State<SyncState>,
    req: axum::extract::Request,
    next: middleware::Next,
) -> Response {
    let expected = state.cfg.runner_token.as_bytes();
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| constant_time_eq::constant_time_eq(t.as_bytes(), expected))
        .unwrap_or(false);
    if !ok {
        return (StatusCode::UNAUTHORIZED, "bearer token required").into_response();
    }
    next.run(req).await
}

#[derive(Debug, Deserialize)]
struct ManifestQuery {
    #[serde(default)]
    include_telemetry: bool,
}

async fn sync_manifest(
    State(state): State<SyncState>,
    Query(query): Query<ManifestQuery>,
) -> impl IntoResponse {
    let json = match cmd::s3_list_prefix(&state.cfg, &state.cfg.s3_bucket, "").await {
        Ok(json) => json,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("sidecar list failed: {e:#}"),
            )
                .into_response();
        }
    };
    let v: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    let mut objects = Vec::new();
    if let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) {
        let entries: Vec<(&str, &serde_json::Value)> = contents
            .iter()
            .filter_map(|o| {
                o.get("Key")
                    .and_then(|k| k.as_str())
                    .map(|k| (k, o))
            })
            .collect();
        for (key, obj) in entries {
            if query.include_telemetry || relayable(key) {
                let etag = obj
                    .get("ETag")
                    .and_then(|e| e.as_str())
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string();
                let size = obj.get("Size").and_then(|s| s.as_i64()).unwrap_or(0);
                objects.push(SyncObject {
                    key: key.to_string(),
                    etag,
                    size,
                });
            }
        }
    }
    axum::Json(Manifest {
        imported: state.imported.load(Ordering::Relaxed),
        objects,
    })
    .into_response()
}

async fn sync_get(
    State(state): State<SyncState>,
    Query(query): Query<KeyQuery>,
) -> impl IntoResponse {
    if !valid_key(&query.key) {
        return (StatusCode::BAD_REQUEST, "invalid key").into_response();
    }
    let tmp = PathBuf::from(&state.cfg.work_dir).join(".sync-get");
    let uri = state.cfg.s3_uri(&query.key);
    if let Err(e) = cmd::s3_cp_download(&state.cfg, &uri, &tmp).await {
        return (
            StatusCode::BAD_GATEWAY,
            format!("sidecar download failed: {e:#}"),
        )
            .into_response();
    }
    let meta = match tokio::fs::metadata(&tmp).await {
        Ok(meta) => meta,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("stat failed: {e}"),
            )
                .into_response();
        }
    };
    if meta.len() > MAX_SYNC_BYTES {
        let _ = tokio::fs::remove_file(&tmp).await;
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "object exceeds relay bound",
        )
            .into_response();
    }
    let bytes = match tokio::fs::read(&tmp).await {
        Ok(bytes) => bytes,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("read failed: {e}"),
            )
                .into_response();
        }
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/octet-stream".parse().unwrap());
    (headers, bytes).into_response()
}

async fn sync_put(
    State(state): State<SyncState>,
    Query(query): Query<KeyQuery>,
    body: Bytes,
) -> impl IntoResponse {
    if !valid_key(&query.key) {
        return (StatusCode::BAD_REQUEST, "invalid key").into_response();
    }
    if body.len() as u64 > MAX_SYNC_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "object exceeds relay bound",
        )
            .into_response();
    }
    let tmp = PathBuf::from(&state.cfg.work_dir).join(".sync-put");
    if let Err(e) = tokio::fs::write(&tmp, &body).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("stage failed: {e}"),
        )
            .into_response();
    }
    let out = match cmd::s3_cp_upload(&state.cfg, &tmp, &query.key).await {
        Ok(()) => axum::Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            format!("sidecar upload failed: {e:#}"),
        )
            .into_response(),
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    out
}

async fn sync_complete(State(state): State<SyncState>) -> impl IntoResponse {
    state.imported.store(true, Ordering::Relaxed);
    tracing::info!("sync import complete; starting main server");
    axum::Json(serde_json::json!({ "ok": true })).into_response()
}

/// Standalone sync router (no pool, no app state): served from boot so the
/// worker can push the snapshot before the main server exists.
pub fn router(state: SyncState) -> Router {
    Router::new()
        .route("/v1/sync/manifest", get(sync_manifest))
        .route("/v1/sync/get", get(sync_get))
        .route("/v1/sync/put", post(sync_put))
        .route("/v1/sync/complete", post(sync_complete))
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(state.clone(), require_bearer))
        .with_state(state)
}

/// Wait for the worker import (or the timeout fallback on fresh boots and
/// non-container targets that never get a push).
pub async fn await_import(
    imported: &Arc<AtomicBool>,
    timeout: Duration,
) {
    let start = tokio::time::Instant::now();
    while !imported.load(Ordering::Relaxed) {
        if start.elapsed() >= timeout {
            tracing::info!("sync import timeout; starting fresh");
            imported.store(true, Ordering::Relaxed);
            return;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
