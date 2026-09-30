//! Which package manager installs and builds a tenant project (SPEC, Package
//! managers).
//!
//! bun ships in the image and stays the default. Everything else runs through
//! jup (https://github.com/unjs/jup), which downloads the manager into the
//! app's own cache, verifies it against the registry signature, and runs it:
//!
//! 1. A pin in package.json (`packageManager`, `devEngines.packageManager`):
//!    jup runs exactly that, bun included.
//! 2. No pin, a lockfile: the manager that wrote it. jup does not guess from
//!    lockfiles, so the runner hands it a spec file (`JUP_SPEC_FILE`, outside
//!    the tree) naming the manager and the major the lockfile needs. The same
//!    spec reaches `npm`/`pnpm`/`yarn` called from package scripts through
//!    the image's jup shims.
//! 3. Neither: bun.

use std::path::Path;

use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
pub struct PackageManager {
    /// `bun`, `npm`, `pnpm`, `yarn`, or whatever a pin names.
    pub name: String,
    /// Why this one, for the deploy log.
    pub reason: String,
    via_jup: bool,
    /// The version range jup should run when the project pins nothing.
    spec_version: Option<&'static str>,
}

impl PackageManager {
    fn bun(reason: &str) -> Self {
        Self { name: "bun".into(), reason: reason.into(), via_jup: false, spec_version: None }
    }

    /// Program and arguments for the install step.
    pub fn install(&self) -> (&str, Vec<&str>) {
        if self.via_jup {
            ("jup", vec!["install"])
        } else {
            ("bun", vec!["install"])
        }
    }

    /// Program and arguments for `run <script>`.
    pub fn run<'a>(&self, script: &'a str) -> (&str, Vec<&'a str>) {
        if self.via_jup {
            ("jup", vec!["run", script])
        } else {
            ("bun", vec!["run", script])
        }
    }

    /// The `JUP_SPEC_FILE` contents for an unpinned project, in package.json
    /// shape; `None` when the project's own pin decides or bun runs.
    pub fn spec_file(&self) -> Option<String> {
        let version = self.spec_version?;
        Some(json!({ "devEngines": { "packageManager": { "name": self.name, "version": version } } }).to_string())
    }
}

/// The package manager for the project at `src_dir` with manifest `package`.
pub fn detect(src_dir: &Path, package: &Value) -> PackageManager {
    if let Some((name, pin)) = pinned(package) {
        return PackageManager {
            reason: format!("pinned: {pin}"),
            name,
            via_jup: true,
            spec_version: None,
        };
    }
    for lock in ["bun.lock", "bun.lockb"] {
        if src_dir.join(lock).is_file() {
            return PackageManager::bun(lock);
        }
    }
    let unpinned = |name: &str, lock: &str, version: &'static str| PackageManager {
        name: name.into(),
        reason: lock.into(),
        via_jup: true,
        spec_version: Some(version),
    };
    if let Some(head) = lockfile_head(&src_dir.join("pnpm-lock.yaml")) {
        return unpinned("pnpm", "pnpm-lock.yaml", pnpm_range(&head));
    }
    if let Some(head) = lockfile_head(&src_dir.join("yarn.lock")) {
        // Yarn 1 wrote this header; Yarn 2+ writes `__metadata`. Unpinned,
        // jup would pick Yarn 4, which refuses a v1 lockfile.
        let version = if head.contains("# yarn lockfile v1") { "^1" } else { "*" };
        return unpinned("yarn", "yarn.lock", version);
    }
    for lock in ["package-lock.json", "npm-shrinkwrap.json"] {
        if src_dir.join(lock).is_file() {
            return unpinned("npm", lock, "*");
        }
    }
    PackageManager::bun("default")
}

/// `(name, pin as written)` when package.json pins a manager with a version.
/// `devEngines.packageManager` wins when it names a version, as in jup.
fn pinned(package: &Value) -> Option<(String, String)> {
    let dev = package.get("devEngines").and_then(|d| d.get("packageManager"));
    // npm allows an array of alternatives; jup reads the first.
    let dev = match dev {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    if let Some(dev) = dev {
        let name = dev.get("name").and_then(Value::as_str);
        let version = dev.get("version").and_then(Value::as_str);
        if let (Some(name), Some(version)) = (name, version) {
            return Some((name.to_string(), format!("devEngines.packageManager {name}@{version}")));
        }
    }
    let field = package.get("packageManager").and_then(Value::as_str)?;
    let (name, version) = field.split_once('@')?;
    if name.is_empty() || version.is_empty() {
        return None;
    }
    Some((name.to_string(), format!("packageManager {field}")))
}

/// The first lines of a lockfile, enough for its format marker.
fn lockfile_head(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = [0u8; 512];
    let n = std::fs::File::open(path).ok()?.read(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf[..n]).into_owned())
}

/// The pnpm major a `pnpm-lock.yaml` format needs (jup's own table; newer
/// pnpm rewrites an older lockfile and `--frozen-lockfile`, the CI default,
/// then fails).
fn pnpm_range(head: &str) -> &'static str {
    let version = head
        .lines()
        .find_map(|l| l.trim().strip_prefix("lockfileVersion:"))
        .map(|v| v.trim().trim_matches(['\'', '"']))
        .unwrap_or("");
    match version {
        "6.0" | "6.1" => "^8",
        "5.4" => "^7",
        "5.3" => "^6",
        v if v.starts_with("5.") || v == "5" => "^5",
        _ => "*",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn project(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("noite-pm-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (file, text) in files {
            std::fs::write(dir.join(file), text).unwrap();
        }
        dir
    }

    fn spec(pm: &PackageManager) -> Option<Value> {
        pm.spec_file().map(|s| serde_json::from_str(&s).unwrap())
    }

    #[test]
    fn a_pin_wins_and_needs_no_spec() {
        let dir = project("pin", &[("bun.lock", "")]);
        let pm = detect(&dir, &json!({ "packageManager": "pnpm@9.15.0+sha512.abc" }));
        assert_eq!(pm.name, "pnpm");
        assert_eq!(pm.install(), ("jup", vec!["install"]));
        assert_eq!(pm.run("build"), ("jup", vec!["run", "build"]));
        assert!(pm.spec_file().is_none());
        assert!(pm.reason.contains("pnpm@9.15.0"), "{}", pm.reason);

        let pm = detect(
            &dir,
            &json!({ "packageManager": "yarn@1.22.22", "devEngines": { "packageManager": { "name": "bun", "version": "^1.2" } } }),
        );
        assert_eq!(pm.name, "bun");
        assert_eq!(pm.install().0, "jup", "a pinned bun version comes from jup too");
    }

    #[test]
    fn a_bare_name_is_no_pin() {
        let dir = project("bare", &[]);
        assert_eq!(detect(&dir, &json!({ "packageManager": "pnpm" })).name, "bun");
        let pm = detect(&dir, &json!({ "devEngines": { "packageManager": { "name": "pnpm" } } }));
        assert_eq!(pm.name, "bun");
    }

    #[test]
    fn lockfiles_pick_the_manager_and_its_major() {
        let pnpm9 = project("pnpm9", &[("pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nsettings:\n")]);
        let pm = detect(&pnpm9, &json!({}));
        assert_eq!((pm.name.as_str(), pm.reason.as_str()), ("pnpm", "pnpm-lock.yaml"));
        assert_eq!(spec(&pm).unwrap()["devEngines"]["packageManager"], json!({ "name": "pnpm", "version": "*" }));

        let pnpm8 = project("pnpm8", &[("pnpm-lock.yaml", "lockfileVersion: '6.0'\n")]);
        assert_eq!(spec(&detect(&pnpm8, &json!({}))).unwrap()["devEngines"]["packageManager"]["version"], "^8");

        let yarn1 = project("yarn1", &[("yarn.lock", "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n\n")]);
        let pm = detect(&yarn1, &json!({}));
        assert_eq!(pm.name, "yarn");
        assert_eq!(spec(&pm).unwrap()["devEngines"]["packageManager"]["version"], "^1");

        let berry = project("berry", &[("yarn.lock", "__metadata:\n  version: 8\n")]);
        assert_eq!(spec(&detect(&berry, &json!({}))).unwrap()["devEngines"]["packageManager"]["version"], "*");

        let npm = project("npm", &[("package-lock.json", "{}")]);
        let pm = detect(&npm, &json!({}));
        assert_eq!(pm.name, "npm");
        assert_eq!(pm.install(), ("jup", vec!["install"]));
    }

    #[test]
    fn bun_is_the_default_and_wins_a_mixed_tree() {
        let none = project("none", &[]);
        let pm = detect(&none, &json!({}));
        assert_eq!((pm.name.as_str(), pm.reason.as_str()), ("bun", "default"));
        assert_eq!(pm.install(), ("bun", vec!["install"]));
        assert!(pm.spec_file().is_none());

        let mixed = project("mixed", &[("bun.lock", ""), ("package-lock.json", "{}")]);
        assert_eq!(detect(&mixed, &json!({})).name, "bun");
    }

    #[test]
    fn pnpm_lockfile_versions() {
        assert_eq!(pnpm_range("lockfileVersion: 5.4\n"), "^7");
        assert_eq!(pnpm_range("lockfileVersion: '6.1'\n"), "^8");
        assert_eq!(pnpm_range("lockfileVersion: \"5.3\"\n"), "^6");
        assert_eq!(pnpm_range("lockfileVersion: 5.1\n"), "^5");
        assert_eq!(pnpm_range("garbage"), "*");
    }
}
