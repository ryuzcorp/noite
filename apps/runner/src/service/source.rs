//! Source preview (tree/blob) + browser-edit commits.

use std::path::PathBuf;

use crate::api_error::ApiError;
use crate::host::{forge, git_identity, source, source_types, web_commit};
use crate::models::App;
use crate::AppState;

use super::apps::app_or_404;

/// Resolve a read on the push mirror: an explicit `ref` (branch, tag or sha)
/// is resolved and validated; without one the deployed sha, else the mirror's
/// HEAD, is used. A missing ref is a 404, a malformed one a 400.
fn rev_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("invalid ref") {
        ApiError::bad(msg)
    } else {
        ApiError::internal(msg)
    }
}

/// Fetch an app plus the mirror and rev to browse. A repository with no
/// commit yet is a 404 with the push hint.
pub async fn app_with_rev(
    state: &AppState,
    id: &str,
    reference: Option<&str>,
) -> Result<(App, PathBuf, String), ApiError> {
    let app = app_or_404(state, id).await?;
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    let rev = forge::read_rev(&bare, &app, reference)
        .await
        .map_err(rev_error)?;
    match rev {
        Some(rev) => Ok((app, bare, rev)),
        None => Err(ApiError::not_found(
            "no source materialized yet — push to main first",
        )),
    }
}

pub async fn tree(
    state: &AppState,
    id: &str,
    reference: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let (_app, bare, rev) = app_with_rev(state, id, reference).await?;
    let tree = source::list_tree(&bare, &rev)
        .await
        .map_err(ApiError::from_anyhow)?;
    serde_json::to_value(tree).map_err(|e| ApiError::internal(e.to_string()))
}

/// `source.bundle`: every text source at `ref`, for the editor's language
/// service. An empty `ref` means "no ref" — the UI's "deployed" choice sends
/// none, and a stray empty string must not 400.
pub async fn bundle(
    state: &AppState,
    id: &str,
    reference: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let reference = reference.filter(|r| !r.is_empty());
    let (_app, bare, rev) = app_with_rev(state, id, reference).await?;
    let bundle = source::bundle(&bare, &rev)
        .await
        .map_err(ApiError::from_anyhow)?;
    serde_json::to_value(bundle).map_err(|e| ApiError::internal(e.to_string()))
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
    reference: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let (_app, bare, rev) = app_with_rev(state, id, reference).await?;
    let blob = source::read_blob(&bare, &rev, path)
        .await
        .map_err(blob_error)?;
    serde_json::to_value(blob).map_err(|e| ApiError::internal(e.to_string()))
}

/// `source.types`: the declaration files captured from the app's last
/// successful build (`host::source_types`). Nothing captured yet is the empty
/// payload (`sha: null`, no files), not an error.
pub async fn types(state: &AppState, id: &str) -> Result<serde_json::Value, ApiError> {
    let app = app_or_404(state, id).await?;
    let types = source_types::read(&state.config, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    serde_json::to_value(types).map_err(|e| ApiError::internal(e.to_string()))
}

/// One browser-edited file: validated path + text content.
#[derive(serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct SourceCommitFile {
    pub path: String,
    pub content: String,
}

/// Browser-edit commit body: validated paths + text contents, a short
/// message, the session user the commit is attributed to, and — when the UI
/// commits to something other than `main` — the target branch, plus the ref a
/// new branch starts from.
#[derive(serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceCommitBody {
    pub actor: git_identity::Actor,
    pub files: Vec<SourceCommitFile>,
    pub message: String,
    #[serde(default)]
    #[ts(optional)]
    pub branch: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub from_sha: Option<String>,
    /// The caller's app role; `require_pr` blocks a non-admin commit to
    /// `main` (`None` counts as a non-admin).
    #[serde(default)]
    #[ts(optional)]
    pub role: Option<String>,
}

/// Browser edits are input validation first (400), a lost CAS race is a real
/// 409 conflict, and an unknown branch to start from is a 404. A genuine
/// git/exec failure stays 500.
fn commit_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("tip moved") {
        ApiError::conflict(msg)
    } else if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("needs ")
        || msg.contains("bad path")
        || msg.contains("exceeds ")
        || msg.contains("looks binary")
        || msg.contains("invalid branch")
        || msg.contains("invalid ref")
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
    // `require_pr` keeps the push role off `main`; a browser edit then has to
    // go to a new branch (the UI offers exactly that).
    let target = body.branch.as_deref().unwrap_or(forge::DEFAULT_BRANCH);
    if target == forge::DEFAULT_BRANCH && body.role.as_deref() != Some("admin") {
        let rules = crate::db::prs::branch_rules(&state.pool, &app.id)
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        if rules.require_pr != 0 {
            return Err(ApiError::conflict(
                "refs/heads/main is protected; commit to a new branch and open a pull request",
            ));
        }
    }
    let actor = git_identity::noreply(&state.config, &body.actor.user_id, &body.actor.name);
    let files: Vec<web_commit::WebFile> = body
        .files
        .iter()
        .map(|f| web_commit::WebFile {
            path: f.path.clone(),
            content: f.content.clone(),
        })
        .collect();
    let sha = web_commit::web_commit(
        state,
        &app,
        &actor,
        &body.message,
        &files,
        body.branch.as_deref(),
        body.from_sha.as_deref(),
    )
    .await
    .map_err(commit_error)?;
    // A browser commit is a head move like any other: keep open PRs pointing
    // at the new sha (best-effort — the commit itself already landed).
    if let Err(e) = crate::host::prs::on_branch_moved(state, &app.id, target, &sha).await {
        tracing::warn!(error = %format!("{e:#}"), "pr head sync");
    }
    Ok(sha)
}
