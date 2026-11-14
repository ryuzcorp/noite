//! Grouped errors: the unary reads and the ingest identity (thin adapters
//! over `service::errors`) plus the live SSE stream.
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::environments::RoleQuery;
use crate::api::sse::poll_stream;
use crate::api_error::ApiError;
use crate::service;
use crate::AppState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorsStreamQuery {
    status: Option<String>,
    #[serde(default)]
    environment_id: Option<String>,
}

/// One status's issue list (`?status=` defaults to `open`;
/// `?environmentId=` narrows to one preview environment, absent is
/// production): the snapshot the live errors tab starts from.
pub async fn list_errors(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ErrorsStreamQuery>,
) -> impl IntoResponse {
    let status = q.status.unwrap_or_else(|| "open".into());
    service::errors::list_for(&state, &id, &status, q.environment_id.as_deref())
        .await
        .map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentQuery {
    #[serde(default)]
    environment_id: Option<String>,
}

/// `?environmentId=` — one issue with its occurrences, frames and logs.
pub async fn get_error(
    State(state): State<AppState>,
    Path((id, fingerprint)): Path<(String, String)>,
    Query(q): Query<EnvironmentQuery>,
) -> impl IntoResponse {
    service::errors::get(&state, &id, &fingerprint, q.environment_id.as_deref())
        .await
        .map(Json)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetErrorStatusBody {
    status: String,
    #[serde(default)]
    environment_id: Option<String>,
}

/// Triage one issue: `open`, `resolved` or `ignored`.
pub async fn set_error_status(
    State(state): State<AppState>,
    Path((id, fingerprint)): Path<(String, String)>,
    Json(body): Json<SetErrorStatusBody>,
) -> impl IntoResponse {
    service::errors::set_status(
        &state,
        &id,
        &fingerprint,
        &body.status,
        body.environment_id.as_deref(),
    )
    .await
    .map(|()| Json(json!({ "ok": true })))
}

/// The app's public error-ingest identity (numeric project id + key); the
/// runner mints the row on first view. `?role=` is the caller's resolved app
/// role, enforced runner-side.
pub async fn get_ingest_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::errors::ingest_key(&state, &id, q.role.as_deref())
        .await
        .map(Json)
}

/// Mint a replacement ingest key, keeping the numeric project id. Admin.
pub async fn rotate_ingest_key(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::errors::rotate_ingest_key(&state, &id, q.role.as_deref())
        .await
        .map(Json)
}

/// Record one envelope's events under the app the project number resolves
/// to; a wrong key or unknown number is one 404 that reveals neither.
pub async fn ingest_errors(
    State(state): State<AppState>,
    Json(body): Json<service::errors::SdkIngestBatch>,
) -> impl IntoResponse {
    service::errors::ingest(&state, body)
        .await
        .map(|fingerprints| Json(json!({ "fingerprints": fingerprints })))
}

/// One status's issue list (the `errors.list` shape) as server-sent events:
/// a frame only when the list, a count or an hourly series changed (plus
/// keep-alive comments). Ends when the client disconnects.
pub async fn list_errors_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ErrorsStreamQuery>,
) -> Response {
    let status = q.status.unwrap_or_else(|| "open".into());
    let Some(status) = crate::models::IssueStatus::parse(&status) else {
        return ApiError::bad("status must be open, resolved or ignored").into_response();
    };
    let scope = match service::observe::telemetry_scope(
        &state.pool,
        &id,
        q.environment_id.as_deref(),
    )
    .await
    {
        Ok(scope) => scope,
        Err(e) => return e.into_response(),
    };
    let pool = state.pool.clone();
    poll_stream("errors", Duration::from_secs(2), move || {
        let pool = pool.clone();
        let app_id = scope.app_id.clone();
        let environment_id = scope.environment_id.clone();
        async move {
            service::errors::list(&pool, &app_id, &environment_id, status)
                .await
                .ok()
                .and_then(|list| serde_json::to_string(&list).ok())
        }
    })
}
