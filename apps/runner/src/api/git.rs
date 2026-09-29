//! Git remote info for the control UI.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde::Serialize;

use crate::db;
use crate::error::ApiError;
use crate::AppState;

pub async fn git_remote(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    Json(GitRemote {
        remote: state.config.git_http_remote(&app.slug),
        url: state.config.git_http_url(&app.slug),
        username: "git".into(),
        s3_remote: state.config.s3_git_remote(&app.slug),
        endpoint: state.config.s3_public_endpoint.clone(),
        bucket: state.config.s3_bucket.clone(),
        prefix: app.git_prefix,
    })
    .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemote {
    pub(crate) remote: String,
    pub(crate) url: String,
    pub(crate) username: String,
    /// Internal S3 layout (debug); clients use `remote` / `url`.
    pub(crate) s3_remote: String,
    pub(crate) endpoint: String,
    pub(crate) bucket: String,
    pub(crate) prefix: String,
}
