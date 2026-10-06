//! App CRUD + health/readiness (thin adapters over `service::apps`).
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::models::{CreateApp, PatchApp, RenameApp};
use crate::service;
use crate::AppState;

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // Busy when a deploy holds the runner: the control DO extends its idle
    // window on this flag so long builds never sleep mid-flight.
    let busy = !crate::host::deploy::snapshot_claimed(&state.deploying)
        .await
        .is_empty();
    Json(json!({ "busy": busy, "ok": true, "service": "noite-runner" }))
}

/// Readiness for the edge (SPEC, Readiness): 200 only when all hold —
/// first reconcile pass, bucket reachable (head-bucket cached 5 s),
/// multi-tenancy isolation checks passed, the control fleet healthy, Caddy's
/// last config load accepted. Body names the failing ones so one healthcheck
/// fits Compose, Railway, Coolify and Fly.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let mut failing: Vec<String> = Vec::new();
    if !state.ready.load(std::sync::atomic::Ordering::Relaxed) {
        failing.push("reconcile".into());
    }
    // Bucket reachable (HEAD on runner/state/, 2 s timeout, cached 5 s).
    {
        let now = std::time::Instant::now();
        let (ok, detail, at) = state.bucket_ok.read().await.clone();
        if now.duration_since(at).as_secs() >= 5 || !ok {
            let _ = detail;
            // One head-bucket per 5 s: it errors only on transport/auth, which
            // is exactly "unreachable".
            let reachable = bucket_reachable(&state.config).await;
            *state.bucket_ok.write().await = (reachable.0, reachable.1.clone(), now);
            if !reachable.0 {
                failing.push(format!("bucket: {}", reachable.1));
            }
        } else if !ok {
            failing.push(format!("bucket: {detail}"));
        }
    }
    {
        let iso = state.isolation.read().await;
        if iso.blocked {
            failing.push(format!("isolation: {}", iso.detail));
        }
    }
    // Control fleet #0 (absent in the dev image, where vite dev serves it).
    if std::path::Path::new(&state.config.control_bundle_dir).exists() {
        let healthy = reqwest::Client::new()
            .get("http://127.0.0.1:8090/.well-known/celld/health")
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if !healthy {
            failing.push("control: fleet not healthy yet".into());
        }
    }
    {
        let (ok, detail) = crate::host::caddy::admin_status();
        if !ok {
            failing.push(format!("caddy: {detail}"));
        }
    }
    if failing.is_empty() {
        Json(json!({ "ok": true, "service": "noite-runner" })).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "failing": failing })),
        )
            .into_response()
    }
}

async fn bucket_reachable(cfg: &crate::config::Config) -> (bool, String) {
    // One head-bucket per 5 s (cached by the caller): false only on
    // transport/auth failure, which is exactly "unreachable".
    if crate::host::s3::s3_head_bucket(cfg).await {
        (true, String::new())
    } else {
        (false, format!("head-bucket {} unreachable", cfg.s3_bucket))
    }
}

pub async fn list_apps(State(state): State<AppState>) -> impl IntoResponse {
    service::apps::list(&state).await.map(Json)
}

pub async fn create_app(
    State(state): State<AppState>,
    Json(body): Json<CreateApp>,
) -> impl IntoResponse {
    service::apps::create(&state, &body.name, &body.slug, body.user_id.as_deref())
        .await
        .map(|app| (StatusCode::CREATED, Json(app)))
}

pub async fn get_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::apps::get(&state, &id).await.map(Json)
}

pub async fn patch_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchApp>,
) -> impl IntoResponse {
    service::apps::patch(&state, &id, body.desired_state.as_deref())
        .await
        .map(Json)
}

pub async fn rename_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameApp>,
) -> impl IntoResponse {
    service::apps::rename(
        &state,
        &id,
        body.name.as_deref(),
        body.slug.as_deref(),
    )
    .await
    .map(Json)
}

pub async fn delete_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::apps::delete(&state, &id)
        .await
        .map(|()| StatusCode::NO_CONTENT)
}

/// Park an app now (SPEC, Scale to zero), skipping the idle check — the
/// operator's lever, and how tests exercise wake-on-request without waiting
/// out `RUNNER_SLEEP_AFTER_H`. 409 when the app cannot sleep (stopped,
/// undeployed, already asleep, or not running yet).
pub async fn sleep_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match service::apps::sleep(&state, &id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true, "asleep": true }))).into_response(),
        Ok(false) => crate::api_error::ApiError::conflict(
            "app cannot sleep (stopped, undeployed, already asleep or not running)",
        )
        .into_response(),
        Err(e) => e.into_response(),
    }
}
