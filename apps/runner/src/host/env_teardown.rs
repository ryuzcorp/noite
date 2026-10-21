//! Preview environment teardown: one place that stops an environment's fleet
//! and wipes everything it owns, plus the ref-driven path (a deleted branch
//! deletes its environment).
//!
//! Order matches `host::purge`: the fleet goes down first, so nothing rewrites
//! D1 / DO / telemetry into the prefix about to be emptied.

use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::logs::LogState;
use crate::host::s3;
use crate::host::supervisor::{self, ProcMap};
use crate::models::{App, Environment};

/// Remove one environment: fleet, local state dir, S3 prefix, then its row.
/// The row goes last so a failure leaves something to retry (the same
/// reasoning as `purge_slug` + `delete_app`).
pub async fn teardown(
    cfg: &Config,
    pool: &SqlitePool,
    procs: &ProcMap,
    log_state: &LogState,
    env: &Environment,
) -> anyhow::Result<()> {
    supervisor::stop_environment_fleet(procs, &env.app_slug, &env.label).await;
    // Brief settle, same as purge: don't clear a dying node's prefix.
    tokio::time::sleep(Duration::from_millis(500)).await;
    crate::host::logs::clear(
        log_state,
        &supervisor::env_fleet_key(&env.app_slug, &env.label),
    )
    .await;
    let state_dir = supervisor::env_state_dir(cfg, &env.app_slug, &env.label);
    if state_dir.exists() {
        tokio::fs::remove_dir_all(&state_dir)
            .await
            .with_context(|| format!("remove {}", state_dir.display()))?;
    }
    clear_env_prefix(cfg, &env.app_slug, &env.label).await?;
    db::delete_environment(pool, &env.id).await?;
    tracing::info!(
        slug = %env.app_slug,
        label = %env.label,
        "tore down preview environment"
    );
    Ok(())
}

/// Empty one environment's bucket prefix (`envs/<slug>/<label>/`). Idempotent:
/// an empty listing is a no-op, so a retry after a partial delete is safe.
pub async fn clear_env_prefix(cfg: &Config, slug: &str, label: &str) -> anyhow::Result<()> {
    let prefix = cfg.envs_prefix(slug);
    s3::s3_rm_prefix(cfg, &cfg.s3_bucket, &format!("{prefix}{label}/"))
        .await
        .with_context(|| format!("clear S3 prefix {prefix}{label}/"))
}

/// A push or server-side ref move deleted refs: every environment whose ref
/// disappeared is torn down (ROADMAP — deleting the branch deletes its
/// environment; a workspace preview's hidden ref is deleted with it). Moves
/// are not handled here: the deploy side is driven by `tips::TipNotify`.
pub async fn on_refs_deleted(state: &crate::AppState, app: &App, deleted: &[String]) {
    for refname in deleted {
        let Ok(Some(env)) = db::get_environment_by_ref(&state.pool, &app.id, refname).await else {
            continue;
        };
        tracing::info!(
            slug = %app.slug,
            label = %env.label,
            ref = %refname,
            "ref deleted; removing its environment"
        );
        if let Err(e) = teardown(&state.config, &state.pool, &state.procs, &state.logs, &env).await
        {
            tracing::warn!(slug = %app.slug, error = %format!("{e:#}"), "environment teardown failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{new_id, EnvironmentKind};

    /// The ref-driven rule: only the environment whose ref vanished is
    /// removed, a moved ref is left alone.
    #[tokio::test]
    async fn deleted_ref_removes_only_its_environment() {
        let dir = std::env::temp_dir().join(format!("noite-env-teardown-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = db::connect(&url).await.expect("boot");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        // Unreachable on purpose: the first pass proves the wipe failure
        // leaves the row for a retry instead of dropping it silently.
        cfg.s3_endpoint = "http://127.0.0.1:1".into();
        let state = crate::AppState {
            pool: pool.clone(),
            config: std::sync::Arc::new(cfg),
            procs: supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify: tokio::sync::watch::channel(0u64).0,
            git_sync: crate::host::git_manifest::GitSync::default(),
            tip_tx: crate::host::tips::channel().0,
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: std::sync::Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
        };
        let app = db::create_app(
            &pool,
            &state.config,
            db::NewApp {
                name: "tear",
                slug: "tear",
                user_id: "local",
                subdomain: "tear.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("app");
        let gone = db::create_environment(
            &pool,
            &state.config,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "tear",
                label: "gone",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/gone",
                created_by: "user_1",
                listen: 30110,
                internal: 30111,
            },
        )
        .await
        .expect("env gone");
        let moved = db::create_environment(
            &pool,
            &state.config,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "tear",
                label: "kept",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/kept",
                created_by: "user_1",
                listen: 30120,
                internal: 30121,
            },
        )
        .await
        .expect("env kept");
        let state_dir = supervisor::env_state_dir(&state.config, "tear", "gone");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("deploy.json"), "{}").unwrap();

        // Only `refs/heads/gone` vanished; `kept` merely moved.
        on_refs_deleted(&state, &app, &[("refs/heads/gone").to_string()]).await;

        let survivors: Vec<String> = db::list_environments(&pool, &app.id)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.label)
            .collect();
        assert_eq!(survivors.len(), 2);
        assert!(survivors.contains(&"gone".to_string()));
        assert!(survivors.contains(&"kept".to_string()));
        assert!(!state_dir.exists());

        // Retry against a reachable (empty) listing: the row goes.
        let mut cfg2 = (*state.config).clone();
        cfg2.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let retry = crate::AppState {
            config: std::sync::Arc::new(cfg2),
            ..state.clone()
        };
        on_refs_deleted(&retry, &app, &[("refs/heads/gone").to_string()]).await;
        assert!(db::get_environment(&pool, &gone.id)
            .await
            .unwrap()
            .is_none());
        assert!(db::get_environment(&pool, &moved.id)
            .await
            .unwrap()
            .is_some());
        state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
