//! The config `celld deploy` takes after a build (SPEC, Deploy pipeline):
//! what the build produced, not the pushed source config.
//!
//! 1. `dist/wrangler.json`, a celld-ready config the build wrote (on Vite or
//!    Rsbuild alike).
//! 2. Void's own `dist/ssr/wrangler.json` (`void` on Vite, assets in
//!    `dist/client/`).
//! 3. Wrangler's deploy redirect, `.wrangler/deploy/config.json`, which
//!    `@cloudflare/vite-plugin` writes beside `dist/<worker>/wrangler.json`.
//!
//! celld refuses 2 and 3 as they are (Wrangler-only keys, an assets
//! directory at `../client`, `.assetsignore`), so each is rewritten into a
//! `wrangler.json` at the nearest directory holding both the Worker and its
//! assets.
//!
//! Only consulted when a build ran in this deploy, so a committed `dist/` or
//! `.wrangler/` never outranks the source config of a tree nothing built.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context};
use serde_json::Value;

/// Wrangler's redirected configuration, relative to the project root.
pub const DEPLOY_REDIRECT: &str = ".wrangler/deploy/config.json";

/// The Worker config Void (`void` on Vite) writes, relative to the project
/// root.
pub const VOID_OUTPUT: &str = "dist/ssr/wrangler.json";

/// Top-level keys `celld deploy` 0.6 accepts; any other key fails the deploy
/// (the celld key allowlist). celld also accepts `no_bundle`, but it is
/// dropped on purpose: the Vite plugin sets it so Wrangler skips esbuild, and
/// celld would then load split chunks it cannot resolve.
/// `containers` holds the celld 0.6 container classes Sandbox templates
/// (the agent template) deploy into.
const CELLD_KEYS: &[&str] = &[
    "$schema",
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "durable_objects",
    "migrations",
    "assets",
    "services",
    "triggers",
    "vars",
    "d1_databases",
    "kv_namespaces",
    "queues",
    "workflows",
    "r2_buckets",
    "containers",
];

const WRANGLER_NAMES: &[&str] = &["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/// The deploy root's `containers[]`, normalized for celld 0.6.3 and with
/// every Dockerfile it names still to prepare ([`ContainersPlan`]).
/// `Ok(None)` when the config declares no containers.
///
/// Normalized: Void and Cloudflare's Sandbox SDK 1.0 shape
/// (`scheduling_policy: "durable_object"`, `images.default.{dockerfile,
/// build_context}` or `images.default.image`), which celld does not model,
/// becomes celld's single `image`. Refused, each a deploy-log error: a
/// `runtime` key (the OCI runtime is operator-owned; celld lets a class
/// override the node default), another scheduling policy, a malformed
/// `images`, and any entry at all when `NOITE_SANDBOX` disabled Sandbox
/// containers for the install. A Dockerfile is not refused here: it is
/// built only after [`crate::host::container_image`] checked that it runs
/// nothing. Anything else malformed is celld's to reject: it validates
/// before it pulls, so a pass here never starts work a refusal would have
/// stopped.
pub fn plan_containers(
    deploy_root: &Path,
    sandbox_disabled: bool,
) -> anyhow::Result<Option<ContainersPlan>> {
    let mut found = None;
    for name in ["wrangler.jsonc", "wrangler.json"] {
        if let Ok(text) = std::fs::read_to_string(deploy_root.join(name)) {
            found = Some((name, text));
            break;
        }
    }
    let Some((label, text)) = found else {
        return Ok(None);
    };
    let mut value =
        crate::host::storage::parse_wrangler(&text).with_context(|| format!("parse {label}"))?;
    let Some(entries) = value
        .get_mut("containers")
        .and_then(Value::as_array_mut)
        .filter(|entries| !entries.is_empty())
    else {
        return Ok(None);
    };
    if sandbox_disabled {
        bail!("containers[0] refused: Sandbox containers are off on this install (NOITE_SANDBOX)");
    }
    let mut dockerfiles = Vec::new();
    let mut changed = false;
    for (index, entry) in entries.iter_mut().enumerate() {
        let Some(entry) = entry.as_object_mut() else {
            continue;
        };
        if entry.contains_key("runtime") {
            bail!("containers[{index}].runtime is refused: the OCI runtime is operator-owned (celld lets a class override the node default); remove the key and the class runs under the install's runtime");
        }
        if let Some(policy) = entry.remove("scheduling_policy") {
            if policy.as_str() != Some("durable_object") {
                bail!("containers[{index}].scheduling_policy {policy} is not supported (only \"durable_object\", one container per Durable Object)");
            }
            changed = true;
        }
        if let Some(images) = entry.remove("images") {
            changed = true;
            if entry.contains_key("image") {
                bail!("containers[{index}] names both `image` and `images`");
            }
            let default = images
                .as_object()
                .filter(|images| images.keys().all(|key| key == "default"))
                .and_then(|images| images.get("default"))
                .and_then(Value::as_object)
                .with_context(|| {
                    format!("containers[{index}].images must be {{\"default\": {{…}}}}")
                })?;
            if let Some(key) = default
                .keys()
                .find(|key| !matches!(key.as_str(), "dockerfile" | "build_context" | "image"))
            {
                bail!("containers[{index}].images.default.{key} is not supported");
            }
            let path = |key: &str| -> anyhow::Result<Option<PathBuf>> {
                default
                    .get(key)
                    .map(|value| {
                        value
                            .as_str()
                            .filter(|path| !path.is_empty())
                            .map(|path| deploy_root.join(path))
                            .with_context(|| {
                                format!("containers[{index}].images.default.{key} must be a path")
                            })
                    })
                    .transpose()
            };
            match (default.get("image").and_then(Value::as_str), path("dockerfile")?) {
                // A file-valued `image` goes through the Dockerfile rule
                // below, exactly as a plain `image` does.
                (Some(image), None) if !default.contains_key("build_context") => {
                    entry.insert("image".into(), Value::String(image.to_string()));
                }
                (None, Some(dockerfile)) => {
                    dockerfiles.push((
                        index,
                        crate::host::container_image::Request {
                            dockerfile,
                            context: path("build_context")?,
                        },
                    ));
                }
                _ => bail!("containers[{index}].images.default needs exactly one of `image` or `dockerfile` (+ optional `build_context`)"),
            }
        }
        // celld builds any `image` naming a file (its `is_dockerfile`), so
        // every such entry is prepared, whichever key it came from.
        let built = dockerfiles.last().is_some_and(|(at, _)| *at == index);
        if let (false, Some(image)) = (built, entry.get("image").and_then(Value::as_str)) {
            if is_dockerfile(deploy_root, image) {
                dockerfiles.push((
                    index,
                    crate::host::container_image::Request {
                        dockerfile: deploy_root.join(image),
                        context: None,
                    },
                ));
            }
        }
    }
    if dockerfiles.len() > MAX_DOCKERFILE_ENTRIES {
        bail!(
            "{} containers build from a Dockerfile; at most {MAX_DOCKERFILE_ENTRIES} may",
            dockerfiles.len()
        );
    }
    Ok(Some(ContainersPlan {
        config: deploy_root.join(label),
        value,
        dockerfiles,
        changed,
    }))
}

/// Containers entries one deploy may build from a Dockerfile: each one is
/// pulled, vetted and built before celld starts.
const MAX_DOCKERFILE_ENTRIES: usize = 4;

/// The deploy root's containers, normalized ([`plan_containers`]): set each
/// Dockerfile entry's prepared image, then [`ContainersPlan::write`].
#[derive(Debug)]
pub struct ContainersPlan {
    config: PathBuf,
    value: Value,
    /// `(containers index, Dockerfile)` for every entry built from one.
    pub dockerfiles: Vec<(usize, crate::host::container_image::Request)>,
    changed: bool,
}

impl ContainersPlan {
    /// Point `containers[index].image` at the prepared Dockerfile, relative
    /// to the deploy root as celld resolves it.
    pub fn set_dockerfile(&mut self, index: usize, dockerfile: &Path) {
        let root = self.config.parent().unwrap_or(Path::new("."));
        let image = relative_up(root, dockerfile);
        self.set_image(index, &image);
    }

    /// Point `containers[index].image` at the prepared Dockerfile by
    /// absolute path: for a config planned in a staging dir but deployed
    /// from elsewhere (the sandbox controller's cohosted project), where a
    /// path relative to the staging dir would dangle. celld joins the
    /// project dir onto the value, and joining an absolute path is the
    /// path itself, so the build reads the pinned file with the vetted
    /// context as its build context.
    pub fn set_dockerfile_absolute(&mut self, index: usize, dockerfile: &Path) {
        self.set_image(index, &dockerfile.display().to_string());
    }

    fn set_image(&mut self, index: usize, image: &str) {
        if let Some(entry) = self
            .value
            .get_mut("containers")
            .and_then(|containers| containers.get_mut(index))
            .and_then(Value::as_object_mut)
        {
            entry.insert("image".into(), Value::String(image.to_string()));
            self.changed = true;
        }
    }

    /// The normalized config: the sandbox slice plans the controller's
    /// moved entry in a staging dir and renders from this value instead of
    /// writing it back.
    pub fn value(&self) -> &Value {
        &self.value
    }

    /// Write the normalized config back when anything changed.
    pub fn write(&self) -> anyhow::Result<()> {
        if !self.changed {
            return Ok(());
        }
        write_fresh(&self.config, &serde_json::to_string_pretty(&self.value)?)
    }
}

/// Write `path` as a new file: whatever the worktree left there (a symlink
/// planted to aim this root write elsewhere included) is removed first,
/// and `create_new` refuses to follow anything that reappears.
pub(crate) fn write_fresh(path: &Path, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => bail!("{} is a directory", path.display()),
        Ok(_) => {
            std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("inspect {}", path.display())),
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(text.as_bytes())
        .with_context(|| format!("write {}", path.display()))
}

/// Whether `image` names a Dockerfile in the project rather than an image
/// reference. Mirrors celld 0.6.3's `is_dockerfile` (`deploy.rs`) exactly:
/// the joined path exists and is a file, via `symlink_metadata` (which
/// does not follow symlinks, so a symlink never counts — as in celld).
/// Shared with the sandbox slice, which absolutizes file-named images when
/// it moves the managed entry out of the app config.
pub(crate) fn is_dockerfile(root: &Path, image: &str) -> bool {
    std::fs::symlink_metadata(root.join(image)).is_ok_and(|metadata| metadata.is_file())
}

/// `path` relative to the directory `from`, with `..` steps where it lies
/// outside it (both absolute).
fn relative_up(from: &Path, path: &Path) -> String {
    let common = common_ancestor(from, path);
    let ups = from
        .strip_prefix(&common)
        .map(|rest| rest.components().count())
        .unwrap_or(0);
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), ups).collect();
    parts.extend(
        path.strip_prefix(&common)
            .unwrap_or(path)
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            }),
    );
    parts.join("/")
}

/// Where a built tree deploys from, what the deploy log should call it, and
/// the `secrets.required` names the rewrite dropped (celld refuses the key):
/// the deploy fails before `celld deploy` unless every one has a setting.
/// `void` marks Void's own build output (`dist/ssr/wrangler.json`): the one
/// gate for every runner-owned Void injection (identity vars, provisioned
/// secrets, `ISR_CACHE`), so anything else deploys exactly as before.
#[derive(Debug)]
pub struct BuiltRoot {
    pub dir: PathBuf,
    pub note: String,
    pub required_secrets: Vec<String>,
    pub void: bool,
}

/// The deploy root the build produced under `src_dir`, or `None` to fall
/// back to the source config.
pub fn built_deploy_root(src_dir: &Path) -> anyhow::Result<Option<BuiltRoot>> {
    let src = src_dir
        .canonicalize()
        .with_context(|| format!("resolve {}", src_dir.display()))?;
    let dist = src.join("dist");
    if dist.join("wrangler.json").is_file() {
        return Ok(Some(BuiltRoot {
            dir: dist,
            note: "dist/wrangler.json (build output)".into(),
            // Used as written: nothing is dropped, so nothing is required.
            required_secrets: Vec::new(),
            void: false,
        }));
    }
    // Void's own output: the Worker and its config under `dist/ssr/`, the
    // assets in `dist/client/`. Rewritten like the redirect below, into
    // `dist/wrangler.json`.
    let void_config = src.join(VOID_OUTPUT);
    if void_config.is_file() {
        // Resolved first, as the redirect is: the runner reads and rewrites
        // it as root, and a link in it or in a parent would aim both
        // outside the worktree.
        let void_config = inside(&src, &void_config).context(VOID_OUTPUT)?;
        let (dir, required_secrets) = celld_config_from(&src, &void_config)?;
        return Ok(Some(BuiltRoot {
            note: format!(
                "{} (from {VOID_OUTPUT}, Void)",
                display_rel(&src, &dir.join("wrangler.json"))
            ),
            dir,
            required_secrets,
            void: true,
        }));
    }
    let redirect = src.join(DEPLOY_REDIRECT);
    if !redirect.is_file() {
        return Ok(None);
    }
    let config = redirected_config(&src, &redirect)?;
    let (dir, required_secrets) = celld_config_from(&src, &config)?;
    Ok(Some(BuiltRoot {
        note: format!(
            "{} (from {}, via {DEPLOY_REDIRECT})",
            display_rel(&src, &dir.join("wrangler.json")),
            display_rel(&src, &config)
        ),
        dir,
        required_secrets,
        void: false,
    }))
}

/// The built config Wrangler's redirect names, inside the worktree.
fn redirected_config(src: &Path, redirect: &Path) -> anyhow::Result<PathBuf> {
    let text =
        std::fs::read_to_string(redirect).with_context(|| format!("read {DEPLOY_REDIRECT}"))?;
    let value: Value =
        serde_json::from_str(&text).with_context(|| format!("parse {DEPLOY_REDIRECT}"))?;
    let aux = value
        .get("auxiliaryWorkers")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if aux > 0 {
        bail!("{DEPLOY_REDIRECT}: auxiliary Workers are not supported (one Worker per app)");
    }
    let rel = value
        .get("configPath")
        .and_then(Value::as_str)
        .with_context(|| format!("{DEPLOY_REDIRECT} has no configPath"))?;
    let base = redirect.parent().unwrap_or(src);
    inside(src, &base.join(rel)).with_context(|| format!("{DEPLOY_REDIRECT} configPath {rel}"))
}

/// Rewrite the built Wrangler config at `config` into a `wrangler.json`
/// celld accepts and return the directory it was written to, plus the
/// `secrets.required` names the rewrite dropped (checked against settings
/// before `celld deploy`).
fn celld_config_from(src: &Path, config: &Path) -> anyhow::Result<(PathBuf, Vec<String>)> {
    let label = display_rel(src, config);
    let text = std::fs::read_to_string(config).with_context(|| format!("read {label}"))?;
    let value =
        crate::host::storage::parse_wrangler(&text).with_context(|| format!("parse {label}"))?;
    // `secrets` goes below (celld refuses the key): capture Void's required
    // list first, so the deploy fails naming them instead of the Worker
    // failing at runtime without them.
    let required_secrets = crate::host::worker_vars::required_secrets(&value);
    let mut value = value;
    let Some(obj) = value.as_object_mut() else {
        bail!("{label} is not a JSON object");
    };
    let config_dir = config.parent().unwrap_or(src).to_path_buf();

    let main = match obj.get("main").and_then(Value::as_str) {
        Some(m) => {
            Some(inside(src, &config_dir.join(m)).with_context(|| format!("{label}: main {m}"))?)
        }
        None => None,
    };
    let assets = match obj
        .get("assets")
        .and_then(|a| a.get("directory"))
        .and_then(Value::as_str)
    {
        Some(d) => Some(
            inside(src, &config_dir.join(d))
                .with_context(|| format!("{label}: assets.directory {d}"))?,
        ),
        None => None,
    };

    // The nearest directory holding the config, the Worker and its assets.
    // celld wants the assets directory strictly below the root.
    let mut root = config_dir.clone();
    if let Some(main_dir) = main.as_deref().and_then(Path::parent) {
        root = common_ancestor(&root, main_dir);
    }
    if let Some(assets) = &assets {
        root = common_ancestor(&root, assets);
        if &root == assets {
            root = root.parent().map(Path::to_path_buf).unwrap_or(root);
        }
    }
    if !root.starts_with(src) {
        bail!("{label}: the Worker and its assets are not inside the worktree");
    }
    let target = root.join("wrangler.json");
    if target != config && WRANGLER_NAMES.iter().any(|n| root.join(n).exists()) {
        bail!(
            "{label}: its output shares {} with another Wrangler config; build into a directory of its own (e.g. dist/)",
            display_rel(src, &root)
        );
    }

    if let Some(main) = &main {
        obj.insert("main".into(), Value::String(relative(&root, main)));
    }
    if let (Some(assets), Some(block)) = (
        &assets,
        obj.get_mut("assets").and_then(Value::as_object_mut),
    ) {
        block.insert("directory".into(), Value::String(relative(&root, assets)));
    }
    relocate_migrations(obj, &config_dir, &root);
    obj.retain(|k, _| CELLD_KEYS.contains(&k.as_str()));

    write_fresh(&target, &serde_json::to_string_pretty(&value)?)
        .with_context(|| format!("write {}", display_rel(src, &target)))?;
    if let Some(assets) = &assets {
        apply_assetsignore(assets)?;
        // An asset-only build keeps its config inside the assets directory;
        // served from there it would publish the app's vars.
        if target != config && config.starts_with(assets) {
            remove_path(config)?;
        }
    }
    Ok((root, required_secrets))
}

/// D1 `migrations_dir` values relative to the new root; one that is missing
/// or outside it is dropped (celld refuses `..`).
fn relocate_migrations(obj: &mut serde_json::Map<String, Value>, config_dir: &Path, root: &Path) {
    let Some(dbs) = obj.get_mut("d1_databases").and_then(Value::as_array_mut) else {
        return;
    };
    for db in dbs.iter_mut().filter_map(Value::as_object_mut) {
        let Some(dir) = db.get("migrations_dir").and_then(Value::as_str) else {
            continue;
        };
        match config_dir.join(dir).canonicalize() {
            Ok(abs) if abs.starts_with(root) && abs != root => {
                db.insert("migrations_dir".into(), Value::String(relative(root, &abs)));
            }
            _ => {
                db.remove("migrations_dir");
            }
        }
    }
}

/// celld has no `.assetsignore`: remove the files it names (plain names only,
/// as Cloudflare's Vite plugin writes them), then the file itself.
fn apply_assetsignore(assets: &Path) -> anyhow::Result<()> {
    let ignore = assets.join(".assetsignore");
    let Ok(text) = std::fs::read_to_string(&ignore) else {
        return Ok(());
    };
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains(['*', '?', '[', '/', '\\', '!']) || line == "." || line == ".." {
            bail!(".assetsignore pattern `{line}` is not supported (plain file names only)");
        }
        remove_path(&assets.join(line))?;
    }
    remove_path(&ignore)
}

fn remove_path(path: &Path) -> anyhow::Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
    };
    result.with_context(|| format!("remove {}", path.display()))
}

/// `path` resolved (symlinks too) and proven to lie inside `src`.
fn inside(src: &Path, path: &Path) -> anyhow::Result<PathBuf> {
    let resolved = path.canonicalize().context("not found")?;
    if !resolved.starts_with(src) {
        bail!("escapes the worktree");
    }
    Ok(resolved)
}

fn common_ancestor(a: &Path, b: &Path) -> PathBuf {
    a.components()
        .zip(b.components())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x)
        .collect()
}

/// `path` below `root` as a forward-slash relative path.
fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn display_rel(src: &Path, path: &Path) -> String {
    let rel = relative(src, path);
    if rel.is_empty() {
        ".".into()
    } else {
        rel
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> crate::testutil::TempDir {
        crate::testutil::TempDir::new(&format!("noite-build-output-{name}"))
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// The layout `@cloudflare/vite-plugin` 1.x writes for a Worker with assets.
    fn vite_worker_tree(src: &Path) {
        write(
            &src.join("wrangler.jsonc"),
            r#"{ "name": "app", "main": "src/index.ts", "compatibility_date": "2026-09-01" }"#,
        );
        write(
            &src.join(DEPLOY_REDIRECT),
            r#"{"configPath":"../../dist/app/wrangler.json","auxiliaryWorkers":[]}"#,
        );
        write(
            &src.join("dist/app/wrangler.json"),
            r#"{"configPath":"/abs/wrangler.jsonc","topLevelName":"app","name":"app","main":"index.js",
                "compatibility_date":"2026-09-01","compatibility_flags":[],"no_bundle":true,"rules":[],
                "assets":{"binding":"ASSETS","directory":"../client","not_found_handling":"single-page-application"},
                "vars":{"GREETING":"hi"},"exports":{},"dev":{"ip":"localhost"},"unknown_key":true,
                "containers":[{"class_name":"Sandbox","image":"prebuilt:latest"}],
                "d1_databases":[{"binding":"DB","database_name":"db","migrations_dir":"../../migrations"}]}"#,
        );
        write(&src.join("dist/app/index.js"), "export default {}");
        write(&src.join("dist/client/index.html"), "<h1>hi</h1>");
        write(
            &src.join("dist/client/.assetsignore"),
            "wrangler.json\n.dev.vars\n",
        );
        write(&src.join("migrations/0001.sql"), "select 1;");
    }

    #[test]
    fn vite_plugin_output_becomes_a_celld_config_in_dist() {
        let guard_vite = scratch("vite");
        let src = guard_vite.path().canonicalize().unwrap();
        vite_worker_tree(&src);

        let built = built_deploy_root(&src).unwrap().expect("redirect followed");
        assert_eq!(built.dir, src.join("dist"));
        assert!(
            built.note.contains("dist/app/wrangler.json"),
            "{}",
            built.note
        );

        let v = read_json(&src.join("dist/wrangler.json"));
        assert_eq!(v["main"], "app/index.js");
        assert_eq!(v["assets"]["directory"], "client");
        assert_eq!(v["assets"]["binding"], "ASSETS");
        assert_eq!(v["vars"]["GREETING"], "hi");
        for dropped in [
            "configPath",
            "topLevelName",
            "no_bundle",
            "rules",
            "exports",
            "dev",
            "unknown_key",
        ] {
            assert!(v.get(dropped).is_none(), "{dropped} kept");
        }
        // celld 0.6 container classes (Sandbox templates) survive the filter.
        assert_eq!(v["containers"][0]["class_name"], "Sandbox");
        // Outside the new root: dropped rather than written with `..`.
        assert!(v["d1_databases"][0].get("migrations_dir").is_none());
        assert!(!src.join("dist/client/.assetsignore").exists());
        // The source config is left alone.
        assert!(std::fs::read_to_string(src.join("wrangler.jsonc"))
            .unwrap()
            .contains("src/index.ts"));
    }

    #[test]
    fn asset_only_output_moves_up_and_unpublishes_its_config() {
        let guard_assets = scratch("assets");
        let src = guard_assets.path().canonicalize().unwrap();
        write(
            &src.join(DEPLOY_REDIRECT),
            r#"{"configPath":"../../dist/client/wrangler.json"}"#,
        );
        write(
            &src.join("dist/client/wrangler.json"),
            r#"{"name":"site","compatibility_date":"2026-09-01","assets":{"directory":"."},"vars":{"K":"v"}}"#,
        );
        write(&src.join("dist/client/index.html"), "<h1>hi</h1>");
        write(
            &src.join("dist/client/.assetsignore"),
            "wrangler.json\n.dev.vars\n",
        );

        let built = built_deploy_root(&src).unwrap().unwrap();
        assert_eq!(built.dir, src.join("dist"));
        let v = read_json(&src.join("dist/wrangler.json"));
        assert_eq!(v["assets"]["directory"], "client");
        assert!(v.get("main").is_none());
        assert!(
            !src.join("dist/client/wrangler.json").exists(),
            "config would be served as an asset"
        );
        assert!(src.join("dist/client/index.html").exists());
    }

    #[test]
    fn celld_ready_dist_config_wins() {
        let guard_oxide = scratch("oxide");
        let src = guard_oxide.path().canonicalize().unwrap();
        vite_worker_tree(&src);
        write(
            &src.join("dist/wrangler.json"),
            r#"{"name":"app","main":"celld/entry.js"}"#,
        );
        let built = built_deploy_root(&src).unwrap().unwrap();
        assert_eq!(built.dir, src.join("dist"));
        // Untouched: already celld's shape.
        assert_eq!(
            read_json(&src.join("dist/wrangler.json"))["main"],
            "celld/entry.js"
        );
    }

    #[test]
    fn no_build_output_falls_back() {
        let guard_plain = scratch("plain");
        let src = guard_plain.path().canonicalize().unwrap();
        write(
            &src.join("wrangler.jsonc"),
            r#"{"name":"app","main":"index.js"}"#,
        );
        assert!(built_deploy_root(&src).unwrap().is_none());
    }

    #[test]
    fn redirect_outside_the_worktree_is_refused() {
        let guard_outside = scratch("outside");
        let outside = guard_outside.path().canonicalize().unwrap();
        write(&outside.join("wrangler.json"), r#"{"name":"x"}"#);
        let guard_escape = scratch("escape");
        let src = guard_escape.path().canonicalize().unwrap();
        let path = outside.join("wrangler.json");
        write(
            &src.join(DEPLOY_REDIRECT),
            &format!(r#"{{"configPath":{}}}"#, serde_json::json!(path)),
        );
        let err = built_deploy_root(&src).unwrap_err();
        assert!(
            format!("{err:#}").contains("escapes the worktree"),
            "{err:#}"
        );
    }

    #[test]
    fn output_sharing_the_source_root_is_refused() {
        let guard_shared = scratch("shared");
        let src = guard_shared.path().canonicalize().unwrap();
        write(&src.join("wrangler.jsonc"), r#"{"name":"app"}"#);
        write(
            &src.join(DEPLOY_REDIRECT),
            r#"{"configPath":"../../out/wrangler.json"}"#,
        );
        write(
            &src.join("out/wrangler.json"),
            r#"{"name":"app","main":"index.js","assets":{"directory":"../public"}}"#,
        );
        write(&src.join("out/index.js"), "export default {}");
        write(&src.join("public/index.html"), "hi");
        let err = built_deploy_root(&src).unwrap_err();
        assert!(format!("{err:#}").contains("shares"), "{err:#}");
    }

    #[test]
    fn assetsignore_globs_are_refused() {
        let guard_glob = scratch("glob");
        let dir = guard_glob.path().to_path_buf();
        write(&dir.join(".assetsignore"), "*.map\n");
        assert!(apply_assetsignore(&dir).is_err());
    }

    fn deploy_root(name: &str, config: &str) -> crate::testutil::TempDir {
        let guard = scratch(name);
        write(&guard.path().join("wrangler.json"), config);
        guard
    }

    fn declares(dir: &Path, sandbox_disabled: bool) -> bool {
        plan_containers(dir, sandbox_disabled)
            .expect("plan")
            .is_some()
    }

    /// A per-class `runtime` overrides the node's default in celld, so the
    /// install's runtime would be the tenant's choice. Refused: the OCI
    /// runtime is operator-owned.
    #[test]
    fn container_runtime_is_refused() {
        for runtime in [r#""runsc""#, "null"] {
            let guard_runtime = deploy_root(
                "runtime",
                &format!(
                    r#"{{"name":"a","containers":[{{"class_name":"Sandbox","image":"ghcr.io/x/y:tag","runtime":{runtime}}}]}}"#
                ),
            );
            let dir = guard_runtime.path().canonicalize().unwrap();
            let text = format!("{:#}", plan_containers(&dir, false).unwrap_err());
            assert!(text.contains("containers[0].runtime is refused"), "{text}");
            assert!(text.contains("operator-owned"), "{text}");
        }
    }

    /// Void's Sandbox entry (Sandbox SDK 1.0 shape) becomes celld's: the
    /// scheduling policy goes, a registry `images.default.image` becomes
    /// `image`, and a Dockerfile is left to prepare, with its context.
    #[test]
    fn voids_container_shape_normalizes_for_celld() {
        let guard_void_shape = scratch("void-shape");
        let dir = guard_void_shape.path().canonicalize().unwrap();
        write(&dir.join("sandbox/Dockerfile"), "FROM scratch\n");
        let dockerfile = dir.join("sandbox/Dockerfile");
        write(
            &dir.join("dist/wrangler.json"),
            &format!(
                r#"{{"name":"a","containers":[
                    {{"name":"void-sandbox-v1","class_name":"SandboxV1","scheduling_policy":"durable_object","images":{{"default":{{"dockerfile":{:?},"build_context":{:?}}}}}}},
                    {{"class_name":"Other","scheduling_policy":"durable_object","images":{{"default":{{"image":"registry.example/x@sha256:00"}}}}}}
                ]}}"#,
                dockerfile.display().to_string(),
                dir.join("sandbox").display().to_string(),
            ),
        );
        let root = dir.join("dist");
        let mut plan = plan_containers(&root, false).unwrap().expect("declares");
        assert_eq!(
            plan.dockerfiles,
            vec![(
                0,
                crate::host::container_image::Request {
                    dockerfile: dockerfile.clone(),
                    context: Some(dir.join("sandbox")),
                }
            )]
        );
        plan.set_dockerfile(0, &dir.join("sandbox/.noite-image-0.Dockerfile"));
        plan.write().unwrap();
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("wrangler.json")).unwrap())
                .unwrap();
        assert_eq!(
            v["containers"][0],
            serde_json::json!({
                "name": "void-sandbox-v1",
                "class_name": "SandboxV1",
                "image": "../sandbox/.noite-image-0.Dockerfile",
            })
        );
        assert_eq!(
            v["containers"][1],
            serde_json::json!({"class_name": "Other", "image": "registry.example/x@sha256:00"})
        );
    }

    /// A staged plan renders from its normalized value instead of writing
    /// it back, with the prepared Dockerfile pinned by absolute path (the
    /// cohosted project deploys from a different dir than the staging one,
    /// so a relative path would dangle).
    #[test]
    fn staged_plan_renders_absolute_without_writing() {
        let guard_staged_plan = scratch("staged-plan");
        let dir = guard_staged_plan.path().canonicalize().unwrap();
        write(&dir.join("sandbox/Dockerfile"), "FROM scratch\n");
        let dockerfile = dir.join("sandbox/Dockerfile");
        write(
            &dir.join("staging/wrangler.json"),
            &format!(
                r#"{{"name":"s","containers":[{{"name":"n","class_name":"C","scheduling_policy":"durable_object","images":{{"default":{{"dockerfile":{},"build_context":{}}}}}}}]}}"#,
                serde_json::to_string(&dockerfile.display().to_string()).unwrap(),
                serde_json::to_string(&dir.join("sandbox").display().to_string()).unwrap(),
            ),
        );
        let mut plan = plan_containers(&dir.join("staging"), false)
            .unwrap()
            .expect("declares");
        assert_eq!(plan.dockerfiles.len(), 1);
        let pinned = dir.join("sandbox/.noite-image-0.Dockerfile");
        plan.set_dockerfile_absolute(0, &pinned);
        assert_eq!(
            plan.value()["containers"][0],
            serde_json::json!({
                "name": "n",
                "class_name": "C",
                "image": pinned.display().to_string(),
            })
        );
        // Nothing written back: the staging file still carries the Void shape.
        let staged: Value = read_json(&dir.join("staging/wrangler.json"));
        assert!(staged["containers"][0].get("images").is_some());
    }

    #[test]
    fn malformed_void_container_shapes_are_refused() {
        for (name, entry) in [
            (
                "other policy",
                r#"{"class_name":"S","scheduling_policy":"regional","image":"x"}"#,
            ),
            (
                "image and images",
                r#"{"class_name":"S","image":"x","images":{"default":{"image":"y"}}}"#,
            ),
            (
                "other variant",
                r#"{"class_name":"S","images":{"gpu":{"image":"y"}}}"#,
            ),
            (
                "both sources",
                r#"{"class_name":"S","images":{"default":{"image":"y","dockerfile":"D"}}}"#,
            ),
            (
                "context with registry image",
                r#"{"class_name":"S","images":{"default":{"image":"y","build_context":"."}}}"#,
            ),
            (
                "unknown image key",
                r#"{"class_name":"S","images":{"default":{"image":"y","args":{}}}}"#,
            ),
            ("empty", r#"{"class_name":"S","images":{"default":{}}}"#),
        ] {
            let guard_void_bad = deploy_root(
                "void-bad",
                &format!(r#"{{"name":"a","containers":[{entry}]}}"#),
            );
            let dir = guard_void_bad.path().canonicalize().unwrap();
            assert!(
                plan_containers(&dir, false).is_err(),
                "{name} must be refused"
            );
        }
    }

    /// A plain `image` naming a file in the project is a Dockerfile to
    /// prepare; the rule mirrors celld's `is_dockerfile` exactly: a missing
    /// path is a registry reference, a directory is not a file, and a
    /// symlink never counts (`symlink_metadata` follows nothing).
    #[test]
    #[cfg(unix)]
    fn container_dockerfile_rule_matches_celld() {
        let guard_dockerfile_rule = scratch("dockerfile-rule");
        let dir = guard_dockerfile_rule.path().canonicalize().unwrap();
        write(&dir.join("images/app/Dockerfile"), "FROM scratch\n");
        std::fs::create_dir_all(dir.join("emptydir")).unwrap();
        std::os::unix::fs::symlink(
            dir.join("images/app/Dockerfile"),
            dir.join("linked-Dockerfile"),
        )
        .unwrap();
        for (image, dockerfile) in [
            ("images/app/Dockerfile", true),
            ("ghcr.io/x/y:tag", false),
            ("images/missing/Dockerfile", false),
            ("emptydir", false),
            ("linked-Dockerfile", false),
        ] {
            write(
                &dir.join("wrangler.json"),
                &format!(
                    r#"{{"name":"a","containers":[{{"class_name":"Sandbox","image":{image:?}}}]}}"#
                ),
            );
            let plan = plan_containers(&dir, false).unwrap().expect("declares");
            assert_eq!(!plan.dockerfiles.is_empty(), dockerfile, "{image}");
        }
    }

    /// celld builds any `image` naming a file, so a Void-shaped
    /// `images.default.image` naming one must be prepared like a plain
    /// `image`, never passed through unchecked (it would build the tenant's
    /// `RUN` steps on the host engine).
    #[test]
    fn a_file_named_by_images_default_image_is_prepared() {
        let guard_images_image_file = scratch("images-image-file");
        let dir = guard_images_image_file.path().canonicalize().unwrap();
        write(&dir.join("Dockerfile"), "FROM node:26\nRUN echo pwned\n");
        write(
            &dir.join("wrangler.json"),
            r#"{"name":"a","containers":[{"class_name":"S","images":{"default":{"image":"Dockerfile"}}}]}"#,
        );
        let plan = plan_containers(&dir, false).unwrap().expect("declares");
        assert_eq!(
            plan.dockerfiles,
            vec![(
                0,
                crate::host::container_image::Request {
                    dockerfile: dir.join("Dockerfile"),
                    context: None,
                }
            )]
        );
    }

    #[test]
    fn too_many_dockerfile_entries_are_refused() {
        let guard_many_dockerfiles = scratch("many-dockerfiles");
        let dir = guard_many_dockerfiles.path().canonicalize().unwrap();
        write(&dir.join("Dockerfile"), "FROM scratch\n");
        let entries: Vec<String> = (0..=MAX_DOCKERFILE_ENTRIES)
            .map(|i| format!(r#"{{"class_name":"S{i}","image":"Dockerfile"}}"#))
            .collect();
        write(
            &dir.join("wrangler.json"),
            &format!(r#"{{"name":"a","containers":[{}]}}"#, entries.join(",")),
        );
        assert!(plan_containers(&dir, false).is_err());
    }

    /// The runner writes the relocated config as root: a link the tree left
    /// at `dist/wrangler.json` (dangling, so nothing treats it as a config)
    /// is replaced, never followed.
    #[test]
    #[cfg(unix)]
    fn void_relocation_never_writes_through_a_planted_link() {
        let guard_void_link = scratch("void-link");
        let src = guard_void_link.path().canonicalize().unwrap();
        write(
            &src.join("dist/ssr/wrangler.json"),
            r#"{"name":"app","main":"index.js","assets":{"directory":"../client"}}"#,
        );
        write(&src.join("dist/ssr/index.js"), "export default {}");
        write(&src.join("dist/client/a.txt"), "");
        let guard_victim = scratch("void-link-victim");
        let victim = guard_victim.path().join("owned");
        std::os::unix::fs::symlink(&victim, src.join("dist/wrangler.json")).unwrap();
        built_deploy_root(&src).unwrap().expect("Void output");
        assert!(!victim.exists(), "the write followed the link");
        assert!(std::fs::symlink_metadata(src.join("dist/wrangler.json"))
            .unwrap()
            .is_file());
    }

    /// A link at Void's config, or at a directory above it, that leads out
    /// of the worktree is refused before the root read and write.
    #[test]
    #[cfg(unix)]
    fn void_output_linked_out_of_the_worktree_is_refused() {
        let guard_void_outside = scratch("void-outside");
        let outside = guard_void_outside.path().canonicalize().unwrap();
        write(
            &outside.join("ssr/wrangler.json"),
            r#"{"name":"stolen","vars":{"SECRET":"x"}}"#,
        );
        let guard_void_file_link = scratch("void-file-link");
        let file_link = guard_void_file_link.path().canonicalize().unwrap();
        std::fs::create_dir_all(file_link.join("dist/ssr")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("ssr/wrangler.json"),
            file_link.join("dist/ssr/wrangler.json"),
        )
        .unwrap();
        let guard_void_dir_link = scratch("void-dir-link");
        let dir_link = guard_void_dir_link.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(&outside, dir_link.join("dist")).unwrap();
        for src in [file_link, dir_link] {
            let err = built_deploy_root(&src).unwrap_err();
            assert!(
                format!("{err:#}").contains("escapes the worktree"),
                "{err:#}"
            );
        }
        assert!(!outside.join("wrangler.json").exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("ssr/wrangler.json")).unwrap(),
            r#"{"name":"stolen","vars":{"SECRET":"x"}}"#
        );
    }

    /// `NOITE_SANDBOX=off` refuses any `containers` entry; a config
    /// without containers (or with an empty array) still deploys.
    #[test]
    fn containers_refused_when_sandbox_disabled() {
        let guard_sandbox_off = deploy_root(
            "sandbox-off",
            r#"{"name":"a","containers":[{"class_name":"Sandbox","image":"ghcr.io/x/y:tag"}]}"#,
        );
        let dir = guard_sandbox_off.path().canonicalize().unwrap();
        let err = plan_containers(&dir, true).unwrap_err();
        assert!(
            format!("{err:#}")
                .contains("Sandbox containers are off on this install (NOITE_SANDBOX)"),
            "{err:#}"
        );
        let guard_sandbox_off_empty =
            deploy_root("sandbox-off-empty", r#"{"name":"a","containers":[]}"#);
        let dir = guard_sandbox_off_empty.path().canonicalize().unwrap();
        assert!(!declares(&dir, true));
        let guard_sandbox_off_none = deploy_root("sandbox-off-none", r#"{"name":"a"}"#);
        let dir = guard_sandbox_off_none.path().canonicalize().unwrap();
        assert!(!declares(&dir, true));
    }

    /// A registry image with no `runtime` declares containers (the deploy
    /// stretches its timeout); anything else malformed is celld's to
    /// reject, so the plan passes it through.
    #[test]
    fn container_plan_reports_and_defers() {
        let guard_registry = deploy_root(
            "registry",
            r#"{"name":"a","containers":[{"class_name":"Sandbox","image":"ghcr.io/x/y:tag"}]}"#,
        );
        let dir = guard_registry.path().canonicalize().unwrap();
        assert!(declares(&dir, false));
        // celld reads `wrangler.jsonc` first: a jsonc without containers
        // wins over a json with a refused key.
        write(
            &dir.join("wrangler.jsonc"),
            r#"{"name":"a", // celld's pick
            }"#,
        );
        assert!(!declares(&dir, false));
        for (name, config) in [
            ("no-config", None),
            ("not-object", Some("[1]")),
            ("not-array", Some(r#"{"name":"a","containers":{}}"#)),
        ] {
            let guard_iter = scratch(name);
            let dir = guard_iter.path().canonicalize().unwrap();
            if let Some(config) = config {
                write(&dir.join("wrangler.json"), config);
            }
            assert!(
                !declares(&dir, false),
                "{name} must pass through undeclared for celld to reject"
            );
        }
        // A non-empty array declares containers even when its shape is
        // celld's to reject (it fails before pulling, so the stretched
        // timeout costs nothing).
        let guard_not_entry = scratch("not-entry");
        let dir = guard_not_entry.path().canonicalize().unwrap();
        write(
            &dir.join("wrangler.json"),
            r#"{"name":"a","containers":["x"]}"#,
        );
        assert!(declares(&dir, false));
    }

    /// Void's own output deploys: `dist/ssr/wrangler.json` becomes
    /// `dist/wrangler.json` with the Worker and assets relative to `dist/`
    /// and only the keys celld accepts.
    #[test]
    fn voids_own_output_becomes_the_deploy_root() {
        let guard_void_output = scratch("void-output");
        let src = guard_void_output.path().canonicalize().unwrap();
        write(
            &src.join("dist/ssr/wrangler.json"),
            r#"{"name":"app","main":"index.js","compatibility_date":"2026-09-01","no_bundle":true,"rules":[],
               "assets":{"binding":"ASSETS","directory":"../client","run_worker_first":["/**","!/assets/a.js"]},
               "durable_objects":{"bindings":[{"name":"SANDBOX","class_name":"SandboxV1"}]},
               "containers":[{"class_name":"SandboxV1","scheduling_policy":"durable_object","images":{"default":{"image":"x"}}}]}"#,
        );
        write(&src.join("dist/ssr/index.js"), "export default {}");
        write(&src.join("dist/client/assets/a.js"), "");
        let built = built_deploy_root(&src).unwrap().expect("Void output");
        assert_eq!(built.dir, src.join("dist"));
        assert!(built.note.contains("Void"), "{}", built.note);
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(src.join("dist/wrangler.json")).unwrap())
                .unwrap();
        assert_eq!(v["main"], "ssr/index.js");
        assert_eq!(v["assets"]["directory"], "client");
        assert_eq!(v["assets"]["run_worker_first"][1], "!/assets/a.js");
        assert!(v.get("no_bundle").is_none() && v.get("rules").is_none());
        assert_eq!(v["containers"][0]["class_name"], "SandboxV1");
    }

    /// Void's `secrets.required` is captured before the rewrite drops the key
    /// celld refuses, so the deploy can fail naming the missing settings.
    #[test]
    fn void_required_secrets_survive_the_drop() {
        let guard_void_required = scratch("void-required");
        let src = guard_void_required.path().canonicalize().unwrap();
        write(
            &src.join("dist/ssr/wrangler.json"),
            r#"{"name":"app","main":"index.js","assets":{"directory":"../client"},
                "vars":{"__VOID_EMAIL_FROM":"noreply@example.com"},
                "secrets":{"required":["SECRET_KEY","DATABASE_URL"]}}"#,
        );
        write(&src.join("dist/ssr/index.js"), "export default {}");
        write(&src.join("dist/client/index.html"), "<h1>hi</h1>");
        let built = built_deploy_root(&src).unwrap().expect("Void output");
        assert_eq!(built.required_secrets, ["SECRET_KEY", "DATABASE_URL"]);
        let v = read_json(&src.join("dist/wrangler.json"));
        assert!(v.get("secrets").is_none());
        // Build-owned `__VOID_*` vars are not runner-reserved: they pass
        // through to the deployed config untouched.
        assert_eq!(v["vars"]["__VOID_EMAIL_FROM"], "noreply@example.com");
    }

    /// Only Void's own output (`dist/ssr/wrangler.json`) marks the root a
    /// Void app: the redirect and the celld-ready config are not Void's, so
    /// the runner's Void injections never touch them.
    #[test]
    fn only_voids_own_output_marks_a_void_app() {
        let guard_void_flag = scratch("void-flag");
        let src = guard_void_flag.path().canonicalize().unwrap();
        write(
            &src.join("dist/ssr/wrangler.json"),
            r#"{"name":"app","main":"index.js","assets":{"directory":"../client"}}"#,
        );
        write(&src.join("dist/ssr/index.js"), "export default {}");
        write(&src.join("dist/client/index.html"), "<h1>hi</h1>");
        let built = built_deploy_root(&src).unwrap().expect("Void output");
        assert!(built.void);
        assert!(built.note.contains("Void"));

        let guard_redirect_flag = scratch("redirect-flag");

        let src = guard_redirect_flag.path().canonicalize().unwrap();
        vite_worker_tree(&src);
        let built = built_deploy_root(&src).unwrap().expect("redirect");
        assert!(!built.void);

        let guard_oxide_flag = scratch("oxide-flag");

        let src = guard_oxide_flag.path().canonicalize().unwrap();
        vite_worker_tree(&src);
        write(
            &src.join("dist/wrangler.json"),
            r#"{"name":"app","main":"celld/entry.js"}"#,
        );
        let built = built_deploy_root(&src).unwrap().expect("dist config");
        assert!(!built.void);
    }
}
