//! Tenancy mode + isolation self-checks (SPEC, Tenancy mode).
//!
//! `NOITE_TENANCY=single|multi` (default multi off localhost). In `multi`,
//! boot runs isolation self-checks (build uid drop works, nft table
//! installed, fleet uid drop works). Any failure keeps `/ready` at 503 with
//! the reason; invites/signups are refused while checks fail (enforced by the
//! control UI reading `/ready`; the runner also refuses builds). In `single`
//! checks run and warn, nothing is refused.

use crate::config::{Config, Tenancy};
use crate::host::{cmd, netisolation};

#[derive(Clone, Debug, Default)]
pub struct IsolationStatus {
    pub tenancy: String,
    pub build_uid_ok: bool,
    pub fleet_uid_ok: bool,
    pub nft_ok: bool,
    pub detail: String,
    /// Hard failure in multi (blocks /ready + builds).
    pub blocked: bool,
}

pub async fn self_check(cfg: &Config, nft_installed: bool) -> IsolationStatus {
    let build_uid_ok = match (cfg.build_uid, cfg.build_gid) {
        (Some(u), Some(g)) => cmd::can_drop_uid(u, g),
        (Some(u), None) => cmd::can_drop_uid(u, u),
        _ => false,
    };
    let fleet_uid_ok = match (cfg.fleet_uid, cfg.fleet_gid) {
        (Some(u), Some(g)) => cmd::can_drop_uid(u, g),
        (Some(u), None) => cmd::can_drop_uid(u, u),
        _ => false,
    };
    let (nft_ok, nft_detail) = if nft_installed {
        (true, "nft noite table installed".to_string())
    } else {
        netisolation::status()
    };
    let mut problems = Vec::new();
    if !build_uid_ok {
        problems.push("build uid drop unavailable (needs CAP_SETUID/CAP_SETGID)".to_string());
    }
    if !fleet_uid_ok {
        problems.push("fleet uid drop unavailable (needs CAP_SETUID/CAP_SETGID)".to_string());
    }
    if !nft_ok {
        problems.push(format!("egress policy missing ({nft_detail})"));
    }
    let blocked = cfg.tenancy == Tenancy::Multi && !problems.is_empty();
    if blocked {
        tracing::error!(tenancy = "multi", problems = ?problems, "isolation self-check failed");
    } else if !problems.is_empty() {
        tracing::warn!(tenancy = %cfg.tenancy.as_str(), problems = ?problems, "isolation self-check warnings");
    }
    IsolationStatus {
        tenancy: cfg.tenancy.as_str().to_string(),
        build_uid_ok,
        fleet_uid_ok,
        nft_ok,
        detail: problems.join("; "),
        blocked,
    }
}

/// Keep platform files away from the sandboxed users (SPEC, Data directory).
///
/// The runner runs with umask 077, so everything it and its children create
/// is private. Existing state from earlier boots is tightened too: the
/// SQLite database, git mirrors, control and Caddy state become owner-only.
/// The sandboxed users need to reach what was handed to them
/// (`builds/<slug>/<ts>` for builds, `fleets/<slug>` for fleets), and bun
/// resolves a project by listing its parent directories, so those parents
/// are 0755: names are visible, contents are not (everything in them is
/// owner-only).
///
/// Known limit: every build runs as the one `build` uid, so two builds that
/// run at the same moment can read each other's worktree until the runner
/// takes each tree back. A uid per build would close that window.
#[cfg(unix)]
pub fn harden_data_dir(cfg: &Config) {
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    // SAFETY: umask only changes this process's file-creation mask.
    unsafe {
        libc::umask(0o077);
    }
    let set = |path: &Path, mode: u32| {
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    };
    let work = PathBuf::from(&cfg.work_dir);
    let traverse: Vec<PathBuf> = {
        let mut dirs = vec![work.join("builds"), work.join("fleets"), work.join("cache")];
        let _ = dirs.iter().try_for_each(std::fs::create_dir_all);
        dirs.push(work.clone());
        if let Some(root) = work.parent() {
            dirs.push(root.to_path_buf());
        }
        dirs
    };
    for dir in &traverse {
        set(dir, 0o755);
    }
    // Per-slug build/cache parents: builds/<slug>/ and cache/<slug>/ too.
    // The bun cache leaf itself stays owner-only (build uid after the
    // deploy hands it over), so the fleet uid can traverse but never read.
    for top in ["builds", "cache"] {
        if let Ok(entries) = std::fs::read_dir(work.join(top)) {
            for entry in entries.flatten() {
                set(&entry.path(), 0o755);
            }
        }
    }
    // Everything else directly under the volume root and the work dir.
    for dir in [work.parent().map(Path::to_path_buf), Some(work.clone())]
        .into_iter()
        .flatten()
    {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if traverse.contains(&path) {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            set(&path, if is_dir { 0o700 } else { 0o600 });
        }
    }
    // The database and its sidecars, wherever NOITE_DB points.
    if let Some(db) = crate::db::local_db_path(cfg) {
        for suffix in ["", "-wal", "-shm"] {
            set(Path::new(&format!("{}{suffix}", db.display())), 0o600);
        }
    }
}

#[cfg(not(unix))]
pub fn harden_data_dir(_cfg: &Config) {}
