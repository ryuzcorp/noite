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
/// Deployments tab filters by environment). Lean rows like the stream
/// (T1.7): finished rows carry no build log (fetch it from `log` on demand),
/// only the newest in-flight row keeps its live log.
pub async fn list(
    state: &AppState,
    id: &str,
    environment_id: Option<&str>,
) -> Result<Vec<Deploy>, ApiError> {
    db::list_deploys_lean(&state.pool, id, environment_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn test_state() -> AppState {
        let dir =
            std::env::temp_dir().join(format!("noite-deploys-list-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        AppState {
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
        }
    }

    async fn seed_app(state: &AppState, slug: &str) -> crate::models::App {
        db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: slug,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    #[tokio::test]
    async fn list_serves_finished_rows_without_build_logs() {
        let state = test_state().await;
        let app = seed_app(&state, "lean").await;
        db::upsert_deploy(
            &state.pool,
            None,
            &app.id,
            None,
            "success",
            Some("abc1234"),
            "full build log",
        )
        .await
        .expect("seed deploy");

        let rows = list(&state, &app.id, None).await.expect("list");

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].log, "",
            "a finished deploy's log rides its own endpoint, not every list row"
        );
    }

    #[tokio::test]
    async fn list_keeps_the_newest_in_flight_log() {
        let state = test_state().await;
        let app = seed_app(&state, "live").await;
        db::upsert_deploy(
            &state.pool,
            None,
            &app.id,
            None,
            "building",
            Some("def5678"),
            "live log",
        )
        .await
        .expect("seed deploy");

        let rows = list(&state, &app.id, None).await.expect("list");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].log, "live log");
    }
}
