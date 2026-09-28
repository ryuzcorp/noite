use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db;
use crate::host::{credentials, logs};
use crate::host::logs::LogState;
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
    {
        let mut map = procs.lock().await;
        if let Some(child) = map.get_mut(&app.slug) {
            match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(status)) => {
                    tracing::warn!(slug = %app.slug, ?status, "celld exited; restarting");
                    map.remove(&app.slug);
                }
                Err(e) => {
                    tracing::warn!(slug = %app.slug, error = %e, "celld status; restarting");
                    map.remove(&app.slug);
                }
            }
        }
    }

    let state_dir = format!("{}/fleets/{}", cfg.work_dir, app.slug);
    tokio::fs::create_dir_all(&state_dir).await?;
    // celld runs as the fleet user: the whole state dir must be its own,
    // including SQLite / replication files an earlier runner (root, or the
    // an older build of this image) left there, or the fleet cannot open its
    // cells.
    #[cfg(unix)]
    if let Some(uid) = cfg.fleet_uid {
        if !crate::host::cmd::lchown_tree(
            std::path::Path::new(&state_dir),
            uid,
            cfg.fleet_gid.unwrap_or(uid),
        ) {
            tracing::warn!(slug = %app.slug, "could not hand the fleet state dir to the fleet user");
        }
    }
    let creds = credentials::fleet_credentials(pool, cfg, &app.slug).await?;
    let (access, secret_key) = (creds.access_key, creds.secret_key);
    // Advertise on loopback: a tenant fleet is a single node, a child of the
    // runner in its own network namespace, and the runner already reaches it
    // at 127.0.0.1:{internal} (reload_fleet). A hostname advertise
    // (fleet-{slug}) doesn't resolve inside the container, which breaks celld
    // node discovery (d1/diagnose read the lease and dial `addr`). The
    // internal listener binds loopback too: it carries celld's
    // unauthenticated operator API (SPEC, Egress policy).
    let listen_addr = format!("0.0.0.0:{listen}");
    let internal_addr = format!("127.0.0.1:{internal}");
    let advertise_addr = format!("127.0.0.1:{internal}");
    let mut cmd = Command::new(&cfg.celld_bin);
    cmd.args([
        "--bucket",
        &app.fleet_bucket,
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
    .env("CELLD_SHUTDOWN_TOTAL_MS", cfg.fleet_shutdown_ms().to_string())
    // Bounds: idle eviction returns memory when an app goes quiet; the
    // shedding threshold (set below only when configured) is container-wide.
    // celld's own logs are what an app owner reads when a deploy serves but
    // misbehaves; the inherited runner filter would suppress them.
    .env("RUST_LOG", &cfg.fleet_log)
    .env("CELLD_IDLE_EVICT_S", cfg.fleet_idle_evict_s.to_string())
    .env("CELLD_DEPLOY_POLL_S", "5")
    .env("CELLD_TRUST_FORWARDED_HEADERS", "1")
    // Fleet telemetry -> Parquet in the fleet bucket (celld OTel, bucket
    // sink), the documented query path for request counts. The flush is the
    // docs' near-live value and the runner compacts the previous hour
    // (`metrics::compact_fleet`) — a short flush without that job makes DuckDB
    // read thousands of tiny files. Retention matches the app_metric prune.
    .env("CELLD_OTEL", "1")
    .env("CELLD_OTEL_FLUSH_MS", crate::host::metrics::OTEL_FLUSH_MS.to_string())
    .env("CELLD_OTEL_RETENTION", "14d");
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
    for (k, v) in db::tenant_env(pool, &app.id).await {
        cmd.env(k, v);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    // Capture the fleet's stdout+stderr into the shared per-app log buffer
    // (was Stdio::inherit, which lost it to the runner's console).
    let slug = app.slug.clone();
    if let Some(out) = child.stdout.take() {
        let state = logs.clone();
        let slug = slug.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logs::append(&state, &slug, line).await;
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let state = logs.clone();
        let slug = slug.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logs::append(&state, &slug, line).await;
            }
        });
    }

    procs.lock().await.insert(app.slug.clone(), child);
    tracing::info!(slug = %app.slug, listen, internal, "started celld");
    Ok(())
}

pub async fn reload_fleet(app: &App) {
    let Some(port) = app.internal_port else {
        return;
    };
    let url = format!("http://127.0.0.1:{port}/reload");
    if let Err(e) = reqwest::Client::new().post(&url).send().await {
        tracing::warn!(slug = %app.slug, error = %e, "reload failed");
    }
}
