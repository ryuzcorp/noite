//! Per-app edge rate limits (`limits.*` RPC; the settings panel's source).

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::config::Config;
use crate::db;
use crate::models::AppLimit;
use crate::AppState;

use super::apps::app_or_404;

/// Ceiling on a per-app edge limit (requests per minute): past this the
/// module's per-client ring buffer stops being small.
const MAX_EDGE_RPM: i64 = 600_000;

/// The platform defaults an app's limits fall back to.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LimitDefaults {
    pub client_rpm: u32,
    pub app_rpm: u32,
}

/// An app's edge limits as the settings panel shows them: its own values
/// (null = default) beside the platform defaults they fall back to.
/// `perClient` is false behind a proxy the edge does not trust, where
/// per-client limits cannot apply (`Config::edge_sees_clients`).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LimitsView {
    pub client_rpm: Option<i64>,
    pub app_rpm: Option<i64>,
    pub per_client: bool,
    pub defaults: LimitDefaults,
}

fn limits_view(cfg: &Config, limit: &AppLimit) -> LimitsView {
    LimitsView {
        client_rpm: limit.client_rpm,
        app_rpm: limit.app_rpm,
        per_client: cfg.edge_sees_clients(),
        defaults: LimitDefaults {
            client_rpm: cfg.edge.client_rpm,
            app_rpm: cfg.edge.app_rpm,
        },
    }
}

pub async fn get(state: &AppState, id: &str) -> Result<LimitsView, ApiError> {
    let app = app_or_404(state, id).await?;
    match db::get_app_limit(&state.pool, &app.id).await {
        Ok(limit) => Ok(limits_view(&state.config, &limit)),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn set(
    state: &AppState,
    id: &str,
    client_rpm: Option<i64>,
    app_rpm: Option<i64>,
) -> Result<LimitsView, ApiError> {
    // Requests per minute; null = the platform default, 0 = off.
    let in_range = |v: Option<i64>| v.is_none_or(|v| (0..=MAX_EDGE_RPM).contains(&v));
    if !in_range(client_rpm) || !in_range(app_rpm) {
        return Err(ApiError::bad(format!(
            "limits must be between 0 and {MAX_EDGE_RPM} requests per minute"
        )));
    }
    let app = app_or_404(state, id).await?;
    let limit = AppLimit {
        app_id: app.id.clone(),
        client_rpm,
        app_rpm,
    };
    db::set_app_limit(&state.pool, &limit)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(limits_view(&state.config, &limit))
}
