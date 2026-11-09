//! Per-fleet cgroup v2 containment (SPEC, Tenant isolation).
//!
//! Each tenant fleet runs in its own cgroup v2 child with `memory.max` (and
//! `pids.max`), so one fleet's growth is OOM-killed inside its own group —
//! contained, and the supervisor restarts it — instead of pushing every fleet
//! toward a shared shed threshold.
//!
//! What the container needs (probed at boot): cgroup v2, a writable cgroupfs
//! mount, and delegation of the `memory` and `pids` controllers. Docker
//! mounts the cgroupfs read-only; the runner remounts its own subtree once
//! at setup, which needs the multi-only compose grant (`CAP_SYS_ADMIN` in
//! `docker/compose.multi.yaml`). The runner anchors at its own cgroup: with
//! a private cgroup namespace that is the mount root itself
//! (`/proc/self/cgroup` reads `0::/`), otherwise the runner's own scope
//! path under the mount. The cgroup
//! v2 "no internal processes" rule forbids enabling controllers on a cgroup
//! that holds member processes, so the runner moves its own processes
//! (including PID 1's group siblings — tini stays reaper, cgroups do not
//! affect reaping) into a `runner` leaf before enabling `+memory +pids`.
//! Fleet leaves need no `subtree_control`: they are leaves, limits only.
//!
//! Where cgroups cannot be created (remount refused, no delegation), the
//! runner records the reason and fleets run in the shared cgroup as before:
//! an explicit, surfaced status in `isolation::self_check`, the boot log
//! and `make doctor` — never a silent no-op. Single-tenant installs get no
//! new grant; multi installs without the overlay block `/ready` like the
//! missing egress policy.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Controllers the runner distributes to the fleet subtree.
const CONTROLLERS: &str = "+memory +pids";

/// Anchor directory name under the runner's own cgroup.
const FLEET_PARENT: &str = "noite";
/// Leaf holding the runner (and PID 1) while controllers are enabled above.
const RUNNER_LEAF: &str = "runner";
/// Prefix of a per-install/build/release-key leaf (`_build-<fleet key>`);
/// the underscore keeps it out of every tenant slug's namespace (slugs
/// cannot start with one, and `_control` is already a reserved key).
const BUILD_LEAF_PREFIX: &str = "_build-";
/// A build's task cap (processes and threads): bun, node, tsc and their
/// workers; far below a fleet's because a build is one project.
pub const BUILD_PIDS_MAX: u64 = 2048;
/// A build's CPU share against a leaf's default 100. Under contention the
/// build yields; on an idle box it still runs at full speed (shares only
/// matter between runnable tasks).
const BUILD_CPU_WEIGHT: u64 = 10;
/// A build's hard CPU ceiling in 1e5-us periods: one core less than the box,
/// never below one core. Weight alone only yields under contention inside
/// the anchor; this caps a build against the whole host (RustFS, Caddy, the
/// runner and SSH itself). Two vCPUs therefore give one core to the build.
const CPU_PERIOD_US: u64 = 100_000;
/// A build's disk share against a leaf's default 100, when the io controller
/// is delegated: bun installs write hundreds of megabytes while RustFS serves
/// telemetry, and an unweighted build can keep the whole host in I/O wait.
const BUILD_IO_WEIGHT: u64 = 10;

/// Cap on a fleet's tasks (processes and threads — the pids controller
/// counts both). Generous on purpose: celld runs isolates in-process and a
/// busy node holds hundreds of threads; the binding constraint is memory.
pub const FLEET_PIDS_MAX: u64 = 4096;

static CGROUPS_OK: AtomicBool = AtomicBool::new(false);
static CGROUP_REASON: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static CGROUP_ANCHOR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static BUILD_MEMORY_MB: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
static BUILD_SWAP_MB: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
static BUILD_CPU: AtomicBool = AtomicBool::new(false);
static BUILD_IO: AtomicBool = AtomicBool::new(false);
static BUILD_SLOTS: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

fn reason(msg: String) {
    if let Ok(mut reason) = CGROUP_REASON.lock() {
        *reason = msg;
    }
}

/// Current cgroup status for `/ready` and doctor.
pub fn status() -> (bool, String) {
    let ok = CGROUPS_OK.load(Ordering::Relaxed);
    let detail = CGROUP_REASON
        .lock()
        .ok()
        .map(|reason| reason.clone())
        .filter(|reason| !reason.is_empty())
        .unwrap_or_else(|| "not probed".to_string());
    (ok, detail)
}

/// A fleet leaf that cannot carry its limits is not containment: trip the
/// install-wide status exactly like a failed setup, so `/ready` and doctor
/// report it and `multi` blocks. One-way until reboot — a kernel refusing
/// these writes will not start accepting them, and the alternative is a
/// silently uncapped fleet. Entries accumulate per fleet (a crash loop
/// re-trips the same key once), so concurrent failures all name themselves.
pub fn note_limit_failed(fleet: &str, reason: String) {
    CGROUPS_OK.store(false, Ordering::Relaxed);
    if let Ok(mut current) = CGROUP_REASON.lock() {
        if !current.contains(&format!("fleet {fleet}:")) {
            if !current.is_empty() {
                current.push_str("; ");
            }
            current.push_str(&format!("fleet {fleet}: {reason}"));
        }
    }
}

/// Anchor holding the per-fleet groups (`<anchor>/<fleet key>`), once setup
/// succeeded. Fleet keys are ProcMap keys (`slug`, `slug.label`).
pub fn anchor() -> Option<PathBuf> {
    CGROUP_ANCHOR.get().cloned()
}

/// The per-build budget in MiB (`0` = uncapped), for the failure message and
/// `/ready`.
pub fn build_memory_mb() -> Option<u64> {
    BUILD_MEMORY_MB.get().copied()
}

/// The swap a build leaf may use past its RAM budget, in MiB (`0` = none),
/// for the failure message and `/ready`.
pub fn build_swap_mb() -> Option<u64> {
    BUILD_SWAP_MB.get().copied()
}

/// Configure build containment once after [`setup`], before any child
/// spawns: remember the budget and (best-effort) enable the CPU controller on
/// the way down so each build leaf can take a small share. No leaf is created
/// here — each deploy creates its own. `false` when cgroupfs is unavailable
/// (builds then share the runner's cgroup, as before), logged loudly.
pub fn setup_build(memory_mb: u64, swap_mb: u64, concurrency: u32) -> bool {
    let Some(anchor) = anchor() else {
        tracing::info!("cgroups unavailable; tenant builds run uncapped");
        return false;
    };
    let _ = BUILD_MEMORY_MB.set(memory_mb);
    let _ = BUILD_SWAP_MB.set(swap_mb);
    let _ = BUILD_SLOTS.set(concurrency.max(1));
    // The CPU controller is optional: it only lets a build yield to serving
    // traffic. Enabling it on the way down changes nothing for existing
    // leaves (all default to weight 100); failing to enable it must not cost
    // the memory cap.
    let own = anchor.parent().unwrap_or(&anchor);
    let cpu = add_controller(own, "cpu")
        .and_then(|()| add_controller(&anchor, "cpu"))
        .map_err(|error| {
            tracing::debug!(
                "build cpu.weight/quota unavailable ({error:#}); builds keep the default share"
            );
        })
        .is_ok();
    let io = add_controller(own, "io")
        .and_then(|()| add_controller(&anchor, "io"))
        .map_err(|error| {
            tracing::debug!(
                "build io.weight unavailable ({error:#}); builds share the disk fairly by default"
            );
        })
        .is_ok();
    BUILD_CPU.store(cpu, Ordering::Relaxed);
    BUILD_IO.store(io, Ordering::Relaxed);
    tracing::info!(
        memory_mb,
        swap_mb,
        cpu,
        cpu_cores = build_cpu_cores(),
        io,
        "tenant build containment active"
    );
    true
}

/// Enable one controller in `cgroup.subtree_control` when it is not already
/// on, and verify the kernel kept it (a refused write must not look applied).
fn add_controller(cgroup: &Path, name: &str) -> anyhow::Result<()> {
    let path = cgroup.join("cgroup.subtree_control");
    let current = std::fs::read_to_string(&path)
        .map_err(|error| anyhow::anyhow!("read {}: {error}", path.display()))?;
    if current.split_whitespace().any(|entry| entry == name) {
        return Ok(());
    }
    write_file(cgroup, "cgroup.subtree_control", &format!("+{name}"))?;
    let applied = std::fs::read_to_string(&path)
        .map_err(|error| anyhow::anyhow!("read {}: {error}", path.display()))?;
    if !applied.split_whitespace().any(|entry| entry == name) {
        anyhow::bail!("{name} did not enable in {}", path.display());
    }
    Ok(())
}

/// The deploy's build leaf when cgroups are active. `Ok(None)` means the
/// install has no cgroup containment, so the step runs uncapped (the boot log
/// and `/ready` already say so).
pub fn build_leaf_for(key: &str, memory_mb: u64, swap_mb: u64) -> anyhow::Result<Option<PathBuf>> {
    let Some(anchor) = anchor() else {
        return Ok(None);
    };
    let cpu = BUILD_CPU.load(Ordering::Relaxed);
    let io = BUILD_IO.load(Ordering::Relaxed);
    Ok(Some(ensure_build_cgroup(
        &anchor, key, memory_mb, swap_mb, cpu, io,
    )?))
}

/// Create (or reuse) the leaf for one deploy key: the memory budget
/// (`RUNNER_BUILD_MEMORY_MB`, 0 = uncapped) and its swap allowance
/// (`RUNNER_BUILD_SWAP_MB`, 0 = none), the group OOM, a task cap and (when
/// the CPU controller is delegated) a small CPU share.
/// Reuse after a crash is safe: the limits are rewritten and the new step
/// moves in. Leaves are world-traversable like fleet leaves; their interface
/// files stay root-owned, so a tenant cannot raise a limit or move itself
/// out.
fn ensure_build_cgroup(
    anchor: &Path,
    key: &str,
    memory_mb: u64,
    swap_mb: u64,
    cpu: bool,
    io: bool,
) -> anyhow::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = anchor.join(format!("{BUILD_LEAF_PREFIX}{}", fleet_dir_name(key)));
    std::fs::create_dir_all(&dir)
        .map_err(|error| anyhow::anyhow!("create {}: {error}", dir.display()))?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
        .map_err(|error| anyhow::anyhow!("chmod {}: {error}", dir.display()))?;
    if memory_mb > 0 {
        write_limit(&dir, "memory.max", &(memory_mb * 1024 * 1024).to_string())?;
        // The swap allowance is the overflow past the RAM budget: a box too
        // small for the build keeps its resident services in RAM and lets
        // the leaf swap the difference, bounded by this cap. Where the
        // kernel has no swap accounting there is nothing to escape into.
        match set_swap_cap(&dir, swap_mb) {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!(
                    key,
                    "no cgroup swap accounting; build contained without memory.swap.max"
                );
            }
            Err(error) => {
                use anyhow::Context;
                return Err(error).with_context(|| format!("cap swap for build {key}"));
            }
        }
        // Kill every task in the leaf when one pushes it over: a lone
        // SIGKILL to the leader can leave a worker holding the budget.
        write_file(&dir, "memory.oom.group", "1")?;
    }
    write_limit(&dir, "pids.max", &BUILD_PIDS_MAX.to_string())?;
    if cpu {
        write_limit(&dir, "cpu.weight", &BUILD_CPU_WEIGHT.to_string())?;
        write_limit(
            &dir,
            "cpu.max",
            &format!("{} {CPU_PERIOD_US}", build_cpu_cores() * CPU_PERIOD_US),
        )?;
    }
    if io {
        // cgroup v2's io.weight takes `default <weight>` (or a device row);
        // a bare number is refused. Best-effort: a store without a
        // weight-aware scheduler would otherwise fail every deploy.
        if let Err(error) = write_limit(&dir, "io.weight", &format!("default {BUILD_IO_WEIGHT}")) {
            tracing::debug!(key, "build io.weight not applied ({error:#})");
        }
    }
    Ok(dir)
}

/// Cores one build may use: the box's cores minus one spare, split across
/// the concurrent build slots (at least one core each). On two vCPUs with one
/// slot that is one core; on 16 vCPUs with two slots it is seven, leaving two
/// for the runner, RustFS, Caddy, the fleets and SSH.
pub fn build_cpu_cores() -> u64 {
    let cores = crate::host::memory::cores().max(1) as u64;
    let slots = BUILD_SLOTS.get().copied().unwrap_or(1).max(1) as u64;
    (cores.saturating_sub(1) / slots).max(1)
}

/// A build leaf's cumulative `oom_kill` counter, or `None` when the file is
/// unreadable. Callers diff it around one step: a rise means the kernel killed
/// that step's cgroup.
pub fn build_oom_kills(dir: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(dir.join("memory.events")).ok()?;
    parse_oom_kills(&text)
}

/// A build leaf pinned at its `memory.max` while stalling on reclaim is not
/// going to finish: every allocation evicts file pages the step then has to
/// re-read, so it burns CPU in the kernel until its timeout (a Vite build
/// with a 613 MiB cap on a 1.6 GiB box read 314 GB in ten minutes while its
/// anon stayed just under the cap, so the kernel never OOM-killed it).
///
/// The exec watchdog samples this every few seconds and fails the step after
/// it stays true: `memory.current` at ≥90% of `memory.max`, the leaf's own
/// `memory.pressure` `full avg10` ≥ 10%, and no swap room left. Swap room
/// matters: a leaf allowed to swap past a RAM cap too small for the build is
/// still making progress through the disk, so it is only stuck once it has
/// filled `memory.swap.max` too (then the next allocation cannot complete at
/// all). A leaf with zero swap keeps the old rule. Anything unreadable
/// (cgroup v1, PSI off) reads as "not pinned", so containment only ever
/// fails a build it can positively see stuck.
pub fn build_thrash_pinned(dir: &Path) -> bool {
    let read_u64 = |name: &str| {
        std::fs::read_to_string(dir.join(name))
            .ok()?
            .trim()
            .parse::<u64>()
            .ok()
    };
    let Some(max) = read_u64("memory.max") else {
        return false;
    };
    let Some(current) = read_u64("memory.current") else {
        return false;
    };
    if max == 0 || current.saturating_mul(100) < max.saturating_mul(90) {
        return false;
    }
    // Swap still has room: the overflow the allowance exists for. Only a
    // leaf that filled its swap cap as well can make no further progress.
    match (read_u64("memory.swap.max"), read_u64("memory.swap.current")) {
        (Some(swap_max), Some(swap_current))
            if swap_max > 0 && swap_current.saturating_mul(100) < swap_max.saturating_mul(90) =>
        {
            return false;
        }
        _ => {}
    }
    std::fs::read_to_string(dir.join("memory.pressure"))
        .ok()
        .and_then(|text| parse_full_avg10(&text))
        .is_some_and(|full| full >= 10.0)
}

/// `full avg10=` from a cgroup `memory.pressure` body.
fn parse_full_avg10(text: &str) -> Option<f64> {
    let full = text.lines().find(|line| line.starts_with("full "))?;
    let avg10 = full
        .split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?;
    avg10.parse().ok()
}

/// The build budget and every live build leaf for `/ready`: charge, swap,
/// high-water mark and OOM count per deploy key. `null` when cgroups are
/// unavailable; `memory_mb`/`swap_mb` are still reported then.
pub fn build_status() -> serde_json::Value {
    let Some(anchor) = anchor() else {
        return serde_json::Value::Null;
    };
    let read = |dir: &Path, name: &str| {
        std::fs::read_to_string(dir.join(name))
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
    };
    let mut leaves: Vec<(String, serde_json::Value)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&anchor) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_prefix(BUILD_LEAF_PREFIX) else {
                continue;
            };
            let dir = entry.path();
            leaves.push((
                key.to_string(),
                serde_json::json!({
                    "current_bytes": read(&dir, "memory.current"),
                    "peak_bytes": read(&dir, "memory.peak"),
                    "swap_max_bytes": read(&dir, "memory.swap.max"),
                    "swap_current_bytes": read(&dir, "memory.swap.current"),
                    "oom_kills": build_oom_kills(&dir),
                    "cpu_max": std::fs::read_to_string(dir.join("cpu.max"))
                        .ok()
                        .map(|raw| raw.trim().to_string()),
                }),
            ));
        }
    }
    leaves.sort_by(|a, b| a.0.cmp(&b.0));
    let leaves: Vec<serde_json::Value> = leaves
        .into_iter()
        .map(|(key, mut value)| {
            value["key"] = serde_json::Value::String(key);
            value
        })
        .collect();
    serde_json::json!({
        "memory_mb": build_memory_mb().unwrap_or(0),
        "swap_mb": build_swap_mb().unwrap_or(0),
        "leaves": leaves,
    })
}

/// `oom_kill` from a cgroup `memory.events` body.
fn parse_oom_kills(text: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        if key != "oom_kill" {
            return None;
        }
        value.trim().parse().ok()
    })
}

/// Resolve the runner's own cgroup under `root` from its kernel placement:
/// a private cgroup namespace reports `/` (the `0::/` line) and the mount
/// root is already the runner's cgroup; otherwise the path names the scope
/// to anchor under. Accepts the raw `0::/…` line too.
fn own_cgroup(root: &Path, self_cgroup: &str) -> PathBuf {
    let trimmed = self_cgroup.trim();
    let path = trimmed.strip_prefix("0::").unwrap_or(trimmed);
    if path.is_empty() || path == "/" {
        return root.to_path_buf();
    }
    root.join(path.trim_start_matches('/'))
}

/// This process's cgroup path (the `0::/…` v2 line of `/proc/self/cgroup`).
#[cfg(unix)]
fn read_self_cgroup() -> Option<String> {
    let raw = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    raw.lines()
        .find_map(|line| line.strip_prefix("0::").map(str::to_string))
}

/// Move every member process of `cgroup` into `leaf`, best-effort per pid:
/// a member that exits between the listing and the move must not fail the
/// drain. (`cgroup.procs` lists only live thread group leaders — never
/// zombies — so every entry here was alive an instant ago.) The caller
/// checks the result.
#[cfg(unix)]
fn drain_to_leaf(cgroup: &Path, leaf: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    let members = std::fs::read_to_string(cgroup.join("cgroup.procs"))
        .with_context(|| format!("read cgroup.procs in {}", cgroup.display()))?;
    for pid in members.split_whitespace() {
        if std::fs::write(leaf.join("cgroup.procs"), pid).is_err() {
            tracing::debug!(pid, "cgroup drain: member exited mid-drain");
        }
    }
    Ok(())
}

/// Does `pid` block enabling controllers: alive and not a zombie? Missing or
/// unparseable state reads as gone — the pid raced away between the `procs`
/// listing and this read. `cgroup.procs` never lists zombies, so the `Z`
/// arm is belt and braces. `proc_root` is `/proc` in production, injected
/// in tests.
#[cfg(unix)]
fn blocks_drain(proc_root: &Path, pid: &str) -> bool {
    let stat = std::fs::read_to_string(proc_root.join(pid).join("stat")).unwrap_or_default();
    // `/proc/<pid>/stat`: `pid (comm) state ...` — comm may hold spaces and
    // parens, so the state is the first field after the last `)`.
    let state = stat.rfind(')').map(|i| stat[i + 1..].trim_start());
    match state.and_then(|s| s.chars().next()) {
        None => false,
        Some('Z') => false,
        Some(_) => true,
    }
}

/// Is `cgroup` free of live member processes, so controllers may be
/// enabled? Entries that raced away do not count. `proc_root` is `/proc`
/// in production, injected in tests.
#[cfg(unix)]
fn is_drained(cgroup: &Path, proc_root: &Path) -> bool {
    let members = std::fs::read_to_string(cgroup.join("cgroup.procs")).unwrap_or_default();
    !members
        .split_whitespace()
        .any(|pid| blocks_drain(proc_root, pid))
}

/// Drain attempts before setup gives up and degrades to the shared cgroup.
#[cfg(unix)]
const DRAIN_ATTEMPTS: usize = 50;
/// Settle between attempts: contenders here are healthcheck execs that live
/// milliseconds.
#[cfg(unix)]
const DRAIN_SETTLE_MS: u64 = 100;

/// Remount `root` read-write, preserving its other flags: Docker mounts the
/// container's cgroupfs read-only, and the multi compose override grants
/// `CAP_SYS_ADMIN` exactly so the runner can flip its own cgroup subtree
/// writable. Without the grant (the base compose, every single-tenant
/// install) this fails and setup degrades loudly as before. Linux-only.
#[cfg(target_os = "linux")]
fn remount_rw(root: &Path) -> anyhow::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let options = mount_options(root).ok_or_else(|| {
        anyhow::anyhow!(
            "remount needs a cgroupfs mount: no /proc/self/mounts entry for {}",
            root.display()
        )
    })?;
    let target = CString::new(root.as_os_str().as_bytes())
        .map_err(|e| anyhow::anyhow!("cgroup root is not a C string: {e}"))?;
    let mut flags: libc::c_ulong = libc::MS_REMOUNT;
    // A remount replaces the flag set, so every flag worth keeping is
    // restated; only the read-only bit is dropped. Unknown options are the
    // filesystem's own (seclabel, nsdelegate) and need no restating.
    for option in options.split(',') {
        flags |= match option {
            "nosuid" => libc::MS_NOSUID,
            "nodev" => libc::MS_NODEV,
            "noexec" => libc::MS_NOEXEC,
            "relatime" => libc::MS_RELATIME,
            "strictatime" => libc::MS_STRICTATIME,
            "noatime" => libc::MS_NOATIME,
            "nodiratime" => libc::MS_NODIRATIME,
            "sync" => libc::MS_SYNCHRONOUS,
            "dirsync" => libc::MS_DIRSYNC,
            _ => 0,
        };
    }
    // SAFETY: null source/type/data with MS_REMOUNT only flips the flags of
    // this mount (a bind inside the container), touching nothing else.
    let rc = unsafe {
        libc::mount(
            std::ptr::null(),
            target.as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
        )
    };
    if rc != 0 {
        return Err(anyhow::anyhow!(
            "remount {} read-write: {}",
            root.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

/// This mount's option list from `/proc/self/mounts` (`source target fstype
/// options …`), so a remount can restate the flags it keeps. Octal escapes
/// (`\040`) decode to their byte; the comparison target has none, but a
/// container root under a spaced path must still match.
#[cfg(target_os = "linux")]
fn mount_options(root: &Path) -> Option<String> {
    let mounts = std::fs::read_to_string("/proc/self/mounts").ok()?;
    find_mount_options(&mounts, root)
}

/// The option list for `root` in one `/proc/self/mounts` dump (`source
/// target fstype options …`). Pure so tests can pin the parsing.
#[cfg(target_os = "linux")]
fn find_mount_options(mounts: &str, root: &Path) -> Option<String> {
    let want = root.to_string_lossy();
    mounts.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        fields.next()?;
        let target = fields.next()?.replace("\\040", " ");
        fields.next()?;
        let options = fields.next()?;
        (target.as_str() == want.as_ref()).then(|| options.to_string())
    })
}

/// The container's cgroupfs mount is read-only on Docker: probe with a
/// throwaway directory, remount once when the probe says read-only, and bail
/// with the operator fix when the grant is missing. A mount that is already
/// writable (privileged, some Podman setups) skips the remount entirely.
#[cfg(unix)]
fn ensure_writable(root: &Path, own: &Path) -> anyhow::Result<()> {
    use anyhow::Context;
    let probe = own.join(".writable");
    if std::fs::create_dir(&probe).is_ok() {
        let _ = std::fs::remove_dir(&probe);
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if remount_rw(root).is_ok() && std::fs::create_dir(&probe).is_ok() {
        let _ = std::fs::remove_dir(&probe);
        tracing::info!(root = %root.display(), "cgroupfs remounted read-write");
        return Ok(());
    }
    Err(anyhow::anyhow!("cgroupfs is not writable"))
        .with_context(|| format!("remount {} refused (multi installs: apply docker/compose.multi.yaml, see the Operator action in CHANGELOG; single installs only warn)", root.display()))
}

/// Write one cgroup interface file. The OS error stays on the chain
/// (`with_context`, never a formatted message): the boot loop classifies a
/// contested enable off `EBUSY` and a dead move target off `ESRCH`, and any
/// formatting here turns both classifiers into dead code — the exact shape
/// of the intermittent boot failure (first EBUSY bailed instead of
/// retrying).
fn write_file(dir: &Path, name: &str, value: &str) -> anyhow::Result<()> {
    use anyhow::Context;
    std::fs::write(dir.join(name), value)
        .with_context(|| format!("write {name} in {}", dir.display()))?;
    Ok(())
}

/// Enable the fleet controllers on `cgroup` and confirm they took: a write
/// the kernel ignores (read-only mount, no delegation) reads back empty.
#[cfg(unix)]
/// Snapshot of a cgroup's enable-relevant state, for the boot log and the
/// `/ready` detail when enabling fails: the failure mode differs by
/// platform, and the next step depends on which of these is off.
#[cfg(unix)]
fn describe(cgroup: &Path) -> String {
    let read = |name: &str| {
        std::fs::read_to_string(cgroup.join(name))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "<unreadable>".to_string())
    };
    let members = std::fs::read_to_string(cgroup.join("cgroup.procs"))
        .map(|m| m.split_whitespace().count().to_string())
        .unwrap_or_else(|_| "<unreadable>".to_string());
    format!(
        "type={} members={} controllers=[{}] subtree=[{}] parent_subtree=[{}]",
        read("cgroup.type"),
        members,
        read("cgroup.controllers"),
        read("cgroup.subtree_control"),
        cgroup
            .parent()
            .map(
                |p| std::fs::read_to_string(p.join("cgroup.subtree_control"))
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| "<unreadable>".to_string())
            )
            .unwrap_or_else(|| "<no parent>".to_string()),
    )
}

/// Enable the fleet controllers on `cgroup` and confirm they took: a write
/// the kernel ignores (read-only mount, no delegation) reads back empty.
#[cfg(unix)]
fn enable_controllers(cgroup: &Path) -> anyhow::Result<()> {
    write_file(cgroup, "cgroup.subtree_control", CONTROLLERS)?;
    use anyhow::Context;
    let enabled = std::fs::read_to_string(cgroup.join("cgroup.subtree_control"))
        .with_context(|| format!("read cgroup.subtree_control in {}", cgroup.display()))?;
    if !enabled
        .split_whitespace()
        .any(|t| t == "+memory" || t == "memory")
        || !enabled
            .split_whitespace()
            .any(|t| t == "+pids" || t == "pids")
    {
        anyhow::bail!("controllers did not enable (have {enabled:?})");
    }
    Ok(())
}
/// Whether `error` is the kernel refusing a contested write (EBUSY): a
/// member landed between the drain check and the enable. Only that case is
/// worth another round; every other failure is permanent.
#[cfg(unix)]
fn is_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error() == Some(libc::EBUSY))
}

/// Set up the fleet anchor under `root` (usually `/sys/fs/cgroup`): capture
/// the runner's own cgroup BEFORE moving (its path changes with the move),
/// move every member into the runner leaf, enable the controllers on the way
/// down, and publish the anchor. Idempotent: a previous boot's anchor is
/// reused after a crash. Records the outcome for `status()`.
pub fn setup(root: &Path) -> bool {
    #[cfg(unix)]
    let placement = read_self_cgroup().unwrap_or_default();
    #[cfg(not(unix))]
    let placement = String::new();
    match setup_inner(root, &placement) {
        Ok(anchor) => {
            let _ = CGROUP_ANCHOR.set(anchor.clone());
            CGROUPS_OK.store(true, Ordering::Relaxed);
            reason(format!("per-fleet cgroups under {}", anchor.display()));
            tracing::info!(anchor = %anchor.display(), "per-fleet cgroups active");
            true
        }
        Err(e) => {
            CGROUPS_OK.store(false, Ordering::Relaxed);
            reason(format!("{e:#}"));
            tracing::warn!(
                "per-fleet cgroups unavailable ({e:#}); fleets share the container cgroup"
            );
            false
        }
    }
}

#[cfg(unix)]
fn setup_inner(root: &Path, placement: &str) -> anyhow::Result<PathBuf> {
    use anyhow::Context;
    use std::os::unix::fs::PermissionsExt;
    if !root.join("cgroup.controllers").is_file() {
        anyhow::bail!("{root:?} is not a cgroup v2 mount (no cgroup.controllers)");
    }
    let own = own_cgroup(root, placement);
    if !own.is_dir() {
        anyhow::bail!("own cgroup {} missing under {root:?}", own.display());
    }
    for controller in ["memory", "pids"] {
        let available = std::fs::read_to_string(own.join("cgroup.controllers"))
            .with_context(|| format!("read controllers of {}", own.display()))?;
        if !available.split_whitespace().any(|c| c == controller) {
            anyhow::bail!("controller {controller} not delegated to {}", own.display());
        }
    }
    // Docker mounts the container's cgroupfs read-only: one remount attempt
    // here (succeeds only with the multi override's CAP_SYS_ADMIN) before
    // anything else writes. The drain loop below stays read-only-safe: a
    // refused remount degrades loudly at once, never after the budget.
    ensure_writable(root, &own)?;
    let anchor = own.join(FLEET_PARENT);
    let leaf = anchor.join(RUNNER_LEAF);
    std::fs::create_dir_all(&leaf).with_context(|| format!("create {}", leaf.display()))?;
    // World-traversable like the fleet groups below it (their doc comment);
    // the runner leaf itself stays private.
    std::fs::set_permissions(&anchor, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("chmod {}", anchor.display()))?;
    // The drain-and-enable below retries a contested enable; see it for why
    // the only racers left are external.
    drain_and_enable(
        &own,
        &anchor,
        &leaf,
        Path::new("/proc"),
        &enable_controllers,
        &|| std::thread::sleep(std::time::Duration::from_millis(DRAIN_SETTLE_MS)),
    )
}

/// Drain `own` into `leaf` and enable the fleet controllers on the way
/// down, retrying a contested enable with a bounded settle.
///
/// Why a retry is the deterministic answer here, not a loophole: everything
/// the runner forks after this point inherits the leaf (setup runs before
/// the first child spawn in `main`), so no runner-spawned process can ever
/// contest `own`. The only arrivals are external — the orchestrator's
/// healthcheck execs (`compose.yaml` probes `/ready` every 10 s; `docker
/// exec` joins the container cgroup by design) — which the runner cannot
/// prevent, only out-wait. A squatter that outlasts the budget degrades to
/// the shared cgroup loudly, as before. `enable` and `settle` are seams for
/// the barrier-driven test, not knobs: production passes the real enable
/// and the bounded settle.
#[cfg(unix)]
fn drain_and_enable(
    own: &Path,
    anchor: &Path,
    leaf: &Path,
    proc_root: &Path,
    enable: &dyn Fn(&Path) -> anyhow::Result<()>,
    settle: &dyn Fn(),
) -> anyhow::Result<PathBuf> {
    use anyhow::Context;
    let mut last_error: Option<anyhow::Error> = None;
    for _ in 0..DRAIN_ATTEMPTS {
        drain_to_leaf(own, leaf)?;
        if is_drained(own, proc_root) {
            match enable(own) {
                Ok(()) => {
                    enable(anchor).with_context(|| {
                        format!("enabling {} ({})", anchor.display(), describe(own))
                    })?;
                    return Ok(anchor.to_path_buf());
                }
                // EBUSY here is a member that landed between the drain and
                // the write (a healthcheck exec) — worth another round.
                // Anything else fails the same way every attempt: bail at
                // once instead of burning the whole budget on an
                // already-loud degradation.
                Err(error) if is_busy(&error) => {
                    last_error = Some(error);
                }
                Err(error) => {
                    return Err(error).with_context(|| format!("enabling {}", own.display()));
                }
            }
        }
        settle();
    }
    match last_error {
        Some(error) => {
            Err(error).with_context(|| format!("enabling {} ({})", own.display(), describe(own)))
        }
        None => {
            anyhow::bail!(
                "{} still holds live processes after the drain ({})",
                own.display(),
                describe(own)
            );
        }
    }
}

#[cfg(not(unix))]
fn setup_inner(_root: &Path, _placement: &str) -> anyhow::Result<PathBuf> {
    anyhow::bail!("cgroups are unix-only")
}

/// Directory name for a fleet key (`slug`, `slug.label`): keys are
/// slug-shaped by construction, but a stray separator must never escape the
/// anchor.
pub fn fleet_dir_name(key: &str) -> String {
    let name: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // A leaf is a child of the anchor: `.` addresses the anchor itself and
    // `..` its parent. No caller produces either today (slugs and labels are
    // constrained), so this keeps the invariant structural.
    if name.is_empty() || name == "." || name == ".." {
        format!("fleet-{name}")
    } else {
        name
    }
}

/// Create (or reuse) a fleet's cgroup with its limits and return its path.
/// Reuse after a crash is safe: the limits are rewritten and the new fleet
/// pid moved in. `memory_mb == 0` means no cap (leave the kernel default).
///
/// Fleet groups are world-traversable (0755), like `builds/` and `fleets/`
/// (SPEC, Data directory: names visible, contents not): a sibling build can
/// see a fleet's slug and its integer limits, which the hostile-tenant lane
/// asserts on, but never tenant data. The values are operational, not
/// secrets. The runner leaf stays private.
pub fn ensure_fleet_cgroup(anchor: &Path, key: &str, memory_mb: u64) -> anyhow::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = anchor.join(fleet_dir_name(key));
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))?;
    if memory_mb > 0 {
        let max = (memory_mb * 1024 * 1024).to_string();
        if let Err(error) = write_limit(&dir, "memory.max", &max) {
            note_limit_failed(key, format!("{error:#}"));
            return Err(error);
        }
        // At the cap the kernel must OOM-kill inside the leaf, not swap the
        // fleet out: with swap allowed a tenant can push gigabytes into host
        // swap past `memory.max` without tripping anything. `memory.swap.max`
        // is absent where the host has no swap accounting — then there is no
        // swap to escape into and the leaf is contained without it.
        match set_swap_cap(&dir, 0) {
            Ok(true) => {}
            Ok(false) => {
                tracing::info!(
                    fleet = key,
                    "no cgroup swap accounting; fleet contained without memory.swap.max"
                );
            }
            Err(error) => {
                note_limit_failed(key, format!("{error:#}"));
                return Err(error);
            }
        }
    }
    if let Err(error) = write_file(&dir, "pids.max", &FLEET_PIDS_MAX.to_string()) {
        note_limit_failed(key, format!("{error:#}"));
        return Err(error);
    }
    Ok(dir)
}

/// Write a cgroup limit and read it back: the kernel rejects what it cannot
/// apply, and a silent no-op (read-only mount after setup, a clamped value)
/// must surface here instead of running uncapped.
fn write_limit(dir: &Path, name: &str, value: &str) -> anyhow::Result<()> {
    write_file(dir, name, value)?;
    let applied = std::fs::read_to_string(dir.join(name))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if applied != value {
        anyhow::bail!("{name} did not apply (wrote {value}, have {applied:?})");
    }
    Ok(())
}

/// Cap a leaf's swap alongside its `memory.max`: MiB for a build leaf, zero
/// for a fleet. Returns whether swap is now capped: `false` when the kernel
/// offers no swap accounting (`memory.swap.max` absent — nothing to escape
/// into).
fn set_swap_cap(dir: &Path, swap_mb: u64) -> anyhow::Result<bool> {
    if !dir.join("memory.swap.max").is_file() {
        return Ok(false);
    }
    write_limit(dir, "memory.swap.max", &(swap_mb * 1024 * 1024).to_string())?;
    Ok(true)
}

/// Move a fleet process into its cgroup; its children inherit it, so the
/// whole fleet — celld and its workers — is contained together.
pub fn enter_cgroup(dir: &Path, pid: u32) -> anyhow::Result<()> {
    write_file(dir, "cgroup.procs", &pid.to_string())
}

/// Drop a stopped fleet's cgroup, returning its high-water RSS first.
/// Best-effort: only an empty cgroup removes, so a racing move keeps its
/// directory and the next spawn reuses it. The peak is read before the
/// removal deletes the leaf (and with it `memory.peak`), so a later read
/// could never recover the number (D3 sizing basis). `None` when the peak
/// is unreadable — no containment, already gone — so callers log only
/// `Some` and an unreadable peak is silence, never a wrong number.
pub fn remove_fleet_cgroup(dir: &Path) -> Option<u64> {
    let peak = fleet_peak_bytes(dir);
    if std::fs::remove_dir(dir).is_err() {
        tracing::debug!(dir = %dir.display(), "fleet cgroup kept (still populated or gone)");
    }
    peak
}

/// High-water RSS of a fleet leaf in bytes (`memory.peak`).
pub fn fleet_peak_bytes(dir: &Path) -> Option<u64> {
    std::fs::read_to_string(dir.join("memory.peak"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// The fleet's current charge from its leaf (`memory.current`): what its cap
/// is measured against right now. `None` for an install without leaves or a
/// fleet that has none.
pub fn fleet_usage_bytes(key: &str) -> Option<u64> {
    let dir = fleet_cgroup_path(key)?;
    std::fs::read_to_string(dir.join("memory.current"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Path of a fleet's cgroup under the active anchor, for stop-time cleanup.
pub fn fleet_cgroup_path(key: &str) -> Option<PathBuf> {
    anchor().map(|a| a.join(fleet_dir_name(key)))
}

/// A fleet that stays up past this long after a spawn starts a fresh OOM
/// chain on its next kill instead of continuing the old one.
const OOM_STABLE_SECS: u64 = 300;
/// First respawn wait after an OOM kill; doubles per consecutive kill.
const OOM_BACKOFF_BASE_SECS: u64 = 5;
/// Longest respawn wait no matter how long the chain gets.
const OOM_BACKOFF_CAP_SECS: u64 = 300;
/// At most one tenant-visible OOM event per fleet per window; every restart
/// still lands in the (ring-bounded) fleet log.
const OOM_EVENT_WINDOW_SECS: u64 = 3600;

/// Per-fleet OOM state: the spawn baseline for kill detection, plus the
/// backoff and event-dedup clocks for a crash loop pinned at its cap. One
/// entry per fleet with a live or recently-dead fleet; forgotten at stop.
struct OomFleet {
    baseline: Option<u64>,
    spawned_at: std::time::Instant,
    consecutive: u32,
    last_event: Option<std::time::Instant>,
    not_before: Option<std::time::Instant>,
}

impl Default for OomFleet {
    fn default() -> Self {
        Self {
            baseline: None,
            spawned_at: std::time::Instant::now(),
            consecutive: 0,
            last_event: None,
            not_before: None,
        }
    }
}

/// OOM-kill baselines per fleet key, taken at spawn: `memory.events`
/// `oom_kill` only grows inside a group, so a restart reports an OOM kill
/// exactly when the counter moved since that fleet's own spawn.
static OOM_FLEETS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, OomFleet>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// What one observed OOM kill means for the supervisor: how long to hold
/// the respawn, whether the tenant event is due (deduped per window), and
/// the event detail naming the cap in force.
pub struct OomNote {
    pub detail: String,
    pub delay: std::time::Duration,
    pub event_due: bool,
}

/// Respawn wait for N consecutive OOM kills: exponential from the base,
/// capped. Pure arithmetic, pinned by unit tests.
fn oom_backoff_delay(consecutive: u32) -> std::time::Duration {
    let shift = consecutive.saturating_sub(1).min(6);
    std::time::Duration::from_secs(OOM_BACKOFF_BASE_SECS * 2u64.pow(shift))
        .min(std::time::Duration::from_secs(OOM_BACKOFF_CAP_SECS))
}

/// Current `oom_kill` count of a fleet group: how many times the kernel
/// OOM-killed inside it. Unreadable (no cgroups, already removed) reads as
/// zero — callers only ever compare against a baseline from the same group.
fn oom_kill_count(dir: &Path) -> u64 {
    let Ok(events) = std::fs::read_to_string(dir.join("memory.events")) else {
        return 0;
    };
    for line in events.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() == Some("oom_kill") {
            if let Some(count) = parts.next().and_then(|n| n.parse().ok()) {
                return count;
            }
        }
    }
    0
}

/// Remember this spawn's OOM-kill count, so the next exit check can tell an
/// OOM kill from any other crash. Preserves the chain clocks across
/// respawns; a hold the spawn passed is spent. Called with the fleet's own
/// group dir.
pub fn note_spawned(key: &str, dir: &Path) {
    let count = oom_kill_count(dir);
    if let Ok(mut fleets) = OOM_FLEETS.lock() {
        let entry = fleets.entry(key.to_string()).or_default();
        entry.baseline = Some(count);
        entry.spawned_at = std::time::Instant::now();
        entry.not_before = None;
    }
}

/// OOM kills since this fleet's own spawn. `Some(n)` with `n > 0` means the
/// kernel killed inside the group and the supervisor is restarting it.
/// Consumes the baseline: one spawn reports at most once. `None` means no
/// baseline (spawned without cgroups, or a runner restart in between).
pub fn oom_kills_since_spawn(key: &str, dir: &Path) -> Option<u64> {
    let mut fleets = OOM_FLEETS.lock().ok()?;
    let baseline = fleets.get_mut(key)?.baseline.take()?;
    oom_kill_count(dir).checked_sub(baseline)
}

/// Record one observed OOM kill for a fleet: advance its consecutive-kill
/// chain (reset when the fleet stayed up past the stable threshold), hold
/// the next respawn by the backoff, and decide whether the tenant event is
/// due (at most one per window; every restart still lands in the fleet log).
pub fn oom_note_kill(key: &str, memory_mb: u32, now: std::time::Instant) -> Option<OomNote> {
    let mut fleets = OOM_FLEETS.lock().ok()?;
    let fleet = fleets.get_mut(key)?;
    let uptime = now.duration_since(fleet.spawned_at);
    fleet.consecutive = if uptime < std::time::Duration::from_secs(OOM_STABLE_SECS) {
        fleet.consecutive.saturating_add(1).max(1)
    } else {
        1
    };
    let delay = oom_backoff_delay(fleet.consecutive);
    let due = match fleet.last_event {
        None => true,
        Some(at) => now.duration_since(at) >= std::time::Duration::from_secs(OOM_EVENT_WINDOW_SECS),
    };
    if due {
        fleet.last_event = Some(now);
    }
    fleet.not_before = Some(now + delay);
    let detail =
        format!("fleet restarted: memory limit {memory_mb} MiB exceeded (Settings → Limits)");
    Some(OomNote {
        detail,
        delay,
        event_due: due,
    })
}

/// Whether a fleet's respawn hold has passed (or was never set). Expired
/// holds are forgotten. Callers skip the spawn while this is false.
pub fn oom_spawn_ready(key: &str, now: std::time::Instant) -> bool {
    let Ok(mut fleets) = OOM_FLEETS.lock() else {
        return true;
    };
    match fleets.get(key).and_then(|fleet| fleet.not_before) {
        Some(at) if now < at => false,
        _ => {
            if let Some(fleet) = fleets.get_mut(key) {
                fleet.not_before = None;
            }
            true
        }
    }
}

/// Whether `error` is the kernel reporting a gone process (ESRCH): a move
/// target that exited mid-move. Only that case means nothing runs uncapped;
/// every other refusal (EACCES, EPERM, read-only mount, no delegation) trips
/// containment.
#[cfg(unix)]
pub fn is_gone(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .any(|io| io.raw_os_error() == Some(libc::ESRCH))
}

/// Forget a stopped fleet's OOM state (stop-time cleanup; a respawn records
/// a fresh one). Best-effort: a missing entry is the common case.
pub fn forget_spawned(key: &str) {
    if let Ok(mut fleets) = OOM_FLEETS.lock() {
        fleets.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeFs {
        dir: PathBuf,
    }

    impl FakeFs {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("noite-cgroup-test-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).expect("fake cgroupfs root");
            Self { dir }
        }

        fn path(&self) -> &Path {
            &self.dir
        }
    }

    impl Drop for FakeFs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fakefs() -> FakeFs {
        FakeFs::new()
    }

    fn write_tree(root: &Path, placement: &str) {
        // A fake of the runner's own cgroup: real cgroupfs semantics
        // (drain checks, controller enables) do not apply, so tests assert
        // path resolution and limit writing, not kernel enforcement.
        let own = own_cgroup(root, placement);
        std::fs::create_dir_all(own.join("noite")).expect("fake own cgroup");
        std::fs::write(own.join("cgroup.controllers"), "cpu memory pids")
            .expect("fake controllers");
        std::fs::write(own.join("cgroup.procs"), "").expect("fake procs");
    }

    #[test]
    fn own_cgroup_private_namespace_is_the_mount_root() {
        let root = Path::new("/sys/fs/cgroup");
        assert_eq!(own_cgroup(root, "0::/"), root);
        assert_eq!(own_cgroup(root, "/"), root);
        assert_eq!(own_cgroup(root, ""), root);
    }

    #[test]
    fn own_cgroup_host_namespace_is_the_scope_path() {
        let root = Path::new("/sys/fs/cgroup");
        let scope = "/user.slice/user-1000.slice/scope.container";
        assert_eq!(
            own_cgroup(root, &format!("0::{scope}")),
            root.join(scope.trim_start_matches('/'))
        );
    }

    #[test]
    fn fleet_dir_name_never_escapes_the_anchor() {
        assert_eq!(fleet_dir_name("shop"), "shop");
        assert_eq!(fleet_dir_name("shop.preview-1"), "shop.preview-1");
        assert_eq!(fleet_dir_name("../../etc"), ".._.._etc");
        assert_eq!(fleet_dir_name("a/b"), "a_b");
        // `.` and `..` address the anchor or its parent, not a leaf.
        assert_eq!(fleet_dir_name("."), "fleet-.");
        assert_eq!(fleet_dir_name(".."), "fleet-..");
        assert_eq!(fleet_dir_name(""), "fleet-");
        // The control leaf is a reserved key: no tenant slug can hold it.
        assert_eq!(fleet_dir_name("_control"), "_control");
    }

    #[test]
    fn fleet_cgroup_writes_limits_as_bytes() {
        let tmp = fakefs();
        let anchor = tmp.path();
        let dir = ensure_fleet_cgroup(anchor, "shop", 512).expect("fleet cgroup");
        assert_eq!(dir, anchor.join("shop"));
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.max")).expect("memory.max"),
            (512 * 1024 * 1024).to_string()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pids.max")).expect("pids.max"),
            FLEET_PIDS_MAX.to_string()
        );
    }

    /// A deploy's build leaf carries the budget as a hard max, kills its whole
    /// group on an OOM, and yields CPU; `memory_mb == 0` writes no memory
    /// limit. The key is namespaced away from tenant slugs.
    #[test]
    fn build_leaf_applies_its_budget() {
        let tmp = fakefs();
        // A real leaf carries the swap interface file when the kernel has
        // swap accounting; the fake leaf mirrors it to assert the write.
        let leaf = tmp.path().join("_build-shop.preview-1");
        std::fs::create_dir_all(&leaf).expect("fake leaf");
        std::fs::write(leaf.join("memory.swap.max"), "max").expect("fake swap accounting");
        let dir = ensure_build_cgroup(tmp.path(), "shop.preview-1", 768, 256, true, false)
            .expect("build cgroup");
        assert_eq!(dir, leaf);
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.max")).expect("memory.max"),
            (768 * 1024 * 1024).to_string()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.swap.max")).expect("swap.max"),
            (256 * 1024 * 1024).to_string(),
            "the build may swap its overflow, bounded by this allowance"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.oom.group")).expect("oom.group"),
            "1"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("pids.max")).expect("pids.max"),
            BUILD_PIDS_MAX.to_string()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("cpu.weight")).expect("cpu.weight"),
            BUILD_CPU_WEIGHT.to_string()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("cpu.max")).expect("cpu.max"),
            format!("{} {CPU_PERIOD_US}", build_cpu_cores() * CPU_PERIOD_US)
        );
        assert!(!dir.join("memory.high").exists(), "no early throttle");

        let io = fakefs();
        let dir =
            ensure_build_cgroup(io.path(), "shop", 768, 0, false, true).expect("build cgroup");
        assert_eq!(
            std::fs::read_to_string(dir.join("io.weight")).expect("io.weight"),
            format!("default {BUILD_IO_WEIGHT}")
        );

        let uncapped = fakefs();
        let dir = ensure_build_cgroup(uncapped.path(), "shop", 0, 0, false, false)
            .expect("uncapped build cgroup");
        assert!(!dir.join("memory.max").exists());
        assert!(!dir.join("cpu.weight").exists());
        assert!(dir.join("pids.max").exists());
    }

    #[test]
    fn build_oom_counter_reads_memory_events() {
        let text = "low 0\nhigh 0\nmax 2\noom 3\noom_kill 4\noom_group_kill 1\n";
        assert_eq!(parse_oom_kills(text), Some(4));
        assert_eq!(parse_oom_kills("low 0\noom 1\n"), None);
        assert_eq!(parse_oom_kills(""), None);
    }

    fn write_leaf(dir: &Path, current: u64, pressure: Option<&str>) {
        std::fs::write(dir.join("memory.max"), "642777088\n").expect("memory.max");
        std::fs::write(dir.join("memory.current"), format!("{current}\n")).expect("memory.current");
        if let Some(text) = pressure {
            std::fs::write(dir.join("memory.pressure"), text).expect("memory.pressure");
        }
    }

    const THRASHING: &str = "some avg10=17.84 avg60=21.90 avg300=19.69 total=1\n\
                             full avg10=16.49 avg60=19.22 avg300=17.24 total=1\n";

    #[test]
    fn build_thrash_pinned_flags_a_cap_bound_leaf_under_full_pressure() {
        let tmp = fakefs();
        write_leaf(tmp.path(), 642_000_000, Some(THRASHING));
        assert!(build_thrash_pinned(tmp.path()));
    }

    #[test]
    fn build_thrash_pinned_needs_the_cap_and_the_stall() {
        let tmp = fakefs();
        // A large build with headroom is making progress, not thrashing.
        write_leaf(tmp.path(), 400_000_000, Some(THRASHING));
        assert!(!build_thrash_pinned(tmp.path()));
        // Pinned but not stalled: the step is still doing work.
        write_leaf(
            tmp.path(),
            642_000_000,
            Some("full avg10=1.5 avg60=1.0 avg300=0.5 total=1\n"),
        );
        assert!(!build_thrash_pinned(tmp.path()));
        // No PSI (cgroup v1 or PSI off) never fails a build.
        write_leaf(tmp.path(), 642_000_000, None);
        assert!(!build_thrash_pinned(tmp.path()));
        // An uncapped leaf (no memory.max) is never thrashing.
        std::fs::remove_file(tmp.path().join("memory.max")).expect("drop memory.max");
        assert!(!build_thrash_pinned(tmp.path()));
    }

    #[test]
    fn build_thrash_pinned_waits_for_the_swap_room() {
        let tmp = fakefs();
        write_leaf(tmp.path(), 642_000_000, Some(THRASHING));
        // Pinned at the RAM cap with swap room left: the overflow is still
        // moving, so the build is slow, not stuck.
        std::fs::write(tmp.path().join("memory.swap.max"), "1073741824\n").expect("swap.max");
        std::fs::write(tmp.path().join("memory.swap.current"), "536870912\n")
            .expect("swap.current");
        assert!(!build_thrash_pinned(tmp.path()));
        // Swap filled too: no allocation can complete, so fail the step.
        std::fs::write(tmp.path().join("memory.swap.current"), "1073741824\n")
            .expect("swap.current");
        assert!(build_thrash_pinned(tmp.path()));
        // A zero swap cap keeps the old rule: pinned + pressure is stuck.
        std::fs::write(tmp.path().join("memory.swap.max"), "0\n").expect("swap.max");
        std::fs::write(tmp.path().join("memory.swap.current"), "0\n").expect("swap.current");
        assert!(build_thrash_pinned(tmp.path()));
    }

    #[test]
    fn add_controller_accepts_an_enabled_controller_without_writing() {
        let tmp = fakefs();
        std::fs::write(
            tmp.path().join("cgroup.subtree_control"),
            "cpu memory pids\n",
        )
        .expect("fake subtree_control");
        add_controller(tmp.path(), "cpu").expect("already enabled");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("cgroup.subtree_control")).unwrap(),
            "cpu memory pids\n",
            "an enabled controller is never rewritten"
        );
    }

    #[test]
    fn fleet_peak_reads_before_removal() {
        let tmp = fakefs();
        let dir = tmp.path().join("shop");
        std::fs::create_dir_all(&dir).expect("fake fleet leaf");
        std::fs::write(dir.join("memory.peak"), "63029248\n").expect("fake peak");
        // A fake leaf holds a real file, so the kernel-empty precondition
        // never holds here and the directory stays — like a racing move in
        // production — but the peak is still returned first.
        assert_eq!(remove_fleet_cgroup(&dir), Some(63029248));
        assert!(dir.exists(), "a populated leaf is kept for the next spawn");
        // An emptied leaf removes, and the peak went out with the call above.
        std::fs::remove_file(dir.join("memory.peak")).expect("empty the leaf");
        remove_fleet_cgroup(&dir);
        assert!(!dir.exists(), "the leaf is removed after the read");
        assert_eq!(
            fleet_peak_bytes(&dir),
            None,
            "a removed leaf reads as absent"
        );
    }

    #[test]
    fn fleet_peak_absent_without_a_reading() {
        let tmp = fakefs();
        assert_eq!(
            fleet_peak_bytes(&tmp.path().join("never-spawned")),
            None,
            "no leaf reads as absent"
        );
        let dir = tmp.path().join("uncapped");
        std::fs::create_dir_all(&dir).expect("fake fleet leaf");
        assert_eq!(
            fleet_peak_bytes(&dir),
            None,
            "a leaf without memory.peak reads as absent"
        );
        std::fs::write(dir.join("memory.peak"), "not-a-number").expect("fake peak");
        assert_eq!(
            fleet_peak_bytes(&dir),
            None,
            "an unreadable peak never logs a wrong number"
        );
    }

    #[test]
    fn fleet_cgroup_reuse_rewrites_limits() {
        let tmp = fakefs();
        let anchor = tmp.path();
        ensure_fleet_cgroup(anchor, "shop", 512).expect("first spawn");
        let dir = ensure_fleet_cgroup(anchor, "shop", 256).expect("respawn after crash");
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.max")).expect("memory.max"),
            (256 * 1024 * 1024).to_string()
        );
    }

    #[test]
    fn fleet_cgroup_zero_memory_leaves_kernel_default() {
        let tmp = fakefs();
        let anchor = tmp.path();
        let dir = ensure_fleet_cgroup(anchor, "shop", 0).expect("fleet cgroup");
        assert!(!dir.join("memory.max").exists(), "no cap written");
        assert!(dir.join("pids.max").exists(), "pids cap still applies");
    }

    #[test]
    fn setup_fails_loudly_without_cgroupfs() {
        let tmp = fakefs();
        // No cgroup.controllers: not a cgroup v2 mount.
        let err = setup_inner(tmp.path(), "0::/").expect_err("must fail without cgroupfs");
        assert!(
            format!("{err:#}").contains("cgroup.controllers"),
            "names the cause: {err:#}"
        );
    }

    #[test]
    fn setup_fails_loudly_without_delegation() {
        let tmp = fakefs();
        std::fs::write(tmp.path().join("cgroup.controllers"), "cpu").expect("host controllers");
        // The fake own cgroup is the mount root (private namespace shape).
        std::fs::write(tmp.path().join("cgroup.procs"), "").expect("fake procs");
        let err = setup_inner(tmp.path(), "0::/").expect_err("must fail without memory/pids");
        assert!(
            format!("{err:#}").contains("not delegated"),
            "names the cause: {err:#}"
        );
    }

    #[test]
    fn write_tree_helper_resolves_private_anchor() {
        let tmp = fakefs();
        write_tree(tmp.path(), "0::/");
        assert!(tmp.path().join("noite").is_dir());
    }

    fn fake_proc(entries: &[(&str, &str)]) -> FakeFs {
        // A fake `/proc`: `<pid>/stat` with the kernel's `pid (comm) state`
        // shape. Comms with spaces and parens exercise the `rfind(')')`
        // parse.
        let procfs = fakefs();
        for (pid, stat) in entries {
            let dir = procfs.path().join(pid);
            std::fs::create_dir_all(&dir).expect("fake pid dir");
            std::fs::write(dir.join("stat"), stat).expect("fake stat");
        }
        procfs
    }

    #[test]
    fn only_live_non_zombies_block_the_drain() {
        let procfs = fake_proc(&[
            ("100", "100 (runner) S 1"),
            ("101", "101 (curl) Z 1"),
            ("102", "102 (my (odd) name) R 1"),
        ]);
        let root = procfs.path();
        assert!(blocks_drain(root, "100"), "sleeping runner blocks");
        assert!(blocks_drain(root, "102"), "running with tricky comm blocks");
        assert!(!blocks_drain(root, "101"), "zombies never block");
        assert!(!blocks_drain(root, "103"), "reaped pids never block");
    }

    #[test]
    fn malformed_stat_reads_as_gone_not_blocking() {
        let procfs = fake_proc(&[("100", "garbage without parens")]);
        assert!(
            !blocks_drain(procfs.path(), "100"),
            "unparseable stat races as gone"
        );
    }

    #[test]
    fn only_ebusy_is_worth_another_round() {
        let busy = anyhow::anyhow!(std::io::Error::from_raw_os_error(libc::EBUSY));
        assert!(is_busy(&busy));
        let denied = anyhow::anyhow!(std::io::Error::from_raw_os_error(libc::EROFS));
        assert!(!is_busy(&denied));
        let plain = anyhow::anyhow!("not even io");
        assert!(!is_busy(&plain));
    }

    #[test]
    fn cgroup_write_errors_keep_their_os_cause() {
        let tmp = fakefs();
        // A directory where the interface file goes: the write is refused
        // (EISDIR, even as root), exercising the production error path
        // rather than a hand-built error.
        let leaf = tmp.path().join("leaf");
        std::fs::create_dir_all(leaf.join("cgroup.procs")).expect("fake interface dir");
        let err = write_file(&leaf, "cgroup.procs", "1").expect_err("EISDIR must fail");
        let code = err
            .chain()
            .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
            .filter_map(|io| io.raw_os_error())
            .next();
        assert_eq!(
            code,
            Some(libc::EISDIR),
            "the OS cause must survive wrapping: the boot loop classifies EBUSY off this chain, and a formatted-away cause makes every retry check dead code"
        );
        // The boot failure shape: an EBUSY wrapped the way production now
        // wraps it must classify as worth another round, while a permanent
        // refusal still bails at once.
        let busy = anyhow::Error::new(std::io::Error::from_raw_os_error(libc::EBUSY))
            .context("write cgroup.subtree_control in /sys/fs/cgroup");
        assert!(is_busy(&busy), "context-wrapped EBUSY retries");
        assert!(!is_busy(&err), "EISDIR bails at once");
    }

    #[test]
    fn busy_enable_retries_past_a_spawn_racing_init() {
        use std::sync::{Arc, Barrier, Mutex};
        let tmp = fakefs();
        // Fake own cgroup holding one member; fake procfs where it is alive.
        let own = tmp.path().join("own");
        let anchor = tmp.path().join("noite");
        let leaf = anchor.join("runner");
        std::fs::create_dir_all(&leaf).expect("fake leaf");
        std::fs::create_dir_all(&own).expect("fake own cgroup");
        std::fs::write(own.join("cgroup.procs"), "100").expect("fake members");
        let procfs = fake_proc(&[("100", "100 (runner) R 1"), ("200", "200 (curl) R 1")]);
        // A spawn racing init: it lands in the root between the drain and
        // the enable, the way a healthcheck exec lands on a real boot. Two
        // barriers pin the landing inside that window — no sleeps.
        let start = Arc::new(Barrier::new(2));
        let landed = Arc::new(Barrier::new(2));
        let squatter = {
            let start = Arc::clone(&start);
            let landed = Arc::clone(&landed);
            let members = own.join("cgroup.procs");
            std::thread::spawn(move || {
                start.wait();
                let mut current = std::fs::read_to_string(&members).expect("read members");
                if !current.split_whitespace().any(|pid| pid == "200") {
                    current.push_str(" 200");
                    std::fs::write(&members, current).expect("land the squatter");
                }
                landed.wait();
            })
        };
        let own_enables = Mutex::new(0usize);
        let contested = Mutex::new(String::new());
        let enable = |target: &Path| -> anyhow::Result<()> {
            if target != own {
                return Ok(());
            }
            let mut n = own_enables.lock().expect("enable count");
            *n += 1;
            if *n == 1 {
                // First enable: let the spawn land mid-window, then fail
                // the way the kernel does — EBUSY wrapped exactly like
                // production wraps it.
                start.wait();
                landed.wait();
                *contested.lock().expect("contested members") =
                    std::fs::read_to_string(target.join("cgroup.procs")).unwrap_or_default();
                Err(
                    anyhow::Error::new(std::io::Error::from_raw_os_error(libc::EBUSY)).context(
                        format!("write cgroup.subtree_control in {}", target.display()),
                    ),
                )
            } else {
                Ok(())
            }
        };
        // Settle emulates the kernel: a moved pid leaves the source cgroup,
        // which a plain file cannot do by itself. No sleeps anywhere.
        let own_procs = own.join("cgroup.procs");
        let leaf_procs = leaf.join("cgroup.procs");
        let settle = || {
            let moved = std::fs::read_to_string(&leaf_procs).unwrap_or_default();
            let current = std::fs::read_to_string(&own_procs).unwrap_or_default();
            let remaining: Vec<&str> = current
                .split_whitespace()
                .filter(|pid| !moved.split_whitespace().any(|m| m == *pid))
                .collect();
            std::fs::write(&own_procs, remaining.join(" ")).expect("emulate kernel removal");
        };
        let anchor_out = drain_and_enable(&own, &anchor, &leaf, procfs.path(), &enable, &settle);
        match anchor_out {
            Ok(dir) => {
                assert_eq!(dir, anchor, "the anchor publishes on success");
                squatter.join().expect("squatter landed");
                assert_eq!(
                    *own_enables.lock().expect("enable count"),
                    2,
                    "one contested own enable, then success"
                );
                assert!(
                    contested
                        .lock()
                        .expect("contested members")
                        .split_whitespace()
                        .any(|pid| pid == "200"),
                    "the spawn landed inside the drain-to-enable window"
                );
                assert_eq!(
                    std::fs::read_to_string(&own_procs).expect("drained members"),
                    "",
                    "the next round drained the racer too"
                );
                assert!(
                    std::fs::read_to_string(&leaf_procs)
                        .expect("leaf members")
                        .split_whitespace()
                        .any(|pid| pid == "200"),
                    "the racer moved into the leaf"
                );
            }
            Err(error) => {
                // The squatter may still be parked on its barrier: fail
                // without joining it rather than deadlocking the suite.
                panic!("a transient squatter must not fail the boot: {error:#}");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn mount_options_picks_this_mount() {
        let mounts = "cgroup2 /sys/fs/cgroup cgroup2 ro,nosuid,nodev,noexec,relatime,nsdelegate 0 0\ntmpfs /run tmpfs rw,nosuid,nodev 0 0\n";
        assert_eq!(
            find_mount_options(mounts, Path::new("/sys/fs/cgroup")),
            Some("ro,nosuid,nodev,noexec,relatime,nsdelegate".to_string())
        );
        assert_eq!(
            find_mount_options(mounts, Path::new("/run")),
            Some("rw,nosuid,nodev".to_string())
        );
        assert_eq!(find_mount_options(mounts, Path::new("/missing")), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn mount_options_decodes_escaped_spaces() {
        let mounts = "cgroup2 /mnt/my\\040cgroup cgroup2 rw,nosuid 0 0\n";
        assert_eq!(
            find_mount_options(mounts, Path::new("/mnt/my cgroup")),
            Some("rw,nosuid".to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn remount_off_a_mount_fails_loudly() {
        let err = remount_rw(Path::new("/definitely/not/a/mount")).expect_err("must fail");
        let msg = format!("{err:#}");
        assert!(msg.contains("remount"), "names the operation: {msg}");
        assert!(
            msg.contains("/definitely/not/a/mount"),
            "names the root: {msg}"
        );
    }

    #[test]
    fn writable_dir_needs_no_remount() {
        let tmp = fakefs();
        ensure_writable(tmp.path(), tmp.path()).expect("tmp is writable");
        assert!(!tmp.path().join(".writable").exists(), "probe removed");
    }

    #[test]
    fn unwritable_dir_names_the_override() {
        let tmp = fakefs();
        // No such subdirectory: the probe mkdir fails, and the throwaway
        // path is no mount, so the remount is refused too.
        let missing = tmp.path().join("no-such-dir");
        let err = ensure_writable(&missing, &missing).expect_err("must fail");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("cgroupfs is not writable"),
            "names the cause: {msg}"
        );
        assert!(msg.contains("compose.multi.yaml"), "names the fix: {msg}");
    }

    fn fake_events(dir: &Path, oom_kill: u64) {
        std::fs::write(
            dir.join("memory.events"),
            format!("low 0\nhigh 0\nmax 0\noom 0\noom_kill {oom_kill}\n"),
        )
        .expect("fake memory.events");
    }

    #[test]
    fn oom_kill_count_reads_the_counter() {
        let tmp = fakefs();
        fake_events(tmp.path(), 3);
        assert_eq!(oom_kill_count(tmp.path()), 3);
        assert_eq!(
            oom_kill_count(&tmp.path().join("no-such-dir")),
            0,
            "unreadable reads as zero"
        );
    }

    #[test]
    fn oom_baseline_reports_growth_once() {
        let tmp = fakefs();
        let key = format!("oom-once-{}", crate::models::new_id());
        fake_events(tmp.path(), 2);
        note_spawned(&key, tmp.path());
        assert_eq!(
            oom_kills_since_spawn(&key, tmp.path()),
            Some(0),
            "no growth since spawn"
        );
        // Consumed by the first check: a second exit without a respawn
        // reports nothing, so one spawn records at most one event.
        assert_eq!(oom_kills_since_spawn(&key, tmp.path()), None);
        // A respawn rebaselines past old kills; growth after that reports.
        fake_events(tmp.path(), 5);
        note_spawned(&key, tmp.path());
        fake_events(tmp.path(), 7);
        assert_eq!(
            oom_kills_since_spawn(&key, tmp.path()),
            Some(2),
            "growth since this spawn reports"
        );
        assert_eq!(oom_kills_since_spawn(&key, tmp.path()), None);
        // A stop forgets the baseline: stale entries never blame a respawn.
        note_spawned(&key, tmp.path());
        forget_spawned(&key);
        assert_eq!(oom_kills_since_spawn(&key, tmp.path()), None);
    }

    #[test]
    fn oom_without_baseline_never_reports() {
        let tmp = fakefs();
        let key = format!("oom-none-{}", crate::models::new_id());
        fake_events(tmp.path(), 9);
        assert_eq!(
            oom_kills_since_spawn(&key, tmp.path()),
            None,
            "a restarted runner must not blame the previous boot"
        );
    }

    #[test]
    fn consecutive_oom_kills_back_off_and_dedupe_the_event() {
        let tmp = fakefs();
        let key = format!("oom-loop-{}", crate::models::new_id());
        let now = std::time::Instant::now();
        // Three rapid kills: delays grow 5 s, 10 s, 20 s, but only the
        // first records its tenant event.
        let mut delays = Vec::new();
        let mut events = 0;
        for n in 1..=3u64 {
            fake_events(tmp.path(), n - 1);
            note_spawned(&key, tmp.path());
            fake_events(tmp.path(), n);
            assert_eq!(
                oom_kills_since_spawn(&key, tmp.path()),
                Some(1),
                "kill {n} observed"
            );
            let note = oom_note_kill(&key, 256, now).expect("kill recorded");
            assert!(
                note.detail.contains("256 MiB"),
                "the event names the cap in force"
            );
            delays.push(note.delay);
            events += usize::from(note.event_due);
        }
        assert_eq!(
            delays,
            vec![
                std::time::Duration::from_secs(5),
                std::time::Duration::from_secs(10),
                std::time::Duration::from_secs(20)
            ],
            "respawn backoff grows exponentially"
        );
        assert_eq!(events, 1, "one tenant event per window, not one per kill");
        assert!(
            !oom_spawn_ready(&key, now),
            "the respawn holds until the backoff passes"
        );
    }

    #[test]
    fn oom_backoff_caps_at_five_minutes() {
        assert_eq!(oom_backoff_delay(1), std::time::Duration::from_secs(5));
        assert_eq!(
            oom_backoff_delay(7),
            std::time::Duration::from_secs(300),
            "the wait never exceeds the cap"
        );
        assert_eq!(
            oom_backoff_delay(u32::MAX),
            std::time::Duration::from_secs(300),
            "no shift overflow past the cap"
        );
    }

    #[test]
    fn only_gone_processes_read_as_gone() {
        let gone = anyhow::anyhow!(std::io::Error::from_raw_os_error(libc::ESRCH));
        assert!(is_gone(&gone));
        for raw in [libc::EACCES, libc::EPERM, libc::EBUSY, libc::EROFS] {
            let denied = anyhow::anyhow!(std::io::Error::from_raw_os_error(raw));
            assert!(!is_gone(&denied), "os error {raw} still trips containment");
        }
        let plain = anyhow::anyhow!("not even io");
        assert!(!is_gone(&plain));
    }

    #[test]
    fn fleet_cgroup_writes_swap_max_zero() {
        let tmp = fakefs();
        let anchor = tmp.path();
        // cap_swap only writes where the kernel offers swap accounting: the
        // fake leaf carries the interface file the way a real leaf does.
        std::fs::create_dir_all(anchor.join("swapped")).expect("fake fleet leaf");
        std::fs::write(anchor.join("swapped").join("memory.swap.max"), "max")
            .expect("fake swap accounting");
        let dir = ensure_fleet_cgroup(anchor, "swapped", 512).expect("fleet cgroup");
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.swap.max")).expect("swap.max"),
            "0",
            "the leaf cannot swap past its memory.max"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("memory.max")).expect("memory.max"),
            (512 * 1024 * 1024).to_string()
        );
    }

    #[test]
    fn missing_swap_accounting_is_contained() {
        let tmp = fakefs();
        // No memory.swap.max on the fake leaf (a host without swap
        // accounting): nothing to escape into, so the spawn succeeds.
        let dir = ensure_fleet_cgroup(tmp.path(), "noswap", 512).expect("fleet cgroup");
        assert!(
            !dir.join("memory.swap.max").exists(),
            "no accounting file invented"
        );
    }

    #[test]
    fn refused_limit_write_trips_containment_status() {
        let tmp = fakefs();
        let anchor = tmp.path();
        let key = format!("capped-{}", crate::models::new_id());
        // A directory where memory.max goes: the limit write is refused
        // (EISDIR, even as root), so the spawn must trip containment
        // instead of running the fleet uncapped.
        std::fs::create_dir_all(anchor.join(fleet_dir_name(&key)).join("memory.max"))
            .expect("fake fleet leaf");
        let err = ensure_fleet_cgroup(anchor, &key, 512).expect_err("must fail on refused write");
        let msg = format!("{err:#}");
        assert!(msg.contains("memory.max"), "names the refused limit: {msg}");
        let (ok, detail) = status();
        assert!(!ok, "a refused limit write is not containment");
        assert!(
            detail.contains(&key),
            "the reason names the fleet: {detail}"
        );
    }
}
