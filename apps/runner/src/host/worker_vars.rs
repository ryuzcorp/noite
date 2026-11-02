//! Settings → Worker `vars` (SPEC, Tenant env): every app setting (Settings →
//! Environment), or an environment's overrides over them, becomes a
//! plain-text entry in the deployed config's `vars`, so Worker code reads it
//! as `env.NAME`. A setting wins over the config's own value. The merge runs
//! in the deploy pipeline after the deploy root is final (build output,
//! source config or generated config) and before `celld deploy`, and a
//! settings change takes effect on the next deploy.
//!
//! Reserved names (shared contract): a setting or a config `vars` entry with
//! a runner-owned name fails the deploy with the name in the log —
//! `__VOID_PROXY`, `__PROJECT_ID`, `__VOID_PROXY_TOKEN`,
//! `__VOID_PROJECT_SLUG`, `__VOID_EMAIL_DOMAIN`, `__VOID_EMAIL_DEPLOYMENT_ID`
//! (`ISR_CACHE` joins once the runner injects it). The build/fleet process
//! prefixes (`PORT`, `AWS_*`, `CELLD_*`, `BETTER_AUTH_*`, …) do NOT apply
//! here: they guard the process environment, and Worker `vars` are a separate
//! namespace no platform component reads (SPEC documents the per-prefix
//! decision). `BETTER_AUTH_*` in particular must stay allowed: Void auth
//! needs `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` in Worker env.
//!
//! Void's `secrets.required` (its `dist/ssr/wrangler.json` carries one, which
//! the build-output rewrite drops because celld refuses the key): every
//! required name needs a setting or a runner-provisioned value, else the
//! deploy fails before `celld deploy` listing the missing names.
//!
//! Values are plaintext in the deployed config (celld has no secret store):
//! they land in `app.deployed_config` (never served) and in celld's
//! deployment manifest under the fleet bucket. The deploy log and every error
//! below carry names only, never values.

use std::collections::HashSet;
use std::path::Path;

use anyhow::Context;
use serde_json::Value;

/// Runner-owned Worker vars: refused in settings and in config `vars` alike.
const RESERVED_WORKER_VARS: &[&str] = &[
    "__VOID_PROXY",
    "__PROJECT_ID",
    "__VOID_PROXY_TOKEN",
    "__VOID_PROJECT_SLUG",
    "__VOID_EMAIL_DOMAIN",
    "__VOID_EMAIL_DEPLOYMENT_ID",
];

/// True for the runner-owned names no setting or config `vars` entry may use.
pub fn worker_var_reserved(name: &str) -> bool {
    RESERVED_WORKER_VARS.contains(&name)
}

/// Names the runner itself provides as Worker vars: a `secrets.required`
/// entry naming one is satisfied without a setting. Today only the reserved
/// runner-owned names; a later slice provisions `BETTER_AUTH_SECRET` here.
pub fn provisioned_names() -> HashSet<String> {
    RESERVED_WORKER_VARS
        .iter()
        .map(ToString::to_string)
        .collect()
}

/// The `secrets.required` names in a config, if it carries a readable one.
/// Anything else shaped (no `secrets`, no array) yields nothing: the runner
/// drops the key either way, and only a real required list can fail a deploy.
pub fn required_secrets(config: &Value) -> Vec<String> {
    config
        .get("secrets")
        .and_then(|secrets| secrets.get("required"))
        .and_then(Value::as_array)
        .map(|required| {
            required
                .iter()
                .filter_map(|name| name.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Fail the deploy when a required secret has neither a setting nor a
/// provisioned value. The error lists the missing names (sorted, deduped)
/// and where to set them; values never appear.
pub fn check_required(
    required: &[String],
    settings: &[(String, String)],
    provisioned: &HashSet<String>,
    settings_label: &str,
) -> anyhow::Result<()> {
    let have: HashSet<&str> = settings.iter().map(|(name, _)| name.as_str()).collect();
    let mut missing: Vec<&str> = required
        .iter()
        .map(String::as_str)
        .filter(|name| !have.contains(name) && !provisioned.contains(*name))
        .collect();
    missing.sort_unstable();
    missing.dedup();
    if missing.is_empty() {
        return Ok(());
    }
    anyhow::bail!(
        "missing required secrets: {} (set each one in {}, then redeploy)",
        missing.join(", "),
        settings_label
    );
}

/// What one merge did, for the deploy log.
#[derive(Debug, PartialEq, Eq)]
pub struct MergeStats {
    /// Settings merged into `vars` (every setting merges).
    pub merged: usize,
    /// Merged settings that replaced the config's own value.
    pub overrode: usize,
}

impl MergeStats {
    /// The deploy-log line: counts only, never names or values.
    pub fn log_line(&self) -> String {
        if self.overrode > 0 {
            format!(
                "worker vars: merged {} Settings variable(s) into vars ({} overrode the config's own value(s))\n",
                self.merged, self.overrode
            )
        } else {
            format!(
                "worker vars: merged {} Settings variable(s) into vars\n",
                self.merged
            )
        }
    }
}

/// Merge `settings` into the config's `vars` (setting wins over the config's
/// own value). Reserved names fail the deploy, whether they come from
/// settings or from the config itself. `settings_label` is where the log
/// tells the operator to fix settings (`Settings → Environment`, or the
/// environment's overrides).
pub fn merge_settings(
    config: &mut Value,
    settings: &[(String, String)],
    settings_label: &str,
) -> anyhow::Result<MergeStats> {
    let Some(obj) = config.as_object_mut() else {
        anyhow::bail!("the Wrangler config is not a JSON object");
    };
    if let Some(name) = settings
        .iter()
        .map(|(name, _)| name)
        .find(|name| worker_var_reserved(name))
    {
        anyhow::bail!(
            "settings variable `{name}` is reserved for the platform and cannot become a Worker var (rename it or remove it from {settings_label})"
        );
    }
    let vars = match obj.get_mut("vars") {
        None => {
            obj.insert("vars".to_string(), Value::Object(Default::default()));
            obj.get_mut("vars")
                .and_then(Value::as_object_mut)
                .expect("vars just inserted as an object")
        }
        Some(vars) => vars
            .as_object_mut()
            .with_context(|| "config `vars` must be an object")?,
    };
    if let Some(name) = vars.keys().find(|name| worker_var_reserved(name)) {
        anyhow::bail!(
            "the config's `vars.{name}` is reserved for the platform (remove it from the config's `vars`)"
        );
    }
    let before: HashSet<&str> = vars.keys().map(String::as_str).collect();
    let overrode = settings
        .iter()
        .filter(|(name, _)| before.contains(name.as_str()))
        .count();
    for (name, value) in settings {
        vars.insert(name.clone(), Value::String(value.clone()));
    }
    Ok(MergeStats {
        merged: settings.len(),
        overrode,
    })
}

/// Merge `settings` into the deploy root's `wrangler.jsonc`/`wrangler.json`
/// (`jsonc` first, as celld reads them), parsed with
/// [`crate::host::storage::parse_wrangler`] and written back as JSON through
/// [`crate::host::build_output::write_fresh`] (never following links; plain
/// JSON is valid JSONC, so a `.jsonc` target stays parseable).
/// `Ok(None)` when the root has neither file — a TOML-only root, which
/// `celld deploy` itself refuses with a clear error. With no settings the
/// file is still checked (reserved config names fail) but left untouched.
pub fn merge_deploy_root(
    deploy_root: &Path,
    settings: &[(String, String)],
    settings_label: &str,
) -> anyhow::Result<Option<MergeStats>> {
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
    let stats = merge_settings(&mut value, settings, settings_label)?;
    if stats.merged > 0 {
        crate::host::build_output::write_fresh(
            &deploy_root.join(label),
            &serde_json::to_string_pretty(&value)?,
        )?;
    }
    Ok(Some(stats))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    /// Every name the process-env filter reserves must stay deployable as a
    /// Worker var: the two namespaces are separate, and Void auth needs
    /// `BETTER_AUTH_*` in Worker env.
    #[test]
    fn process_env_prefixes_stay_allowed_as_worker_vars() {
        for name in [
            "PORT",
            "HOST",
            "AWS_REGION",
            "S3_ENDPOINT",
            "CELLD_WATCH",
            "RUNNER_TOKEN",
            "NOITE_IMAGE",
            "BETTER_AUTH_SECRET",
            "BETTER_AUTH_URL",
            "CADDY_ADMIN",
            "LD_PRELOAD",
            "NODE_OPTIONS",
            "BUN_BEACON",
            "DOCKER_HOST",
            "VITE_PUBLIC_URL",
        ] {
            assert!(!worker_var_reserved(name), "{name} refused");
            let mut config = json!({"name": "a"});
            let stats = merge_settings(&mut config, &settings(&[(name, "v")]), "Settings")
                .unwrap_or_else(|e| panic!("{name}: {e:#}"));
            assert_eq!(stats.merged, 1);
            assert_eq!(config["vars"][name], "v");
        }
    }

    #[test]
    fn settings_win_over_the_configs_own_values() {
        let mut config = json!({
            "name": "a",
            "vars": {"SHARED": "config", "CONFIG_ONLY": "kept"},
        });
        let stats = merge_settings(
            &mut config,
            &settings(&[("SHARED", "setting"), ("SETTING_ONLY", "new")]),
            "Settings",
        )
        .unwrap();
        assert_eq!(
            stats,
            MergeStats {
                merged: 2,
                overrode: 1
            }
        );
        assert_eq!(config["vars"]["SHARED"], "setting");
        assert_eq!(config["vars"]["CONFIG_ONLY"], "kept");
        assert_eq!(config["vars"]["SETTING_ONLY"], "new");
    }

    #[test]
    fn reserved_names_are_refused_from_settings_and_config() {
        for name in RESERVED_WORKER_VARS {
            let mut config = json!({"name": "a"});
            let err = merge_settings(
                &mut config,
                &settings(&[(*name, "v")]),
                "Settings → Environment",
            )
            .unwrap_err();
            assert!(
                format!("{err:#}").contains(name),
                "reserved setting unnamed: {err:#}"
            );
            let mut vars = serde_json::Map::new();
            vars.insert((*name).to_string(), Value::String("spoof".to_string()));
            let mut config = json!({"name": "a", "vars": Value::Object(vars)});
            let err = merge_settings(&mut config, &[], "Settings → Environment").unwrap_err();
            assert!(
                format!("{err:#}").contains(name),
                "reserved config var unnamed: {err:#}"
            );
        }
    }

    #[test]
    fn malformed_vars_and_configs_fail_clearly() {
        let mut config = json!({"name": "a", "vars": ["x"]});
        assert!(format!(
            "{:#}",
            merge_settings(&mut config, &settings(&[("A", "v")]), "Settings").unwrap_err()
        )
        .contains("must be an object"));
        let mut config = json!([1]);
        assert!(merge_settings(&mut config, &[], "Settings").is_err());
    }

    #[test]
    fn required_secrets_need_a_setting_or_a_provisioned_value() {
        let required = ["SECRET_KEY".to_string(), "DATABASE_URL".to_string()];
        let empty = HashSet::new();
        // Missing names are listed, sorted.
        let err = check_required(
            &["B_KEY".to_string(), "A_KEY".to_string()],
            &[],
            &empty,
            "Settings",
        )
        .unwrap_err();
        assert!(
            format!("{err:#}").contains("A_KEY, B_KEY"),
            "missing names not listed: {err:#}"
        );
        // A setting satisfies one; the provisioned set satisfies the other.
        let mut provisioned = HashSet::new();
        provisioned.insert("DATABASE_URL".to_string());
        assert!(check_required(
            &required,
            &settings(&[("SECRET_KEY", "v")]),
            &provisioned,
            "Settings"
        )
        .is_ok());
        // The runner-owned names are provisioned by default.
        assert!(check_required(
            &["__PROJECT_ID".to_string()],
            &[],
            &provisioned_names(),
            "Settings"
        )
        .is_ok());
        assert!(check_required(&[], &[], &empty, "Settings").is_ok());
    }

    #[test]
    fn required_lists_are_read_liberally() {
        assert_eq!(
            required_secrets(&json!({"secrets": {"required": ["A", "B"]}})),
            ["A", "B"]
        );
        assert!(required_secrets(&json!({"name": "a"})).is_empty());
        assert!(required_secrets(&json!({"secrets": {"required": "A"}})).is_empty());
        assert_eq!(
            required_secrets(&json!({"secrets": {"required": ["A", 1, null]}})),
            ["A"]
        );
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-worker-vars-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn jsonc_merges_and_stays_parseable() {
        let dir = scratch("jsonc").canonicalize().unwrap();
        std::fs::write(
            dir.join("wrangler.jsonc"),
            r#"{
  // the worker
  "name": "a", /* trailing */ "main": "./worker.js",
  "vars": { "FROM_CONFIG": "c", }, // trailing comma
}"#,
        )
        .unwrap();
        let stats = merge_deploy_root(&dir, &settings(&[("FROM_SETTINGS", "s")]), "Settings")
            .unwrap()
            .expect("jsonc found");
        assert_eq!(stats.merged, 1);
        let text = std::fs::read_to_string(dir.join("wrangler.jsonc")).unwrap();
        // Plain JSON is valid JSONC: celld still parses the rewritten file.
        let value = crate::host::storage::parse_wrangler(&text).unwrap();
        assert_eq!(value["name"], "a");
        assert_eq!(value["vars"]["FROM_CONFIG"], "c");
        assert_eq!(value["vars"]["FROM_SETTINGS"], "s");
    }

    #[test]
    fn jsonc_wins_over_json_like_celld() {
        let dir = scratch("both").canonicalize().unwrap();
        std::fs::write(dir.join("wrangler.jsonc"), r#"{"name":"a"}"#).unwrap();
        std::fs::write(
            dir.join("wrangler.json"),
            r#"{"name":"a","vars":{"STALE":"x"}}"#,
        )
        .unwrap();
        merge_deploy_root(&dir, &settings(&[("N", "v")]), "Settings").unwrap();
        let jsonc = std::fs::read_to_string(dir.join("wrangler.jsonc")).unwrap();
        assert!(jsonc.contains("\"N\""), "{jsonc}");
        let json = std::fs::read_to_string(dir.join("wrangler.json")).unwrap();
        assert!(!json.contains("\"N\""), "{json}");
    }

    #[test]
    fn empty_settings_leave_the_file_byte_identical() {
        let dir = scratch("untouched").canonicalize().unwrap();
        let before = "// kept\n{\"name\": \"a\", \"vars\": {},}\n";
        std::fs::write(dir.join("wrangler.jsonc"), before).unwrap();
        let stats = merge_deploy_root(&dir, &[], "Settings")
            .unwrap()
            .expect("jsonc found");
        assert_eq!(stats.merged, 0);
        assert_eq!(
            std::fs::read_to_string(dir.join("wrangler.jsonc")).unwrap(),
            before
        );
    }

    #[test]
    fn toml_only_roots_are_left_for_celld_to_refuse() {
        let dir = scratch("toml").canonicalize().unwrap();
        std::fs::write(dir.join("wrangler.toml"), "name = \"a\"\n").unwrap();
        assert!(
            merge_deploy_root(&dir, &settings(&[("N", "v")]), "Settings")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    #[cfg(unix)]
    fn the_merge_never_writes_through_a_planted_link() {
        let dir = scratch("link").canonicalize().unwrap();
        let victim_dir = scratch("link-victim").canonicalize().unwrap();
        let victim = victim_dir.join("owned");
        std::fs::write(&victim, r#"{"name":"a"}"#).unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("wrangler.json")).unwrap();
        merge_deploy_root(&dir, &settings(&[("N", "v")]), "Settings").unwrap();
        // The link is replaced by a real file; the outside target is intact.
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), r#"{"name":"a"}"#);
        assert!(std::fs::symlink_metadata(dir.join("wrangler.json"))
            .unwrap()
            .is_file());
    }
}
