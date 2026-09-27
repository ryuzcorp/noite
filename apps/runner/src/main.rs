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
use std::sync::{
    Arc,
    atomic::AtomicBool,
};

use axum::{
    middleware,
    routing::{delete, get, post},
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
    /// Set after the first successful reconcile pass (fleets spawned,
    /// Caddyfile written). Gates /ready so the edge never routes to a
    /// runner whose tenants are still cold-booting.
    pub ready: Arc<AtomicBool>,
    /// Isolation self-check result (SPEC, Tenancy mode).
    pub isolation: Arc<tokio::sync::RwLock<host::isolation::IsolationStatus>>,
    /// Bucket state sync (SPEC, Runner state). Marked dirty by mutating
    /// API calls (see snapshot hook in api modules).
    pub state_sync: host::state::StateSync,
    /// Bucket reachability probe (cached 5 s) for /ready.
    pub bucket_ok: Arc<tokio::sync::RwLock<(bool, String, std::time::Instant)>>,
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

    // Before anything writes to /data: private by default (SPEC, Data directory).
    host::isolation::harden_data_dir(&config);

    host::cmd::ensure_buckets(&config).await?;

    // Boot: restore SQLite snapshot when the volume is empty (SPEC, Runner state). A
    // failure other than "no snapshot" stops the boot: starting empty would
    // upload the empty database over the good snapshot.
    host::state::restore_if_missing(&config).await?;
    let state_sync = host::state::StateSync::new();
    if let Err(e) = state_sync.claim(&config).await {
        tracing::warn!(error = %e, "could not claim runner state in the bucket; snapshots keep trying");
    }

    let pool = db::connect(&config.database_url).await?;
    let swept = db::fail_stuck_deploys(&pool, DEPLOY_STUCK_MS, &HashSet::new())
        .await
        .unwrap_or(0);
    if swept > 0 {
        tracing::info!(swept, "swept stalled deploys on boot");
    }

    // Isolation: nft egress policy first, then self-checks (SPEC, Egress policy + Tenancy mode).
    // Only in multi tenancy: the single tenant is trusted, and the policy
    // would also cut single-tenant release commands off from the bucket.
    let nft_installed = match (config.tenancy, config.build_uid, config.fleet_uid) {
        (config::Tenancy::Multi, Some(b), Some(f)) => {
            let storage = host::netisolation::storage_target(&config.s3_endpoint).await;
            let ok = host::netisolation::ensure(b, f, &storage).await;
            if ok {
                host::netisolation::spawn_storage_refresh(b, f, config.s3_endpoint.clone());
            }
            ok
        }
        _ => {
            host::netisolation::skip("single tenancy: egress policy not installed");
            false
        }
    };
    let isolation = host::isolation::self_check(&config, nft_installed).await;
    if isolation.blocked {
        tracing::error!(detail = %isolation.detail, "multi-tenant isolation checks failed; /ready stays 503");
    }

    // Control fleet #0: deploy the bundle baked into the image, then run it.
    // The dev image has no bundle: `vite dev` serves the UI on the same port
    // (docker/dev.sh), so there is nothing to deploy or supervise.
    let control_child = if control_bundle_present(&config) {
        if let Err(e) = host::control::ensure_deployed(&config).await {
            tracing::warn!(error = %e, "control fleet deploy failed; continuing");
        }
        Some(supervise_control(&config))
    } else {
        tracing::info!("no control bundle (dev image): the UI is served by vite dev");
        None
    };
    // The edge: Caddy as a supervised child, with a placeholder config until
    // the first reconcile writes the real one.
    host::children::ensure_bootstrap_caddyfile(&config.caddyfile_path).await?;
    let caddy_child = supervise_caddy(&config);

    let procs = host::supervisor::new_procs();
    let logs = host::logs::new_state();
    // Rebuild bare mirrors from S3 tip bundles when the work dir is fresh.
    host::rehydrate::rehydrate_all(&pool, &config).await;
    let deploying = host::deploy::new_deploying();
    let mut metrics = host::metrics::new_state();
    // Resume telemetry aggregation where the last snapshot left off.
    match db::get_metric_watermarks(&pool).await {
        Ok(marks) => host::metrics::set_watermarks(&mut metrics, marks),
        Err(e) => tracing::warn!(error = %e, "watermark restore"),
    }
    let ready = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(AtomicBool::new(false));
    host::state::spawn_sync_task(state_sync.clone(), pool.clone(), (*config).clone());
    let state = AppState {
        pool: pool.clone(),
        config: config.clone(),
        procs: procs.clone(),
        logs: logs.clone(),
        deploying: deploying.clone(),
        git_sync: host::git_manifest::GitSync::default(),
        ready: ready.clone(),
        isolation: Arc::new(tokio::sync::RwLock::new(isolation)),
        state_sync: state_sync.clone(),
        bucket_ok: Arc::new(tokio::sync::RwLock::new((true, String::new(), std::time::Instant::now()))),
    };

    let cfg_loop = (*config).clone();
    let shutdown_loop = shutdown.clone();
    tokio::spawn(host::loop_::run_forever(
        pool.clone(),
        cfg_loop,
        procs.clone(),
        logs.clone(),
        deploying.clone(),
        metrics,
        ready.clone(),
        shutdown_loop,
    ));


    let app = Router::new()
        .route("/health", get(api::health))
        .route("/ready", get(api::ready))
        .route("/v1/admin/snapshot", post(api::snapshot))
        .route("/v1/edge/fallback", get(host::edge::edge_fallback))
        .route("/v1/edge/tls-ask", get(host::edge::tls_ask))
        .route("/webhook", post(api::webhook))
        .route("/v1/apps", get(api::list_apps).post(api::create_app))
        .route(
            "/v1/apps/{id}",
            get(api::get_app).patch(api::patch_app).delete(api::delete_app),
        )
        .route("/v1/apps/{id}/rename", post(api::rename_app))
        .route(
            "/v1/apps/{id}/domains",
            get(api::list_domains).post(api::add_domain),
        )
        .route(
            "/v1/apps/{id}/domains/{hostname}",
            delete(api::remove_domain),
        )
        .route("/v1/apps/{id}/deploys", get(api::list_deploys))
        .route("/v1/apps/{id}/rollback", post(api::rollback))
        .route(
            "/v1/apps/{id}/deploys/stream",
            get(api::list_deploys_stream),
        )
        .route("/v1/apps/{id}/git-remote", post(api::git_remote))
        .route("/v1/apps/{id}/tree", get(api::source_tree))
        .route("/v1/apps/{id}/blob/{*path}", get(api::source_blob))
        .route("/v1/apps/{id}/diff", get(api::source_diff))
        .route("/v1/apps/{id}/metrics", get(api::app_metrics))
        .route("/v1/apps/{id}/devices", get(api::app_devices))
        .route("/v1/apps/{id}/paths", get(api::app_paths))
        .route("/v1/apps/{id}/refs", get(api::app_refs))
        .route("/v1/apps/{id}/spans", get(api::app_spans))
        .route("/v1/apps/{id}/events", get(api::list_events).post(api::log_event))
        .route("/v1/apps/{id}/events/stream", get(api::list_events_stream))
        .route("/v1/apps/{id}/events/channels", get(api::list_channels))
        .route("/v1/apps/{id}/identify", post(api::identify_user))
        .route("/v1/apps/{id}/users/{user_id}/props", get(api::get_user_props))
        .route("/v1/apps/{id}/insights", get(api::list_insights).post(api::set_insight))
        .route("/v1/apps/{id}/logs", get(api::app_logs))
        .route("/v1/apps/{id}/logs/stream", get(api::app_logs_stream))
        .route("/v1/apps/{id}/storage", get(api::app_storage))
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}",
            get(api::app_d1),
        )
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/write",
            post(api::app_d1_write),
        )
        .route(
            "/v1/apps/{id}/source/commit",
            post(api::app_source_commit),
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
        .route("/v1/apps/{id}/env", get(api::list_env).post(api::set_env))
        .route("/v1/apps/{id}/env/{name}", delete(api::delete_env))
        .route("/rpc", post(api::handle_rpc))
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
        .layer(middleware::from_fn_with_state(
            state.clone(),
            |axum::extract::State(s): axum::extract::State<AppState>,
             req: axum::http::Request<axum::body::Body>,
             next: axum::middleware::Next| async move {
                let dirty = matches!(req.method(), &axum::http::Method::POST | &axum::http::Method::PATCH | &axum::http::Method::PUT | &axum::http::Method::DELETE)
                    && req.uri().path().starts_with("/v1/");
                let resp = next.run(req).await;
                if dirty && resp.status().is_success() {
                    s.state_sync.mark_dirty();
                }
                resp
            },
        ))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "noite-runner listening");
    // Graceful shutdown (SPEC, Shutdown): SIGTERM/SIGINT stops the listener, then all
    // fleets in parallel under one budget, then a final bucket snapshot.
    // Caddy stops last so in-flight requests drain.
    let shutdown_signal = shutdown.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
            let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).ok();
            loop {
                tokio::select! {
                    v = async { match sigterm.as_mut() { Some(s) => s.recv().await, None => std::future::pending().await } } => {
                        if v.is_some() {
                            break;
                        }
                    }
                    v = async { match sigint.as_mut() { Some(s) => s.recv().await, None => std::future::pending().await } } => {
                        if v.is_some() {
                            break;
                        }
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.ok();
        }
        shutdown_signal.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let budget = std::time::Duration::from_millis(config.stop_budget_ms);
    axum::serve(listener, app)
        .with_graceful_shutdown({
            let shutdown = shutdown.clone();
            async move {
                while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        })
        .await?;
    // Reconcile loop observes the flag and stops spawning. Tenant fleets and
    // the control fleet stop together under the one budget; Caddy goes last
    // so requests already in flight drain through it.
    let control_stop = async {
        if let Some(control) = &control_child {
            control.stop(budget).await;
        }
    };
    tokio::join!(host::supervisor::stop_all(&procs, budget), control_stop);
    caddy_child.stop(std::time::Duration::from_secs(5)).await;
    host::state::final_snapshot(&state_sync, &pool, &config).await;
    Ok(())
}

fn control_bundle_present(config: &Config) -> bool {
    let dir = std::path::Path::new(&config.control_bundle_dir);
    dir.join("wrangler.json").exists() || dir.join("wrangler.jsonc").exists()
}

/// Control fleet #0: celld with the public listener on loopback
/// (Caddy is in the same container) and the internal one on the private
/// address (see `host::control::control_advertise`). Supervised: restarted
/// on exit, stopped with the fleets on shutdown.
fn supervise_control(config: &Config) -> host::children::Supervised {
    let args = host::control::spawn_args(config);
    let shutdown_ms = config.fleet_shutdown_ms().to_string();
    let celld = config.celld_bin.clone();
    host::children::Supervised::start("control", move || {
        let state_dir = "/data/control";
        let _ = std::fs::create_dir_all(state_dir);
        let mut cmd = tokio::process::Command::new(&celld);
        cmd.args(&args)
            .env("CELLD_TRUST_FORWARDED_HEADERS", "1")
            .env("CELLD_WATCH", state_dir)
            .env("CELLD_READY_FLEET_GATE_MS", "15000")
            .env("CELLD_DURABILITY", "bucket")
            .env("CELLD_SHUTDOWN_TOTAL_MS", &shutdown_ms);
        cmd
    })
}

/// Caddy: admin on its default 127.0.0.1:2019, where the runner
/// POSTs each new config (`host::caddy::load_admin`); `--watch` on the same
/// file stays as the fallback path.
fn supervise_caddy(config: &Config) -> host::children::Supervised {
    let caddyfile = config.caddyfile_path.clone();
    host::children::Supervised::start("caddy", move || {
        let mut cmd = tokio::process::Command::new("caddy");
        cmd.args(["run", "--config", &caddyfile, "--adapter", "caddyfile", "--watch"])
            // Certificates and ACME state in the volume, not in the
            // container's $HOME: a recreate must not re-issue every cert
            // (CA rate limits) or lose the on-demand ones.
            .env("XDG_DATA_HOME", "/data/caddy/data")
            .env("XDG_CONFIG_HOME", "/data/caddy/config");
        cmd
    })
}

