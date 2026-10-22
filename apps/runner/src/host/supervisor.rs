use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db;
use crate::host::logs::LogState;
use crate::host::{credentials, logs};
use crate::models::App;
use sqlx::SqlitePool;

/// Send SIGTERM to a pid (replaces the `/bin/sh -c kill` workaround; the
/// image has no `/bin/kill`). Returns false when the pid is already gone.
fn sigterm(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: kill with SIGTERM has no process-state side effects beyond
        // the signal itself.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// SIGKILL a fleet's whole process tree. When `pid` leads its own group (a
/// fleet this supervisor spawned with `process_group(0)`), the group dies —
/// including workers orphaned after the leader already exited, which still
/// hold the group (and the fleet's port) until they are signaled. A foreign
/// child shares its parent's group — `killpg` there would signal the runner
/// itself — so those get a single-pid kill instead. ESRCH on a fully gone
/// group is fine either way.
fn sigkill_tree(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: getpgid only reads; kill/killpg signal at most the group
        // the pid leads (or led — a reaped leader's orphans keep its group
        // alive, and only an immediate pid recycle could misdirect that,
        // the same exposure `run_sandboxed` already accepts).
        unsafe {
            let pgid = libc::getpgid(pid as i32);
            if pgid == pid as i32 || pgid < 0 {
                libc::killpg(pid as i32, libc::SIGKILL);
            } else {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

pub type ProcMap = Arc<Mutex<HashMap<String, Child>>>;

pub fn new_procs() -> ProcMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// What became of a fleet a caller was waiting on.
#[derive(Debug, PartialEq, Eq)]
pub enum FleetFate {
    /// Gone from the map: a stop or a teardown took it on purpose.
    Removed,
    /// celld exited on its own (still in the map until the next ensure).
    Exited(String),
}

/// Resolve once the fleet under `key` is no longer a live child. A waiter
/// that holds a claim (a deploy on the health gate) races this, so the claim
/// never outlives the fleet it waits on.
pub async fn fleet_gone(procs: &ProcMap, key: &str) -> FleetFate {
    loop {
        {
            let mut map = procs.lock().await;
            let Some(child) = map.get_mut(key) else {
                return FleetFate::Removed;
            };
            match child.try_wait() {
                Ok(None) => {}
                Ok(Some(status)) => return FleetFate::Exited(status.to_string()),
                Err(e) => return FleetFate::Exited(format!("{e}")),
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// How long a fleet stop waits for graceful exit (SIGTERM) and then for the
/// SIGKILL reaping before giving up and logging. Deletes SIGKILL first: the
/// fleet's data is wiped right after, so a graceful shutdown does only
/// durability work the purge destroys a moment later — waiting it out only
/// delays the delete past the API caller's own 5 s timeout, and a dropped
/// delete leaves the app half-deleted. Every other stop keeps the full grace
/// so a healthy fleet always shuts down cleanly.
#[derive(Debug, Clone, Copy)]
pub struct StopGrace {
    kill: Duration,
    term: Duration,
    /// Skip SIGTERM and the graceful wait: SIGKILL the group at once.
    kill_first: bool,
}

impl StopGrace {
    pub const FOR_DELETE: Self = Self {
        kill: Duration::from_secs(3),
        term: Duration::ZERO,
        kill_first: true,
    };
    pub const NORMAL: Self = Self {
        kill: Duration::from_secs(5),
        term: Duration::from_secs(15),
        kill_first: false,
    };
}

/// Stop one tenant fleet. The docs are explicit: celld shuts down gracefully
/// on SIGTERM/SIGINT (cancel work, prove durability, release leases, seal
/// the node log). SIGKILL only as a bounded fallback — delivered to the whole
/// process group, so an orphaned worker can never keep the fleet's port into
/// the next spawn.
pub async fn stop_fleet(procs: &ProcMap, slug: &str, grace: StopGrace) {
    let mut map = procs.lock().await;
    let Some(mut child) = map.remove(slug) else {
        return;
    };
    drop(map);
    // Read before the wait: `id()` goes `None` once the child is reaped, and
    // the fallback below needs the pid (the old code signaled `None` and
    // fell back to a `kill()` on an already-waited child — a no-op).
    let pid = child.id();
    if grace.kill_first {
        // Delete path: no SIGTERM, no graceful wait. The purge wipes the
        // fleet's data right after the stop, so durability work is pure
        // delay — and every second here runs against the API caller's own
        // timeout. SIGKILL the group at once instead.
        tracing::info!(slug, "stopping celld for delete (SIGKILL first)");
        match pid {
            Some(pid) => sigkill_tree(pid),
            None => {
                let _ = child.kill().await;
            }
        }
        let _ = tokio::time::timeout(grace.kill, child.wait()).await;
    } else if let Some(pid) = pid {
        sigterm(pid);
        if tokio::time::timeout(grace.term, child.wait())
            .await
            .is_err()
        {
            tracing::warn!(slug, "celld did not stop in time; killing");
            sigkill_tree(pid);
            let _ = tokio::time::timeout(grace.kill, child.wait()).await;
        }
    }
    // Whatever survived — a worker that ignored SIGTERM — must not outlive
    // the stop: reap the whole group, like `run_sandboxed`.
    if let Some(pid) = pid {
        sigkill_tree(pid);
    }
    // A stopped fleet leaves its cgroup behind only when a member outlived
    // the kill: an empty group removes, a live one is reused by the next
    // spawn (which rewrites the limits). Best-effort either way. The
    // removal returns the leaf's high-water RSS first: the leaf vanishes
    // with the fleet, so a later read could never recover it (D3 sizing
    // basis in SPEC, Limits).
    if let Some(dir) = crate::host::cgroups::fleet_cgroup_path(slug) {
        if let Some(peak_bytes) = crate::host::cgroups::remove_fleet_cgroup(&dir) {
            tracing::info!(fleet = slug, peak_bytes, "fleet memory peak at stop");
        }
    }
    crate::host::cgroups::forget_spawned(slug);
    tracing::info!(slug, "stopped celld");
}

/// Stop every running fleet whose app — or whose environment — no longer
/// exists. A delete stops its fleet before purging, but a reconcile tick (or a
/// wake) that read the row before the delete can start it again, and once the
/// row is gone nothing else manages that process: it keeps the fleet's port,
/// so the next fleet given that port crash-loops on "Address already in use".
/// Each candidate is re-read before it is stopped, so an app created or
/// renamed since the caller listed apps keeps its fleet. A sick database reads
/// as "still wanted": never kill live fleets on a failed lookup.
pub async fn stop_orphan_fleets(pool: &SqlitePool, procs: &ProcMap) {
    let running: Vec<String> = procs.lock().await.keys().cloned().collect();
    for key in running {
        if !fleet_still_wanted(pool, &key).await {
            tracing::warn!(fleet = %key, "stopping fleet with no app/environment row");
            stop_fleet(procs, &key, StopGrace::NORMAL).await;
        }
    }
}

/// Whether the `ProcMap` key still names something: a plain key is an app
/// slug, `slug.label` a preview environment (`Environment::fleet_key`).
async fn fleet_still_wanted(pool: &SqlitePool, key: &str) -> bool {
    match key.split_once('.') {
        Some((slug, label)) => match db::get_app_by_slug(pool, slug).await {
            Ok(Some(app)) => match db::get_environment_by_label(pool, &app.id, label).await {
                Ok(Some(_)) => true,
                Ok(None) => false,
                Err(_) => true,
            },
            Ok(None) => false,
            Err(_) => true,
        },
        None => !matches!(db::get_app_by_slug(pool, key).await, Ok(None)),
    }
}

/// The `ProcMap` key and log-ring key of an environment fleet: the app slug
/// cannot contain `.` (`lifecycle::slug_ok`), so `slug.label` never collides
/// with a production fleet's key.
pub fn env_fleet_key(slug: &str, label: &str) -> String {
    format!("{slug}.{label}")
}

/// Local state dir of an environment fleet: `envs/<slug>/<label>`, the local
/// mirror of its bucket prefix, so purge and rename walk one shape.
pub fn env_state_dir(cfg: &Config, slug: &str, label: &str) -> std::path::PathBuf {
    std::path::Path::new(&cfg.work_dir)
        .join("envs")
        .join(slug)
        .join(label)
}

/// Stop one environment fleet.
pub async fn stop_environment_fleet(procs: &ProcMap, slug: &str, label: &str) {
    stop_fleet(procs, &env_fleet_key(slug, label), StopGrace::NORMAL).await;
}

/// Stop every environment fleet of one app (`slug.*`): what a delete, a purge
/// and a rename need before touching the envs/<slug>/ prefix.
pub async fn stop_environment_fleets(procs: &ProcMap, slug: &str, grace: StopGrace) {
    let keys: Vec<String> = procs
        .lock()
        .await
        .keys()
        .filter(|key| key.split_once('.').is_some_and(|(owner, _)| owner == slug))
        .cloned()
        .collect();
    for key in keys {
        stop_fleet(procs, &key, grace).await;
    }
}

/// One celld fleet to (re)spawn: identity, bucket, ports, state dir, env.
struct FleetSpec {
    /// `ProcMap` key and log-ring key (`slug`, or `slug.label`).
    key: String,
    /// The app that owns this fleet: the OOM-kill app event's owner.
    app_id: String,
    /// The tenant scope whose key the fleet holds: the app's own prefix, or
    /// the environment's own when this fleet is a preview.
    scope: crate::host::credentials::Scope,
    bucket: String,
    listen: i64,
    internal: i64,
    state_dir: std::path::PathBuf,
    env: Vec<(String, String)>,
    /// Effective per-fleet memory cap in MiB (per-app override, else
    /// `RUNNER_FLEET_MEMORY_MB`): the cgroup's `memory.max`. `CELLD_MAX_RSS_MB`
    /// deliberately does not follow it (celld measures container-scale).
    memory_mb: u32,
}

/// Effective fleet memory cap: the app's `app_limit.memory_mb` override, or
/// the platform default. A corrupt row value cannot happen — `limits.set`
/// refuses it — so a defensive fallback keeps the type. In `multi` the
/// override is clamped to the operator ceiling, so rows stored before a
/// ceiling change cannot exceed it.
async fn fleet_memory_mb(pool: &SqlitePool, cfg: &Config, app_id: &str) -> u32 {
    let stored = match db::get_app_limit(pool, app_id).await {
        Ok(limit) => limit.memory_mb.and_then(|v| u32::try_from(v).ok()),
        Err(e) => {
            tracing::warn!(app_id, error = %e, "could not read app limits; using platform fleet memory");
            None
        }
    };
    clamp_memory_mb(
        stored,
        cfg.fleet_memory_mb,
        cfg.fleet_memory_max_mb,
        matches!(cfg.tenancy, crate::config::Tenancy::Multi),
    )
}

/// Clamp a stored per-app override to the operator ceiling. Pure so tests
/// pin it: `None` falls back to the platform default, multi caps stored
/// values (including rows written before the ceiling was lowered), single
/// applies the override verbatim.
fn clamp_memory_mb(stored_mb: Option<u32>, default_mb: u32, ceiling_mb: u32, multi: bool) -> u32 {
    let uncapped = stored_mb.unwrap_or(default_mb);
    if multi {
        uncapped.min(ceiling_mb)
    } else {
        uncapped
    }
}

/// App fleet: celld on the app's bucket and ports (SPEC, Fleet lifecycle).
pub async fn ensure_fleet(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
) -> anyhow::Result<()> {
    let (Some(listen), Some(internal)) = (app.listen_port, app.internal_port) else {
        return Ok(());
    };
    let spec = FleetSpec {
        key: app.slug.clone(),
        app_id: app.id.clone(),
        bucket: app.fleet_bucket.clone(),
        listen,
        internal,
        state_dir: std::path::Path::new(&cfg.work_dir)
            .join("fleets")
            .join(&app.slug),
        env: db::tenant_env(pool, &app.id).await,
        scope: crate::host::credentials::Scope::app(app),
        memory_mb: fleet_memory_mb(pool, cfg, &app.id).await,
    };
    ensure_spawned(pool, cfg, procs, logs, spec).await
}

/// Environment fleet: its own celld on the environment's bucket and ports,
/// with the app's variables plus the environment's overrides. Nothing here
/// reads or writes the app's bucket, ports or `last_deploy_sha`.
pub async fn ensure_environment_fleet(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    env: &crate::models::Environment,
) -> anyhow::Result<()> {
    let (Some(listen), Some(internal)) = (env.listen_port, env.internal_port) else {
        return Ok(());
    };
    let state_dir = env_state_dir(cfg, &env.app_slug, &env.label);
    // `envs/` and `envs/<slug>/` are created under the runner's umask 077,
    // and the fleet uid has to traverse them to reach its own state dir
    // (`harden_data_dir` keeps them 0755 across boots, as for `fleets/`).
    #[cfg(unix)]
    if let Some(slug_dir) = state_dir.parent() {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::create_dir_all(slug_dir).await?;
        for dir in [Some(slug_dir), slug_dir.parent()].into_iter().flatten() {
            tokio::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755)).await?;
        }
    }
    let spec = FleetSpec {
        key: env_fleet_key(&env.app_slug, &env.label),
        app_id: env.app_id.clone(),
        bucket: env.fleet_bucket.clone(),
        listen,
        internal,
        state_dir,
        env: db::environment_tenant_env(pool, &env.app_id, &env.id).await,
        scope: crate::host::credentials::Scope::environment(env),
        memory_mb: fleet_memory_mb(pool, cfg, &env.app_id).await,
    };
    ensure_spawned(pool, cfg, procs, logs, spec).await
}

/// An exited fleet whose cgroup counter moved since its own spawn died by
/// OOM kill at its cap: collect what the restart needs — the tenant-visible
/// event detail, the respawn backoff, and whether the event is due
/// (deduplicated per window). Sync so the caller can run it under the
/// proc-map lock; the log and DB writes happen after the guard drops.
/// Anything else (no cgroups, no movement, no baseline) yields nothing —
/// the caller still logs and restarts.
fn collect_possible_oom(spec: &FleetSpec) -> Option<crate::host::cgroups::OomNote> {
    let dir = crate::host::cgroups::fleet_cgroup_path(&spec.key)?;
    if !dir.is_dir() {
        return None;
    }
    match crate::host::cgroups::oom_kills_since_spawn(&spec.key, &dir) {
        Some(kills) if kills > 0 => {}
        _ => return None,
    }
    crate::host::cgroups::oom_note_kill(&spec.key, spec.memory_mb, std::time::Instant::now())
}

/// What moving a spawned fleet into its group observed. `Gone` (exited
/// first, or the kernel says ESRCH) means nothing runs uncapped: log and
/// hold the spawn for the next tick. `Refused` (live pid, real denial)
/// trips containment, kills the child so it never runs uncapped, and aborts
/// the spawn. `Moved` records the OOM baseline.
#[derive(Debug, PartialEq, Eq)]
enum MoveOutcome {
    Moved,
    Gone,
    Refused,
}

/// Move a spawned fleet into its group and report what happened. Async
/// because a refused move kills the live child first.
async fn move_fleet_into_group(
    key: &str,
    dir: &std::path::Path,
    child: &mut tokio::process::Child,
) -> MoveOutcome {
    let pid = match child.id() {
        None => {
            // Already waited (id() is None only after wait), so nothing to
            // reap here — unlike the ESRCH arm below.
            tracing::warn!(fleet = %key, "fleet exited before its cgroup move");
            return MoveOutcome::Gone;
        }
        Some(pid) => pid,
    };
    match crate::host::cgroups::enter_cgroup(dir, pid) {
        Ok(()) => {
            crate::host::cgroups::note_spawned(key, dir);
            MoveOutcome::Moved
        }
        Err(error) if crate::host::cgroups::is_gone(&error) => {
            // A leader that forked a worker and then exited lands here: the
            // worker keeps the group (and the fleet's port) alive uncapped
            // unless it is signaled too. ESRCH on a fully gone group is
            // fine, per sigkill_tree's contract.
            sigkill_tree(pid);
            // Exited between spawn and the move: reap the zombie (a dropped
            // Child only kill()-on-drops its leader) so no pid-table slot
            // leaks on a persistently refusing move.
            let _ = child.try_wait();
            tracing::warn!(fleet = %key, pid, "fleet exited before its cgroup move; nothing runs uncapped");
            MoveOutcome::Gone
        }
        Err(error) => {
            tracing::warn!(fleet = %key, pid, error = %error, "fleet refused its cgroup move; killing its tree");
            // Whole-tree kill: the fleet leads its own group, so a worker it
            // forked before the move dies with it instead of serving uncapped
            // from the shared cgroup and holding the fleet's ports past the
            // recovery respawn. Then reap (short timeout): without the wait
            // the dropped Child leaks a zombie until runner exit.
            sigkill_tree(pid);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
            crate::host::cgroups::note_limit_failed(
                key,
                format!("fleet missed its cgroup: {error:#}"),
            );
            MoveOutcome::Refused
        }
    }
}

/// Spawn (or confirm) one celld fleet, whoever owns it.
async fn ensure_spawned(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    spec: FleetSpec,
) -> anyhow::Result<()> {
    let key = spec.key.clone();
    // A fleet backing off after consecutive OOM kills is not respawned
    // until its hold passes; the next tick retries.
    if !crate::host::cgroups::oom_spawn_ready(&key, std::time::Instant::now()) {
        return Ok(());
    }
    // Consume the OOM baseline and collect the verdict under the lock; the
    // log and DB writes happen after the guard drops, never while holding
    // it. Removal stays in the same critical section as the consume, so a
    // same-key respawn cannot slip between them and inherit or orphan a
    // baseline.
    let oom_note: Option<crate::host::cgroups::OomNote> = {
        let mut map = procs.lock().await;
        if let Some(child) = map.get_mut(&key) {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(status)) => {
                    let note = collect_possible_oom(&spec);
                    tracing::warn!(fleet = %key, ?status, "celld exited; restarting");
                    map.remove(&key);
                    note
                }
                Err(e) => {
                    let note = collect_possible_oom(&spec);
                    tracing::warn!(fleet = %key, error = %e, "celld status; restarting");
                    map.remove(&key);
                    note
                }
            }
        } else {
            None
        }
    };
    if let Some(note) = oom_note {
        tracing::warn!(fleet = %key, detail = %note.detail, delay = ?note.delay, "fleet OOM-killed at its cap; restarting");
        logs::append(logs, &key, note.detail.clone()).await;
        if note.event_due {
            let _ = db::insert_app_event(
                pool,
                &crate::models::new_id(),
                &spec.app_id,
                "fleet",
                "fleet restarted",
                &note.detail,
                "🧠",
                "{}",
                "",
                &crate::models::now_iso(),
            )
            .await;
        }
    }

    let state_dir = spec.state_dir.to_string_lossy().into_owned();
    tokio::fs::create_dir_all(&state_dir).await?;
    // celld runs as the fleet user: the whole state dir must be its own,
    // including SQLite / replication files an earlier runner (root, or an
    // older build of this image) left there, or the fleet cannot open its
    // cells.
    #[cfg(unix)]
    if let Some(uid) = cfg.fleet_uid {
        if !crate::host::exec::lchown_tree(
            std::path::Path::new(&state_dir),
            uid,
            cfg.fleet_gid.unwrap_or(uid),
        ) {
            tracing::warn!(fleet = %key, "could not hand the fleet state dir to the fleet user");
        }
    }
    // The fleet holds its scope's key — the app's own prefix, or the
    // environment's own for a preview — minted lazily on first spawn so
    // upgrades need no manual step (SPEC, Scoped credentials).
    let creds = credentials::fleet_credentials(pool, cfg, &spec.scope).await?;
    let (access, secret_key) = (creds.access_key, creds.secret_key);
    // Advertise on loopback: a tenant fleet is a single node, a child of the
    // runner in its own network namespace, and the runner already reaches it
    // at 127.0.0.1:{internal} (reload_fleet). A hostname advertise
    // (fleet-{slug}) doesn't resolve inside the container, which breaks celld
    // node discovery (d1/diagnose read the lease and dial `addr`). The
    // internal listener binds loopback too: it carries celld's
    // unauthenticated operator API (SPEC, Egress policy).
    let listen_addr = format!("0.0.0.0:{}", spec.listen);
    let internal_addr = format!("127.0.0.1:{}", spec.internal);
    let advertise_addr = internal_addr.clone();
    let mut cmd = Command::new(&cfg.celld_bin);
    cmd.args([
        "--bucket",
        &spec.bucket,
        "--endpoint",
        &cfg.s3_endpoint,
        "--region",
        &cfg.aws_region,
        "--listen",
        listen_addr.as_str(),
        "--internal-listen",
        internal_addr.as_str(),
        "--advertise",
        advertise_addr.as_str(),
    ])
    .env("AWS_ACCESS_KEY_ID", access)
    .env("AWS_SECRET_ACCESS_KEY", secret_key)
    .env("AWS_REGION", &cfg.aws_region)
    .env("AWS_EC2_METADATA_DISABLED", "true")
    .env("S3_ENDPOINT", &cfg.s3_endpoint)
    .env("CELLD_WATCH", &state_dir)
    .env("CELLD_DURABILITY", "bucket")
    // Inside the runner's stop budget, so celld seals its node log before
    // the runner's own SIGKILL fallback (SPEC, Shutdown).
    .env(
        "CELLD_SHUTDOWN_TOTAL_MS",
        cfg.fleet_shutdown_ms().to_string(),
    )
    // Bounds: idle eviction returns memory when an app goes quiet; the
    // shedding threshold (set below only when configured) is container-wide.
    // celld's own logs are what an app owner reads when a deploy serves but
    // misbehaves; the inherited runner filter would suppress them.
    .env("RUST_LOG", &cfg.fleet_log)
    .env("CELLD_IDLE_EVICT_S", cfg.fleet_idle_evict_s.to_string())
    // T1.5: the runner POSTs /reload after every deploy path (push,
    // rollback, web commit, rename), so the fleet's own poll only covers a
    // missed reload — every 300 s instead of every 5 s.
    .env("CELLD_DEPLOY_POLL_S", cfg.fleet_deploy_poll_s.to_string())
    // T1.8: bound the per-fleet on-disk asset cache (celld's 512 MiB
    // default, per idle app, is unbounded across fleets).
    .env(
        "CELLD_ASSET_CACHE_BYTES",
        (cfg.fleet_asset_cache_mb * 1024 * 1024).to_string(),
    )
    // In the fleet's own state dir: celld's default, /tmp/celld/asset-cache,
    // is one directory for every node in the container, created 0700 by
    // whichever starts first (the control node, as root), so a fleet serving
    // assets as the fleet uid crash-looped on EACCES, and tenants would share
    // one cache even when it opened.
    .env("CELLD_ASSET_CACHE_DIR", format!("{state_dir}/asset-cache"))
    .env("CELLD_TRUST_FORWARDED_HEADERS", "1");
    // Fleet telemetry -> Parquet in the fleet bucket (celld OTel, bucket
    // sink), the documented query path for request counts. The flush / the
    // runner's compaction of the previous hour (`metrics::compact_fleet`) and
    // the retention knob (RUNNER_TELEMETRY_RETENTION_DAYS, shared with the
    // metric prune) come from the same helper the control fleet uses, so the
    // two sources cannot drift. An environment's files land under
    // `envs/<slug>/<label>/telemetry/...` (its own `--bucket`), which the
    // ingest reads alongside production, keyed by environment.
    for (key, value) in crate::host::metrics::otel_env(cfg) {
        cmd.env(key, value);
    }
    // Per-fleet containment (SPEC, Tenant isolation): while cgroups are
    // active the fleet gets its own group with the effective memory cap; the
    // kernel OOM-kills overgrowth inside that group (contained, and the
    // supervisor restarts the fleet) instead of every fleet shedding.
    //
    // `CELLD_MAX_RSS_MB` deliberately does NOT follow the per-fleet cap:
    // celld measures the greater of its own RSS and the *container-scale*
    // cgroup working set (through the private-ns cgroupfs root, not the
    // fleet leaf), so a per-fleet value closes every fleet's ready gate as
    // soon as the container as a whole passes it — the exact incident that
    // retired the old 512 default, replayed in the isolation lane
    // (2026-10-21: `CELLD_MAX_RSS_MB=512` per fleet, trivial fleets never
    // healthy while builds ran). The explicit knob keeps its container-wide
    // shed meaning; unset stays celld's default (80% of the container).
    let fleet_cgroup = crate::host::cgroups::anchor().and_then(|anchor| {
        match crate::host::cgroups::ensure_fleet_cgroup(&anchor, &key, u64::from(spec.memory_mb)) {
            Ok(dir) => Some(dir),
            Err(e) => {
                tracing::warn!(fleet = %key, error = %e, "fleet cgroup unavailable; shared cgroup");
                None
            }
        }
    });
    if cfg.fleet_max_rss_mb > 0 {
        cmd.env("CELLD_MAX_RSS_MB", cfg.fleet_max_rss_mb.to_string());
    }
    {
        use std::os::unix::process::CommandExt;
        if let Some(uid) = cfg.fleet_uid {
            cmd.as_std_mut().uid(uid);
        }
        if let Some(gid) = cfg.fleet_gid {
            cmd.as_std_mut().gid(gid);
        }
        // Its own process group (like `run_sandboxed`): the stops below kill
        // the whole tree, so an orphaned worker can never keep the fleet's
        // port into the next spawn. Uid drop above is untouched.
        cmd.as_std_mut().process_group(0);
    }
    for (k, v) in spec.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    // Move the fleet into its group at once: between spawn and this write a
    // sliver of startup memory is charged to the shared cgroup instead —
    // negligible next to the fleet's lifetime, and documented, not hidden.
    if let Some(dir) = &fleet_cgroup {
        match move_fleet_into_group(&key, dir, &mut child).await {
            MoveOutcome::Moved => {}
            // Exited first: nothing runs uncapped. Hold the spawn for the
            // next tick instead of inserting a dead child.
            MoveOutcome::Gone => return Ok(()),
            // Refused for a live pid: tripped, killed, and the spawn aborts
            // rather than running uncapped.
            MoveOutcome::Refused => {
                return Err(anyhow::anyhow!("fleet {key} missed its cgroup"));
            }
        }
    }

    // Capture the fleet's stdout+stderr into the shared per-fleet log buffer
    // (was Stdio::inherit, which lost it to the runner's console).
    if let Some(out) = child.stdout.take() {
        let state = logs.clone();
        let ring = key.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logs::append(&state, &ring, line).await;
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let state = logs.clone();
        let ring = key.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logs::append(&state, &ring, line).await;
            }
        });
    }

    procs.lock().await.insert(key.clone(), child);
    tracing::info!(fleet = %key, listen = spec.listen, internal = spec.internal, memory_mb = spec.memory_mb, cgroup = fleet_cgroup.is_some(), "started celld");
    Ok(())
}

/// Signal every fleet at once, then join waits under one budget
/// (SPEC, Shutdown). Survivors past the budget get SIGKILL. Caddy
/// is stopped last by the caller so in-flight requests drain.
pub async fn stop_all(procs: &ProcMap, budget: Duration) {
    let mut children: Vec<(String, Child, Option<u32>)> = Vec::new();
    {
        let mut map = procs.lock().await;
        for (slug, child) in map.drain() {
            let pid = child.id();
            children.push((slug, child, pid));
        }
    }
    for (_, _, pid) in &children {
        if let Some(pid) = pid {
            sigterm(*pid);
        }
    }
    if children.is_empty() {
        return;
    }
    let deadline = tokio::time::sleep(budget);
    tokio::pin!(deadline);
    let mut remaining: Vec<(String, Child, Option<u32>)> = children;
    let waits = remaining.iter_mut().map(|(s, c, _)| async move {
        let st = c.wait().await.ok();
        (s.clone(), st)
    });
    tokio::select! {
        done = futures::future::join_all(waits) => {
            for (slug, _) in done {
                tracing::info!(slug, "stopped celld");
            }
        }
        _ = &mut deadline => {
            for (slug, child, pid) in &mut remaining {
                tracing::warn!(slug, "fleet past stop budget; killing");
                match pid {
                    Some(pid) => sigkill_tree(*pid),
                    None => {
                        let _ = child.kill().await;
                    }
                }
            }
            for (_, mut child, _) in remaining {
                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            }
        }
    }
}

pub async fn reload_fleet(app: &App) {
    let Some(port) = app.internal_port else {
        return;
    };
    reload_at(&app.slug, port).await;
}

/// POST /reload on an environment fleet, so a preview deploy goes live
/// without waiting for celld's own poll.
pub async fn reload_environment_fleet(env: &crate::models::Environment) {
    let Some(port) = env.internal_port else {
        return;
    };
    reload_at(&env_fleet_key(&env.app_slug, &env.label), port).await;
}

async fn reload_at(fleet: &str, port: i64) {
    let url = format!("http://127.0.0.1:{port}/reload");
    if let Err(e) = reqwest::Client::new().post(&url).send().await {
        tracing::warn!(fleet = %fleet, error = %e, "reload failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_sleeper() -> Child {
        Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep")
    }

    /// A fleet whose app row is gone (a delete raced by a reconcile respawn)
    /// is stopped; a fleet whose app still exists keeps running.
    #[tokio::test]
    async fn orphan_fleets_stop_and_live_ones_stay() {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let cfg = crate::config::config_for_tests();
        db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "alive",
                slug: "alive",
                user_id: "user_test",
                subdomain: "alive.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        let procs = new_procs();
        let orphan = spawn_sleeper();
        let orphan_pid = orphan.id().expect("orphan pid");
        {
            let mut map = procs.lock().await;
            map.insert("alive".into(), spawn_sleeper());
            map.insert("deleted".into(), orphan);
        }

        stop_orphan_fleets(&pool, &procs).await;

        let map = procs.lock().await;
        assert!(map.contains_key("alive"));
        assert!(!map.contains_key("deleted"));
        drop(map);
        // The orphan's process is really gone, not just forgotten.
        assert!(!std::path::Path::new(&format!("/proc/{orphan_pid}")).exists());
    }

    /// Environment fleets are keyed `slug.label` and swept by their own row:
    /// a deleted environment's fleet stops, a live one's stays, and a plain
    /// app key is never mistaken for one.
    #[tokio::test]
    async fn environment_fleets_are_swept_by_their_own_row() {
        use crate::models::EnvironmentKind;
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let cfg = crate::config::config_for_tests();
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "env",
                slug: "env",
                user_id: "user_test",
                subdomain: "env.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");
        for (label, git_ref, listen) in [
            ("live", "refs/heads/live", 30110),
            ("gone", "refs/heads/gone", 30120),
        ] {
            db::create_environment(
                &pool,
                &cfg,
                db::NewEnvironment {
                    app_id: &app.id,
                    slug: "env",
                    label,
                    kind: EnvironmentKind::Branch,
                    git_ref,
                    created_by: "user_test",
                    listen,
                    internal: listen + 1,
                },
            )
            .await
            .expect("seed environment");
        }
        let procs = new_procs();
        {
            let mut map = procs.lock().await;
            map.insert("env".into(), spawn_sleeper());
            map.insert(env_fleet_key("env", "live"), spawn_sleeper());
            map.insert(env_fleet_key("env", "gone"), spawn_sleeper());
            map.insert(env_fleet_key("env", "never"), spawn_sleeper());
        }
        // Delete the `gone` row while its process is still registered.
        let gone = db::get_environment_by_label(&pool, &app.id, "gone")
            .await
            .expect("lookup")
            .expect("row");
        db::delete_environment(&pool, &gone.id)
            .await
            .expect("delete");

        stop_orphan_fleets(&pool, &procs).await;

        let map = procs.lock().await;
        assert!(map.contains_key("env"), "the app fleet stays");
        assert!(map.contains_key(&env_fleet_key("env", "live")));
        assert!(!map.contains_key(&env_fleet_key("env", "gone")));
        assert!(!map.contains_key(&env_fleet_key("env", "never")));
    }

    #[test]
    fn environment_state_dir_mirrors_the_bucket_prefix() {
        let cfg = crate::config::config_for_tests();
        assert_eq!(
            env_state_dir(&cfg, "blog", "feature"),
            std::path::Path::new(&cfg.work_dir)
                .join("envs")
                .join("blog")
                .join("feature")
        );
        assert_eq!(env_fleet_key("blog", "feature"), "blog.feature");
    }

    /// Stopping a fleet reaps the whole tree: a worker the fleet left behind
    /// (same process group) dies with it instead of keeping the fleet's port
    /// for the next spawn to crash-loop on.
    #[tokio::test]
    async fn stop_fleet_kills_the_process_group() {
        use std::os::unix::process::CommandExt;
        // A sleep duration no other process can plausibly share, so the
        // /proc scan below cannot false-positive.
        let marker = "31337378";
        let mut cmd = Command::new("sh");
        let script = format!("sleep {marker} & wait");
        cmd.args(["-c", script.as_str()]);
        cmd.as_std_mut().process_group(0);
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn sleeper tree");
        let procs = new_procs();
        procs.lock().await.insert("probe".into(), child);

        stop_fleet(&procs, "probe", StopGrace::NORMAL).await;

        assert!(!procs.lock().await.contains_key("probe"));

        assert!(
            crate::testutil::wait_for_cmdline_gone(marker, Duration::from_secs(5)).await,
            "stopped fleet left a worker behind (sleep {marker} still live 5s after the group kill)"
        );
    }

    /// Deletes SIGKILL first: a fleet that ignores SIGTERM (young celld
    /// fleets did, every time in the slow-delete failures) must not hold a
    /// delete out for a grace period — the API caller gives up after 5 s and
    /// a dropped delete used to leave the app half-deleted.
    #[tokio::test]
    async fn delete_stop_kills_without_grace() {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "trap '' TERM; sleep 60"]);
        cmd.as_std_mut().process_group(0);
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn TERM-ignoring sleeper");
        let pid = child.id().expect("child pid");
        let procs = new_procs();
        procs.lock().await.insert("killfirst".into(), child);

        let started = std::time::Instant::now();
        stop_fleet(&procs, "killfirst", StopGrace::FOR_DELETE).await;
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(2),
            "delete stop waited out a grace period ({elapsed:?}); FOR_DELETE must SIGKILL first"
        );
        assert!(!procs.lock().await.contains_key("killfirst"));
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "SIGKILL-first stop left the fleet leader behind"
        );
    }

    /// A deploy waiting on the health gate must let go when its fleet does:
    /// a stop resolves as Removed (the deploy completes, a queued delete gets
    /// the claim), a crash as Exited with its status (the deploy fails fast),
    /// and a live fleet keeps the waiter waiting.
    #[tokio::test]
    async fn fleet_gone_tells_a_stop_from_a_crash() {
        let procs = new_procs();
        let live = Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleeper");
        procs.lock().await.insert("live".into(), live);
        let still =
            tokio::time::timeout(Duration::from_millis(600), fleet_gone(&procs, "live")).await;
        assert!(still.is_err(), "a live fleet keeps the waiter waiting");

        let stopper = {
            let procs = procs.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                stop_fleet(&procs, "live", StopGrace::NORMAL).await;
            })
        };
        assert_eq!(fleet_gone(&procs, "live").await, FleetFate::Removed);
        stopper.await.expect("stopper");

        let crashed = Command::new("sh")
            .args(["-c", "exit 3"])
            .spawn()
            .expect("spawn crasher");
        procs.lock().await.insert("crashed".into(), crashed);
        let FleetFate::Exited(why) = fleet_gone(&procs, "crashed").await else {
            panic!("a crashed fleet is Exited, not Removed");
        };
        assert!(why.contains('3'), "{why}");
    }

    fn fake_fleet_leaf(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-fleet-unit-{name}-{}",
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).expect("fake fleet leaf");
        dir
    }

    #[tokio::test]
    async fn exited_fleet_skips_move_without_tripping() {
        // A child that exits before the move is reaped here, so id() is
        // None exactly like a fleet that dies between spawn and enter.
        let mut dead = tokio::process::Command::new("sh")
            .args(["-c", "exit 3"])
            .spawn()
            .expect("spawn exiter");
        dead.wait().await.expect("reap exiter");
        let dir = fake_fleet_leaf("gone");
        let key = format!("gone-{}", crate::models::new_id());
        assert_eq!(
            move_fleet_into_group(&key, &dir, &mut dead).await,
            MoveOutcome::Gone
        );
        let (_, detail) = crate::host::cgroups::status();
        assert!(
            !detail.contains(&key),
            "an exited fleet trips nothing: {detail}"
        );
        assert_eq!(
            crate::host::cgroups::oom_kills_since_spawn(&key, &dir),
            None,
            "no baseline without a group"
        );
    }

    #[tokio::test]
    async fn refused_move_kills_the_live_fleet_and_trips() {
        // cgroup.procs as a directory: the move is refused (EISDIR, not
        // ESRCH) for a live pid, like a real denial.
        let dir = fake_fleet_leaf("refused");
        std::fs::create_dir_all(dir.join("cgroup.procs")).expect("fake procs dir");
        let key = format!("refused-{}", crate::models::new_id());
        let mut live = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeper");
        assert_eq!(
            move_fleet_into_group(&key, &dir, &mut live).await,
            MoveOutcome::Refused
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), live.wait())
            .await
            .expect("killed fleet dies")
            .expect("reap killed fleet");
        let (ok, detail) = crate::host::cgroups::status();
        assert!(!ok, "a refused move trips containment");
        assert!(
            detail.contains(&key),
            "the reason names the fleet: {detail}"
        );
    }

    /// A refused move kills the whole tree, not just the leader: a worker
    /// the fleet forked before the move must die with it instead of serving
    /// uncapped from the shared cgroup, and the child is reaped (no zombie).
    #[tokio::test]
    async fn refused_move_kills_the_tree_and_reaps() {
        use std::os::unix::process::CommandExt;
        // Unique per test-process run: a leaked sleeper from an earlier run
        // must never satisfy this run's /proc scan.
        let marker = format!("31337{}", std::process::id() % 100000);
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", &format!("sleep {marker} & wait")]);
        cmd.as_std_mut().process_group(0);
        cmd.kill_on_drop(true);
        let mut leader = cmd.spawn().expect("spawn group leader");
        // The leader must have forked its sleeper before the move, or a
        // leader-only kill passes vacuously with nothing to orphan.
        let spawned = std::time::Instant::now();
        while !crate::testutil::live_cmdline_has(&marker) {
            assert!(
                spawned.elapsed() < Duration::from_secs(5),
                "group leader never forked its sleeper"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // cgroup.procs as a directory: the move is refused (EISDIR, not
        // ESRCH) for a live pid, like a real denial.
        let dir = fake_fleet_leaf("refused-tree");
        std::fs::create_dir_all(dir.join("cgroup.procs")).expect("fake procs dir");
        let key = format!("refused-tree-{}", crate::models::new_id());
        assert_eq!(
            move_fleet_into_group(&key, &dir, &mut leader).await,
            MoveOutcome::Refused
        );
        assert!(
            leader.id().is_none(),
            "the refused child is reaped inside the move, not left a zombie"
        );
        assert!(
            crate::testutil::wait_for_cmdline_gone(&marker, Duration::from_secs(5)).await,
            "refused move left a grandchild behind (sleep {marker} still live 5s after the group kill)"
        );
        let (ok, detail) = crate::host::cgroups::status();
        assert!(!ok, "a refused move trips containment");
        assert!(
            detail.contains(&key),
            "the reason names the fleet: {detail}"
        );
    }

    #[tokio::test]
    async fn successful_move_records_baseline() {
        let dir = fake_fleet_leaf("moved");
        let key = format!("moved-{}", crate::models::new_id());
        let mut live = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeper");
        assert_eq!(
            move_fleet_into_group(&key, &dir, &mut live).await,
            MoveOutcome::Moved
        );
        assert_eq!(
            crate::host::cgroups::oom_kills_since_spawn(&key, &dir),
            Some(0),
            "the spawn baseline exists"
        );
        live.kill().await.expect("stop sleeper");
    }

    #[test]
    fn effective_cap_clamps_stored_overrides_to_the_ceiling_in_multi() {
        // A row stored before the ceiling was lowered still applies, capped.
        assert_eq!(clamp_memory_mb(Some(1024), 512, 256, true), 256);
        assert_eq!(clamp_memory_mb(Some(128), 512, 256, true), 128);
        // Single applies the override verbatim; missing rows fall back to the
        // default, which the ceiling caps in multi like any other value.
        assert_eq!(clamp_memory_mb(Some(1024), 512, 256, false), 1024);
        assert_eq!(clamp_memory_mb(None, 512, 256, true), 256);
        assert_eq!(clamp_memory_mb(None, 512, 256, false), 512);
    }
}
