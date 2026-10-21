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

/// Store the operator's preference (absent = on). (Re-)enabling hands one
/// immediate check to a background task and returns at once with
/// `checking: true`, so the admin save action never waits on GitHub; the
/// spawned check keeps the last result on failure. While the env force-off
/// locks the check, the preference still moves but nothing spawns.
pub async fn set(state: &AppState, enabled: bool) -> Result<UpdateStatus, ApiError> {
    match update_check::http_client() {
        Ok(client) if enabled && state.config.update_check_lock_reason().is_none() => {
            let url = update_check::RELEASES_URL.to_string();
            update_check::set(
                &state.pool,
                &state.config,
                enabled,
                move || {
                    let client = client.clone();
                    async move { update_check::fetch_releases(&client, &url).await }
                },
                |check| {
                    tokio::spawn(check);
                },
            )
            .await
            .map_err(ApiError::from_anyhow)
        }
        Ok(_) | Err(_) => {
            if enabled {
                tracing::debug!("update check: no http client at enable; stored only");
            }
            update_check::set_stored(&state.pool, &state.config, enabled)
                .await
                .map_err(ApiError::from_anyhow)
        }
    }
}
