//! Git remote info + forge operations (branch/history/compare reads and the
//! branch mutations) for the control UI. Reads run on the push mirror, which
//! holds every pushed branch; branch create/delete go through
//! [`forge::publish_ref`], so they publish (bundles + manifest) exactly like
//! a push and a deleted branch leaves the manifest.

use std::path::PathBuf;

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::host::forge::{self, GitBranch, GitCommitDetail, GitCompare, GitLog, GitRefs};
use crate::host::git_http::list_refs;
use crate::models::App;
use crate::AppState;

use super::apps::app_or_404;

/// Clone/browse coordinates. `url` is the stock remote; `s3Remote` is the
/// internal layout (debug).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitRemote {
    pub url: String,
    pub username: String,
    pub s3_remote: String,
    pub endpoint: String,
    pub bucket: String,
    pub prefix: String,
}

pub async fn remote(state: &AppState, id: &str) -> Result<GitRemote, ApiError> {
    let app = app_or_404(state, id).await?;
    Ok(GitRemote {
        url: state.config.git_http_url(&app.slug),
        username: "git".into(),
        s3_remote: state.config.s3_git_remote(&app.slug),
        endpoint: state.config.s3_public_endpoint.clone(),
        bucket: state.config.s3_bucket.clone(),
        prefix: app.git_prefix,
    })
}

/// The forge's error vocabulary: an unknown ref is a 404, a malformed one a
/// 400, a lost compare-and-swap a 409.
fn forge_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("invalid ref") || msg.contains("invalid branch name") {
        ApiError::bad(msg)
    } else if msg.contains("tip moved") {
        ApiError::conflict(msg)
    } else {
        ApiError::internal(msg)
    }
}

/// The app plus its manifest-synced push mirror.
async fn app_repo(state: &AppState, id: &str) -> Result<(App, PathBuf), ApiError> {
    let app = app_or_404(state, id).await?;
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    Ok((app, bare))
}

/// Every branch, with distance from `main` and the deployed sha.
pub async fn refs(state: &AppState, id: &str) -> Result<GitRefs, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    forge::refs(&bare, app.last_deploy_sha.as_deref())
        .await
        .map_err(forge_error)
}

/// One page of history, optionally for a single file.
pub async fn log(
    state: &AppState,
    id: &str,
    reference: Option<&str>,
    path: Option<&str>,
    skip: Option<i64>,
    limit: Option<i64>,
) -> Result<GitLog, ApiError> {
    let (_app, bare) = app_repo(state, id).await?;
    let path = match path {
        Some(path) if !crate::host::source::valid_path(path) => {
            return Err(ApiError::bad("invalid path"));
        }
        other => other,
    };
    forge::log(&bare, reference, path, skip.unwrap_or(0), limit)
        .await
        .map_err(forge_error)
}

/// One commit's metadata, body, files and patch.
pub async fn commit(state: &AppState, id: &str, sha: &str) -> Result<GitCommitDetail, ApiError> {
    let (_app, bare) = app_repo(state, id).await?;
    forge::commit_detail(&bare, sha).await.map_err(forge_error)
}

/// `base..head` plus whether a squash merge of `head` into `base` is clean.
pub async fn compare(
    state: &AppState,
    id: &str,
    base: &str,
    head: &str,
) -> Result<GitCompare, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    forge::compare(&state.config, &app.slug, &bare, base, head)
        .await
        .map_err(forge_error)
}

/// Create a branch at `from`. An existing branch is a 409.
pub async fn branch_create(
    state: &AppState,
    id: &str,
    name: &str,
    from: &str,
) -> Result<GitBranch, ApiError> {
    if !forge::valid_branch_name(name) {
        return Err(ApiError::bad(format!("invalid branch name {name:?}")));
    }
    let (app, bare) = app_repo(state, id).await?;
    let sha = forge::resolve_ref(&bare, from).await.map_err(forge_error)?;
    forge::publish_ref(state, &app, name, None, Some(&sha))
        .await
        .map_err(forge_error)?;
    if let Err(e) = crate::host::prs::on_branch_moved(state, &app.id, name, &sha).await {
        tracing::warn!(error = %format!("{e:#}"), "pr head sync");
    }
    forge::refs(&bare, app.last_deploy_sha.as_deref())
        .await
        .map_err(forge_error)?
        .branches
        .into_iter()
        .find(|branch| branch.name == name)
        .ok_or_else(|| ApiError::internal("branch missing after create"))
}

/// Delete a branch. Refuses `main` (400); an unknown branch is a 404.
pub async fn branch_delete(state: &AppState, id: &str, name: &str) -> Result<(), ApiError> {
    if name == forge::DEFAULT_BRANCH {
        return Err(ApiError::bad("cannot delete the default branch"));
    }
    if !forge::valid_branch_name(name) {
        return Err(ApiError::bad(format!("invalid branch name {name:?}")));
    }
    let (app, bare) = app_repo(state, id).await?;
    let refname = format!("refs/heads/{name}");
    let refs = list_refs(&bare).await.map_err(ApiError::from_anyhow)?;
    let Some(old) = refs.get(&refname).cloned() else {
        return Err(ApiError::not_found(format!("branch {name:?} not found")));
    };
    forge::publish_ref(state, &app, name, Some(&old), None)
        .await
        .map_err(forge_error)
}
