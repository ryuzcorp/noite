//! The config `celld deploy` takes after a build (SPEC, Deploy pipeline):
//! what the build produced, not the pushed source config.
//!
//! 1. `dist/wrangler.json`, a celld-ready config the build wrote (Oxide, on
//!    Vite and Rsbuild alike).
//! 2. Wrangler's deploy redirect, `.wrangler/deploy/config.json`, which
//!    `@cloudflare/vite-plugin` writes beside `dist/<worker>/wrangler.json`.
//!    celld refuses that output as is (Wrangler-only keys, an assets
//!    directory at `../client`, `.assetsignore`), so it is rewritten into a
//!    `wrangler.json` at the nearest directory holding both the Worker and
//!    its assets.
//!
//! Only consulted when a build ran in this deploy, so a committed `dist/` or
//! `.wrangler/` never outranks the source config of a tree nothing built.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context};
use serde_json::Value;

/// Wrangler's redirected configuration, relative to the project root.
pub const DEPLOY_REDIRECT: &str = ".wrangler/deploy/config.json";

/// Top-level keys `celld deploy` 0.6 accepts; any other key fails the deploy
/// (oxidejs `CELLD_WRANGLER_KEYS`). celld also accepts `no_bundle`, but it is
/// dropped on purpose: the Vite plugin sets it so Wrangler skips esbuild, and
/// celld would then load split chunks it cannot resolve.
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
];

const WRANGLER_NAMES: &[&str] = &["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/// Where a built tree deploys from, and what the deploy log should call it.
#[derive(Debug)]
pub struct BuiltRoot {
    pub dir: PathBuf,
    pub note: String,
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
        }));
    }
    let redirect = src.join(DEPLOY_REDIRECT);
    if !redirect.is_file() {
        return Ok(None);
    }
    let config = redirected_config(&src, &redirect)?;
    let dir = celld_config_from(&src, &config)?;
    Ok(Some(BuiltRoot {
        note: format!(
            "{} (from {}, via {DEPLOY_REDIRECT})",
            display_rel(&src, &dir.join("wrangler.json")),
            display_rel(&src, &config)
        ),
        dir,
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
/// celld accepts and return the directory it was written to.
fn celld_config_from(src: &Path, config: &Path) -> anyhow::Result<PathBuf> {
    let label = display_rel(src, config);
    let text = std::fs::read_to_string(config).with_context(|| format!("read {label}"))?;
    let mut value =
        crate::host::storage::parse_wrangler(&text).with_context(|| format!("parse {label}"))?;
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

    std::fs::write(&target, serde_json::to_string_pretty(&value)?)
        .with_context(|| format!("write {}", display_rel(src, &target)))?;
    if let Some(assets) = &assets {
        apply_assetsignore(assets)?;
        // An asset-only build keeps its config inside the assets directory;
        // served from there it would publish the app's vars.
        if target != config && config.starts_with(assets) {
            remove_path(config)?;
        }
    }
    Ok(root)
}

/// D1 `migrations_dir` values relative to the new root; one that is missing
/// or outside it is dropped (celld refuses `..`), as oxidejs does.
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-build-output-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
                "vars":{"GREETING":"hi"},"exports":{},"dev":{"ip":"localhost"},
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
        let src = scratch("vite").canonicalize().unwrap();
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
        ] {
            assert!(v.get(dropped).is_none(), "{dropped} kept");
        }
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
        let src = scratch("assets").canonicalize().unwrap();
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
        let src = scratch("oxide").canonicalize().unwrap();
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
        let src = scratch("plain").canonicalize().unwrap();
        write(
            &src.join("wrangler.jsonc"),
            r#"{"name":"app","main":"index.js"}"#,
        );
        assert!(built_deploy_root(&src).unwrap().is_none());
    }

    #[test]
    fn redirect_outside_the_worktree_is_refused() {
        let outside = scratch("outside").canonicalize().unwrap();
        write(&outside.join("wrangler.json"), r#"{"name":"x"}"#);
        let src = scratch("escape").canonicalize().unwrap();
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
        let src = scratch("shared").canonicalize().unwrap();
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
        let dir = scratch("glob");
        write(&dir.join(".assetsignore"), "*.map\n");
        assert!(apply_assetsignore(&dir).is_err());
    }
}
