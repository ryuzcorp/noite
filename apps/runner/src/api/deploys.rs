//! Deploy history (JSON + live SSE stream).
use std::time::Duration;

use axum::{
    extract::{Path, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use tokio_stream::wrappers::ReceiverStream;

use crate::db;
use crate::error::ApiError;
use crate::host::deploy;
use crate::AppState;

/// Rollback to a previous successful deploy sha: re-runs the pipeline at
/// the old tip bundle (bundles are immutable per-sha). 202 immediately;
/// progress follows on the deploys stream.
#[derive(serde::Deserialize)]
pub struct RollbackBody {
    sha: String,
}

pub(crate) fn sha_valid(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn rollback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RollbackBody>,
) -> impl IntoResponse {
    let sha = body.sha.trim().to_lowercase();
    if !sha_valid(&sha) {
        return ApiError::bad("sha must be 7-40 hex chars").into_response();
    }
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::get_success_deploy(&state.pool, &app.id, &sha).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("no successful deploy at that sha").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let pool = state.pool.clone();
    let cfg = state.config.clone();
    let procs = state.procs.clone();
    let logs = state.logs.clone();
    let deploying = state.deploying.clone();
    let key = format!("git/{}/refs/heads/main/{sha}.bundle", app.slug);
    let sha_resp = sha.clone();
    tokio::spawn(async move {
        deploy::deploy_app(
            &pool,
            &cfg,
            &procs,
            &logs,
            &deploying,
            app,
            &key,
            Some(&sha),
        )
        .await;
    });
    Json(serde_json::json!({ "ok": true, "sha": sha_resp })).into_response()
}

pub async fn list_deploys(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match db::list_deploys(&state.pool, &id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// One deploy's full build log (T1.7). The stream omits finished rows' logs,
/// so the UI fetches them here when a "Build logs" tab opens. Finished
/// deploys never change, so callers may cache this forever.
pub async fn deploy_log(
    State(state): State<AppState>,
    Path((id, deploy_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::get_deploy_log(&state.pool, &app.id, deploy_id.trim()).await {
        Ok(Some(log)) => Json(serde_json::json!({ "log": log })).into_response(),
        Ok(None) => ApiError::not_found("deploy not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// Deploy history as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Ends when the
/// client disconnects.
pub async fn list_deploys_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let pool = state.pool.clone();
    let app_id = app.id.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    crate::host::stats::sse_enter("deploys");
    tokio::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            match db::list_deploys_lean(&pool, &app_id).await {
                Ok(rows) => {
                    let data = serde_json::to_string(&rows).unwrap_or_default();
                    if last.as_ref() != Some(&data) {
                        if tx
                            .send(Ok(Event::default().data(data.clone())))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        last = Some(data);
                    }
                }
                Err(_) => {
                    // Transient DB error — retry on next tick.
                }
            }
            // Stop promptly when the client leaves (T1.2): the send-failure
            // check above only fires on change, so an idle stream would poll
            // SQLite every 2 s forever after disconnect.
            tokio::select! {
                () = tokio::time::sleep(Duration::from_secs(2)) => {}
                () = tx.closed() => break,
            }
        }
        crate::host::stats::sse_exit("deploys");
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
