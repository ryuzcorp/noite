//! Tenant build/release sandbox and the runner's command runner: explicit
//! environments, uid/gid drop, rlimits, and the process-group kill that keeps
//! a step from outliving its timeout. S3 lives in `host::s3`; git tip bundles
//! in `host::tips`.

use anyhow::{bail, Context};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

use crate::config::Config;

/// How often the build thrash watchdog samples its cgroup leaf.
const THRASH_SAMPLE: Duration = Duration::from_secs(5);
/// Consecutive samples a leaf must stay pinned before the step is failed
/// (30 s). A build that is merely large dips in and out of the cap; one
/// stuck under full memory pressure stays there.
const THRASH_SAMPLES: u32 = 6;

/// Explicit base environment for tenant builds (SPEC, Build and release sandbox).
/// Nothing is inherited: `run_sandboxed` starts from `env_clear()` plus
/// these, then the already-denylisted tenant vars.
///
/// Every cache lives under the app's own cache root: bun's in `bun/`, jup's
/// store of package managers in `jup/`, and `HOME` is `home/`, which is
/// where npm, pnpm and Yarn keep theirs. A shared `HOME` would be one cache
/// for every tenant.
pub fn base_env(work_tmp: &str, cache: &Path) -> Vec<(String, String)> {
    let sub = |name: &str| cache.join(name).to_string_lossy().into_owned();
    vec![
        ("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()),
        ("HOME".into(), sub(CACHE_HOME)),
        ("TMPDIR".into(), work_tmp.into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("CI".into(), "1".into()),
        // `CI` alone turns colors on in picocolors (Vite, Rsbuild); the
        // deploy log is plain text.
        ("NO_COLOR".into(), "1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("BUN_INSTALL_CACHE_DIR".into(), sub(CACHE_BUN)),
        ("JUP_HOME".into(), sub(CACHE_JUP)),
        // A build never edits the project: jup would otherwise add a
        // `packageManager` pin to an unpinned package.json.
        ("JUP_ENABLE_AUTO_PIN".into(), "0".into()),
        // Its advisories call the runner's spec file (package_manager.rs) a
        // stray manifest outside the project, which misleads in a deploy log.
        ("JUP_QUIET_ADVISORIES".into(), "1".into()),
    ]
}

/// Share of a build leaf's RAM cap given to V8's old space, in percent.
/// Node sizes its default heap from the leaf's `memory.max` — about half —
/// so a 613 MiB leaf gives a 397-package pnpm install ~306 MB and it aborts
/// with `FATAL ERROR: Reached heap limit` after `added 397, done` (Ember,
/// beta.4). Three quarters leaves native headroom (RSS, page cache) while
/// the overflow swaps; a ceiling at or above the RAM cap would pin the leaf
/// and trip the thrash watchdog on a healthy build (see
/// `cgroups::build_thrash_pinned`).
const NODE_HEAP_PCT: u64 = 75;

/// V8 heap ceiling in MiB for a build leaf with `memory_mb` of RAM: `None`
/// when builds run uncapped (`0` is the old behavior, no `NODE_OPTIONS`).
/// Swap never counts toward the ceiling: heap past the RAM cap would pin the
/// leaf and trip the thrash watchdog, so swap stays the overflow for native
/// RSS and page cache. Runner-owned: tenant `NODE_OPTIONS` is dropped in
/// `db::env`, so nothing the tenant sets can widen or narrow this.
pub(crate) fn build_node_heap_max_mb(memory_mb: u64) -> Option<u64> {
    if memory_mb == 0 {
        return None;
    }
    Some(memory_mb * NODE_HEAP_PCT / 100)
}

/// The runner-owned `NODE_OPTIONS` for one build step (`None` when builds
/// run uncapped): every Node in the step — jup, the package manager it
/// runs, lifecycle scripts, the config converter — sizes its heap from the
/// leaf's real budget instead of V8's default half-of-cgroup.
pub(crate) fn node_heap_flag() -> Option<String> {
    let heap = build_node_heap_max_mb(crate::host::cgroups::build_memory_mb()?)?;
    Some(format!("--max-old-space-size={heap}"))
}

/// MiB of leaf RAM per pnpm tarball worker. pnpm's pool defaults to one
/// worker per CPU minus one (31 on a 32-thread box, 1 on a 2-vCPU one), and
/// every worker faults and extracts concurrently: 31 workers OOM a 613 MiB
/// leaf in fetch within a second, while 1–2 survive (Ember, beta.4, measured
/// at 2 and 32 CPUs). So each worker gets half a GiB of RAM to itself, capped
/// by the leaf's CPU share — never more workers than cores, never fewer
/// than one.
const PNPM_WORKER_RAM_MB: u64 = 512;

/// pnpm tarball-worker cap for a build leaf with `memory_mb` of RAM and
/// `cpu_cores` of CPU share: `None` when builds run uncapped (`0` is the old
/// behavior, no `PNPM_MAX_WORKERS`). Runner-owned: tenant `PNPM_MAX_WORKERS`
/// is dropped in `db::env`, so nothing the tenant sets can widen this.
/// npm, Yarn and bun ignore the name, so it is set unconditionally.
pub(crate) fn build_pnpm_workers_max(memory_mb: u64, cpu_cores: u64) -> Option<u64> {
    if memory_mb == 0 {
        return None;
    }
    Some(1.max(cpu_cores.min(memory_mb / PNPM_WORKER_RAM_MB)))
}

/// The runner-owned `PNPM_MAX_WORKERS` for one build step (`None` when
/// builds run uncapped): pnpm's exact worker count, sized from the leaf's
/// real budget instead of the host's CPU count.
pub(crate) fn pnpm_workers_flag() -> Option<String> {
    let workers = build_pnpm_workers_max(
        crate::host::cgroups::build_memory_mb()?,
        crate::host::cgroups::build_cpu_cores(),
    )?;
    Some(workers.to_string())
}

/// A V8 heap abort in a step's output: Node SIGABRTs, so the status has no
/// code (`exit None`) and the raw dump names no knob. Matched against the
/// step's combined output to turn it into the budget error below instead.
fn v8_heap_oom(out: &str, err: &str) -> bool {
    const MARKERS: &[&str] = &["JavaScript heap out of memory", "Reached heap limit"];
    MARKERS
        .iter()
        .any(|marker| out.contains(marker) || err.contains(marker))
}

/// Subdirectories of a per-app build cache root.
const CACHE_BUN: &str = "bun";
const CACHE_JUP: &str = "jup";
const CACHE_HOME: &str = "home";

/// The image's read-only store of bundled package managers
/// (`docker/Dockerfile` seeds it at build time with `JUP_HOME` pointed here):
/// jup's own layout, `v1/<name>/<version>/` entries each carrying jup's `.jup`
/// completion marker. World-readable; the build uid must read but never
/// modify the shared copy, so deploys copy (never symlink) entries into the
/// app's own `JUP_HOME`.
pub const BUNDLED_SEED_DIR: &str = "/opt/jup-bundled";

/// Copy a bundled manager (`name@version`, e.g. from
/// `package_manager::PackageManager::bundled`) from `seed_dir` (production:
/// `BUNDLED_SEED_DIR`) into the app's `JUP_HOME`, so jup runs the installed
/// exact version with no registry request. Copies only when the versioned
/// entry (with jup's `.jup` marker) is missing; returns true when the entry is
/// present afterwards. Any failure returns false so the caller falls back to
/// today's behavior (jup downloads the release): dev targets and old images
/// have no seed.
pub fn seed_bundled_manager(seed_dir: &Path, cache: &Path, name: &str, version: &str) -> bool {
    let target = cache.join(CACHE_JUP).join("v1").join(name).join(version);
    if target.join(".jup").is_file() {
        return true;
    }
    let source = seed_dir.join("v1").join(name).join(version);
    if copy_dir(&source, &target).is_ok() && target.join(".jup").is_file() {
        return true;
    }
    let _ = std::fs::remove_dir_all(&target);
    false
}

/// Recursively copy `source` to `target` without following symlinks. A tenant
/// tree can link at platform paths (see `lchown_tree`), so links are
/// recreated, never traversed.
fn copy_dir(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)?.flatten() {
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&from, &to)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            {
                let link = std::fs::read_link(&from)?;
                std::os::unix::fs::symlink(link, to)?;
            }
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Tenant sandbox: uid/gid drop + explicit env (SPEC, Build and release sandbox).
/// `uid: None` = current user (dev only, single-tenant).
/// `cache: None` = a throwaway `.build-cache` inside the worktree; `Some` =
/// the persistent per-app cache root (T5.1).
/// `cgroup: None` = no build containment on this install; `Some` = the
/// deploy's capped build leaf, which the step enters before dropping uid.
pub struct Sandbox<'a> {
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub env: &'a [(&'a str, &'a str)],
    pub cache: Option<&'a Path>,
    pub cgroup: Option<&'a Path>,
}

/// Probe whether uid drops work (needs CAP_SETUID/CAP_SETGID or root).
pub fn can_drop_uid(uid: u32, gid: u32) -> bool {
    #[cfg(unix)]
    {
        // Fork-free probe: try setuid in a child `id` process via `su`-less
        // `setpriv`-style check is overkill; attempt a no-op `sh` with uid
        // set and see if it spawns. Cheap and cached by the caller.
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("/bin/true");
        cmd.uid(uid).gid(gid);
        cmd.status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = (uid, gid);
        false
    }
}

/// Recursively hand `path` to (uid, gid) without following symlinks: a tenant
/// tree can contain `x -> /data/noite.sqlite`, and a following chown run by
/// the runner (CAP_CHOWN) would give the build uid the platform database.
/// `lchown` changes the link itself, and links are never descended into.
/// Returns false when any entry could not be changed.
#[cfg(unix)]
pub fn lchown_tree(path: &Path, uid: u32, gid: u32) -> bool {
    let mut ok = true;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&p) else {
            ok = false;
            continue;
        };
        if std::os::unix::fs::lchown(&p, Some(uid), Some(gid)).is_err() {
            ok = false;
        }
        if meta.file_type().is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for entry in rd.flatten() {
                    stack.push(entry.path());
                }
            }
        }
    }
    ok
}

/// Total bytes under `dir` (symlinks not followed).
pub fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            let Ok(m) = entry.metadata() else {
                continue;
            };
            if m.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

/// Refuse a worktree above the disk quota (SPEC, Build and release sandbox).
pub fn check_work_quota(work: &Path, max_mb: u64) -> anyhow::Result<()> {
    let max = max_mb.saturating_mul(1024 * 1024);
    let used = dir_bytes(work);
    if used > max {
        anyhow::bail!("build worktree {used} bytes exceeds RUNNER_BUILD_MAX_MB={max_mb}");
    }
    Ok(())
}

/// Persistent per-app build cache root (T5.1): `/data/runner/cache/<slug>`,
/// holding `bun/`, `jup/` and `home/` (see `base_env`). Per app, never shared
/// across tenants (a shared cache would let one tenant's build poison
/// another's packages). Deleted with the app (`purge_slug`) and moved on
/// rename.
pub fn build_cache_dir(cfg: &Config, slug: &str) -> PathBuf {
    work_root(cfg).join("cache").join(slug)
}

/// Prune the persistent build cache until it fits `max_mb`
/// (RUNNER_BUILD_CACHE_MB), dropping whole caches, largest first: a cache
/// with single files missing (a pnpm release in jup's store, a package in
/// pnpm's) breaks the next build, and a missing cache only costs a download.
/// The units are the entries below `bun/`, `jup/` and `home/`; `home/` holds
/// npm's, pnpm's and Yarn's caches side by side. Symlinks are never followed
/// (`dir_bytes`, and `remove_dir_all` removes a link, not its target): like
/// `lchown_tree`, a tenant can link at `/data/noite.sqlite`. Missing dir is a
/// no-op.
pub fn prune_build_cache(dir: &Path, max_mb: u64) {
    let max = max_mb.saturating_mul(1024 * 1024);
    let mut total = dir_bytes(dir);
    if total <= max {
        return;
    }
    let mut units: Vec<(u64, PathBuf)> = Vec::new();
    for sub in [CACHE_BUN, CACHE_JUP, CACHE_HOME] {
        let Ok(rd) = std::fs::read_dir(dir.join(sub)) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let bytes = match entry.file_type() {
                Ok(t) if t.is_dir() => dir_bytes(&path),
                _ => entry.metadata().map_or(0, |m| m.len()),
            };
            units.push((bytes, path));
        }
    }
    units.sort_by_key(|u| std::cmp::Reverse(u.0));
    let mut pruned = 0u64;
    let mut pruned_bytes = 0u64;
    for (bytes, path) in units {
        if total <= max {
            break;
        }
        let removed = match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => std::fs::remove_dir_all(&path),
            _ => std::fs::remove_file(&path),
        };
        if removed.is_ok() {
            total = total.saturating_sub(bytes);
            pruned += 1;
            pruned_bytes += bytes;
        }
    }
    tracing::info!(dir = %dir.display(), pruned, pruned_bytes, max_mb, "pruned build cache");
}

/// Tenant build/release sandbox: `env_clear`, BASE_ENV + tenant vars, uid/gid
/// drop, new process group (whole tree dies on timeout via killpg), rlimits
/// (NPROC, FSIZE). Network egress is closed by the nft policy in
/// `host::netisolation`, which also covers this uid.
pub async fn run_sandboxed(
    program: &str,
    args: &[&str],
    cwd: &Path,
    sb: &Sandbox<'_>,
    timeout: Duration,
) -> anyhow::Result<String> {
    super::stats::count_spawn(program);
    use std::os::unix::process::CommandExt;
    let tmp = cwd.join(".tmp-sandbox");
    let _ = std::fs::create_dir_all(&tmp);
    // Persistent per-app cache (T5.1) when the caller hands one over;
    // otherwise the old throwaway inside the worktree.
    let cache_owned;
    let cache: &Path = match sb.cache {
        Some(dir) => dir,
        None => {
            cache_owned = cwd.join(".build-cache");
            &cache_owned
        }
    };
    for sub in [CACHE_BUN, CACHE_JUP, CACHE_HOME] {
        let _ = std::fs::create_dir_all(cache.join(sub));
    }
    // Created by the runner after the worktree was handed over: give them to
    // the sandbox user too, or TMPDIR and the build cache are unwritable.
    if let Some(uid) = sb.uid {
        let gid = sb.gid.unwrap_or(uid);
        lchown_tree(&tmp, uid, gid);
        lchown_tree(cache, uid, gid);
    }
    let drops_uid = sb.uid.is_some();
    // Move the build into its capped leaf before the build uid is applied
    // (cgroup.procs is root-owned; after setuid the write is refused), so the
    // whole step — install, build, release — runs under the build budget.
    let build_procs = match sb.cgroup {
        Some(dir) => Some(
            std::ffi::CString::new(dir.join("cgroup.procs").as_os_str().as_bytes())
                .map_err(|_| anyhow::anyhow!("build cgroup path contains a NUL byte"))?,
        ),
        None => None,
    };
    let oom_kills_before = sb.cgroup.and_then(crate::host::cgroups::build_oom_kills);
    let credentials = sb.uid.map(|uid| (uid, sb.gid.unwrap_or(uid)));
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in base_env(&tmp.to_string_lossy(), cache) {
        cmd.env(k, v);
    }
    for (k, v) in sb.env {
        cmd.env(k, v);
    }
    // The runner's own V8 ceiling (tenant `NODE_OPTIONS` is dropped in
    // `db::env`, so this name is always the runner's to set): without it a
    // 397-package pnpm install aborts after `added 397, done` on a small
    // leaf, as SIGABRT (`exit None`) with a raw V8 dump. Set after the step
    // env so nothing the step carries can narrow it.
    if let Some(flag) = node_heap_flag() {
        cmd.env("NODE_OPTIONS", flag);
    }
    // The runner's own pnpm worker cap (tenant `PNPM_MAX_WORKERS` is dropped
    // in `db::env`, so this name is always the runner's to set): pnpm sizes
    // its tarball pool from the host's CPU count, and 31 workers OOM a small
    // leaf in fetch before the heap ceiling ever matters. npm, Yarn and bun
    // ignore the name. Set after the step env like the heap ceiling above.
    if let Some(workers) = pnpm_workers_flag() {
        cmd.env("PNPM_MAX_WORKERS", workers);
    }
    {
        let std_cmd = cmd.as_std_mut();
        std_cmd.process_group(0);
        // SAFETY: pre_exec runs between fork and exec; only async-signal-safe
        // libc calls. Cgroup move, credentials, then rlimits: cgroup.procs
        // needs root, and NPROC is only meaningful for the dedicated build
        // uid (on the runner's own uid it would cap the runner and fleets).
        unsafe {
            std_cmd.pre_exec(move || {
                if let Some(path) = &build_procs {
                    let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                    if fd < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    let moved = libc::write(fd, b"0".as_ptr().cast(), 1);
                    libc::close(fd);
                    if moved != 1 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if let Some((uid, gid)) = credentials {
                    // Clear root's supplementary groups before gid/uid, or the
                    // build keeps group access it was never granted.
                    if libc::setgroups(0, std::ptr::null()) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setgid(gid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::setuid(uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if drops_uid {
                    let nproc = libc::rlimit {
                        rlim_cur: 512,
                        rlim_max: 512,
                    };
                    if libc::setrlimit(libc::RLIMIT_NPROC, &nproc) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                let fsize = libc::rlimit {
                    rlim_cur: 4 * 1024 * 1024 * 1024,
                    rlim_max: 4 * 1024 * 1024 * 1024,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &fsize) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let pid = child.id();
    // A build pinned at its cap never OOMs: it reclaims its own page cache
    // continuously, re-reading the files it just evicted, until the step
    // timeout. Sample the leaf while the step runs and kill it once the leaf
    // proves it is stuck (see `build_thrash_pinned`); the flag turns the exit
    // into the budget error below instead of a bare exit 137.
    let thrash = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Only a capped leaf can thrash; an uncapped install (0 = uncapped) has
    // no `memory.max` to pin against, so skip the sampler entirely.
    let watchdog = sb
        .cgroup
        .filter(|_| crate::host::cgroups::build_memory_mb().is_some_and(|mb| mb > 0))
        .map(|leaf| {
            let leaf = leaf.to_path_buf();
            let thrash = thrash.clone();
            tokio::spawn(async move {
                let mut pinned = 0u32;
                loop {
                    tokio::time::sleep(THRASH_SAMPLE).await;
                    pinned = if crate::host::cgroups::build_thrash_pinned(&leaf) {
                        pinned + 1
                    } else {
                        0
                    };
                    if pinned >= THRASH_SAMPLES {
                        if let Some(pid) = pid {
                            kill_group(pid);
                        }
                        thrash.store(true, std::sync::atomic::Ordering::SeqCst);
                        return;
                    }
                }
            })
        });
    // An operator stop must not wait out the step: race the token against
    // the child, kill its whole group, and let the pipeline record the
    // failure. `kill_on_drop` alone only reaches the leader. The stop is
    // carried out of the select as a value, never as a `bail!`, so the
    // thrash watchdog is aborted and the group killed by the one shared
    // cleanup below — a leaked watchdog would later `killpg` a recycled pid.
    let (result, stopped) = match super::cancel::current() {
        Some(token) => tokio::select! {
            r = tokio::time::timeout(timeout, child.wait_with_output()) => (r, false),
            () = token.cancelled() => (
                Ok(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))),
                true,
            ),
        },
        None => (
            tokio::time::timeout(timeout, child.wait_with_output()).await,
            false,
        ),
    };
    if let Some(watchdog) = watchdog {
        watchdog.abort();
    }
    // Whatever happened, nothing the step started may outlive it: a build
    // that leaves a watcher or a server behind would keep running as the
    // build uid between steps. The group id is the child's pid
    // (process_group(0)); ESRCH when the group is already empty is fine.
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: signals only the process group this call created.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    if stopped {
        bail!("cancelled by the operator");
    }
    // The watchdog's kill is the build failing to make progress at its cap,
    // not a crash: name the budget and the two ways out, like the OOM case.
    if thrash.load(std::sync::atomic::Ordering::SeqCst)
        && !matches!(&result, Ok(Ok(output)) if output.status.success())
    {
        let swap = crate::host::cgroups::build_swap_mb().unwrap_or(0);
        let swap_note = if swap > 0 {
            format!(" and {swap} MiB swap (RUNNER_BUILD_SWAP_MB)")
        } else {
            String::new()
        };
        bail!(
            "the build is not making progress inside its {} MiB memory budget (RUNNER_BUILD_MEMORY_MB{swap_note}): it stays pinned and stalls on reclaim, so it would only end at the step timeout. Raise the budget (if the box has the RAM for it) or deploy a prebuilt dist from CI; the runner and the apps kept serving",
            crate::host::cgroups::build_memory_mb().unwrap_or(0)
        );
    }
    // A rise in the leaf's OOM counter is this step outgrowing its budget:
    // say so, instead of a bare signal or timeout and a log the operator has
    // to correlate with `dmesg`. The rest of the install kept running.
    if let Some(before) = oom_kills_before {
        if sb
            .cgroup
            .and_then(crate::host::cgroups::build_oom_kills)
            .is_some_and(|after| after > before)
        {
            let swap = crate::host::cgroups::build_swap_mb().unwrap_or(0);
            let swap_note = if swap > 0 {
                format!(" plus {swap} MiB swap")
            } else {
                String::new()
            };
            // Without host swap the leaf cannot overflow past RAM at all: an
            // install that links hundreds of megabytes transiently (an
            // Ember-size tree needs ~0.5 GiB of swap on a 613 MiB leaf at 2
            // CPUs, measured) dies here even with the heap ceiling doing its
            // job. Name the missing swap, not just the RAM budget.
            let way_out = if swap > 0 {
                "Raise the budget (if the box has the RAM for it) or deploy a prebuilt dist from CI"
            } else {
                "The leaf has no swap to overflow into — RUNNER_BUILD_SWAP_MB only splits existing host swap. Add host swap, raise the budget, or deploy a prebuilt dist from CI"
            };
            bail!(
                "the build exceeded its memory budget ({} MiB, RUNNER_BUILD_MEMORY_MB{swap_note}) and the kernel killed it inside its own cgroup. {way_out}; the runner and the apps kept serving",
                crate::host::cgroups::build_memory_mb().unwrap_or(0)
            );
        }
    }
    match result {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                let out = String::from_utf8_lossy(&output.stdout);
                // A V8 heap abort (SIGABRT, `exit None`) is the step
                // outgrowing its JavaScript heap, not the leaf: name the
                // ceiling and the two budgets instead of the raw dump alone.
                // The invocation line stays first, like the generic bail
                // below: the convert step strips it (its argv carries the
                // whole converter script), and the header must survive that.
                if v8_heap_oom(&out, &err) {
                    let memory = crate::host::cgroups::build_memory_mb().unwrap_or(0);
                    let swap = crate::host::cgroups::build_swap_mb().unwrap_or(0);
                    let heap = match build_node_heap_max_mb(memory) {
                        Some(heap) => format!("{heap} MiB"),
                        None => "unset".to_string(),
                    };
                    bail!(
                        "{program} {:?} exit {:?}\nthe build step ran out of JavaScript heap (Node aborted with `FATAL ERROR: Reached heap limit`; the V8 ceiling is {heap} from a {memory} MiB RAM budget, RUNNER_BUILD_MEMORY_MB, plus {swap} MiB swap, RUNNER_BUILD_SWAP_MB). Raise the budget (if the box has the RAM for it) or deploy a prebuilt dist from CI; the runner and the apps kept serving\n{out}{err}",
                        args,
                        output.status.code()
                    );
                }
                // stdout first: a build's progress goes there and its error to
                // stderr, and the deploy log keeps the tail.
                bail!(
                    "{program} {:?} exit {:?}\n{out}{err}",
                    args,
                    output.status.code()
                );
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Err(e)) => Err(e).context("wait output"),
        Err(_) => Err(anyhow::anyhow!(
            "{program} {:?} timed out after {:?}",
            args,
            timeout
        )),
    }
}

/// SIGKILL a process group this module created (group id = leader pid).
/// ESRCH when the group is already empty is fine — the call sites run it
/// unconditionally after the wait, exactly like `run_sandboxed`.
#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: signals only the process group this call created.
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
}

/// Runner-owned command (git, celld): explicit env, piped output, and
/// — like [`run_sandboxed`] — its own process group, so a timed-out step's
/// grandchildren die with it instead of keeping its port or lock.
pub async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<String> {
    let output = run_cmd_output(program, args, cwd, env, timeout).await?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let out = String::from_utf8_lossy(&output.stdout);
        bail!(
            "{program} {:?} exit {:?}\n{err}{out}",
            args,
            output.status.code()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Run a command with stdin bytes; returns raw stdout (no UTF-8 requirement).
/// Grouped like [`run_cmd`]: a timed-out step's grandchildren die with it.
pub async fn run_cmd_stdin(
    program: &str,
    args: &[&str],
    stdin: &[u8],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    let output = run_cmd_output_stdin(program, args, Some(stdin), cwd, env, timeout).await?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{program} {:?} exit {:?}\n{err}",
            args,
            output.status.code()
        );
    }
    Ok(output.stdout)
}

/// One finished child process: its exit status plus both captured streams.
/// Unlike [`run_cmd`], a nonzero exit is data rather than an error: some
/// commands print their verdict on stdout however they exit (`celld invoke
/// --json` prints the result envelope before its nonzero exit on a non-2xx
/// answer; `celld r2 get|head --json` prints the `not_found` object for an
/// absent key), so the caller — not the spawn — decides what the status
/// means.
pub struct CmdOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Run a command and return its output however it exited: the spawn,
/// timeout and process-group kill are exactly [`run_cmd`]'s (a timeout is
/// still an error), but the exit status comes back for the caller to
/// interpret instead of failing here.
pub async fn run_cmd_output(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<CmdOutput> {
    run_cmd_output_stdin(program, args, None, cwd, env, timeout).await
}

/// [`run_cmd_output`] with the child's stdin fed, then closed: for commands
/// that answer bytes — `celld r2 get` never reads stdin, so the closed pipe
/// is never observed (the same reason [`run_cmd_stdin`] exists). `None`
/// leaves stdin inherited, as [`run_cmd`] does.
pub async fn run_cmd_output_stdin(
    program: &str,
    args: &[&str],
    stdin: Option<&[u8]>,
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<CmdOutput> {
    use tokio::io::AsyncWriteExt;
    super::stats::count_spawn(program);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let pid = child.id();
    // Feed stdin from its own task: a command that answers with more than a
    // pipe buffer holds (batch `git cat-file`) blocks on stdout, and if we
    // were still blocked writing stdin the two would deadlock.
    let writer = match stdin {
        Some(input) => {
            let mut pipe = child.stdin.take().context("stdin pipe")?;
            let input = input.to_vec();
            Some(tokio::spawn(async move {
                let _ = pipe.write_all(&input).await;
                let _ = pipe.shutdown().await;
            }))
        }
        None => None,
    };
    // An operator stop must not wait out the step: race the token against
    // the child, kill its whole group, and let the pipeline record the
    // failure. `kill_on_drop` alone only reaches the leader.
    // The stop leaves the select as a value (see `run_sandboxed`): the
    // cleanup below kills the group and reaps the stdin writer, then the
    // cancel line is the error.
    let (result, stopped) = match super::cancel::current() {
        Some(token) => tokio::select! {
            r = tokio::time::timeout(timeout, child.wait_with_output()) => (r, false),
            () = token.cancelled() => (
                Ok(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))),
                true,
            ),
        },
        None => (
            tokio::time::timeout(timeout, child.wait_with_output()).await,
            false,
        ),
    };
    // Whatever happened, nothing the step started may outlive it: the group
    // id is the child's pid (process_group(0)); ESRCH when the group is
    // already empty is fine.
    #[cfg(unix)]
    if let Some(pid) = pid {
        kill_group(pid);
    }
    let output = if stopped {
        // The pipe is closed by the kill; the writer ends on its own, and an
        // abort keeps it from outliving this call.
        if let Some(writer) = writer {
            writer.abort();
        }
        bail!("cancelled by the operator");
    } else {
        result.context("command timeout")?.context("wait output")?
    };
    if let Some(writer) = writer {
        let _ = writer.await;
    }
    Ok(CmdOutput {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// [`run_cmd_output_stdin`] with the child's stdin coming from a file instead
/// of bytes: the child reads a spooled push at its own pace, so a large push
/// is never held in RAM. Cancel, kill-group and timeout semantics match
/// [`run_cmd_output_stdin`] — keep the two in step; there is no writer task
/// because nothing is piped.
pub async fn run_cmd_output_file_stdin(
    program: &str,
    args: &[&str],
    stdin_path: &Path,
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<CmdOutput> {
    super::stats::count_spawn(program);
    let file = tokio::fs::File::open(stdin_path)
        .await
        .with_context(|| format!("open push spool {}", stdin_path.display()))?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdin(std::process::Stdio::from(file.into_std().await))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let pid = child.id();
    // Same race as [`run_cmd_output_stdin`]: an operator stop wins over the
    // step's timeout, and the group kill below reaps whatever the stop
    // leaves — there is no writer task to abort here.
    let (result, stopped) = match super::cancel::current() {
        Some(token) => tokio::select! {
            r = tokio::time::timeout(timeout, child.wait_with_output()) => (r, false),
            () = token.cancelled() => (
                Ok(Err(std::io::Error::from(std::io::ErrorKind::Interrupted))),
                true,
            ),
        },
        None => (
            tokio::time::timeout(timeout, child.wait_with_output()).await,
            false,
        ),
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        kill_group(pid);
    }
    let output = if stopped {
        bail!("cancelled by the operator");
    } else {
        result.context("command timeout")?.context("wait output")?
    };
    Ok(CmdOutput {
        status: output.status,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// [`run_cmd_stdin`] from a spooled file: the child's exit decides, and its
/// stderr explains the refusal.
pub async fn run_cmd_file_stdin(
    program: &str,
    args: &[&str],
    stdin_path: &Path,
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    let output = run_cmd_output_file_stdin(program, args, stdin_path, cwd, env, timeout).await?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{program} {:?} exit {:?}\n{err}",
            args,
            output.status.code()
        );
    }
    Ok(output.stdout)
}

pub fn work_root(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.work_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The operator's stop reaches a running step: the wait returns with the
    /// cancel line instead of holding for the step timeout, and the child is
    /// killed, not orphaned. The trip runs on the second poll — after
    /// `run_cmd_output` spawned the child (the current-thread runtime polls
    /// the join's branches in order) — so the stop lands mid-step.
    #[tokio::test]
    async fn a_cancelled_run_ends_at_once_with_the_operator_line() {
        let cancels = super::super::cancel::Cancels::default();
        let token = cancels.register("deploy-test");
        let started = std::time::Instant::now();
        let run = super::super::cancel::with(
            token,
            run_cmd_output("sleep", &["30"], None, &[], Duration::from_secs(60)),
        );
        let stop = async {
            tokio::task::yield_now().await;
            assert_eq!(
                cancels.cancel("deploy-test"),
                super::super::cancel::CancelOutcome::Signalled
            );
        };
        let (result, ()) = tokio::join!(run, stop);
        let Err(err) = result else {
            panic!("a stopped run is an error");
        };
        assert!(
            err.to_string().contains("cancelled by the operator"),
            "{err}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the stop waited {:?}",
            started.elapsed()
        );
        // The token is gone with the run (the deploy's release guard, the
        // same one the pipeline holds): a second stop answers from the row.
        cancels.release("deploy-test");
        assert_eq!(
            cancels.cancel("deploy-test"),
            super::super::cancel::CancelOutcome::Missing
        );
    }

    /// A token only exists between register and release; ids are opaque, so
    /// one deploy's stop can never touch another's.
    #[test]
    fn the_registry_trips_only_the_registered_deploy() {
        let cancels = super::super::cancel::Cancels::default();
        let token = cancels.register("a");
        assert!(!token.is_cancelled());
        assert_eq!(
            cancels.cancel("b"),
            super::super::cancel::CancelOutcome::Missing
        );
        assert_eq!(
            cancels.cancel("a"),
            super::super::cancel::CancelOutcome::Signalled
        );
        assert!(token.is_cancelled());
        cancels.release("a");
        assert_eq!(
            cancels.cancel("a"),
            super::super::cancel::CancelOutcome::Missing
        );

        // Past the point of no return the stop is refused, not half-applied.
        let committed = cancels.register("c");
        committed.commit();
        assert_eq!(
            cancels.cancel("c"),
            super::super::cancel::CancelOutcome::Committed
        );
        assert!(!committed.is_cancelled());
    }

    #[test]
    fn seed_copies_the_bundled_entry_once() {
        let root = std::env::temp_dir().join(format!("noite-seed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let seed = root.join("seed");
        let cache = root.join("cache");
        let entry = seed.join("v1").join("pnpm").join("9.9.9");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(entry.join(".jup"), "{}").unwrap();
        std::fs::write(entry.join("pnpm"), vec![0u8; 1024]).unwrap();

        // Missing seed: false, and no half-written entry left behind.
        assert!(!seed_bundled_manager(
            &root.join("absent"),
            &cache,
            "pnpm",
            "9.9.9"
        ));
        assert!(!cache.join("jup/v1/pnpm/9.9.9").exists());

        // Present seed: copies the entry with its marker.
        assert!(seed_bundled_manager(&seed, &cache, "pnpm", "9.9.9"));
        assert!(cache.join("jup/v1/pnpm/9.9.9/.jup").is_file());
        assert_eq!(
            std::fs::read(cache.join("jup/v1/pnpm/9.9.9/pnpm"))
                .unwrap()
                .len(),
            1024
        );

        // Second deploy: already seeded, no copy (a stray file survives).
        std::fs::write(cache.join("jup/v1/pnpm/9.9.9/stray"), "x").unwrap();
        assert!(seed_bundled_manager(&seed, &cache, "pnpm", "9.9.9"));
        assert!(cache.join("jup/v1/pnpm/9.9.9/stray").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_drops_whole_caches_largest_first() {
        let dir = std::env::temp_dir().join(format!("noite-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let write = |rel: &str, bytes: usize| {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, vec![0u8; bytes]).unwrap();
        };
        let mb = 1024 * 1024;
        write("jup/v1/pnpm/12.8.2/pnpm", 2 * mb);
        write("home/.local/share/pnpm/store/a", mb / 2);
        write("home/.local/share/pnpm/store/b", mb / 2);
        write("bun/pkg@1/index.js", mb / 4);

        // 3.25 MiB against a 2 MiB cap: jup's store (2 MiB) goes whole, and
        // that is enough; nothing is left half-deleted.
        prune_build_cache(&dir, 2);
        assert!(!dir.join("jup/v1").exists());
        assert!(dir.join("home/.local/share/pnpm/store/a").exists());
        assert!(dir.join("home/.local/share/pnpm/store/b").exists());
        assert!(dir.join("bun/pkg@1/index.js").exists());

        // Under the cap: untouched.
        prune_build_cache(&dir, 2);
        assert!(dir.join("home/.local").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A timed-out step must not leave grandchildren: `sh` backgrounds a
    /// `sleep` (the step's grandchild, in its process group) and waits, the
    /// timeout fires, and the group kill must reap the whole tree — the old
    /// `kill_on_drop`-only code left the sleep holding the step's port.
    #[tokio::test]
    async fn run_cmd_timeout_kills_grandchildren() {
        // Unique per test-process run: a fixed marker lets a sleeper
        // orphaned by an aborted earlier run (a killed test binary never
        // reaches the group kill) satisfy this run's /proc scan, failing it
        // until someone kills the stale sleeper by hand. The guard kills
        // this run's marker on every exit path — pass, fail or panic — so
        // this test never orphans one itself.
        let marker = format!("31337{}", std::process::id());
        let _cleanup = crate::testutil::KillMarkerOnDrop::new(&marker);
        let script = format!("sleep {marker} & wait");
        let err = run_cmd(
            "sh",
            &["-c", script.as_str()],
            None,
            &[],
            Duration::from_secs(2),
        )
        .await
        .expect_err("sleep must hit the timeout");
        assert!(err.to_string().contains("command timeout"), "{err:#}");
        assert!(
            crate::testutil::wait_for_cmdline_gone(&marker, Duration::from_secs(5)).await,
            "timed-out step left a grandchild behind (sleep {marker} still live 5s after the group kill)"
        );
    }

    /// The clone's size walk never fails: an entry that vanishes between the
    /// listing and the stat (git renames lock/tmp files aside mid-clone)
    /// counts as nothing instead of failing the walk with ENOENT — the poll
    /// in `run_grouped` must not turn clone churn into a failed clone.
    #[test]
    fn dir_bytes_skips_what_is_not_there() {
        let dir = crate::testutil::TempDir::new("noite-dir-bytes");
        std::fs::write(dir.path().join("a"), "12345").expect("seed file");
        assert_eq!(dir_bytes(dir.path()), 5);
        assert_eq!(dir_bytes(&dir.path().join("missing")), 0);
    }

    /// The build leaf's V8 ceiling is three quarters of its RAM cap: a 613
    /// MiB leaf (a 1.6 GiB box) gives pnpm 459 MB, past the ~320 MB an Ember
    /// install needs where V8's default half-of-cgroup (~306 MB) aborts it.
    /// Uncapped builds (`0`) keep the old behavior: no `NODE_OPTIONS`.
    #[test]
    fn the_heap_ceiling_is_three_quarters_of_the_ram_cap() {
        assert_eq!(build_node_heap_max_mb(0), None);
        assert_eq!(build_node_heap_max_mb(613), Some(459));
        assert_eq!(build_node_heap_max_mb(512), Some(384));
        assert_eq!(build_node_heap_max_mb(1024), Some(768));
        assert_eq!(build_node_heap_max_mb(4096), Some(3072));
    }

    /// The V8 signature matches the real abort (Ember's deploy log, beta.4:
    /// `jup ["install"] exit None` over a `FATAL ERROR: Reached heap limit`
    /// dump) and not an ordinary step failure, so only a heap abort earns
    /// the budget error.
    #[test]
    fn the_heap_signature_matches_only_a_v8_abort() {
        let out = "Progress: resolved 397, reused 397, downloaded 0, added 397, done\n";
        let err = "<--- Last few GCs --->\n\
             [22:0x26912000] 1288 ms: Mark-Compact 307.1 (436.4) -> 302.7 (433.1) MB, \
             pooled: 3 MB, 15.83 / 0.00 ms allocation failure\n\
             FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
        assert!(v8_heap_oom(out, err));
        assert!(!v8_heap_oom(
            "Progress: resolved 397, reused 397, downloaded 0, added 397, done\n",
            "ERR_PNPM_NO_MATCHING_VERSION No matching version found for foo@^99\n"
        ));
        assert!(!v8_heap_oom("", ""));
    }

    /// The runner's own V8 ceiling reaches the step: with a 613 MiB build
    /// budget the step sees `NODE_OPTIONS=--max-old-space-size=459`, and a
    /// value under the name can never narrow the runner's — tenant
    /// `NODE_OPTIONS` is dropped in `db::env`, so the runner owns it.
    #[tokio::test]
    async fn run_sandboxed_sets_the_runner_heap_ceiling() {
        crate::host::cgroups::set_build_budgets_for_tests(613, 0);
        let dir = crate::testutil::TempDir::new("noite-node-heap");
        let sb = Sandbox {
            uid: None,
            gid: None,
            env: &[("NODE_OPTIONS", "--max-old-space-size=128")],
            cache: None,
            cgroup: None,
        };
        let out = run_sandboxed(
            "sh",
            &["-c", "echo $NODE_OPTIONS"],
            dir.path(),
            &sb,
            Duration::from_secs(30),
        )
        .await
        .expect("echo the step env");
        assert!(
            out.trim_end().ends_with("--max-old-space-size=459"),
            "the runner's ceiling wins, got {out:?}"
        );
    }

    /// The pnpm worker cap follows RAM and the leaf's CPU share: 613 MiB
    /// with 31 cores still gets 1 worker (half a GiB each), a 4096 MiB leaf
    /// with room gets 8, and uncapped builds (`0`) keep the old behavior.
    #[test]
    fn the_worker_cap_follows_ram_and_cpu_share() {
        assert_eq!(build_pnpm_workers_max(0, 31), None);
        assert_eq!(build_pnpm_workers_max(613, 31), Some(1));
        assert_eq!(build_pnpm_workers_max(613, 1), Some(1));
        assert_eq!(build_pnpm_workers_max(1024, 3), Some(2));
        assert_eq!(build_pnpm_workers_max(4096, 31), Some(8));
        assert_eq!(build_pnpm_workers_max(4096, 1), Some(1));
    }

    /// The runner's own worker cap reaches the step: with a 613 MiB build
    /// budget the step sees `PNPM_MAX_WORKERS=1` on any host, and a step
    /// value under the name can never widen the runner's — tenant
    /// `PNPM_MAX_WORKERS` is dropped in `db::env`, so the runner owns it.
    #[tokio::test]
    async fn run_sandboxed_sets_the_runner_worker_cap() {
        crate::host::cgroups::set_build_budgets_for_tests(613, 0);
        let dir = crate::testutil::TempDir::new("noite-pnpm-workers");
        let sb = Sandbox {
            uid: None,
            gid: None,
            env: &[("PNPM_MAX_WORKERS", "31")],
            cache: None,
            cgroup: None,
        };
        let out = run_sandboxed(
            "sh",
            &["-c", "echo $PNPM_MAX_WORKERS"],
            dir.path(),
            &sb,
            Duration::from_secs(30),
        )
        .await
        .expect("echo the step env");
        assert_eq!(out.trim_end(), "1", "the runner's cap wins, got {out:?}");
    }

    /// A heap abort keeps the invocation line first: the convert step strips
    /// it (its argv carries the whole converter script), so the header must
    /// sit on line two to survive — first-line strippers then keep it too.
    #[tokio::test]
    async fn run_sandboxed_heap_abort_keeps_invocation_first() {
        crate::host::cgroups::set_build_budgets_for_tests(613, 0);
        let dir = crate::testutil::TempDir::new("noite-heap-shape");
        let sb = Sandbox {
            uid: None,
            gid: None,
            env: &[],
            cache: None,
            cgroup: None,
        };
        let err = run_sandboxed(
            "sh",
            &[
                "-c",
                "echo 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' >&2; exit 1",
            ],
            dir.path(),
            &sb,
            Duration::from_secs(30),
        )
        .await
        .expect_err("a failing step is an error");
        let message = err.to_string();
        let mut lines = message.lines();
        let first = lines.next().unwrap_or("");
        assert!(
            first.starts_with("sh "),
            "invocation first, got {message:?}"
        );
        assert!(
            message.contains("the build step ran out of JavaScript heap"),
            "header survives, got {message:?}"
        );
    }
}
