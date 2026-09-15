//! Noite runner — Oxide UI talks bearer REST; this process owns fleets, Caddy, and S3.
//!
//! Lifecycle invariants (see also `lifecycle`):
//! 1. Deploy and purge share `AppLock` — never overlapping S3 writers for a slug.
//! 2. Purge artifacts, then delete the DB row (create is the inverse).
//! 3. `desired_state` is only running|stopped; removal is hard DELETE.
//! 4. Metrics watermark advances only after a successful telemetry agg.
mod api;
mod auth;
mod config;
mod db;
mod error;
mod host;
mod lifecycle;
mod models;

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use sqlx::SqlitePool;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::config::Config;
use crate::host::deploy::Deploying;
use crate::host::logs::LogState;
use crate::host::supervisor::ProcMap;
use crate::lifecycle::DEPLOY_STUCK_MS;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub procs: ProcMap,
    pub logs: LogState,
    pub deploying: Deploying,
    pub git_sync: host::git_manifest::GitSync,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "noite_runner=info,tower_http=info".into()),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    tokio::fs::create_dir_all(&config.work_dir).await.ok();

    host::cmd::ensure_buckets(&config).await?;

    let pool = db::connect(&config.database_url).await?;
    let swept = db::fail_stuck_deploys(&pool, DEPLOY_STUCK_MS, &HashSet::new())
        .await
        .unwrap_or(0);
    if swept > 0 {
        tracing::info!(swept, "swept stalled deploys on boot");
    }

    let procs = host::supervisor::new_procs();
    let logs = host::logs::new_state();
    // Reclaim leftover soft-delete rows from pre-hard-DELETE era.
    reclaim_legacy_soft_deletes(&pool, &config, &procs, &logs).await;

    let deploying = host::deploy::new_deploying();
    let metrics = host::metrics::new_state();
    let state = AppState {
        pool: pool.clone(),
        config: config.clone(),
        procs: procs.clone(),
        logs: logs.clone(),
        deploying: deploying.clone(),
        git_sync: host::git_manifest::GitSync::default(),
    };

    let cfg_loop = (*config).clone();
    tokio::spawn(host::loop_::run_forever(
        pool,
        cfg_loop,
        procs,
        logs,
        deploying,
        metrics,
    ));

    let app = Router::new()
        .route("/health", get(api::health))
        .route("/v1/edge/fallback", get(host::edge::edge_fallback))
        .route("/webhook", post(api::webhook))
        .route("/v1/apps", get(api::list_apps).post(api::create_app))
        .route(
            "/v1/apps/{id}",
            get(api::get_app).patch(api::patch_app).delete(api::delete_app),
        )
        .route("/v1/apps/{id}/rename", post(api::rename_app))
        .route("/v1/apps/{id}/deploys", get(api::list_deploys))
        .route("/v1/apps/{id}/git-remote", post(api::git_remote))
        .route("/v1/apps/{id}/tree", get(api::source_tree))
        .route("/v1/apps/{id}/blob/{*path}", get(api::source_blob))
        .route("/v1/apps/{id}/diff", get(api::source_diff))
        .route("/v1/apps/{id}/metrics", get(api::app_metrics))
        .route("/v1/apps/{id}/spans", get(api::app_spans))
        .route("/v1/apps/{id}/logs", get(api::app_logs))
        .route("/v1/apps/{id}/logs/stream", get(api::app_logs_stream))
        .route("/v1/apps/{id}/storage", get(api::app_storage))
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}",
            get(api::app_d1),
        )
        .route(
            "/v1/apps/{id}/storage/do/{class_name}",
            get(api::app_do),
        )
        .route(
            "/v1/apps/{id}/storage/r2/{bucket}",
            get(api::app_r2),
        )
        .route(
            "/v1/apps/{id}/storage/r2/{bucket}/object",
            get(api::app_r2_object).delete(api::app_r2_delete),
        )
        .route(
            "/v1/apps/{id}/storage/r2/{bucket}/raw",
            get(api::app_r2_raw),
        )
        .route(
            "/v1/git/{slug}/info/refs",
            get(host::git_http::info_refs),
        )
        .route(
            "/v1/git/{slug}/git-upload-pack",
            post(host::git_http::upload_pack),
        )
        .route(
            "/v1/git/{slug}/git-receive-pack",
            post(host::git_http::receive_pack),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            |axum::extract::State(s): axum::extract::State<AppState>,
             req,
             next| async move { auth::require_bearer(s, req, next).await },
        ))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "noite-runner listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn reclaim_legacy_soft_deletes(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
) {
    let Ok(apps) = db::list_all_apps(pool).await else {
        return;
    };
    for app in apps {
        let soft = app.desired_state == "deleted"
            || app.status == "deleting"
            || app.status == "gone";
        if !soft {
            continue;
        }
        tracing::info!(slug = %app.slug, "reclaiming legacy soft-deleted app");
        if let Err(e) = host::purge::purge_slug(cfg, procs, logs, &app.slug).await {
            tracing::error!(slug = %app.slug, error = %e, "legacy purge failed");
            continue;
        }
        if let Err(e) = db::delete_app(pool, &app.id).await {
            tracing::error!(slug = %app.slug, error = %e, "legacy row delete failed");
        }
    }
}
