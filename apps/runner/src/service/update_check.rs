//! Opt-out update-notice admin surface: the effective state, the stored
//! preference, and the newest promoted release the runner has seen. One
//! implementation behind `instance.update_status`/`instance.update_set`
//! (RPC) and `GET`/`PUT /v1/admin/update` (REST).

use crate::api_error::ApiError;
use crate::host::update_check::{self, UpdateStatus};
use crate::AppState;

pub async fn get(state: &AppState) -> Result<UpdateStatus, ApiError> {
    update_check::status(&state.pool, &state.config)
        .await
        .map_err(ApiError::from_anyhow)
}

/// Store the operator's preference (absent = on). (Re-)enabling triggers one
/// immediate check, bounded by the fetch timeout, so the banner can appear
/// without waiting for the next hourly tick; a failed fetch keeps the last
/// result. While the env force-off locks the check, the preference still
/// moves but no fetch runs.
pub async fn set(state: &AppState, enabled: bool) -> Result<UpdateStatus, ApiError> {
    update_check::set(&state.pool, &state.config, enabled)
        .await
        .map_err(ApiError::from_anyhow)
}
