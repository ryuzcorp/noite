//! Source preview (tree/blob) + browser-edit commits (thin adapters over
//! `service::source`). `?ref=` selects a branch, tag or sha; absent keeps the
//! deployed-sha resolution.
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};
use serde_json::json;

use crate::service;
use crate::AppState;

use super::git::RefQuery;

pub async fn source_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::tree(&state, &id, q.reference.as_deref())
        .await
        .map(Json)
}

pub async fn source_blob(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::blob(&state, &id, &path, q.reference.as_deref())
        .await
        .map(Json)
}

/// All text sources at `ref` (the editor's language service); no `ref` keeps
/// the deployed-sha resolution.
pub async fn source_bundle(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::bundle(&state, &id, q.reference.as_deref())
        .await
        .map(Json)
}

/// Declaration files captured from the app's last successful build.
pub async fn source_types(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::source::types(&state, &id).await.map(Json)
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
