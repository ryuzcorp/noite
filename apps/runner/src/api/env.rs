//! Tenant env vars (`.dev.vars` model): list/set/delete. Values are
//! injected into build, release-command, and fleet env; reserved platform
//! names are filtered at inject time (see db::tenant_env).
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::db;
use crate::error::ApiError;
use crate::AppState;

pub(crate) fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

pub async fn list_env(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    // Values included: single-operator premise, same posture as app_secret.
    match db::list_env(&state.pool, &app.id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

#[derive(serde::Deserialize)]
pub struct SetEnvBody {
    pub name: String,
    pub value: String,
}

pub async fn set_env(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetEnvBody>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    if !name_valid(&name) {
        return ApiError::bad("name must match [A-Za-z_][A-Za-z0-9_]* (≤64)").into_response();
    }
    if body.value.len() > 32 * 1024 {
        return ApiError::bad("value exceeds 32 KiB").into_response();
    }
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::set_env(&state.pool, &app.id, &name, &body.value).await {
        Ok(()) => {
            crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
            Json(serde_json::json!({ "ok": true, "name": name })).into_response()
        }
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn delete_env(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    if !name_valid(&name) {
        return ApiError::bad("invalid name").into_response();
    }
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::delete_env(&state.pool, &app.id, &name).await {
        Ok(()) => {
            crate::host::persist::snapshot_best_effort(&state.pool, &state.config).await;
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}
