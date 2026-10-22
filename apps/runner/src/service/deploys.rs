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

/// Deploy history, filtered by target: `environment_id = None` is the app's
/// production history, `Some` one preview environment's (ROADMAP, the
/// Deployments tab filters by environment).
pub async fn list(
    state: &AppState,
    id: &str,
    environment_id: Option<&str>,
) -> Result<Vec<Deploy>, ApiError> {
    db::list_deploys(&state.pool, id, environment_id)
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

/// A validated rollback ready to run: its queued deploy row already exists,
/// so a watcher sees the rollback before the spawned task is even scheduled.
pub struct PreparedRollback {
    pub deploy_id: String,
    pub sha: String,
    app: crate::models::App,
    key: String,
    pool: sqlx::SqlitePool,
    cfg: std::sync::Arc<crate::config::Config>,
    procs: crate::host::supervisor::ProcMap,
    logs: crate::host::logs::LogState,
    deploying: deploy::Deploying,
}

impl PreparedRollback {
    /// Re-run the pipeline at the old sha. Queued behind the app's in-flight
    /// deploy (`claim_wait`) instead of skipping like an unrowed tip deploy.
    /// Explicit: rolling back to the live sha rebuilds it (a redeploy).
    pub async fn run(self) {
        let Self {
            deploy_id,
            sha,
            app,
            key,
            pool,
            cfg,
            procs,
            logs,
            deploying,
        } = self;
        deploy::deploy_app(
            &pool,
            &cfg,
            &procs,
            &logs,
            &deploying,
            app,
            deploy::DeployTarget::Production,
            &key,
            Some(&sha),
            deploy::DeployTrigger::Explicit,
            Some(&deploy_id),
        )
        .await;
    }
}

/// Validate the sha and pre-create the rollback's queued deploy row, so a
/// caller watching the stream sees the rollback even while the app's
/// previous deploy is still finishing.
pub async fn prepare_rollback(
    state: &AppState,
    id: &str,
    sha: &str,
) -> Result<PreparedRollback, ApiError> {
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
    let key = format!("git/{}/refs/heads/main/{sha}.bundle", app.slug);
    // A caller watches this deploy (the UI stream, the e2e `waitForDeploy`):
    // without its own row a rollback issued while the previous deploy still
    // holds the app's lock silently skips (`claim` fails) after answering
    // ok, and the watcher waits on a deploy that never started. A background
    // tip deploy has no row and skips; the next reconcile tick picks the tip
    // up again.
    let deploy_id = db::upsert_deploy(
        &state.pool,
        None,
        &app.id,
        None,
        "building",
        Some(&sha),
        "▸ queued\n",
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(PreparedRollback {
        deploy_id,
        sha,
        app,
        key,
        pool: state.pool.clone(),
        cfg: state.config.clone(),
        procs: state.procs.clone(),
        logs: state.logs.clone(),
        deploying: state.deploying.clone(),
    })
}

/// Re-run the pipeline at an old successful tip bundle (immutable per-sha).
/// Returns the new deploy id and the sha; progress follows on the stream.
pub async fn rollback(state: &AppState, id: &str, sha: &str) -> Result<(String, String), ApiError> {
    let prepared = prepare_rollback(state, id, sha).await?;
    let out = (prepared.deploy_id.clone(), prepared.sha.clone());
    tokio::spawn(async move { prepared.run().await });
    Ok(out)
}
