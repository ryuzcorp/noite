//! Tenant env vars (`.dev.vars` model): list/set/delete (thin adapters over
//! `service::env`). Values are injected into build, release-command, and fleet
//! env; reserved platform names are filtered at inject time (see db::tenant_env).
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::service;
use crate::AppState;

#[derive(serde::Deserialize)]
pub struct SetEnvBody {
    pub name: String,
    pub value: String,
}

pub async fn list_env(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::env::list(&state, &id).await.map(Json)
}

pub async fn set_env(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetEnvBody>,
) -> impl IntoResponse {
    service::env::set(&state, &id, &body.name, &body.value)
        .await
        .map(|name| Json(json!({ "ok": true, "name": name })))
}

pub async fn delete_env(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    service::env::delete(&state, &id, &name)
        .await
        .map(|()| Json(json!({ "ok": true })))
}
