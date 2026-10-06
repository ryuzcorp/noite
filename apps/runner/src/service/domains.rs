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

use crate::api_error::ApiError;
use crate::config::Config;
use crate::db;
use crate::lifecycle::hostname_ok;
use crate::models::AppDomain;
use crate::AppState;

use super::apps::app_or_404;

/// Hostnames this platform answers for itself: the base domain and its
/// platform subdomains, plus every extra control hostname. An app may never
/// claim one — `Host` dispatch would otherwise fight the control plane.
fn platform_host(cfg: &Config, hostname: &str) -> bool {
    let base = cfg.base_domain.to_lowercase();
    if hostname == base || hostname.ends_with(&format!(".{base}")) {
        return true;
    }
    cfg.control_extra_hosts
        .iter()
        .any(|extra| hostname == extra.trim().trim_matches('.').to_lowercase())
}

pub async fn list(state: &AppState, app_id: &str) -> Result<Vec<AppDomain>, ApiError> {
    db::list_domains_for(&state.pool, app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn add(
    state: &AppState,
    app_id: &str,
    hostname: &str,
) -> Result<Vec<AppDomain>, ApiError> {
    let hostname = hostname.trim().trim_end_matches('.').to_lowercase();
    if !hostname_ok(&hostname) {
        return Err(ApiError::bad("invalid hostname"));
    }
    if platform_host(&state.config, &hostname) {
        return Err(ApiError::bad("hostname belongs to the platform"));
    }
    app_or_404(state, app_id).await?;
    match db::domain_owner(&state.pool, &hostname).await {
        Ok(Some(owner)) if owner != app_id => {
            return Err(ApiError::conflict("hostname is already in use"));
        }
        Ok(_) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    if let Err(e) = db::add_domain(&state.pool, app_id, &hostname).await {
        // The primary key is the final word on a concurrent claim.
        return Err(ApiError::conflict(format!(
            "hostname is already in use: {e}"
        )));
    }
    list(state, app_id).await
}

pub async fn remove(
    state: &AppState,
    app_id: &str,
    hostname: &str,
) -> Result<Vec<AppDomain>, ApiError> {
    let hostname = hostname.trim().to_lowercase();
    match db::remove_domain(&state.pool, app_id, &hostname).await {
        Ok(0) => Err(ApiError::not_found("hostname is not attached to this app")),
        Ok(_) => list(state, app_id).await,
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}
