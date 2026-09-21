//! Git remote info + S3 webhook deploy nudge.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use serde::Serialize;
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::host::deploy;
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

pub async fn webhook(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut keys = Vec::new();
    if let Some(records) = body.get("Records").and_then(|r| r.as_array()) {
        for rec in records {
            if let Some(key) = rec
                .pointer("/s3/object/key")
                .and_then(|k| k.as_str())
            {
                keys.push(key.replace('+', " "));
            }
        }
    }
    for key in &keys {
        // Keys are `git/{slug}/refs/heads/main/{sha}.bundle` (single-bucket layout).
        // Accept legacy `{slug}/refs/...` from the old dedicated `git` bucket.
        let path = key.strip_prefix("git/").unwrap_or(key.as_str());
        let slug = path.split('/').next().unwrap_or("");
        if slug.is_empty() || !key.ends_with(".bundle") || !path.contains("/refs/heads/main/") {
            continue;
        }
        let Ok(Some(app)) = db::get_app_by_slug(&state.pool, slug).await else {
            continue;
        };
        if app.is_stopped() {
            continue;
        }
        let pool = state.pool.clone();
        let cfg = state.config.clone();
        let procs = state.procs.clone();
        let logs = state.logs.clone();
        let deploying = state.deploying.clone();
        let key = key.clone();
        tokio::spawn(async move {
            deploy::deploy_app(&pool, &cfg, &procs, &logs, &deploying, app, &key, None).await;
        });
    }
    Json(json!({ "ok": true, "keys": keys }))
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
