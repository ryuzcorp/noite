//! Long-lived platform children (SPEC, Process tree):
//! Caddy and the control fleet. The runner owns their whole lifecycle: a
//! child that exits is restarted with backoff, and shutdown stops it with
//! SIGTERM (Caddy drains, celld seals its node log) before SIGKILL.
//!
//! Tenant fleets keep their own supervision (`host::supervisor`, driven by
//! the reconcile loop); these two are not apps and have no desired state.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use tokio::process::Command;
use tokio::sync::Notify;

/// Restart backoff bounds; a child that ran this long counts as healthy and
/// resets the backoff.
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const HEALTHY_RUN: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Supervised {
    name: &'static str,
    stop: Arc<AtomicBool>,
    /// Pid of the running child, 0 when none.
    pid: Arc<AtomicU32>,
    /// Signalled when the supervision task has exited for good.
    done: Arc<Notify>,
    finished: Arc<AtomicBool>,
}

impl Supervised {
    /// Start `make()` now and keep it running until `stop`.
    pub fn start<F>(name: &'static str, make: F) -> Self
    where
        F: Fn() -> Command + Send + Sync + 'static,
    {
        let sup = Self {
            name,
            stop: Arc::new(AtomicBool::new(false)),
            pid: Arc::new(AtomicU32::new(0)),
            done: Arc::new(Notify::new()),
            finished: Arc::new(AtomicBool::new(false)),
        };
        let task = sup.clone();
        tokio::spawn(async move {
            let mut backoff = BACKOFF_MIN;
            while !task.stop.load(Ordering::Relaxed) {
                let mut cmd = make();
                cmd.kill_on_drop(true);
                let started = Instant::now();
                match cmd.spawn() {
                    Ok(mut child) => {
                        task.pid.store(child.id().unwrap_or(0), Ordering::Relaxed);
                        tracing::info!(child = task.name, "started");
                        let status = child.wait().await;
                        task.pid.store(0, Ordering::Relaxed);
                        if task.stop.load(Ordering::Relaxed) {
                            break;
                        }
                        tracing::warn!(child = task.name, ?status, "exited; restarting");
                    }
                    Err(e) => {
                        tracing::error!(child = task.name, error = %e, "spawn failed; retrying");
                    }
                }
                if started.elapsed() >= HEALTHY_RUN {
                    backoff = BACKOFF_MIN;
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
            task.finished.store(true, Ordering::Relaxed);
            task.done.notify_waiters();
        });
        sup
    }

    /// Stop for good: SIGTERM, wait up to `budget`, then SIGKILL.
    pub async fn stop(&self, budget: Duration) {
        self.stop.store(true, Ordering::Relaxed);
        let pid = self.pid.load(Ordering::Relaxed);
        if pid != 0 {
            signal(pid, libc::SIGTERM);
        }
        let waited = tokio::time::timeout(budget, async {
            while !self.finished.load(Ordering::Relaxed) {
                // Re-check after registering, so a notify between the load
                // and the await is not missed.
                let notified = self.done.notified();
                if self.finished.load(Ordering::Relaxed) {
                    break;
                }
                notified.await;
            }
        })
        .await;
        if waited.is_err() {
            let pid = self.pid.load(Ordering::Relaxed);
            tracing::warn!(child = self.name, "did not stop within budget; killing");
            if pid != 0 {
                signal(pid, libc::SIGKILL);
            }
        }
        tracing::info!(child = self.name, "stopped");
    }
}

fn signal(pid: u32, sig: libc::c_int) {
    // SAFETY: signals a pid this module spawned and still tracks.
    unsafe {
        libc::kill(pid as i32, sig);
    }
}

/// Caddy's first config: serves a placeholder until the runner's first
/// reconcile writes the real Caddyfile (`caddy run` refuses a missing file).
pub async fn ensure_bootstrap_caddyfile(path: &str) -> anyhow::Result<()> {
    let path = std::path::Path::new(path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if !path.exists() {
        tokio::fs::write(path, ":80 {\n\trespond \"noite edge starting\" 200\n}\n").await?;
    }
    Ok(())
}
