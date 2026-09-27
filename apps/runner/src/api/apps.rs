//! App CRUD + health/readiness.
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::host::deploy;
use crate::host::purge;
use crate::lifecycle::slug_ok;
use crate::models::{CreateApp, DesiredState, PatchApp, RenameApp};
use crate::AppState;

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // Busy when a deploy holds the runner: the control DO extends its idle
    // window on this flag so long builds never sleep mid-flight.
    let busy = !crate::host::deploy::snapshot_claimed(&state.deploying).await.is_empty();
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
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false, "failing": failing })))
            .into_response()
    }
}

async fn bucket_reachable(cfg: &crate::config::Config) -> (bool, String) {
    let env_owned = crate::host::cmd::aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    match crate::host::cmd::run_cmd(
        "aws",
        &["--endpoint-url", &cfg.s3_endpoint, "s3api", "head-bucket", "--bucket", &cfg.s3_bucket],
        None,
        &env,
        std::time::Duration::from_secs(2),
    )
    .await
    {
        Ok(_) => (true, String::new()),
        Err(e) => (false, format!("{e:#}")),
    }
}

pub async fn list_apps(State(state): State<AppState>) -> impl IntoResponse {
    match db::list_apps(&state.pool).await {
        Ok(apps) => Json(apps).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn create_app(
    State(state): State<AppState>,
    Json(body): Json<CreateApp>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    let slug = body.slug.trim().to_lowercase();
    if name.is_empty() || !slug_ok(&slug) {
        return ApiError::bad("invalid name/slug").into_response();
    }
    match db::get_app_by_slug(&state.pool, &slug).await {
        Ok(Some(_)) => {
            return ApiError::conflict("slug already taken").into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return ApiError::internal(e.to_string()).into_response();
        }
    }
    // Always wipe leftover S3/local data for this slug before the new row lands.
    if let Err(e) = purge::purge_slug(&state.config, &state.procs, &state.logs, &slug).await {
        return ApiError::internal(format!("failed to clear slug data: {e:#}")).into_response();
    }
    let (listen, internal) = match db::next_ports_in(&state.pool, state.config.fleet_port_min, state.config.fleet_port_max).await {
        Ok(p) => p,
        Err(e) => {
            return ApiError::internal(e.to_string()).into_response();
        }
    };
    let subdomain = format!("{slug}.{}", state.config.base_domain);
    let owner = body
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local");
    if owner != "local" {
        match db::count_apps_for_user(&state.pool, owner).await {
            Ok(count) if count >= i64::from(state.config.max_apps_per_user) => {
                return ApiError::conflict(format!(
                    "app limit reached ({} per account)",
                    state.config.max_apps_per_user
                ))
                .into_response();
            }
            Ok(_) => {}
            Err(e) => return ApiError::internal(e.to_string()).into_response(),
        }
    }
    match db::create_app(
        &state.pool,
        &state.config,
        db::NewApp {
            internal,
            listen,
            name: &name,
            slug: &slug,
            subdomain: &subdomain,
            user_id: owner,
        },
    )
    .await {
        Ok(app) => {
            // No credential row: only a scoped provider (Phase 4) mints one.
            state.state_sync.mark_dirty();
            (StatusCode::CREATED, Json(app)).into_response()
        }
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}


pub async fn get_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => Json(app).into_response(),
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn patch_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchApp>,
) -> impl IntoResponse {
    if let Some(desired) = body.desired_state.as_deref() {
        let Some(ds) = DesiredState::parse(desired) else {
            return ApiError::bad("desiredState must be running|stopped").into_response();
        };
        if let Err(e) = db::patch_app_desired(&state.pool, &id, ds.as_str()).await {
            return ApiError::internal(e.to_string()).into_response();
        }
    }
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => Json(app).into_response(),
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn rename_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameApp>,
) -> impl IntoResponse {
    let name = body.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let slug = body
        .slug
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if name.is_none() && slug.is_none() {
        return ApiError::bad("name or slug required").into_response();
    }
    if let Some(ref s) = slug {
        if !slug_ok(s) {
            return ApiError::bad("invalid slug").into_response();
        }
        match db::get_app_by_slug(&state.pool, s).await {
            Ok(Some(other)) if other.id != id => {
                return ApiError::conflict("slug already taken").into_response()
            }
            Ok(_) => {}
            Err(e) => return ApiError::internal(e.to_string()).into_response(),
        }
    }
    match crate::host::rename::rename_app(
        &state.config,
        &state.pool,
        &state.procs,
        &state.logs,
        &state.deploying,
        &id,
        name.as_deref(),
        slug.as_deref(),
    )
    .await
    {
        Ok(app) => Json(app).into_response(),
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("deploy in flight") {
                ApiError::conflict(msg).into_response()
            } else if msg.contains("invalid slug") || msg.contains("app not found") {
                ApiError::bad(msg).into_response()
            } else {
                ApiError::internal(msg).into_response()
            }
        }
    }
}

pub async fn delete_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };

    // Same lock as deploy: wait out an in-flight build, then purge exclusively.
    if !deploy::claim_wait(&state.deploying, &app.id, Duration::from_secs(120)).await {
        return ApiError::conflict("deploy in flight; retry delete shortly").into_response();
    }
    let purge_result =
        purge::purge_slug(&state.config, &state.procs, &state.logs, &app.slug).await;
    deploy::release(&state.deploying, &app.id).await;
    if let Err(e) = purge_result {
        return ApiError::internal(format!("failed to purge app data: {e:#}")).into_response();
    }

    match db::delete_app(&state.pool, &id).await {
        Ok(()) => {
            let _ = crate::host::credentials::revoke(&state.pool, &id).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}
