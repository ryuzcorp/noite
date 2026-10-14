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

fn sigkill(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
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

/// Stop one tenant fleet. The docs are explicit: celld shuts down gracefully
/// on SIGTERM/SIGINT (cancel work, prove durability, release leases, seal
/// the node log). SIGKILL only as a bounded fallback.
pub async fn stop_fleet(procs: &ProcMap, slug: &str) {
    let mut map = procs.lock().await;
    let Some(mut child) = map.remove(slug) else {
        return;
    };
    drop(map);
    if let Some(pid) = child.id() {
        sigterm(pid);
    }
    if tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .is_err()
    {
        tracing::warn!(slug, "celld did not stop within 15s; killing");
        if let Some(pid) = child.id() {
            sigkill(pid);
        } else {
            let _ = child.kill().await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
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
            stop_fleet(procs, &key).await;
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
    stop_fleet(procs, &env_fleet_key(slug, label)).await;
}

/// Stop every environment fleet of one app (`slug.*`): what a delete, a purge
/// and a rename need before touching the envs/<slug>/ prefix.
pub async fn stop_environment_fleets(procs: &ProcMap, slug: &str) {
    let keys: Vec<String> = procs
        .lock()
        .await
        .keys()
        .filter(|key| key.split_once('.').is_some_and(|(owner, _)| owner == slug))
        .cloned()
        .collect();
    for key in keys {
        stop_fleet(procs, &key).await;
    }
}

/// One celld fleet to (re)spawn: identity, bucket, ports, state dir, env.
struct FleetSpec {
    /// `ProcMap` key and log-ring key (`slug`, or `slug.label`).
    key: String,
    /// Owning app slug: scoped credentials and logs are per app.
    slug: String,
    bucket: String,
    listen: i64,
    internal: i64,
    state_dir: std::path::PathBuf,
    env: Vec<(String, String)>,
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
        slug: app.slug.clone(),
        bucket: app.fleet_bucket.clone(),
        listen,
        internal,
        state_dir: std::path::Path::new(&cfg.work_dir)
            .join("fleets")
            .join(&app.slug),
        env: db::tenant_env(pool, &app.id).await,
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
        slug: env.app_slug.clone(),
        bucket: env.fleet_bucket.clone(),
        listen,
        internal,
        state_dir,
        env: db::environment_tenant_env(pool, &env.app_id, &env.id).await,
    };
    ensure_spawned(pool, cfg, procs, logs, spec).await
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
    {
        let mut map = procs.lock().await;
        if let Some(child) = map.get_mut(&key) {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(status)) => {
                    tracing::warn!(fleet = %key, ?status, "celld exited; restarting");
                    map.remove(&key);
                }
                Err(e) => {
                    tracing::warn!(fleet = %key, error = %e, "celld status; restarting");
                    map.remove(&key);
                }
            }
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
    // Scoped credentials are per app prefix: until a provider that also scopes
    // `envs/<slug>/` lands, an environment fleet shares its app's pair
    // (SPEC, Scoped credentials).
    let creds = credentials::fleet_credentials(pool, cfg, &spec.slug).await?;
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
    // Phase 1 ingest does not read (ROADMAP Phase 3).
    for (key, value) in crate::host::metrics::otel_env(cfg) {
        cmd.env(key, value);
    }
    if cfg.fleet_max_rss_mb > 0 {
        cmd.env("CELLD_MAX_RSS_MB", cfg.fleet_max_rss_mb.to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if let Some(uid) = cfg.fleet_uid {
            cmd.as_std_mut().uid(uid);
        }
        if let Some(gid) = cfg.fleet_gid {
            cmd.as_std_mut().gid(gid);
        }
    }
    for (k, v) in spec.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

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
    tracing::info!(fleet = %key, listen = spec.listen, internal = spec.internal, "started celld");
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
    let mut remaining: Vec<(String, Child)> =
        children.into_iter().map(|(s, c, _)| (s, c)).collect();
    let waits = remaining.iter_mut().map(|(s, c)| async move {
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
            for (slug, child) in &mut remaining {
                tracing::warn!(slug, "fleet past stop budget; killing");
                if let Some(pid) = child.id() {
                    sigkill(pid);
                } else {
                    let _ = child.kill().await;
                }
            }
            for (_, mut child) in remaining {
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
}
