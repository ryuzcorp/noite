//! A Wrangler config for apps that bring none (SPEC, Deploy pipeline,
//! Generated config). Consulted only when the pushed tree, its build output
//! and its subdirectories hold no Wrangler config, so an app that declares
//! its Worker is never second-guessed.
//!
//! - **Static site**: the build left an `index.html` in `dist/`, `build/` or
//!   `out/` (Vite, Astro static, Create React App, a Next export). Deployed as
//!   assets only: unknown paths get `404.html` when the build wrote one, else
//!   `index.html` (a single-page app's client routes).
//! - **Worker**: `package.json` `main` names a module that exports a `fetch`
//!   handler (Hono, H3, Elysia, a hand-written Worker). A static output
//!   beside it is served first, and the Worker answers the rest.
//!
//! A Node server (`app.listen(…)`, `createServer`) is refused with a message:
//! celld implements neither `node:http` servers nor `IncomingMessage`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde_json::{json, Value};

/// Where builds put a static site, in the order they are tried.
const STATIC_DIRS: &[&str] = &["dist", "build", "out"];

/// The compatibility date written into generated configs.
const COMPATIBILITY_DATE: &str = "2026-09-01";

/// What to deploy, with paths relative to the project root.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Assets only.
    Static {
        dir: String,
        not_found: &'static str,
    },
    /// A module exporting `fetch`, optionally with static assets.
    Worker {
        main: String,
        assets: Option<String>,
    },
}

impl Plan {
    /// One line for the deploy log.
    pub fn note(&self) -> String {
        match self {
            Plan::Static { dir, not_found } => {
                let fallback = if *not_found == "404-page" {
                    "404.html"
                } else {
                    "index.html"
                };
                format!("generated: static site from {dir}/ (unknown paths get {fallback})")
            }
            Plan::Worker {
                main,
                assets: Some(dir),
            } => {
                format!("generated: Worker {main} with static assets from {dir}/")
            }
            Plan::Worker { main, assets: None } => format!("generated: Worker {main}"),
        }
    }
}

/// The first static output directory holding an `index.html`.
fn static_dir(root: &Path) -> Option<&'static str> {
    STATIC_DIRS
        .iter()
        .copied()
        .find(|dir| root.join(dir).join("index.html").is_file())
}

/// `package.json` `main`, normalised to a relative path, when it names a file.
fn package_main(root: &Path, package: Option<&Value>) -> anyhow::Result<Option<String>> {
    let Some(main) = package.and_then(|p| p.get("main")).and_then(Value::as_str) else {
        return Ok(None);
    };
    let main = main.trim().trim_start_matches("./");
    if main.is_empty() {
        return Ok(None);
    }
    if Path::new(main).is_absolute() || main.split('/').any(|part| part == "..") {
        bail!("package.json main {main:?} must be a path inside the project");
    }
    // `npm init` writes `"main": "index.js"` whether or not the file exists:
    // a missing file is not a declared entry.
    Ok(root.join(main).is_file().then(|| main.to_string()))
}

/// A module that starts its own HTTP server instead of exporting `fetch`.
/// A heuristic over the entry file itself, for a clear message up front
/// instead of a Worker that fails on its first request.
fn looks_like_node_server(source: &str) -> bool {
    let listens = source.contains(".listen(") || source.contains("createServer(");
    listens && !source.contains("fetch")
}

/// Decide what to deploy. `None` when the tree has nothing deployable.
pub fn plan(root: &Path, package: Option<&Value>) -> anyhow::Result<Option<Plan>> {
    let assets = static_dir(root);
    if let Some(main) = package_main(root, package)? {
        let source = std::fs::read_to_string(root.join(&main)).unwrap_or_default();
        if looks_like_node_server(&source) {
            bail!(
                "package.json main {main} starts a Node HTTP server; Noite runs Workers, which \
                 export a fetch handler instead (`export default {{ fetch }}`, or a framework's \
                 Cloudflare Workers target). Express-style `node:http` servers are not supported"
            );
        }
        if let Some(dir) = assets {
            if Path::new(&main).starts_with(dir) {
                bail!(
                    "package.json main {main} is inside the static output {dir}/, so its source \
                     would be served publicly; build the server entry outside {dir}/"
                );
            }
        }
        return Ok(Some(Plan::Worker {
            main,
            assets: assets.map(str::to_string),
        }));
    }
    Ok(assets.map(|dir| Plan::Static {
        dir: dir.to_string(),
        not_found: if root.join(dir).join("404.html").is_file() {
            "404-page"
        } else {
            "single-page-application"
        },
    }))
}

/// `path` resolved (symlinks too) and still inside `root`.
fn contained(root: &Path, rel: &str) -> anyhow::Result<PathBuf> {
    let root = root.canonicalize().context("resolve project root")?;
    let path = root
        .join(rel)
        .canonicalize()
        .with_context(|| format!("resolve {rel}"))?;
    if !path.starts_with(&root) {
        bail!("{rel} resolves outside the project");
    }
    Ok(path)
}

/// Write `wrangler.json` for `plan` at `root`. Runs after every tenant
/// process has finished (the tree is the runner's again), and re-resolves
/// each path so a symlink cannot point celld at files outside the project.
pub fn write(root: &Path, name: &str, plan: &Plan) -> anyhow::Result<()> {
    let mut config = json!({
        "name": name,
        "compatibility_date": COMPATIBILITY_DATE,
    });
    match plan {
        Plan::Static { dir, not_found } => {
            contained(root, dir)?;
            config["assets"] = json!({ "directory": dir, "not_found_handling": not_found });
        }
        Plan::Worker { main, assets } => {
            contained(root, main)?;
            config["main"] = json!(main);
            config["compatibility_flags"] = json!(["nodejs_compat"]);
            if let Some(dir) = assets {
                contained(root, dir)?;
                // Assets answer first; a path with no file reaches the Worker,
                // which can also read them through `env.ASSETS`.
                config["assets"] = json!({ "directory": dir, "binding": "ASSETS" });
            }
        }
    }
    let text = serde_json::to_string_pretty(&config)?;
    std::fs::write(root.join("wrangler.json"), format!("{text}\n"))
        .context("write wrangler.json")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-generated-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn written(root: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(root.join("wrangler.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_vite_build_deploys_as_a_single_page_app() {
        let root = scratch("spa");
        write_file(&root, "dist/index.html", "<!doctype html>");
        write_file(&root, "dist/assets/app.js", "");
        let plan = plan(
            &root,
            Some(&json!({ "scripts": { "build": "vite build" } })),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            plan,
            Plan::Static {
                dir: "dist".into(),
                not_found: "single-page-application"
            }
        );
        write(&root, "hello", &plan).unwrap();
        let config = written(&root);
        assert_eq!(config["name"], "hello");
        assert_eq!(config["assets"]["directory"], "dist");
        assert!(config.get("main").is_none(), "assets only: {config}");
    }

    #[test]
    fn a_404_page_turns_the_spa_fallback_off() {
        let root = scratch("mpa");
        write_file(&root, "out/index.html", "");
        write_file(&root, "out/404.html", "");
        let plan = plan(&root, None).unwrap().unwrap();
        assert_eq!(
            plan,
            Plan::Static {
                dir: "out".into(),
                not_found: "404-page"
            }
        );
    }

    #[test]
    fn dist_wins_over_build_and_out() {
        let root = scratch("order");
        write_file(&root, "build/index.html", "");
        write_file(&root, "dist/index.html", "");
        assert!(
            matches!(plan(&root, None).unwrap(), Some(Plan::Static { dir, .. }) if dir == "dist")
        );
    }

    #[test]
    fn a_fetch_module_deploys_as_a_worker_with_its_assets() {
        let root = scratch("worker");
        write_file(
            &root,
            "server/index.js",
            "export default { fetch() { return new Response('hi') } }",
        );
        write_file(&root, "dist/index.html", "");
        let package = json!({ "main": "./server/index.js" });
        let plan = plan(&root, Some(&package)).unwrap().unwrap();
        assert_eq!(
            plan,
            Plan::Worker {
                main: "server/index.js".into(),
                assets: Some("dist".into())
            }
        );
        write(&root, "api", &plan).unwrap();
        let config = written(&root);
        assert_eq!(config["main"], "server/index.js");
        assert_eq!(config["compatibility_flags"], json!(["nodejs_compat"]));
        assert_eq!(config["assets"]["binding"], "ASSETS");
    }

    #[test]
    fn an_npm_init_main_that_does_not_exist_is_ignored() {
        let root = scratch("npm-init");
        write_file(&root, "dist/index.html", "");
        let plan = plan(&root, Some(&json!({ "main": "index.js" })))
            .unwrap()
            .unwrap();
        assert!(matches!(plan, Plan::Static { .. }), "{plan:?}");
    }

    #[test]
    fn a_node_server_is_refused_with_a_reason() {
        let root = scratch("express");
        write_file(
            &root,
            "index.js",
            "const app = express(); app.listen(3000);",
        );
        let err = plan(&root, Some(&json!({ "main": "index.js" })))
            .unwrap_err()
            .to_string();
        assert!(err.contains("Node HTTP server"), "{err}");
        // Bun/Deno-style servers that also export fetch are not Node servers.
        write_file(
            &root,
            "index.js",
            "export default { fetch: app.fetch }; if (dev) server.listen(3000);",
        );
        assert!(plan(&root, Some(&json!({ "main": "index.js" }))).is_ok());
    }

    #[test]
    fn a_server_entry_inside_the_public_output_is_refused() {
        let root = scratch("leak");
        write_file(&root, "dist/index.html", "");
        write_file(&root, "dist/server.js", "export default { fetch() {} }");
        let err = plan(&root, Some(&json!({ "main": "dist/server.js" })))
            .unwrap_err()
            .to_string();
        assert!(err.contains("served publicly"), "{err}");
    }

    #[test]
    fn paths_must_stay_inside_the_project() {
        let root = scratch("escape");
        assert!(plan(&root, Some(&json!({ "main": "../x.js" }))).is_err());
        assert!(plan(&root, Some(&json!({ "main": "/etc/passwd" }))).is_err());
        #[cfg(unix)]
        {
            let outside = scratch("escape-target");
            write_file(&outside, "index.html", "");
            std::os::unix::fs::symlink(&outside, root.join("dist")).unwrap();
            let plan = plan(&root, None).unwrap().unwrap();
            let err = write(&root, "x", &plan).unwrap_err().to_string();
            assert!(err.contains("outside the project"), "{err}");
        }
    }

    #[test]
    fn nothing_deployable_is_none() {
        let root = scratch("empty");
        write_file(&root, "src/main.ts", "");
        assert!(plan(&root, Some(&json!({ "name": "x" })))
            .unwrap()
            .is_none());
    }
}
