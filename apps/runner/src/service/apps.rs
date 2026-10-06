//! App CRUD + sleep: the operations behind `apps.*` (RPC) and
//! `/v1/apps...` (REST).

use std::time::Duration;

use crate::api_error::ApiError;
use crate::db;
use crate::host::{deploy, purge, rename, sleep};
use crate::lifecycle::slug_ok;
use crate::models::{App, DesiredState};
use crate::AppState;

/// The single "load the app or answer 404" helper every domain uses, so the
/// not-found body is uniform across REST and RPC.
pub async fn app_or_404(state: &AppState, id: &str) -> Result<App, ApiError> {
    match db::get_app(&state.pool, id).await {
        Ok(Some(app)) => Ok(app),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn list(state: &AppState) -> Result<Vec<App>, ApiError> {
    db::list_apps(&state.pool)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn get(state: &AppState, id: &str) -> Result<App, ApiError> {
    app_or_404(state, id).await
}

pub async fn get_by_slug(state: &AppState, slug: &str) -> Result<App, ApiError> {
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(app)) => Ok(app),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn create(
    state: &AppState,
    name: &str,
    slug: &str,
    user_id: Option<&str>,
) -> Result<App, ApiError> {
    let name = name.trim().to_string();
    let slug = slug.trim().to_lowercase();
    if name.is_empty() || !slug_ok(&slug) {
        return Err(ApiError::bad("invalid name/slug"));
    }
    match db::get_app_by_slug(&state.pool, &slug).await {
        Ok(Some(_)) => return Err(ApiError::conflict("slug already taken")),
        Ok(None) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    // Always wipe leftover S3/local data for this slug before the new row lands.
    if let Err(e) = purge::purge_slug(&state.config, &state.procs, &state.logs, &slug).await {
        return Err(ApiError::internal(format!(
            "failed to clear slug data: {e:#}"
        )));
    }
    let (listen, internal) = db::alloc::next_ports_in(
        &state.pool,
        state.config.fleet_port_min,
        state.config.fleet_port_max,
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    let subdomain = format!("{slug}.{}", state.config.base_domain);
    let owner = user_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local");
    if owner != "local" {
        match db::count_apps_for_user(&state.pool, owner).await {
            Ok(count) if count >= i64::from(state.config.max_apps_per_user) => {
                return Err(ApiError::conflict(format!(
                    "app limit reached ({} per account)",
                    state.config.max_apps_per_user
                )));
            }
            Ok(_) => {}
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
    // No credential row: only a scoped provider (Phase 4) mints one.
    db::create_app(
        &state.pool,
        &state.config,
        db::NewApp {
            internal,
            listen,
            name: &name,
            slug: &slug,
            subdomain: &subdomain,
            user_id: owner,
        },
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn patch(
    state: &AppState,
    id: &str,
    desired: Option<&str>,
) -> Result<App, ApiError> {
    if let Some(desired) = desired {
        let Some(ds) = DesiredState::parse(desired) else {
            return Err(ApiError::bad("desiredState must be running|stopped"));
        };
        db::patch_app_desired(&state.pool, id, ds.as_str())
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
    }
    app_or_404(state, id).await
}

pub async fn rename(
    state: &AppState,
    id: &str,
    name: Option<&str>,
    slug: Option<&str>,
) -> Result<App, ApiError> {
    let name = name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let slug = slug.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if name.is_none() && slug.is_none() {
        return Err(ApiError::bad("name or slug required"));
    }
    if let Some(s) = &slug {
        if !slug_ok(s) {
            return Err(ApiError::bad("invalid slug"));
        }
        match db::get_app_by_slug(&state.pool, s).await {
            Ok(Some(other)) if other.id != id => {
                return Err(ApiError::conflict("slug already taken"))
            }
            Ok(_) => {}
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
    match rename::rename_app(
        &state.config,
        &state.pool,
        &state.procs,
        &state.logs,
        &state.deploying,
        id,
        name.as_deref(),
        slug.as_deref(),
    )
    .await
    {
        Ok(app) => Ok(app),
        // `rename_app` reports intent as anyhow strings; keep the mapping here
        // so REST and RPC cannot drift on it.
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("deploy in flight") {
                Err(ApiError::conflict(msg))
            } else if msg.contains("invalid slug") || msg.contains("app not found") {
                Err(ApiError::bad(msg))
            } else {
                Err(ApiError::internal(msg))
            }
        }
    }
}

pub async fn delete(state: &AppState, id: &str) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    // Same lock as deploy: wait out an in-flight build, then purge exclusively.
    if !deploy::claim_wait(&state.deploying, &app.id, Duration::from_secs(120)).await {
        return Err(ApiError::conflict("deploy in flight; retry delete shortly"));
    }
    let purge_result = purge::purge_slug(&state.config, &state.procs, &state.logs, &app.slug).await;
    deploy::release(&state.deploying, &app.id).await;
    if let Err(e) = purge_result {
        return Err(ApiError::internal(format!(
            "failed to purge app data: {e:#}"
        )));
    }
    db::delete_app(&state.pool, id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    // Both transports revoke: the RPC path used to skip this and leak the row.
    let _ = crate::host::credentials::revoke(&state.pool, id).await;
    Ok(())
}

/// Park an app now, skipping the idle check. `false` = it does not qualify.
pub async fn sleep(state: &AppState, id: &str) -> Result<bool, ApiError> {
    sleep::sleep_app(&state.pool, &state.config, &state.procs, id, true)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}
