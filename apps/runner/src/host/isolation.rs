//! Tenancy mode + isolation self-checks (SPEC, Tenancy mode).
//!
//! `NOITE_TENANCY=single|multi` (default multi off localhost). In `multi`,
//! boot runs isolation self-checks (build uid drop works, nft table
//! installed, fleet uid drop works, per-fleet cgroups set up). Any failure
//! keeps `/ready` at 503 with the reason; invites/signups are refused while
//! checks fail (enforced by the control UI reading `/ready`; the runner also
//! refuses builds). In `single` checks run and warn, nothing is refused.

use crate::config::{Config, Tenancy};
use crate::host::{cgroups, exec, netisolation};

/// One isolation capability's state. It used to be a bare `bool` with a reason
/// string next to it, so "the probe never ran" (dev image), "this install never
/// has it" (single tenancy) and "it worked and then failed" (a fleet's cgroup
/// refused after boot) all read as `false`.
///
/// ```text
/// stateDiagram-v2
///     Unprobed --> Ok: boot probe passed
///     Unprobed --> Unavailable: boot probe failed (reason)
/// ```
///
/// A capability that fails *after* boot is not stored here. The cgroup check
/// is re-read from the filesystem on every [`IsolationStatus::failures`] call,
/// so a leaf whose mount went away blocks `/ready` at once. Egress (nft) has
/// no such read — it needs a process to inspect — so `netisolation::status()`
/// is the last *observed* state: a table flushed out-of-band keeps reading
/// `ok` until the 30 s refresh pass re-applies it, and this type does not
/// pretend otherwise.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Capability {
    /// The boot probe has not run (or this is a test fixture).
    #[default]
    Unprobed,
    /// The capability works; `detail` is the probe's own wording.
    Ok { detail: String },
    /// It does not work on this install, for `reason`.
    Unavailable { reason: String },
}

impl Capability {
    /// The reason it is not in place, when it is not.
    pub fn failure(&self) -> Option<String> {
        match self {
            Capability::Unprobed => Some("not probed".to_string()),
            Capability::Ok { .. } => None,
            Capability::Unavailable { reason } => Some(reason.clone()),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct IsolationStatus {
    pub tenancy: String,
    pub build_uid: Capability,
    pub fleet_uid: Capability,
    pub nft: Capability,
    pub cgroups: Capability,
    /// Every warning the check produced, joined; `/ready` and `make doctor`
    /// print this next to the failing capabilities.
    pub detail: String,
    /// What tenant fleets hold (SPEC, Scoped credentials): `scoped (...)`
    /// or `root (<why>)`. Root is an explicit documented mode, not a block.
    pub credentials: String,
}

impl IsolationStatus {
    /// Hard failure in multi (blocks `/ready` and builds). Derived, never
    /// stored: the boot warnings plus anything that failed since.
    pub fn blocked(&self) -> bool {
        self.tenancy == "multi" && !self.failures().is_empty()
    }

    /// Everything that makes the isolation checks fail right now, as
    /// operator-readable sentences: the boot capabilities joined with the
    /// *live* cgroup and egress probes. This is what `/ready` and
    /// `make doctor` report, so an install that loses its nft table or has a
    /// fleet's cgroup refused after boot no longer reads healthy.
    ///
    /// The credential mode is deliberately not here: root bucket keys in
    /// `multi` are an explicit, documented mode (`self.detail` records it as a
    /// warning, `credentials` names it on every answer), not a contained
    /// failure, and blocking on it would 503 every install on R2, Tigris or
    /// plain AWS keys.
    pub fn failures(&self) -> Vec<String> {
        // The boot snapshot's warnings are already joined in `detail`; the
        // capabilities are added here so a caller that built the status from
        // parts still gets the unproven ones. Duplicates are dropped.
        let mut out: Vec<String> = Vec::new();
        let push = |out: &mut Vec<String>, failure: String| {
            if !out.contains(&failure) {
                out.push(failure);
            }
        };
        for (name, cap) in [
            ("build uid drop", &self.build_uid),
            ("fleet uid drop", &self.fleet_uid),
            ("egress policy", &self.nft),
            ("per-fleet cgroups", &self.cgroups),
        ] {
            if let Some(why) = cap.failure() {
                push(&mut out, format!("{name}: {why}"));
            }
        }
        // Live probe: the cgroup anchor is a directory tree, so this one can
        // be re-read for real — a leaf whose mount went away reads failed.
        let (cgroups_ok, cgroups_detail) = cgroups::live_status();
        if !cgroups_ok {
            push(&mut out, format!("per-fleet cgroups: {cgroups_detail}"));
        }
        let (nft_ok, nft_detail) = netisolation::status();
        if !nft_ok {
            push(&mut out, format!("egress policy: {nft_detail}"));
        }
        out
    }
}

pub async fn self_check(cfg: &Config, nft_installed: bool) -> IsolationStatus {
    // One probe is enough: every uid in the range drops the same way.
    let build_uid_ok = match cfg.build_uid_base {
        Some(base) => exec::can_drop_uid(base, base),
        None => false,
    };
    let fleet_uid_ok = match (cfg.fleet_uid, cfg.fleet_gid) {
        (Some(u), Some(g)) => exec::can_drop_uid(u, g),
        (Some(u), None) => exec::can_drop_uid(u, u),
        _ => false,
    };
    let (nft_ok, nft_detail) = if nft_installed {
        (true, "nft noite table installed".to_string())
    } else {
        netisolation::status()
    };
    let (cgroup_ok, cgroup_detail) = cgroups::status();
    let build_uid = capability(
        build_uid_ok,
        "build uid drop unavailable (needs CAP_SETUID/CAP_SETGID)",
        "build uid drop works",
    );
    let fleet_uid = capability(
        fleet_uid_ok,
        "fleet uid drop unavailable (needs CAP_SETUID/CAP_SETGID)",
        "fleet uid drop works",
    );
    let nft = capability(nft_ok, &nft_detail, &nft_detail);
    let cgroups = capability(cgroup_ok, &cgroup_detail, &cgroup_detail);
    let mut problems: Vec<String> = [
        ("build uid drop", &build_uid),
        ("fleet uid drop", &fleet_uid),
        ("egress policy", &nft),
        ("per-fleet cgroups", &cgroups),
    ]
    .into_iter()
    .filter_map(|(name, cap)| cap.failure().map(|why| format!("{name}: {why}")))
    .collect();
    // Root bucket keys in multi are explicit, not silent: warn loudly here
    // (and in the boot log, /ready and doctor) without blocking.
    let credentials = cfg.credentials.summary();
    if !cfg.credentials.is_scoped() {
        if cfg.tenancy == Tenancy::Multi {
            tracing::warn!(credentials = %credentials, "multi-tenant install without scoped bucket keys");
        }
        problems.push(format!(
            "tenant fleets hold the root bucket keys ({credentials})"
        ));
    }
    let status = IsolationStatus {
        tenancy: cfg.tenancy.as_str().to_string(),
        build_uid,
        fleet_uid,
        nft,
        cgroups,
        detail: problems.join("; "),
        credentials,
    };
    if status.blocked() {
        tracing::error!(tenancy = "multi", problems = ?problems, "isolation self-check failed");
    } else if !problems.is_empty() {
        tracing::warn!(tenancy = %cfg.tenancy.as_str(), problems = ?problems, "isolation self-check warnings");
    }
    status
}

/// One capability from a probe's verdict: `ok` carries the probe's own detail,
/// a failure its reason.
fn capability(ok: bool, failure: &str, success: &str) -> Capability {
    if ok {
        Capability::Ok {
            detail: success.to_string(),
        }
    } else {
        Capability::Unavailable {
            reason: failure.to_string(),
        }
    }
}

/// Keep platform files away from the sandboxed users (SPEC, Data directory).
///
/// The runner runs with umask 077, so everything it and its children create
/// is private. Existing state from earlier boots is tightened too: the
/// SQLite database, git mirrors, control and Caddy state become owner-only.
/// The sandboxed users need to reach what was handed to them
/// (`builds/<slug>/<ts>` for builds, `fleets/<slug>` and
/// `envs/<slug>/<label>` for fleets), and bun
/// resolves a project by listing its parent directories, so those parents
/// are 0755: names are visible, contents are not (everything in them is
/// owner-only).
///
/// Each app's builds run as their own uid (`db::ensure_app_build_uid`), so
/// the 0700 worktree and cache leaves are readable by that app alone — a
/// sibling build's uid cannot even enter them.
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
        let mut dirs = vec![
            work.join("builds"),
            work.join("fleets"),
            work.join("envs"),
            work.join("cache"),
        ];
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
    // Per-slug build/cache/environment parents: builds/<slug>/, cache/<slug>/
    // and envs/<slug>/ too. The bun cache leaf itself stays owner-only (build
    // uid after the deploy hands it over), so the fleet uid can traverse but
    // never read.
    for top in ["builds", "cache", "envs"] {
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
