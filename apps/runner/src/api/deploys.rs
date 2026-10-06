//! Deploy history (thin adapters over `service::deploys`) plus the live SSE
//! stream.
use std::time::Duration;

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::api::sse::poll_stream;
use crate::db;
use crate::service;
use crate::AppState;

/// Rollback to a previous successful deploy sha: re-runs the pipeline at
/// the old tip bundle (bundles are immutable per-sha). 202 immediately;
/// progress follows on the deploys stream.
#[derive(serde::Deserialize)]
pub struct RollbackBody {
    sha: String,
}

pub async fn rollback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RollbackBody>,
) -> impl IntoResponse {
    service::deploys::rollback(&state, &id, &body.sha)
        .await
        .map(|sha| Json(json!({ "ok": true, "sha": sha })))
}

pub async fn list_deploys(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::deploys::list(&state, &id).await.map(Json)
}

/// One deploy's full build log (T1.7). The stream omits finished rows' logs,
/// so the UI fetches them here when a "Build logs" tab opens. Finished
/// deploys never change, so callers may cache this forever.
pub async fn deploy_log(
    State(state): State<AppState>,
    Path((id, deploy_id)): Path<(String, String)>,
) -> impl IntoResponse {
    service::deploys::log(&state, &id, &deploy_id)
        .await
        .map(|log| Json(json!({ "log": log })))
}

/// Deploy history as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Ends when the
/// client disconnects.
pub async fn list_deploys_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let app = match service::apps::app_or_404(&state, &id).await {
        Ok(app) => app,
        Err(e) => return e.into_response(),
    };
    let pool = state.pool.clone();
    let app_id = app.id.clone();
    poll_stream("deploys", Duration::from_secs(2), move || {
        let pool = pool.clone();
        let app_id = app_id.clone();
        async move {
            db::list_deploys_lean(&pool, &app_id)
                .await
                .ok()
                .map(|rows| serde_json::to_string(&rows).unwrap_or_default())
        }
    })
}
