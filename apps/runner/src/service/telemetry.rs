//! Instance telemetry admin surface: the effective state, the stored
//! preference, and the exact payload a send would post. One implementation
//! behind `GET`/`PUT
//! /v1/admin/telemetry` (REST).

use crate::api_error::ApiError;
use crate::db;
use crate::host::telemetry_report::{self, TelemetryStatus};
use crate::AppState;

pub async fn get(state: &AppState) -> Result<TelemetryStatus, ApiError> {
    status(state).await.map_err(ApiError::from_anyhow)
}

/// Store the operator's preference. While a kill switch locks telemetry the
/// preference still changes; the effective state does not.
pub async fn set(state: &AppState, enabled: bool) -> Result<TelemetryStatus, ApiError> {
    let stored = if enabled { "1" } else { "0" };
    db::set_setting(&state.pool, db::TELEMETRY_ENABLED, stored)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    status(state).await.map_err(ApiError::from_anyhow)
}

async fn status(state: &AppState) -> anyhow::Result<TelemetryStatus> {
    telemetry_report::status(&state.pool, &state.config, state.started_at).await
}
