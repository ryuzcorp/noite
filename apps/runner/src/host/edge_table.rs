//! The edge route table: Caddy's config is static after boot, so app
//! lifecycle events push this table through Caddy's admin API instead of
//! rewriting the Caddyfile and POSTing /load (every reload drops in-flight
//! requests). The Go module in edge/ (`http.handlers.edge_routes`) holds
//! the table and publishes `{http.vars.edge_route}` /
//! `{http.vars.edge_upstream}`; the static Caddyfile (also written here,
//! once at boot) branches on them with stock directives.
//!
//! This module mirrors edge/table.go field for field; a test pins the wire
//! shape on both sides.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::db::{self, EnvironmentRoute};
use crate::host::edge::{self, PREVIEW_LABEL};
use crate::models::{App, AppDomain, AppLimit};

fn is_zero(v: &u32) -> bool {
    *v == 0
}

/// One host's edge behavior (mirrors `edge.Route` in edge/table.go).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EdgeKind {
    Control,
    Api,
    Git,
    Tenant,
    Custom,
    Env,
    EnvParked,
    Preview,
    Fallback,
    Deny,
}

/// One host's edge behavior (mirrors `edge.Route`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeRoute {
    pub kind: EdgeKind,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub upstream: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewrite: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub client_rpm: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_zone: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub app_rpm: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub app_zone: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub asleep: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub gated: bool,
}

/// A suffix rule (mirrors `edge.Wildcard`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeWildcard {
    pub suffix: String,
    /// Nested (not flattened): the Go module decodes `{"suffix", "route"}`.
    pub route: EdgeRoute,
}

/// The whole pushed route table (mirrors `edge.Table`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeTable {
    pub generation: u64,
    pub exact: HashMap<String, EdgeRoute>,
    pub wildcards: Vec<EdgeWildcard>,
}

/// Per-client zone rate, collapsed when the edge cannot tell clients apart
/// (mirrors the old `Zone::per_client`: behind a terminating proxy with no
/// trusted proxies every request arrives from the proxy).
fn per_client_rpm(cfg: &Config, rpm: u32) -> u32 {
    if cfg.edge_sees_clients() {
        rpm
    } else {
        0
    }
}

/// An app's effective limits: its own setting when it has one, else the
/// platform default (mirrors the old `app_zones`).
fn app_zones(cfg: &Config, app: &App, limits: &[AppLimit]) -> (u32, u32) {
    let own = limits.iter().find(|l| l.app_id == app.id);
    let pick = |own: Option<i64>, default: u32| {
        own.map_or(default, |v| u32::try_from(v.max(0)).unwrap_or(u32::MAX))
    };
    (
        per_client_rpm(
            cfg,
            pick(own.and_then(|l| l.client_rpm), cfg.edge.client_rpm),
        ),
        pick(own.and_then(|l| l.app_rpm), cfg.edge.app_rpm),
    )
}

/// Resolved inputs shared by every route of one app.
struct AppRoutes<'a> {
    cfg: &'a Config,
    app: &'a App,
    limits: &'a [AppLimit],
}

fn fleet_route(
    ctx: &AppRoutes,
    kind: EdgeKind,
    upstream: String,
    rewrite: Option<String>,
    asleep: bool,
    gated: bool,
) -> EdgeRoute {
    let (client_rpm, app_rpm) = app_zones(ctx.cfg, ctx.app, ctx.limits);
    EdgeRoute {
        kind,
        upstream,
        rewrite,
        client_rpm,
        client_zone: if client_rpm > 0 {
            format!("client_{}", ctx.app.slug)
        } else {
            String::new()
        },
        app_rpm,
        app_zone: if app_rpm > 0 {
            format!("app_{}", ctx.app.slug)
        } else {
            String::new()
        },
        asleep,
        gated,
    }
}

fn unzoned(kind: EdgeKind, upstream: String) -> EdgeRoute {
    EdgeRoute {
        kind,
        upstream,
        rewrite: None,
        client_rpm: 0,
        client_zone: String::new(),
        app_rpm: 0,
        app_zone: String::new(),
        asleep: false,
        gated: false,
    }
}

fn client_zoned(cfg: &Config, kind: EdgeKind, upstream: String, zone: &str, rpm: u32) -> EdgeRoute {
    let rpm = per_client_rpm(cfg, rpm);
    EdgeRoute {
        kind,
        upstream,
        rewrite: None,
        client_rpm: rpm,
        client_zone: if rpm > 0 { zone.into() } else { String::new() },
        app_rpm: 0,
        app_zone: String::new(),
        asleep: false,
        gated: false,
    }
}

fn fallback_route(cfg: &Config) -> EdgeRoute {
    EdgeRoute {
        rewrite: Some("/v1/edge/fallback".into()),
        ..client_zoned(
            cfg,
            EdgeKind::Fallback,
            cfg.caddy_api_upstream.clone(),
            "client_fallback",
            cfg.edge.client_rpm,
        )
    }
}

/// Whether an app serves traffic on its own hosts (mirrors the old
/// tenant-site gate: stopped or never-deployed apps fall through to the
/// wildcard fallback page instead of a dead upstream).
fn serves(app: &App) -> bool {
    app.listen_port.is_some() && !app.is_stopped() && app.is_deployed()
}

fn upstream(cfg: &Config, port: i64) -> String {
    format!("{}:{port}", cfg.caddy_upstream_host)
}

/// Build the route table from the same DB rows `rewrite_caddy` rendered.
pub fn build_table(
    cfg: &Config,
    apps: &[App],
    domains: &[AppDomain],
    limits: &[AppLimit],
    envs: &[EnvironmentRoute],
) -> EdgeTable {
    let mut exact = HashMap::new();
    let mut wildcards = Vec::new();
    // Control plane: every control hostname plus the loopback healthcheck.
    // The loopback carries no zones (it never had a guard).
    for host in cfg.control_hosts() {
        exact.insert(
            host.to_lowercase(),
            client_zoned(
                cfg,
                EdgeKind::Control,
                cfg.caddy_control_upstream.clone(),
                "client_control",
                cfg.edge.client_rpm,
            ),
        );
    }
    exact.insert(
        "127.0.0.1".into(),
        unzoned(EdgeKind::Control, cfg.caddy_control_upstream.clone()),
    );
    // API → runner (Bearer-protected REST).
    exact.insert(
        format!("api.{}", cfg.base_domain).to_lowercase(),
        client_zoned(
            cfg,
            EdgeKind::Api,
            cfg.caddy_api_upstream.clone(),
            "client_api",
            cfg.edge.client_rpm,
        ),
    );
    // Git smart-HTTP → runner `/v1/git/{slug}/…` (Basic auth inside runner).
    exact.insert(
        format!("git.{}", cfg.base_domain).to_lowercase(),
        EdgeRoute {
            rewrite: Some("/v1/git{uri}".into()),
            ..client_zoned(
                cfg,
                EdgeKind::Git,
                cfg.caddy_api_upstream.clone(),
                "client_git",
                cfg.edge.git_rpm,
            )
        },
    );
    // Tenants serve under every DNS base; custom domains when verified.
    for base in cfg.tenant_bases() {
        for app in apps {
            let Some(port) = app.listen_port else {
                continue;
            };
            if !serves(app) {
                continue;
            }
            let ctx = AppRoutes { cfg, app, limits };
            exact.insert(
                format!("{}.{}", app.slug, base).to_lowercase(),
                fleet_route(
                    &ctx,
                    EdgeKind::Tenant,
                    upstream(cfg, port),
                    None,
                    app.is_asleep(),
                    false,
                ),
            );
        }
    }
    for domain in domains {
        if !domain.is_verified() {
            continue;
        }
        let Some(app) = apps.iter().find(|a| a.id == domain.app_id) else {
            continue;
        };
        let Some(port) = app.listen_port else {
            continue;
        };
        if !serves(app) {
            continue;
        }
        let ctx = AppRoutes { cfg, app, limits };
        exact.insert(
            domain.hostname.to_lowercase(),
            fleet_route(
                &ctx,
                EdgeKind::Custom,
                upstream(cfg, port),
                None,
                app.is_asleep(),
                false,
            ),
        );
    }
    // Preview + environment hosts, under every tenant base.
    for base in cfg.tenant_bases() {
        for app in apps {
            exact.insert(
                format!("{PREVIEW_LABEL}.preview.{}.{base}", app.slug).to_lowercase(),
                client_zoned(
                    cfg,
                    EdgeKind::Preview,
                    cfg.caddy_control_upstream.clone(),
                    "client_preview",
                    cfg.edge.client_rpm,
                ),
            );
            // Any other label under the app's preview suffix 404s.
            wildcards.push(EdgeWildcard {
                suffix: format!(".preview.{}.{base}", app.slug).to_lowercase(),
                route: unzoned(EdgeKind::Deny, String::new()),
            });
        }
        for env in envs {
            let Some(app) = apps.iter().find(|a| a.id == env.app_id) else {
                continue;
            };
            let host = format!("{}.{}.{base}", env.label, app.slug).to_lowercase();
            if edge::env_live(env) {
                // A gate that admits an asleep environment wakes it, so a
                // gated site needs no separate wake hop (and an
                // unauthenticated visitor never spawns a fleet).
                let gated = !env.public;
                let asleep = !gated && env.asleep_since.is_some();
                // A live environment with no fleet port yet keeps its host
                // but answers the runner's page (matches the old parked
                // branch, which proxied the api upstream).
                let (kind, up, rewrite) = match env.listen_port {
                    Some(port) => (EdgeKind::Env, upstream(cfg, port), None),
                    None => (
                        EdgeKind::EnvParked,
                        cfg.caddy_api_upstream.clone(),
                        Some("/v1/edge/fallback".into()),
                    ),
                };
                let ctx = AppRoutes { cfg, app, limits };
                exact.insert(host, fleet_route(&ctx, kind, up, rewrite, asleep, gated));
            } else {
                let ctx = AppRoutes { cfg, app, limits };
                exact.insert(
                    host,
                    fleet_route(
                        &ctx,
                        EdgeKind::EnvParked,
                        cfg.caddy_api_upstream.clone(),
                        Some("/v1/edge/fallback".into()),
                        false,
                        false,
                    ),
                );
            }
        }
        // Every label under an app that owns an environment answers the
        // runner's page (a deleted environment, a typo), like the tenant
        // wildcard. Unknown hosts land on the fallback page.
        for app in apps {
            if envs.iter().any(|env| env.app_id == app.id) {
                wildcards.push(EdgeWildcard {
                    suffix: format!(".{}.{base}", app.slug).to_lowercase(),
                    route: fallback_route(cfg),
                });
            }
        }
        wildcards.push(EdgeWildcard {
            suffix: format!(".{base}").to_lowercase(),
            route: fallback_route(cfg),
        });
    }
    EdgeTable {
        generation: 0,
        exact,
        wildcards,
    }
}

fn push_note(ok: bool, detail: String) {
    crate::host::caddy::admin_note(ok, detail);
}

/// Push the table to Caddy's admin API (loopback-only). A failure only
/// warns: Caddy boots from the file, and the next tick re-pushes.
async fn push_live(cfg: &Config, table: &EdgeTable) {
    let url = format!("{}/edge/routes", cfg.caddy_admin_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    match client
        .post(&url)
        .json(table)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            push_note(true, String::new());
        }
        Ok(resp) => {
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let tail = body.chars().take(300).collect::<String>();
            push_note(false, format!("caddy /edge/routes {code}: {tail}"));
            tracing::warn!(%code, body = %tail, "edge table push rejected");
        }
        Err(e) => {
            tracing::debug!(error = %e, "edge admin not reachable yet");
        }
    }
}

/// Build the table from the DB, write the file atomically when it changed,
/// and push it live. Every app lifecycle event calls this immediately; the
/// reconcile tick calls it too as the self-healing backstop.
/// Serializes concurrent pushes: two lifecycle events at once must not
/// interleave build → write → push, or an older table lands last until the
/// next tick (the module also rejects older generations with a 409, and the
/// generation counter is monotonic across restarts because it is persisted
/// in the table file).
static PUSH_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Fold a fresh build onto the previous file state: keep the old generation
/// when nothing changed (and skip the write), else bump it.
fn apply_table(prev: Option<&EdgeTable>, mut fresh: EdgeTable) -> (EdgeTable, bool) {
    match prev {
        Some(prev) if prev.exact == fresh.exact && prev.wildcards == fresh.wildcards => {
            fresh.generation = prev.generation;
            (fresh, false)
        }
        Some(prev) => {
            fresh.generation = prev.generation + 1;
            (fresh, true)
        }
        None => {
            fresh.generation = 1;
            (fresh, true)
        }
    }
}

pub async fn push_routes(pool: &sqlx::SqlitePool, cfg: &Config) -> anyhow::Result<()> {
    let _held = PUSH_LOCK.lock().await;
    // Every read propagates: a transient DB error (SQLITE_BUSY) must keep
    // the previous table serving, never push a table with silently
    // dropped domains, limits or environments.
    let apps = db::list_apps(pool).await?;
    let domains = db::list_app_domains(pool).await?;
    let limits = db::list_app_limits(pool).await?;
    let envs = db::list_environment_routes(pool).await?;
    warn_if_blind(cfg, &limits);
    let fresh = build_table(cfg, &apps, &domains, &limits, &envs);
    let prev_table = std::fs::read_to_string(&cfg.routes_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<EdgeTable>(&raw).ok());
    // The file carries the generation, so compare content without it.
    let (table, changed) = apply_table(prev_table.as_ref(), fresh);
    if changed {
        let path = Path::new(&cfg.routes_path);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let next = serde_json::to_string_pretty(&table)?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &next).await?;
        tokio::fs::rename(&tmp, path).await?;
        tracing::info!(path = %cfg.routes_path, n = table.exact.len(), "edge routes updated");
    }
    push_live(cfg, &table).await;
    Ok(())
}

/// Warns once when per-client zones collapse (mirrors the old boot warning
/// in `rewrite_caddy`).
pub fn warn_if_blind(cfg: &Config, limits: &[AppLimit]) {
    use std::sync::atomic::AtomicBool;
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !cfg.edge_sees_clients()
        && (cfg.edge.client_rpm > 0 || limits.iter().any(|l| l.client_rpm.is_some_and(|v| v > 0)))
        && !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed)
    {
        tracing::warn!(
            "per-client rate limits disabled: the edge sees one client IP (no trusted_proxies); \
              set trusted_proxies or rely on the per-app shared limits"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_for_tests;
    use crate::models::{AppStatus, DesiredState, DOMAIN_STATUS_VERIFIED};

    fn test_app(slug: &str) -> App {
        App {
            id: format!("app-{slug}"),
            slug: slug.into(),
            name: slug.into(),
            user_id: "u".into(),
            status: AppStatus::Running.as_str().into(),
            subdomain: format!("{slug}.localhost"),
            git_prefix: format!("git/{slug}"),
            fleet_bucket: format!("s3://noite/fleets/{slug}"),
            listen_port: Some(20011),
            internal_port: None,
            last_deploy_sha: Some("abc".into()),
            last_error: None,
            desired_state: DesiredState::Running.as_str().into(),
            created_at: "t".into(),
            updated_at: "t".into(),
            asleep_since: None,
            woke_at: None,
            deployed_config: None,
            import_source: None,
            imported: false,
        }
    }

    fn test_env(app: &App, label: &str) -> EnvironmentRoute {
        EnvironmentRoute {
            id: format!("env-{}-{label}", app.id),
            app_id: app.id.clone(),
            app_slug: app.slug.clone(),
            label: label.into(),
            listen_port: Some(20021),
            public: false,
            desired_state: DesiredState::Running.as_str().into(),
            asleep_since: None,
            last_deployed_at: Some("t".into()),
        }
    }

    fn table(cfg: &Config) -> EdgeTable {
        let app = test_app("myapp");
        build_table(cfg, &[app], &[], &[], &[])
    }

    #[test]
    fn tenant_and_platform_hosts_resolve() {
        let cfg = config_for_tests();
        let app = test_app("myapp");
        let t = build_table(&cfg, std::slice::from_ref(&app), &[], &[], &[]);
        let tenant = t.exact.get("myapp.localhost").expect("tenant route");
        assert_eq!(tenant.kind, EdgeKind::Tenant);
        assert_eq!(tenant.upstream, "127.0.0.1:20011");
        assert_eq!(tenant.client_zone, "client_myapp");
        assert_eq!(tenant.client_rpm, cfg.edge.client_rpm);
        assert!(!tenant.asleep && !tenant.gated);

        let control = t.exact.get("localhost").expect("control route");
        assert_eq!(control.kind, EdgeKind::Control);
        assert_eq!(control.upstream, cfg.caddy_control_upstream);

        let api = t.exact.get("api.localhost").expect("api route");
        assert_eq!(api.kind, EdgeKind::Api);

        let git = t.exact.get("git.localhost").expect("git route");
        assert_eq!(git.kind, EdgeKind::Git);
        assert_eq!(git.rewrite.as_deref(), Some("/v1/git{uri}"));

        let fallback = t
            .wildcards
            .iter()
            .find(|w| w.suffix == ".localhost")
            .expect("base fallback");
        assert_eq!(fallback.route.kind, EdgeKind::Fallback);
        assert_eq!(fallback.route.rewrite.as_deref(), Some("/v1/edge/fallback"));

        let unknown = t
            .wildcards
            .iter()
            .filter(|w| "zzz.localhost".ends_with(w.suffix.as_str()))
            .max_by_key(|w| w.suffix.len())
            .expect("unknown host matches");
        assert_eq!(unknown.route.kind, EdgeKind::Fallback);
    }

    #[test]
    fn stopped_and_never_deployed_apps_get_no_route() {
        let cfg = config_for_tests();
        let mut stopped = test_app("parked");
        stopped.desired_state = DesiredState::Stopped.as_str().into();
        let mut fresh = test_app("fresh");
        fresh.status = "created".into();
        fresh.last_deploy_sha = None;
        let t = build_table(&cfg, &[stopped, fresh], &[], &[], &[]);
        assert!(!t.exact.contains_key("parked.localhost"));
        assert!(!t.exact.contains_key("fresh.localhost"));
    }

    #[test]
    fn custom_domains_need_verification_and_a_live_app() {
        let cfg = config_for_tests();
        let app = test_app("myapp");
        let verified = AppDomain {
            app_id: app.id.clone(),
            hostname: "Example.COM".into(),
            status: DOMAIN_STATUS_VERIFIED.into(),
            token: "t".into(),
            verified_at: Some("t".into()),
            created_at: "t".into(),
        };
        let pending = AppDomain {
            hostname: "pending.example.com".into(),
            status: "pending".into(),
            ..verified.clone()
        };
        let t = build_table(&cfg, &[app], &[verified, pending], &[], &[]);
        // Hostnames normalize to lowercase without a trailing dot.
        let custom = t.exact.get("example.com").expect("verified custom route");
        assert_eq!(custom.kind, EdgeKind::Custom);
        assert!(!t.exact.contains_key("pending.example.com"));
    }

    #[test]
    fn environments_map_flags_and_ports() {
        let cfg = config_for_tests();
        let app = test_app("myapp");
        let mut live = test_env(&app, "main");
        live.public = true;
        let mut gated = test_env(&app, "auth");
        gated.public = false;
        let mut asleep = test_env(&app, "night");
        asleep.public = true;
        asleep.asleep_since = Some("t".into());
        let mut parked = test_env(&app, "old");
        parked.listen_port = None;
        let t = build_table(&cfg, &[app], &[], &[], &[live, gated, asleep, parked]);
        let open = t.exact.get("main.myapp.localhost").expect("live env");
        assert_eq!(open.kind, EdgeKind::Env);
        assert!(!open.gated && !open.asleep);
        assert_eq!(open.upstream, "127.0.0.1:20021");

        let members = t.exact.get("auth.myapp.localhost").expect("gated env");
        assert_eq!(members.kind, EdgeKind::Env);
        assert!(members.gated && !members.asleep);

        let sleepy = t.exact.get("night.myapp.localhost").expect("asleep env");
        assert!(sleepy.asleep && !sleepy.gated);

        let gone = t.exact.get("old.myapp.localhost").expect("parked env");
        assert_eq!(gone.kind, EdgeKind::EnvParked);
        assert_eq!(gone.upstream, cfg.caddy_api_upstream);
        assert_eq!(gone.rewrite.as_deref(), Some("/v1/edge/fallback"));

        // Every label under an app that owns an environment answers the page.
        let wild = t
            .wildcards
            .iter()
            .find(|w| w.suffix == ".myapp.localhost")
            .expect("env wildcard");
        assert_eq!(wild.route.kind, EdgeKind::Fallback);
    }

    #[test]
    fn preview_hosts_allowlist_and_deny_wildcards() {
        let cfg = config_for_tests();
        let app = test_app("myapp");
        let t = build_table(&cfg, &[app], &[], &[], &[]);
        let pod = t
            .exact
            .get("app-0.preview.myapp.localhost")
            .expect("pod host");
        assert_eq!(pod.kind, EdgeKind::Preview);
        assert_eq!(pod.upstream, cfg.caddy_control_upstream);
        let deny = t
            .wildcards
            .iter()
            .find(|w| w.suffix == ".preview.myapp.localhost")
            .expect("preview deny");
        assert_eq!(deny.route.kind, EdgeKind::Deny);
    }

    #[test]
    fn app_limits_override_and_blind_proxies_collapse() {
        let mut cfg = config_for_tests();
        let app = test_app("myapp");
        let limits = vec![AppLimit {
            app_id: app.id.clone(),
            client_rpm: Some(60),
            app_rpm: Some(6),
            memory_mb: None,
        }];
        let t = build_table(&cfg, std::slice::from_ref(&app), &[], &limits, &[]);
        let tenant = &t.exact["myapp.localhost"];
        // 60/min stays 60/min on the table; the window math lives in the module.
        assert_eq!(tenant.client_rpm, 60);
        assert_eq!(tenant.app_rpm, 6);

        cfg.auto_https = false;
        cfg.base_domain = "example.com".into();
        let t = build_table(&cfg, &[app], &[], &limits, &[]);
        let tenant = &t.exact["myapp.example.com"];
        assert_eq!(tenant.client_rpm, 0);
        assert_eq!(tenant.client_zone, "");
        assert_eq!(tenant.app_rpm, 6);
        assert_eq!(tenant.app_zone, "app_myapp");
    }

    #[test]
    fn wire_shape_matches_the_go_module() {
        // Kinds serialize exactly as edge/table.go expects (kebab-case).
        let cfg = config_for_tests();
        let t = table(&cfg);
        let raw = serde_json::to_value(&t).expect("table serializes");
        assert_eq!(raw["exact"]["myapp.localhost"]["kind"], "tenant");
        assert_eq!(raw["generation"], 0);
        // Wildcards serialize nested ({suffix, route}), never flattened:
        // the Go module decodes that exact shape (a flat route would fail
        // validation with an empty kind).
        let wild = &raw["wildcards"][0];
        assert!(wild.get("route").is_some(), "{raw}");
        assert!(wild.get("kind").is_none(), "{raw}");
        // Longest-suffix wins on the Go side too; order here is stable.
        let suffixes: Vec<&str> = t.wildcards.iter().map(|w| w.suffix.as_str()).collect();
        assert!(suffixes.contains(&".localhost"));
    }

    #[test]
    fn generation_is_monotonic_across_reloads() {
        // F6: the counter persists in the file, so a runner restart keeps
        // ordering pushes (and the module's 409 rejects anything older).
        let cfg = config_for_tests();
        let app = test_app("myapp");
        let dir = std::env::temp_dir().join(format!("noite-edge-gen-{}", app.id));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("routes.json");
        let write = |t: &EdgeTable| {
            std::fs::write(&path, serde_json::to_string_pretty(t).expect("json")).expect("write");
        };
        let load = || {
            serde_json::from_str::<EdgeTable>(&std::fs::read_to_string(&path).expect("read"))
                .expect("parse")
        };

        // Fresh file: generation starts at 1.
        let (t1, changed) = apply_table(
            None,
            build_table(&cfg, std::slice::from_ref(&app), &[], &[], &[]),
        );
        assert!(changed);
        write(&t1);
        assert_eq!(load().generation, 1);

        // Same content after a "restart" (reload from file): same generation.
        let (t2, changed) = apply_table(
            Some(&load()),
            build_table(&cfg, std::slice::from_ref(&app), &[], &[], &[]),
        );
        assert!(!changed);
        assert_eq!(t2.generation, 1);

        // Changed content: generation advances.
        let mut gone = app.clone();
        gone.listen_port = Some(20099);
        let (t3, changed) = apply_table(Some(&load()), build_table(&cfg, &[gone], &[], &[], &[]));
        assert!(changed);
        write(&t3);
        assert_eq!(load().generation, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn asleep_apps_set_the_wake_flag() {
        let cfg = config_for_tests();
        let mut app = test_app("myapp");
        app.asleep_since = Some("t".into());
        let t = build_table(&cfg, &[app], &[], &[], &[]);
        assert!(t.exact["myapp.localhost"].asleep);
    }
}
