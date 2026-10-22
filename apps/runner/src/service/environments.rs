//! Preview environments (ROADMAP, Preview environments): list, create from a
//! branch, delete, toggle public, redeploy, variable overrides, and the
//! workspace preview (`source.preview`).
//!
//! Role gates mirror `service::prs`: the control UI resolves the caller's app
//! role and passes it, and the runner re-checks it here. `view` reads, `push`
//! creates / deploys / previews / sets variables, `admin` deletes and flips an
//! environment public. `environments.*`, `domains.*` and `env.*` predate the
//! role-carrying surfaces and gate only in the UI; these are new, so they gate
//! here too.

use crate::api_error::ApiError;
use crate::db;
use crate::host::deploy::{self, DeployTarget, DeployTrigger};
use crate::host::env_label;
use crate::host::git_identity::Actor;
use crate::host::{env_teardown, forge, git_http, git_identity, web_commit};
use crate::models::{App, AppEnv, Environment, EnvironmentKind};
use crate::service::source::SourceCommitBody;
use crate::AppState;

use super::apps::app_or_404;
use super::env::name_valid;

/// Whether `role` satisfies `need`. `admin` implies `push` implies `view`.
pub fn role_ok(role: &str, need: &str) -> bool {
    match need {
        "view" => matches!(role, "view" | "push" | "admin"),
        "push" => matches!(role, "push" | "admin"),
        "admin" => role == "admin",
        _ => false,
    }
}

/// Enforce one gate. A missing role is a refusal, never a default: the caller
/// (the control UI) always knows its role, and an unknown caller must not
/// inherit `push`.
fn require(role: Option<&str>, need: &str) -> Result<(), ApiError> {
    match role {
        Some(role) if role_ok(role, need) => Ok(()),
        Some(role) => Err(ApiError::forbidden(format!(
            "role {role:?} may not {need} this app's environments"
        ))),
        None => Err(ApiError::forbidden(format!(
            "the {need} role is required for this operation"
        ))),
    }
}

pub async fn list(
    state: &AppState,
    id: &str,
    role: Option<&str>,
) -> Result<Vec<Environment>, ApiError> {
    require(role, "view")?;
    let app = app_or_404(state, id).await?;
    db::list_environments(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Load one environment of one app, or 404.
async fn env_or_404(state: &AppState, app_id: &str, env_id: &str) -> Result<Environment, ApiError> {
    match db::get_environment(&state.pool, env_id).await {
        Ok(Some(env)) if env.app_id == app_id => Ok(env),
        Ok(_) => Err(ApiError::not_found("environment not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// How many environments this app (and this install) may still create.
async fn check_caps(state: &AppState, app_id: &str) -> Result<(), ApiError> {
    let per_app = db::count_environments_for_app(&state.pool, app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if per_app >= i64::from(state.config.max_environments_per_app) {
        return Err(ApiError::conflict(format!(
            "environment limit reached ({} per app)",
            state.config.max_environments_per_app
        )));
    }
    let total = db::count_environments(&state.pool)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if total >= i64::from(state.config.max_environments) {
        return Err(ApiError::conflict(format!(
            "this install is at its environment limit ({}); delete one first",
            state.config.max_environments
        )));
    }
    Ok(())
}

/// The labels already taken in one app (the unique `(app_id, label)` index's
/// input, read before the insert so a collision gets a suffix instead of an
/// error).
async fn taken_labels(state: &AppState, app_id: &str) -> Result<Vec<String>, ApiError> {
    Ok(db::list_environments(&state.pool, app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .map(|e| e.label)
        .collect())
}

/// Create an environment from a branch and deploy its head. `main` is the app
/// itself and is refused.
pub async fn create(
    state: &AppState,
    id: &str,
    branch: &str,
    actor: Option<&Actor>,
    role: Option<&str>,
) -> Result<Environment, ApiError> {
    require(role, "push")?;
    let app = app_or_404(state, id).await?;
    let branch = branch.trim();
    if branch == forge::DEFAULT_BRANCH {
        return Err(ApiError::bad("main is the app itself, not an environment"));
    }
    if !forge::valid_branch_name(branch) {
        return Err(ApiError::bad(format!("invalid branch name {branch:?}")));
    }
    let git_ref = format!("refs/heads/{branch}");
    // Caps first: they are a plain count, and a user at the limit should hear
    // that rather than "no such branch" for one they were about to create.
    check_caps(state, &app.id).await?;
    // The branch must exist: an environment tracks a real ref, and this also
    // proves the mirror has its objects for the deploy below.
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    let sha = forge::resolve_ref(&bare, branch).await.map_err(|e| {
        let msg = format!("{e:#}");
        if msg.contains("not found") {
            ApiError::not_found(msg)
        } else {
            ApiError::bad(msg)
        }
    })?;
    let label = env_label::unique_label(
        &env_label::sanitize_label(branch),
        &taken_labels(state, &app.id).await?,
    );
    let (listen, internal) = db::alloc::next_ports_in(
        &state.pool,
        state.config.fleet_port_min,
        state.config.fleet_port_max,
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    let created_by = actor.map(|a| a.user_id.clone()).unwrap_or_default();
    let env = db::create_environment(
        &state.pool,
        &state.config,
        db::NewEnvironment {
            app_id: &app.id,
            slug: &app.slug,
            label: &label,
            kind: EnvironmentKind::Branch,
            git_ref: &git_ref,
            created_by: &created_by,
            listen,
            internal,
        },
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    // The new site has to exist before the fleet does, so the first request
    // reaches a route instead of the app's wildcard fallback.
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(error = %format!("{e:#}"), "caddy rewrite after environment create");
    }
    spawn_deploy(state, &app, env.clone(), &sha).await?;
    Ok(env)
}

pub async fn delete(
    state: &AppState,
    id: &str,
    env_id: &str,
    role: Option<&str>,
) -> Result<(), ApiError> {
    // Like app delete: a dropped HTTP handler must not cancel the teardown
    // halfway and leave the fleet, the prefix or the row behind (see
    // `service::detached`).
    let state = state.clone();
    let id = id.to_string();
    let env_id = env_id.to_string();
    let role = role.map(str::to_string);
    super::detached::run(format!("env:{env_id}"), async move {
        delete_inner(&state, &id, &env_id, role.as_deref()).await
    })
    .await
}

async fn delete_inner(
    state: &AppState,
    id: &str,
    env_id: &str,
    role: Option<&str>,
) -> Result<(), ApiError> {
    require(role, "admin")?;
    let app = app_or_404(state, id).await?;
    let env = env_or_404(state, &app.id, env_id).await?;
    env_teardown::teardown(&state.config, &state.pool, &state.procs, &state.logs, &env)
        .await
        .map_err(|e| ApiError::internal(format!("{e:#}")))?;
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(error = %format!("{e:#}"), "caddy rewrite after environment delete");
    }
    Ok(())
}

/// Toggle members-only / public.
pub async fn update(
    state: &AppState,
    id: &str,
    env_id: &str,
    public: bool,
    role: Option<&str>,
) -> Result<Environment, ApiError> {
    require(role, "admin")?;
    let app = app_or_404(state, id).await?;
    env_or_404(state, &app.id, env_id).await?;
    let env = db::set_environment_public(&state.pool, env_id, public)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found("environment not found"))?;
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(error = %format!("{e:#}"), "caddy rewrite after environment update");
    }
    Ok(env)
}

/// Re-deploy an environment at its ref's current head (explicit: the same sha
/// rebuilds). Returns the deploy row id and the sha; progress follows on the
/// deploy stream filtered by this environment.
pub async fn deploy(
    state: &AppState,
    id: &str,
    env_id: &str,
    role: Option<&str>,
) -> Result<(String, String), ApiError> {
    require(role, "push")?;
    let app = app_or_404(state, id).await?;
    let env = env_or_404(state, &app.id, env_id).await?;
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    let sha = forge::resolve_ref(&bare, &env.git_ref).await.map_err(|e| {
        let msg = format!("{e:#}");
        if msg.contains("not found") {
            ApiError::not_found(msg)
        } else {
            ApiError::bad(msg)
        }
    })?;
    let deploy_id = spawn_deploy(state, &app, env, &sha).await?;
    Ok((deploy_id, sha))
}

/// The ref-isolated head of a bundle written by a push (or a web commit) for
/// this environment, with the deploy row pre-created so a caller learns its id
/// immediately: the build itself runs on its own task.
async fn spawn_deploy(
    state: &AppState,
    app: &App,
    env: Environment,
    sha: &str,
) -> Result<String, ApiError> {
    // Mirror the hidden-ref shape: `git/<slug>/<ref>/<sha>.bundle`, written by
    // `after_receive` for every ref a write moved.
    let key = format!("git/{}/{}/{sha}.bundle", app.slug, env.git_ref);
    let deploy_id = db::upsert_deploy(
        &state.pool,
        None,
        &app.id,
        Some(&env.id),
        "building",
        Some(sha),
        "▸ queued\n",
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    let pool = state.pool.clone();
    let cfg = state.config.clone();
    let procs = state.procs.clone();
    let logs = state.logs.clone();
    let deploying = state.deploying.clone();
    let app_row = app.clone();
    let deploy_id_for_task = deploy_id.clone();
    let sha = sha.to_string();
    tokio::spawn(async move {
        deploy::deploy_app(
            &pool,
            &cfg,
            &procs,
            &logs,
            &deploying,
            app_row,
            DeployTarget::Environment(Box::new(env)),
            &key,
            Some(&sha),
            DeployTrigger::Explicit,
            Some(&deploy_id_for_task),
        )
        .await;
    });
    Ok(deploy_id)
}

/// One environment's variable overrides (the app's variables are inherited on
/// top).
pub async fn vars(
    state: &AppState,
    id: &str,
    env_id: &str,
    role: Option<&str>,
) -> Result<Vec<AppEnv>, ApiError> {
    require(role, "view")?;
    let app = app_or_404(state, id).await?;
    env_or_404(state, &app.id, env_id).await?;
    db::list_env_override(&state.pool, env_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn vars_set(
    state: &AppState,
    id: &str,
    env_id: &str,
    name: &str,
    value: &str,
    role: Option<&str>,
) -> Result<String, ApiError> {
    require(role, "push")?;
    let name = name.trim().to_string();
    if !name_valid(&name) {
        return Err(ApiError::bad(
            "name must match [A-Za-z_][A-Za-z0-9_]* (≤64)",
        ));
    }
    if value.len() > 32 * 1024 {
        return Err(ApiError::bad("value exceeds 32 KiB"));
    }
    let app = app_or_404(state, id).await?;
    env_or_404(state, &app.id, env_id).await?;
    db::set_env_override(&state.pool, env_id, &name, value)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(name)
}

pub async fn vars_delete(
    state: &AppState,
    id: &str,
    env_id: &str,
    name: &str,
    role: Option<&str>,
) -> Result<(), ApiError> {
    require(role, "push")?;
    if !name_valid(name) {
        return Err(ApiError::bad("invalid name"));
    }
    let app = app_or_404(state, id).await?;
    env_or_404(state, &app.id, env_id).await?;
    db::delete_env_override(&state.pool, env_id, name)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// What `source.preview` answers: the (user, branch) environment it deployed,
/// the commit it snapshotted, and the deploy row to stream.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PreviewResult {
    pub environment: Environment,
    pub sha: String,
    pub deploy_id: String,
}

/// The hidden ref one (user, branch) pair previews from. The user segment is
/// label-sanitized so an exotic user id cannot make an un-writable ref name,
/// and `refs/previews/` is never advertised or listed.
pub fn preview_ref(user_id: &str, branch: &str) -> String {
    format!(
        "{}{}/{branch}",
        git_http::PREVIEW_REF_PREFIX,
        env_label::sanitize_label(user_id)
    )
}

/// `source.preview`: snapshot the workspace's uncommitted changes as one commit
/// on top of the branch head, publish it to the (user, branch) hidden ref,
/// then deploy that environment (creating it on first use). The branch itself
/// is never moved and no pull request sees the commit.
pub async fn preview(
    state: &AppState,
    id: &str,
    body: &SourceCommitBody,
) -> Result<PreviewResult, ApiError> {
    require(body.role.as_deref(), "push")?;
    let app = app_or_404(state, id).await?;
    let branch = body.branch.as_deref().unwrap_or(forge::DEFAULT_BRANCH);
    if !forge::valid_branch_name(branch) {
        return Err(ApiError::bad(format!("invalid branch name {branch:?}")));
    }
    let git_ref = preview_ref(&body.actor.user_id, branch);
    let existing = db::get_environment_by_ref(&state.pool, &app.id, &git_ref)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let env = match existing {
        Some(env) => env,
        None => {
            check_caps(state, &app.id).await?;
            let label = env_label::unique_label(
                &env_label::workspace_label(branch, &body.actor.user_id),
                &taken_labels(state, &app.id).await?,
            );
            let (listen, internal) = db::alloc::next_ports_in(
                &state.pool,
                state.config.fleet_port_min,
                state.config.fleet_port_max,
            )
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
            let env = db::create_environment(
                &state.pool,
                &state.config,
                db::NewEnvironment {
                    app_id: &app.id,
                    slug: &app.slug,
                    label: &label,
                    kind: EnvironmentKind::Workspace,
                    git_ref: &git_ref,
                    created_by: &body.actor.user_id,
                    listen,
                    internal,
                },
            )
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
            if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
                tracing::warn!(error = %format!("{e:#}"), "caddy rewrite after preview create");
            }
            env
        }
    };
    // The workspace snapshot: files validated and committed exactly like a
    // browser edit, but onto the hidden ref.
    let actor = git_identity::noreply(&state.config, &body.actor.user_id, &body.actor.name);
    let mut files: Vec<web_commit::WebFile> = Vec::with_capacity(body.files.len());
    for f in &body.files {
        let encoding = f.encoding.unwrap_or(web_commit::WebEncoding::Utf8);
        let content = encoding.decode(&f.path, &f.content).map_err(commit_error)?;
        files.push(web_commit::WebFile {
            path: f.path.clone(),
            content,
        });
    }
    let moves: Vec<web_commit::WebMove> = body
        .moves
        .iter()
        .map(|m| web_commit::WebMove {
            from: m.from.clone(),
            to: m.to.clone(),
        })
        .collect();
    let sha = web_commit::web_commit_preview(
        state,
        &app,
        &actor,
        &body.message,
        web_commit::WebChanges {
            files: &files,
            moves: &moves,
            deletes: &body.deletes,
        },
        &git_ref,
        branch,
    )
    .await
    .map_err(commit_error)?;
    let deploy_id = spawn_deploy(state, &app, env.clone(), &sha).await?;
    Ok(PreviewResult {
        environment: env,
        sha,
        deploy_id,
    })
}

/// The commit vocabulary from `service::source`, reused for the preview
/// snapshot so both surfaces report the same way.
fn commit_error(e: anyhow::Error) -> ApiError {
    super::source::commit_error(e)
}
