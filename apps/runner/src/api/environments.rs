//! Preview environments (thin adapters over `service::environments`) and the
//! workspace preview (`source.preview`).
//!
//! Role gates live in the service layer: `role` is required on every mutating
//! call (`push` to create/deploy/preview and set variables, `admin` to delete
//! and to flip an environment public) and on reads (`view`).
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::host::git_identity::Actor;
use crate::service;
use crate::AppState;

/// `?role=` — the caller's role in this app, resolved by the control UI.
#[derive(Deserialize)]
pub struct RoleQuery {
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEnvironmentBody {
    pub branch: String,
    #[serde(default)]
    pub actor: Option<Actor>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnvironmentBody {
    pub public: bool,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployEnvironmentBody {
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct SetEnvironmentVarBody {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub role: Option<String>,
}

pub async fn list_environments(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::environments::list(&state, &id, q.role.as_deref())
        .await
        .map(Json)
}

pub async fn create_environment(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateEnvironmentBody>,
) -> impl IntoResponse {
    service::environments::create(
        &state,
        &id,
        &body.branch,
        body.actor.as_ref(),
        body.role.as_deref(),
    )
    .await
    .map(Json)
}

pub async fn delete_environment(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::environments::delete(&state, &id, &env_id, q.role.as_deref())
        .await
        .map(|()| Json(json!({ "ok": true })))
}

pub async fn update_environment(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Json(body): Json<UpdateEnvironmentBody>,
) -> impl IntoResponse {
    service::environments::update(&state, &id, &env_id, body.public, body.role.as_deref())
        .await
        .map(Json)
}

pub async fn deploy_environment(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Json(body): Json<DeployEnvironmentBody>,
) -> impl IntoResponse {
    service::environments::deploy(&state, &id, &env_id, body.role.as_deref())
        .await
        .map(|(deploy_id, sha)| Json(json!({ "deployId": deploy_id, "sha": sha })))
}

pub async fn list_environment_env(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::environments::vars(&state, &id, &env_id, q.role.as_deref())
        .await
        .map(Json)
}

pub async fn set_environment_env(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Json(body): Json<SetEnvironmentVarBody>,
) -> impl IntoResponse {
    service::environments::vars_set(
        &state,
        &id,
        &env_id,
        &body.name,
        &body.value,
        body.role.as_deref(),
    )
    .await
    .map(|name| Json(json!({ "ok": true, "name": name })))
}

pub async fn delete_environment_env(
    State(state): State<AppState>,
    Path((id, env_id, name)): Path<(String, String, String)>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::environments::vars_delete(&state, &id, &env_id, &name, q.role.as_deref())
        .await
        .map(|()| Json(json!({ "ok": true })))
}

/// `source.preview`: snapshot the workspace as a commit on the hidden
/// `refs/previews/<userId>/<branch>` ref and deploy its environment, creating
/// it on first use.
pub async fn app_source_preview(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<service::source::SourceCommitBody>,
) -> impl IntoResponse {
    service::environments::preview(&state, &id, &body)
        .await
        .map(Json)
}
