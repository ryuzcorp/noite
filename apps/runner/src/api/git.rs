//! Git remote info + forge operations (thin adapters over `service::git`).
//!
//! The forge routes live under `/git/` because `/v1/apps/{id}/refs` is
//! already the traffic-referrer endpoint.
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::service;
use crate::AppState;

pub async fn git_remote(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::git::remote(&state, &id).await.map(Json)
}

/// `?ref=` on the source reads; absent keeps the deployed-sha resolution.
#[derive(Debug, Deserialize)]
pub struct RefQuery {
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub skip: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CompareQuery {
    pub base: String,
    pub head: String,
}

#[derive(Debug, Deserialize)]
pub struct BranchCreateBody {
    pub name: String,
    pub from: String,
}

pub async fn git_refs(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::git::refs(&state, &id).await.map(Json)
}

pub async fn git_log(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<LogQuery>,
) -> impl IntoResponse {
    service::git::log(
        &state,
        &id,
        q.reference.as_deref(),
        q.path.as_deref(),
        q.skip,
        q.limit,
    )
    .await
    .map(Json)
}

pub async fn git_commit(
    State(state): State<AppState>,
    Path((id, sha)): Path<(String, String)>,
) -> impl IntoResponse {
    service::git::commit(&state, &id, &sha).await.map(Json)
}

pub async fn git_compare(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CompareQuery>,
) -> impl IntoResponse {
    service::git::compare(&state, &id, &q.base, &q.head)
        .await
        .map(Json)
}

pub async fn git_branch_create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<BranchCreateBody>,
) -> impl IntoResponse {
    service::git::branch_create(&state, &id, &body.name, &body.from)
        .await
        .map(Json)
}

pub async fn git_branch_delete(
    State(state): State<AppState>,
    Path((id, name)): Path<(String, String)>,
) -> impl IntoResponse {
    service::git::branch_delete(&state, &id, &name)
        .await
        .map(|()| Json(json!({ "ok": true })))
}
