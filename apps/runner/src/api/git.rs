//! Git remote info for the control UI (thin adapter over `service::git`).
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::service;
use crate::AppState;

pub async fn git_remote(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::git::remote(&state, &id).await.map(Json)
}
