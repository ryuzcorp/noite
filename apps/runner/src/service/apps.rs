//! App CRUD + sleep: the operations behind `apps.*` (RPC) and
//! `/v1/apps...` (REST).

use std::sync::LazyLock;
use std::time::Duration;

use crate::api_error::ApiError;
use crate::db;
use crate::host::{deploy, git_http, import, purge, rename, sleep, supervisor};
use crate::lifecycle::slug_ok;
use crate::models::{App, AppSource, AppStatus, DesiredState};
use crate::AppState;

/// Serializes the create critical section (NOITE-APPS-001). The per-account
/// quota is a count-then-insert, and the purge of a slug's leftovers destroys
/// data, so two creates that interleave there can slip past the limit — or wipe
/// the mirrors of a slug another create just landed. Creating an app is
/// human-paced (and the push-to-create path), so one process-wide lock is the
/// honest fix: the whole check → purge → quota → insert sequence runs alone.
///
/// Lock ordering with the other guards (deadlock rule, see
/// [`crate::host::git_manifest::GitSync`]): `CREATE_LOCK` is outermost, then
/// the per-app `AppLock`, then the per-slug `push_guard`. Create holds
/// `CREATE_LOCK` + its slug's `push_guard`; a slug-changing rename holds all
/// three; delete holds `AppLock` + its slug's `push_guard`.
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
    source: Option<&AppSource>,
) -> Result<App, ApiError> {
    let name = name.trim().to_string();
    let slug = slug.trim().to_lowercase();
    if name.is_empty() || !slug_ok(&slug) {
        return Err(ApiError::bad("invalid name/slug"));
    }
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
    // prefixes pushes write under `push_guard(&slug)`, so the guard stays
    // held across purge → init → insert (ordering: CREATE_LOCK → push_guard).
    // A push to a half-created slug either lands fully before the purge or
    // waits for the row.
    let _push = state.git_sync.push_guard(&slug).await;
    match db::get_app_by_slug(&state.pool, &slug).await {
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
        &state.git_sync,
        &slug,
        supervisor::StopGrace::NORMAL,
    )
    .await
    {
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
    // A0: both bare mirrors exist, HEAD at `main`, before the app row does — a
    // failure here leaves no half-created app behind.
    if let Err(e) = git_http::init_repos(&state.config, &slug).await {
        return Err(ApiError::internal(format!(
            "failed to initialize the git repositories: {e:#}"
        )));
    }
    // No credential row: only a scoped provider (Phase 4) mints one.
    let app = db::create_app(
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
    .map_err(|e| ApiError::internal(e.to_string()))?;
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
    if let Err(e) = db::update_app_status(
        &state.pool,
        &app.id,
        AppStatus::Importing.as_str(),
        None,
        None,
    )
    .await
    {
        return Err(ApiError::internal(e.to_string()));
    }
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
    if app.status == AppStatus::Importing.as_str() && import::running(&app.id) {
        return Err(ApiError::conflict("an import is already running"));
    }
    if let Err(e) = db::update_app_status(
        &state.pool,
        &app.id,
        AppStatus::Importing.as_str(),
        None,
        None,
    )
    .await
    {
        return Err(ApiError::internal(e.to_string()));
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
        db::patch_app_desired(&state.pool, id, ds.as_str())
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
        &state.git_sync,
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

pub async fn delete(state: &AppState, id: &str) -> Result<(), ApiError> {
    // A dropped HTTP handler must not cancel the purge halfway: the control
    // plane times the call out after 5 s, and a cancelled delete leaves the
    // app row, the fleet and the scoped credentials behind. The destructive
    // work runs as its own task, so dropping this future only drops the
    // waiter — the task runs to completion either way. The handler still
    // awaits it, so a connected caller gets the real outcome.
    let state = state.clone();
    let id = id.to_string();
    match tokio::spawn(async move { delete_inner(&state, &id).await }).await {
        Ok(result) => result,
        Err(join) => Err(ApiError::internal(format!(
            "app delete task failed: {join}"
        ))),
    }
}
async fn delete_inner(state: &AppState, id: &str) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    // Same lock as deploy: wait out an in-flight build, then purge exclusively.
    // The row is deleted while the claim is still held (R-01): a waiter that
    // acquires after us must find no row and bail instead of building into
    // the just-purged prefix. Ordering here is AppLock → push_guard (see
    // [`crate::host::git_manifest::GitSync`]); `purge_slug` requires its
    // callers to hold the slug's push guard. The guard releases on every
    // return below — and on cancel or panic — so a dropped delete can never
    // wedge later deletes behind a stale "deploy in flight".
    let Some(claim) =
        deploy::claim_wait_owned(&state.deploying, &app.id, Duration::from_secs(120)).await
    else {
        return Err(ApiError::conflict("deploy in flight; retry delete shortly"));
    };
    // R-02: a concurrent push writes under `push_guard(&slug)` across git +
    // S3 + manifest; the purge must not run inside one of those writes.
    let _push = state.git_sync.push_guard(&app.slug).await;
    // Mark it stopped before the fleet goes down: the purge takes seconds
    // (S3 prefixes), and an app still marked running is respawned in that
    // window by the reconcile loop or by a wake. A failed purge leaves the
    // app stopped, which a retried delete finishes.
    if let Err(e) =
        db::patch_app_desired(&state.pool, &app.id, DesiredState::Stopped.as_str()).await
    {
        return Err(ApiError::internal(e.to_string()));
    }
    let purge_result = purge::purge_slug(
        &state.config,
        &state.procs,
        &state.logs,
        &state.git_sync,
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
    drop(claim);
    delete_result.map_err(|e| ApiError::internal(e.to_string()))?;
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(app_id = %id, error = %format!("{e:#}"), "edge push after app delete");
    }
    // A reconcile tick that listed apps before the stop above can still have
    // started the fleet again; with the row gone nothing else would stop it.
    supervisor::stop_fleet(&state.procs, &app.slug, supervisor::StopGrace::FOR_DELETE).await;
    // Revoke the app's keys and its environments' (SPEC, Scoped credentials).
    // R-10: a revoke failure must not vanish — warn loudly so the orphaned
    // credential row is visible instead of silently kept.
    if let Err(e) = crate::host::credentials::revoke_app(&state.pool, &state.config, id).await {
        tracing::warn!(app_id = %id, error = %format!("{e:#}"), "app deleted but credential revoke failed");
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

    /// In-process S3 stand-in: every request answers an empty `ListObjectsV2`
    /// page, so purge and cold-mirror hydration see "nothing there" instead of
    /// dialing RustFS (the stub the API parity tests use). Bodies and deletes
    /// are never reached: an empty listing short-circuits both.
    async fn spawn_s3_stub() -> String {
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
                    let body = concat!(
                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                        "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                        "<Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                        "</ListBucketResult>"
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    /// One runner state with a per-account app limit of `max_apps`.
    async fn test_state(max_apps: u32) -> (AppState, std::path::PathBuf) {
        let s3 = spawn_s3_stub().await;
        test_state_with_s3(max_apps, s3).await
    }

    /// Same, against a caller-supplied S3 endpoint: a test that must park
    /// the purge mid-flight gates the stub instead of answering at once.
    async fn test_state_with_s3(max_apps: u32, s3: String) -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("noite-create-tests-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.s3_endpoint = s3.clone();
        cfg.s3_public_endpoint = s3;
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        cfg.max_apps_per_user = max_apps;
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        let state = AppState {
            pool,
            config,
            procs: crate::host::supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify,
            git_sync: crate::host::git_manifest::GitSync::default(),
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
        };
        (state, dir)
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let deleting = tokio::spawn(async move { delete(&owned, &id).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            !deleting.is_finished(),
            "delete must wait out the deploy claim"
        );
        // The delete holds the claim through purge + row delete: wait until
        // it owns the claim, then queue a waiter behind it (an explicit
        // deploy's `claim_wait`). The purge's settle sleep keeps this window
        // wide open.
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
            tokio::time::sleep(Duration::from_millis(50)).await;
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
        let _ = std::fs::remove_dir_all(&dir);
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// R-12: create holds the slug's push guard across purge → init →
    /// insert, so a create queued behind a push (or vice versa) serializes
    /// instead of wiping a half-written prefix.
    #[tokio::test]
    async fn create_waits_for_an_in_flight_push_guard() {
        let (state, dir) = test_state(10).await;
        let _push = state.git_sync.push_guard("guarded").await;
        let owned = state.clone();
        let creating =
            tokio::spawn(
                async move { create(&owned, "Guarded", "guarded", Some("u1"), None).await },
            );
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            !creating.is_finished(),
            "create must wait for the slug push guard"
        );
        drop(_push);
        let app = tokio::time::timeout(Duration::from_secs(30), creating)
            .await
            .expect("create finishes")
            .expect("create task")
            .expect("create ok");
        assert_eq!(app.slug, "guarded");
        let _ = std::fs::remove_dir_all(&dir);
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
        let _push = state.git_sync.push_guard("ps-old").await;
        let owned = state.clone();
        let id = app.id.clone();
        let renaming = tokio::spawn(async move { rename(&owned, &id, None, Some("ps-new")).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            !renaming.is_finished(),
            "rename must wait for the old-slug push guard"
        );
        drop(_push);
        let renamed = tokio::time::timeout(Duration::from_secs(30), renaming)
            .await
            .expect("rename finishes")
            .expect("rename task")
            .expect("rename ok");
        assert_eq!(renamed.slug, "ps-new");
        let _ = std::fs::remove_dir_all(&dir);
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
            let body = concat!(
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
                let body = body.to_string();
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
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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

        // The detached work still runs: the row must go and the key must stop
        // being handed out.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let gone = crate::db::get_app(&state.pool, &id)
                .await
                .expect("lookup")
                .is_none();
            if gone {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "delete cancelled with its caller: the app row survived a dropped delete"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            crate::db::live_scoped_credential(&state.pool, &format!("app:{id}"))
                .await
                .expect("key lookup")
                .is_none(),
            "the app's scoped key is still handed out after a dropped delete"
        );
        let _ = std::fs::remove_dir_all(&dir);
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

        // The detached work still runs: the row must go.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let gone = crate::db::get_environment(&state.pool, &env.id)
                .await
                .expect("lookup")
                .is_none();
            if gone {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "teardown cancelled with its caller: the environment row survived a dropped delete"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
