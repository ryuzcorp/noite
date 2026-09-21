//! Source preview (tree/blob/diff) + browser-edit commits.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::host::source;
use crate::host::web_commit;
use crate::AppState;

/// Fetch an app plus the rev to browse in its source mirror (last deploy,
/// else bare-mirror HEAD). Err → app exists but has no source yet.
pub(crate) async fn app_with_rev(
    state: &AppState,
    id: &str,
) -> Result<Option<(crate::models::App, String)>, String> {
    let Some(app) = db::get_app(&state.pool, id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let Some(rev) = source::resolve_rev(&state.config, &app)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Err("no source materialized yet — push to main first".into());
    };
    Ok(Some((app, rev)))
}

pub async fn source_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::list_tree(&state.config, &app, &rev).await {
            Ok(t) => Json(t).into_response(),
            Err(e) => ApiError::from_anyhow(e).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

pub async fn source_blob(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::read_blob(&state.config, &app, &rev, &path).await {
            Ok(b) => Json(b).into_response(),
            Err(e) => ApiError::not_found(e.to_string()).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

pub async fn source_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::make_patch(&state.config, &app, &rev).await {
            Ok(d) => Json(d).into_response(),
            Err(e) => ApiError::from_anyhow(e).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

/// Browser-edit commit body: validated paths + text contents, a short
/// message, and the collaborator email used as the git author.
#[derive(Deserialize)]
pub struct SourceCommitFile {
    pub path: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct SourceCommitBody {
    pub files: Vec<SourceCommitFile>,
    pub message: String,
    pub author: String,
}

pub async fn app_source_commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SourceCommitBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let files: Vec<web_commit::WebFile> = body
        .files
        .into_iter()
        .map(|f| web_commit::WebFile { path: f.path, content: f.content })
        .collect();
    match web_commit::web_commit(&state, &app, &body.author, &body.message, &files).await {
        Ok(sha) => Json(json!({"sha": sha})).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}
