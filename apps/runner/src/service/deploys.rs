//! Deploy history and rollback (the list/log reads plus the rollback spawn).

use crate::api_error::ApiError;
use crate::db;
use crate::host::deploy;
use crate::models::Deploy;
use crate::AppState;

use super::apps::app_or_404;

pub fn sha_valid(sha: &str) -> bool {
    (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit())
}

pub async fn list(state: &AppState, id: &str) -> Result<Vec<Deploy>, ApiError> {
    db::list_deploys(&state.pool, id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// One deploy's full build log (T1.7). Finished deploys never change, so
/// callers may cache this forever.
pub async fn log(state: &AppState, id: &str, deploy_id: &str) -> Result<String, ApiError> {
    let app = app_or_404(state, id).await?;
    match db::get_deploy_log(&state.pool, &app.id, deploy_id.trim()).await {
        Ok(Some(log)) => Ok(log),
        Ok(None) => Err(ApiError::not_found("deploy not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// Re-run the pipeline at an old successful tip bundle (immutable per-sha).
/// Returns the sha, spawned; progress follows on the deploys stream.
pub async fn rollback(state: &AppState, id: &str, sha: &str) -> Result<String, ApiError> {
    let sha = sha.trim().to_lowercase();
    if !sha_valid(&sha) {
        return Err(ApiError::bad("sha must be 7-40 hex chars"));
    }
    let app = app_or_404(state, id).await?;
    match db::get_success_deploy(&state.pool, &app.id, &sha).await {
        Ok(Some(_)) => {}
        Ok(None) => return Err(ApiError::not_found("no successful deploy at that sha")),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    let pool = state.pool.clone();
    let cfg = state.config.clone();
    let procs = state.procs.clone();
    let logs = state.logs.clone();
    let deploying = state.deploying.clone();
    let key = format!("git/{}/refs/heads/main/{sha}.bundle", app.slug);
    let sha_resp = sha.clone();
    // Explicit: rolling back to the live sha rebuilds it (a redeploy).
    tokio::spawn(async move {
        deploy::deploy_app(
            &pool,
            &cfg,
            &procs,
            &logs,
            &deploying,
            app,
            &key,
            Some(&sha),
            deploy::DeployTrigger::Explicit,
        )
        .await;
    });
    Ok(sha_resp)
}
