//! Per-fleet cgroup v2 containment (SPEC, Tenant isolation).
//!
//! Each tenant fleet runs in its own cgroup v2 child with `memory.max` (and
//! `pids.max`), so one fleet's growth is OOM-killed inside its own group —
//! contained, and the supervisor restarts it — instead of pushing every fleet
//! toward a shared shed threshold.
//!
//! What the container needs (probed at boot): cgroup v2, a writable cgroupfs
//! mount, and delegation of the `memory` and `pids` controllers. The runner
//! anchors at its own cgroup: with a private cgroup namespace that is the
//! mount root itself (`/proc/self/cgroup` reads `0::/`), otherwise the
//! runner's own scope path under the mount. The cgroup
//! v2 "no internal processes" rule forbids enabling controllers on a cgroup
//! that holds member processes, so the runner moves its own processes
//! (including PID 1's group siblings — tini stays reaper, cgroups do not
//! affect reaping) into a `runner` leaf before enabling `+memory +pids`.
//! Fleet leaves need no `subtree_control`: they are leaves, limits only.
//!
//! Where cgroups cannot be created (read-only cgroupfs, no delegation, no
//! `privileged`), the runner records the reason and fleets run in the shared
//! cgroup as before: an explicit, surfaced status in `isolation::self_check`,
//! the boot log and `make doctor` — never a silent no-op. Compose files ship
//! `privileged: true`, which is what makes the mount writable.

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
static CGROUP_REASON: std::sync::OnceLock<String> = std::sync::OnceLock::new();
static CGROUP_ANCHOR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn reason(msg: String) {
    let _ = CGROUP_REASON.set(msg);
}

/// Current cgroup status for `/ready` and doctor.
pub fn status() -> (bool, String) {
    let ok = CGROUPS_OK.load(Ordering::Relaxed);
    let detail = CGROUP_REASON
        .get()
        .cloned()
        .unwrap_or_else(|| "not probed".to_string());
    (ok, detail)
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

fn write_file(dir: &Path, name: &str, value: &str) -> anyhow::Result<()> {
    std::fs::write(dir.join(name), value)
        .map_err(|e| anyhow::anyhow!("write {name} in {}: {e}", dir.display()))
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
    let anchor = own.join(FLEET_PARENT);
    let leaf = anchor.join(RUNNER_LEAF);
    std::fs::create_dir_all(&leaf).with_context(|| format!("create {}", leaf.display()))?;
    // World-traversable like the fleet groups below it (their doc comment);
    // the runner leaf itself stays private.
    std::fs::set_permissions(&anchor, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("chmod {}", anchor.display()))?;
    // The container cgroup is shared with healthcheck execs at boot:
    // a one-shot drain loses to a curl that lands mid-drain (observed in
    // the isolation lane: two curls held the root past a single drain).
    // Retry with a bounded settle; a live squatter past the budget degrades
    // to the shared cgroup, loudly.
    let mut drained = false;
    for _ in 0..DRAIN_ATTEMPTS {
        drain_to_leaf(&own, &leaf)?;
        if is_drained(&own) {
            drained = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_SETTLE_MS));
    }
    if !drained {
        anyhow::bail!(
            "{} still holds live processes after the drain",
            own.display()
        );
    }
    enable_controllers(&own)?;
    enable_controllers(&anchor)?;
    Ok(anchor)
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
        write_file(&dir, "memory.max", &max)?;
        // The kernel rejects what it cannot apply; read back so a silent
        // no-op (read-only mount after setup, a clamped value) surfaces here
        // instead of running uncapped.
        let applied = std::fs::read_to_string(dir.join("memory.max"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if applied != max {
            anyhow::bail!("memory.max did not apply (wrote {max}, have {applied:?})");
        }
    }
    write_file(&dir, "pids.max", &FLEET_PIDS_MAX.to_string())?;
    Ok(dir)
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
}
