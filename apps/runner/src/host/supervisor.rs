use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db;
use crate::host::logs::{self, LogState};
use crate::models::App;
use sqlx::SqlitePool;

pub type ProcMap = Arc<Mutex<HashMap<String, Child>>>;

pub fn new_procs() -> ProcMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn stop_fleet(procs: &ProcMap, slug: &str) {
    let mut map = procs.lock().await;
    if let Some(mut child) = map.remove(slug) {
        let _ = child.kill().await;
        // Wait so the node cannot rewrite leases / LTX into a prefix we are
        // about to wipe (partial S3 clears leave RestoreFailed cells).
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        tracing::info!(slug, "stopped celld");
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

    let secret = db::get_secret(pool, &app.id, "fleet").await?;
    let access = secret
        .as_ref()
        .map(|s| s.access_key.as_str())
        .unwrap_or(&cfg.aws_access_key_id);
    let secret_key = secret
        .as_ref()
        .map(|s| s.secret_key.as_str())
        .unwrap_or(&cfg.aws_secret_access_key);

    // Advertise on loopback: fleets run as children of the runner in its own
    // network namespace, and the runner already reaches them at
    // 127.0.0.1:{internal} (reload_fleet). A hostname advertise
    // (fleet-{slug}) doesn't resolve inside the container, which breaks celld
    // node discovery (d1/diagnose read the lease and dial `addr`).
    let mut child = Command::new(&cfg.celld_bin)
        .args([
            "--bucket",
            &app.fleet_bucket,
            "--endpoint",
            &cfg.s3_endpoint,
            "--region",
            &cfg.aws_region,
            "--listen",
            &format!("0.0.0.0:{listen}"),
            "--internal-listen",
            &format!("0.0.0.0:{internal}"),
            "--advertise",
            &format!("127.0.0.1:{internal}"),
        ])
        .env("AWS_ACCESS_KEY_ID", access)
        .env("AWS_SECRET_ACCESS_KEY", secret_key)
        .env("AWS_REGION", &cfg.aws_region)
        .env("AWS_EC2_METADATA_DISABLED", "true")
        .env("S3_ENDPOINT", &cfg.s3_endpoint)
        .env("CELLD_WATCH", &state_dir)
        .env("CELLD_DURABILITY", "bucket")
        .env("CELLD_DEPLOY_POLL_S", "5")
        .env("CELLD_TRUST_FORWARDED_HEADERS", "1")
        // Fleet telemetry -> Parquet in the fleet bucket (celld OTel, bucket
        // sink). 2 s flush + 10 s runner aggregation = ~near-real-time request
        // counts; retention matches the runner's app_metric prune.
        .env("CELLD_OTEL", "1")
        .env("CELLD_OTEL_FLUSH_MS", "2000")
        .env("CELLD_OTEL_RETENTION", "14d")
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
