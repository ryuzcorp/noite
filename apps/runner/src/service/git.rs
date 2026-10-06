//! Git remote info for the control UI.

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
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
