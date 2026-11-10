use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::db;
use crate::host::logs::LogState;
use crate::host::{credentials, logs};
use crate::models::{App, FleetHold, FleetHoldInfo};
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

/// Every supervised fleet's runtime, keyed by fleet key (`slug`, or
/// `slug.label` for a preview): the child process (when it has one) plus the
/// explicit [`FleetState`] that says what the fleet is doing. Nothing else in
/// the runner answers "is this fleet up?" — the map used to be plain
/// `Child` presence, which could not tell a live child from an exited one,
/// nor a fresh spawn from a crash-held or parked one.
pub type ProcMap = Arc<Mutex<HashMap<String, FleetEntry>>>;

pub fn new_procs() -> ProcMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// One fleet's supervised lifecycle. See the module docs on
/// [`FleetState::on`] for the transition table; every state change goes
/// through that one function, so a caller never has to combine "child exists",
/// "row says running", "crash gate", "OOM hold", and "confirm set" by hand.
///
/// ```text
/// stateDiagram-v2
///     Absent --> Spawning: Spawned
///     Spawning --> Probing: ProbeStarted
///     Probing --> Healthy: Confirmed
///     Probing --> Spawning: Unconfirmed
///     Probing --> Spawning: Tick (probe deadline passed)
///     Spawning --> Healthy: Confirmed (a wake's own gate)
///     Spawning --> CrashHeld: Exited(no OOM)
///     Probing --> CrashHeld: Exited(no OOM)
///     Healthy --> CrashHeld: Exited(no OOM)
///     Spawning --> OomHeld: Exited(OOM)
///     Probing --> OomHeld: Exited(OOM)
///     Healthy --> OomHeld: Exited(OOM)
///     CrashHeld --> Spawning: Spawned (hold passed)
///     OomHeld --> Spawning: Spawned (hold passed)
///     Absent --> Asleep: Parked (nothing left to stop)
///     Spawning --> Absent: SpawnFailed
///     Spawning --> Asleep: Parked
///     Probing --> Asleep: Parked
///     Healthy --> Asleep: Parked
///     Waking --> Spawning: Spawned (the wake's own cold start, once the hold it carried lapsed)
///     Asleep --> Waking: Woke (keeps the parked hold)
///     Absent --> Waking: Woke (first wake after a runner restart)
///     Waking --> Healthy: Confirmed
///     Waking --> Asleep: Parked (the wake failed)
///     Spawning --> Stopped: Stopped
///     Probing --> Stopped: Stopped
///     Healthy --> Stopped: Stopped
///     CrashHeld --> Stopped: Stopped
///     OomHeld --> Stopped: Stopped
///     Asleep --> Stopped: Stopped
///     Waking --> Stopped: Stopped
///     Stopped --> Absent: Woke / Spawned
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetState {
    /// No child and no hold: the next `ensure_fleet` spawns one.
    Absent,
    /// A child runs; it has not answered its health gate yet. `since` is the
    /// instant the current child started (the healthy-window clock), and
    /// `crashes` the non-OOM chain length it inherited.
    Spawning { since: Instant, crashes: u32 },
    /// A health probe is in flight for the child (one per fleet; the state
    /// itself makes a second probe impossible). `until` is the probe's
    /// deadline: a probe task that dies without reporting cannot wedge the
    /// fleet, because the next tick past `until` puts it back to `Spawning`.
    Probing {
        since: Instant,
        crashes: u32,
        until: Instant,
    },
    /// The current child answered its health gate.
    Healthy { since: Instant, crashes: u32 },
    /// The child exited on its own; the next spawn waits until `until`
    /// (5 s, 10 s, 20 s … capped at 60 s, reset after five healthy minutes).
    CrashHeld { crashes: u32, until: Instant },
    /// The kernel OOM-killed the child at its memory cap; the next spawn waits
    /// until `until` (5 s … capped at 300 s).
    OomHeld { crashes: u32, until: Instant },
    /// A held request, or a deploy, is cold-starting a parked fleet; the row
    /// keeps saying asleep until the health gate opens, so a failed wake
    /// leaves the fleet exactly as parked as it was. `until` is the hold the
    /// wake inherited from `Asleep`: a wake neither drops the backoff nor
    /// spawns through it, so the fleet still waits it out.
    Waking {
        since: Instant,
        crashes: u32,
        until: Option<Instant>,
    },
    /// Parked by the sleep sweep, an operator sleep, or memory pressure: no
    /// child, and the edge wakes it on the next request. `until` is the hold
    /// the park inherited from a crash/OOM backoff: a parked fleet that had
    /// just crash-looped still backs off, so waking it fails fast until then,
    /// and the wake carries the hold on into [`FleetState::Waking`].
    Asleep { until: Option<Instant> },
    /// Deliberately stopped (desired state, delete, teardown): no child and no
    /// automatic respawn.
    Stopped,
}

/// What happened to a fleet. Every [`FleetState::on`] transition names one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FleetEvent {
    /// A child was spawned for the fleet.
    Spawned { at: Instant },
    /// A health probe started; `until` is its deadline.
    ProbeStarted { until: Instant },
    /// The health gate answered 200.
    Confirmed,
    /// The health gate gave up without an answer; the next tick probes again.
    Unconfirmed,
    /// The child exited on its own. `oom` says the kernel killed it at its cap.
    Exited { oom: bool, at: Instant },
    /// A held request is being woken (only meaningful from `Asleep`).
    Woke { at: Instant },
    /// The sleep sweep or an operator parked it.
    Parked,
    /// A deliberate stop or delete.
    Stopped,
    /// The spawn this claim covered never produced a child (exec error, no
    /// leaf in `multi`, a refused cgroup move): release the claim so the next
    /// tick may try again.
    SpawnFailed,
    /// A timer: an expired hold becomes [`FleetState::Absent`].
    Tick { at: Instant },
}

/// Non-OOM crash backoff: 5 s, doubling to a 60 s cap.
const CRASH_BACKOFF_BASE: Duration = Duration::from_secs(5);
const CRASH_BACKOFF_CAP: Duration = Duration::from_secs(60);
/// A fleet that stayed up this long starts a fresh crash chain.
const CRASH_HEALTHY_AFTER: Duration = Duration::from_secs(300);

/// Wait after the N-th consecutive crash: 5, 10, 20, 40, 60 … seconds.
pub(crate) fn crash_backoff(consecutive: u32) -> Duration {
    let shift = consecutive.saturating_sub(1).min(4);
    (CRASH_BACKOFF_BASE * 2u32.pow(shift)).min(CRASH_BACKOFF_CAP)
}

impl FleetState {
    /// The one transition function: every state change in the fleet
    /// supervisor is `state = state.on(event)`. Illegal events leave the state
    /// alone (a stop that arrives twice, a confirm for a parked fleet, a probe
    /// for a fleet with no child), so a caller can act on whichever event it
    /// observed without re-deriving the preconditions.
    pub fn on(self, event: FleetEvent) -> Self {
        use FleetEvent as E;
        use FleetState as S;
        match (self, event) {
            // A spawn is only meaningful for a fleet that is not running.
            (S::Absent | S::Stopped, E::Spawned { at }) => S::Spawning {
                since: at,
                crashes: 0,
            },
            (S::CrashHeld { crashes, .. } | S::OomHeld { crashes, .. }, E::Spawned { at }) => {
                S::Spawning { since: at, crashes }
            }
            (S::Asleep { .. } | S::Waking { .. }, E::Spawned { at }) => S::Spawning {
                since: at,
                crashes: 0,
            },

            (S::Spawning { since, crashes }, E::ProbeStarted { until }) => S::Probing {
                since,
                crashes,
                until,
            },
            (S::Spawning { since, crashes }, E::Confirmed)
            | (S::Probing { since, crashes, .. }, E::Confirmed) => S::Healthy { since, crashes },
            (S::Waking { since, crashes, .. }, E::Confirmed) => S::Healthy { since, crashes },
            // A probe that timed out just means "not yet": the next tick
            // retries, and the repeated state is the explicit no-op.
            (S::Probing { since, crashes, .. }, E::Unconfirmed) => S::Spawning { since, crashes },
            // A probe that never reported (its task died) is reclaimed by the
            // deadline, so a fleet can always be confirmed again.
            (
                S::Probing {
                    since,
                    crashes,
                    until,
                    ..
                },
                E::Tick { at },
            ) if at >= until => S::Spawning { since, crashes },

            // A crash from any state with a running child takes the exit path.
            (S::Spawning { since, crashes }, E::Exited { oom, at })
            | (S::Probing { since, crashes, .. }, E::Exited { oom, at })
            | (S::Healthy { since, crashes }, E::Exited { oom, at })
            | (S::Waking { since, crashes, .. }, E::Exited { oom, at }) => {
                // A fleet that ran longer than the healthy window starts a
                // fresh chain instead of escalating forever.
                let chain = if at.saturating_duration_since(since) >= CRASH_HEALTHY_AFTER {
                    1
                } else {
                    crashes.saturating_add(1).max(1)
                };
                if oom {
                    S::OomHeld {
                        crashes: chain,
                        until: at + crate::host::cgroups::oom_backoff_delay(chain),
                    }
                } else {
                    S::CrashHeld {
                        crashes: chain,
                        until: at + crash_backoff(chain),
                    }
                }
            }

            // A wake moves the fleet out of `Asleep` (a deploy needs its
            // fleet to spawn, and the row is about to say awake) but keeps the
            // hold it inherited: dropping it here spawned a crash-looping
            // fleet on the very next reconcile tick, and the next request no
            // longer failed fast. `Absent` is the first wake after a runner
            // restart: the row was parked but this process never saw the park.
            (S::Asleep { until }, E::Woke { at }) => S::Waking {
                since: at,
                crashes: 0,
                until,
            },
            (S::Absent, E::Woke { at }) => S::Waking {
                since: at,
                crashes: 0,
                until: None,
            },
            // Parking is a deliberate scale-to-zero, and it keeps whatever
            // backoff the fleet had: a fleet parked while crash-held rests
            // `Asleep` with that hold, so a wake still fails fast until it
            // expires. `Absent` is the state a park lands in once the child is
            // already gone (the sweep stops the fleet, then records the park).
            (S::CrashHeld { until, .. } | S::OomHeld { until, .. }, E::Parked) => {
                S::Asleep { until: Some(until) }
            }
            // A park inside the window of a hold a wake carried keeps it: the
            // fleet is parked *and* still backing off, exactly as a
            // crash-then-park rests.
            (S::Waking { until, .. }, E::Parked) => S::Asleep { until },
            (S::Absent | S::Spawning { .. } | S::Probing { .. } | S::Healthy { .. }, E::Parked) => {
                S::Asleep { until: None }
            }

            // A stop wins over every state: the caller then tears the child
            // down and the fleet stays `Stopped` until a spawn restarts it.
            (_, E::Stopped) => S::Stopped,

            // Only a claimed spawn can fail: the fleet was never running, so
            // it is back to "spawn when due".
            (S::Spawning { .. }, E::SpawnFailed) => S::Absent,

            // An expired hold is not a state of its own: the caller spawns
            // straight from `CrashHeld`/`OomHeld`, which is what carries
            // `crashes` into the next `Spawning` and keeps the backoff
            // growing. Collapsing to `Absent` here would reset the chain to
            // one crash on every retry (a 5 s restart storm forever).

            // Everything else: illegal or already handled. The state stands.
            (state, _) => state,
        }
    }

    /// The instant a crash/OOM hold expires, when the state has one.
    pub fn hold_until(self) -> Option<Instant> {
        match self {
            FleetState::CrashHeld { until, .. } | FleetState::OomHeld { until, .. } => Some(until),
            FleetState::Asleep { until } | FleetState::Waking { until, .. } => until,
            _ => None,
        }
    }

    /// Whether a child is expected to be running in this state.
    pub fn is_live(self) -> bool {
        matches!(
            self,
            FleetState::Spawning { .. }
                | FleetState::Probing { .. }
                | FleetState::Healthy { .. }
                | FleetState::Waking { .. }
        )
    }
}

/// The next spawn identity, process-wide and monotonic. A per-entry counter
/// would restart at 0 for a key that was stopped (the entry is removed) and
/// hand a *new* generation the number an in-flight old one still holds — the
/// stale spawn would then win its claim again.
static NEXT_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn next_epoch() -> u64 {
    NEXT_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// How long a spawn claim may stand before it is treated as debris. A spawn
/// that takes longer than this is wedged (the runner's own exec timeouts are
/// shorter), and the claim exists to recover from exactly that.
const SPAWN_CLAIM_TTL: Duration = Duration::from_secs(300);

/// One entry of the [`ProcMap`]: the child (when the state has one), the state
/// machine's current value, and the **spawn epoch**.
///
/// The epoch is the spawn's identity: `ensure_spawned` bumps it when it claims
/// the right to spawn (moving the fleet to `Spawning` under the map lock), and
/// the spawn adopts its child and records its exit only while that epoch is
/// still the entry's. Two concurrent `ensure_fleet`s therefore cannot both
/// spawn one fleet, and a child from a spawn that lost its claim is killed
/// rather than adopted.
pub struct FleetEntry {
    child: Option<Child>,
    state: FleetState,
    epoch: u64,
}

impl FleetEntry {
    fn new(child: Option<Child>, state: FleetState) -> Self {
        Self {
            child,
            state,
            epoch: 0,
        }
    }

    /// The supervised child, when the fleet has one (the metrics sampler only
    /// needs its pid).
    pub fn child(&self) -> Option<&Child> {
        self.child.as_ref()
    }

    /// Adopt a freshly spawned child, unless the fleet is parked or stopped:
    /// `Asleep`/`Stopped` with a live child is the state a stop-while-spawning
    /// race creates, and it must not be representable. Every write to `child`
    /// goes through here, which is what makes that true by construction.
    fn adopt(&mut self, child: &mut Option<Child>, epoch: u64) -> bool {
        if self.epoch != epoch
            || self.child.is_some()
            || matches!(self.state, FleetState::Asleep { .. } | FleetState::Stopped)
        {
            return false;
        }
        self.child = child.take();
        true
    }

    /// Take the child out of the entry (a park or a stop is about to kill it).
    fn take_child(&mut self) -> Option<Child> {
        self.child.take()
    }

    /// A supervised child in [`FleetState::Spawning`], for tests that need a
    /// real process in the map (the map has no other legal way in).
    #[cfg(test)]
    pub fn test_entry(child: Child) -> Self {
        Self::new(
            Some(child),
            FleetState::Spawning {
                since: Instant::now(),
                crashes: 0,
            },
        )
    }
}

/// What became of a fleet a caller was waiting on.
#[derive(Debug, PartialEq, Eq)]
pub enum FleetFate {
    /// Gone from the map: a stop or a teardown took it on purpose.
    Removed,
    /// celld exited on its own (still in the map until the next ensure).
    Exited(String),
}

/// Whether a fleet is supervised at all right now: a live child, a crash/OOM
/// hold, or a parked/stopped marker. Used by the reconcile loop to tell a cold
/// start (no entry, subject to the per-tick batch cap) from a fleet that is
/// already accounted for (its own hold or backoff decides when it spawns).
pub async fn has_process(procs: &ProcMap, key: &str) -> bool {
    procs.lock().await.contains_key(key)
}

/// The keys with a live child (running or spawning), not parked, held or
/// stopped placeholders. Telemetry and the orphan sweep care about processes,
/// not about which fleets are accounted for; `has_process` answers the latter.
pub async fn live_keys(procs: &ProcMap) -> Vec<String> {
    let map = procs.lock().await;
    map.iter()
        .filter(|(_, entry)| entry.state.is_live() && entry.child.is_some())
        .map(|(key, _)| key.clone())
        .collect()
}

/// The fleet's current state, `Absent` when nothing supervises it.
pub async fn state_of(procs: &ProcMap, key: &str) -> FleetState {
    procs
        .lock()
        .await
        .get(key)
        .map_or(FleetState::Absent, |entry| entry.state)
}

/// Apply one [`FleetEvent`] under the map lock and return the new state. This
/// is the only way a state changes: no caller pokes a flag or inserts a child
/// directly.
pub async fn note_event(procs: &ProcMap, key: &str, event: FleetEvent) -> FleetState {
    // Only the events that mean "a supervised fleet exists" create an entry.
    // A confirm, a probe or a timer that lands after a stop must not insert an
    // epoch-0 ghost: a live ghost makes `cleanup_scaffolding` reject the
    // stop's epoch and skip the cleanup of the fleet's leaf, proxy and pid
    // registration.
    let creates = matches!(
        event,
        FleetEvent::Parked | FleetEvent::Woke { .. } | FleetEvent::Spawned { .. }
    );
    let mut map = procs.lock().await;
    if creates {
        let entry = map
            .entry(key.to_string())
            .or_insert_with(|| FleetEntry::new(None, FleetState::Absent));
        entry.state = entry.state.on(event);
        return entry.state;
    }
    match map.get_mut(key) {
        Some(entry) => {
            entry.state = entry.state.on(event);
            entry.state
        }
        None => FleetState::Absent,
    }
}

/// Claim the health probe for `key`: `true` when this caller owns it, `false`
/// when the fleet is parked, held, stopped, or already being probed. `budget`
/// is the probe's own deadline, so a probe task that dies without reporting
/// (a cancelled spawn, a panic) cannot wedge the fleet: the tick that follows
/// the deadline puts it back to `Spawning` and the next confirm retries.
pub async fn probe_started(procs: &ProcMap, key: &str, budget: Duration) -> bool {
    let mut map = procs.lock().await;
    // A probe for a fleet nobody supervises is a no-op: creating an entry here
    // was another way to leave an epoch-0 ghost that outlives a stop.
    let Some(entry) = map.get_mut(key) else {
        return false;
    };
    entry.state = entry.state.on(FleetEvent::Tick { at: Instant::now() });
    if !matches!(entry.state, FleetState::Spawning { .. }) {
        return false;
    }
    entry.state = entry.state.on(FleetEvent::ProbeStarted {
        until: Instant::now() + budget,
    });
    true
}

/// The health gate answered 200 for `key`. Returns whether the fleet is
/// `Healthy` now — the caller writes `running` only then, which is what keeps
/// a confirm that raced a park from flipping a parked row back to running.
pub async fn confirmed(procs: &ProcMap, key: &str) -> bool {
    matches!(
        note_event(procs, key, FleetEvent::Confirmed).await,
        FleetState::Healthy { .. }
    )
}

/// The probe gave up (deadline, timeout, or a connection error): back to
/// `Spawning` so the next reconcile tick retries instead of the status
/// sticking at `building` forever.
pub async fn probe_gave_up(procs: &ProcMap, key: &str) {
    note_event(procs, key, FleetEvent::Unconfirmed).await;
}

/// The sentence a held fleet answers a deploy's health gate with: the same
/// one the edge wake gives a request, so an operator reading the failed deploy
/// is told to retry rather than handed a state dump.
fn hold_reason(until: Instant, now: Instant) -> String {
    format!(
        "fleet is restarting after a crash; retry in {}s",
        until.saturating_duration_since(now).as_secs().max(1)
    )
}

/// Resolve once the fleet under `key` is no longer a live child. A waiter
/// that holds a claim (a deploy on the health gate) races this, so the claim
/// never outlives the fleet it waits on.
///
/// The three answers differ, and they decide what a deploy does:
/// - no entry, `Absent`, `Stopped` or `Asleep`: [`FleetFate::Removed`] — nobody
///   is trying to serve, so the deploy records as before (a stop in the
///   window is what this arm exists for);
/// - a child that exited, or a fleet held after a crash/OOM — in the held
///   state itself or carried by a wake into `Waking`: [`FleetFate::Exited`]
///   — the fleet died, so the deploy must fail its health gate instead of
///   recording success and skipping its migrations;
/// - a live state with no child yet (`Spawning`/`Probing`, and a `Waking`
///   fleet whose hold has lapsed): keep waiting. Returning `Removed` there let
///   a deploy pass its gate before its fleet had even started.
pub async fn fleet_gone(procs: &ProcMap, key: &str) -> FleetFate {
    loop {
        {
            let mut map = procs.lock().await;
            let Some(entry) = map.get_mut(key) else {
                return FleetFate::Removed;
            };
            match entry.child.as_mut() {
                None => match entry.state {
                    // Nobody is trying to serve this fleet.
                    FleetState::Absent | FleetState::Stopped | FleetState::Asleep { .. } => {
                        return FleetFate::Removed;
                    }
                    // It died and is backing off: the deploy fails its gate.
                    // A wake carries the hold (`Waking { until }`), and an
                    // unexpired one there is the same answer — waiting on it
                    // would sit the deploy out until its own timeout.
                    FleetState::CrashHeld { until, .. } | FleetState::OomHeld { until, .. } => {
                        return FleetFate::Exited(hold_reason(until, Instant::now()));
                    }
                    FleetState::Waking {
                        until: Some(until), ..
                    } if until > Instant::now() => {
                        return FleetFate::Exited(hold_reason(until, Instant::now()));
                    }
                    // A spawn or a probe is in flight: wait for its answer.
                    _ => {}
                },
                Some(child) => match child.try_wait() {
                    Ok(None) => {}
                    Ok(Some(status)) => return FleetFate::Exited(status.to_string()),
                    Err(e) => return FleetFate::Exited(format!("{e}")),
                },
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
    /// A cold start that never answered its health gate, stopped because the
    /// wake that started it failed. It still gets SIGTERM — celld releases its
    /// leases and seals its log on the way out, and a SIGKILL would leave the
    /// next wake waiting out the lease TTL — but the budget is short enough to
    /// stay inside Caddy's wake response margin (`wake_timeout_s` + 15 s),
    /// which `NORMAL`'s 15 s drain plus 5 s kill would spend on its own.
    pub const FAILED_WAKE: Self = Self {
        kill: Duration::from_secs(3),
        term: Duration::from_secs(5),
        kill_first: false,
    };
}

/// Stop one tenant fleet. The docs are explicit: celld shuts down gracefully
/// on SIGTERM/SIGINT (cancel work, prove durability, release leases, seal
/// the node log). SIGKILL only as a bounded fallback — delivered to the whole
/// process group, so an orphaned worker can never keep the fleet's port into
/// the next spawn.
pub async fn stop_fleet(procs: &ProcMap, slug: &str, grace: StopGrace) {
    // A deliberate stop (or delete) starts the fleet with a clean chain if
    // it is started again: the entry — and with it the crash/OOM chain — goes
    // away, and the resting state is `Absent`.
    let (child, epoch) = {
        let mut map = procs.lock().await;
        match map.remove(slug) {
            Some(mut entry) => {
                entry.state = entry.state.on(FleetEvent::Stopped);
                debug_assert_eq!(entry.state, FleetState::Stopped);
                (entry.child.take(), entry.epoch)
            }
            // No entry: no claim ever owned this key, so the cleanup below
            // runs on nobody's behalf (an epoch-0 park/wake ghost can match,
            // and it holds no child or scaffolding of its own, so cleaning is
            // what the stop wants).
            None => (None, 0),
        }
    };
    let Some(child) = child else {
        // No process — but a proxy may still be served (a spawn that never
        // completed, a crash the tick hasn't reaped), and the fleet's cgroup
        // leaf and OOM baseline outlive the entry: both are cleaned here too,
        // otherwise a held or parked fleet that is deleted leaves its leaf
        // (and, once its pid is recycled, its baseline) behind. The entry is
        // gone (or was stopped), so `cleanup_scaffolding` owns the key.
        cleanup_scaffolding(procs, slug, epoch, SideEffects::Stop).await;
        return;
    };
    stop_child(procs, slug, child, grace, epoch).await;
}

/// Park `key`: under the map lock, move the fleet to `Asleep` and hand back
/// its child (with the park's epoch, for the stop) so the caller can stop it. Taking the child here is what makes
/// `Asleep` with a live child unrepresentable: the only way a child leaves an
/// entry is through this call or a stop, and both stop it.
pub async fn park(procs: &ProcMap, key: &str) -> Option<(Child, u64)> {
    // The park starts a new generation: bumping the epoch is what makes a
    // spawn that is still in flight (pre-adoption) unable to adopt its child
    // or record its exit into the parked entry — the pre-adoption `Gone` used
    // to turn `Asleep` into `CrashHeld` for a fleet nobody was spawning.
    let (child, epoch) = {
        let mut map = procs.lock().await;
        let entry = map
            .entry(key.to_string())
            .or_insert_with(|| FleetEntry::new(None, FleetState::Absent));
        entry.epoch = next_epoch();
        entry.state = entry.state.on(FleetEvent::Parked);
        (entry.take_child(), entry.epoch)
    };
    if child.is_none() {
        // A park with no child still owns the fleet's scaffolding (a spawn
        // that never completed leaves a proxy and a leaf behind). The park
        // just took the key, so a spawn that is *still* running under the
        // previous epoch cleans whatever it creates after this point itself
        // (its adoption is refused, and `cleanup_scaffolding` sees a
        // non-live owner and lets it). A park is deliberate, so the OOM chain
        // goes with the fleet.
        cleanup_scaffolding(procs, key, epoch, SideEffects::Stop).await;
    }
    child.map(|child| (child, epoch))
}

/// Stop one child that is no longer supervised: SIGTERM, a bounded wait, then
/// SIGKILL of its whole group, followed by the fleet's key-scoped cleanup.
/// `stop_fleet` and `park` both end here, so a child can never be left running
/// by either.
pub async fn stop_child(
    procs: &ProcMap,
    slug: &str,
    mut child: Child,
    grace: StopGrace,
    epoch: u64,
) {
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
    // Only the generation that took this child down owns the key-scoped
    // cleanup: a spawn that started during the drain must keep its leaf,
    // baseline and proxy.
    cleanup_scaffolding(procs, slug, epoch, SideEffects::Stop).await;
    tracing::info!(slug, "stopped celld");
}

/// Why the key-scoped scaffolding is being released: a deliberate stop or
/// delete, or a generation that ended on its own (a crash, an OOM kill, a
/// failed spawn).
///
/// The difference is the OOM monitor's memory. `cgroups::OomState` keeps the
/// chain length and the last tenant event across respawns (`Reported` is what
/// the next spawn inherits), and only a deliberate stop is allowed to forget
/// it — forgetting on every exit made each OOM restart emit a fresh
/// tenant-visible "fleet restarted" event instead of one per window, and reset
/// the backoff to its base.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SideEffects {
    /// A deliberate stop or delete: nothing will respawn this fleet by itself,
    /// so its OOM chain and event window go too.
    Stop,
    /// A generation ended on its own and the respawn is coming: keep the OOM
    /// chain and its event window.
    Exit,
}

/// The per-fleet cleanup every release does whether or not a child was found:
/// drop the cgroup leaf (logging its high-water RSS first — the leaf vanishes
/// with it, so a later read could never recover the number), and, for a
/// deliberate stop, the OOM baseline and chain. A fleet leaves its leaf behind
/// only when a member outlived the kill: an empty group removes, a live one is
/// reused by the next spawn, which rewrites the limits. Best-effort either
/// way.
fn fleet_side_effects(slug: &str, why: SideEffects) {
    if let Some(dir) = crate::host::cgroups::fleet_cgroup_path(slug) {
        if let Some(peak_bytes) = crate::host::cgroups::remove_fleet_cgroup(&dir) {
            tracing::info!(fleet = slug, peak_bytes, "fleet memory peak at release");
        }
    }
    if why == SideEffects::Stop {
        crate::host::cgroups::forget_spawned(slug);
    }
}

/// Tear down `key`'s key-scoped scaffolding (cgroup leaf, OOM baseline, pid
/// registration and engine proxy) on behalf of generation `epoch`.
///
/// The rule is the same everywhere, because these pieces are keyed by the
/// fleet and cannot carry an epoch themselves: **whoever holds the key when the
/// scaffolding has no live owner cleans it.** That is generation `epoch`
/// itself, or nobody (a stop or delete removed the entry), or a non-live
/// owner — a park or stop that ran before this spawn created anything, whose
/// own cleanup could not see what did not exist yet. A *newer live* generation
/// owns its own scaffolding and is left alone (a same-key takeover is only
/// possible past the claim's TTL).
///
/// The decision and the synchronous parts run under one map lock, so a
/// concurrent claim cannot slip between the check and the act; the engine
/// proxy close is async and re-checks the same rule immediately before it
/// runs. `why` decides whether the OOM monitor's chain and event window are
/// forgotten too — only a deliberate stop may ([`SideEffects`]). Returns
/// whether it cleaned up.
pub(crate) async fn cleanup_scaffolding(
    procs: &ProcMap,
    key: &str,
    epoch: u64,
    why: SideEffects,
) -> bool {
    {
        let map = procs.lock().await;
        let owned = match map.get(key) {
            None => true,
            Some(entry) => entry.epoch == epoch || !entry.state.is_live(),
        };
        if !owned {
            return false;
        }
        // Synchronous, and cheap: a few syscalls and a hashmap removal. Held
        // under the lock so the check above cannot go stale.
        crate::host::sandbox::registry::unregister_fleet(key);
        fleet_side_effects(key, why);
    }
    // The engine close aborts the fleet's proxy loop (and its containers),
    // which is async: re-check that no newer live generation took the key in
    // the meantime — a fresh spawn re-serves its own socket, and closing that
    // would break the fleet it just started.
    let still_ours = match procs.lock().await.get(key) {
        None => true,
        Some(entry) => entry.epoch == epoch || !entry.state.is_live(),
    };
    if still_ours {
        crate::host::sandbox::engine::close_fleet(key).await;
    }
    true
}

/// Stop every running fleet whose app — or whose environment — no longer
/// exists. A delete stops its fleet before purging, but a reconcile tick (or a
/// wake) that read the row before the delete can start it again, and once the
/// row is gone nothing else manages that process: it keeps the fleet's port,
/// so the next fleet given that port crash-loops on "Address already in use".
/// Each candidate is re-read before it is stopped, so an app created or
/// renamed since the caller listed apps keeps its fleet. A sick database reads
/// as "still wanted": never kill live fleets on a failed lookup. Only fleets
/// with a live child are candidates: a parked or crash-held entry holds no
/// process, and re-reading its row every tick for every parked app was pure
/// database load.
pub async fn stop_orphan_fleets(pool: &SqlitePool, procs: &ProcMap) {
    let running = live_keys(procs).await;
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
    /// `RUNNER_FLEET_MEMORY_MB`): the cgroup's `memory.max`, which the shed
    /// threshold measures too once `CELLD_MEMORY_SCOPE=self` points celld
    /// at the fleet's own leaf.
    memory_mb: u32,
}

/// Effective fleet memory cap: the app's `app_limit.memory_mb` override, or
/// the platform default. A corrupt row value cannot happen — `limits.set`
/// refuses it — so a defensive fallback keeps the type. In `multi` the
/// override is clamped to the operator ceiling, so rows stored before a
/// ceiling change cannot exceed it.
pub(crate) async fn fleet_memory_mb(pool: &SqlitePool, cfg: &Config, app_id: &str) -> u32 {
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
fn collect_possible_oom(key: &str, memory_mb: u32) -> Option<crate::host::cgroups::OomNote> {
    let dir = crate::host::cgroups::fleet_cgroup_path(key)?;
    if !dir.is_dir() {
        return None;
    }
    match crate::host::cgroups::oom_kills_since_spawn(key, &dir) {
        Some(kills) if kills > 0 => {}
        _ => return None,
    }
    crate::host::cgroups::oom_note_kill(key, memory_mb, std::time::Instant::now())
}

/// Observe `key`'s child under the map lock: when it has exited, take the OOM
/// verdict and transition [`FleetEvent::Exited`], so the crash/OOM hold
/// applies. `None` means the child is still running (or there is none) — the
/// caller decides what that means for its own flow.
///
/// This is what a failed wake uses: a cold start that died must leave its
/// hold behind, or the parked app spawns again on the very next request.
pub async fn note_exit(procs: &ProcMap, key: &str, memory_mb: u32) -> Option<FleetState> {
    let mut map = procs.lock().await;
    let entry = map.get_mut(key)?;
    let exited = match entry.child.as_mut() {
        None => return None,
        Some(child) => match child.try_wait() {
            Ok(None) => return None,
            Ok(Some(status)) => status.to_string(),
            Err(e) => e.to_string(),
        },
    };
    let oom = collect_possible_oom(key, memory_mb);
    tracing::warn!(fleet = %key, status = %exited, "celld exited");
    entry.child = None;
    entry.state = entry.state.on(FleetEvent::Exited {
        oom: oom.is_some(),
        at: Instant::now(),
    });
    Some(entry.state)
}

/// A fleet that exited before it was ever adopted (spawn → dead before its
/// cgroup move, or before the map insert): record the spawn and its exit in
/// one step, so the crash/OOM hold applies exactly as it would for a fleet
/// that ran for a while.
pub(crate) async fn note_spawn_exit(procs: &ProcMap, key: &str, memory_mb: u32, epoch: u64) {
    let oom = collect_possible_oom(key, memory_mb);
    let mut map = procs.lock().await;
    // Only the spawn that still owns the epoch records its exit: `or_insert`
    // here used to resurrect an entry for a fleet a stop or delete had just
    // removed, leaving a held ghost nobody supervises.
    let Some(entry) = map.get_mut(key) else {
        return;
    };
    if entry.epoch != epoch {
        return;
    }
    let now = Instant::now();
    entry.state = entry.state.on(FleetEvent::Exited {
        oom: oom.is_some(),
        at: now,
    });
}

/// Release a spawn claim whose spawn produced no child, so the next tick can
/// try again instead of waiting out the claim's TTL.
async fn spawn_failed(procs: &ProcMap, key: &str, epoch: u64) {
    let mut map = procs.lock().await;
    let Some(entry) = map.get_mut(key) else {
        return;
    };
    if entry.epoch != epoch || entry.child.is_some() {
        return;
    }
    entry.state = entry.state.on(FleetEvent::SpawnFailed);
}

/// Fill every app's [`crate::models::App::fleet_hold`] from the supervisor's
/// state, in one pass under the map lock: the one thing about a fleet the row
/// cannot carry, and the reason a crash-looping app no longer has to look
/// `running` in the UI. A fleet that is not in a crash/OOM hold — healthy,
/// spawning, parked, stopped — has no hold to report.
pub async fn annotate_holds(procs: &ProcMap, apps: &mut [App]) {
    let map = procs.lock().await;
    for app in apps.iter_mut() {
        app.fleet_hold = map.get(&app.slug).and_then(|entry| match entry.state {
            FleetState::CrashHeld { until, .. } => Some(hold_info(FleetHold::Crash, until)),
            FleetState::OomHeld { until, .. } => Some(hold_info(FleetHold::Oom, until)),
            _ => None,
        });
    }
}

/// The API shape of one hold: the reason plus the wall-clock instant the next
/// spawn is due (the state keeps a monotonic `Instant`).
fn hold_info(hold: FleetHold, until: Instant) -> FleetHoldInfo {
    let wait = until.saturating_duration_since(Instant::now());
    FleetHoldInfo {
        hold,
        retry_at: (chrono::Utc::now() + chrono::Duration::from_std(wait).unwrap_or_default())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}

/// When `key`'s next spawn is held back (a crash or OOM backoff), the instant
/// it lifts. Callers that would otherwise spawn on demand — a wake — fail fast
/// on it instead of spawning once per request.
pub async fn hold_until(procs: &ProcMap, key: &str) -> Option<Instant> {
    procs
        .lock()
        .await
        .get(key)
        .and_then(|entry| entry.state.hold_until())
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

/// A generation's fleet process is gone — it exited, its spawn failed, it
/// never got a leaf, or it died before adoption: drop its pid registration
/// and close its engine proxy (which removes its containers from the engine).
///
/// It goes through [`cleanup_scaffolding`] because the fleet may no longer be
/// this generation's: a stop can remove the entry and a fresh claim can take
/// the key while a spawn is still on its way out (the claim serialises spawns,
/// it does not cancel them). Cleaning by key alone there unregisters the new
/// fleet's pid and closes its proxy — its containers and every Sandbox call it
/// makes die under it. `epoch` is the generation this caller speaks for.
/// Idempotent: safe for a fleet that never served.
async fn fleet_gone_cleanup(procs: &ProcMap, key: &str, epoch: u64) {
    cleanup_scaffolding(procs, key, epoch, SideEffects::Exit).await;
}

/// Serve one fleet its engine proxy socket before spawn. `None` (with a
/// warning) when the socket cannot be served: the fleet then spawns without
/// an engine rather than not at all.
fn fleet_engine_socket(key: &str) -> Option<std::path::PathBuf> {
    match crate::host::sandbox::engine::serve_fleet(key) {
        Ok(socket) => Some(socket),
        Err(e) => {
            tracing::warn!(fleet = %key, error = %e, "fleet engine socket unavailable; no engine for this fleet");
            None
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
    let now = Instant::now();
    // One critical section decides everything the map can answer: expiry of a
    // crash/OOM hold, whether the child is still running, and — when it exited
    // — what that exit means. The OOM verdict is read while the baseline still
    // exists, so a same-key respawn cannot slip between consume and removal.
    let due = {
        let mut map = procs.lock().await;
        let entry = map
            .entry(key.clone())
            .or_insert_with(|| FleetEntry::new(None, FleetState::Absent));
        // A passed hold becomes `Absent` here (the timer lives in the state,
        // not in a separate gate map).
        entry.state = entry.state.on(FleetEvent::Tick { at: now });
        let exited = match entry.child.as_mut() {
            None => None,
            Some(child) => match child.try_wait() {
                Ok(None) => return Ok(()), // still running
                Ok(Some(status)) => Some(status.to_string()),
                Err(e) => Some(e.to_string()),
            },
        };
        match exited {
            // No child: the state alone says whether a spawn is due. A
            // spawn claim in flight (another caller's) or an unexpired hold
            // waits; otherwise this caller claims the spawn — bumping the
            // epoch and moving to `Spawning` under this same lock, so no two
            // callers can spawn one fleet.
            None => {
                if !spawn_due(entry.state, now) {
                    Due::Wait
                } else {
                    if matches!(entry.state, FleetState::Spawning { .. }) {
                        tracing::warn!(fleet = %key, "spawn claim expired; taking it over");
                    }
                    claim(entry, now)
                }
            }
            Some(why) => {
                let note = collect_possible_oom(&key, spec.memory_mb);
                tracing::warn!(fleet = %key, status = %why, "celld exited; restarting");
                entry.child = None;
                entry.state = entry.state.on(FleetEvent::Exited {
                    oom: note.is_some(),
                    at: now,
                });
                Due::Exited {
                    oom: note,
                    epoch: entry.epoch,
                }
            }
        }
    };
    match due {
        Due::Wait => Ok(()),
        Due::Spawn(epoch) => spawn_fleet(pool, cfg, procs, logs, spec, epoch).await,
        Due::Exited { oom, epoch } => {
            // The old process is gone: its proxy — and its containers — go
            // before a respawn serves a new socket, so the new fleet starts
            // with no previous run behind it. Only for the generation that
            // exited: a claim can take the key between that read and here.
            fleet_gone_cleanup(procs, &key, epoch).await;
            if let Some(note) = oom {
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
            // The exit always took a hold (crash or OOM backoff): the next tick
            // that finds it passed spawns from the held state, so the chain
            // (`crashes`) survives into `Spawning`.
            Ok(())
        }
    }
}

/// Whether a caller may claim a spawn now that the fleet has no child: an
/// unexpired crash/OOM hold (in the held state itself, or carried by a wake
/// into `Waking`) and another caller's live spawn claim both wait. Every other
/// state — `Absent`, `Stopped`, `Asleep` past its hold, and a `Waking` fleet
/// whose cold start nobody has claimed yet — is spawnable.
fn spawn_due(state: FleetState, now: Instant) -> bool {
    match state {
        FleetState::Spawning { since, .. } => {
            now.saturating_duration_since(since) >= SPAWN_CLAIM_TTL
        }
        FleetState::CrashHeld { until, .. } | FleetState::OomHeld { until, .. } => now >= until,
        FleetState::Asleep { until } | FleetState::Waking { until, .. } => {
            until.is_none_or(|until| now >= until)
        }
        _ => true,
    }
}

/// Claim the right to spawn `key` for the caller: bump the epoch (the spawn's
/// identity) and move the fleet to `Spawning`, which is what makes a second
/// `ensure_fleet` for the same fleet wait instead of spawning a second child.
fn claim(entry: &mut FleetEntry, now: Instant) -> Due {
    entry.epoch = next_epoch();
    entry.state = entry.state.on(FleetEvent::Spawned { at: now });
    Due::Spawn(entry.epoch)
}

/// What an [`ensure_spawned`] pass found under the proc-map lock.
enum Due {
    /// A live child, an unexpired hold, or a spawn another caller claimed:
    /// nothing spawns this pass.
    Wait,
    /// No child, no hold, no claim: this caller owns epoch `u64` and spawns.
    Spawn(u64),
    /// The child exited on its own and the state now holds the respawn.
    Exited {
        oom: Option<crate::host::cgroups::OomNote>,
        /// The generation whose child exited: the cleanup that follows is its
        /// to do, and a newer claim in the meantime owns the key.
        epoch: u64,
    },
}

/// Spawn one celld for an [`FleetState::Absent`] fleet and record
/// [`FleetEvent::Spawned`]. Split from [`ensure_spawned`] so the decision half
/// stays readable: the caller has already established that no child runs and no
/// hold is pending.
async fn spawn_fleet(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    spec: FleetSpec,
    epoch: u64,
) -> anyhow::Result<()> {
    let key = spec.key.clone();
    let result = spawn_fleet_inner(pool, cfg, procs, logs, spec, epoch).await;
    if result.is_err() {
        // The claim is ours and nothing ran: release it, or the next pass
        // waits out the claim's TTL before retrying.
        spawn_failed(procs, &key, epoch).await;
    }
    result
}

/// The body of [`spawn_fleet`]: everything between "a claim exists" and "the
/// child is adopted". Errors here release the claim through the wrapper.
async fn spawn_fleet_inner(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    spec: FleetSpec,
    epoch: u64,
) -> anyhow::Result<()> {
    let key = spec.key.clone();

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
    // The fleet's operator token, minted once per scope and stable across
    // restarts (SPEC, Tenant isolation): the node requires it as a Bearer
    // token on every internal route, and the runner sends it back on its
    // own internal calls. Tenant settings cannot override it — `CELLD_*`
    // never reaches `spec.env` (`db::env_reserved`) — and Worker code
    // cannot read the process env (celld builds the Worker env from
    // declared vars only).
    let operator_token = credentials::operator_token(
        pool,
        &cfg.runner_token,
        &spec.scope.key(),
        spec.scope.app_id(),
    )
    .await?;
    // Advertise on loopback: a tenant fleet is a single node, a child of the
    // runner in its own network namespace, and the runner already reaches it
    // at 127.0.0.1:{internal} (reload_fleet). A hostname advertise
    // (fleet-{slug}) doesn't resolve inside the container, which breaks celld
    // node discovery (d1/diagnose read the lease and dial `addr`). The
    // internal listener binds loopback too: it carries celld's operator API,
    // token-guarded (SPEC, Tenant isolation) and closed to tenant code by
    // the Worker egress policy on top.
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
    ]);
    // Per-fleet containment (SPEC, Tenant isolation): while cgroups are
    // active the fleet gets its own group with the effective memory cap; the
    // kernel OOM-kills overgrowth inside that group (contained, and the
    // supervisor restarts the fleet) instead of every fleet shedding.
    let fleet_cgroup = match crate::host::cgroups::anchor() {
        None => {
            // `multi` promises every tenant fleet its own cgroup leaf. Without
            // an anchor this spawn can only run it in the shared group, so it
            // fails closed rather than silently running uncapped: boot's
            // isolation check already reports the missing anchor (`/ready`
            // 503), and this is the spawn that must not happen anyway.
            if cfg.tenancy == crate::config::Tenancy::Multi {
                fleet_gone_cleanup(procs, &key, epoch).await;
                return Err(anyhow::anyhow!(
                    "multi tenancy requires per-fleet cgroups, but the runner has no cgroup anchor (see /ready isolation); refusing to spawn {key} uncapped"
                ));
            }
            None
        }
        Some(anchor) => {
            match crate::host::cgroups::ensure_fleet_cgroup(
                &anchor,
                &key,
                u64::from(spec.memory_mb),
            ) {
                Ok(dir) => Some(dir),
                Err(e) => {
                    // `ensure_fleet_cgroup` already tripped containment
                    // (`note_limit_failed`). In `multi` a fleet without its
                    // own leaf would run uncapped, so the spawn fails closed
                    // instead — the same rule as a refused `cgroup.procs`
                    // move. `single` is one operator's own box: warn and run
                    // in the shared group, as before.
                    if cfg.tenancy == crate::config::Tenancy::Multi {
                        fleet_gone_cleanup(procs, &key, epoch).await;
                        return Err(anyhow::anyhow!(
                            "fleet {key} could not get its cgroup leaf in multi: {e:#}"
                        ));
                    }
                    tracing::warn!(fleet = %key, error = %e, "fleet cgroup unavailable; shared cgroup");
                    None
                }
            }
        }
    };
    {
        use std::os::unix::process::CommandExt;
        // Its own process group (like `run_sandboxed`): the stops below kill
        // the whole tree, so an orphaned worker can never keep the fleet's
        // port into the next spawn.
        cmd.as_std_mut().process_group(0);
        // The fleet reaches the engine only through its own proxy socket
        // (DOCKER_HOST below): it joins no engine group. The demotion still
        // sets the group list explicitly — a bare uid()/gid() would keep
        // the runner's own supplementary groups, and one of those reaching
        // the host socket would bypass the proxy entirely.
        // The whole demotion happens in the hook: std runs pre_exec after
        // it applies uid()/gid(), so a hook that only set groups would run
        // unprivileged and fail every spawn. With no builder ids set,
        // nothing drops privileges before the hook runs.
        // SAFETY: pre_exec runs between fork and exec; only
        // async-signal-safe libc calls, no allocation (failures surface as
        // raw errnos through the spawn errno pipe).
        match (cfg.fleet_uid, cfg.fleet_gid) {
            (Some(uid), Some(gid)) => unsafe {
                cmd.as_std_mut().pre_exec(move || {
                    if libc::geteuid() != 0 {
                        return Err(std::io::Error::from_raw_os_error(libc::EPERM));
                    }
                    let groups = [gid as libc::gid_t];
                    let mut ret = libc::setgroups(groups.len(), groups.as_ptr());
                    if ret == 0 {
                        ret = libc::setgid(gid as libc::gid_t);
                    }
                    if ret == 0 {
                        ret = libc::setuid(uid as libc::uid_t);
                    }
                    if ret != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            },
            (Some(uid), None) => {
                cmd.as_std_mut().uid(uid);
            }
            (None, Some(gid)) => {
                cmd.as_std_mut().gid(gid);
            }
            (None, None) => {}
        }
    }
    // With sandboxing on the fleet gets its own proxy socket, otherwise no
    // engine at all. celld's operator knobs for containers stay unsupported:
    // a runtime or resolver makes celld send `Runtime`/`Binds`, which the
    // engine proxy refuses (they would hand a fleet host paths or a weaker
    // runtime), so a value would only break every Sandbox start.
    let engine_socket = if cfg.sandbox_disabled {
        None
    } else {
        fleet_engine_socket(&key)
    };
    let engine_socket = engine_socket
        .as_ref()
        .map(|socket| socket.to_string_lossy().into_owned());
    // Explicit environment only (`host::fleet_env`): the spawn inherits
    // nothing — no `RUNNER_TOKEN`, no operator-global `CELLD_*`, no ambient
    // credential chain — and tenant settings cannot override a platform
    // knob, since the builder applies them first. This `apply` call is
    // load-bearing (nothing here fails if it is dropped): the builder and
    // the spawn-path tests in `host::fleet_env` pin what it applies.
    let inherited = crate::host::fleet_env::runner_inherited();
    let fleet_env =
        crate::host::fleet_env::tenant_fleet_env(&crate::host::fleet_env::TenantFleetEnv {
            cfg,
            state_dir: &state_dir,
            access_key: &access,
            secret_key: &secret_key,
            operator_token: &operator_token,
            tenant_env: &spec.env,
            has_cgroup_leaf: fleet_cgroup.is_some(),
            engine_socket: engine_socket.as_deref(),
            inherited: &inherited,
        });
    crate::host::fleet_env::apply(&mut cmd, &fleet_env);
    let mut child = match cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            // Served a socket for a fleet that never started: close it
            // rather than leak the loop (the next tick re-serves) — unless a
            // stop and a fresh claim took the key while this spawn failed, in
            // which case the socket is the new generation's.
            fleet_gone_cleanup(procs, &key, epoch).await;
            return Err(e.into());
        }
    };
    // The engine proxy admits only this pid on the fleet's socket.
    if let Some(pid) = child.id() {
        crate::host::sandbox::registry::register_fleet(&key, pid);
    }
    // Move the fleet into its group at once: between spawn and this write a
    // sliver of startup memory is charged to the shared cgroup instead —
    // negligible next to the fleet's lifetime, and documented, not hidden.
    if let Some(dir) = &fleet_cgroup {
        match move_fleet_into_group(&key, dir, &mut child).await {
            MoveOutcome::Moved => {}
            // Exited first: nothing runs uncapped. That is still an exit —
            // the crash/OOM hold has to apply, or a fleet that dies during
            // startup respawns on the next tick forever.
            MoveOutcome::Gone => {
                note_spawn_exit(procs, &key, spec.memory_mb, epoch).await;
                fleet_gone_cleanup(procs, &key, epoch).await;
                return Ok(());
            }
            // Refused for a live pid: tripped, killed, and the spawn aborts
            // rather than running uncapped.
            MoveOutcome::Refused => {
                cleanup_scaffolding(procs, &key, epoch, SideEffects::Exit).await;
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

    // Adopt the child only if the fleet is still wanted. A stop or a park that
    // ran while this spawn was in flight removed or parked the entry, and
    // resurrecting a child then would leave a fleet nobody supervises — the
    // state machine's "a stop wins" rule has to hold across the spawn too.
    let mut child = Some(child);
    let adopted = {
        let mut map = procs.lock().await;
        match map.get_mut(&key) {
            // No entry at all: a stop or delete ran while this spawn was in
            // flight and nobody supervises this fleet any more.
            None => false,
            // The claim is what serializes spawns per fleet, so a refusal here
            // means a stop or a park took the fleet (or a TTL-expired claim
            // was taken over): this child is not wanted, and the key-scoped
            // cleanup below cannot step on a concurrent spawn of the same
            // fleet.
            Some(entry) => entry.adopt(&mut child, epoch),
        }
    };
    if !adopted {
        // Kill the child this spawn created, as a group, and reap it here.
        // `stop_fleet(key)` would be wrong: the map entry belongs to whoever
        // stopped or parked the fleet, and stopping the key would kill *their*
        // child. The cgroup leaf and OOM baseline for this spawn go too, so
        // the next spawn starts clean.
        tracing::info!(fleet = %key, "fleet was stopped or parked while it was spawning; killing the child it no longer wants");
        if let Some(child) = child.as_mut() {
            if let Some(pid) = child.id() {
                sigkill_tree(pid);
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        cleanup_scaffolding(procs, &key, epoch, SideEffects::Exit).await;
        return Ok(());
    }
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
        for (slug, mut entry) in map.drain() {
            entry.state = entry.state.on(FleetEvent::Stopped);
            if let Some(child) = entry.child.take() {
                let pid = child.id();
                children.push((slug, child, pid));
            }
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
    let slugs: Vec<String> = children.iter().map(|(slug, _, _)| slug.clone()).collect();
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
    for slug in &slugs {
        // The map is drained above, so no claim holds the key: epoch 0 stands
        // for "nobody", and an epoch-0 park/wake ghost that raced the drain
        // owns no child or scaffolding either, so cleaning is what shutdown
        // wants. Shutdown is a stop: nothing respawns behind it.
        cleanup_scaffolding(procs, slug, 0, SideEffects::Stop).await;
    }
}

/// What celld's `POST /reload` concluded (celld 0.6.3 `internal_reload`):
/// `{ok, outcome, ...}` with `outcome` one of `adopted`, `unchanged`,
/// `failed` (422, with `error`), or `unavailable` (503, no pointer yet).
/// Anything else — a transport error, an unparsable body — is
/// [`ReloadOutcome::Unreachable`]: the deploy keeps its current handling
/// (a warning; the health gate below decides), because the reload races a
/// cold boot and the old generation still serves either way. Only an
/// explicit failed adoption fails the deploy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReloadOutcome {
    Adopted,
    Unchanged,
    Failed { error: String },
    Unreachable,
}

impl ReloadOutcome {
    /// Fail the deploy when celld refused the new generation, with celld's
    /// own error; anything else (adopted, unchanged, unreachable) proceeds
    /// to the health gate.
    pub fn fail_deploy_on_failed(self, fleet: &str) -> anyhow::Result<()> {
        match self {
            ReloadOutcome::Failed { error } => {
                anyhow::bail!(
                    "celld refused the new deployment for {}: {}",
                    fleet,
                    sanitize_reload_error(&error)
                )
            }
            _ => Ok(()),
        }
    }
}

/// Celld's reload error, safe for the deploy log and `last_error`: the text
/// can carry tenant-shaped input (celld formats an unvalidated
/// `services[].service` target into it), so control characters flatten to
/// spaces and the whole is capped — the same posture as `check_required`
/// quoting required names, minus the quotes, so a genuine multi-line build
/// error stays readable on one line.
fn sanitize_reload_error(error: &str) -> String {
    error
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(RELOAD_ERROR_CAP)
        .collect()
}

/// Longest reload error kept: genuine build errors fit, while a
/// tenant-shaped target cannot bloat the deploy log or `last_error`.
const RELOAD_ERROR_CAP: usize = 2000;

/// Parse one `POST /reload` response body into its outcome. `failed`
/// carries celld's error; `adopted`/`unchanged` succeed; `unavailable` and
/// anything unparsable read as unreachable (warned by the caller).
pub fn parse_reload_response(body: &str) -> ReloadOutcome {
    let outcome = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("outcome")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    match outcome.as_deref() {
        Some("adopted") => ReloadOutcome::Adopted,
        Some("unchanged") => ReloadOutcome::Unchanged,
        Some("failed") => {
            let error = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|error| !error.is_empty())
                .unwrap_or_else(|| "celld reported a failed reload".to_string());
            ReloadOutcome::Failed { error }
        }
        _ => ReloadOutcome::Unreachable,
    }
}

/// POST /reload on the fleet and report what celld concluded. See
/// [`ReloadOutcome`]: only a failed adoption is returned as such — a
/// transport error warns, as before, and reads as unreachable. The fleet's
/// operator token rides as a Bearer token (the node requires it on every
/// internal route); without a cached token the call goes out bare and a
/// 401 reads as unreachable, exactly as a dead fleet does.
pub async fn reload_fleet(app: &App) -> ReloadOutcome {
    let Some(port) = app.internal_port else {
        return ReloadOutcome::Unreachable;
    };
    let scope_key = crate::host::credentials::Scope::app(app).key();
    reload_at(&app.slug, port, &scope_key).await
}

/// POST /reload on an environment fleet, so a preview deploy goes live
/// without waiting for celld's own poll. Same outcome contract as
/// [`reload_fleet`].
pub async fn reload_environment_fleet(env: &crate::models::Environment) -> ReloadOutcome {
    let Some(port) = env.internal_port else {
        return ReloadOutcome::Unreachable;
    };
    let scope_key = crate::host::credentials::Scope::environment(env).key();
    reload_at(&env_fleet_key(&env.app_slug, &env.label), port, &scope_key).await
}

async fn reload_at(fleet: &str, port: i64, scope_key: &str) -> ReloadOutcome {
    let url = format!("http://127.0.0.1:{port}/reload");
    let mut request = reqwest::Client::new().post(&url);
    if let Some(token) = crate::host::credentials::cached_operator_token(scope_key) {
        request = request.bearer_auth(token);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!(fleet = %fleet, error = %e, "reload failed");
            return ReloadOutcome::Unreachable;
        }
    };
    let body = response.text().await.unwrap_or_default();
    let outcome = parse_reload_response(&body);
    if outcome == ReloadOutcome::Unreachable {
        // Truncated: the body is celld's, not ours, and the deploy log
        // below prints only what the deploy does with the outcome.
        let snippet: String = body.chars().take(200).collect();
        tracing::warn!(fleet = %fleet, body = %snippet, "reload outcome unparsable");
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_backoff_doubles_to_the_cap() {
        assert_eq!(crash_backoff(1), Duration::from_secs(5));
        assert_eq!(crash_backoff(2), Duration::from_secs(10));
        assert_eq!(crash_backoff(3), Duration::from_secs(20));
        assert_eq!(crash_backoff(4), Duration::from_secs(40));
        assert_eq!(crash_backoff(5), Duration::from_secs(60));
        assert_eq!(crash_backoff(99), Duration::from_secs(60));
        assert_eq!(
            crash_backoff(0),
            Duration::from_secs(5),
            "never a zero wait"
        );
    }

    /// The whole fleet transition table, without a process: a crash takes a
    /// hold, the hold expires to `Absent`, a healthy run resets the chain, and
    /// every illegal event is a no-op. This is the table the old
    /// `CRASH_GATES` map, the `Confirming` set and the "child is in the map"
    /// check each held a fragment of.
    #[test]
    fn fleet_state_transition_table() {
        use FleetEvent as E;
        use FleetState as S;
        let t0 = Instant::now();
        let at = |secs: u64| t0 + Duration::from_secs(secs);

        // Cold start -> spawning -> probing -> healthy.
        let s = S::Absent.on(E::Spawned { at: t0 });
        let S::Spawning { since, crashes } = s else {
            panic!("a spawn enters Spawning, got {s:?}");
        };
        assert_eq!((since, crashes), (t0, 0));
        let s = s.on(E::ProbeStarted { until: at(10) });
        assert!(matches!(s, S::Probing { .. }), "{s:?}");
        let s = s.on(E::Confirmed);
        assert!(matches!(s, S::Healthy { .. }), "{s:?}");
        assert!(s.is_live());

        // A crash holds the next spawn for the first backoff.
        let s = s.on(E::Exited {
            oom: false,
            at: at(60),
        });
        let S::CrashHeld { crashes, until } = s else {
            panic!("a crash enters CrashHeld, got {s:?}");
        };
        assert_eq!((crashes, until), (1, at(65)), "5 s after the crash");
        assert_eq!(
            s.on(E::Tick { at: at(64) }),
            s,
            "still held one second early"
        );
        // An expired hold keeps the state, and with it the chain: the spawn
        // happens from the held state, so the next crash escalates instead of
        // restarting at five seconds forever.
        assert_eq!(s.on(E::Tick { at: at(65) }), s, "a tick does not reset it");
        assert!(s.hold_until().is_some_and(|until| at(65) >= until));

        // The production path: a tick lands on the held state, then the spawn.
        // The chain must survive both, or every retry restarts at five
        // seconds and a crash loop never backs off.
        let after_tick = s.on(E::Tick { at: at(65) }).on(E::Spawned { at: at(65) });
        assert!(
            matches!(after_tick, S::Spawning { crashes: 1, .. }),
            "a spawn after the hold keeps the chain: {after_tick:?}"
        );

        // Two quick crashes escalate; a crash after the healthy window does
        // not (it starts the chain over at the base wait).
        let quick = S::CrashHeld {
            crashes: 1,
            until: at(5),
        }
        .on(E::Spawned { at: at(5) })
        .on(E::Exited {
            oom: false,
            at: at(6),
        });
        assert!(
            matches!(quick, S::CrashHeld { crashes: 2, until } if until == at(16)),
            "10 s after the second crash: {quick:?}"
        );
        let long_run = S::Healthy {
            since: t0,
            crashes: 4,
        }
        .on(E::Exited {
            oom: false,
            at: at(400),
        });
        assert!(
            matches!(long_run, S::CrashHeld { crashes: 1, until } if until == at(405)),
            "five healthy minutes reset the chain: {long_run:?}"
        );

        // OOM kills hold on their own, longer chain.
        let oom = S::Healthy {
            since: t0,
            crashes: 0,
        }
        .on(E::Exited { oom: true, at: t0 });
        assert!(
            matches!(oom, S::OomHeld { crashes: 1, until } if until == at(5)),
            "{oom:?}"
        );

        // A probe that died is reclaimed by its deadline, so the fleet can be
        // confirmed again.
        let stale = S::Probing {
            since: t0,
            crashes: 0,
            until: at(3),
        }
        .on(E::Tick { at: at(3) });
        assert!(
            matches!(stale, S::Spawning { since, crashes: 0 } if since == t0),
            "{stale:?}"
        );

        // Park/wake round trip, and a failed wake stays parked.
        let parked = S::Healthy {
            since: t0,
            crashes: 0,
        }
        .on(E::Parked);
        assert_eq!(parked, S::Asleep { until: None });
        let waking = parked.on(E::Woke { at: at(1) });
        assert!(matches!(waking, S::Waking { .. }), "{waking:?}");
        assert_eq!(
            waking.on(E::Parked),
            S::Asleep { until: None },
            "a failed wake re-parks"
        );
        assert!(matches!(waking.on(E::Confirmed), S::Healthy { .. }));

        // A park keeps the hold it inherited: the fleet rests Asleep and a
        // wake still fails fast until the backoff expires.
        let held = S::CrashHeld {
            crashes: 2,
            until: at(30),
        };
        let parked_held = held.on(E::Parked);
        assert_eq!(
            parked_held,
            S::Asleep {
                until: Some(at(30))
            }
        );
        assert_eq!(
            parked_held.hold_until(),
            Some(at(30)),
            "the hold survives the park"
        );
        assert!(!spawn_due(parked_held, at(29)), "and still holds the spawn");
        assert!(spawn_due(parked_held, at(30)));
        // A wake carries it: the deploy wake moved the fleet out of `Asleep`
        // so the reconcile loop may spawn the release it is about to land, and
        // that spawn must still wait the backoff out instead of hammering a
        // crash-looping fleet on the next tick.
        let waking_held = parked_held.on(E::Woke { at: at(1) });
        assert_eq!(
            waking_held,
            S::Waking {
                since: at(1),
                crashes: 0,
                until: Some(at(30))
            },
            "the wake keeps the hold"
        );
        assert_eq!(waking_held.hold_until(), Some(at(30)));
        assert!(
            !spawn_due(waking_held, at(29)),
            "nothing spawns through the hold it carried"
        );
        assert!(spawn_due(waking_held, at(30)));
        assert!(matches!(
            waking_held.on(E::Spawned { at: at(30) }),
            S::Spawning { since, crashes: 0 } if since == at(30)
        ));
        // A park that lands inside the carried hold keeps it, like a park of a
        // crash-held fleet: the fleet rests asleep and still backs off.
        assert_eq!(
            waking_held.on(E::Parked),
            S::Asleep {
                until: Some(at(30))
            }
        );
        // A wake from `Absent` (the first one after a runner restart) has no
        // hold to carry.
        assert_eq!(
            S::Absent.on(E::Woke { at: at(2) }),
            S::Waking {
                since: at(2),
                crashes: 0,
                until: None
            }
        );

        // A stop wins over every state, and nothing but a spawn leaves it.
        for state in [
            S::Absent,
            S::Spawning {
                since: t0,
                crashes: 1,
            },
            S::Probing {
                since: t0,
                crashes: 0,
                until: at(9),
            },
            S::Healthy {
                since: t0,
                crashes: 2,
            },
            S::CrashHeld {
                crashes: 1,
                until: at(9),
            },
            S::OomHeld {
                crashes: 1,
                until: at(9),
            },
            S::Asleep { until: None },
            S::Waking {
                since: t0,
                crashes: 0,
                until: None,
            },
        ] {
            assert_eq!(state.on(E::Stopped), S::Stopped, "{state:?}");
            assert_eq!(
                S::Stopped.on(E::Tick { at: at(9999) }),
                S::Stopped,
                "a timer never restarts a stopped fleet"
            );
            assert_eq!(S::Stopped.on(E::Parked), S::Stopped, "{state:?}");
            assert!(matches!(
                S::Stopped.on(E::Spawned { at: t0 }),
                S::Spawning { .. }
            ));
        }

        // Illegal events leave the state alone: a confirm for a parked fleet
        // must never make it healthy (that is the park race).
        assert_eq!(
            S::Asleep { until: None }.on(E::Confirmed),
            S::Asleep { until: None }
        );
        assert_eq!(S::Absent.on(E::Confirmed), S::Absent);
        assert_eq!(
            S::CrashHeld {
                crashes: 1,
                until: at(5)
            }
            .on(E::ProbeStarted { until: at(6) }),
            S::CrashHeld {
                crashes: 1,
                until: at(5)
            }
        );
    }

    /// A fleet that dies before it is adopted (spawn → dead before its cgroup
    /// move, or before the map insert) still takes its crash hold: the silent
    /// drop respawned it on every tick.
    #[tokio::test]
    async fn a_fleet_that_dies_before_adoption_still_takes_its_hold() {
        let procs = new_procs();
        let key = "died-young";
        let epoch = claim_epoch(&procs, key).await;
        note_spawn_exit(&procs, key, 256, epoch).await;
        let state = state_of(&procs, key).await;
        assert!(
            matches!(state, FleetState::CrashHeld { crashes: 1, .. }),
            "the exit took a crash hold: {state:?}"
        );
        assert!(hold_until(&procs, key).await.is_some());
    }

    /// `Asleep`/`Stopped` with a live child is not representable: the only way
    /// into the map is `adopt`, and it refuses a parked or stopped fleet, so a
    /// stop or park that lands during a spawn leaves the child to be killed by
    /// the spawn itself instead of being adopted behind a parked row.
    #[tokio::test]
    async fn a_parked_or_stopped_fleet_never_adopts_a_child() {
        for state in [FleetState::Asleep { until: None }, FleetState::Stopped] {
            let mut entry = FleetEntry::new(None, state);
            let mut child = Some(spawn_sleeper());
            assert!(!entry.adopt(&mut child, 0), "{state:?} refuses a child");
            assert!(child.is_some(), "the refused child is handed back");
            assert!(entry.child().is_none(), "{state:?} holds no child");
        }
        // A fleet that is still wanted takes it.
        let mut entry = FleetEntry::new(None, FleetState::Absent);
        let mut child = Some(spawn_sleeper());
        assert!(entry.adopt(&mut child, 0));
        assert!(entry.child().is_some());
        assert!(child.is_none(), "the child moved into the entry");
        // A child from a spawn that lost its claim (a stale epoch) is refused
        // even by a fleet that is still wanted.
        let mut stale = Some(spawn_sleeper());
        let mut entry = FleetEntry::new(None, FleetState::Absent);
        assert!(!entry.adopt(&mut stale, 7), "a stale epoch is refused");
        assert!(entry.child().is_none());
    }

    /// A stop with no child still clears the fleet's sled: the cgroup leaf and
    /// the OOM baseline outlive the entry, and a stopped fleet must not leave
    /// either behind (the next spawn would inherit a stale baseline).
    #[tokio::test]
    async fn a_childless_stop_clears_the_hold_and_the_entry() {
        let procs = new_procs();
        let key = "childless-stop";
        let epoch = claim_epoch(&procs, key).await;
        note_spawn_exit(&procs, key, 128, epoch).await;
        assert!(hold_until(&procs, key).await.is_some());
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        assert!(!has_process(&procs, key).await, "the entry is gone");
        assert!(
            hold_until(&procs, key).await.is_none(),
            "and so is the crash hold"
        );
    }

    /// A probe is claimed once: the state machine itself is the dedup that the
    /// `Confirming` set used to be, and a probe whose task died is reclaimed by
    /// its deadline instead of wedging the fleet forever.
    #[tokio::test]
    async fn one_probe_per_fleet_and_a_dead_probe_recovers() {
        let procs = new_procs();
        let key = "probe";
        assert!(!probe_started(&procs, key, Duration::from_secs(5)).await);
        note_event(&procs, key, FleetEvent::Spawned { at: Instant::now() }).await;
        assert!(probe_started(&procs, key, Duration::from_secs(5)).await);
        assert!(
            !probe_started(&procs, key, Duration::from_secs(5)).await,
            "a second confirm must not pile onto the first"
        );
        assert!(confirmed(&procs, key).await);
        assert!(matches!(
            state_of(&procs, key).await,
            FleetState::Healthy { .. }
        ));
        // A probe that never reports is reclaimed by its deadline (the clock
        // is the state's own, so the test needs no sleep): the fleet goes back
        // to Spawning and can be probed again instead of sticking in Probing
        // forever.
        let stale = FleetState::Probing {
            since: Instant::now(),
            crashes: 0,
            until: Instant::now(),
        };
        procs
            .lock()
            .await
            .insert("stale".to_string(), FleetEntry::new(None, stale));
        assert!(
            probe_started(&procs, "stale", Duration::from_secs(5)).await,
            "a probe past its deadline is reclaimed"
        );
    }

    /// Claim a spawn the way `ensure_spawned` does, returning the epoch.
    async fn claim_epoch(procs: &ProcMap, key: &str) -> u64 {
        let mut map = procs.lock().await;
        let entry = map
            .entry(key.to_string())
            .or_insert_with(|| FleetEntry::new(None, FleetState::Absent));
        match claim(entry, Instant::now()) {
            Due::Spawn(epoch) => epoch,
            Due::Wait => panic!("the fleet was not claimable"),
            Due::Exited { .. } => panic!("no child to exit"),
        }
    }

    /// A parked fleet's wake must be able to spawn: `Waking` (like `Asleep`,
    /// `Absent` and `Stopped`) is a state with no child and no claim, so it is
    /// due. Only a `Spawning` claim in flight and an unexpired hold wait.
    /// Getting this wrong made a parked app's wake wait out the claim TTL and
    /// never serve (the e2e sleep test).
    #[test]
    fn a_wake_and_a_park_are_spawnable_but_a_claim_and_a_hold_are_not() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        for state in [
            FleetState::Absent,
            FleetState::Stopped,
            FleetState::Asleep { until: None },
            FleetState::Waking {
                since: t0,
                crashes: 0,
                until: None,
            },
        ] {
            assert!(spawn_due(state, t0), "{state:?} is spawnable");
        }
        assert!(
            !spawn_due(
                FleetState::Spawning {
                    since: t0,
                    crashes: 0
                },
                at(1)
            ),
            "another caller's claim waits"
        );
        assert!(
            spawn_due(
                FleetState::Spawning {
                    since: t0,
                    crashes: 0
                },
                at(SPAWN_CLAIM_TTL.as_secs())
            ),
            "an expired claim is taken over"
        );
        assert!(
            !spawn_due(
                FleetState::CrashHeld {
                    crashes: 1,
                    until: at(5)
                },
                at(4)
            ),
            "a hold waits"
        );
        assert!(spawn_due(
            FleetState::CrashHeld {
                crashes: 1,
                until: at(5)
            },
            at(5)
        ));
    }

    /// The claim is the spawn's identity: a second `ensure_fleet` for the same
    /// fleet must not spawn a second child, and a spawn whose claim was taken
    /// away (a stale epoch) must not adopt or record anything.
    #[tokio::test]
    async fn one_spawn_claim_per_fleet() {
        let procs = new_procs();
        let key = "claimed";
        let epoch = claim_epoch(&procs, key).await;
        assert!(matches!(
            state_of(&procs, key).await,
            FleetState::Spawning { .. }
        ));
        // A second caller sees the claim and waits instead of spawning.
        {
            let mut map = procs.lock().await;
            let entry = map.get_mut(key).expect("entry");
            assert!(matches!(
                entry.state.on(FleetEvent::Tick { at: Instant::now() }),
                FleetState::Spawning { .. }
            ));
            let mut due = None;
            // The same decision `ensure_spawned` makes: live state, no child.
            if entry.state.is_live() {
                let since = match entry.state {
                    FleetState::Spawning { since, .. } => since,
                    _ => Instant::now(),
                };
                if Instant::now().saturating_duration_since(since) < SPAWN_CLAIM_TTL {
                    due = Some(Due::Wait);
                }
            }
            assert!(matches!(due, Some(Due::Wait)), "the second caller waits");
        }
        // A stale epoch cannot adopt.
        let mut child = Some(spawn_sleeper());
        {
            let mut map = procs.lock().await;
            let entry = map.get_mut(key).expect("entry");
            assert!(!entry.adopt(&mut child, epoch + 1), "stale epoch");
        }
        drop(child);
        // And it cannot record an exit either: the entry keeps its state.
        note_spawn_exit(&procs, key, 64, epoch + 1).await;
        assert_eq!(
            state_of(&procs, key).await,
            FleetState::Spawning {
                since: match state_of(&procs, key).await {
                    FleetState::Spawning { since, .. } => since,
                    other => panic!("unexpected {other:?}"),
                },
                crashes: 0,
            }
        );
    }

    /// Epochs are process-wide and monotonic: a key that is stopped and
    /// respawned must never reuse the number an older, still-in-flight spawn
    /// holds, or that stale spawn would win its claim again.
    #[tokio::test]
    async fn a_new_generation_never_reuses_an_epoch() {
        let procs = new_procs();
        let key = "epochs";
        let first = claim_epoch(&procs, key).await;
        // The stop removes the entry (the resting state is `Absent`), and the
        // next claim starts from a fresh entry.
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        assert!(!has_process(&procs, key).await);
        let second = claim_epoch(&procs, key).await;
        assert!(
            second > first,
            "a new entry must not restart the counter: {second} > {first}"
        );
        // A park starts a generation too, and its number is fresh as well.
        let (_, parked) = park(&procs, key)
            .await
            .map_or((None, 0), |(c, e)| (Some(c), e));
        assert!(
            parked == 0 || parked > second,
            "park epoch {parked} > {second}"
        );
    }

    /// The ownership rule every cleanup shares: our own generation, nobody, and
    /// a non-live owner (a park/stop that could not see what did not exist yet)
    /// may clean; a newer *live* generation owns its own scaffolding.
    #[tokio::test]
    async fn only_a_non_live_owner_lets_a_cleanup_through() {
        let procs = new_procs();
        let key = "owned";
        // Our own generation owns the key.
        let epoch = claim_epoch(&procs, key).await;
        assert!(cleanup_scaffolding(&procs, key, epoch, SideEffects::Stop).await);
        // A park takes the key and leaves it non-live; the stale generation may
        // still clean, which is exactly the park-race case: the park ran its
        // cleanup before this spawn created anything, so the debris is ours.
        park(&procs, key).await;
        assert!(
            cleanup_scaffolding(&procs, key, epoch, SideEffects::Stop).await,
            "a non-live owner lets a stale generation clean its own debris"
        );
        // A newer *live* generation (a claim in flight) owns its scaffolding.
        let fresh = claim_epoch(&procs, key).await;
        assert!(
            !cleanup_scaffolding(&procs, key, epoch, SideEffects::Stop).await,
            "a stale generation never tears down a live one"
        );
        assert!(cleanup_scaffolding(&procs, key, fresh, SideEffects::Stop).await);
        // No entry at all: nobody owns the debris.
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        assert!(cleanup_scaffolding(&procs, key, fresh, SideEffects::Stop).await);
    }

    /// A generation that finds its fleet gone cleans only what it still owns.
    /// A stop removes the entry and the next call claims the key while the
    /// older generation is still on its way out; a by-key cleanup there
    /// unregisters the new fleet's pid and closes its engine proxy — its
    /// containers and every Sandbox call it makes die under it. The crash-exit
    /// reconcile, the fail-closed `multi` spawn, the spawn error and the death
    /// before adoption all learn "this generation is over" that way.
    #[tokio::test]
    async fn a_gone_generation_leaves_a_newer_live_fleet_alone() {
        use crate::host::sandbox::registry;
        let procs = new_procs();
        let key = "gone-vs-newer";
        let stale = claim_epoch(&procs, key).await;
        // A stop removes the entry, and a fresh claim takes the key: that
        // generation is live and owns everything keyed by the fleet.
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        let fresh = claim_epoch(&procs, key).await;
        registry::register_fleet(key, 4242);
        fleet_gone_cleanup(&procs, key, stale).await;
        assert_eq!(
            registry::pid_of_fleet(key),
            Some(4242),
            "the live generation keeps its pid registration"
        );
        // Its own generation still cleans: the exit of a fleet nobody
        // retook drops the registration the way it always did.
        fleet_gone_cleanup(&procs, key, fresh).await;
        assert_eq!(registry::pid_of_fleet(key), None);
    }

    /// A crash or OOM exit keeps the fleet's OOM chain and its event window:
    /// they live in `cgroups`' per-fleet monitor and only a deliberate stop
    /// may forget them. Forgetting on every exit (which routing the exit
    /// paths through the key-scoped cleanup first did) emitted a fresh
    /// tenant-visible "fleet restarted" event on every OOM restart and reset
    /// the backoff to its base.
    #[tokio::test]
    async fn an_oom_exit_keeps_the_event_window_and_the_chain() {
        use crate::host::cgroups;
        let procs = new_procs();
        let key = "oom-window";
        let dir = std::env::temp_dir().join(format!("noite-oom-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let events = |n: u64| {
            std::fs::write(dir.join("memory.events"), format!("oom_kill {n}\n")).expect("events")
        };
        // First OOM exit: this spawn was killed once.
        events(1);
        cgroups::note_spawned(key, &dir);
        events(2);
        assert_eq!(cgroups::oom_kills_since_spawn(key, &dir), Some(1));
        let first = cgroups::oom_note_kill(key, 256, Instant::now()).expect("first kill");
        assert!(first.event_due, "the first kill is the tenant event");
        // The exit cleanup of that generation — the respawn is coming.
        fleet_gone_cleanup(&procs, key, 7).await;
        // The respawn is killed again inside the window.
        cgroups::note_spawned(key, &dir);
        events(3);
        assert_eq!(cgroups::oom_kills_since_spawn(key, &dir), Some(1));
        let second = cgroups::oom_note_kill(key, 256, Instant::now()).expect("second kill");
        assert!(
            !second.event_due,
            "one tenant event per window, not one per restart"
        );
        assert_eq!(
            second.delay,
            Duration::from_secs(10),
            "and the consecutive-kill chain kept growing"
        );
        // A deliberate stop is what forgets it: the next spawn starts clean.
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        cgroups::note_spawned(key, &dir);
        events(4);
        assert_eq!(cgroups::oom_kills_since_spawn(key, &dir), Some(1));
        let fresh = cgroups::oom_note_kill(key, 256, Instant::now()).expect("fresh kill");
        assert!(
            fresh.event_due,
            "a stop clears the chain and its window with it"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A held fleet is visible on the app row without touching its status: the
    /// crash/OOM backoff (what makes a crash-looping app stop reading
    /// `running`) and the instant the next attempt is due. A fleet that is not
    /// held — parked, healthy, spawning, stopped — reports nothing, so the
    /// field cannot be read as "not running yet".
    #[tokio::test]
    async fn a_held_fleet_reports_its_hold() {
        use crate::models::FleetHold as Hold;
        let procs = new_procs();
        let until = Instant::now() + Duration::from_secs(30);
        let mut apps = vec![
            app_row("crash-held"),
            app_row("oom-held"),
            app_row("parked"),
            app_row("healthy"),
            app_row("stopped"),
        ];
        {
            let mut map = procs.lock().await;
            map.insert(
                "crash-held".into(),
                FleetEntry::new(None, FleetState::CrashHeld { crashes: 2, until }),
            );
            map.insert(
                "oom-held".into(),
                FleetEntry::new(None, FleetState::OomHeld { crashes: 3, until }),
            );
            map.insert(
                "parked".into(),
                FleetEntry::new(None, FleetState::Asleep { until: Some(until) }),
            );
            map.insert(
                "healthy".into(),
                FleetEntry::new(
                    None,
                    FleetState::Healthy {
                        since: Instant::now(),
                        crashes: 0,
                    },
                ),
            );
            map.insert("stopped".into(), FleetEntry::new(None, FleetState::Stopped));
        }
        annotate_holds(&procs, &mut apps).await;
        let crash = apps[0]
            .fleet_hold
            .as_ref()
            .expect("the crash hold is served");
        assert_eq!(crash.hold, Hold::Crash);
        let retry = chrono::DateTime::parse_from_rfc3339(&crash.retry_at).expect("RFC 3339");
        let wait = retry
            .signed_duration_since(chrono::Utc::now())
            .num_seconds();
        assert!(
            (25..=31).contains(&wait),
            "retryAt is the hold's deadline, got {wait}s"
        );
        assert_eq!(apps[1].fleet_hold.as_ref().map(|h| h.hold), Some(Hold::Oom));
        for app in &apps[2..] {
            assert!(
                app.fleet_hold.is_none(),
                "{} is not held: {:?}",
                app.slug,
                app.fleet_hold
            );
        }
    }

    /// A bare row for the hold tests: nothing outside `slug` and `status`
    /// matters to `annotate_holds`.
    fn app_row(slug: &str) -> App {
        App {
            id: format!("app-{slug}"),
            slug: slug.into(),
            name: slug.into(),
            user_id: "u".into(),
            status: crate::models::AppStatus::Running,
            subdomain: format!("{slug}.localhost"),
            git_prefix: format!("git/{slug}"),
            fleet_bucket: format!("s3://noite/fleets/{slug}"),
            listen_port: Some(20011),
            internal_port: Some(20012),
            last_deploy_sha: Some("abc".into()),
            last_error: None,
            desired_state: crate::models::DesiredState::Running,
            created_at: "t".into(),
            updated_at: "t".into(),
            asleep_since: None,
            woke_at: None,
            deployed_config: None,
            import_source: None,
            imported: false,
            fleet_hold: None,
        }
    }

    /// A late probe or confirm for a fleet that is gone must not create an
    /// entry: an epoch-0 ghost makes the ownership rule reject the stop's
    /// epoch, so its leaf, proxy and pid registration are never cleaned.
    #[tokio::test]
    async fn a_late_probe_does_not_resurrect_a_fleet_entry() {
        let procs = new_procs();
        let key = "late-probe";
        assert_eq!(
            note_event(&procs, key, FleetEvent::Confirmed).await,
            FleetState::Absent
        );
        assert!(!probe_started(&procs, key, Duration::from_secs(5)).await);
        assert!(!confirmed(&procs, key).await);
        probe_gave_up(&procs, key).await;
        assert!(
            !has_process(&procs, key).await,
            "no entry was created for the late probe"
        );
        // The fleet's scaffolding is still the cleanup's to take.
        assert!(cleanup_scaffolding(&procs, key, 42, SideEffects::Stop).await);
        // The events that *do* mean a fleet exists still create one.
        note_event(&procs, key, FleetEvent::Parked).await;
        assert!(has_process(&procs, key).await);
    }

    /// A deploy waiting on the health gate must not read a held or still
    /// spawning fleet as "removed": that recorded success without the gate (and
    /// skipped migrations). A stop or a park still reads as removed.
    #[tokio::test]
    async fn fleet_gone_distinguishes_held_and_claiming_from_stopped() {
        let procs = new_procs();
        let held = "held";
        let epoch = claim_epoch(&procs, held).await;
        note_spawn_exit(&procs, held, 256, epoch).await;
        assert!(
            matches!(fleet_gone(&procs, held).await, FleetFate::Exited(_)),
            "a crash-held fleet died: the deploy must fail its gate"
        );
        // The same hold carried by a wake (a deploy woke a parked fleet):
        // unexpired, it is the same answer instead of a wait to the deploy's
        // own timeout.
        let woken = "woken-held";
        let epoch = claim_epoch(&procs, woken).await;
        note_spawn_exit(&procs, woken, 256, epoch).await;
        note_event(&procs, woken, FleetEvent::Parked).await;
        note_event(&procs, woken, FleetEvent::Woke { at: Instant::now() }).await;
        assert!(
            matches!(
                state_of(&procs, woken).await,
                FleetState::Waking { until: Some(_), .. }
            ),
            "the wake carried the hold: {:?}",
            state_of(&procs, woken).await
        );
        assert!(
            matches!(fleet_gone(&procs, woken).await, FleetFate::Exited(_)),
            "a held wake fails the gate like a held fleet"
        );
        let parked = "parked";
        note_event(&procs, parked, FleetEvent::Parked).await;
        assert_eq!(fleet_gone(&procs, parked).await, FleetFate::Removed);
        let stopped = "stopped";
        claim_epoch(&procs, stopped).await;
        stop_fleet(&procs, stopped, StopGrace::NORMAL).await;
        assert_eq!(fleet_gone(&procs, stopped).await, FleetFate::Removed);
        // A claim with no child yet keeps the waiter waiting.
        let claiming = "claiming";
        claim_epoch(&procs, claiming).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fleet_gone(&procs, claiming))
                .await
                .is_err(),
            "a spawn in flight is not 'gone'"
        );
    }

    /// A spawn that fails releases its claim: the fleet must be spawnable
    /// again on the next tick, not parked behind a five-minute claim.
    #[tokio::test]
    async fn a_failed_spawn_releases_its_claim() {
        let procs = new_procs();
        let key = "spawn-failed";
        let epoch = claim_epoch(&procs, key).await;
        assert!(matches!(
            state_of(&procs, key).await,
            FleetState::Spawning { .. }
        ));
        spawn_failed(&procs, key, epoch).await;
        assert_eq!(state_of(&procs, key).await, FleetState::Absent);
        // A stale claim's failure does not touch the current one.
        let current = claim_epoch(&procs, key).await;
        spawn_failed(&procs, key, current - 1).await;
        assert!(matches!(
            state_of(&procs, key).await,
            FleetState::Spawning { .. }
        ));
    }

    /// `note_spawn_exit` must not resurrect an entry a stop removed: the fleet
    /// is gone, and a held ghost for it would never be supervised again.
    #[tokio::test]
    async fn a_removed_fleet_takes_no_exit_hold() {
        let procs = new_procs();
        let key = "removed";
        let epoch = claim_epoch(&procs, key).await;
        stop_fleet(&procs, key, StopGrace::NORMAL).await;
        note_spawn_exit(&procs, key, 128, epoch).await;
        assert!(!has_process(&procs, key).await, "no entry comes back");
        assert!(hold_until(&procs, key).await.is_none());
    }

    /// A park takes the child with it: `Asleep` with a live child cannot be
    /// produced, so a park that races an adoption leaves nothing running, and
    /// an adoption that lands after the park is refused.
    #[tokio::test]
    async fn a_park_takes_the_child() {
        let procs = new_procs();
        let key = "park-race";
        procs
            .lock()
            .await
            .insert(key.to_string(), FleetEntry::test_entry(spawn_sleeper()));
        let (child, epoch) = park(&procs, key).await.expect("the child comes back");
        assert_eq!(
            state_of(&procs, key).await,
            FleetState::Asleep { until: None }
        );
        assert!(
            procs
                .lock()
                .await
                .get(key)
                .expect("entry")
                .child()
                .is_none(),
            "the parked entry holds no child"
        );
        // A spawn that was in flight now cannot adopt into the parked entry.
        let mut late = Some(spawn_sleeper());
        {
            let mut map = procs.lock().await;
            assert!(
                !map.get_mut(key).expect("entry").adopt(&mut late, 0),
                "a parked fleet refuses a child"
            );
        }
        drop(late);
        assert!(epoch > 0, "the park starts a new generation");
        stop_child(&procs, key, child, StopGrace::FOR_DELETE, epoch).await;
    }

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
            map.insert("alive".into(), FleetEntry::test_entry(spawn_sleeper()));
            map.insert("deleted".into(), FleetEntry::test_entry(orphan));
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
            map.insert("env".into(), FleetEntry::test_entry(spawn_sleeper()));
            map.insert(
                env_fleet_key("env", "live"),
                FleetEntry::test_entry(spawn_sleeper()),
            );
            map.insert(
                env_fleet_key("env", "gone"),
                FleetEntry::test_entry(spawn_sleeper()),
            );
            map.insert(
                env_fleet_key("env", "never"),
                FleetEntry::test_entry(spawn_sleeper()),
            );
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
        // Unique per test-process run, like the exec group-kill test: a
        // fixed marker lets a sleeper orphaned by an aborted earlier run
        // fail this run until someone kills it by hand. The guard kills
        // this run's marker on every exit path.
        let marker = format!("31338{}", std::process::id());
        let _cleanup = crate::testutil::KillMarkerOnDrop::new(&marker);
        let mut cmd = Command::new("sh");
        let script = format!("sleep {marker} & wait");
        cmd.args(["-c", script.as_str()]);
        cmd.as_std_mut().process_group(0);
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn sleeper tree");
        let procs = new_procs();
        procs
            .lock()
            .await
            .insert("probe".into(), FleetEntry::test_entry(child));

        stop_fleet(&procs, "probe", StopGrace::NORMAL).await;

        assert!(!procs.lock().await.contains_key("probe"));

        assert!(
            crate::testutil::wait_for_cmdline_gone(&marker, Duration::from_secs(5)).await,
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
        procs
            .lock()
            .await
            .insert("killfirst".into(), FleetEntry::test_entry(child));

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
        procs
            .lock()
            .await
            .insert("live".into(), FleetEntry::test_entry(live));
        let still =
            tokio::time::timeout(Duration::from_millis(600), fleet_gone(&procs, "live")).await;
        assert!(still.is_err(), "a live fleet keeps the waiter waiting");

        // The waiter pended while the fleet was live (proven above); stopping
        // now resolves it as Removed, deterministically and with no stagger.
        stop_fleet(&procs, "live", StopGrace::NORMAL).await;
        assert_eq!(fleet_gone(&procs, "live").await, FleetFate::Removed);

        let crashed = Command::new("sh")
            .args(["-c", "exit 3"])
            .spawn()
            .expect("spawn crasher");
        procs
            .lock()
            .await
            .insert("crashed".into(), FleetEntry::test_entry(crashed));
        let FleetFate::Exited(why) = fleet_gone(&procs, "crashed").await else {
            panic!("a crashed fleet is Exited, not Removed");
        };
        assert!(why.contains('3'), "{why}");
    }

    fn fake_fleet_leaf(name: &str) -> crate::testutil::TempDir {
        crate::testutil::TempDir::new(&format!("noite-fleet-unit-{name}"))
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
        let guard_gone = fake_fleet_leaf("gone");
        let dir = guard_gone.path().to_path_buf();
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
        let guard_refused = fake_fleet_leaf("refused");
        let dir = guard_refused.path().to_path_buf();
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
        // must never satisfy this run's /proc scan. The guard kills this
        // run's marker on every exit path, so this test never orphans one
        // itself.
        let marker = format!("31337{}", std::process::id() % 100000);
        let _cleanup = crate::testutil::KillMarkerOnDrop::new(&marker);
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", &format!("sleep {marker} & wait")]);
        cmd.as_std_mut().process_group(0);
        cmd.kill_on_drop(true);
        let mut leader = cmd.spawn().expect("spawn group leader");
        // The leader must have forked its sleeper before the move, or a
        // leader-only kill passes vacuously with nothing to orphan. Yield
        // between scans so the forked child gets scheduled; the deadline
        // only fires when the fork never happens.
        let spawned = std::time::Instant::now();
        while !crate::testutil::live_cmdline_has(&marker) {
            assert!(
                spawned.elapsed() < Duration::from_secs(5),
                "group leader never forked its sleeper"
            );
            tokio::task::yield_now().await;
        }
        // cgroup.procs as a directory: the move is refused (EISDIR, not
        // ESRCH) for a live pid, like a real denial.
        let guard_refused_tree = fake_fleet_leaf("refused-tree");
        let dir = guard_refused_tree.path().to_path_buf();
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
        let guard_moved = fake_fleet_leaf("moved");
        let dir = guard_moved.path().to_path_buf();
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

    /// celld's `/reload` bodies (0.6.3 `internal_reload`) parse into their
    /// outcomes: `failed` keeps celld's error, `unavailable` and anything
    /// unexpected read as unreachable.
    #[test]
    fn reload_bodies_parse_into_their_outcomes() {
        assert_eq!(
            parse_reload_response(
                r#"{"ok":true,"outcome":"adopted","generation":3,"version":"v","prefix":"p"}"#
            ),
            ReloadOutcome::Adopted
        );
        assert_eq!(
            parse_reload_response(
                r#"{"ok":true,"outcome":"unchanged","generation":3,"version":"v"}"#
            ),
            ReloadOutcome::Unchanged
        );
        // The missing-service-target body, verbatim from a real celld
        // `/reload` (a dangling `services` entry fails adoption this way):
        // the deploy must fail with celld's error, never record Success.
        assert_eq!(
            parse_reload_response(
                r#"{"ok":false,"outcome":"failed","error":"load service binding target no-such-script: read s3://voidproxy/deploy/no-such-script/current.json: no such key"}"#
            ),
            ReloadOutcome::Failed {
                error: "load service binding target no-such-script: read s3://voidproxy/deploy/no-such-script/current.json: no such key"
                    .to_string(),
            }
        );
        // A failed outcome without an error still fails, with a fallback.
        assert!(matches!(
            parse_reload_response(r#"{"ok":false,"outcome":"failed"}"#),
            ReloadOutcome::Failed { .. }
        ));
        // No pointer yet, an unknown outcome, garbage: all unreachable.
        for body in [
            r#"{"ok":false,"outcome":"unavailable","error":"this node has no deployment pointer to reload from"}"#,
            r#"{"ok":true,"outcome":"rebuilding"}"#,
            r#"{"ok":true}"#,
            "not json",
            "",
        ] {
            assert_eq!(
                parse_reload_response(body),
                ReloadOutcome::Unreachable,
                "{}",
                body
            );
        }
    }

    /// Minimal celld `/reload` stand-in: answers `adopted` and records the
    /// `Authorization` header it saw, so the test pins what the runner sent.
    async fn serve_reload(listener: tokio::net::TcpListener, seen: Arc<Mutex<Option<String>>>) {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = [0u8; 4096];
        let mut req = Vec::new();
        while !req.ends_with(b"\r\n\r\n") {
            let Ok(n) = stream.read(&mut buf).await else {
                return;
            };
            if n == 0 || req.len() > 8192 {
                return;
            }
            req.extend_from_slice(&buf[..n]);
        }
        let text = String::from_utf8_lossy(&req);
        let header = text.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_string())
        });
        *seen.lock().await = header;
        let body = r#"{"ok":true,"outcome":"adopted"}"#;
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
    }

    /// The reload POST carries the fleet's operator token as a Bearer token
    /// once the fleet was ensured, and goes out bare before that (a 401 then
    /// reads as unreachable, like a dead fleet).
    #[tokio::test]
    async fn reload_sends_the_cached_operator_token() {
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        sqlx::query(include_str!("../../schema.sql"))
            .execute(&pool)
            .await
            .expect("test schema");
        let cfg = crate::config::config_for_tests();
        let app_id = crate::models::new_id();
        let scope_key = format!("app:{app_id}");
        // Bare before the fleet was ever ensured.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = i64::from(listener.local_addr().expect("addr").port());
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        tokio::spawn(serve_reload(listener, seen.clone()));
        assert_eq!(
            reload_at("fleet", port, &scope_key).await,
            ReloadOutcome::Adopted
        );
        assert_eq!(*seen.lock().await, None, "no token cached yet");
        // Ensuring the fleet caches its token; the next reload sends it.
        let token = credentials::operator_token(&pool, &cfg.runner_token, &scope_key, &app_id)
            .await
            .expect("mint");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = i64::from(listener.local_addr().expect("addr").port());
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        tokio::spawn(serve_reload(listener, seen.clone()));
        assert_eq!(
            reload_at("fleet", port, &scope_key).await,
            ReloadOutcome::Adopted
        );
        assert_eq!(
            *seen.lock().await,
            Some(format!("Bearer {token}")),
            "the reload carries the fleet token"
        );
        // Another fleet's token is never sent: a scope this process never
        // ensured goes out bare even while other tokens are cached.
        let other = format!("app:{}", crate::models::new_id());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = i64::from(listener.local_addr().expect("addr").port());
        let seen: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        tokio::spawn(serve_reload(listener, seen.clone()));
        assert_eq!(
            reload_at("other", port, &other).await,
            ReloadOutcome::Adopted
        );
        assert_eq!(*seen.lock().await, None, "no cross-fleet token");
        pool.close().await;
    }

    /// Only a failed adoption fails the deploy — with celld's error naming
    /// the cause — while adopted, unchanged and unreachable proceed to the
    /// health gate.
    #[test]
    fn only_a_failed_adoption_fails_the_deploy() {
        let err = ReloadOutcome::Failed {
            error: "load service binding target no-such-script".to_string(),
        }
        .fail_deploy_on_failed("blog")
        .unwrap_err();
        assert!(
            format!("{:#}", err).contains("load service binding target no-such-script"),
            "{:#}",
            err
        );
        for outcome in [
            ReloadOutcome::Adopted,
            ReloadOutcome::Unchanged,
            ReloadOutcome::Unreachable,
        ] {
            assert!(outcome.fail_deploy_on_failed("blog").is_ok());
        }
    }

    /// A forged service target cannot inject lines into the deploy failure:
    /// the reload error collapses to one capped line, while its genuine
    /// prefix survives.
    #[test]
    fn forged_service_targets_cannot_inject_reload_lines() {
        let forged = "x\nERROR: forged lines\nerror: fake summary";
        let error = format!("load service binding target {}", forged);
        // Through the real path: celld's body, parsed, then failed.
        let body = format!(
            "{{\"ok\":false,\"outcome\":\"failed\",\"version\":\"v\",\"prefix\":\"p\",\"error\":{:?}}}",
            error
        );
        let err = parse_reload_response(&body)
            .fail_deploy_on_failed("blog")
            .unwrap_err();
        let text = format!("{:#}", err);
        assert!(!text.contains('\n'), "{}", text);
        assert!(text.chars().all(|c| !c.is_control()), "{}", text);
        assert!(text.contains("load service binding target x"), "{}", text);
        // A directly built failure sanitizes the same way.
        let err = ReloadOutcome::Failed { error }
            .fail_deploy_on_failed("blog")
            .unwrap_err();
        let text = format!("{:#}", err);
        assert!(!text.contains('\n'), "{}", text);
        assert!(text.chars().all(|c| !c.is_control()), "{}", text);
        // Long errors are capped, not passed through whole.
        let err = ReloadOutcome::Failed {
            error: "e".repeat(5000),
        }
        .fail_deploy_on_failed("blog")
        .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.len() < 5000, "{}", text.len());
    }
}
