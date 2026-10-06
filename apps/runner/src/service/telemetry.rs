//! Instance telemetry admin surface: the effective state, the stored
//! preference, and the exact payload a send would post. One implementation
//! behind `telemetry.get`/`telemetry.set` (RPC) and `GET`/`PUT
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
    let pool = &state.pool;
    let cfg = &state.config;
    let now = chrono::Utc::now();
    let setting = db::get_setting(pool, db::TELEMETRY_ENABLED).await?.as_deref() != Some("0");
    let last_sent_at = db::get_setting(pool, db::TELEMETRY_LAST_SENT_AT).await?;
    let lock_reason = cfg.telemetry_lock_reason();
    let locked = lock_reason.is_some();
    // The preview is the payload a send right now would POST, so it carries a
    // live user count (bounded at 5 s) even while locked.
    let users = telemetry_report::control_users(cfg).await;
    let facts = telemetry_report::gather(pool, cfg, state.started_at, now, users).await?;
    Ok(TelemetryStatus {
        enabled: setting && !locked,
        setting,
        locked,
        lock_reason: lock_reason.map(str::to_string),
        last_sent_at,
        install_id: facts.install_id.clone(),
        preview: telemetry_report::build_event(&facts),
    })
}
