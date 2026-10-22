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

/// Cap on a fleet's tasks (processes and threads — the pids controller
/// counts both). Generous on purpose: celld runs isolates in-process and a
/// busy node holds hundreds of threads; the binding constraint is memory.
pub const FLEET_PIDS_MAX: u64 = 4096;

static CGROUPS_OK: AtomicBool = AtomicBool::new(false);
static CGROUP_REASON: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
static CGROUP_ANCHOR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

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
/// silently uncapped fleet.
pub fn note_limit_failed(fleet: &str, reason: String) {
    CGROUPS_OK.store(false, Ordering::Relaxed);
    self::reason(format!("fleet {fleet}: {reason}"));
}

/// Anchor holding the per-fleet groups (`<anchor>/<fleet key>`), once setup
/// succeeded. Fleet keys are ProcMap keys (`slug`, `slug.label`).
pub fn anchor() -> Option<PathBuf> {
    CGROUP_ANCHOR.get().cloned()
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
    let members = std::fs::read_to_string(cgroup.join("cgroup.procs"))
        .map_err(|e| anyhow::anyhow!("read cgroup.procs: {e}"))?;
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
/// enabled? Entries that raced away do not count.
#[cfg(unix)]
fn is_drained(cgroup: &Path) -> bool {
    let members = std::fs::read_to_string(cgroup.join("cgroup.procs")).unwrap_or_default();
    let proc_root = Path::new("/proc");
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

fn write_file(dir: &Path, name: &str, value: &str) -> anyhow::Result<()> {
    std::fs::write(dir.join(name), value)
        .map_err(|e| anyhow::anyhow!("write {name} in {}: {e}", dir.display()))
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
    let enabled = std::fs::read_to_string(cgroup.join("cgroup.subtree_control"))
        .map_err(|e| anyhow::anyhow!("read cgroup.subtree_control: {e}"))?;
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
    // The container cgroup is shared with healthcheck execs at boot: a
    // one-shot drain loses to a curl that lands mid-drain (observed in the
    // isolation lane: two curls held the root past a single drain), and a
    // curl that lands between the final check and the enable fails that too
    // (EBUSY — observed on Docker). Retry the drain *and* the enable with a
    // bounded settle; a live squatter past the budget degrades to the shared
    // cgroup, loudly. Persistent errors fail the same way every attempt
    // (read-only mounts and missing delegation bail earlier, in
    // `ensure_writable` and the delegation check), so the loop only spends
    // its budget on the contested case.
    let mut last_error: Option<anyhow::Error> = None;
    for _ in 0..DRAIN_ATTEMPTS {
        drain_to_leaf(&own, &leaf)?;
        if is_drained(&own) {
            match enable_controllers(&own) {
                Ok(()) => {
                    enable_controllers(&anchor).with_context(|| {
                        format!("enabling {} ({})", anchor.display(), describe(&own))
                    })?;
                    return Ok(anchor);
                }
                // EBUSY here is a member that landed between the check and
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
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_SETTLE_MS));
    }
    match last_error {
        Some(error) => {
            Err(error).with_context(|| format!("enabling {} ({})", own.display(), describe(&own)))
        }
        None => {
            anyhow::bail!(
                "{} still holds live processes after the drain ({})",
                own.display(),
                describe(&own)
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
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
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
        match cap_swap(&dir) {
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

/// Cap a fleet leaf's swap at zero alongside its `memory.max`. Returns
/// whether swap is now capped: `false` when the kernel offers no swap
/// accounting (`memory.swap.max` absent — nothing to escape into).
fn cap_swap(dir: &Path) -> anyhow::Result<bool> {
    if !dir.join("memory.swap.max").is_file() {
        return Ok(false);
    }
    write_limit(dir, "memory.swap.max", "0")?;
    Ok(true)
}

/// Move a fleet process into its cgroup; its children inherit it, so the
/// whole fleet — celld and its workers — is contained together.
pub fn enter_cgroup(dir: &Path, pid: u32) -> anyhow::Result<()> {
    write_file(dir, "cgroup.procs", &pid.to_string())
}

/// Drop a stopped fleet's cgroup. Best-effort: only an empty cgroup removes,
/// so a racing move keeps its directory and the next spawn reuses it.
pub fn remove_fleet_cgroup(dir: &Path) {
    if std::fs::remove_dir(dir).is_err() {
        tracing::debug!(dir = %dir.display(), "fleet cgroup kept (still populated or gone)");
    }
}

/// Path of a fleet's cgroup under the active anchor, for stop-time cleanup.
pub fn fleet_cgroup_path(key: &str) -> Option<PathBuf> {
    anchor().map(|a| a.join(fleet_dir_name(key)))
}

/// OOM-kill baselines per fleet key, taken at spawn: `memory.events`
/// `oom_kill` only grows inside a group, so a restart reports an OOM kill
/// exactly when the counter moved since that fleet's own spawn. Entries are
/// consumed by the first exit check after the spawn and forgotten at stop.
static OOM_BASELINE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

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
/// OOM kill from any other crash. Called with the fleet's own group dir.
pub fn note_spawned(key: &str, dir: &Path) {
    let count = oom_kill_count(dir);
    if let Ok(mut baseline) = OOM_BASELINE.lock() {
        baseline.insert(key.to_string(), count);
    }
}

/// OOM kills since this fleet's own spawn. `Some(n)` with `n > 0` means the
/// kernel killed inside the group and the supervisor is restarting it —
/// record the tenant-visible event. Consumes the baseline: one spawn reports
/// at most once. `None` means no baseline (spawned without cgroups, or a
/// runner restart in between) — never report on that.
pub fn oom_kills_since_spawn(key: &str, dir: &Path) -> Option<u64> {
    let baseline = OOM_BASELINE.lock().ok()?.remove(key)?;
    oom_kill_count(dir).checked_sub(baseline)
}

/// Forget a stopped fleet's baseline (stop-time cleanup; a respawn records a
/// fresh one). Best-effort: a missing entry is the common case.
pub fn forget_spawned(key: &str) {
    if let Ok(mut baseline) = OOM_BASELINE.lock() {
        baseline.remove(key);
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
