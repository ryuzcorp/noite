//! Grouped errors as a live SSE stream (the unary reads live in
//! `service::errors`, served by JSON-RPC and the REST list if one is added).
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
};

use crate::api::sse::poll_stream;
use crate::api_error::ApiError;
use crate::service;
use crate::AppState;

#[derive(serde::Deserialize)]
pub struct ErrorsStreamQuery {
    status: Option<String>,
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
    if !service::errors::ERROR_STATUSES.contains(&status.as_str()) {
        return ApiError::bad("status must be open, resolved or ignored").into_response();
    }
    let app_id = match service::observe::telemetry_target_or_404(&state.pool, &id).await {
        Ok((app_id, _)) => app_id,
        Err(e) => return e.into_response(),
    };
    let pool = state.pool.clone();
    poll_stream("errors", Duration::from_secs(2), move || {
        let pool = pool.clone();
        let app_id = app_id.clone();
        let status = status.clone();
        async move {
            service::errors::list(&pool, &app_id, &status)
                .await
                .ok()
                .and_then(|list| serde_json::to_string(&list).ok())
        }
    })
}
