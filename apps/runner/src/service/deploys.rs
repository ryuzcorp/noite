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
/// its own `cancelled` row (`ERROR: cancelled by the operator`); a row whose
/// run is already gone (finished between the read and the call, or the runner
/// restarted mid-build) is closed here so the UI never keeps a "building" row
/// that nothing is building. Either way the row is `cancelled`, not `failed`:
/// nothing failed, the operator stopped it.
pub async fn cancel(state: &AppState, id: &str, deploy_id: &str) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    let deploy_id = deploy_id.trim();
    let row = db::get_deploy(&state.pool, &app.id, deploy_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(row) = row else {
        return Err(ApiError::not_found("deploy not found"));
    };
    let in_flight = row.status.is_in_flight();
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
            db::write_environment_status(
                &state.pool,
                env_id,
                crate::models::AppStatus::Failed,
                Some(summary),
                crate::models::WriteGuard::Wanted,
            )
            .await
        }
        None => {
            db::write_app_status(
                &state.pool,
                &app.id,
                crate::models::AppStatus::Failed,
                Some(summary),
                None,
                crate::models::WriteGuard::Wanted,
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
    /// The tip bundle the run reads: the ref the successful deploy came from.
    pub key: String,
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
    let success = match db::get_success_deploy(
        &state.pool,
        &app.id,
        &sha,
        environment.as_ref().map(|env| env.id.as_str()),
    )
    .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return Err(ApiError::not_found("no successful deploy at that sha")),
        Err(e) => return Err(ApiError::internal(e.to_string())),
    };
    // The bundle lives under the ref the deploy came from: `git/<slug>/<ref>/`
    // for a preview (mirroring `after_receive`); for production the main tip —
    // or the branch a one-off branch deploy recorded, so rolling back to its
    // sha fetches the bundle that exists instead of assuming `refs/heads/main`.
    let reference = match &environment {
        Some(env) => env.git_ref.clone(),
        None => {
            // Any branch success at this sha names the ref, not only the newest
            // row: after a rollback/redeploy of that sha the newest success is
            // a `rollback` row, which would otherwise fall back to main.
            let branch = if success.intent == crate::models::DeployIntent::Branch {
                success.actor.clone()
            } else {
                db::get_success_branch_deploy(&state.pool, &app.id, &sha)
                    .await
                    .map_err(|e| ApiError::internal(e.to_string()))?
                    .and_then(|row| row.actor)
            };
            recorded_branch_ref(branch.as_deref())
                .unwrap_or("refs/heads/main")
                .to_string()
        }
    };
    let key = format!("git/{}/{}/{sha}.bundle", app.slug, reference);
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
    // The row records why it exists: `rollback`, so the history and the API
    // can tell it apart from a push.
    let deploy_id = db::queue_deploy(
        &state.pool,
        &app.id,
        target.environment_id(),
        crate::models::DeployIntent::Rollback,
        &sha,
        None,
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

/// A validated branch deploy whose queued row already exists: a watcher sees
/// it before the spawned task is even scheduled.
pub struct PreparedBranchDeploy {
    pub deploy_id: String,
    pub sha: String,
    /// The tip bundle the run reads: that branch's own ref, never production's.
    pub key: String,
    app: crate::models::App,
    pool: sqlx::SqlitePool,
    cfg: std::sync::Arc<crate::config::Config>,
    procs: crate::host::supervisor::ProcMap,
    logs: crate::host::logs::LogState,
    deploying: deploy::Deploying,
}

impl PreparedBranchDeploy {
    /// Build the branch's tip into production. Explicit: a branch tip equal to
    /// the live sha still builds, the way Redeploy does.
    pub async fn run(self) {
        let Self {
            deploy_id,
            sha,
            key,
            app,
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

/// Resolve `reference` to one branch's current tip and pre-create its deploy
/// row. The row records `DeployIntent::Branch` and the branch ref in `actor`,
/// so the history reads `Deploy <branch>@<sha>`.
pub async fn prepare_branch_deploy(
    state: &AppState,
    id: &str,
    reference: &str,
    role: Option<&str>,
) -> Result<PreparedBranchDeploy, ApiError> {
    // The UI's Deploy button is the same operator surface as Redeploy, so it
    // carries the same push gate.
    super::environments::require_push(role)?;
    let app = app_or_404(state, id).await?;
    // Branch protection is the admin's word on how code reaches production:
    // with a PR rule on, a push member must open a pull request instead of
    // deploying a branch around it (the same stance as a `main` push and the
    // web-commit path). Admins keep the override.
    let rules = crate::db::prs::branch_rules(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if (rules.require_pr != 0 || rules.required_approvals > 0) && role != Some("admin") {
        return Err(ApiError::forbidden(
            "branch protection is on: open a pull request, or ask an admin to deploy a branch",
        ));
    }
    let branch = branch_ref(reference)?;
    let bare = crate::host::forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    let sha = crate::host::forge::resolve_user_ref(&bare, &branch)
        .await
        .map_err(|e| {
            let msg = format!("{e:#}");
            if msg.contains("not found") {
                ApiError::not_found(msg)
            } else {
                ApiError::bad(msg)
            }
        })?;
    // The bundle `after_receive` wrote for that branch's tip, never the
    // production one: the branch's commit is materialized from its own ref.
    let key = format!("git/{}/{}/{sha}.bundle", app.slug, branch);
    let deploy_id = db::queue_deploy(
        &state.pool,
        &app.id,
        None,
        crate::models::DeployIntent::Branch,
        &sha,
        Some(branch.as_str()),
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(PreparedBranchDeploy {
        deploy_id,
        sha,
        key,
        app,
        pool: state.pool.clone(),
        cfg: state.config.clone(),
        procs: state.procs.clone(),
        logs: state.logs.clone(),
        deploying: state.deploying.clone(),
    })
}

/// Deploy one branch's current tip to production, once. The production
/// branch itself (and the automatic tip pipeline) is not touched: a later
/// push to it deploys exactly as before, which is the rollback rule in
/// `host::loop_::sweep_needs_tip` (a git tip the history already built is
/// never pulled back over a release).
///
/// `reference` is a branch name (`main`) or its full ref
/// (`refs/heads/main`); it goes through the same caller-reference guard the
/// source views use, so a reserved namespace can never be resolved here.
/// Returns the new deploy id and the sha; progress follows on the deploys
/// stream.
pub async fn deploy_branch(
    state: &AppState,
    id: &str,
    reference: &str,
    role: Option<&str>,
) -> Result<(String, String), ApiError> {
    let prepared = prepare_branch_deploy(state, id, reference, role).await?;
    let out = (prepared.deploy_id.clone(), prepared.sha.clone());
    tokio::spawn(async move { prepared.run().await });
    Ok(out)
}

/// A branch deploy's recorded ref, validated before it becomes an S3 key: a
/// stored row must not be able to point the bundle read outside the app's own
/// branch namespace. `None` falls back to the production ref.
fn recorded_branch_ref(reference: Option<&str>) -> Option<&str> {
    let reference = reference?;
    let name = reference.strip_prefix("refs/heads/")?;
    if !crate::host::forge::valid_branch_name(name)
        || crate::host::forge::is_reserved_ref(reference)
    {
        return None;
    }
    Some(reference)
}

/// The full branch ref for a caller's reference: a branch name gains the
/// `refs/heads/` prefix, an already-qualified branch ref is kept. Anything
/// under another `refs/` namespace (tags, hidden previews) is refused here so
/// the history label and the bundle key always name a branch. A name that
/// looks like a sha (`deadbeef`, `20240101`) is still a branch name: the
/// picker only sends branches, and resolution below has no sha fallback.
fn branch_ref(reference: &str) -> Result<String, ApiError> {
    let name = reference.trim();
    if name.is_empty() {
        return Err(ApiError::bad("branch is required"));
    }
    let refname = if name.starts_with("refs/heads/") {
        name.to_string()
    } else if name.starts_with("refs/") {
        return Err(ApiError::bad("deploy ref must be a branch"));
    } else {
        format!("refs/heads/{name}")
    };
    Ok(refname)
}

/// Re-run the pipeline at an old successful tip bundle (immutable per-sha),
/// for production or one preview environment. Returns the new deploy id and
/// the sha; progress follows on that target's stream.
pub async fn rollback(
    state: &AppState,
    id: &str,
    sha: &str,
    environment_id: Option<&str>,
    role: Option<&str>,
) -> Result<(String, String), ApiError> {
    // A preview target is an environment operation, so it carries the same
    // push-role gate `environments.deploy` enforces; production rollback is
    // unchanged (the control already gates it).
    if environment_id.is_some() {
        super::environments::require_push(role)?;
    }
    let prepared = prepare_rollback(state, id, sha, environment_id).await?;
    let out = (prepared.deploy_id.clone(), prepared.sha.clone());
    tokio::spawn(async move { prepared.run().await });
    Ok(out)
}
