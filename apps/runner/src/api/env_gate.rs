//! Environment access grant (`environments.grant`): the REST mirror of the RPC
//! the control UI's `/api/env-auth` route calls before it redirects a browser
//! into a members-only environment (host/env_gate.rs).

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::service;
use crate::AppState;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantBody {
    pub user_id: String,
}

pub async fn grant_environment(
    State(state): State<AppState>,
    Path((id, env_id)): Path<(String, String)>,
    Json(body): Json<GrantBody>,
) -> impl IntoResponse {
    service::env_gate::grant(&state, &id, &env_id, &body.user_id)
        .await
        .map(Json)
}
