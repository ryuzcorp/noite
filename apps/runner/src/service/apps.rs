//! App CRUD + sleep: the operations behind `apps.*` (RPC) and
//! `/v1/apps...` (REST).

use std::sync::LazyLock;
use std::time::Duration;

use crate::api_error::ApiError;
use crate::db;
use crate::host::{deploy, git_http, import, purge, rename, sleep};
use crate::lifecycle::slug_ok;
use crate::models::{App, AppSource, AppStatus, DesiredState};
use crate::AppState;

/// Serializes the create critical section (NOITE-APPS-001). The per-account
/// quota is a count-then-insert, and the purge of a slug's leftovers destroys
/// data, so two creates that interleave there can slip past the limit — or wipe
/// the mirrors of a slug another create just landed. Creating an app is
/// human-paced (and the push-to-create path), so one process-wide lock is the
/// honest fix: the whole check → purge → quota → insert sequence runs alone.
static CREATE_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

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
            Some(git)
        }
        Some(AppSource::Blank) | None => None,
    };
    // NOITE-APPS-001: from here on the function reads and destroys state, so it
    // runs under one lock — the slug re-check, the purge, the quota count and
    // the insert cannot interleave with another create.
    let _create = CREATE_LOCK.lock().await;
    match db::get_app_by_slug(&state.pool, &slug).await {
        Ok(Some(_)) => return Err(ApiError::conflict("slug already taken")),
        Ok(None) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    // Always wipe leftover S3/local data for this slug before the new row lands
    // — safe now: no row exists for it (checked just above, under this lock).
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
        let dir =
            std::env::temp_dir().join(format!("noite-create-tests-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let s3 = spawn_s3_stub().await;
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
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
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
}
