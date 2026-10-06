//! Tenant env vars (`.dev.vars` model): list/set/delete. Values are injected
//! into build, release-command, and fleet env; reserved platform names are
//! filtered at inject time (see db::tenant_env).

use crate::api_error::ApiError;
use crate::db;
use crate::models::AppEnv;
use crate::AppState;

use super::apps::app_or_404;

pub fn name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .enumerate()
            .all(|(i, c)| c == '_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

pub async fn list(state: &AppState, id: &str) -> Result<Vec<AppEnv>, ApiError> {
    let app = app_or_404(state, id).await?;
    // Values included: single-operator premise, same posture as the rest of the runner API.
    db::list_env(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Set one variable; returns its canonical (trimmed) name.
pub async fn set(
    state: &AppState,
    id: &str,
    name: &str,
    value: &str,
) -> Result<String, ApiError> {
    let name = name.trim().to_string();
    if !name_valid(&name) {
        return Err(ApiError::bad("name must match [A-Za-z_][A-Za-z0-9_]* (≤64)"));
    }
    if value.len() > 32 * 1024 {
        return Err(ApiError::bad("value exceeds 32 KiB"));
    }
    let app = app_or_404(state, id).await?;
    db::set_env(&state.pool, &app.id, &name, value)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(name)
}

pub async fn delete(state: &AppState, id: &str, name: &str) -> Result<(), ApiError> {
    if !name_valid(name) {
        return Err(ApiError::bad("invalid name"));
    }
    let app = app_or_404(state, id).await?;
    db::delete_env(&state.pool, &app.id, name)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}
