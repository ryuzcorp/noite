//! Noite runner — the control UI talks bearer REST; this process owns fleets, Caddy, and S3.
//!
//! Lifecycle invariants (see also `lifecycle`):
//! 1. Deploy and purge share `AppLock` — never overlapping S3 writers for a slug.
//! 2. Purge artifacts, then delete the DB row (create is the inverse).
//! 3. `desired_state` is only running|stopped; removal is hard DELETE.
//! 4. Metrics watermark advances only after a successful telemetry agg.
mod api;
mod api_error;
mod auth;
mod config;
mod db;
mod dns;
mod host;
mod lifecycle;
mod models;
mod recover;
mod schema_version;
mod service;
mod telemetry;
#[cfg(test)]
mod testutil;
mod void_cmd;

use std::collections::HashSet;
use std::sync::{atomic::AtomicBool, Arc};

use sqlx::SqlitePool;

use crate::config::Config;
use crate::host::logs::LogState;
use crate::host::supervisor::ProcMap;
use crate::lifecycle::DEPLOY_STUCK_MS;

/// Why `/ready` answers 503. One closed type so the four independent signals
/// cannot be combined into an unrepresentable mix: the gate is `Ready` only
/// when every producer succeeded.
///
/// stateDiagram-v2
///   [*] --> Degraded: boot (reconcile has not passed yet)
///   Degraded --> Ready: every probe passes
///   Ready --> Degraded: a probe fails
///   Degraded --> Blocked: isolation refused
///   Blocked --> Degraded: isolation restored
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    Degraded {
        failures: Vec<ReadyFailure>,
    },
    /// Multi-tenant containment failed: `/ready` never recovers on its own.
    Blocked {
        failures: Vec<ReadyFailure>,
    },
}

/// One reason `/ready` is not green. The rendered text is the wire contract
/// (`failing` array), so each variant keeps today's wording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadyFailure {
    Reconcile,
    Bucket(String),
    Isolation(String),
    Cgroups(String),
    Control(String),
    Caddy(String),
}

impl ReadyFailure {
    pub fn message(&self) -> String {
        match self {
            Self::Reconcile => "reconcile".to_string(),
            Self::Bucket(detail) => format!("bucket: {detail}"),
            Self::Isolation(detail) => format!("isolation: {detail}"),
            Self::Cgroups(detail) => format!("cgroups: {detail}"),
            Self::Control(detail) => format!("control: {detail}"),
            Self::Caddy(detail) => format!("caddy: {detail}"),
        }
    }
}

impl Readiness {
    /// The one transition: resolve the current outputs into a state. An
    /// isolation block is terminal (`Blocked`) regardless of the other
    /// probes; the first reconcile pass is prefixed to the failures so the
    /// `failing` array keeps the pre-machine order and wording.
    pub fn resolve(reconciled: bool, mut failures: Vec<ReadyFailure>) -> Self {
        if !reconciled {
            failures.insert(0, ReadyFailure::Reconcile);
        }
        if failures
            .iter()
            .any(|f| matches!(f, ReadyFailure::Isolation(_)))
        {
            return Self::Blocked { failures };
        }
        match failures.len() {
            0 => Self::Ready,
            _ => Self::Degraded { failures },
        }
    }

    pub fn ok(&self) -> bool {
        matches!(self, Self::Ready)
    }

    /// The `failing` array, byte-identical to the pre-machine response.
    pub fn failing(&self) -> Vec<String> {
        match self {
            Self::Ready => Vec::new(),
            Self::Degraded { failures } | Self::Blocked { failures } => {
                failures.iter().map(ReadyFailure::message).collect()
            }
        }
    }
}

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
    pub wal: host::git_store::GitWal,
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
    /// TXT ownership proofs for custom domains (SPEC, Custom domains):
    /// the system resolver in production, a fake in tests.
    pub dns: Arc<dyn crate::dns::TxtResolver>,
    /// Process start (whole hours of uptime go into the instance heartbeat).
    pub started_at: chrono::DateTime<chrono::Utc>,
    /// Parsed per-deploy source maps for error symbolication, bounded
    /// (`host::sourcemaps::SourceMapCache`).
    pub source_maps: host::sourcemaps::SourceMapCache,
    /// Why the control fleet failed to come up (deploy or migrations), or
    /// `None`: /ready reports it beside "fleet not healthy", so a red lane
    /// names its cause instead of only failing.
    pub control_boot: Arc<std::sync::Mutex<Option<String>>>,
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
    if argv.first().map(String::as_str) == Some("void") {
        let config = Config::from_env()?;
        return void_cmd::run(&config, &argv[1..]).await;
    }
    // The sandbox relay runs from this same binary in its own container: no
    // config, no logging setup, nothing started — it must not need runner env.
    if argv.first().map(String::as_str) == Some("sandbox-relay") {
        return host::sandbox::relay::run_standalone(&argv[1..]).await;
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "noite_runner=info,tower_http=info".into()),
        )
        .init();

    let mut config = Arc::new(Config::from_env()?);
    tokio::fs::create_dir_all(&config.work_dir).await.ok();
    // Config strips `S3_ENDPOINT` userinfo; say so rather than drop it
    // silently (the store authenticates with the access keys).
    if config.s3_endpoint_as_configured != config.s3_endpoint {
        tracing::warn!(
            "S3_ENDPOINT credentials ignored: the store authenticates with \
             AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY; remove them from the URL"
        );
    }
    // Fleets get only the knobs the runner sets, so an operator-global
    // `CELLD_*` here reaches no fleet.
    let ignored = host::fleet_env::ignored_celld_vars(
        std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()),
    );
    if !ignored.is_empty() {
        tracing::warn!(
            vars = %ignored.join(","),
            "CELLD_* in the runner env reaches no fleet; use the RUNNER_FLEET_* knobs"
        );
    }

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
    // Where tenant keys come from (SPEC, Scoped credentials): `auto` probes
    // an unknown store now that the bucket answers, before any fleet spawns.
    // A store that cannot answer fails the boot rather than guess, because
    // the answer decides what every fleet holds.
    Arc::get_mut(&mut config)
        .expect("config uniquely owned at boot")
        .resolve_credentials()
        .await?;
    tracing::info!(
        credentials = %config.credentials.summary(),
        tenancy = %config.tenancy.as_str(),
        "tenant bucket credentials"
    );
    if !config.credentials.is_scoped() && config.tenancy == crate::config::Tenancy::Multi {
        tracing::warn!(
            "multi-tenant install runs fleets with the root bucket keys: \
             a compromised fleet process can reach every prefix (SPEC, Scoped credentials)"
        );
    }

    // Boot: restore SQLite snapshot when the volume is empty (SPEC, Runner state). A
    // failure other than "no snapshot" stops the boot: starting empty would
    // upload the empty database over the good snapshot.
    host::state::restore_if_missing(&config).await?;
    let state_sync = host::state::StateSync::new();
    if let Err(e) = state_sync.claim(&config).await {
        tracing::warn!(error = %e, "could not claim runner state in the bucket; snapshots keep trying");
    }

    let pool = db::connect(&config.database_url).await?;
    // A dev install that changed its base domain (localhost → noite.localhost)
    // keeps links coherent: the stored subdomain is derived from the slug.
    match db::rebind_local_subdomains(&pool, &config.base_domain).await {
        Ok(0) => {}
        Ok(rewritten) => tracing::info!(
            rewritten,
            base_domain = %config.base_domain,
            "rewrote app subdomains onto the configured base domain"
        ),
        Err(e) => tracing::warn!(error = %e, "could not rebind app subdomains"),
    }
    let swept = db::fail_stuck_deploys(&pool, DEPLOY_STUCK_MS, &HashSet::new())
        .await
        .unwrap_or_default();
    if !swept.is_empty() {
        tracing::info!(swept = swept.len(), "swept stalled deploys on boot");
        // A stalled row spends the automatic-deploy budget like a failure.
        crate::host::auto_deploy::note_stalled(&pool, &swept).await;
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
    // The table covers the build range only (Worker egress lives in celld);
    // with no range there is nothing to install (builds are refused
    // separately).
    let build_uids = config.build_uid_base.map(|b| (b, config.build_uid_range));
    let nft_installed = match (config.tenancy, build_uids) {
        (config::Tenancy::Multi, Some(_)) => {
            let storage = host::netisolation::storage_target(&config.s3_endpoint).await;
            let ok = host::netisolation::ensure(build_uids, &storage).await;
            if ok {
                host::netisolation::spawn_policy_refresh(build_uids, config.s3_endpoint.clone());
            }
            ok
        }
        (config::Tenancy::Multi, None) => {
            host::netisolation::skip("uid drops disabled: no build range to police");
            false
        }
        _ => {
            host::netisolation::skip("single tenancy: egress policy not installed");
            false
        }
    };
    // The sandbox plane (both tenancies: single has no egress policy but the
    // same relay/gateway path): celld bridges, relay container, gateway
    // listener, gateway nft table, and the one-time cleanup of what
    // alpha.12–14 left on the host. Best-effort and never blocking: the
    // whole pass runs in a spawned task (sequential engine calls would
    // otherwise stall cgroups, isolation checks, and Caddy behind a sick
    // engine, #120's fix), and a failure only keeps Sandbox classes
    // unreachable. One refresh task re-ensures networks/relay/table every
    // 30 s, jittered; only the storage allowance refreshes separately.
    // This install's id scopes the sandbox container labels, so the sweeps
    // below never touch another install's containers on a shared engine.
    host::sandbox::set_install(host::credentials::install_tag(
        &config.s3_endpoint,
        &config.s3_bucket,
        &config.aws_region,
    ));
    // Before any fleet starts (so it cannot remove a container a fresh fleet
    // just created): the previous run's fleet containers are orphans now —
    // their fleets died with the runner. Also with sandboxing switched off,
    // so turning it off leaves nothing running. Bounded, so a sick engine
    // delays boot by at most the bound. Reading this container's image here
    // too lets the engine proxy run celld's fence from it from the start.
    let boot_pass = async {
        let swept = host::sandbox::engine::sweep_boot().await;
        if !config.sandbox_disabled {
            host::sandbox::plane::own_container().await;
        }
        swept
    };
    match tokio::time::timeout(std::time::Duration::from_secs(20), boot_pass).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "sandbox boot sweep failed"),
        Err(_) => tracing::warn!("sandbox boot sweep timed out"),
    }
    if !config.sandbox_disabled {
        let fleet_ids = config
            .fleet_uid
            .map(|uid| (uid, config.fleet_gid.unwrap_or(uid)));
        tokio::spawn(async move {
            let first = host::sandbox::plane::ensure_networks().await;
            if first.engine {
                tracing::info!(subnets = ?first.subnets, "sandbox plane ensured");
                let relay_ok = host::sandbox::relay::ensure().await;
                host::sandbox::gateway::spawn(fleet_ids);
                let table_ok = host::sandbox::gateway::ensure_table(
                    &first.subnets,
                    fleet_ids.map(|(uid, _)| uid),
                )
                .await;
                host::sandbox::plane::cleanup_legacy().await;
                let relay_healthy = relay_ok && host::sandbox::relay::healthy().await;
                host::sandbox::plane::record(true, first.subnets, relay_healthy, table_ok);
            } else {
                tracing::debug!("no engine; sandbox plane not ensured");
                host::sandbox::plane::record(false, Vec::new(), false, false);
            }
            loop {
                let jitter = rand::random::<u64>() % 5;
                tokio::time::sleep(std::time::Duration::from_secs(30 + jitter)).await;
                let nets = host::sandbox::plane::ensure_networks().await;
                if !nets.engine {
                    host::sandbox::plane::record(false, Vec::new(), false, false);
                    continue;
                }
                let relay_ok = host::sandbox::relay::ensure().await;
                let table_ok = host::sandbox::gateway::ensure_table(
                    &nets.subnets,
                    fleet_ids.map(|(uid, _)| uid),
                )
                .await;
                let relay_healthy = relay_ok && host::sandbox::relay::healthy().await;
                host::sandbox::plane::record(true, nets.subnets, relay_healthy, table_ok);
            }
        });
    }
    // Per-fleet cgroups before any child is spawned: setup drains the
    // runner's own cgroup (tini stays reaped, cgroups do not affect that)
    // into a leaf, so children spawned after it inherit the leaf and tenant
    // fleets can each move to their own group (SPEC, Tenant isolation).
    host::cgroups::setup(&config.cgroup_root);
    // Builds move into their own capped leaf: a Vite/Rolldown build peaks
    // above a small box's spare memory, and the build — not a fleet — must be
    // the thing that dies when it outgrows its budget.
    host::cgroups::setup_build(
        config.build_memory_mb,
        config.build_swap_mb,
        config.build_concurrency,
    );
    let isolation = host::isolation::self_check(&config, nft_installed).await;
    if isolation.blocked() {
        tracing::error!(detail = %isolation.detail, "multi-tenant isolation checks failed; /ready stays 503");
    }

    // The edge first: Caddy as a supervised child, on the Caddyfile the volume
    // already has (or a placeholder until the first reconcile writes the real
    // one). It starts before the control deploy and before the fleets, so the
    // route a visitor hits is live — or answering the starting page — for the
    // whole boot, and nothing below it can hold the tenants up.
    host::children::ensure_bootstrap_caddyfile(&config.caddyfile_path).await?;
    // The edge config is static after boot: write it from platform config
    // (never from app rows), then start Caddy from it. App events push the
    // route table through the admin API and never reload. No `/load` here:
    // Caddy boots from the file just written.
    host::caddy::write_static_caddyfile(&config).await?;
    // A routes file written by an older runner can carry a kind this build's
    // closed set no longer knows (the retired `preview` pod route). Caddy
    // validates the file when it provisions, so it would refuse the whole
    // table and answer 503 for every host until the first push. Rebuild the
    // file from the rows first; a failure here leaves the old file for the
    // reconcile loop's first tick.
    if let Err(e) = host::edge_table::push_routes(&pool, &config).await {
        tracing::warn!(error = %format!("{e:#}"), "edge routes rebuild before Caddy boot");
    }
    let caddy_child = host::children::supervise_caddy(&config);

    let procs = host::supervisor::new_procs();
    let logs = host::logs::new_state();
    // Rebuild bare mirrors from S3 tip bundles when the work dir is fresh.
    host::rehydrate::rehydrate_all(&pool, &config).await;
    let deploying = host::deploy::new_deploying();
    // A killed telemetry DuckDB leaves its spill behind, and stale bytes
    // count against RUNNER_DUCKDB_TEMP_MB; boot is the one moment no query
    // can be running, so clear the whole directory.
    host::metrics::sweep_spill(&config, std::time::Duration::ZERO);
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
    let control_boot = Arc::new(std::sync::Mutex::new(None::<String>));
    let state = AppState {
        pool: pool.clone(),
        config: config.clone(),
        procs: procs.clone(),
        logs: logs.clone(),
        deploying: deploying.clone(),
        wal: host::git_store::build_wal(&config),
        tip_tx: tip_tx.clone(),
        log_notify: log_tx.clone(),
        ready: ready.clone(),
        isolation: Arc::new(tokio::sync::RwLock::new(isolation)),
        state_sync: state_sync.clone(),
        dns: crate::dns::system(),
        bucket_ok: Arc::new(tokio::sync::RwLock::new((
            true,
            String::new(),
            std::time::Instant::now(),
        ))),
        started_at,
        source_maps: host::sourcemaps::SourceMapCache::new(),
        control_boot: control_boot.clone(),
    };

    // Retired workspace previews (`source.preview`, removed): an upgraded
    // install still holds their rows, fleets and bucket prefixes, and the
    // environment model no longer decodes one. Tear them down before the
    // reconcile loop (or any request) lists environments; a failure aborts the
    // boot so the next start retries instead of running on a database whose
    // next environment read would fail.
    let retired = host::env_teardown::retire_workspace_environments(&state).await?;
    if retired > 0 {
        tracing::info!(retired, "removed retired workspace preview environments");
        // The route table is rebuilt from the rows; land the removal before
        // the first request instead of waiting for the loop's first tick.
        if let Err(e) = host::edge_table::push_routes(&state.pool, &state.config).await {
            tracing::warn!(error = %format!("{e:#}"), "edge push after retiring workspace previews");
        }
    }

    // A runner that died mid-wipe — or a shutdown between the ref move's
    // manifest flip and the queued teardown — leaves a branch environment
    // whose ref is gone; the reconcile loop would otherwise respawn its fleet
    // for a deleted branch. Non-fatal: a failed read or wipe logs and leaves
    // the row for the next boot.
    let swept = host::env_teardown::sweep_orphan_branch_environments(&state).await;
    if swept > 0 {
        tracing::info!(swept, "removed branch environments whose ref is gone");
        if let Err(e) = host::edge_table::push_routes(&state.pool, &state.config).await {
            tracing::warn!(error = %format!("{e:#}"), "edge push after the orphan environment sweep");
        }
    }

    // A delete that committed but never finished its wipe (a crash, a restart
    // or an upgrade mid-wipe, an S3 failure) leaves a durable tombstone in
    // `app_purge`; a wipe a re-create stopped leaves one too when that create
    // aborted. Resume them in the background — non-fatal, like the sweeps
    // above, and paced: each takes its slug's guard and yields to a create
    // that wants the slug back.
    {
        let state = state.clone();
        service::detached::spawn("purge:resume".to_string(), async move {
            let report = host::purge::resume_pending(
                &state.pool,
                &state.config,
                &state.procs,
                &state.logs,
                state.wal.sync(),
            )
            .await;
            if report.noteworthy() {
                tracing::info!(
                    pending = report.pending,
                    cleared = report.cleared,
                    failed = report.failed,
                    "resumed pending app purges"
                );
            }
        });
    }
    // CI cache volumes no live app owns: a legacy slug-keyed name, a deleted
    // app whose wipe died, a rename. Detached and non-fatal, like the sweeps
    // below; the slow loop tick runs it again.
    {
        let state = state.clone();
        service::detached::spawn("ci-cache:sweep".to_string(), async move {
            let removed = host::purge::reconcile_ci_caches(&state.config, &state.pool).await;
            if removed > 0 {
                tracing::info!(removed, "removed orphaned CI cache volumes");
            }
        });
    }
    // Credential rows whose app row is gone (a delete that died before the
    // atomic mark, or a database from an older build) are marked/dropped
    // before anything can be minted on a re-created slug's prefix. Local-only
    // and non-fatal: the loop's first `sweep` does the store side.
    match host::credentials::reconcile_orphans(&state.pool).await {
        Ok(rows) if !rows.nothing() => tracing::info!(
            keys_marked = rows.keys_marked,
            tokens_dropped = rows.tokens_dropped,
            "reconciled orphaned credential rows"
        ),
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "orphan credential row reconcile failed")
        }
    }

    let cfg_loop = (*config).clone();
    let shutdown_loop = shutdown.clone();
    tokio::spawn(host::loop_::run_forever(
        pool.clone(),
        cfg_loop,
        procs.clone(),
        control_pid.clone(),
        logs.clone(),
        deploying.clone(),
        state.wal.sync().clone(),
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
    // Opt-out update check, off the boot critical path: the task sleeps five
    // minutes before its first attempt, then checks hourly, and is a no-op
    // once the admin opts out (SPEC, update check).
    tokio::spawn(host::update_check::run_scheduler(
        pool.clone(),
        config.clone(),
    ));

    // Control fleet #0: deploy the bundle baked into the image, then run it.
    // The dev image has no bundle: `vite dev` serves the UI on the same port
    // (docker/dev.sh), so there is nothing to deploy or supervise.
    let control_child = if host::control::bundle_present(&config) {
        // The control node's operator token: minted once and snapshotted
        // with the database, so an overlapping redeploy's new node agrees
        // with the old one on peer traffic. Retried like the control
        // deploy below; still missing, the control fleet does not run at
        // all — failing closed, never an open internal listener on :8091 —
        // and the stale published token (if any) is deleted so `make
        // doctor` fails loudly instead of probing with a dead token.
        let mut control_token = String::new();
        for attempt in 1..=3 {
            match host::credentials::operator_token(
                &pool,
                &config.runner_token,
                host::credentials::CONTROL_OPERATOR_SCOPE,
                "_control",
            )
            .await
            {
                Ok(token) => {
                    control_token = token;
                    break;
                }
                Err(e) => {
                    tracing::warn!(attempt, error = %format!("{e:#}"), "control operator token unavailable; retrying");
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                }
            }
        }
        if control_token.is_empty() {
            tracing::error!(
                "control operator token unavailable; not supervising the control fleet"
            );
            host::control::remove_operator_token_file(&config.work_dir);
            None
        } else {
            if let Err(e) = host::control::ensure_deployed(&config).await {
                let reason = format!("{e:#}");
                tracing::warn!(error = %reason, "control fleet deploy failed; continuing");
                *control_boot.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(format!("deploy failed: {reason}"));
            }
            let child =
                host::control::supervise(&config, control_pid.clone(), logs.clone(), control_token);
            // The migration endpoints are served by the control worker, so
            // this waits for the fleet to adopt the pointer first. Retried:
            // a refused move or a slow celld start is transient; a schema
            // that still will not apply leaves the UI erroring (loudly).
            for attempt in 1..=3 {
                match host::control::migrate(&config).await {
                    Ok(()) => {
                        tracing::info!("control migrations applied");
                        break;
                    }
                    Err(e) if attempt < 3 => {
                        tracing::warn!(attempt, error = %format!("{e:#}"), "control migrations failed; retrying");
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    }
                    Err(e) => {
                        let reason = format!("{e:#}");
                        tracing::error!(error = %reason, "control migrations not applied; the control UI will error until they apply");
                        *control_boot.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some(format!("migrations failed: {reason}"));
                    }
                }
            }
            tracing::info!(ms = boot.elapsed().as_millis(), "control bundle ready");
            Some(child)
        }
    } else {
        if std::path::Path::new(&config.control_bundle_dir).exists() {
            // The directory is there, the config is not: a build layout the
            // deploy cannot read. /ready would only say "fleet not healthy",
            // so record it.
            let reason = format!("no wrangler config under {}", config.control_bundle_dir);
            tracing::error!(%reason, "control bundle unreadable; not deploying it");
            *control_boot.lock().unwrap_or_else(|p| p.into_inner()) = Some(reason);
        } else {
            tracing::info!("no control bundle (dev image): the UI is served by vite dev");
        }
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
    // The sandbox relay belongs to this container: remove it under the same
    // budget (a leftover is replaced on the next boot, but a clean shutdown
    // leaves no orphan for the next install to sweep).
    let relay_stop = host::sandbox::relay::remove_ours();
    tokio::join!(
        host::supervisor::stop_all(&procs, budget),
        control_stop,
        relay_stop
    );
    caddy_child.stop(std::time::Duration::from_secs(5)).await;
    host::state::final_snapshot(&state_sync, &pool, &config).await;
    Ok(())
}
