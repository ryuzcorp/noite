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

/// Readiness for the edge: 200 only after the first successful reconcile
/// pass (fleets spawned, Caddyfile written). Liveness stays on /health.
/// Compose healthchecks and Coolify route on this, so tenants are never
/// sent to a runner whose fleets are still cold-booting.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    if state.ready.load(std::sync::atomic::Ordering::Relaxed) {
        Json(json!({ "ok": true, "service": "noite-runner" })).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false })))
            .into_response()
    }
}

/// Pre-export checkpoint: flush a fresh SQLite snapshot so the worker's R2
/// relay (and nightly backup) copy seconds-old state, not minutes-old.
/// Best-effort like every other snapshot trigger — the relay diffs etags anyway.
pub async fn checkpoint(State(state): State<AppState>) -> impl IntoResponse {
    crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
    Json(json!({ "ok": true }))
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
        Ok(Some(existing))
            if existing.desired_state == "deleted"
                || existing.status == "deleting"
                || existing.status == "gone" =>
        {
            // Legacy soft-delete row: reclaim requires a hard DB delete first.
            if let Err(e) = db::delete_app(&state.pool, &existing.id).await {
                return ApiError::internal(format!("failed to reclaim slug row: {e}"))
                    .into_response();
            }
        }
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
    let (listen, internal) = match db::next_ports(&state.pool, state.config.port_base).await {
        Ok(p) => p,
        Err(e) => {
            return ApiError::internal(e.to_string()).into_response();
        }
    };
    let subdomain = format!("{slug}.{}", state.config.base_domain);
    match db::create_app(
        &state.pool,
        &state.config,
        &name,
        &slug,
        &subdomain,
        listen,
        internal,
    )
    .await {
        Ok(app) => {
            crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
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
        crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
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
            crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}
