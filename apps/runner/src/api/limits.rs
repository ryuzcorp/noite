//! Per-app limits (thin adapters over `service::limits`): the edge rate
//! limits and the fleet memory cap override the settings panel edits.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::service;
use crate::AppState;

/// `null` returns one limit to the platform default; `role` is the caller's
/// resolved app role (anything but `admin` is refused runner-side).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLimitsBody {
    #[serde(default)]
    client_rpm: Option<i64>,
    #[serde(default)]
    app_rpm: Option<i64>,
    #[serde(default)]
    memory_mb: Option<i64>,
    #[serde(default)]
    sleep_after_s: Option<i64>,
    #[serde(default)]
    role: Option<String>,
}

pub async fn get_limits(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::limits::get(&state, &id).await.map(Json)
}

pub async fn set_limits(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetLimitsBody>,
) -> impl IntoResponse {
    service::limits::set(
        &state,
        &id,
        body.client_rpm,
        body.app_rpm,
        body.memory_mb,
        body.sleep_after_s,
        body.role.as_deref(),
    )
    .await
    .map(Json)
}
