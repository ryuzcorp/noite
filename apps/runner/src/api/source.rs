//! Source preview (tree/blob/diff) + browser-edit commits (thin adapters over
//! `service::source`).
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::service;
use crate::AppState;

pub async fn source_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::source::tree(&state, &id).await.map(Json)
}

pub async fn source_blob(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
) -> impl IntoResponse {
    service::source::blob(&state, &id, &path).await.map(Json)
}

pub async fn source_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::source::diff(&state, &id).await.map(Json)
}

pub async fn app_source_commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<service::source::SourceCommitBody>,
) -> impl IntoResponse {
    service::source::commit(&state, &id, &body)
        .await
        .map(|sha| Json(json!({ "sha": sha })))
}
