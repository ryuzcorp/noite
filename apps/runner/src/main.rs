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
mod api_error;
mod host;
mod lifecycle;
mod models;
mod recover;
mod schema_version;
mod service;
mod telemetry;

use std::collections::HashSet;
use std::sync::{atomic::AtomicBool, Arc};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::host::logs::LogState;
use crate::host::supervisor::ProcMap;
use crate::lifecycle::DEPLOY_STUCK_MS;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub procs: ProcMap,
    pub logs: LogState,
    pub deploying: host::deploy::Deploying,
    /// Broadcast when the ingest tick appends OTel log rows: the log stream
    /// wakes on this instead of polling (spec T3.3).
    pub log_notify: tokio::sync::watch::Sender<u64>,
    pub git_sync: host::git_manifest::GitSync,
    /// Push-driven tip notifications (T2.2): the Git adapter and web commits
    /// send here, the reconcile loop drains every tick and deploys.
    pub tip_tx: host::tips::TipSender,
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
    /// Process start (whole hours of uptime go into the instance heartbeat).
    pub started_at: chrono::DateTime<chrono::Utc>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Operator subcommands run in the same container as the daemon and exit:
    // no boot, no logging setup, nothing started.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("recover") {
        let config = Config::from_env()?;
        return recover::run(&config, &argv[1..]).await;
    }
    if argv.first().map(String::as_str) == Some("telemetry") {
        let config = Config::from_env()?;
        return telemetry::run(&config, &argv[1..]).await;
    }

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

    // Wall clock for the boot-phase log lines below (fleet start vs control UI).
    let boot = std::time::Instant::now();
    // Process start, for the instance heartbeat's whole-hours uptime.
    let started_at = chrono::Utc::now();

    // Signal handling before anything is spawned or uploaded: Caddy, the
    // control fleet and every tenant fleet below are children of this process,
    // and a SIGTERM that lands while they are starting must run the whole stop
    // contract (SIGTERM to each child, the stop budget, the final bucket
    // snapshot) instead of the default hard exit, which would SIGKILL them with
    // the container and skip the snapshot. Compose's `stop_grace_period` is the
    // outer bound (SPEC, Shutdown).
    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_signal = shutdown.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            let mut sigterm =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
            let mut sigint =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).ok();
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

    host::s3::ensure_buckets(&config).await?;

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

    // Install identity for the instance heartbeat: created on first boot and
    // snapshotted with the database, so a container recreation keeps the same
    // install id. A failure here is not fatal — the status API retries it.
    match db::ensure_identity(&pool).await {
        Ok((install_id, _)) => tracing::debug!(install_id = %install_id, "instance identity"),
        Err(e) => tracing::warn!(error = %e, "could not read the instance identity"),
    }

    // Isolation: nft egress policy first, then self-checks (SPEC, Egress policy + Tenancy mode).
    // Only in multi tenancy: the single tenant is trusted, and the policy
    // would also cut single-tenant release commands off from the bucket.
    // The build range is `None` when uid drops are disabled; fleets are
    // still policed (builds are refused separately).
    let build_uids = config.build_uid_base.map(|b| (b, config.build_uid_range));
    let nft_installed = match (config.tenancy, config.fleet_uid) {
        (config::Tenancy::Multi, Some(f)) => {
            let storage = host::netisolation::storage_target(&config.s3_endpoint).await;
            let ok = host::netisolation::ensure(build_uids, f, &storage).await;
            if ok {
                host::netisolation::spawn_storage_refresh(
                    build_uids,
                    f,
                    config.s3_endpoint.clone(),
                );
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

    // The edge first: Caddy as a supervised child, on the Caddyfile the volume
    // already has (or a placeholder until the first reconcile writes the real
    // one). It starts before the control deploy and before the fleets, so the
    // route a visitor hits is live — or answering the starting page — for the
    // whole boot, and nothing below it can hold the tenants up.
    host::children::ensure_bootstrap_caddyfile(&config.caddyfile_path).await?;
    // Before the first Caddyfile: whether this Caddy can take rate limits.
    host::caddy::detect_modules().await;
    if !config.edge_sees_clients() {
        tracing::warn!(
            "CADDY_AUTO_HTTPS=off without NOITE_TRUSTED_PROXIES: the edge sees the proxy, not \
             visitors, so per-visitor rate limits are off (per-app ceilings still apply)"
        );
    }
    let caddy_child = host::children::supervise_caddy(&config);

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
    // Resume compaction where it left off (spec T3.5): hours due while the
    // runner was down compact on the next passes, bounded per pass.
    match db::get_compacted_hours(&pool).await {
        Ok(marks) => host::metrics::set_compacted(&mut metrics, marks),
        Err(e) => tracing::warn!(error = %e, "compaction restore"),
    }
    let ready = Arc::new(AtomicBool::new(false));
    // Pid of the running control node (0 when none). The reconcile loop's
    // metrics ingest samples its CPU and treats it as a live telemetry source,
    // exactly like a tenant fleet — the control fleet has no app row, so this
    // slot is how it reaches the loop.
    let control_pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
    // Push-driven tips (T2.2): the Git adapter notifies, the loop drains.
    let (tip_tx, tip_rx) = host::tips::channel();
    // Ingest "new logs" signal for the log stream (spec T3.3).
    let (log_tx, _log_rx) = tokio::sync::watch::channel(0u64);
    let log_tx_loop = log_tx.clone();
    host::state::spawn_sync_task(state_sync.clone(), pool.clone(), (*config).clone());
    let state = AppState {
        pool: pool.clone(),
        config: config.clone(),
        procs: procs.clone(),
        logs: logs.clone(),
        deploying: deploying.clone(),
        git_sync: host::git_manifest::GitSync::default(),
        tip_tx: tip_tx.clone(),
        log_notify: log_tx.clone(),
        ready: ready.clone(),
        isolation: Arc::new(tokio::sync::RwLock::new(isolation)),
        state_sync: state_sync.clone(),
        bucket_ok: Arc::new(tokio::sync::RwLock::new((
            true,
            String::new(),
            std::time::Instant::now(),
        ))),
        started_at,
    };

    let cfg_loop = (*config).clone();
    let shutdown_loop = shutdown.clone();
    tokio::spawn(host::loop_::run_forever(
        pool.clone(),
        cfg_loop,
        procs.clone(),
        control_pid.clone(),
        logs.clone(),
        deploying.clone(),
        metrics,
        ready.clone(),
        shutdown_loop,
        tip_rx,
        log_tx_loop,
    ));
    // Tenant fleets boot from here (the loop's first tick spawns them all, in
    // this same millisecond). The control UI is deployed after them on purpose:
    // on an upgrade the baked UI bundle carries a new revision, so
    // `ensure_deployed` uploads it — measured 0.66 s against a local store and
    // more against a remote one — and that upload must not delay a tenant.
    tracing::info!(
        ms = boot.elapsed().as_millis(),
        "tenant fleets booting; control UI deploys next"
    );

    // The socket is listening while the control deploy below runs (a proxied
    // request waits in the backlog instead of failing to connect); signal
    // handling is already installed above, before any child was spawned.
    let listener = tokio::net::TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "noite-runner listening");

    // Instance heartbeat, off the boot critical path: the task sleeps ten
    // minutes before its first attempt, then checks hourly, and is a no-op
    // once the instance opts out (SPEC, telemetry).
    tokio::spawn(host::telemetry_report::run_scheduler(
        pool.clone(),
        config.clone(),
        started_at,
    ));

    // Control fleet #0: deploy the bundle baked into the image, then run it.
    // The dev image has no bundle: `vite dev` serves the UI on the same port
    // (docker/dev.sh), so there is nothing to deploy or supervise.
    let control_child = if host::control::bundle_present(&config) {
        if let Err(e) = host::control::ensure_deployed(&config).await {
            tracing::warn!(error = %e, "control fleet deploy failed; continuing");
        }
        let child = host::control::supervise(&config, control_pid.clone(), logs.clone());
        tracing::info!(ms = boot.elapsed().as_millis(), "control bundle ready");
        Some(child)
    } else {
        tracing::info!("no control bundle (dev image): the UI is served by vite dev");
        None
    };

    let app = api::router::router(state);

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
