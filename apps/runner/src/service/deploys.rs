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

/// Stop an in-flight deploy of `app_id`. A live run is signalled and records
/// its own failure (`ERROR: cancelled by the operator`); a row whose run is
/// already gone (finished between the read and the call, or the runner
/// restarted mid-build) is closed here so the UI never keeps a "building" row
/// that nothing is building.
pub async fn cancel(state: &AppState, id: &str, deploy_id: &str) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    let deploy_id = deploy_id.trim();
    let row = db::get_deploy(&state.pool, &app.id, deploy_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(ApiError::not_found("deploy not found"));
    };
    let in_flight = matches!(row.status.as_str(), "queued" | "building" | "deploying");
    if !in_flight {
        return Err(ApiError::conflict("deploy is not in flight"));
    }
    match crate::host::cancel::CANCELS.cancel(deploy_id) {
        crate::host::cancel::CancelOutcome::Signalled => return Ok(()),
        // The new generation is already on the fleet; only a new deploy (or a
        // rollback) replaces it now.
        crate::host::cancel::CancelOutcome::Committed => {
            return Err(ApiError::conflict("deploy is past the point of no return"));
        }
        crate::host::cancel::CancelOutcome::Missing => {}
    }
    // No live token: the process running this row is gone.
    let closed = db::mark_deploy_cancelled(&state.pool, &app.id, deploy_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if !closed {
        return Err(ApiError::conflict("deploy is not in flight"));
    }
    let summary = crate::host::cancel::CANCELLED;
    let outcome = match row.environment_id.as_deref() {
        Some(env_id) => {
            db::update_environment_status_if_wanted(
                &state.pool,
                env_id,
                crate::models::AppStatus::Failed.as_str(),
                Some(summary),
            )
            .await
        }
        None => {
            db::update_app_status_if_wanted(
                &state.pool,
                &app.id,
                crate::models::AppStatus::Failed.as_str(),
                Some(summary),
            )
            .await
        }
    };
    outcome.map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(())
}

/// A validated rollback ready to run: its queued deploy row already exists,
/// so a watcher sees the rollback before the spawned task is even scheduled.
pub struct PreparedRollback {
    pub deploy_id: String,
    pub sha: String,
    app: crate::models::App,
    /// Production, or the preview environment the sha came from.
    target: deploy::DeployTarget,
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
            target,
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
            target,
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
/// previous deploy is still finishing. `environment_id` scopes both the
/// proof (a successful row *in that target*) and the run (that environment's
/// fleet), so a preview sha never lands in production.
pub async fn prepare_rollback(
    state: &AppState,
    id: &str,
    sha: &str,
    environment_id: Option<&str>,
) -> Result<PreparedRollback, ApiError> {
    let sha = sha.trim().to_lowercase();
    if !sha_valid(&sha) {
        return Err(ApiError::bad("sha must be 7-40 hex chars"));
    }
    let app = app_or_404(state, id).await?;
    let environment = match environment_id {
        Some(env_id) => Some(super::environments::env_or_404(state, &app.id, env_id).await?),
        None => None,
    };
    match db::get_success_deploy(
        &state.pool,
        &app.id,
        &sha,
        environment.as_ref().map(|env| env.id.as_str()),
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return Err(ApiError::not_found("no successful deploy at that sha")),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    // The bundle lives under the ref the deploy came from: `git/<slug>/<ref>/`
    // for a preview (mirroring `after_receive`), the main tip for production.
    let key = match &environment {
        Some(env) => format!("git/{}/{}/{sha}.bundle", app.slug, env.git_ref),
        None => format!("git/{}/refs/heads/main/{sha}.bundle", app.slug),
    };
    let target = match environment {
        Some(env) => deploy::DeployTarget::Environment(Box::new(env)),
        None => deploy::DeployTarget::Production,
    };
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
        target.environment_id(),
        crate::models::DeployStatus::Queued.as_str(),
        Some(&sha),
        "▸ queued behind the app's running deploy\n",
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(PreparedRollback {
        deploy_id,
        sha,
        app,
        target,
        key,
        pool: state.pool.clone(),
        cfg: state.config.clone(),
        procs: state.procs.clone(),
        logs: state.logs.clone(),
        deploying: state.deploying.clone(),
    })
}

/// Re-run the pipeline at an old successful tip bundle (immutable per-sha),
/// for production or one preview environment. Returns the new deploy id and
/// the sha; progress follows on that target's stream.
pub async fn rollback(
    state: &AppState,
    id: &str,
    sha: &str,
    environment_id: Option<&str>,
) -> Result<(String, String), ApiError> {
    let prepared = prepare_rollback(state, id, sha, environment_id).await?;
    let out = (prepared.deploy_id.clone(), prepared.sha.clone());
    tokio::spawn(async move { prepared.run().await });
    Ok(out)
}
