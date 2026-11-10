//! App CRUD + sleep: the operations behind `apps.*` (RPC) and
//! `/v1/apps...` (REST).

use std::sync::LazyLock;
use std::time::Duration;

use crate::api_error::ApiError;
use crate::db;
use crate::host::{deploy, git_http, import, purge, rename, sleep, supervisor};
use crate::lifecycle::slug_ok;
use crate::models::{App, AppSource, AppStatus, DesiredState, WriteGuard};
use crate::AppState;

/// Serializes the create critical section (NOITE-APPS-001). The per-account
/// quota is a count-then-insert, and the purge of a slug's leftovers destroys
/// data, so two creates that interleave there can slip past the limit — or wipe
/// the mirrors of a slug another create just landed. Creating an app is
/// human-paced (and the push-to-create path), so one process-wide lock is the
/// honest fix: the whole check → purge → quota → insert sequence runs alone.
///
/// Lock ordering with the other guards (deadlock rule, see
/// [`ryuz_git::GitSync`]): `CREATE_LOCK` is outermost, then
/// the per-app `AppLock`, then the per-slug lock. Create holds
/// `CREATE_LOCK` + its slug's lock; a slug-changing rename holds all
/// three; delete holds `AppLock` + its slug's lock.
static CREATE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

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
        .map(|apps| apps.into_iter().filter(|app| !deleting(&app.id)).collect())
        .map_err(|e| ApiError::internal(e.to_string()))
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
        Ok(Some(app)) if !deleting(&app.id) => Ok(app),
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
    if name.is_empty() || !slug_ok(&slug) {
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
    // NOITE-APPS-001: from here on the function reads and destroys state, so it
    // runs under one lock — the slug re-check, the purge, the quota count and
    // the insert cannot interleave with another create.
    let _create = CREATE_LOCK.lock().await;
    // R-12: the purge destroys the same `git/<slug>/` + `fleets/<slug>/`
    // prefixes pushes write under the slug lock, so the guard stays
    // held across purge → init → insert (ordering: CREATE_LOCK → slug lock).
    // A push to a half-created slug either lands fully before the purge or
    // waits for the row.
    let _push = state.wal.lock(slug).await;
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(_)) => return Err(ApiError::conflict("slug already taken")),
        Ok(None) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    // Always wipe leftover S3/local data for this slug before the new row lands
    // — safe now: no row exists for it (checked just above, under these locks).
    // Callers of `purge_slug` hold the slug's push guard (see its docs); the
    // `_push` guard above is that holder for this path.
    if let Err(e) = purge::purge_slug(
        &state.config,
        &state.procs,
        &state.logs,
        state.wal.sync(),
        slug,
        supervisor::StopGrace::NORMAL,
    )
    .await
    {
        return Err(ApiError::internal(format!(
            "failed to clear slug data: {e:#}"
        )));
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
            Err(e) => return Err(ApiError::internal(e.to_string())),
        }
    }
    // A0: both bare mirrors exist, HEAD at `main`, before the app row does — a
    // failure here leaves no half-created app behind.
    if let Err(e) = git_http::init_repos(state, slug).await {
        return Err(ApiError::internal(format!(
            "failed to initialize the git repositories: {e:#}"
        )));
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
        sqlx::Error::RowNotFound => ApiError::conflict(format!(
            "fleet port range {}-{} exhausted; raise NOITE_FLEET_PORTS",
            state.config.fleet_port_min, state.config.fleet_port_max
        )),
        other => ApiError::internal(other.to_string()),
    })?;
    let app = db::create_app(
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
    .map_err(|e| ApiError::internal(e.to_string()))?;
    drop(ports);
    let Some(git) = git_source else {
        return Ok(app);
    };
    // An import is a background job (A2): store the source so it can be retried,
    // flip the status, and answer at once.
    let stored = serde_json::to_string(&AppSource::Git(git.clone()))
        .map_err(|e| ApiError::internal(e.to_string()))?;
    db::set_app_import_source(&state.pool, &app.id, Some(&stored))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    db::write_app_status(
        &state.pool,
        &app.id,
        AppStatus::Importing,
        None,
        None,
        WriteGuard::Table,
    )
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    let app = app_or_404(state, &app.id).await?;
    import::spawn(state, app.clone(), git.clone());
    Ok(app)
}

/// Retry a failed import (A2) with the source stored on the app row.
pub async fn retry_import(state: &AppState, id: &str) -> Result<App, ApiError> {
    let app = app_or_404(state, id).await?;
    let Some(stored) = app.import_source.clone() else {
        return Err(ApiError::bad("this app was not created from an import"));
    };
    let source: AppSource = serde_json::from_str(&stored)
        .map_err(|e| ApiError::internal(format!("stored import source is unreadable: {e}")))?;
    let AppSource::Git(git) = source else {
        return Err(ApiError::bad("this app was not created from an import"));
    };
    // `importing` with a live task is a real conflict; `importing` without one
    // is an import interrupted by a restart, which is what Retry is for.
    if app.status == AppStatus::Importing && import::running(&app.id) {
        return Err(ApiError::conflict("an import is already running"));
    }
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
    let app = app_or_404(state, &app.id).await?;
    import::spawn(state, app.clone(), git);
    Ok(app)
}

pub async fn patch(state: &AppState, id: &str, desired: Option<&str>) -> Result<App, ApiError> {
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
        let out = rename_inner(&state, &id, name.as_deref(), slug.as_deref()).await;
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
    // R-03: the slug-taken check is per-slug but the rename lock is per app
    // id, so two apps renaming onto one slug could both pass and both move
    // prefixes before the second fails at the row write. A slug-changing
    // rename therefore holds CREATE_LOCK across check → move → row update
    // (ordering: CREATE_LOCK → AppLock → push_guard), serializing it against
    // creates and every other slug rename. Name-only renames move nothing
    // and skip it.
    let _create = if slug.is_some() {
        Some(CREATE_LOCK.lock().await)
    } else {
        None
    };
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
        state.wal.sync(),
        id,
        name,
        slug,
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
            } else if msg.contains("slug already taken") || msg.contains("UNIQUE constraint") {
                // Late loser of a slug race: the row write refused it after
                // the moves. Still a 409, never a 500.
                Err(ApiError::conflict("slug already taken"))
            } else {
                Err(ApiError::internal(msg))
            }
        }
    }
}

/// What a delete call reports: finished, or still purging in the
/// background (a slow store or a deploy in flight).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deletion {
    Done,
    InProgress,
}

/// How long a delete call waits for the purge before answering
/// [`Deletion::InProgress`]: under the control plane's 5 s bound on every
/// runner call (`apps/noite/src/lib/runner.ts`), so a purge that takes
/// longer (thousands of telemetry objects on a slow store, a deploy holding
/// the claim for minutes) never surfaces as a timeout.
const DELETE_ANSWER_WITHIN: Duration = Duration::from_secs(3);

/// How long the best-effort cleanup after the row delete may take. The app
/// row (and the slug's push guard) are already released when it starts, so a
/// hung provider or Caddy call can only delay this task, never a create or
/// rename onto the slug; the bound also stops a permanently stuck provider
/// from leaking the detached task and its in-memory delete marker.
const DELETE_CLEANUP_WITHIN: Duration = Duration::from_secs(30);

/// Where one app's delete is (RDEP-6). There is no DB column for it on
/// purpose (a hard DELETE is the only removal path): the phases live in the
/// process, and a runner restart mid-delete leaves the app stopped and
/// listed again, which a second delete finishes.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Purging: DELETE claims the app (hidden from list/get)
///   Purging --> Cleanup: the row is gone and the slug is free
///   Cleanup --> [*]: routes, credentials and tokens done (bounded)
///   Purging --> [*]: purge failed; the row stays stopped and listed again
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeletePhase {
    /// Claimed: the fleet is stopping, the slug's data is being wiped.
    Purging,
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
    /// reports [`Deletion::InProgress`] instead of starting a second purge).
    fn begin(&self, id: &str) -> bool {
        self.guard()
            .insert(id.to_string(), DeletePhase::Purging)
            .is_none()
    }

    /// Move a claimed app on. Only ever Purging → Cleanup, and only while the
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
/// ([`list`], [`get`], [`get_by_slug`]).
fn deleting(id: &str) -> bool {
    DELETIONS.phase(id).is_some()
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
    let app = app_or_404(state, id).await?;
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
            let note = format!("delete failed: {e}; delete the app again to retry");
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
    let app = app_or_404(state, id).await?;
    // Same lock as deploy: wait out an in-flight build, then purge exclusively.
    // The row is deleted while the claim is still held (R-01): a waiter that
    // acquires after us must find no row and bail instead of building into
    // the just-purged prefix. Ordering here is AppLock → slug lock (see
    // [`ryuz_git::GitSync`]); `purge_slug` requires its
    // callers to hold the slug's lock. The guard releases on every
    // return below — and on cancel or panic — so a dropped delete can never
    // wedge later deletes behind a stale "deploy in flight".
    let Some(claim) =
        deploy::claim_wait_owned(&state.deploying, &app.id, Duration::from_secs(120)).await
    else {
        return Err(ApiError::conflict("deploy in flight; retry delete shortly"));
    };
    // R-02: a concurrent push writes under the slug lock across git +
    // S3 + manifest; the purge must not run inside one of those writes.
    let push = state.wal.lock(&app.slug).await;
    // Mark it stopped before the fleet goes down: the purge takes seconds
    // (S3 prefixes), and an app still marked running is respawned in that
    // window by the reconcile loop or by a wake. A failed purge leaves the
    // app stopped, which a retried delete finishes.
    if let Err(e) = db::patch_app_desired(&state.pool, &app.id, DesiredState::Stopped).await {
        return Err(ApiError::internal(e.to_string()));
    }
    let purge_result = purge::purge_slug(
        &state.config,
        &state.procs,
        &state.logs,
        state.wal.sync(),
        &app.slug,
        supervisor::StopGrace::FOR_DELETE,
    )
    .await;
    if let Err(e) = purge_result {
        return Err(ApiError::internal(format!(
            "failed to purge app data: {e:#}"
        )));
    }
    let delete_result = db::delete_app(&state.pool, id).await;
    delete_result.map_err(|e| ApiError::internal(e.to_string()))?;
    // A reconcile tick (or a wake) that listed the app before the stop above
    // can still have started the fleet again; with the row gone nothing else
    // would stop it. Stop it while the push guard is still ours: releasing
    // the slug first would let a new app with the same slug spawn, and this
    // late stop would kill *its* fleet.
    supervisor::stop_fleet(&state.procs, &app.slug, supervisor::StopGrace::FOR_DELETE).await;
    // The row is gone and no fleet can start under this slug any more:
    // release the slug's push guard and the app's deploy claim *now*, before
    // the best-effort cleanup below. Create and rename onto this slug wait on
    // the guard (and the control plane aborts their runner call after 5 s); a
    // hung provider or Caddy call must never keep the slug unusable — that
    // was the "deleted app, slug still taken" bug.
    drop(push);
    drop(claim);
    // The row is gone and the slug is free: only the best-effort cleanup is
    // left, which is the state a caller's 202 keeps the app in.
    DELETIONS.advance(id, DeletePhase::Cleanup);
    let cleanup = async {
        if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
            tracing::warn!(app_id = %id, error = %format!("{e:#}"), "edge push after app delete");
        }
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

    /// The delete registry owns "is this app being deleted": one claim per
    /// app, one-way phase, and a release on every exit path (the drop guard
    /// is what a panic or a dropped caller relies on).
    #[test]
    fn the_delete_claim_is_one_per_app_and_released_on_drop() {
        let id = "sm-delete-claim-test";
        assert!(DELETIONS.begin(id), "the first delete claims the app");
        assert!(!DELETIONS.begin(id), "a second delete reports the first");
        assert_eq!(DELETIONS.phase(id), Some(DeletePhase::Purging));
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

    /// R-03: two apps renaming onto one slug serialize under CREATE_LOCK —
    /// exactly one wins and the loser is a 409, with no prefix moves leaking
    /// onto the target before the conflict.
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

        // Drive the delete until the purge reaches S3, then drop the caller —
        // the control plane timing out is just the handler future going away.
        let mut slot = Some(Box::pin(delete(&state, &id)));
        let finished = tokio::select! {
            result = async { slot.as_mut().expect("delete future").await } => Some(result),
            () = gated.entered.notified() => None,
        };
        if let Some(result) = finished {
            panic!("delete finished before reaching the gate: {result:?}");
        }
        let _ = slot.take();
        gated.release.notify_one();

        // The detached work still runs to its end — every effect, the key's
        // revoke included, which lands after the row is gone. Waiting on the
        // row alone raced that revoke (CI 39751293992). A delete cancelled
        // with its caller never signals, and the bound turns that into a
        // failure instead of a hang.
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
