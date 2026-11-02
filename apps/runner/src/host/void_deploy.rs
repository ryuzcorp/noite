//! Runner-owned Void injections (SPEC, Deploy pipeline): what a Void app's
//! deploy gets beyond its settings, merged into the final config alongside
//! the Worker-vars merge and through the same write path.
//!
//! The gate is [`is_void_build`]: the deploy root came from Void's build
//! output (`dist/ssr/wrangler.json`). Anything else deploys exactly as
//! before — no vars, no bindings, no new failure modes.
//!
//! For a Void app the merge ([`merge_runner_owned`]) writes:
//!
//! - identity vars: `__PROJECT_ID` (the Noite app id, environments included —
//!   Void scopes it per project, and the proxy pins the caller's `projectId`
//!   against its own copy, so both scripts in a fleet must agree),
//!   `__VOID_PROJECT_SLUG` (the app slug, same scoping), and
//!   `__VOID_PROXY_TOKEN` (a random per-fleet token, minted once and stored
//!   as a runner-provisioned setting: the app's row for production, one row
//!   per environment for previews — never inherited, so each fleet's token
//!   is its own);
//! - runner-owned `services` on top of the tenant's (preserved): a collision
//!   with a runner-owned binding name fails the deploy naming it;
//! - the `ISR_CACHE` KV namespace (`binding: ISR_CACHE`, one fixed id):
//!   celld scopes a namespace id to the fleet bucket, so the fixed id is a
//!   distinct namespace per app and per environment — previews never share
//!   production's ISR cache — and the proxy slice binds the same id in the
//!   same bucket to purge it.
//!
//! The `__VOID_PROXY` service binding itself is NOT injected yet: the proxy
//! script does not exist in fleets until the proxy slice, and a dangling
//! service fails celld adoption. The binding name is already reserved (a
//! tenant entry collides loudly), and the proxy slice adds its one entry in
//! [`runner_services`] — the only place that changes.
//!
//! `BETTER_AUTH_SECRET` is provisioned, not merged here: when a Void app's
//! `secrets.required` lists it and no setting exists, [`ensure_auth_secret`]
//! mints 32 random bytes hex and stores them as an `auth-default` setting at
//! the app level (one per app; environments inherit it unless overridden),
//! and the value then flows through the ordinary settings load into the
//! slice-1 merge. A user value — app or override — always wins and is never
//! overwritten.
//!
//! Values at rest are plaintext settings rows like any other (`app_env` /
//! `environment_env`, plus the merged config in `app.deployed_config` and
//! celld's manifest): the UI redacts them as usual, the deploy log carries
//! names only, never values.

use std::path::Path;

use anyhow::Context;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db;
use crate::host::build_output::BuiltRoot;

/// The runner-owned proxy Worker script, one per Void fleet (proxy slice).
/// A tenant config using it as its script `name` would alias the proxy's
/// named pointer, so it fails the deploy.
pub const PROXY_SCRIPT_NAME: &str = "noite-void-proxy";

/// The service binding the proxy slice injects. Reserved now (a tenant
/// entry fails the deploy), injected then.
pub const PROXY_BINDING: &str = "__VOID_PROXY";

/// Identity vars the runner-owned merge writes for Void apps.
pub const PROJECT_ID_VAR: &str = "__PROJECT_ID";
pub const PROJECT_SLUG_VAR: &str = "__VOID_PROJECT_SLUG";
pub const PROXY_TOKEN_VAR: &str = "__VOID_PROXY_TOKEN";

/// The ISR KV namespace the runner injects for Void apps.
pub const ISR_CACHE_BINDING: &str = "ISR_CACHE";

/// The namespace id behind [`ISR_CACHE_BINDING`]. Fixed across apps: celld
/// takes the id verbatim and scopes it to the fleet bucket, so production
/// (`fleets/<slug>/`) and each preview (`envs/<slug>/<label>/`) already get
/// distinct namespaces. Stable across deploys, so the cache — and the
/// proxy's purge binding — survives them.
pub const ISR_CACHE_NAMESPACE_ID: &str = "noite-isr-cache";

/// The auth secret Void requires (`secrets.required`) and the runner
/// provisions when no setting exists.
pub const AUTH_SECRET_NAME: &str = "BETTER_AUTH_SECRET";

/// Binding names the runner owns in `services`: a tenant entry using one
/// fails the deploy naming it. Today only the proxy binding (reserved
/// ahead of its injection); [`runner_services`] decides what is injected.
const RUNNER_BINDINGS: &[&str] = &[PROXY_BINDING];

/// True when the deploy root came from Void's build output — the one gate
/// for every injection in this module. `None` (source config, generated
/// config) and any other build output are not Void apps.
pub fn is_void_build(built: Option<&BuiltRoot>) -> bool {
    built.is_some_and(|root| root.void)
}

/// 32 random bytes, base64url: the per-fleet proxy token.
pub fn mint_proxy_token() -> String {
    use base64::Engine as _;
    use rand::TryRng as _;
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 32 random bytes hex, both Void implementations' `BETTER_AUTH_SECRET`.
pub fn mint_auth_secret() -> String {
    use rand::TryRng as _;
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Ensure the app-level auto-provisioned `BETTER_AUTH_SECRET`, unless a
/// value already exists: an environment override (any source — overrides
/// are user-written) or any app-level row wins, and nothing is overwritten.
/// Environments inherit the app's row through the ordinary settings load.
/// Returns whether this call minted the secret.
pub async fn ensure_auth_secret(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> anyhow::Result<bool> {
    if let Some(env_id) = environment_id {
        if db::get_env_override(pool, env_id, AUTH_SECRET_NAME)
            .await?
            .is_some()
        {
            return Ok(false);
        }
    }
    if db::get_env(pool, app_id, AUTH_SECRET_NAME).await?.is_some() {
        return Ok(false);
    }
    // Mint-then-insert loses nothing under a raced deploy: the loser reuses
    // the winner's row through the settings load that follows.
    db::insert_provisioned(
        pool,
        app_id,
        AUTH_SECRET_NAME,
        &mint_auth_secret(),
        db::SOURCE_AUTH_DEFAULT,
    )
    .await?;
    Ok(true)
}

/// Ensure this fleet's `__VOID_PROXY_TOKEN`: the app-level row for
/// production, the environment's own row for a preview (per-fleet, never
/// inherited). Minted once, reused on later deploys; a user row under the
/// name fails the deploy as reserved instead of being read or overwritten
/// (unreachable in the deploy flow — the settings merge refuses it first —
/// but the helper must not depend on that).
pub async fn ensure_proxy_token(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> anyhow::Result<(String, bool)> {
    match environment_id {
        None => {
            if let Some(row) = db::get_env(pool, app_id, PROXY_TOKEN_VAR).await? {
                if row.source != db::SOURCE_VOID_PROXY_TOKEN {
                    anyhow::bail!(
                        "settings variable `{PROXY_TOKEN_VAR}` is reserved for the platform and cannot become a Worker var (rename it or remove it from Settings → Environment)"
                    );
                }
                return Ok((row.value, false));
            }
            let token = mint_proxy_token();
            db::insert_provisioned(
                pool,
                app_id,
                PROXY_TOKEN_VAR,
                &token,
                db::SOURCE_VOID_PROXY_TOKEN,
            )
            .await?;
            let row = db::get_env(pool, app_id, PROXY_TOKEN_VAR)
                .await?
                .context("provisioned proxy token missing")?;
            let minted = row.value == token;
            Ok((row.value, minted))
        }
        Some(env_id) => {
            if let Some(row) = db::get_env_override(pool, env_id, PROXY_TOKEN_VAR).await? {
                if row.source != db::SOURCE_VOID_PROXY_TOKEN {
                    anyhow::bail!(
                        "settings variable `{PROXY_TOKEN_VAR}` is reserved for the platform and cannot become a Worker var (rename it or remove it from this environment's Variable overrides)"
                    );
                }
                return Ok((row.value, false));
            }
            let token = mint_proxy_token();
            db::insert_env_override_provisioned(
                pool,
                env_id,
                PROXY_TOKEN_VAR,
                &token,
                db::SOURCE_VOID_PROXY_TOKEN,
            )
            .await?;
            let row = db::get_env_override(pool, env_id, PROXY_TOKEN_VAR)
                .await?
                .context("provisioned proxy token missing")?;
            let minted = row.value == token;
            Ok((row.value, minted))
        }
    }
}

/// Mint a fresh proxy token for the fleet, overwriting whatever the row
/// held. Takes effect on the next deploy of that fleet (production or the
/// environment): the deploy injects the new token into the app and — once
/// the proxy slice lands — redeploys the proxy beside it, so both agree.
pub async fn rotate_proxy_token(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> anyhow::Result<String> {
    let token = mint_proxy_token();
    match environment_id {
        None => {
            db::set_provisioned(
                pool,
                app_id,
                PROXY_TOKEN_VAR,
                &token,
                db::SOURCE_VOID_PROXY_TOKEN,
            )
            .await?;
        }
        Some(env_id) => {
            db::set_env_override_provisioned(
                pool,
                env_id,
                PROXY_TOKEN_VAR,
                &token,
                db::SOURCE_VOID_PROXY_TOKEN,
            )
            .await?;
        }
    }
    Ok(token)
}

/// One runner-owned `services` entry: `{binding, service}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerService {
    pub binding: &'static str,
    pub service: &'static str,
}

/// The runner-owned `services` entries for a Void app's deploy. Empty
/// today: the `__VOID_PROXY` entry lands with the proxy slice (which
/// deploys the `noite-void-proxy` script first) — a dangling service would
/// fail celld adoption, so nothing is injected until then. The proxy slice
/// adds its entry here, in this one place.
pub fn runner_services() -> Vec<RunnerService> {
    Vec::new()
}

/// The runner-owned values for one Void deploy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerOwned {
    pub project_id: String,
    pub project_slug: String,
    pub proxy_token: String,
    pub services: Vec<RunnerService>,
}

/// What one runner-owned merge did, for the deploy log.
#[derive(Debug, PartialEq, Eq)]
pub struct RunnerOwnedStats {
    /// Identity vars written into `vars`.
    pub vars_injected: usize,
    /// Runner-owned `services` entries appended.
    pub services_added: usize,
    /// Whether the `ISR_CACHE` namespace was appended.
    pub isr_cache_added: bool,
    /// Whether this deploy minted the fleet's token (else it reused it).
    pub token_minted: bool,
}

impl RunnerOwnedStats {
    /// The deploy-log line: counts and names only, never values.
    pub fn log_line(&self, settings_label: &str) -> String {
        let mut line = format!(
            "void: injected {} identity var(s), {} runner-owned service(s) and the ISR_CACHE namespace\n",
            self.vars_injected, self.services_added
        );
        if self.token_minted {
            line.push_str(&format!(
                "void: minted the fleet's __VOID_PROXY_TOKEN (stored in {settings_label}; redeploying reuses it)\n"
            ));
        }
        line
    }
}

/// Merge the runner-owned entries into a Void app's config: the identity
/// vars, the runner-owned `services`, and the `ISR_CACHE` namespace. The
/// tenant's `services` are preserved; a collision with a runner-owned
/// binding name — or a script `name`, `vars` entry or setting the runner
/// owns — fails the deploy naming it. `settings` is the merged user
/// settings (for the Void-reserved check); `settings_label` says where to
/// fix them, as in the settings merge.
pub fn merge_runner_owned(
    config: &mut Value,
    settings: &[(String, String)],
    owned: &RunnerOwned,
    settings_label: &str,
) -> anyhow::Result<RunnerOwnedStats> {
    let Some(obj) = config.as_object_mut() else {
        anyhow::bail!("the Wrangler config is not a JSON object");
    };
    // The settings merge already refused the global reserved names; the
    // Void-only ones (`ISR_CACHE`) are refused here, where the gate is known.
    if let Some(name) = settings
        .iter()
        .map(|(name, _)| name)
        .find(|name| crate::host::worker_vars::worker_var_reserved_for(name, true))
    {
        anyhow::bail!(
            "settings variable `{name}` is reserved for the platform and cannot become a Worker var (rename it or remove it from {settings_label})"
        );
    }
    if obj.get("name").and_then(Value::as_str) == Some(PROXY_SCRIPT_NAME) {
        anyhow::bail!(
            "the config's `name` is `{PROXY_SCRIPT_NAME}`, reserved for the platform's Void proxy script (rename the Worker)"
        );
    }
    let services = match obj.get_mut("services") {
        None => {
            obj.insert("services".to_string(), Value::Array(Vec::new()));
            obj.get_mut("services")
                .and_then(Value::as_array_mut)
                .expect("services just inserted as an array")
        }
        Some(services) => services
            .as_array_mut()
            .with_context(|| "config `services` must be an array")?,
    };
    for entry in services.iter() {
        if let Some(binding) = entry.get("binding").and_then(Value::as_str) {
            if RUNNER_BINDINGS.contains(&binding) {
                anyhow::bail!(
                    "the config's `services` entry `{binding}` is reserved for the platform (remove it: the runner injects its own)"
                );
            }
        }
    }
    for service in &owned.services {
        services.push(serde_json::json!({"binding": service.binding, "service": service.service}));
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
    if let Some(name) = vars
        .keys()
        .find(|name| crate::host::worker_vars::worker_var_reserved_for(name, true))
    {
        anyhow::bail!(
            "the config's `vars.{name}` is reserved for the platform (remove it from the config's `vars`)"
        );
    }
    vars.insert(
        PROJECT_ID_VAR.to_string(),
        Value::String(owned.project_id.clone()),
    );
    vars.insert(
        PROJECT_SLUG_VAR.to_string(),
        Value::String(owned.project_slug.clone()),
    );
    vars.insert(
        PROXY_TOKEN_VAR.to_string(),
        Value::String(owned.proxy_token.clone()),
    );
    let namespaces = match obj.get_mut("kv_namespaces") {
        None => {
            obj.insert("kv_namespaces".to_string(), Value::Array(Vec::new()));
            obj.get_mut("kv_namespaces")
                .and_then(Value::as_array_mut)
                .expect("kv_namespaces just inserted as an array")
        }
        Some(namespaces) => namespaces
            .as_array_mut()
            .with_context(|| "config `kv_namespaces` must be an array")?,
    };
    for entry in namespaces.iter() {
        if entry.get("binding").and_then(Value::as_str) == Some(ISR_CACHE_BINDING) {
            anyhow::bail!(
                "the config's `kv_namespaces` entry `{ISR_CACHE_BINDING}` is reserved for the platform (remove it: the runner injects its own)"
            );
        }
        if entry.get("id").and_then(Value::as_str) == Some(ISR_CACHE_NAMESPACE_ID) {
            anyhow::bail!(
                "the config's `kv_namespaces` entry uses the namespace id `{ISR_CACHE_NAMESPACE_ID}`, reserved for the platform's ISR cache (use another id)"
            );
        }
    }
    namespaces
        .push(serde_json::json!({"binding": ISR_CACHE_BINDING, "id": ISR_CACHE_NAMESPACE_ID}));
    Ok(RunnerOwnedStats {
        vars_injected: 3,
        services_added: owned.services.len(),
        isr_cache_added: true,
        token_minted: false,
    })
}

/// Merge the runner-owned entries into the deploy root's
/// `wrangler.jsonc`/`wrangler.json` (`jsonc` first, as celld reads them),
/// parsed and written back like the settings merge (never following links).
/// `Ok(None)` when the root has neither file — a TOML-only root, which
/// `celld deploy` itself refuses. The fleet's token is ensured (minted
/// once, then reused) and its mint recorded in the stats.
pub async fn merge_void_root(
    pool: &SqlitePool,
    app: &crate::models::App,
    environment: Option<&crate::models::Environment>,
    deploy_root: &Path,
    settings: &[(String, String)],
    settings_label: &str,
) -> anyhow::Result<Option<RunnerOwnedStats>> {
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
    let environment_id = environment.map(|env| env.id.as_str());
    let (proxy_token, token_minted) = ensure_proxy_token(pool, &app.id, environment_id).await?;
    let mut stats = merge_runner_owned(
        &mut value,
        settings,
        &RunnerOwned {
            project_id: app.id.clone(),
            project_slug: app.slug.clone(),
            proxy_token,
            services: runner_services(),
        },
        settings_label,
    )?;
    stats.token_minted = token_minted;
    crate::host::build_output::write_fresh(
        &deploy_root.join(label),
        &serde_json::to_string_pretty(&value)?,
    )?;
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

    fn owned() -> RunnerOwned {
        RunnerOwned {
            project_id: "app-1".to_string(),
            project_slug: "blog".to_string(),
            proxy_token: "tok".to_string(),
            services: runner_services(),
        }
    }

    #[test]
    fn only_a_void_built_root_is_a_void_app() {
        assert!(!is_void_build(None));
        for (void, expect) in [(true, true), (false, false)] {
            let built = BuiltRoot {
                dir: Default::default(),
                note: String::new(),
                required_secrets: Vec::new(),
                void,
            };
            assert_eq!(is_void_build(Some(&built)), expect);
        }
    }

    #[test]
    fn minted_secrets_have_their_shapes() {
        use base64::Engine as _;
        let token = mint_proxy_token();
        assert_eq!(token.len(), 43, "{token}");
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&token)
                .unwrap()
                .len(),
            32
        );
        assert_ne!(mint_proxy_token(), token);
        let secret = mint_auth_secret();
        assert_eq!(secret.len(), 64, "{secret}");
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()), "{secret}");
        assert_ne!(mint_auth_secret(), secret);
    }

    /// The merge's golden shape: identity vars, the tenant's own services
    /// kept in order, and the `ISR_CACHE` namespace beside the tenant's.
    #[test]
    fn runner_owned_merge_injects_beside_the_tenants_config() {
        let mut config = json!({
            "name": "blog",
            "main": "index.js",
            "services": [{"binding": "API", "service": "api"}],
            "kv_namespaces": [{"binding": "KV", "id": "local"}],
            "vars": {"MODE": "prod"},
        });
        let stats = merge_runner_owned(&mut config, &[], &owned(), "Settings").unwrap();
        assert_eq!(
            stats,
            RunnerOwnedStats {
                vars_injected: 3,
                services_added: 0,
                isr_cache_added: true,
                token_minted: false,
            }
        );
        assert_eq!(config["vars"]["__PROJECT_ID"], "app-1");
        assert_eq!(config["vars"]["__VOID_PROJECT_SLUG"], "blog");
        assert_eq!(config["vars"]["__VOID_PROXY_TOKEN"], "tok");
        assert_eq!(config["vars"]["MODE"], "prod");
        assert_eq!(
            config["services"],
            json!([{"binding": "API", "service": "api"}])
        );
        assert_eq!(
            config["kv_namespaces"],
            json!([
                {"binding": "KV", "id": "local"},
                {"binding": "ISR_CACHE", "id": "noite-isr-cache"},
            ])
        );
    }

    /// The proxy slice adds its service in [`runner_services`]: the merge
    /// appends runner entries after the tenant's, whatever they are.
    #[test]
    fn runner_services_append_after_the_tenants() {
        assert!(runner_services().is_empty());
        let mut config = json!({
            "name": "blog",
            "services": [{"binding": "API", "service": "api"}],
        });
        let mut next = owned();
        next.services = vec![RunnerService {
            binding: "__VOID_PROXY",
            service: "noite-void-proxy",
        }];
        let stats = merge_runner_owned(&mut config, &[], &next, "Settings").unwrap();
        assert_eq!(stats.services_added, 1);
        assert_eq!(
            config["services"],
            json!([
                {"binding": "API", "service": "api"},
                {"binding": "__VOID_PROXY", "service": "noite-void-proxy"},
            ])
        );
    }

    #[test]
    fn every_runner_owned_name_fails_naming_it() {
        // A setting or config var the runner owns.
        let err = merge_runner_owned(
            &mut json!({"name": "a"}),
            &settings(&[("ISR_CACHE", "x")]),
            &owned(),
            "Settings",
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("`ISR_CACHE`"), "{err:#}");
        let err = merge_runner_owned(
            &mut json!({"name": "a", "vars": {"ISR_CACHE": "x"}}),
            &[],
            &owned(),
            "Settings",
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("vars.ISR_CACHE"), "{err:#}");
        // The proxy script's name as the Worker's own.
        let err = merge_runner_owned(
            &mut json!({"name": "noite-void-proxy"}),
            &[],
            &owned(),
            "Settings",
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("noite-void-proxy"), "{err:#}");
        // A tenant service, KV binding or KV id the runner owns.
        for (config, name) in [
            (
                json!({"name": "a", "services": [{"binding": "__VOID_PROXY", "service": "x"}]}),
                "__VOID_PROXY",
            ),
            (
                json!({"name": "a", "kv_namespaces": [{"binding": "ISR_CACHE", "id": "other"}]}),
                "ISR_CACHE",
            ),
            (
                json!({"name": "a", "kv_namespaces": [{"binding": "OTHER", "id": "noite-isr-cache"}]}),
                "noite-isr-cache",
            ),
        ] {
            let err =
                merge_runner_owned(&mut config.clone(), &[], &owned(), "Settings").unwrap_err();
            assert!(format!("{err:#}").contains(name), "{name}: {err:#}");
        }
    }

    #[test]
    fn malformed_sections_fail_clearly() {
        for (config, what) in [
            (json!({"name": "a", "services": {}}), "services"),
            (json!({"name": "a", "kv_namespaces": {}}), "kv_namespaces"),
            (json!({"name": "a", "vars": []}), "vars"),
        ] {
            let err =
                merge_runner_owned(&mut config.clone(), &[], &owned(), "Settings").unwrap_err();
            assert!(format!("{err:#}").contains(what), "{what}: {err:#}");
        }
        assert!(merge_runner_owned(&mut json!([1]), &[], &owned(), "Settings").is_err());
    }

    async fn seed(pool: &SqlitePool) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "void-app",
                slug: "void-app",
                user_id: "local",
                subdomain: "void-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    async fn seed_env(pool: &SqlitePool, app_id: &str) -> crate::models::Environment {
        let cfg = crate::config::config_for_tests();
        crate::db::create_environment(
            pool,
            &cfg,
            crate::db::NewEnvironment {
                app_id,
                slug: "void-app",
                label: "staging",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/staging",
                created_by: "user_1",
                listen: 30010,
                internal: 30011,
            },
        )
        .await
        .expect("seed env")
    }

    /// One token per fleet: production's lives on the app row, a preview's
    /// on its own override; each is minted once and reused, and the two
    /// differ.
    #[tokio::test]
    async fn proxy_tokens_are_per_fleet_minted_once() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let env = seed_env(&pool, &app.id).await;

        let (prod, minted) = ensure_proxy_token(&pool, &app.id, None).await.unwrap();
        assert!(minted);
        let (again, minted) = ensure_proxy_token(&pool, &app.id, None).await.unwrap();
        assert!(!minted);
        assert_eq!(again, prod);

        let (preview, minted) = ensure_proxy_token(&pool, &app.id, Some(&env.id))
            .await
            .unwrap();
        assert!(minted);
        assert_ne!(preview, prod);
        let (again, minted) = ensure_proxy_token(&pool, &app.id, Some(&env.id))
            .await
            .unwrap();
        assert!(!minted);
        assert_eq!(again, preview);

        // The rows carry the marker, so the settings merges skip them.
        assert_eq!(
            db::get_env(&pool, &app.id, PROXY_TOKEN_VAR)
                .await
                .unwrap()
                .unwrap()
                .source,
            db::SOURCE_VOID_PROXY_TOKEN
        );
        assert_eq!(
            db::get_env_override(&pool, &env.id, PROXY_TOKEN_VAR)
                .await
                .unwrap()
                .unwrap()
                .source,
            db::SOURCE_VOID_PROXY_TOKEN
        );
    }

    /// A user row under the token's name is refused, never read: the value
    /// the fleet would get must always be the runner's.
    #[tokio::test]
    async fn a_user_row_under_the_token_name_is_refused() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        db::set_env(&pool, &app.id, PROXY_TOKEN_VAR, "spoof")
            .await
            .unwrap();
        let err = ensure_proxy_token(&pool, &app.id, None).await.unwrap_err();
        assert!(format!("{err:#}").contains(PROXY_TOKEN_VAR), "{err:#}");
        assert_eq!(
            db::get_env(&pool, &app.id, PROXY_TOKEN_VAR)
                .await
                .unwrap()
                .unwrap()
                .value,
            "spoof"
        );
    }

    /// Rotation replaces the fleet's token (whosever row it was) and the
    /// next ensure reuses the rotated value.
    #[tokio::test]
    async fn rotation_replaces_and_reuse_follows() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (before, _) = ensure_proxy_token(&pool, &app.id, None).await.unwrap();
        let rotated = rotate_proxy_token(&pool, &app.id, None).await.unwrap();
        assert_ne!(rotated, before);
        let (again, minted) = ensure_proxy_token(&pool, &app.id, None).await.unwrap();
        assert!(!minted);
        assert_eq!(again, rotated);
    }

    /// The auth secret provisions once at the app level; any existing value
    /// — an app row or an environment override — wins untouched.
    #[tokio::test]
    async fn auth_secret_provisions_once_and_never_overwrites() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let env = seed_env(&pool, &app.id).await;

        assert!(ensure_auth_secret(&pool, &app.id, None).await.unwrap());
        let minted = db::get_env(&pool, &app.id, AUTH_SECRET_NAME)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(minted.source, db::SOURCE_AUTH_DEFAULT);
        // Reused, not reminted — for production and for previews alike.
        assert!(!ensure_auth_secret(&pool, &app.id, None).await.unwrap());
        assert!(!ensure_auth_secret(&pool, &app.id, Some(&env.id))
            .await
            .unwrap());
        assert_eq!(
            db::get_env(&pool, &app.id, AUTH_SECRET_NAME)
                .await
                .unwrap()
                .unwrap()
                .value,
            minted.value
        );

        // An override skips the mint: the app gains no row at all.
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let env = seed_env(&pool, &app.id).await;
        db::set_env_override(&pool, &env.id, AUTH_SECRET_NAME, "mine")
            .await
            .unwrap();
        assert!(!ensure_auth_secret(&pool, &app.id, Some(&env.id))
            .await
            .unwrap());
        assert!(db::get_env(&pool, &app.id, AUTH_SECRET_NAME)
            .await
            .unwrap()
            .is_none());

        // A user app row wins untouched.
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        db::set_env(&pool, &app.id, AUTH_SECRET_NAME, "mine")
            .await
            .unwrap();
        assert!(!ensure_auth_secret(&pool, &app.id, None).await.unwrap());
        let row = db::get_env(&pool, &app.id, AUTH_SECRET_NAME)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.value, "mine");
        assert_eq!(row.source, "");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-void-deploy-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The file wrapper parses, injects and rewrites through the same path
    /// as the settings merge — and `jsonc` wins over `json`, as celld
    /// reads them.
    #[tokio::test]
    async fn void_root_rewrites_and_records_the_mint() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let dir = scratch("root").canonicalize().unwrap();
        std::fs::write(
            dir.join("wrangler.jsonc"),
            r#"{"name": "blog", /* c */ "vars": {"MODE": "prod"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("wrangler.json"), r#"{"name": "stale"}"#).unwrap();

        let stats = merge_void_root(&pool, &app, None, &dir, &[], "Settings")
            .await
            .unwrap()
            .expect("jsonc found");
        assert!(stats.token_minted);
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.jsonc")).unwrap())
                .unwrap();
        assert_eq!(value["vars"]["__PROJECT_ID"], app.id);
        assert_eq!(value["vars"]["__VOID_PROJECT_SLUG"], "void-app");
        assert_eq!(value["kv_namespaces"][0]["binding"], "ISR_CACHE");
        assert_eq!(value["vars"]["MODE"], "prod");
        // The untouched sibling still stands.
        assert_eq!(
            std::fs::read_to_string(dir.join("wrangler.json")).unwrap(),
            r#"{"name": "stale"}"#
        );
        // Second deploy reuses the token: same value, no mint recorded
        // (a deploy always starts from fresh build output).
        let before = value["vars"]["__VOID_PROXY_TOKEN"].clone();
        std::fs::write(
            dir.join("wrangler.jsonc"),
            r#"{"name": "blog", /* c */ "vars": {"MODE": "prod"}}"#,
        )
        .unwrap();
        let stats = merge_void_root(&pool, &app, None, &dir, &[], "Settings")
            .await
            .unwrap()
            .expect("jsonc found");
        assert!(!stats.token_minted);
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.jsonc")).unwrap())
                .unwrap();
        assert_eq!(value["vars"]["__VOID_PROXY_TOKEN"], before);
    }

    #[tokio::test]
    async fn void_root_without_a_json_config_is_none() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let dir = scratch("toml").canonicalize().unwrap();
        std::fs::write(dir.join("wrangler.toml"), "name = \"a\"\n").unwrap();
        assert!(merge_void_root(&pool, &app, None, &dir, &[], "Settings")
            .await
            .unwrap()
            .is_none());
    }
}
