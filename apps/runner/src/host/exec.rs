//! Tenant build/release sandbox and the runner's command runner: explicit
//! environments, uid/gid drop, rlimits, and the process-group kill that keeps
//! a step from outliving its timeout. S3 lives in `host::s3`; git tip bundles
//! in `host::tips`.

use anyhow::{bail, Context};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

use crate::config::Config;

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

/// Subdirectories of a per-app build cache root.
const CACHE_BUN: &str = "bun";
const CACHE_JUP: &str = "jup";
const CACHE_HOME: &str = "home";

/// Tenant sandbox: uid/gid drop + explicit env (SPEC, Build and release sandbox).
/// `uid: None` = current user (dev only, single-tenant).
/// `cache: None` = a throwaway `.build-cache` inside the worktree; `Some` =
/// the persistent per-app cache root (T5.1).
pub struct Sandbox<'a> {
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub env: &'a [(&'a str, &'a str)],
    pub cache: Option<&'a Path>,
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
    {
        let std_cmd = cmd.as_std_mut();
        if let Some(uid) = sb.uid {
            std_cmd.uid(uid);
        }
        if let Some(gid) = sb.gid {
            std_cmd.gid(gid);
        }
        std_cmd.process_group(0);
        // SAFETY: pre_exec runs between fork and exec; only async-signal-safe
        // libc calls. setrlimit bounds fork bombs (NPROC) and runaway
        // outputs (FSIZE 4 GiB).
        unsafe {
            std_cmd.pre_exec(move || {
                // RLIMIT_NPROC counts every process of the real uid, so it is
                // only meaningful for the dedicated build uid; on the
                // runner's own uid (dev, single tenancy) it would cap the
                // runner and its fleets too.
                if drops_uid {
                    let nproc = libc::rlimit {
                        rlim_cur: 512,
                        rlim_max: 512,
                    };
                    libc::setrlimit(libc::RLIMIT_NPROC, &nproc);
                }
                let fsize = libc::rlimit {
                    rlim_cur: 4 * 1024 * 1024 * 1024,
                    rlim_max: 4 * 1024 * 1024 * 1024,
                };
                libc::setrlimit(libc::RLIMIT_FSIZE, &fsize);
                Ok(())
            });
        }
    }
    let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let pid = child.id();
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
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
    match result {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                let out = String::from_utf8_lossy(&output.stdout);
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

pub async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<String> {
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
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .context("command timeout")?
        .context("wait output")?;
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
pub async fn run_cmd_stdin(
    program: &str,
    args: &[&str],
    stdin: &[u8],
    cwd: Option<&Path>,
    timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncWriteExt;
    super::stats::count_spawn(program);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(stdin).await.context("write stdin")?;
        pipe.shutdown().await.ok();
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .context("command timeout")?
        .context("wait output")?;
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
}
