//! Custom hostnames: list, add, remove. One hostname belongs to exactly one
//! app (`app_domain.hostname` is the primary key), and the edge only serves it
//! while its app is deployed and running — `host/caddy.rs` writes the route and
//! `host/edge.rs` answers the on-demand TLS gate.
//!
//! There is no DNS or ownership proof here: the operator points the hostname at
//! the edge, and a certificate is minted on first visit through the same
//! ask-gated path every platform hostname uses, so a hostname that does not
//! resolve to this server never gets one. Adding a hostname therefore only
//! *reserves* it for the app; it cannot serve another owner's domain.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::db;
use crate::error::ApiError;
use crate::lifecycle::hostname_ok;
use crate::AppState;

#[derive(Debug, serde::Deserialize)]
pub struct AddDomain {
    pub hostname: String,
}

/// Hostnames this platform answers for itself: the base domain and its
/// platform subdomains, plus every extra control hostname. An app may never
/// claim one — `Host` dispatch would otherwise fight the control plane.
fn platform_host(cfg: &crate::config::Config, hostname: &str) -> bool {
    let base = cfg.base_domain.to_lowercase();
    if hostname == base || hostname.ends_with(&format!(".{base}")) {
        return true;
    }
    cfg.control_extra_hosts
        .iter()
        .any(|extra| hostname == extra.trim().trim_matches('.').to_lowercase())
}

pub async fn list_domains(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
) -> impl IntoResponse {
    match db::list_domains_for(&state.pool, &app_id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn add_domain(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    Json(body): Json<AddDomain>,
) -> impl IntoResponse {
    let hostname = body.hostname.trim().trim_end_matches('.').to_lowercase();
    if !hostname_ok(&hostname) {
        return ApiError::bad("invalid hostname").into_response();
    }
    if platform_host(&state.config, &hostname) {
        return ApiError::bad("hostname belongs to the platform").into_response();
    }
    match db::get_app(&state.pool, &app_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    match db::domain_owner(&state.pool, &hostname).await {
        Ok(Some(owner)) if owner != app_id => {
            return ApiError::conflict("hostname is already in use").into_response();
        }
        Ok(_) => {}
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    if let Err(e) = db::add_domain(&state.pool, &app_id, &hostname).await {
        // The primary key is the final word on a concurrent claim.
        return ApiError::conflict(format!("hostname is already in use: {e}"))
            .into_response();
    }
    match db::list_domains_for(&state.pool, &app_id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn remove_domain(
    State(state): State<AppState>,
    Path((app_id, hostname)): Path<(String, String)>,
) -> impl IntoResponse {
    let hostname = hostname.trim().to_lowercase();
    match db::remove_domain(&state.pool, &app_id, &hostname).await {
        Ok(0) => ApiError::not_found("hostname is not attached to this app").into_response(),
        Ok(_) => match db::list_domains_for(&state.pool, &app_id).await {
            Ok(rows) => Json(rows).into_response(),
            Err(e) => ApiError::internal(e.to_string()).into_response(),
        },
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}
