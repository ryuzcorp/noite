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

/// Where one supervised platform child (Caddy, the control fleet) is. The
/// supervision task is the only writer; `pid = 0` used to mean both "between
/// spawns" and "stopped for good", so a restart's backoff and a shutdown were
/// indistinguishable.
///
/// ```text
/// stateDiagram-v2
///     Starting --> Running: Spawned(pid)
///     Starting --> Backoff: SpawnFailed
///     Running --> Backoff: Exited (short run, attempt+1)
///     Running --> Starting: Exited (ran HEALTHY_RUN, attempt reset)
///     Backoff --> Starting: Tick (backoff passed)
///     Starting --> Stopped: Stopped
///     Running --> Stopped: Stopped
///     Backoff --> Stopped: Stopped
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildState {
    /// No child right now; the task will spawn one. `attempt` is the streak
    /// of short runs it carries, so the backoff keeps growing across retries.
    Starting { attempt: u32 },
    /// A child runs with this pid.
    Running { pid: u32, attempt: u32 },
    /// The child exited (or its spawn failed) and the retry waits until
    /// `until`, doubling after every short run.
    Backoff { attempt: u32, until: Instant },
    /// Stopped for good: the supervision task is finished.
    Stopped,
}

/// What happened to a supervised child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildEvent {
    /// A spawn succeeded (the pid is live).
    Spawned { pid: u32 },
    /// The spawn itself failed.
    SpawnFailed { at: Instant },
    /// The child exited after running for `ran`.
    Exited { ran: Duration, at: Instant },
    /// A deliberate stop.
    Stopped,
    /// A timer: an expired backoff is due to retry.
    Tick { at: Instant },
}

impl ChildState {
    /// The one transition function for platform children.
    pub fn on(self, event: ChildEvent) -> Self {
        use ChildEvent as E;
        use ChildState as S;
        match (self, event) {
            (S::Starting { attempt }, E::Spawned { pid }) => S::Running { pid, attempt },
            (S::Backoff { attempt, .. }, E::Spawned { pid }) => S::Running { pid, attempt },
            (S::Starting { attempt }, E::SpawnFailed { at })
            | (S::Backoff { attempt, .. }, E::SpawnFailed { at }) => {
                let attempt = attempt.saturating_add(1);
                S::Backoff {
                    attempt,
                    until: at + backoff_for(attempt),
                }
            }
            (S::Running { attempt, .. }, E::Exited { ran, at }) => {
                // A long, healthy run starts the next crash over at the
                // shortest wait; a short one doubles the streak.
                let attempt = if ran >= HEALTHY_RUN {
                    1
                } else {
                    attempt.saturating_add(1)
                };
                S::Backoff {
                    attempt,
                    until: at + backoff_for(attempt),
                }
            }
            (_, E::Stopped) => S::Stopped,
            (S::Backoff { attempt, until }, E::Tick { at }) if at >= until => {
                S::Starting { attempt }
            }
            (state, _) => state,
        }
    }

    /// Whether the supervision task may spawn now.
    pub fn may_spawn(self) -> bool {
        matches!(self, ChildState::Starting { .. })
    }
}

/// Wait after the N-th consecutive short run: 1, 2, 4 … capped at 30 s.
fn backoff_for(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(5);
    (BACKOFF_MIN * 2u32.pow(shift)).min(BACKOFF_MAX)
}

#[derive(Clone)]
pub struct Supervised {
    name: &'static str,
    stop: Arc<AtomicBool>,
    /// Pid of the running child, 0 when none. Shared with readers that sample
    /// the child from outside (the metrics ingest), so it stays a slot and the
    /// lifecycle lives in `state`.
    pid: Arc<AtomicU32>,
    /// The child's lifecycle (see [`ChildState`]).
    state: Arc<std::sync::Mutex<ChildState>>,
    /// Signalled when the supervision task has exited for good.
    done: Arc<Notify>,
    /// Wakes the supervision task out of a backoff sleep when `stop` is set:
    /// the child is not running, so nothing else would end that wait before
    /// the budget expires.
    wake: Arc<Notify>,
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
        Self::start_observed_with(name, pid, capture, None::<fn(u32)>, make)
    }

    /// [`start_observed`] plus `on_spawn`, run with the child's pid right
    /// after a successful spawn (before its pipes are read). The control
    /// fleet uses it to move itself into its cgroup leaf; a hook must not
    /// block, or the child runs without its pipe readers meanwhile.
    pub fn start_observed_with<F, G>(
        name: &'static str,
        pid: Option<Arc<AtomicU32>>,
        capture: Option<(LogState, String)>,
        on_spawn: Option<G>,
        make: F,
    ) -> Self
    where
        F: Fn() -> Command + Send + Sync + 'static,
        G: Fn(u32) + Send + Sync + 'static,
    {
        let sup = Self {
            name,
            stop: Arc::new(AtomicBool::new(false)),
            pid: pid.unwrap_or_else(|| Arc::new(AtomicU32::new(0))),
            state: Arc::new(std::sync::Mutex::new(ChildState::Starting { attempt: 0 })),
            done: Arc::new(Notify::new()),
            wake: Arc::new(Notify::new()),
        };
        let task = sup.clone();
        tokio::spawn(async move {
            while !task.stop.load(Ordering::Relaxed) {
                let now = Instant::now();
                let state = task.transition(ChildEvent::Tick { at: now });
                if let ChildState::Backoff { until, .. } = state {
                    // Sleep only until the backoff expires — or until a stop
                    // asks the task to end, which `stop()` signals on `wake`.
                    let wait = until.saturating_duration_since(now);
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = task.wake.notified() => {}
                    }
                    continue;
                }
                if !state.may_spawn() {
                    break;
                }
                let mut cmd = make();
                cmd.kill_on_drop(true);
                let started = Instant::now();
                match cmd.spawn() {
                    Ok(mut child) => {
                        let pid = child.id().unwrap_or(0);
                        task.pid.store(pid, Ordering::Relaxed);
                        task.transition(ChildEvent::Spawned { pid });
                        if let Some(hook) = &on_spawn {
                            hook(pid);
                        }
                        tracing::info!(child = task.name, pid, "started");
                        if let Some((state, slug)) = &capture {
                            capture_output(&mut child, state, slug);
                        }
                        // A stop that landed between the loop check above and
                        // this spawn: terminate the child now. Without this the
                        // caller's SIGTERM missed it and its budget ran out
                        // before the SIGKILL (a bounded but real shutdown
                        // delay, and a fleet running through its own stop).
                        if task.stop.load(Ordering::Relaxed) && pid != 0 {
                            signal(pid, libc::SIGTERM);
                        }
                        let status = child.wait().await;
                        task.pid.store(0, Ordering::Relaxed);
                        if task.stop.load(Ordering::Relaxed) {
                            break;
                        }
                        tracing::warn!(child = task.name, ?status, "exited; restarting");
                        task.transition(ChildEvent::Exited {
                            ran: started.elapsed(),
                            at: Instant::now(),
                        });
                    }
                    Err(e) => {
                        tracing::error!(child = task.name, error = %e, "spawn failed; retrying");
                        task.transition(ChildEvent::SpawnFailed { at: Instant::now() });
                    }
                }
            }
            task.transition(ChildEvent::Stopped);
            task.done.notify_waiters();
        });
        sup
    }

    /// Apply one transition to the child's lifecycle and return the new state.
    fn transition(&self, event: ChildEvent) -> ChildState {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *state = state.on(event);
        *state
    }

    /// The child's current lifecycle state.
    pub fn state(&self) -> ChildState {
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Stop for good: SIGTERM, wait up to `budget`, then SIGKILL.
    pub async fn stop(&self, budget: Duration) {
        self.stop.store(true, Ordering::Relaxed);
        // `notify_one` stores a permit, so a stop that lands before the task
        // reaches its `select!` is not lost.
        self.wake.notify_one();
        let pid = self.pid.load(Ordering::Relaxed);
        if pid != 0 {
            signal(pid, libc::SIGTERM);
        }
        let waited = tokio::time::timeout(budget, async {
            loop {
                // Re-check after registering, so a notify between the load
                // and the await is not missed.
                let notified = self.done.notified();
                if self.state() == ChildState::Stopped {
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

/// Caddy: static config, written once at boot (`host::caddy`), with the
/// admin on its default 127.0.0.1:2019, where the runner pushes the route
/// table (`host::edge_table::push_routes`). App events never reload: there
/// is no `--watch` and no `/load` path after boot. On boot Caddy reads the
/// file the runner wrote before supervising it; the table file it loads in
/// Provision, and the tick re-pushes the live table.
pub fn supervise_caddy(config: &Config) -> Supervised {
    let caddyfile = config.caddyfile_path.clone();
    Supervised::start("caddy", move || {
        let mut cmd = tokio::process::Command::new("caddy");
        cmd.args(["run", "--config", &caddyfile, "--adapter", "caddyfile"])
            // Certificates and ACME state in the volume, not in the
            // container's $HOME: a recreate must not re-issue every cert
            // (CA rate limits) or lose the on-demand ones.
            .env("XDG_DATA_HOME", "/data/caddy/data")
            .env("XDG_CONFIG_HOME", "/data/caddy/config");
        cmd
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The platform-child table: a short run doubles the retry wait, a long
    /// one resets it, the wait is skipped by a tick, and a stop wins from
    /// every state (that is what makes "stop while restarting" safe).
    #[test]
    fn child_state_transition_table() {
        use ChildEvent as E;
        use ChildState as S;
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);

        let s = S::Starting { attempt: 0 }.on(E::Spawned { pid: 42 });
        assert_eq!(
            s,
            S::Running {
                pid: 42,
                attempt: 0
            }
        );
        let s = s.on(E::Exited {
            ran: Duration::from_secs(3),
            at: t0,
        });
        assert_eq!(
            s,
            S::Backoff {
                attempt: 1,
                until: at(1)
            },
            "the first short run waits one second"
        );
        assert!(!s.may_spawn());
        assert_eq!(s.on(E::Tick { at: at(1) }), S::Starting { attempt: 1 });

        // Second short run doubles, and the streak survives the retry.
        let s = S::Starting { attempt: 1 }
            .on(E::Spawned { pid: 43 })
            .on(E::Exited {
                ran: Duration::from_secs(2),
                at: t0,
            });
        assert_eq!(
            s,
            S::Backoff {
                attempt: 2,
                until: at(2)
            }
        );

        // A healthy run resets the streak.
        let s = S::Running {
            pid: 44,
            attempt: 9,
        }
        .on(E::Exited {
            ran: HEALTHY_RUN,
            at: t0,
        });
        assert_eq!(
            s,
            S::Backoff {
                attempt: 1,
                until: at(1)
            }
        );

        // A failed spawn backs off too instead of spinning.
        let s = S::Starting { attempt: 0 }.on(E::SpawnFailed { at: t0 });
        assert_eq!(
            s,
            S::Backoff {
                attempt: 1,
                until: at(1)
            }
        );

        // A stop wins from every state, and nothing restarts it.
        for state in [
            S::Starting { attempt: 0 },
            S::Running { pid: 1, attempt: 3 },
            S::Backoff {
                attempt: 2,
                until: at(30),
            },
        ] {
            assert_eq!(state.on(E::Stopped), S::Stopped, "{state:?}");
            assert_eq!(
                S::Stopped.on(E::Tick { at: at(9999) }),
                S::Stopped,
                "a stopped child never retries"
            );
            assert!(!S::Stopped.may_spawn());
        }
    }

    /// A stop during a backoff wait ends the supervision task at once: the
    /// wait is on the backoff clock (a second at minimum), so a stop that only
    /// set a flag left the caller waiting out its whole budget with no pid to
    /// kill.
    #[tokio::test]
    async fn a_stop_ends_a_backoff_wait_instead_of_waiting_it_out() {
        // A child that exits at once: the task lands in `Backoff` (1 s).
        let sup = Supervised::start("flapper", || {
            let mut cmd = Command::new("false");
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            cmd
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !matches!(sup.state(), ChildState::Backoff { .. }) {
            assert!(Instant::now() < deadline, "the child never backed off");
            tokio::task::yield_now().await;
        }

        // A 20 ms budget is far shorter than the 1 s backoff: only a task that
        // was woken can reach `Stopped` inside it.
        sup.stop(Duration::from_millis(20)).await;

        let deadline = Instant::now() + Duration::from_millis(500);
        while sup.state() != ChildState::Stopped {
            assert!(
                Instant::now() < deadline,
                "the stop did not wake the backoff sleep: {:?}",
                sup.state()
            );
            tokio::task::yield_now().await;
        }
    }

    #[test]
    fn backoff_caps_at_thirty_seconds() {
        assert_eq!(backoff_for(1), Duration::from_secs(1));
        assert_eq!(backoff_for(3), Duration::from_secs(4));
        assert_eq!(backoff_for(99), Duration::from_secs(30));
    }
}
