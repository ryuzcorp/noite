//! Pull-request endpoints: thin adapters over `service::prs`.
//!
//! Same data as the `prs.*` / `branch_rules.*` RPCs; the UI uses the RPCs, the
//! REST mirrors exist so every RPC has one (contract §"Every new runner RPC
//! gets a REST mirror").
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

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub skip: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    pub actor: Actor,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub base: String,
    pub head: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBody {
    pub actor: Actor,
    pub role: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentBody {
    pub actor: Actor,
    pub role: String,
    pub body: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub side: Option<String>,
    #[serde(default)]
    pub commit_sha: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentEditBody {
    pub actor: Actor,
    #[serde(default)]
    pub role: Option<String>,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBody {
    pub actor: Actor,
    pub role: String,
    pub state: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeBody {
    pub actor: Actor,
    pub role: String,
    #[serde(default)]
    pub author_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub delete_branch: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesBody {
    pub require_pr: bool,
    pub required_approvals: i64,
}

pub async fn list_prs(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    service::prs::list(
        &state,
        &id,
        q.state.as_deref(),
        q.skip.unwrap_or(0),
        q.limit.unwrap_or(25),
    )
    .await
    .map(Json)
}

pub async fn get_pr(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, i64)>,
) -> impl IntoResponse {
    service::prs::get(&state, &id, number).await.map(Json)
}

pub async fn create_pr(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<CreateBody>,
) -> impl IntoResponse {
    service::prs::create(
        &state, &id, &body.actor, &body.title, &body.body, &body.base, &body.head,
    )
    .await
    .map(Json)
}

pub async fn update_pr(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, i64)>,
    Json(body): Json<UpdateBody>,
) -> impl IntoResponse {
    service::prs::update(
        &state,
        &id,
        number,
        &body.actor,
        &body.role,
        body.title.as_deref(),
        body.body.as_deref(),
        body.state.as_deref(),
    )
    .await
    .map(Json)
}

pub async fn add_comment(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, i64)>,
    Json(body): Json<CommentBody>,
) -> impl IntoResponse {
    service::prs::comment(
        &state,
        &id,
        number,
        &body.actor,
        &body.role,
        &body.body,
        body.path.as_deref(),
        body.line,
        body.side.as_deref(),
        body.commit_sha.as_deref(),
    )
    .await
    .map(Json)
}

pub async fn edit_comment(
    State(state): State<AppState>,
    Path((id, comment_id)): Path<(String, String)>,
    Json(body): Json<CommentEditBody>,
) -> impl IntoResponse {
    service::prs::comment_edit(&state, &id, &comment_id, &body.actor, &body.body)
        .await
        .map(|()| Json(json!({ "ok": true })))
}

pub async fn delete_comment(
    State(state): State<AppState>,
    Path((id, comment_id)): Path<(String, String)>,
    Json(body): Json<CommentEditBody>,
) -> impl IntoResponse {
    service::prs::comment_delete(
        &state,
        &id,
        &comment_id,
        &body.actor,
        body.role.as_deref().unwrap_or("view"),
    )
    .await
    .map(|()| Json(json!({ "ok": true })))
}

pub async fn add_review(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, i64)>,
    Json(body): Json<ReviewBody>,
) -> impl IntoResponse {
    service::prs::review(&state, &id, number, &body.actor, &body.role, &body.state)
        .await
        .map(Json)
}

pub async fn merge_pr(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, i64)>,
    Json(body): Json<MergeBody>,
) -> impl IntoResponse {
    service::prs::merge(
        &state,
        &id,
        number,
        &body.actor,
        &body.role,
        body.author_name.as_deref(),
        body.title.as_deref(),
        body.message.as_deref(),
        body.delete_branch,
    )
    .await
    .map(Json)
}

pub async fn get_branch_rules(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::prs::branch_rules_get(&state, &id).await.map(Json)
}

pub async fn set_branch_rules(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RulesBody>,
) -> impl IntoResponse {
    service::prs::branch_rules_set(&state, &id, body.require_pr, body.required_approvals)
        .await
        .map(Json)
}
