//! Reap fleet processes a previous run of this install left behind.
//!
//! A runner restart without a container restart — dev's cargo-watch, and any
//! in-container runner relaunch — orphans the old run's fleets: the supervisor
//! spawns every fleet in its own process group (`process_group(0)`), so
//! killing the runner's own group never reaches them, and they reparent to
//! init (or the subreaper) while the new runner's `ProcMap` knows nothing
//! about them. Every new spawn on their ports then crash-loops on
//! `EADDRINUSE` behind `celld exited; restarting` in the fleet log.
//!
//! Boot therefore reaps them before the first fleet spawn (see `main.rs`, next
//! to the sandbox-container orphan sweep), by the identity every fleet of this
//! install carries in its process title.
//!
//! Safety argument — how each rule holds:
//!
//! 1. **Only provable fleets of this install.** Every fleet spawn (tenant in
//!    `host::supervisor`, control in `host::control`) sets argv[0] to
//!    [`fleet_argv0`] of this install's [`install_tag_for`]: the
//!    store-derived install tag that already scopes the sandbox labels and
//!    the credential sweep, so no other install's fleet shares it. The tag
//!    rides argv[0] rather than the environment because fleet nodes are
//!    non-dumpable (celld `0053`): `/proc/<pid>/environ` answers `EACCES`
//!    even as root, while cmdline stays readable — and clap ignores argv[0]
//!    (verified against celld 0.6.3), whereas an unknown flag would fail the
//!    spawn. Ports are never matched: two installs never share a tag even
//!    when their port ranges overlap. `NOITE_FLEET_INSTALL` carries the same
//!    tag in the fleet environment for debuggability, but the sweep never
//!    reads environ — it cannot, on a non-dumpable node.
//! 2. **Never a live fleet of the running runner.** The sweep runs before
//!    this runner spawns anything, and [`should_reap`] still skips any pid
//!    whose ppid is this process.
//! 3. **Kill the process group, then wait bounded.** The victim leads its own
//!    group (tenant fleets always did; the control fleet takes its own group
//!    with this change), so `SIGKILL` to the group takes the leader and any
//!    worker still holding the port. The wait then polls the same condition
//!    the kill established — no live process carrying the marker, plus a
//!    best-effort check that the parsed listen ports answer
//!    connection-refused — yielding between scans, never sleeping, under a
//!    deadline. One `warn!` per reaped fleet names its key and pid.
//! 4. **Never fail the boot.** `/proc` reads that fail, unparseable stats,
//!    a kill that lands on an already-exited pid, and a wait that times out
//!    all log and continue; the existing crash-restart path still reports
//!    whatever survives.

use std::time::{Duration, Instant};

use crate::config::Config;

/// `argv[0]` of every fleet of the install: still greppable as celld
/// (`pgrep -f celld` keeps matching), with the install tag appended so the
/// boot sweep can tell this install's previous-run fleets from any other
/// install's live ones sharing the same `/proc`.
pub fn fleet_argv0(install_tag: &str) -> String {
    format!("celld-noite-{}", install_tag)
}

/// This install's tag for fleet identity: the store-derived install tag that
/// already scopes the sandbox container labels and the credential sweep. It
/// survives database loss (unlike the row-based install id), so a restored
/// snapshot keeps the same identity.
pub fn install_tag_for(cfg: &Config) -> String {
    crate::host::credentials::install_tag(&cfg.s3_endpoint, &cfg.s3_bucket, &cfg.aws_region)
}

/// The argv[0] marker this runner's fleet spawns carry.
pub fn marker_for(cfg: &Config) -> String {
    fleet_argv0(&install_tag_for(cfg))
}

/// One scanned process: the facts the reap decision is pure over.
pub struct ScannedProc {
    /// `/proc/<pid>`.
    pub pid: u32,
    /// Parent pid, from `/proc/<pid>/stat`.
    pub ppid: u32,
    /// Raw `/proc/<pid>/cmdline` bytes (NUL-separated argv); empty for
    /// zombies and kernel threads, which therefore never match.
    pub cmdline: String,
    /// `/proc/<pid>/cwd` target when readable. Non-dumpable nodes deny it;
    /// collected for the reap log line only, never for identity.
    pub cwd: Option<String>,
}

/// The process title: argv[0] is the bytes up to the first NUL.
pub fn argv0(cmdline: &str) -> &str {
    cmdline.split('\0').next().unwrap_or("")
}

/// Pure reap decision: a previous run's fleet of this install, and nothing
/// else. `marker` is this install's [`marker_for`]; `own_pid` is the running
/// runner's pid.
///
/// A process is reaped only when its title is exactly the marker — another
/// install's fleet (different tag), a non-celld process, and a zombie (empty
/// cmdline) all read as keep — and never when it is the runner itself or a
/// live child of the runner.
pub fn should_reap(own_pid: u32, marker: &str, proc: &ScannedProc) -> bool {
    if marker.is_empty() {
        return false;
    }
    if proc.pid == own_pid || proc.ppid == own_pid {
        return false;
    }
    argv0(&proc.cmdline) == marker
}

/// This install's fleet key for one scanned fleet's argv: the `--bucket`
/// value's leaf (`fleets/<slug>` → `slug`, `envs/<slug>/<label>` →
/// `slug.label`, `control` → `_control`), for the reap log line.
pub fn fleet_key_from_argv(argv: &[&str]) -> String {
    let mut bucket: Option<&str> = None;
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        if *arg == "--bucket" {
            bucket = rest.next().copied();
            break;
        }
    }
    let Some(value) = bucket else {
        return "unknown".to_string();
    };
    let Some(path) = value.split("://").nth(1) else {
        return "unknown".to_string();
    };
    let mut segments = path.split('/');
    match (segments.next(), segments.next(), segments.next()) {
        (Some(_), Some("fleets"), Some(slug)) => slug.to_string(),
        (Some(_), Some("envs"), Some(slug)) => match segments.next() {
            Some(label) => format!("{}.{}", slug, label),
            None => "unknown".to_string(),
        },
        (Some(_), Some("control"), None) => "_control".to_string(),
        _ => "unknown".to_string(),
    }
}

/// The `--listen` / `--internal-listen` values in one scanned fleet's argv,
/// for the post-kill port check.
pub fn listen_addrs_from_argv(argv: &[&str]) -> Vec<String> {
    let mut addrs = Vec::new();
    let mut rest = argv.iter();
    while let Some(arg) = rest.next() {
        if *arg == "--listen" || *arg == "--internal-listen" {
            if let Some(addr) = rest.next() {
                addrs.push((*addr).to_string());
            }
        }
    }
    addrs
}

/// Split a raw cmdline into argv fields.
fn split_argv(cmdline: &str) -> Vec<&str> {
    cmdline
        .split('\0')
        .filter(|field| !field.is_empty())
        .collect()
}

/// Parent pid from one `/proc/<pid>/stat` body: `pid (comm) state ppid …`,
/// where comm may itself hold spaces and parens, so the fields start after
/// the last `)`.
fn ppid_from_stat(stat: &str) -> Option<u32> {
    let after = stat.rfind(')')?;
    let mut fields = stat[after + 1..].split_whitespace();
    let _state = fields.next()?;
    fields.next()?.parse().ok()
}

/// Scan every visible process for the reap facts. A process whose stat cannot
/// be read (exiting under us) is skipped: without a ppid the "not our child"
/// guard cannot be proven.
pub fn scan() -> Vec<ScannedProc> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return out;
    };
    let own = std::process::id();
    for entry in dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        if pid == own {
            continue;
        }
        let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let cmdline = String::from_utf8_lossy(&raw).into_owned();
        let stat = std::fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
        let Some(ppid) = ppid_from_stat(&stat) else {
            continue;
        };
        let cwd = std::fs::read_link(entry.path().join("cwd"))
            .ok()
            .map(|target| target.to_string_lossy().into_owned());
        out.push(ScannedProc {
            pid,
            ppid,
            cmdline,
            cwd,
        });
    }
    out
}

/// Bound for the post-kill wait: SIGKILL lands at once, so the first re-scan
/// usually already sees every victim gone; the deadline only caps a stuck
/// scan, never paces it.
const REAP_WAIT: Duration = Duration::from_secs(10);

/// Poll until no scanned process carries `marker`, yielding between scans —
/// never sleeping — up to `REAP_WAIT`. The condition, not a clock, ends the
/// wait.
async fn wait_for_marker_gone(marker: &str) -> bool {
    let start = Instant::now();
    loop {
        if !scan().iter().any(|proc| argv0(&proc.cmdline) == marker) {
            return true;
        }
        if start.elapsed() >= REAP_WAIT {
            return false;
        }
        tokio::task::yield_now().await;
    }
}

/// Best-effort check that a parsed listen address from a reaped fleet answers
/// connection-refused now: the crash-loop this sweep prevents is a held port,
/// so a still-open one is worth a warning even after the processes are gone.
async fn port_still_held(addr: &str) -> bool {
    let dial = addr.replacen("0.0.0.0", "127.0.0.1", 1);
    matches!(
        tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(&dial),
        )
        .await,
        Ok(Ok(_))
    )
}

/// Reap every scanned process the decision names, then wait (bounded) for the
/// marker to clear and the parsed listen ports to free. Returns how many were
/// reaped. Never fails: every I/O or kill error logs and continues.
pub async fn reap_matching(marker: &str) -> usize {
    let own = std::process::id();
    let victims: Vec<ScannedProc> = scan()
        .into_iter()
        .filter(|proc| should_reap(own, marker, proc))
        .collect();
    if victims.is_empty() {
        return 0;
    }
    let mut addrs: Vec<String> = Vec::new();
    for victim in &victims {
        let argv = split_argv(&victim.cmdline);
        let key = fleet_key_from_argv(&argv);
        addrs.extend(listen_addrs_from_argv(&argv));
        tracing::warn!(
            fleet = %key,
            pid = victim.pid,
            cwd = ?victim.cwd,
            "reaping the previous run's fleet process"
        );
        crate::host::supervisor::sigkill_tree(victim.pid);
    }
    if !wait_for_marker_gone(marker).await {
        tracing::warn!(
            reaped = victims.len(),
            "the previous run's fleet processes are still present; continuing the boot, the crash-restart path still reports"
        );
        return victims.len();
    }
    for addr in &addrs {
        if port_still_held(addr).await {
            tracing::warn!(addr = %addr, "a reaped fleet's listen address still answers; the next spawn may crash-loop on it");
        }
    }
    tracing::info!(
        reaped = victims.len(),
        "reaped the previous run's fleet processes"
    );
    victims.len()
}

/// Boot entry: reap the previous run's fleet processes of this install before
/// the first fleet spawn. See the module docs for the safety argument; see
/// `main.rs` for the call site, next to the sandbox-container orphan sweep.
pub async fn reap_previous_run(cfg: &Config) {
    let marker = marker_for(cfg);
    reap_matching(&marker).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(pid: u32, ppid: u32, cmdline: &str) -> ScannedProc {
        ScannedProc {
            pid,
            ppid,
            cmdline: cmdline.to_string(),
            cwd: Some("/data/runner".to_string()),
        }
    }

    /// Marker-shaped cmdlines the tests build: title first, then the real
    /// celld flags, NUL-separated like `/proc/<pid>/cmdline`.
    fn fleet_cmdline(marker: &str, bucket: &str, listen: &str, internal: &str) -> String {
        [
            marker,
            "--bucket",
            bucket,
            "--endpoint",
            "http://rustfs:9000",
            "--region",
            "us-east-1",
            "--listen",
            listen,
            "--internal-listen",
            internal,
            "--advertise",
            internal,
        ]
        .join("\0")
    }

    #[test]
    fn marker_names_the_install_in_a_celld_title() {
        assert_eq!(fleet_argv0("a1b2c3d4"), "celld-noite-a1b2c3d4");
    }

    #[test]
    fn own_previous_run_fleet_reaps() {
        let marker = "celld-noite-a1b2c3d4";
        let proc = scanned(
            444,
            1,
            &fleet_cmdline(
                marker,
                "s3://noite/fleets/shop",
                "0.0.0.0:20000",
                "127.0.0.1:20001",
            ),
        );
        assert!(should_reap(7, marker, &proc));
    }

    #[test]
    fn another_install_fleet_keeps() {
        let proc = scanned(
            445,
            1,
            &fleet_cmdline(
                "celld-noite-e5f6a7b8",
                "s3://noite/fleets/shop",
                "0.0.0.0:20000",
                "127.0.0.1:20001",
            ),
        );
        assert!(!should_reap(7, "celld-noite-a1b2c3d4", &proc));
    }

    #[test]
    fn non_celld_process_keeps() {
        // The marker as a mere argument is not the title: argv[0] decides.
        let argued = scanned(446, 1, "sleep\0celld-noite-a1b2c3d4\0");
        assert!(!should_reap(7, "celld-noite-a1b2c3d4", &argued));
        let plain = scanned(447, 1, &("sleep\0".to_string() + "60\0"));
        assert!(!should_reap(7, "celld-noite-a1b2c3d4", &plain));
    }

    #[test]
    fn own_child_keeps() {
        let marker = "celld-noite-a1b2c3d4";
        let proc = scanned(
            448,
            7,
            &fleet_cmdline(
                marker,
                "s3://noite/fleets/shop",
                "0.0.0.0:20000",
                "127.0.0.1:20001",
            ),
        );
        assert!(!should_reap(7, marker, &proc));
    }

    #[test]
    fn zombie_and_empty_marker_keep() {
        let zombie = scanned(449, 1, "");
        assert!(!should_reap(7, "celld-noite-a1b2c3d4", &zombie));
        let proc = scanned(450, 1, "celld-noite-a1b2c3d4\0");
        assert!(!should_reap(7, "", &proc));
        assert!(!should_reap(450, "celld-noite-a1b2c3d4", &proc));
    }

    #[test]
    fn keys_come_from_the_bucket_leaf() {
        let tenant_raw = fleet_cmdline(
            "m",
            "s3://noite/fleets/shop",
            "0.0.0.0:20000",
            "127.0.0.1:20001",
        );
        let tenant = split_argv(&tenant_raw);
        assert_eq!(fleet_key_from_argv(&tenant), "shop");
        let env_raw = fleet_cmdline(
            "m",
            "s3://noite/envs/shop/preview",
            "0.0.0.0:20002",
            "127.0.0.1:20003",
        );
        let env = split_argv(&env_raw);
        assert_eq!(fleet_key_from_argv(&env), "shop.preview");
        let control_raw =
            fleet_cmdline("m", "s3://noite/control", "127.0.0.1:8090", "0.0.0.0:8091");
        let control = split_argv(&control_raw);
        assert_eq!(fleet_key_from_argv(&control), "_control");
        assert_eq!(fleet_key_from_argv(&["m"]), "unknown");
    }

    #[test]
    fn listen_addrs_come_from_the_flags() {
        let raw = fleet_cmdline(
            "m",
            "s3://noite/fleets/shop",
            "0.0.0.0:20000",
            "127.0.0.1:20001",
        );
        let argv = split_argv(&raw);
        assert_eq!(
            listen_addrs_from_argv(&argv),
            vec!["0.0.0.0:20000", "127.0.0.1:20001"]
        );
        assert!(listen_addrs_from_argv(&["m"]).is_empty());
    }

    /// Boot reap end to end: a stand-in fleet carrying this install's marker
    /// in argv[0] — the way a real celld spawn holds it — in its own process
    /// group is gone after the reap, while a stand-in with another install's
    /// marker survives. Both stand-ins are true orphans (reparented, like a
    /// real previous-run fleet — a live child would be spared by the
    /// not-our-child guard, which the unit tests pin). Both guards clean up
    /// on every exit path, and the visibility waits poll the condition
    /// (never a single scan after spawn).
    #[tokio::test]
    #[cfg(unix)]
    async fn boot_reap_kills_own_previous_run_fleet_and_spares_another_install() {
        use std::os::unix::process::CommandExt;
        use std::time::Duration;

        // A store identity unique to this test-process run: a stale stand-in
        // from an aborted earlier run must never satisfy this run's scan.
        let mut cfg = crate::config::config_for_tests();
        cfg.s3_endpoint = format!("http://127.0.0.1:{}", std::process::id());
        let own_marker = marker_for(&cfg);
        let other_marker = fleet_argv0(&format!("other{:x}", std::process::id()));
        let _own_cleanup = crate::testutil::KillMarkerOnDrop::new(&own_marker);
        let _other_cleanup = crate::testutil::KillMarkerOnDrop::new(&other_marker);

        // A stand-in fleet that outlives its launcher's parenthood: the
        // outer shell backgrounds a `setsid` leader titled with `marker`
        // and exits at once, so the fleet reparents to init in its own
        // group — like a real previous-run fleet — instead of staying a
        // child of this test (which the sweep deliberately spares).
        let spawn_orphan_standin = |marker: &str| {
            let script = format!("setsid bash -c 'exec -a {marker} sleep 60' &");
            std::process::Command::new("bash")
                .args(["-c", &script])
                .process_group(0)
                .spawn()
                .expect("spawn stand-in launcher")
                .wait()
                .expect("reap the launcher");
        };
        spawn_orphan_standin(&own_marker);
        spawn_orphan_standin(&other_marker);

        // Wait for the exact reap candidates, not just the marker text: the
        // launchers' own cmdlines carry it as an argument until the final
        // `exec` titles the fleet.
        let own_pid = std::process::id();
        let spawned = std::time::Instant::now();
        loop {
            let candidate = scan()
                .iter()
                .any(|proc| should_reap(own_pid, &own_marker, proc));
            if candidate {
                break;
            }
            assert!(
                spawned.elapsed() < Duration::from_secs(5),
                "own stand-in fleet never became visible"
            );
            tokio::task::yield_now().await;
        }

        // This is the call boot makes: the same marker derivation, scan,
        // group kill and bounded wait.
        reap_previous_run(&cfg).await;

        assert!(
            crate::testutil::wait_for_cmdline_gone(&own_marker, Duration::from_secs(5)).await,
            "the reap missed this install's previous-run fleet"
        );
        assert!(
            crate::testutil::live_cmdline_has(&other_marker),
            "the reap killed another install's fleet"
        );
    }
}
