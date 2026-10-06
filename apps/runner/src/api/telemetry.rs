//! Instance telemetry admin endpoints (thin adapters over `service::telemetry`).

use axum::{
    extract::State,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::service;
use crate::AppState;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetTelemetryBody {
    pub enabled: bool,
}

pub async fn get_telemetry(State(state): State<AppState>) -> impl IntoResponse {
    service::telemetry::get(&state).await.map(Json)
}

pub async fn set_telemetry(
    State(state): State<AppState>,
    Json(body): Json<SetTelemetryBody>,
) -> impl IntoResponse {
    service::telemetry::set(&state, body.enabled).await.map(Json)
}
