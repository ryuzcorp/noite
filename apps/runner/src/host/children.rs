//! Long-lived platform children (SPEC, Process tree):
//! Caddy and the control fleet. The runner owns their whole lifecycle: a
//! child that exits is restarted with backoff, and shutdown stops it with
//! SIGTERM (Caddy drains, celld seals its node log) before SIGKILL.
//!
//! Tenant fleets keep their own supervision (`host::supervisor`, driven by
//! the reconcile loop); these two are not apps and have no desired state.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::config::Config;
use crate::host::logs::{self, LogState};

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
        Self::start_observed(name, None, None, make)
    }

    /// Start with the running pid mirrored into `pid` and, when `capture` is
    /// set, the child's stdout+stderr appended to the shared log buffer under
    /// that slug (the caller must pipe both). Both exist for the control
    /// fleet: the metrics ingest samples its CPU like a tenant fleet's, and
    /// its node log is what an operator reads next to the worker's OTel logs.
    /// The pid slot is shared (not created here) so the caller can hand it to
    /// the reconcile loop before this child exists.
    pub fn start_observed<F>(
        name: &'static str,
        pid: Option<Arc<AtomicU32>>,
        capture: Option<(LogState, String)>,
        make: F,
    ) -> Self
    where
        F: Fn() -> Command + Send + Sync + 'static,
    {
        let sup = Self {
            name,
            stop: Arc::new(AtomicBool::new(false)),
            pid: pid.unwrap_or_else(|| Arc::new(AtomicU32::new(0))),
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
                        if let Some((state, slug)) = &capture {
                            capture_output(&mut child, state, slug);
                        }
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

/// Pipe a supervised child's stdout+stderr into the shared per-slug log
/// buffer. The caller must have set both to piped stdio; a poll cadence of one
/// reader task per pipe matches `supervisor::ensure_fleet` for tenant fleets.
/// Readers are per spawn: a restarted child gets fresh pipes and fresh tasks.
fn capture_output(child: &mut tokio::process::Child, state: &LogState, slug: &str) {
    if let Some(stdout) = child.stdout.take() {
        capture_lines(stdout, state, slug);
    }
    if let Some(stderr) = child.stderr.take() {
        capture_lines(stderr, state, slug);
    }
}

/// One reader task: every line of one piped stream into the shared buffer.
fn capture_lines<R>(pipe: R, state: &LogState, slug: &str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let state = state.clone();
    let slug = slug.to_string();
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            logs::append(&state, &slug, line).await;
        }
    });
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

/// Caddy: admin on its default 127.0.0.1:2019, where the runner
/// POSTs each new config (`host::caddy::load_admin`); `--watch` on the same
/// file stays as the fallback path.
pub fn supervise_caddy(config: &Config) -> Supervised {
    let caddyfile = config.caddyfile_path.clone();
    Supervised::start("caddy", move || {
        let mut cmd = tokio::process::Command::new("caddy");
        cmd.args([
            "run",
            "--config",
            &caddyfile,
            "--adapter",
            "caddyfile",
            "--watch",
        ])
        // Certificates and ACME state in the volume, not in the
        // container's $HOME: a recreate must not re-issue every cert
        // (CA rate limits) or lose the on-demand ones.
        .env("XDG_DATA_HOME", "/data/caddy/data")
        .env("XDG_CONFIG_HOME", "/data/caddy/config");
        cmd
    })
}
