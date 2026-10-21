//! Update-check admin endpoints (thin adapters over
//! `service::update_check`).

use axum::{extract::State, response::IntoResponse, Json};
use serde::Deserialize;

use crate::service;
use crate::AppState;

pub async fn get_update_status(State(state): State<AppState>) -> impl IntoResponse {
    service::update_check::get(&state).await.map(Json)
}

#[derive(Deserialize)]
pub struct SetUpdateStatusBody {
    enabled: bool,
}

pub async fn set_update_status(
    State(state): State<AppState>,
    Json(body): Json<SetUpdateStatusBody>,
) -> impl IntoResponse {
    service::update_check::set(&state, body.enabled)
        .await
        .map(Json)
}
