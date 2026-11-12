//! App CRUD + sleep: the operations behind `apps.*` (RPC) and
//! `/v1/apps...` (REST).

use std::sync::LazyLock;
use std::time::Duration;

use crate::api_error::ApiError;
use crate::db;
use crate::host::{deploy, git_http, import, logs, purge, rename, sleep, supervisor};
use crate::lifecycle::slug_ok;
use crate::models::{App, AppSource, AppStatus, DesiredState, WriteGuard};
use crate::AppState;

/// Serializes the per-account quota decision with the row insert (NOITE-APPS-001):
/// the quota is a count-then-insert, so two creates for one account could both
/// slip under the limit. It is deliberately the *only* thing this lock covers,
/// and it is taken after the slug lock — nothing acquires a slug guard while
/// holding it, so a create for slug A can never wait on a create or delete for
/// slug B. Slug exclusivity needs no global lock: create, rename and delete all
/// hold that slug's `push_guard`. Lock order: `AppLock` → slug guard →
/// `QUOTA_LOCK`.
static QUOTA_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// What a failing operation tells its caller: the step, a failure class in
/// tenant words, and a short ref whose full chain (store error text, bucket,
/// work-dir path, stderr) is in the runner log. The raw detail is never part of
/// the client message: prefixes, bucket names and local paths are internals,
/// and a transport error can carry a presigned URL (review finding, 2026-11-12).
fn step_failure(step: &str, detail: &str) -> String {
    let id = crate::models::new_id();
    let reference = &id[..8];
    tracing::warn!(reference, step, error = detail, "app request step failed");
    format!("{step}: {} (ref {reference})", failure_class(detail))
}

/// The failure class a step reports, from the raw chain. Kept coarse on
/// purpose: it tells the tenant what they can do (retry now, retry later, ask
/// the operator), never which path or bucket broke.
fn failure_class(detail: &str) -> &'static str {
    let text = detail.to_ascii_lowercase();
    if text.contains("timed out") || text.contains("timeout") {
        "timed out"
    } else if text.contains("accessdenied")
        || text.contains("access denied")
        || text.contains("forbidden")
        || text.contains("403")
    {
        "the storage service denied the request"
    } else if text.contains("notempty") || text.contains("not empty") {
        "the data is not empty yet"
    } else if text.contains("nosuchbucket") || text.contains("not found") || text.contains("404") {
        "the storage service could not find the data"
    } else if text.contains("connect")
        || text.contains("transport")
        || text.contains("unavailable")
        || text.contains("slowdown")
        || text.contains("503")
        || text.contains("502")
    {
        "the storage service is unavailable"
    } else {
        "an internal error"
    }
}

/// Fill the derived fields of a row on its way out: [`App::fleet_hold`] (the
/// supervisor's crash or OOM backoff, process state) and [`App::auto_deploy`]
/// (the automatic-deploy budget, derived from the deploy rows). Neither is a
/// column, so every read that answers a client annotates here — one helper so
/// REST, RPC and the state stream cannot disagree about whether an app is
/// held or paused.
async fn with_hold(state: &AppState, mut app: App) -> App {
    crate::host::supervisor::annotate_holds(&state.procs, std::slice::from_mut(&mut app)).await;
    annotate_auto_deploy(state, std::slice::from_mut(&mut app)).await;
    app
}

/// Fill each app's automatic-deploy state from its production deploy rows.
async fn annotate_auto_deploy(state: &AppState, apps: &mut [App]) {
    crate::host::auto_deploy::annotate_apps(&state.pool, apps).await;
}

/// The single "load the app or answer 404" helper every domain uses, so the
/// not-found body is uniform across REST and RPC.
pub async fn app_or_404(state: &AppState, id: &str) -> Result<App, ApiError> {
    match db::get_app(&state.pool, id).await {
        Ok(Some(app)) => Ok(with_hold(state, app).await),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn list(state: &AppState) -> Result<Vec<App>, ApiError> {
    let mut apps: Vec<App> = db::list_apps(&state.pool)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .filter(|app| !deleting(&app.id))
        .collect();
    crate::host::supervisor::annotate_holds(&state.procs, &mut apps).await;
    annotate_auto_deploy(state, &mut apps).await;
    Ok(apps)
}

pub async fn get(state: &AppState, id: &str) -> Result<App, ApiError> {
    let app = app_or_404(state, id).await?;
    if deleting(&app.id) {
        return Err(ApiError::not_found("app not found"));
    }
    Ok(app)
}

pub async fn get_by_slug(state: &AppState, slug: &str) -> Result<App, ApiError> {
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(app)) if !deleting(&app.id) => Ok(with_hold(state, app).await),
        Ok(_) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn create(
    state: &AppState,
    name: &str,
    slug: &str,
    user_id: Option<&str>,
    source: Option<&AppSource>,
) -> Result<App, ApiError> {
    let name = name.trim().to_string();
    let slug = slug.trim().to_lowercase();
    if name.is_empty() || !slug_ok(&state.config, &slug) {
        return Err(ApiError::bad("invalid name/slug"));
    }
    // The purge of a reused slug can outlast the control plane's lifecycle
    // bound (a deleted app with a large D1/telemetry history), and a caller
    // that aborts must not cancel the create halfway: the row would never
    // land while the prefix was partly deleted. Run it as its own task; a
    // dropped caller only drops the waiter, and the retry finds the row.
    let state = state.clone();
    let user_id = user_id.map(str::to_string);
    let source = source.cloned();
    super::detached::run(format!("create:{slug}"), async move {
        let out = create_inner(&state, &name, &slug, user_id.as_deref(), source.as_ref()).await;
        if let Err(e) = &out {
            tracing::warn!(slug = %slug, error = %e, "app create failed");
        }
        out
    })
    .await
}

async fn create_inner(
    state: &AppState,
    name: &str,
    slug: &str,
    user_id: Option<&str>,
    source: Option<&AppSource>,
) -> Result<App, ApiError> {
    // A2/A3: refuse a bad import URL before anything is created — the async
    // task only ever runs a source this validated.
    let git_source = match source {
        Some(AppSource::Git(git)) => {
            import::github_url(&git.url).map_err(ApiError::bad)?;
            if let Some(reference) = &git.reference {
                import::import_ref(reference).map_err(ApiError::bad)?;
            }
            if let Some(path) = &git.path {
                import::import_path(path).map_err(ApiError::bad)?;
            }
            Some(git)
        }
        Some(AppSource::Blank) | None => None,
    };
    // A background purge of this slug (the app that held it was just deleted)
    // asks to end before we queue on the slug lock: the wipe yields at its next
    // batch, so a re-create never waits out a heavy wipe. We run the wipe
    // ourselves below, under the lock, so nothing is skipped.
    purge::stop(slug);
    // R-12: the purge destroys the same `git/<slug>/` + `fleets/<slug>/`
    // prefixes pushes write under the slug lock, so the guard is held across
    // purge → init → insert (lock order: slug guard → QUOTA_LOCK). A push to a
    // half-created slug either lands fully before the purge or waits for the
    // row. The guard is also what serializes two creates for one slug — and it
    // is per slug, so a slow create or delete of another app is never in the
    // way (a process-wide create lock used to stall every create behind one
    // slow purge: owner report, 2026-11-12).
    let _push = state.wal.lock(slug).await;
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(_)) => return Err(ApiError::conflict("slug already taken")),
        Ok(None) => {}
        Err(e) => {
            let step = step_failure("could not check the slug", &e.to_string());
            return Err(ApiError::internal(format!("create {slug}: {step}")));
        }
    }
    // An unfinished rename reserves this slug: its target prefix may hold the
    // only copy of the app's moved objects, so wiping it here would destroy
    // them. Refuse instead; the rename resumes on its own (the loop's slow
    // tick) or on the client's retry.
    if crate::host::rename::target_reserved(&state.config, slug).await {
        return Err(ApiError::conflict(format!(
            "create {slug}: the slug is still being renamed; retry shortly"
        )));
    }
    // Always wipe leftover S3/local data for this slug before the new row lands
    // — safe now: no row exists for it (checked just above, under this guard).
    // Callers of `purge_slug` hold the slug's push guard (see its docs); the
    // `_push` guard above is that holder for this path.
    match purge::purge_slug(
        &state.config,
        &state.procs,
        &state.logs,
        state.wal.sync(),
        slug,
        supervisor::StopGrace::NORMAL,
        None,
        false,
    )
    .await
    {
        Ok(purge::Purged::Done) => {
            // The prefixes are empty and no row owns the slug (checked under
            // this guard): every pending-purge tombstone for it is satisfied.
            // A failure only leaves them for the resume pass, which re-checks
            // the row and wipes an empty prefix — never fail the create for it.
            if let Err(e) = db::clear_app_purges(&state.pool, slug).await {
                tracing::warn!(slug, error = %e, "could not clear the slug's purge tombstones");
            }
        }
        Ok(purge::Purged::Stopped) => {
            return Err(ApiError::internal(format!(
                "create {slug}: the leftover wipe was stopped before it finished; retry the create"
            )))
        }
        Err(e) => {
            let step = step_failure("could not clear the deleted app's data", &format!("{e:#}"));
            return Err(ApiError::internal(format!("create {slug}: {step}")));
        }
    }
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
            Err(e) => {
                let step = step_failure("could not count the account's apps", &e.to_string());
                return Err(ApiError::internal(format!("create {slug}: {step}")));
            }
        }
    }
    // A0: both bare mirrors exist, HEAD at `main`, before the app row does — a
    // failure here leaves no half-created app behind.
    if let Err(e) = git_http::init_repos(state, slug).await {
        let step = step_failure(
            "could not initialize the git repositories",
            &format!("{e:#}"),
        );
        return Err(ApiError::internal(format!("create {slug}: {step}")));
    }
    // No credential row: only a scoped provider (Phase 4) mints one.
    // Ports are claimed, not just picked: the claim holds the allocator lock
    // until the row below lands, so a concurrent environment create cannot
    // take the same pair (SPEC, Ports).
    let ports = db::alloc::claim_ports_in(
        &state.pool,
        state.config.fleet_port_min,
        state.config.fleet_port_max,
    )
    .await
    .map_err(|e| match e {
        db::alloc::AllocError::Exhausted { .. } => ApiError::conflict(format!(
            "fleet port range {}-{} exhausted; raise NOITE_FLEET_PORTS",
            state.config.fleet_port_min, state.config.fleet_port_max
        )),
        other => ApiError::internal(format!("create {slug}: no fleet ports: {other}")),
    })?;
    let app = {
        // The quota count and the insert are one decision: the early check
        // above fails fast, this one makes the limit exact when two creates for
        // one account land together.
        let _quota = QUOTA_LOCK.lock().await;
        if owner != "local" {
            match db::count_apps_for_user(&state.pool, owner).await {
                Ok(count) if count >= i64::from(state.config.max_apps_per_user) => {
                    return Err(ApiError::conflict(format!(
                        "app limit reached ({} per account)",
                        state.config.max_apps_per_user
                    )));
                }
                Ok(_) => {}
                Err(e) => {
                    let step = step_failure("could not count the account's apps", &e.to_string());
                    return Err(ApiError::internal(format!("create {slug}: {step}")));
                }
            }
        }
        db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                internal: ports.internal,
                listen: ports.listen,
                name,
                slug,
                subdomain: &subdomain,
                user_id: owner,
            },
        )
        .await
        .map_err(|e| {
            let step = step_failure("could not store the app", &e.to_string());
            ApiError::internal(format!("create {slug}: {step}"))
        })?
    };
    drop(ports);
    let Some(git) = git_source else {
        return Ok(with_hold(state, app).await);
    };
    // An import is a background job (A2): store the source so it can be retried,
    // flip the status, and answer at once.
    let stored = serde_json::to_string(&AppSource::Git(git.clone()))
        .map_err(|e| ApiError::internal(e.to_string()))?;
    db::set_app_import_source(&state.pool, &app.id, Some(&stored))
        .await
        .map_err(|e| {
            let step = step_failure("could not store the import source", &e.to_string());
            ApiError::internal(format!("create {slug}: {step}"))
        })?;
    db::write_app_status(
        &state.pool,
        &app.id,
        AppStatus::Importing,
        None,
        None,
        WriteGuard::Table,
    )
    .await
    .map_err(|e| {
        let step = step_failure("could not mark the app as importing", &e.to_string());
        ApiError::internal(format!("create {slug}: {step}"))
    })?;
    let app = app_or_404(state, &app.id).await?;
    // A row created a moment ago cannot be held by another attempt, so the
    // claim always succeeds here.
    let _ = import::spawn(state, app.clone(), git.clone());
    Ok(app)
}

/// Retry a failed import (A2) with the source stored on the app row.
pub async fn retry_import(state: &AppState, id: &str) -> Result<App, ApiError> {
    ensure_not_deleting(id)?;
    let app = app_or_404(state, id).await?;
    let Some(stored) = app.import_source.clone() else {
        return Err(ApiError::bad("this app was not created from an import"));
    };
    let source: AppSource = serde_json::from_str(&stored)
        .map_err(|e| ApiError::internal(format!("stored import source is unreadable: {e}")))?;
    let AppSource::Git(git) = source else {
        return Err(ApiError::bad("this app was not created from an import"));
    };
    // The status write is the gate: only a state an import can start from
    // (pending, provisioned, error, stopped, failed) moves to `importing`, so
    // Retry can no longer drag a running or deploying app back to
    // `importing` while its fleet keeps serving.
    let written = db::write_app_status(
        &state.pool,
        &app.id,
        AppStatus::Importing,
        None,
        None,
        WriteGuard::Table,
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    if let crate::models::StatusWrite::Refused { current } = written {
        return Err(ApiError::conflict(match current {
            AppStatus::Running | AppStatus::Sleeping => {
                "the app is deployed; an import cannot replace it"
            }
            _ => "the app is busy; retry after its current operation",
        }));
    }
    // The claim is the gate against a second concurrent retry: `spawn`
    // takes it atomically, so exactly one attempt runs and the loser answers
    // the same conflict a live import does. An `importing` row with no claim
    // is an import interrupted by a restart — what Retry is for.
    let app = app_or_404(state, &app.id).await?;
    if !import::spawn(state, app.clone(), git) {
        return Err(ApiError::conflict("an import is already running"));
    }
    Ok(app)
}

pub async fn patch(state: &AppState, id: &str, desired: Option<&str>) -> Result<App, ApiError> {
    ensure_not_deleting(id)?;
    if let Some(desired) = desired {
        let Some(ds) = DesiredState::parse(desired) else {
            return Err(ApiError::bad("desiredState must be running|stopped"));
        };
        db::patch_app_desired(&state.pool, id, ds)
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        // A stop parks the route (and a start restores it): push now.
        if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
            tracing::warn!(app_id = %id, error = %format!("{e:#}"), "edge push after desired-state patch");
        }
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
    let slug = slug
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if name.is_none() && slug.is_none() {
        return Err(ApiError::bad("name or slug required"));
    }
    // The move (local dirs, three S3 prefixes, then the row) can outlast the
    // control plane's call bound on a store with real data. Run it as its own
    // task: a timed-out caller only drops the waiter, and the rename still
    // finishes; a retry with the same slug then sees it already applied.
    let state = state.clone();
    let id = id.to_string();
    super::detached::run(format!("rename:{id}"), async move {
        let out = match ensure_not_deleting(&id) {
            Ok(()) => rename_inner(&state, &id, name.as_deref(), slug.as_deref()).await,
            Err(e) => Err(e),
        };
        if let Err(e) = &out {
            tracing::warn!(app_id = %id, error = %e, "app rename failed");
        }
        out
    })
    .await
}

async fn rename_inner(
    state: &AppState,
    id: &str,
    name: Option<&str>,
    slug: Option<&str>,
) -> Result<App, ApiError> {
    // R-03: two apps renaming onto one slug must not both move prefixes. The
    // slug's `push_guard` is what serializes them now (`rename_app` takes both
    // slugs' guards and re-checks the target under them), so no process-wide
    // lock is involved: a rename of app A never delays a create or another
    // rename of app B. This check is only the cheap, early 409.
    if let Some(s) = &slug {
        if !slug_ok(&state.config, s) {
            return Err(ApiError::bad("invalid slug"));
        }
        match db::get_app_by_slug(&state.pool, s).await {
            Ok(Some(other)) if other.id != id => {
                return Err(ApiError::conflict("slug already taken"))
            }
            Ok(_) => {}
            Err(e) => {
                let step = step_failure("could not check the slug", &e.to_string());
                return Err(ApiError::internal(format!("rename {id}: {step}")));
            }
        }
    }
    match rename::rename_app(
        &state.config,
        &state.pool,
        &state.procs,
        &state.logs,
        &state.deploying,
        state.wal.sync(),
        id,
        name,
        slug,
    )
    .await
    {
        Ok(app) => Ok(with_hold(state, app).await),
        // `rename_app` reports intent as anyhow strings; keep the mapping here
        // so REST and RPC cannot drift on it.
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("deploy in flight") {
                Err(ApiError::conflict(msg))
            } else if msg.contains("another rename of this app is pending") {
                // An unfinished move to a different target still owns what it
                // may have moved there; retry once it resolves.
                Err(ApiError::conflict(msg))
            } else if msg.contains("invalid slug") || msg.contains("app not found") {
                Err(ApiError::bad(msg))
            } else if msg.contains("slug already taken") || msg.contains("UNIQUE constraint") {
                // Late loser of a slug race: the row write refused it after
                // the moves. Still a 409, never a 500.
                Err(ApiError::conflict("slug already taken"))
            } else {
                // The raw chain can carry a presigned URL (the store's
                // transport errors do); only the log gets it.
                let step = step_failure("could not move the app", &msg);
                Err(ApiError::internal(format!("rename {id}: {step}")))
            }
        }
    }
}

/// What a delete call reports: finished, or still running in the background
/// (a deploy in flight holds the app; the row, slug and data wipe are done).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deletion {
    Done,
    InProgress,
}

/// How long a delete call waits for the row to be gone before answering
/// [`Deletion::InProgress`]: under the control plane's 5 s bound on every
/// runner call (`apps/noite/src/lib/runner.ts`), so a delete that has to wait
/// out an in-flight deploy never surfaces as a timeout.
const DELETE_ANSWER_WITHIN: Duration = Duration::from_secs(3);

/// How long the best-effort cleanup after the row delete may take. The app
/// row, the slug's push guard and the data wipe are all already released when
/// it starts, so a hung provider call can only delay this task; the bound also
/// stops a permanently stuck provider from leaking the detached task and its
/// in-memory delete marker.
const DELETE_CLEANUP_WITHIN: Duration = Duration::from_secs(30);

/// How long the delete may spend revoking the app's store keys before it
/// releases the slug. The row transaction already marked them `revoking`; this
/// bound is only so a hung provider cannot keep the slug unusable.
const REVOKE_BEFORE_RELEASE_WITHIN: Duration = Duration::from_secs(5);

/// Where one app's delete is (RDEP-6). There is no DB column for it on
/// purpose (a hard DELETE is the only removal path): the phases live in the
/// process, and a runner restart mid-delete leaves the app stopped and
/// listed again, which a second delete finishes.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Stopping: DELETE claims the app (hidden from list/get)
///   Stopping --> Cleanup: the fleets are stopped, the row is gone and the slug is free
///   Cleanup --> [*]: routes, credential revoke and tokens done (bounded)
///   Stopping --> [*]: stopping failed; the row stays stopped and listed again
/// ```
///
/// The data wipe (local dirs + S3 prefixes) is deliberately *not* a phase: it
/// runs as a background chore after the slug is free, and the caller's answer
/// never waits for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeletePhase {
    /// Claimed: the fleet is stopping and the row is about to go.
    Stopping,
    /// The row is deleted and the slug released; only best-effort cleanup
    /// (routes, scoped credentials, operator tokens) is still running.
    Cleanup,
}

/// The in-process delete registry: one phase per app being deleted. The
/// phase is the only state; every read and write goes through this type, so
/// "is this app being deleted" has one answer.
#[derive(Default)]
struct Deletions {
    phases: std::sync::Mutex<std::collections::HashMap<String, DeletePhase>>,
}

impl Deletions {
    fn guard(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, DeletePhase>> {
        self.phases
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Claim `id` for a delete. `false` = one is already running (the caller
    /// reports [`Deletion::InProgress`] instead of starting a second one).
    fn begin(&self, id: &str) -> bool {
        self.guard()
            .insert(id.to_string(), DeletePhase::Stopping)
            .is_none()
    }

    /// Move a claimed app on. Only ever Stopping → Cleanup, and only while the
    /// app is still claimed.
    fn advance(&self, id: &str, next: DeletePhase) {
        if let Some(phase) = self.guard().get_mut(id) {
            *phase = next;
        }
    }

    fn phase(&self, id: &str) -> Option<DeletePhase> {
        self.guard().get(id).copied()
    }

    /// Release the claim: the delete finished (or failed, and a retry may
    /// start again).
    fn finish(&self, id: &str) {
        self.guard().remove(id);
    }
}

static DELETIONS: LazyLock<Deletions> = LazyLock::new(Deletions::default);

/// An app is hidden from every caller from the moment its delete starts
/// ([`list`], [`get`], [`get_by_slug`]), and every other mutation refuses it
/// (the row is about to be purged; a late write would land on a freed slug).
pub(crate) fn deleting(id: &str) -> bool {
    DELETIONS.phase(id).is_some()
}

/// Claim `id` for a delete, for tests outside this module that need the
/// registry in a known phase.
#[cfg(test)]
pub(crate) fn deleting_claim_for_test(id: &str) -> bool {
    DELETIONS.begin(id)
}

/// Release a claim taken by [`deleting_claim_for_test`].
#[cfg(test)]
pub(crate) fn deleting_release_for_test(id: &str) {
    DELETIONS.finish(id);
}

/// Refuse a mutation of an app whose delete is running. Reuses the delete's
/// own conflict vocabulary: the caller retries once it is gone.
fn ensure_not_deleting(id: &str) -> Result<(), ApiError> {
    if deleting(id) {
        return Err(ApiError::conflict("app is being deleted"));
    }
    Ok(())
}

/// A delete's row read: keep the 404/conflict vocabulary, but a DB failure is
/// a step with a failure class and a `ref`, never the raw driver chain.
fn delete_read_error(id: &str, error: ApiError) -> ApiError {
    match error {
        ApiError::Internal(detail) => {
            let step = step_failure("could not read the app", &detail);
            ApiError::internal(format!("delete {id}: {step}"))
        }
        other => other,
    }
}

/// An app's delete claim, released on drop — however the task ends, a panic
/// included, so a marker can never hide an app from every listing until a
/// restart.
struct DeletionGuard(String);

impl Drop for DeletionGuard {
    fn drop(&mut self) {
        DELETIONS.finish(&self.0);
    }
}

pub async fn delete(state: &AppState, id: &str) -> Result<Deletion, ApiError> {
    let app = app_or_404(state, id)
        .await
        .map_err(|e| delete_read_error(id, e))?;
    if !DELETIONS.begin(&app.id) {
        return Ok(Deletion::InProgress);
    }
    // A dropped HTTP handler must not cancel the purge halfway (see
    // `service::detached`): the work runs as its own task, and the timeout
    // below only stops waiting for it.
    let state = state.clone();
    let id = app.id;
    let work = super::detached::run(format!("app:{id}"), async move {
        // Released however the task ends (a panic included): a marker left
        // behind would hide the app from every listing until a restart.
        let _marker = DeletionGuard(id.clone());
        let out = delete_inner(&state, &id).await;
        if let Err(e) = &out {
            // The caller may be long gone: the log and the row are where a
            // failed delete shows. The app stays stopped; deleting it again
            // retries.
            tracing::warn!(app_id = %id, error = %e, "app delete failed");
            let note = format!("{e}; delete the app again to retry");
            if let Err(db_error) = db::write_app_status(
                &state.pool,
                &id,
                AppStatus::Stopped,
                Some(&note),
                None,
                WriteGuard::Table,
            )
            .await
            {
                tracing::warn!(app_id = %id, error = %db_error, "could not record the failed delete");
            }
        }
        out
    });
    match tokio::time::timeout(DELETE_ANSWER_WITHIN, work).await {
        Ok(out) => out.map(|()| Deletion::Done),
        Err(_) => Ok(Deletion::InProgress),
    }
}

async fn delete_inner(state: &AppState, id: &str) -> Result<(), ApiError> {
    let app = app_or_404(state, id)
        .await
        .map_err(|e| delete_read_error(id, e))?;
    // Same lock as deploy: wait out an in-flight build before stopping
    // anything. The row is deleted while the claim is still held (R-01): a
    // waiter that acquires after us must find no row and bail instead of
    // building into the just-purged prefix. Ordering here is AppLock → slug
    // lock (see [`ryuz_git::GitSync`]); `purge_slug` requires its callers to
    // hold the slug's lock. The guard releases on every return below — and on
    // cancel or panic — so a dropped delete can never wedge later deletes
    // behind a stale "deploy in flight".
    let Some(claim) =
        deploy::claim_wait_owned(&state.deploying, &app.id, Duration::from_secs(120)).await
    else {
        return Err(ApiError::conflict(
            "delete failed: a deploy is still in flight; retry the delete shortly",
        ));
    };
    // Re-read the row: the persona above may have waited out a deploy, and a
    // rename (which wins the AppLock too) can have moved the app to another
    // slug in that window. Everything below — the fleet stop, the wipe, the
    // row delete — must act on the slug the row has *now*, or it would free
    // the wrong slug and leave this app's data orphaned as another tenant's
    // inheritance.
    let app = match db::get_app(&state.pool, id).await {
        Ok(Some(app)) => app,
        Ok(None) => {
            return Err(ApiError::not_found(
                "delete failed: the app is already gone",
            ))
        }
        Err(e) => {
            let step = step_failure("could not read the app", &e.to_string());
            return Err(ApiError::internal(format!("delete {id}: {step}")));
        }
    };
    // The telemetry marks are keyed by fleet key (`<slug>`, `<slug>.<label>`)
    // and outlive the rows in this process, exactly as an environment
    // teardown's do: a slug or label reused after this delete must start from
    // the floor instead of inheriting the dead fleet's watermark and "already
    // compacted" hours. The labels are read before the row goes (the cascade
    // takes the environment rows).
    let env_keys: Vec<String> = match db::list_environments(&state.pool, &app.id).await {
        Ok(envs) => envs
            .iter()
            .map(|env| supervisor::env_fleet_key(&app.slug, &env.label))
            .collect(),
        Err(e) => {
            // Only in-memory marks read this: never fail a delete for it.
            tracing::warn!(app_id = %app.id, error = %e, "could not read the environments for the telemetry marks");
            Vec::new()
        }
    };
    // The delete claim (taken by `delete` before this task starts) is what
    // closes import admission: a retry that passed its own check cannot
    // register a new attempt now, and anything registered is swept below.
    let _direct_claim = DELETIONS.begin(id).then(|| DeletionGuard(id.to_string()));
    // A background import is part of this delete: stop it and wait for it to
    // end before the wipe. A clone that finishes late would publish
    // `refs/heads/main` under the slug this delete is about to free, and the
    // next app to take that slug would inherit the imported tree.
    if import::cancel_and_wait(&app.id).await {
        tracing::info!(app_id = %app.id, "import stopped for delete");
    }
    // R-02: a concurrent push writes under the slug lock across git + S3 +
    // manifest; the wipe must not run inside one of those writes.
    let push = state.wal.lock(&app.slug).await;
    // Mark it stopped before the fleet goes down: an app still marked running
    // is respawned in that window by the reconcile loop or by a wake. A failed
    // delete leaves the app stopped, which a retried delete finishes.
    if let Err(e) = db::patch_app_desired(&state.pool, &app.id, DesiredState::Stopped).await {
        let step = step_failure("could not stop the app", &e.to_string());
        return Err(ApiError::internal(format!("delete {}: {step}", app.slug)));
    }
    // Remember whether anything was running before the stops remove the map
    // entries: the background wipe must still settle when it killed a node,
    // and `any_fleet` inside it would see the map already empty.
    let had_fleet = supervisor::any_fleet(&state.procs, &app.slug).await;
    // Stop what serves the slug now. This is the cheap part of the teardown;
    // the expensive part (local dirs + three S3 prefixes) runs as a background
    // chore below, after the slug is free.
    supervisor::stop_fleet(&state.procs, &app.slug, supervisor::StopGrace::FOR_DELETE).await;
    supervisor::stop_environment_fleets(&state.procs, &app.slug, supervisor::StopGrace::FOR_DELETE)
        .await;
    logs::clear(&state.logs, &app.slug).await;
    crate::host::metrics::forget_fleet(&app.slug);
    for key in &env_keys {
        crate::host::metrics::forget_fleet(key);
    }
    // Row first. Every edge path resolves a host from the row (`app_for_host`,
    // `app_for_slug`), so from this moment the slug answers "no app" — the
    // reported "paused page for a deleted app" was the row lingering, stopped,
    // for the whole wipe. The slug is free here too, so a re-create does not
    // wait for the wipe. `delete_app` writes the purge tombstone and marks the
    // app's scoped keys `revoking` in the same transaction, so nothing below
    // can be lost (and no old key outlives the freed slug) if this task dies.
    // A pending rename marker is deliberately *not* dropped here. It records
    // that an unfinished attempt may already have moved this app's objects
    // under the target slug; with the row gone, those objects belong to
    // nobody. Keeping the marker reserves the target until the rename resume
    // pass wipes it (under the target's guard) and only then removes the
    // marker: a failed delete preserves it, a successful one leaves its
    // target for that pass, and a boot-time pass covers a crash.
    // The row delete is fenced against credential minting: a mint that is
    // already in flight either commits first (this transaction marks its row
    // `revoking`, swept below) or sees the app gone and revokes its key.
    let delete_result = db::delete_app(&state.pool, id).await;
    delete_result.map_err(|e| {
        let step = step_failure("could not remove the app row", &e.to_string());
        ApiError::internal(format!("delete {}: {step}", app.slug))
    })?;
    // A reconcile tick (or a wake) that listed the app before the stop above
    // can still have started the fleet again; with the row gone nothing else
    // would stop it. Stop it while the push guard is still ours: releasing
    // the slug first would let a new app with the same slug spawn, and this
    // late stop would kill *its* fleet. A fleet killed here counts for the
    // wipe's settle wait too.
    let had_fleet = had_fleet || supervisor::any_fleet(&state.procs, &app.slug).await;
    supervisor::stop_fleet(&state.procs, &app.slug, supervisor::StopGrace::FOR_DELETE).await;
    // Register the background wipe *before* the slug is released, so a create
    // that wins the guard next can ask it to stop (`purge::stop`) instead of
    // racing it. See the row re-check in the task: a create that already held
    // the guard when we registered would otherwise be wiped.
    let registered = purge::begin(&app.slug);
    // Revoke the app's scoped keys at the store *before* the slug is free: the
    // row delete only marked them `revoking`, and a holder of the old key could
    // otherwise read or write a re-created app's objects in this window. The
    // store call is bounded so a hanging provider cannot keep the slug
    // unusable; whatever the bound leaves marked is retried by the cleanup
    // below and by the periodic sweep.
    match tokio::time::timeout(
        REVOKE_BEFORE_RELEASE_WITHIN,
        crate::host::credentials::revoke_app(&state.pool, &state.config, id),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(
            app_id = %id,
            error = %format!("{e:#}"),
            "app deleted but the store revocation failed; the sweep retries it"
        ),
        Err(_) => tracing::warn!(
            app_id = %id,
            "store revocation timed out before the slug was released; the cleanup retries it"
        ),
    }
    // The row is gone and no fleet can start under this slug any more:
    // release the slug's push guard and the app's deploy claim *now*, before
    // the edge push, the wipe and the best-effort cleanup below. Create and
    // rename onto this slug wait on the guard (and the control plane aborts
    // their runner call after 5 s); a hung store or Caddy call must never keep
    // the slug unusable — that was the "deleted app, slug still taken" bug.
    drop(push);
    drop(claim);
    // The CI cache volume goes with the slug's data, but its removal never
    // gates the answer or the tombstone: it runs detached (no slug guard
    // held), and `purge::reconcile_ci_caches` retries whatever fails here.
    {
        let (cfg, app_id) = (state.config.clone(), app.id.clone());
        tokio::spawn(async move {
            if let Err(e) = purge::remove_ci_cache_volume(&cfg, &app_id).await {
                tracing::warn!(app_id = %app_id, error = %format!("{e:#}"), "could not remove the app's CI cache volume; the reconcile sweep retries");
            }
        });
    }
    // The row is gone and the slug is free: only best-effort work is left,
    // which is the state a caller's 202 keeps the app in.
    DELETIONS.advance(id, DeletePhase::Cleanup);
    // The edge stops routing the slug on this push, not on the next reconcile
    // tick. Best-effort: the row is already gone, so an unanswered push only
    // leaves a stale route (Caddy's upstream probe) until the tick retries.
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(app_id = %id, error = %format!("{e:#}"), "edge push after app delete");
    }
    // The wipe itself: local dirs and `git/`, `fleets/`, `envs/` prefixes. It
    // holds the slug's guard while it runs (the create that wants the slug
    // back is what asks it to stop), and it re-checks the row first: if the
    // slug was already re-created, that create's own wipe was the
    // authoritative one and this one must not touch the new app's objects.
    {
        let state = state.clone();
        let slug = app.slug.clone();
        super::detached::spawn(format!("purge:{slug}"), async move {
            let guard = state.wal.lock(&slug).await;
            // Clear the durable tombstone(s) for the slug once the prefixes
            // are empty (this wipe's `Done`, or the taker's authoritative wipe
            // when a row exists again). A stopped or failed wipe keeps them,
            // so `purge::resume_pending` retries at boot and on the loop.
            let satisfied = match db::get_app_by_slug(&state.pool, &slug).await {
                Ok(Some(_)) => {
                    tracing::debug!(slug, "purge skipped: the slug was re-created");
                    true
                }
                Ok(None) => {
                    let out = purge::purge_slug(
                        &state.config,
                        &state.procs,
                        &state.logs,
                        state.wal.sync(),
                        &slug,
                        supervisor::StopGrace::FOR_DELETE,
                        Some(registered.stop()),
                        had_fleet,
                    )
                    .await;
                    match out {
                        Ok(purge::Purged::Done) => true,
                        Ok(purge::Purged::Stopped) => {
                            tracing::info!(slug, "purge stopped: the slug is being re-created");
                            false
                        }
                        Err(e) => {
                            // The tombstone is where a retry comes from: this is
                            // an operator-visible warning, not the end of the
                            // story.
                            tracing::warn!(slug, error = %format!("{e:#}"), "background purge failed; the slug's data is left for the resume pass");
                            false
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(slug, error = %e, "purge skipped: could not check whether the slug was re-created");
                    false
                }
            };
            if satisfied {
                if let Err(e) = db::clear_app_purges(&state.pool, &slug).await {
                    tracing::warn!(slug, error = %e, "could not clear the slug's purge tombstones");
                }
            }
            drop(guard);
            drop(registered);
        });
    }
    let cleanup = async {
        // Revoke the app's keys and its environments' (SPEC, Scoped
        // credentials). R-10: a revoke failure must not vanish — warn loudly
        // so the orphaned credential row is visible instead of silently kept.
        if let Err(e) = crate::host::credentials::revoke_app(&state.pool, &state.config, id).await {
            tracing::warn!(app_id = %id, error = %format!("{e:#}"), "app deleted but credential revoke failed");
        }
        // The fleets' operator tokens go with the app (rows and process
        // cache), so a recreated slug mints fresh ones instead of inheriting
        // the dead fleets' tokens.
        if let Err(e) = crate::host::credentials::delete_app_operator_tokens(&state.pool, id).await
        {
            tracing::warn!(app_id = %id, error = %e, "app deleted but operator token rows remain");
        }
    };
    if tokio::time::timeout(DELETE_CLEANUP_WITHIN, cleanup)
        .await
        .is_err()
    {
        tracing::warn!(
            app_id = %id,
            "post-delete cleanup still pending; the slug is free and the next sweep/reconcile retries the rest"
        );
    }
    Ok(())
}

/// Park an app now, skipping the idle check. `false` = it does not qualify.
pub async fn sleep(state: &AppState, id: &str) -> Result<bool, ApiError> {
    sleep::sleep_app(&state.pool, &state.config, &state.procs, id, true)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    /// In-process S3 stand-in: LIST answers an empty `ListObjectsV2` page, and
    /// object GET/HEAD answer 404 `NoSuchKey`, so purge and cold-mirror
    /// hydration see "nothing there" instead of dialing RustFS (the stub the
    /// API parity tests use). Bodies and deletes never reach it: an empty
    /// listing plus missing keys short-circuit both.
    async fn spawn_s3_stub() -> String {
        fn is_object_op(request: &[u8]) -> Option<bool> {
            let line = request
                .split(|byte| *byte == b'\n')
                .next()
                .and_then(|line| std::str::from_utf8(line).ok())?;
            let target = line.split_whitespace().nth(1)?;
            let mut halves = target.splitn(2, '?');
            let path = halves.next().unwrap_or("");
            let query = halves.next().unwrap_or("");
            // Bucket actions (LIST, batch delete) sign with or without a
            // trailing slash; only a `list-type` query makes one a listing.
            if query.contains("list-type") {
                return Some(false);
            }
            Some(path.trim_start_matches('/').contains('/'))
        }
        fn is_read(request: &[u8]) -> bool {
            request.starts_with(b"GET ") || request.starts_with(b"HEAD ")
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind s3 stub");
        let addr = listener.local_addr().expect("stub addr");
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 8192];
                    let _ = sock.read(&mut buf).await;
                    let object = is_object_op(&buf).unwrap_or(false);
                    let (status, body) = if object && is_read(&buf) {
                        (
                            "404 Not Found",
                            concat!(
                                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                                "<Error><Code>NoSuchKey</Code>",
                                "<Message>missing</Message></Error>",
                            ),
                        )
                    } else if object {
                        ("200 OK", "")
                    } else {
                        (
                            "200 OK",
                            concat!(
                                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                                "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                                "<Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                                "</ListBucketResult>"
                            ),
                        )
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// One runner state with a per-account app limit of `max_apps`.
    async fn test_state(max_apps: u32) -> (AppState, crate::testutil::TempDir) {
        let s3 = spawn_s3_stub().await;
        test_state_with_s3(max_apps, s3).await
    }

    /// Same, against a caller-supplied S3 endpoint: a test that must park
    /// the purge mid-flight gates the stub instead of answering at once.
    async fn test_state_with_s3(max_apps: u32, s3: String) -> (AppState, crate::testutil::TempDir) {
        test_state_with_s3_and(max_apps, s3, None).await
    }

    /// Same, with the edge admin URL overridden: the delete-frees-the-slug
    /// test parks the post-delete route push behind a server that never
    /// answers, so cleanup stays in flight while the test probes the guard.
    async fn test_state_with_s3_and(
        max_apps: u32,
        s3: String,
        caddy_admin_url: Option<String>,
    ) -> (AppState, crate::testutil::TempDir) {
        let guard = crate::testutil::TempDir::new("noite-create-tests");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!(
            "sqlite:{}?mode=rwc",
            guard.path().join("noite.sqlite").display()
        );
        cfg.s3_endpoint = s3.clone();
        cfg.s3_public_endpoint = s3;
        cfg.work_dir = guard.path().join("work").to_string_lossy().into_owned();
        cfg.max_apps_per_user = max_apps;
        if let Some(url) = caddy_admin_url {
            cfg.caddy_admin_url = url;
        }
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        let state = AppState {
            pool,
            config: config.clone(),
            procs: crate::host::supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify,
            wal: crate::host::git_store::build_wal(&config),
            tip_tx,
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
            source_maps: Default::default(),
            control_boot: Default::default(),
        };
        (state, guard)
    }

    /// NOITE-APPS-001: the count→insert window and the destructive purge run
    /// under one lock, so concurrent creates for one account cannot slip past
    /// the quota — and the loser of a same-slug race never purges the winner's
    /// fresh mirrors.
    #[tokio::test]
    async fn concurrent_creates_respect_the_quota_and_the_slug() {
        let (state, dir) = test_state(1).await;
        // Two different slugs, one account, a hard limit of 1.
        let (first, second) = tokio::join!(
            create(&state, "Alpha", "race-alpha", Some("u1"), None),
            create(&state, "Beta", "race-beta", Some("u1"), None),
        );
        assert_eq!(
            [&first, &second].iter().filter(|r| r.is_ok()).count(),
            1,
            "the quota must hold under concurrent creates: {first:?} {second:?}"
        );
        let loser = [&first, &second]
            .into_iter()
            .find(|r| r.is_err())
            .expect("one create has to lose");
        assert!(matches!(loser, Err(ApiError::Conflict(_))), "{loser:?}");

        // The same slug from two accounts: one row, and the loser's purge must
        // not have removed the winner's mirrors.
        let (third, fourth) = tokio::join!(
            create(&state, "Gamma", "race-one", Some("u2"), None),
            create(&state, "Delta", "race-one", Some("u3"), None),
        );
        assert_eq!(
            [&third, &fourth].iter().filter(|r| r.is_ok()).count(),
            1,
            "{third:?} {fourth:?}"
        );
        let app = crate::db::get_app_by_slug(&state.pool, "race-one")
            .await
            .expect("slug lookup")
            .expect("the winner's row");
        assert!(
            git_http::http_bare(&state.config, &app.slug)
                .join("HEAD")
                .exists(),
            "the winner's push mirror survived the loser's create"
        );
        assert!(
            crate::host::source::bare_repo(&state.config, &app.slug)
                .join("HEAD")
                .exists(),
            "the winner's source mirror survived the loser's create"
        );
        drop(dir);
    }

    /// R-01: delete waits out an in-flight deploy claim, and the row is gone
    /// before the claim releases — so a waiter that acquires after the delete
    /// finds no row and bails instead of building into the purged prefix.
    #[tokio::test]
    async fn delete_waits_then_leaves_no_row_for_waiters() {
        let (state, dir) = test_state(10).await;
        let app = create(&state, "Doomed", "doomed", Some("u1"), None)
            .await
            .expect("create");
        // A fake in-flight deploy holding the AppLock.
        let fake_deploy = deploy::claim_owned(&state.deploying, &app.id)
            .await
            .expect("fake deploy takes the claim");
        let owned = state.clone();
        let id = app.id.clone();
        let mut deleting = tokio::spawn(async move { delete_inner(&owned, &id).await });
        // The delete must still be waiting on the deploy claim: a timeout
        // race proves it stayed pending (a delete that skips the wait
        // finishes early and fails here).
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut deleting)
                .await
                .is_err(),
            "delete must wait out the deploy claim"
        );
        // The delete holds the claim through purge + row delete: wait until
        // it owns the claim, then queue a waiter behind it (an explicit
        // deploy's `claim_wait`). The purge's settle sleep keeps this window
        // wide open. The wait yields between scans; only the deadline below
        // can fail it.
        drop(fake_deploy);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while !deploy::snapshot_claimed(&state.deploying)
            .await
            .contains(&app.id)
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "delete never took the claim"
            );
            tokio::task::yield_now().await;
        }
        let owned = state.clone();
        let id = app.id.clone();
        let waiter = tokio::spawn(async move {
            let _waiter = deploy::claim_wait_owned(&owned.deploying, &id, Duration::from_secs(30))
                .await
                .expect("waiter acquires once delete releases");
            db::get_app(&owned.pool, &id).await.expect("lookup")
        });
        tokio::time::timeout(Duration::from_secs(30), deleting)
            .await
            .expect("delete finishes")
            .expect("delete task")
            .expect("delete ok");
        let row = tokio::time::timeout(Duration::from_secs(30), waiter)
            .await
            .expect("waiter finishes")
            .expect("waiter task");
        assert!(
            row.is_none(),
            "a deploy that waits behind delete finds no row"
        );
        drop(dir);
    }

    /// A delete that cannot finish within the answer bound (here a deploy
    /// holds the claim) answers "in progress" instead of timing the caller
    /// out: the app is gone from every listing at once, a second delete
    /// reports the running one, and the purge still finishes once the claim
    /// frees.
    #[tokio::test]
    async fn a_slow_delete_answers_in_progress_and_still_finishes() {
        let (state, dir) = test_state(10).await;
        let app = create(&state, "Slow", "slow-delete", Some("u1"), None)
            .await
            .expect("create");
        let fake_deploy = deploy::claim_owned(&state.deploying, &app.id)
            .await
            .expect("fake deploy takes the claim");
        let done = crate::service::detached::finished(&format!("app:{}", app.id));

        assert_eq!(
            delete(&state, &app.id).await.expect("delete answers"),
            Deletion::InProgress
        );
        assert!(
            list(&state)
                .await
                .expect("list")
                .iter()
                .all(|a| a.id != app.id),
            "a deleting app is not listed"
        );
        assert!(matches!(
            get(&state, &app.id).await,
            Err(ApiError::NotFound(_))
        ));
        assert!(get_by_slug(&state, "slow-delete").await.is_err());
        assert_eq!(
            delete(&state, &app.id)
                .await
                .expect("second delete answers"),
            Deletion::InProgress,
            "a second delete reports the running one"
        );

        drop(fake_deploy);
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("the background delete finishes");
        assert!(db::get_app(&state.pool, &app.id)
            .await
            .expect("lookup")
            .is_none());
        assert!(!deleting(&app.id), "a finished delete leaves no marker");
        drop(dir);
    }

    /// Every mutation refuses an app whose delete is running: the row is about
    /// to be purged, and a late write (an import retry, a desired-state patch,
    /// a rename) would land on a slug the delete is freeing.
    #[tokio::test]
    async fn mutations_refuse_an_app_that_is_being_deleted() {
        let (state, dir) = test_state(10).await;
        let app = create(&state, "Doomed", "doomed-app", Some("u1"), None)
            .await
            .expect("create");
        assert!(DELETIONS.begin(&app.id));
        let guard = DeletionGuard(app.id.clone());

        assert!(matches!(
            retry_import(&state, &app.id).await,
            Err(ApiError::Conflict(_))
        ));
        assert!(matches!(
            patch(&state, &app.id, Some(DesiredState::Stopped.as_str())).await,
            Err(ApiError::Conflict(_))
        ));
        assert!(matches!(
            rename(&state, &app.id, Some("Other"), None).await,
            Err(ApiError::Conflict(_))
        ));
        // The stop was refused too: the app still wants to run.
        let row = db::get_app(&state.pool, &app.id)
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(row.desired(), DesiredState::Running);

        drop(guard);
        assert!(
            patch(&state, &app.id, Some(DesiredState::Stopped.as_str()))
                .await
                .is_ok(),
            "the same mutation works once the delete is over"
        );
        drop(dir);
    }

    /// The delete registry owns "is this app being deleted": one claim per
    /// app, one-way phase, and a release on every exit path (the drop guard
    /// is what a panic or a dropped caller relies on).
    #[test]
    fn the_delete_claim_is_one_per_app_and_released_on_drop() {
        let id = "sm-delete-claim-test";
        assert!(DELETIONS.begin(id), "the first delete claims the app");
        assert!(!DELETIONS.begin(id), "a second delete reports the first");
        assert_eq!(DELETIONS.phase(id), Some(DeletePhase::Stopping));
        DELETIONS.advance(id, DeletePhase::Cleanup);
        assert_eq!(DELETIONS.phase(id), Some(DeletePhase::Cleanup));
        assert!(deleting(id));
        drop(DeletionGuard(id.to_string()));
        assert!(!deleting(id), "the guard releases the claim");
        assert!(
            DELETIONS.begin(id),
            "a failed or finished delete may start again"
        );
        DELETIONS.finish(id);
    }

    /// R-03: two apps renaming onto one slug serialize under the target
    /// slug's push guard (AppLock → slug guard) — exactly one wins and the
    /// loser is a 409, with no prefix moves leaking onto the target before the
    /// conflict.
    #[tokio::test]
    async fn concurrent_renames_onto_one_slug_leave_one_winner() {
        let (state, dir) = test_state(10).await;
        let a = create(&state, "Alpha", "r3-alpha", Some("u1"), None)
            .await
            .expect("create a");
        let b = create(&state, "Beta", "r3-beta", Some("u1"), None)
            .await
            .expect("create b");
        let (first, second) = tokio::join!(
            rename(&state, &a.id, None, Some("r3-target")),
            rename(&state, &b.id, None, Some("r3-target")),
        );
        assert_eq!(
            [&first, &second].iter().filter(|r| r.is_ok()).count(),
            1,
            "one rename must win: {first:?} {second:?}"
        );
        let loser = [&first, &second]
            .into_iter()
            .find(|r| r.is_err())
            .expect("one rename has to lose");
        assert!(matches!(loser, Err(ApiError::Conflict(_))), "{loser:?}");
        let winner = crate::db::get_app_by_slug(&state.pool, "r3-target")
            .await
            .expect("slug lookup")
            .expect("the winner's row");
        assert!(
            winner.id == a.id || winner.id == b.id,
            "the target belongs to one of the racers"
        );
        drop(dir);
    }

    /// R-12: create holds the slug's push guard across purge → init →
    /// insert, so a create queued behind a push (or vice versa) serializes
    /// instead of wiping a half-written prefix.
    #[tokio::test]
    async fn create_waits_for_an_in_flight_push_guard() {
        let (state, dir) = test_state(10).await;
        let _push = state.wal.sync().lock("guarded").await;
        let owned = state.clone();
        let mut creating =
            tokio::spawn(
                async move { create(&owned, "Guarded", "guarded", Some("u1"), None).await },
            );
        // The create must still be waiting on the push guard: a timeout
        // race proves it stayed pending (a create that skips the wait
        // finishes early and fails here).
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut creating)
                .await
                .is_err(),
            "create must wait for the slug push guard"
        );
        drop(_push);
        let app = tokio::time::timeout(Duration::from_secs(30), creating)
            .await
            .expect("create finishes")
            .expect("create task")
            .expect("create ok");
        assert_eq!(app.slug, "guarded");
        drop(dir);
    }

    /// The control plane aborting a create only drops the waiter: the row
    /// still lands and the import is spawned, so a retry sees the app
    /// instead of re-purging a half-deleted prefix forever. Fails without
    /// the detached task (the create is canceled on the guard wait).
    #[tokio::test]
    async fn dropped_create_caller_does_not_cancel_the_create() {
        let (state, dir) = test_state(10).await;
        let guard = state.wal.sync().lock("slow-create").await;
        let done = crate::service::detached::finished("create:slow-create");
        let owned = state.clone();
        let mut caller =
            tokio::spawn(
                async move { create(&owned, "Slow", "slow-create", Some("u1"), None).await },
            );
        assert!(
            tokio::time::timeout(Duration::from_millis(300), &mut caller)
                .await
                .is_err(),
            "the create should be waiting on the slug guard"
        );
        caller.abort();
        drop(guard);
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("create canceled with its caller: the row never landed");
        assert!(
            db::get_app_by_slug(&state.pool, "slow-create")
                .await
                .expect("slug lookup")
                .is_some(),
            "the created app is missing"
        );
        drop(dir);
    }

    /// A store that models objects, so a test can seed a leftover under a freed
    /// slug and watch a wipe delete it: LIST answers what the map holds under
    /// the requested prefix, a batch delete removes exactly the keys its body
    /// names.
    struct ObjectStore {
        endpoint: String,
        objects: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
    }

    impl ObjectStore {
        fn insert(&self, key: &str) {
            self.objects
                .lock()
                .expect("object store lock")
                .insert(key.to_string());
        }

        fn has(&self, key: &str) -> bool {
            self.objects
                .lock()
                .expect("object store lock")
                .contains(key)
        }
    }

    async fn spawn_object_store() -> ObjectStore {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind object store");
        let endpoint = format!("http://{}", listener.local_addr().expect("store addr"));
        let objects: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>> =
            std::sync::Arc::default();
        let seen = objects.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let objects = seen.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    // Read a whole request: headers, then the `Content-Length`
                    // body (a batch delete's key list).
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let mut body_start = None;
                    let mut want = 0usize;
                    loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if body_start.is_none() {
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                body_start = Some(pos + 4);
                                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                                want = head
                                    .lines()
                                    .find_map(|line| {
                                        let (name, value) = line.split_once(':')?;
                                        if name.eq_ignore_ascii_case("content-length") {
                                            value.trim().parse::<usize>().ok()
                                        } else {
                                            None
                                        }
                                    })
                                    .unwrap_or(0);
                            }
                        }
                        if let Some(start) = body_start {
                            if buf.len() >= start + want {
                                break;
                            }
                        }
                        if buf.len() > 262_144 {
                            break;
                        }
                    }
                    let request_line = String::from_utf8_lossy(&buf)
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next().unwrap_or_default().to_string();
                    let target = parts.next().unwrap_or_default().to_string();
                    let (_, query) = target.split_once('?').unwrap_or((&target, ""));
                    let body = String::from_utf8_lossy(&buf[body_start.unwrap_or(buf.len())..])
                        .to_string();
                    let status = "200 OK";
                    let payload = if query.contains("list-type") {
                        let prefix = query
                            .split('&')
                            .find_map(|pair| pair.strip_prefix("prefix="))
                            .unwrap_or("")
                            .replace("%2F", "/")
                            .replace("%2f", "/");
                        let mut page = String::from(
                            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                             <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                             <Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                        );
                        for key in objects
                            .lock()
                            .expect("object store lock")
                            .iter()
                            .filter(|key| key.starts_with(&prefix))
                        {
                            page.push_str(&format!(
                                "<Contents><Key>{key}</Key>\
                                 <LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                                 <ETag>&quot;x&quot;</ETag><Size>1</Size></Contents>"
                            ));
                        }
                        page.push_str("</ListBucketResult>");
                        page
                    } else if method == "POST" {
                        let mut removed = String::new();
                        let mut guard = objects.lock().expect("object store lock");
                        for key in body
                            .split("<Key>")
                            .skip(1)
                            .filter_map(|rest| rest.split_once("</Key>").map(|(key, _)| key))
                        {
                            guard.remove(key);
                            removed.push_str(&format!("<Deleted><Key>{key}</Key></Deleted>"));
                        }
                        format!(
                            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                             <DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                             {removed}</DeleteResult>"
                        )
                    } else {
                        String::new()
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        ObjectStore { endpoint, objects }
    }

    /// A rename onto a slug freed by a delete wipes the leftover prefixes
    /// before moving its own objects in. The row is dropped before the wipe
    /// now, so "slug free" no longer implies "prefix empty" — without the
    /// target wipe the renamed app would inherit the deleted tenant's git
    /// history and celld durability (review finding, 2026-11-12).
    #[tokio::test]
    async fn rename_onto_a_freed_slug_wipes_its_leftover_prefixes() {
        let store = spawn_object_store().await;
        let (state, dir) = test_state_with_s3(10, store.endpoint.clone()).await;
        // Rows directly: this test is about the wipe/rename order, and a
        // full `create` would need the stub to model git manifests too.
        let keeper = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Keeper",
                slug: "ps-old",
                user_id: "u1",
                subdomain: "ps-old.localhost",
                listen: 30600,
                internal: 30601,
            },
        )
        .await
        .expect("keeper row");
        let gone = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Gone",
                slug: "ps-target",
                user_id: "u1",
                subdomain: "ps-target.localhost",
                listen: 30610,
                internal: 30611,
            },
        )
        .await
        .expect("gone row");
        // The delete's own row transaction (its background chore is not what
        // this test is about): the row is gone and the tombstone is written.
        db::delete_app(&state.pool, &gone.id)
            .await
            .expect("delete row");
        store.insert("git/ps-target/leftover.bundle");
        store.insert("fleets/ps-target/durable.sqlite");

        let renamed = rename(&state, &keeper.id, None, Some("ps-target"))
            .await
            .expect("rename onto a freed slug");

        assert_eq!(renamed.slug, "ps-target");
        assert!(
            !store.has("git/ps-target/leftover.bundle"),
            "the freed slug's git prefix must be wiped before the move"
        );
        assert!(
            !store.has("fleets/ps-target/durable.sqlite"),
            "the freed slug's fleet durability must be wiped before the move"
        );
        assert!(
            db::pending_purges(&state.pool)
                .await
                .expect("tombstones")
                .is_empty(),
            "the target wipe satisfies the pending-purge tombstone"
        );
        drop(dir);
    }

    /// A rename that moved some objects and then died before the row update
    /// leaves the moved data under the target while the row still names the
    /// source. The retry must resume, not wipe the target as another tenant's
    /// leftover: the durable marker records that the attempt belongs to this
    /// app.
    #[tokio::test]
    async fn a_retried_rename_keeps_data_an_earlier_attempt_moved() {
        let store = spawn_object_store().await;
        let (state, dir) = test_state_with_s3(10, store.endpoint.clone()).await;
        let app = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Retried",
                slug: "rr-old",
                user_id: "u1",
                subdomain: "rr-old.localhost",
                listen: 30620,
                internal: 30621,
            },
        )
        .await
        .expect("app row");
        // The first attempt moved this object, then failed before the row
        // update (which still names `rr-old`).
        store.insert("git/rr-new/already-moved.bundle");
        store.insert("git/rr-old/still-there.bundle");
        crate::host::rename::write_rename_marker_for_test(
            &state.config,
            &app.id,
            "rr-old",
            "rr-new",
        )
        .await
        .expect("crashed attempt leaves its marker");

        let renamed = rename(&state, &app.id, None, Some("rr-new"))
            .await
            .expect("retried rename");

        assert_eq!(renamed.slug, "rr-new");
        assert!(
            store.has("git/rr-new/already-moved.bundle"),
            "the retry must keep the data the earlier attempt already moved"
        );
        // (The stub does not model the copy/delete round-trip; the surviving
        // target object above is the observable the retry must preserve.)
        drop(dir);
    }

    /// An unfinished rename reserves its target: the prefix may already hold
    /// the only copy of the app's moved objects, so another create must be
    /// refused instead of wiping them, and the app's own retry resolves it.
    #[tokio::test]
    async fn a_pending_rename_reserves_its_target_against_another_owner() {
        let (state, dir) = test_state(10).await;
        let a = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "A",
                slug: "ab-old",
                user_id: "u1",
                subdomain: "ab-old.localhost",
                listen: 30630,
                internal: 30631,
            },
        )
        .await
        .expect("app A");
        // A's first attempt at ab-old → ab-target failed and left its marker.
        crate::host::rename::write_rename_marker_for_test(
            &state.config,
            &a.id,
            "ab-old",
            "ab-target",
        )
        .await
        .expect("failed attempt marker");

        let refused = create(&state, "B", "ab-target", Some("u1"), None)
            .await
            .expect_err("a reserved target is not available");
        assert!(
            matches!(&refused, ApiError::Conflict(message) if message.contains("being renamed")),
            "the create is a retryable conflict, got {refused:?}"
        );

        // The rename's own retry is allowed and resolves the reservation.
        let renamed = rename(&state, &a.id, None, Some("ab-target"))
            .await
            .expect("retry A's rename");
        assert_eq!(renamed.slug, "ab-target");
        assert!(
            create(&state, "B", "ab-target", Some("u1"), None)
                .await
                .is_err(),
            "once A owns the target, B is refused as taken"
        );
        drop(dir);
    }

    /// The reconcile loop resumes an unfinished rename from its marker, so a
    /// crash mid-move neither blocks the reservation forever nor loses the
    /// partially moved data (the marker makes the retry skip the target wipe).
    #[tokio::test]
    async fn an_unfinished_rename_is_resumed_and_its_reservation_released() {
        let (state, dir) = test_state(10).await;
        let app = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Resumed",
                slug: "rs-old",
                user_id: "u1",
                subdomain: "rs-old.localhost",
                listen: 30670,
                internal: 30671,
            },
        )
        .await
        .expect("app row");
        crate::host::rename::write_rename_marker_for_test(
            &state.config,
            &app.id,
            "rs-old",
            "rs-new",
        )
        .await
        .expect("failed attempt marker");
        assert!(
            crate::host::rename::target_reserved(&state.config, "rs-new").await,
            "the target is reserved until the rename resolves"
        );

        let resumed = crate::host::rename::resume_pending_renames(
            &state.config,
            &state.pool,
            &state.procs,
            &state.logs,
            &state.deploying,
            state.wal.sync(),
        )
        .await;

        assert_eq!(resumed, 1);
        let now = db::get_app(&state.pool, &app.id)
            .await
            .expect("read")
            .expect("row");
        assert_eq!(now.slug, "rs-new");
        assert!(
            !crate::host::rename::target_reserved(&state.config, "rs-new").await,
            "the reservation is released once the row commits"
        );
        drop(dir);
    }

    /// A pending rename to one target blocks a rename to another: the earlier
    /// attempt may already have moved objects there, and committing a
    /// different target would clear its marker and leave them owned by
    /// nobody. The retry is a conflict until the pending move finishes.
    #[tokio::test]
    async fn a_rename_to_a_third_slug_waits_for_the_pending_target() {
        let (state, dir) = test_state(10).await;
        let app = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Pending",
                slug: "rn-old",
                user_id: "u1",
                subdomain: "rn-old.localhost",
                listen: 30680,
                internal: 30681,
            },
        )
        .await
        .expect("app row");
        // A's attempt at rn-old → rn-new failed before the row update.
        crate::host::rename::write_rename_marker_for_test(
            &state.config,
            &app.id,
            "rn-old",
            "rn-new",
        )
        .await
        .expect("failed attempt marker");

        let refused = rename(&state, &app.id, None, Some("rn-other"))
            .await
            .expect_err("a different target is blocked by the pending move");
        assert!(
            matches!(&refused, ApiError::Conflict(message) if message.contains("pending")),
            "the refusal is a retryable conflict, got {refused:?}"
        );
        let row = db::get_app(&state.pool, &app.id)
            .await
            .expect("read")
            .expect("row");
        assert_eq!(row.slug, "rn-old", "nothing moved");

        // The pending move still resolves, and then the other target works.
        let renamed = rename(&state, &app.id, None, Some("rn-new"))
            .await
            .expect("the pending target resumes");
        assert_eq!(renamed.slug, "rn-new");
        let again = rename(&state, &app.id, None, Some("rn-other"))
            .await
            .expect("a different target once nothing is pending");
        assert_eq!(again.slug, "rn-other");
        drop(dir);
    }

    /// A delete keeps a pending rename's marker: the target may already hold
    /// the app's moved objects, which now belong to nobody. The slug stays
    /// reserved until a resume pass wipes the target, and only then is the
    /// marker dropped.
    #[tokio::test]
    async fn a_delete_keeps_the_marker_until_its_target_is_wiped() {
        let (state, dir) = test_state(10).await;
        let app = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "Orphan",
                slug: "ob-old",
                user_id: "u1",
                subdomain: "ob-old.localhost",
                listen: 30682,
                internal: 30683,
            },
        )
        .await
        .expect("app row");
        crate::host::rename::write_rename_marker_for_test(
            &state.config,
            &app.id,
            "ob-old",
            "ob-new",
        )
        .await
        .expect("failed attempt marker");
        // The failed attempt got as far as moving an object to the target.
        let moved = crate::host::exec::work_root(&state.config)
            .join("fleets")
            .join("ob-new");
        std::fs::create_dir_all(&moved).expect("moved target dir");
        std::fs::write(moved.join("object.bin"), "moved").expect("moved object");

        let done = crate::service::detached::finished(&format!("app:{}", app.id));
        let _ = delete(&state, &app.id).await.expect("delete answers");
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("the delete's detached work finished");

        assert!(
            crate::host::rename::target_reserved(&state.config, "ob-new").await,
            "the delete leaves the pending marker in place"
        );
        assert!(
            moved.join("object.bin").exists(),
            "the delete does not touch the target it does not own"
        );
        let refused = create(&state, "B", "ob-new", Some("u1"), None)
            .await
            .expect_err("the target stays reserved until it is wiped");
        assert!(
            matches!(&refused, ApiError::Conflict(message) if message.contains("being renamed")),
            "the create is a retryable conflict, got {refused:?}"
        );

        let resumed = crate::host::rename::resume_pending_renames(
            &state.config,
            &state.pool,
            &state.procs,
            &state.logs,
            &state.deploying,
            state.wal.sync(),
        )
        .await;
        assert_eq!(resumed, 0, "there is no app left to rename");
        assert!(!moved.exists(), "the orphaned target's data is wiped");
        assert!(
            !crate::host::rename::target_reserved(&state.config, "ob-new").await,
            "the marker is dropped only after the wipe"
        );
        create(&state, "B", "ob-new", Some("u1"), None)
            .await
            .expect("the slug is usable once the target is clean");
        drop(dir);
    }

    /// R-02: a slug rename holds both slugs' push guards across the whole
    /// move, so a rename queued behind a push serializes instead of moving
    /// prefixes under a live git+S3+manifest write.
    #[tokio::test]
    async fn rename_waits_for_an_in_flight_push_guard() {
        let (state, dir) = test_state(10).await;
        let app = create(&state, "Mover", "ps-old", Some("u1"), None)
            .await
            .expect("create");
        let _push = state.wal.sync().lock("ps-old").await;
        let owned = state.clone();
        let id = app.id.clone();
        let mut renaming =
            tokio::spawn(async move { rename(&owned, &id, None, Some("ps-new")).await });
        // The rename must still be waiting on the push guard: a timeout
        // race proves it stayed pending (a rename that skips the wait
        // finishes early and fails here).
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut renaming)
                .await
                .is_err(),
            "rename must wait for the old-slug push guard"
        );
        drop(_push);
        let renamed = tokio::time::timeout(Duration::from_secs(30), renaming)
            .await
            .expect("rename finishes")
            .expect("rename task")
            .expect("rename ok");
        assert_eq!(renamed.slug, "ps-new");
        drop(dir);
    }
    /// A slug that still belongs to another app is a conflict, answered
    /// without moving anything: no local dirs, no S3, no row write.
    #[tokio::test]
    async fn rename_onto_a_taken_slug_is_a_conflict() {
        let (state, dir) = test_state(10).await;
        let a = create(&state, "Alpha", "ps-a", Some("u1"), None)
            .await
            .expect("create a");
        create(&state, "Beta", "ps-b", Some("u1"), None)
            .await
            .expect("create b");
        let err = rename(&state, &a.id, None, Some("ps-b"))
            .await
            .expect_err("the slug belongs to another app");
        assert!(matches!(err, ApiError::Conflict(_)), "{err:?}");
        let row = db::get_app(&state.pool, &a.id)
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(row.slug, "ps-a");
        drop(dir);
    }

    /// The reported case: rename onto a slug whose app was deleted. The
    /// delete's purge finished before its row went away, so the target has
    /// no leftover dirs or prefixes and the rename must succeed; the delete
    /// guard no longer blocks it (alpha.22 bug).
    #[tokio::test]
    async fn rename_onto_a_deleted_slug_succeeds() {
        let (state, dir) = test_state(10).await;
        let keeper = create(&state, "Keeper", "ps-old", Some("u1"), None)
            .await
            .expect("create keeper");
        let gone = create(&state, "Gone", "ps-target", Some("u1"), None)
            .await
            .expect("create gone");
        let done = crate::service::detached::finished(&format!("app:{}", gone.id));
        let _ = delete(&state, &gone.id).await.expect("delete answers");
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("the delete's detached work never finished");
        assert!(
            db::get_app_by_slug(&state.pool, "ps-target")
                .await
                .expect("slug lookup")
                .is_none(),
            "the deleted slug still has a row"
        );
        let renamed = rename(&state, &keeper.id, None, Some("ps-target"))
            .await
            .expect("rename onto a deleted slug");
        assert_eq!(renamed.slug, "ps-target");
        drop(dir);
    }

    /// The rename runs as its own task: the control plane aborting the call
    /// only drops the waiter, and the move completes instead of leaving the
    /// row on the old slug with dirs or prefixes half moved.
    #[tokio::test]
    async fn dropped_rename_caller_does_not_cancel_the_move() {
        let (state, dir) = test_state(10).await;
        let app = create(&state, "Mover", "ps-old", Some("u1"), None)
            .await
            .expect("create");
        let guard = state.wal.sync().lock("ps-old").await;
        let done = crate::service::detached::finished(&format!("rename:{}", app.id));
        let owned = state.clone();
        let id = app.id.clone();
        let mut caller =
            tokio::spawn(async move { rename(&owned, &id, None, Some("ps-new")).await });
        assert!(
            tokio::time::timeout(Duration::from_millis(300), &mut caller)
                .await
                .is_err(),
            "the rename should be waiting on the old-slug guard"
        );
        caller.abort();
        drop(guard);
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("rename canceled with its caller: the move never finished");
        let row = db::get_app(&state.pool, &app.id)
            .await
            .expect("lookup")
            .expect("row");
        assert_eq!(row.slug, "ps-new");
        drop(dir);
    }

    /// The alpha.22 delete bug: the app row was gone but the slug's push
    /// guard stayed held through the post-delete cleanup (edge push, provider
    /// revoke), so create/rename onto the slug waited past the control plane's
    /// 5 s and answered "operation aborted due to timeout". The row delete
    /// must release the guard before cleanup starts.
    #[tokio::test]
    async fn delete_frees_the_slug_before_cleanup_finishes() {
        // Accepts the edge push and never answers: the cleanup parks on it
        // until reqwest's request timeout. The first accept is the signal
        // that the row is gone and cleanup is in flight; the sockets stay
        // open, since dropping one would reset the request and end the hang.
        let admin = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stalled admin");
        let admin_url = format!("http://{}", admin.local_addr().expect("admin addr"));
        let reached = Arc::new(tokio::sync::Notify::new());
        let reached_tx = reached.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = admin.accept().await {
                reached_tx.notify_waiters();
                held.push(sock);
            }
        });
        let s3 = spawn_s3_stub().await;
        let (state, dir) = test_state_with_s3_and(10, s3, Some(admin_url)).await;
        let app = create(&state, "Doomed", "doomed", Some("u1"), None)
            .await
            .expect("create");
        let owned = state.clone();
        let id = app.id.clone();
        let deleting = tokio::spawn(async move { delete(&owned, &id).await });
        // The edge push starts only after the row delete; from then on the
        // slug must be usable even while that push is still parked.
        tokio::time::timeout(Duration::from_secs(5), reached.notified())
            .await
            .expect("the post-delete cleanup never reached the edge push");
        let push =
            tokio::time::timeout(Duration::from_millis(500), state.wal.sync().lock("doomed")).await;
        assert!(
            push.is_ok(),
            "the deleted slug's push guard is still held while cleanup runs"
        );
        drop(push);
        tokio::time::timeout(Duration::from_secs(30), deleting)
            .await
            .expect("delete finishes")
            .expect("delete task")
            .expect("delete ok");
        drop(dir);
    }

    /// A create must never wait on another slug's guard. Before 2026-11-12
    /// a process-wide create lock was taken *before* the slug guard, so one
    /// create parked behind a delete's wipe (or a push) stalled every other
    /// create — the owner's "creating an app under a different name failed
    /// for five minutes" right after a delete. `create_inner` is driven
    /// inline (no detached task) so the ordering below is the test's, not the
    /// scheduler's.
    #[tokio::test]
    async fn create_of_one_slug_never_waits_on_another_slugs_guard() {
        let (state, dir) = test_state(10).await;
        // Stand in for the wipe of a just-deleted app (or a push in flight):
        // `busy-slug`'s guard is held for as long as this test wants.
        let busy = state.wal.lock("busy-slug").await;
        let mut blocked = Box::pin(create_inner(&state, "Busy", "busy-slug", Some("u1"), None));
        let mut other = Box::pin(create_inner(
            &state,
            "Other",
            "other-slug",
            Some("u2"),
            None,
        ));
        // Biased: the blocked create is polled first, so it is parked on the
        // guard before the unrelated one is polled at all.
        let created = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::select! {
                biased;
                _ = &mut blocked => panic!("the parked create finished instead of waiting"),
                out = &mut other => out,
            }
        })
        .await
        .expect("a create for another slug waited on busy-slug's guard")
        .expect("the unrelated create lands");
        assert_eq!(created.slug, "other-slug");
        assert!(
            db::get_app_by_slug(&state.pool, "other-slug")
                .await
                .expect("lookup")
                .is_some(),
            "the unrelated app's row is stored"
        );
        // The blocked one is still waiting, not failed.
        drop(busy);
        let parked = tokio::time::timeout(Duration::from_secs(10), blocked)
            .await
            .expect("the create that waited on the guard never landed")
            .expect("the parked create lands once the guard frees");
        assert_eq!(parked.slug, "busy-slug");
        drop(dir);
    }

    /// The row is the edge's only source of truth, so a delete drops it before
    /// the wipe: the slug is free and answers "no app" while the wipe is still
    /// parked in the object store. Before 2026-11-12 the row (stopped) and the
    /// slug both outlived the whole wipe — a deleted app answered the "paused"
    /// page for minutes, and re-creating it was a 409 for the same window.
    #[tokio::test]
    async fn delete_frees_the_slug_before_the_wipe_finishes() {
        let gated = spawn_gated_s3_stub().await;
        let (state, dir) = test_state_with_s3(10, gated.endpoint.clone()).await;
        let app = create(&state, "SlowWipe", "slow-wipe", Some("u1"), None)
            .await
            .expect("create");
        gated.armed.store(true, std::sync::atomic::Ordering::SeqCst);
        let purged = crate::service::detached::finished(&format!("purge:{}", app.slug));

        let answered = delete(&state, &app.id).await.expect("delete answers");
        assert_eq!(answered, Deletion::Done);
        // The wipe is parked on its first S3 request, so nothing below can be
        // explained by the wipe having finished.
        tokio::time::timeout(Duration::from_secs(5), gated.entered.notified())
            .await
            .expect("the delete never started a background wipe");
        assert!(
            tokio::time::timeout(Duration::from_millis(200), purged.notified())
                .await
                .is_err(),
            "the wipe finished before the gate released it"
        );
        assert!(
            db::get_app(&state.pool, &app.id)
                .await
                .expect("lookup")
                .is_none(),
            "the row outlived the delete answer"
        );
        assert!(
            db::get_app_by_slug(&state.pool, "slow-wipe")
                .await
                .expect("lookup")
                .is_none(),
            "the slug is still taken while the wipe runs"
        );
        assert!(matches!(
            get_by_slug(&state, "slow-wipe").await,
            Err(ApiError::NotFound(_))
        ));
        // And the edge's own authoritative lookup (what `edge_fallback` uses)
        // finds nothing, which is what makes the deleted app answer "not
        // found" instead of the paused page.
        assert!(crate::db::get_app_by_slug(&state.pool, "slow-wipe")
            .await
            .expect("lookup")
            .is_none());

        gated.release.notify_one();
        tokio::time::timeout(Duration::from_secs(30), purged.notified())
            .await
            .expect("the background wipe never finished");
        assert!(
            !purge::stop("slow-wipe"),
            "a finished wipe left a live stop handle behind"
        );
        drop(dir);
    }

    /// S3 stub that parks the purge mid-flight: once armed, the first
    /// request is read, `entered` fires, and the response waits for
    /// `release`. Everything before arming — and every request after the
    /// release — answers an empty listing at once.
    struct GatedS3 {
        endpoint: String,
        entered: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Notify>,
        armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    async fn spawn_gated_s3_stub() -> GatedS3 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind gated s3 stub");
        let endpoint = format!("http://{}", listener.local_addr().expect("stub addr"));
        let entered = std::sync::Arc::new(tokio::sync::Notify::new());
        let release = std::sync::Arc::new(tokio::sync::Notify::new());
        let armed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let parked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let outer_entered = entered.clone();
        let outer_release = release.clone();
        let outer_armed = armed.clone();
        tokio::spawn(async move {
            fn is_object_op(request: &[u8]) -> Option<bool> {
                let line = request
                    .split(|byte| *byte == b'\n')
                    .next()
                    .and_then(|line| std::str::from_utf8(line).ok())?;
                let target = line.split_whitespace().nth(1)?;
                let mut halves = target.splitn(2, '?');
                let path = halves.next().unwrap_or("");
                let query = halves.next().unwrap_or("");
                if query.contains("list-type") {
                    return Some(false);
                }
                Some(path.trim_start_matches('/').contains('/'))
            }
            fn is_read(request: &[u8]) -> bool {
                request.starts_with(b"GET ") || request.starts_with(b"HEAD ")
            }
            let list_body = concat!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                "<Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                "</ListBucketResult>"
            );
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let entered = outer_entered.clone();
                let release = outer_release.clone();
                let armed = outer_armed.clone();
                let parked = parked.clone();
                let list_body = list_body.to_string();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 8192];
                    let _ = sock.read(&mut buf).await;
                    if armed.load(std::sync::atomic::Ordering::SeqCst)
                        && !parked.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        entered.notify_one();
                        release.notified().await;
                    }
                    let object = is_object_op(&buf).unwrap_or(false);
                    let (status, body) = if object && is_read(&buf) {
                        (
                            "404 Not Found",
                            concat!(
                                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                                "<Error><Code>NoSuchKey</Code>",
                                "<Message>missing</Message></Error>",
                            ),
                        )
                    } else if object {
                        ("200 OK", "")
                    } else {
                        ("200 OK", list_body.as_str())
                    };
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        GatedS3 {
            endpoint,
            entered,
            release,
            armed,
        }
    }

    /// F4: a failing step names itself and a failure class, never the store's
    /// internals (bucket, prefixes, work-dir paths, stderr), and carries the
    /// same short ref the runner log line does.
    #[test]
    fn step_failures_name_the_step_and_hide_internals() {
        let cases = [
            (
                "s3 list git/shop/ transport: operation timed out",
                "timed out",
            ),
            (
                "s3 delete-keys failed: AccessDenied access denied",
                "denied",
            ),
            (
                "clear S3 prefix s3://noite/fleets/shop/: connection refused",
                "unavailable",
            ),
            (
                "remove /data/work/projects/shop: Directory not empty",
                "not empty",
            ),
            ("NoSuchBucket: s3://noite/x", "could not find"),
            ("database is locked", "internal error"),
        ];
        for (detail, class) in cases {
            let message = step_failure("could not clear the deleted app's data", detail);
            assert!(message.contains(class), "{message} must name {class}");
            assert!(
                !message.contains("s3://"),
                "{message} must not name the bucket"
            );
            assert!(
                !message.contains("git/shop/"),
                "{message} must not name a prefix"
            );
            assert!(
                !message.contains("/data/work"),
                "{message} must not name a path"
            );
            assert!(
                message.contains("(ref "),
                "{message} must carry the log ref"
            );
        }
    }

    /// A dropped caller must not cancel a delete halfway: the control plane
    /// times the call out after 5 s, so a delete that outlasts it runs to
    /// completion anyway — the purge finishes, the row is gone and the app's
    /// keys stop being handed out. (Before: the purge cancelled with the
    /// caller and the row survived.)
    #[tokio::test]
    async fn delete_completes_when_caller_goes_away() {
        let gated = spawn_gated_s3_stub().await;
        let (state, dir) = test_state_with_s3(10, gated.endpoint).await;
        let app = create(&state, "Doomed", "doomed", Some("u1"), None)
            .await
            .expect("create");
        // A live scoped key: the delete's revoke must mark it even when the
        // caller is gone (the test store never deletes, so it stays
        // `revoking` instead of vanishing — the mark is what revoke owns).
        crate::db::insert_scoped_credential(
            &state.pool,
            &crate::db::NewScopedCredential {
                scope: &format!("app:{}", app.id),
                app_id: &app.id,
                handle: "test-handle",
                prefix: "fleets/doomed/",
                store: "test-store",
                nonce: b"nonce-12-bytes",
                ciphertext: b"ciphertext",
            },
        )
        .await
        .expect("insert scoped key");
        gated.armed.store(true, std::sync::atomic::Ordering::SeqCst);
        let id = app.id.clone();
        let done = crate::service::detached::finished(&format!("app:{id}"));
        let purged = crate::service::detached::finished(&format!("purge:{}", app.slug));

        // Drive the delete until its background wipe is parked inside S3, then
        // drop the caller — the control plane timing out is just the handler
        // future going away. (The delete answers as soon as the row is gone;
        // the gate catches it before or after, both are the same contract.)
        let mut slot = Some(Box::pin(delete(&state, &id)));
        let _ = tokio::select! {
            result = async { slot.as_mut().expect("delete future").await } => Some(result),
            () = gated.entered.notified() => None,
        };
        let _ = slot.take();
        gated.release.notify_one();

        // The background wipe still runs to its end, and the detached cleanup
        // still revokes the key — which lands after the row is gone. Waiting on
        // the row alone raced that revoke (CI 39751293992). A wipe or cleanup
        // cancelled with its caller never signals, and the bound turns that
        // into a failure instead of a hang.
        tokio::time::timeout(Duration::from_secs(30), purged.notified())
            .await
            .expect("the data wipe stopped when its caller went away");
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("delete cancelled with its caller: the detached work never finished");
        assert!(
            crate::db::get_app(&state.pool, &id)
                .await
                .expect("lookup")
                .is_none(),
            "the app row survived a dropped delete"
        );
        assert!(
            crate::db::live_scoped_credential(&state.pool, &format!("app:{id}"))
                .await
                .expect("key lookup")
                .is_none(),
            "the app's scoped key is still handed out after a dropped delete"
        );
        drop(dir);
    }

    /// Same guarantee for preview environments: a dropped caller must not
    /// cancel a teardown halfway and leave the fleet, the prefix or the row
    /// behind. (Before: the teardown cancelled with the caller and the row
    /// survived.)
    #[tokio::test]
    async fn environment_delete_completes_when_caller_goes_away() {
        let gated = spawn_gated_s3_stub().await;
        let (state, dir) = test_state_with_s3(10, gated.endpoint).await;
        let app = create(&state, "EnvApp", "envapp", Some("u1"), None)
            .await
            .expect("create");
        let env = crate::db::create_environment(
            &state.pool,
            &state.config,
            crate::db::NewEnvironment {
                app_id: &app.id,
                slug: &app.slug,
                label: "feature",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/feature",
                created_by: "user_1",
                listen: 30310,
                internal: 30311,
            },
        )
        .await
        .expect("environment");
        gated.armed.store(true, std::sync::atomic::Ordering::SeqCst);
        let done = crate::service::detached::finished(&format!("env:{}", env.id));

        // Drive the teardown until it reaches S3, then drop the caller.
        let mut slot = Some(Box::pin(crate::service::environments::delete(
            &state,
            &app.id,
            &env.id,
            Some("admin"),
        )));
        let finished = tokio::select! {
            result = async { slot.as_mut().expect("teardown future").await } => Some(result),
            () = gated.entered.notified() => None,
        };
        if let Some(result) = finished {
            panic!("teardown finished before reaching the gate: {result:?}");
        }
        let _ = slot.take();
        gated.release.notify_one();

        // The detached work still runs to its end; a teardown cancelled with
        // its caller never signals, and the bound turns that into a failure.
        tokio::time::timeout(Duration::from_secs(30), done.notified())
            .await
            .expect("teardown cancelled with its caller: the detached work never finished");
        assert!(
            crate::db::get_environment(&state.pool, &env.id)
                .await
                .expect("lookup")
                .is_none(),
            "the environment row survived a dropped delete"
        );
        drop(dir);
    }
}
