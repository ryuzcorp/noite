//! Environment access grants (`environments.grant`): the short-lived token the
//! control UI redirects a browser with, on its way to the environment's own
//! `/__noite/auth` (host/env_gate.rs).
//!
//! The control UI is the only party that knows the session and the app's
//! `view` role, and the runner has no session of its own — so this RPC is the
//! one thing the UI cannot do for itself: it turns "this viewer may see this
//! environment" into a token only the runner can mint.

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::host::env_gate;
use crate::AppState;

use super::apps::app_or_404;

/// The token the control UI hands back on `<env host>/__noite/auth?token=`.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvGrant {
    pub token: String,
}

/// Mint the hand-back token for one environment of one app.
pub async fn grant(
    state: &AppState,
    app_id: &str,
    env_id: &str,
    user_id: &str,
) -> Result<EnvGrant, ApiError> {
    let app = app_or_404(state, app_id).await?;
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err(ApiError::bad("userId is required"));
    }
    let env = match crate::db::get_environment(&state.pool, env_id).await {
        Ok(Some(env)) => env,
        Ok(None) => return Err(ApiError::not_found("no such environment")),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    // The environment id is globally unique, so a token must be minted through
    // the app it routes on: a request naming another app's environment is a
    // caller bug (or a probe), never a grant.
    if env.app_id != app.id {
        return Err(ApiError::not_found("no such environment"));
    }
    Ok(EnvGrant {
        token: env_gate::mint_grant(&state.config, &env.id, user_id),
    })
}
