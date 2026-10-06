//! Source preview (tree/blob/diff) + browser-edit commits.

use crate::api_error::ApiError;
use crate::host::{source, web_commit};
use crate::models::App;
use crate::AppState;

use super::apps::app_or_404;

/// Fetch an app plus the rev to browse in its source mirror (last deploy,
/// else bare-mirror HEAD). A missing mirror is a 404 with the push hint.
pub async fn app_with_rev(state: &AppState, id: &str) -> Result<(App, String), ApiError> {
    let app = app_or_404(state, id).await?;
    let rev = source::resolve_rev(&state.config, &app)
        .await
        .map_err(ApiError::from_anyhow)?;
    match rev {
        Some(rev) => Ok((app, rev)),
        None => Err(ApiError::not_found(
            "no source materialized yet — push to main first",
        )),
    }
}

pub async fn tree(state: &AppState, id: &str) -> Result<serde_json::Value, ApiError> {
    let (app, rev) = app_with_rev(state, id).await?;
    let tree = source::list_tree(&state.config, &app, &rev)
        .await
        .map_err(ApiError::from_anyhow)?;
    serde_json::to_value(tree).map_err(|e| ApiError::internal(e.to_string()))
}

/// Blob reads distinguish "no such file" (404) and an invalid path (400) from
/// a real mirror failure (500). The old code answered 404 for all three.
fn blob_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("invalid path") {
        ApiError::bad(msg)
    } else {
        ApiError::internal(msg)
    }
}

pub async fn blob(
    state: &AppState,
    id: &str,
    path: &str,
) -> Result<serde_json::Value, ApiError> {
    let (app, rev) = app_with_rev(state, id).await?;
    let blob = source::read_blob(&state.config, &app, &rev, path)
        .await
        .map_err(blob_error)?;
    serde_json::to_value(blob).map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn diff(state: &AppState, id: &str) -> Result<serde_json::Value, ApiError> {
    let (app, rev) = app_with_rev(state, id).await?;
    let patch = source::make_patch(&state.config, &app, &rev)
        .await
        .map_err(ApiError::from_anyhow)?;
    serde_json::to_value(patch).map_err(|e| ApiError::internal(e.to_string()))
}

/// One browser-edited file: validated path + text content.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct SourceCommitFile {
    pub path: String,
    pub content: String,
}

/// Browser-edit commit body: validated paths + text contents, a short
/// message, and the collaborator email used as the git author.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct SourceCommitBody {
    pub files: Vec<SourceCommitFile>,
    pub message: String,
    pub author: String,
}

/// Browser edits are input validation first (400), the "push once before web
/// edits" precondition is a 404, and a lost CAS race is a real 409 conflict.
/// A genuine git/exec failure stays 500.
fn commit_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("does not exist") {
        ApiError::not_found(msg)
    } else if msg.contains("tip moved under this commit") {
        ApiError::conflict(msg)
    } else if msg.contains("needs ")
        || msg.contains("bad path")
        || msg.contains("exceeds ")
        || msg.contains("looks binary")
    {
        ApiError::bad(msg)
    } else {
        ApiError::internal(msg)
    }
}

pub async fn commit(
    state: &AppState,
    id: &str,
    body: &SourceCommitBody,
) -> Result<String, ApiError> {
    let app = app_or_404(state, id).await?;
    let files: Vec<web_commit::WebFile> = body
        .files
        .iter()
        .map(|f| web_commit::WebFile {
            path: f.path.clone(),
            content: f.content.clone(),
        })
        .collect();
    web_commit::web_commit(state, &app, &body.author, &body.message, &files)
        .await
        .map_err(commit_error)
}
