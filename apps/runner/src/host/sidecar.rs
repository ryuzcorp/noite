//! Loopback S3 sidecar for the container cell.
//!
//! The celld fence blocks every route from the container to the
//! compose-network object store, so in `sidecar_s3` mode the runner spawns
//! its own rustfs on 127.0.0.1:9000 (same net namespace — loopback is inside
//! the fence) and talks S3-protocol to it. All existing `aws`-CLI paths and
//! `celld --bucket s3://…` tenant fleets work unmodified against the sidecar;
//! durability is relayed by the control worker into R2 (`host/sync.rs` +
//! `RunnerContainer` import/export). The sidecar holds no unique state:
//! everything in it is a copy of what the relay carries.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Child;

use crate::config::Config;

/// Loopback endpoint the sidecar serves (also the in-container S3_ENDPOINT).
pub const SIDECAR_ENDPOINT: &str = "http://127.0.0.1:9000";

/// Data dir for the sidecar, under the (ephemeral) work dir.
pub fn sidecar_dir(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.work_dir).join("sidecar")
}

fn rustfs_cmd(dir: &Path, cfg: &Config) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("/usr/local/bin/rustfs");
    cmd.arg(dir.as_os_str())
        .arg("--address")
        .arg("127.0.0.1:9000")
        .env("RUSTFS_ACCESS_KEY", &cfg.aws_access_key_id)
        .env("RUSTFS_SECRET_ACCESS_KEY", &cfg.aws_secret_access_key)
        .env("AWS_EC2_METADATA_DISABLED", "true")
        .env("RUSTFS_CONSOLE_ENABLE", "false")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

/// Spawn the sidecar and wait until it answers. The returned child is owned
/// by the caller for the process lifetime (`kill_on_drop`).
pub async fn spawn_sidecar(cfg: &Config) -> anyhow::Result<Child> {
    let dir = sidecar_dir(cfg);
    tokio::fs::create_dir_all(&dir).await?;
    let mut child = match rustfs_cmd(&dir, cfg).spawn() {
        Ok(child) => child,
        Err(e) => {
            tracing::warn!(error = %e, "sidecar /usr/local/bin/rustfs missing; trying PATH");
            let mut fallback = tokio::process::Command::new("rustfs");
            fallback
                .arg(dir.as_os_str())
                .arg("--address")
                .arg("127.0.0.1:9000")
                .env("RUSTFS_ACCESS_KEY", &cfg.aws_access_key_id)
                .env("RUSTFS_SECRET_ACCESS_KEY", &cfg.aws_secret_access_key)
                .env("AWS_EC2_METADATA_DISABLED", "true")
                .env("RUSTFS_CONSOLE_ENABLE", "false")
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            fallback.spawn()?
        }
    };
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "sidecar", "{line}");
            }
        });
    }
    for _ in 0..60 {
        if tokio::net::TcpStream::connect("127.0.0.1:9000").await.is_ok() {
            tracing::info!("sidecar s3 up at {SIDECAR_ENDPOINT}");
            return Ok(child);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    anyhow::bail!("sidecar s3 not listening at {SIDECAR_ENDPOINT} after 30s");
}
