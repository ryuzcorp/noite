//! Edge fallback page: Caddy's `*.{domain}` catch-all lands here for hosts
//! with no tenant route — unknown slugs, stopped apps, never-deployed apps.
//!
//! States by Host header: no app row → 404 Not found; app stopped → 503
//! Paused; app without a deploy → 404 Not deployed yet. Self-contained HTML
//! (no UI build involved), public route (own lookup, no bearer token).

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
};

use crate::config::is_localhost_domain;
use crate::AppState;

/// Tenant slug from a Host header, if it addresses `{slug}.{base}` under any
/// tenant base (configured domain plus LAN/extra DNS names) and is not one
/// of the platform hosts (bare bases, control, api, git).
pub fn parse_edge_slug(host: &str, bases: &[String], control_sub: &str) -> Option<String> {
    let bare = host.split_once(':').map(|(h, _)| h).unwrap_or(host);
    let bare = bare.trim().to_lowercase();
    if bare.is_empty() {
        return None;
    }
    if bases.contains(&bare) {
        return None;
    }
    // First suffix match wins; the configured domain stays primary.
    for base in bases {
        if base.trim().is_empty() {
            continue;
        }
        let Some(slug) = bare.strip_suffix(format!(".{base}").as_str()) else {
            continue;
        };
        if slug.is_empty() || slug.contains('.') {
            return None;
        }
        if slug == control_sub || slug == "api" || slug == "git" {
            return None;
        }
        return Some(slug.to_string());
    }
    None
}

/// The preview origin's pod label. One **stable** hostname per app, so
/// on-demand TLS issues a certificate once per app instead of one per preview
/// session — the pod's instance id is random per boot, and a wildcard label
/// would let anyone drain the CA's per-domain issuance limit. The pod host
/// document, its bundle, its process workers and its preview service worker all
/// live on this one origin, and the pod boots with path URLs there, so nothing
/// has to interpolate an instance id into a hostname.
pub const PREVIEW_LABEL: &str = "app-0";

/// Preview slug from a pod's preview host
/// (`{PREVIEW_LABEL}.preview.{slug}.{base}`): the app's own preview origin, one
/// label under the instance wildcard. `None` for anything else — a plain tenant
/// host, another base, a dotted slug, or any other pod label.
pub fn parse_preview_slug(host: &str, bases: &[String]) -> Option<String> {
    let bare = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .trim_end_matches('.')
        .to_lowercase();
    if bare.is_empty() {
        return None;
    }
    for base in bases {
        if base.trim().is_empty() {
            continue;
        }
        let Some(rest) = bare.strip_suffix(format!(".{base}").as_str()) else {
            continue;
        };
        let Some((pod, slug)) = rest.split_once(".preview.") else {
            continue;
        };
        if pod != PREVIEW_LABEL || slug.is_empty() || slug.contains('.') {
            continue;
        }
        return Some(slug.to_string());
    }
    None
}

/// Environment host `<label>.<slug>.<base>` — exactly one **stable** hostname
/// per environment (ROADMAP, Preview environments): a branch's data survives
/// its redeploys, so the address must not change per commit, and on-demand TLS
/// then issues one certificate per environment instead of one per push.
///
/// `None` for everything else. A tenant host has one label below the base; the
/// pod host has three (`{PREVIEW_LABEL}.preview.{slug}`), so it can never be
/// read as `<label>.<slug>`; and the two labels the preview hosts own are
/// refused here as well (`preview`, `{PREVIEW_LABEL}`) because the environment
/// labeler refuses to mint them ([`crate::host::env_label`]), so a
/// hand-written host must not become an environment either.
pub fn parse_env_host(host: &str, bases: &[String]) -> Option<(String, String)> {
    let bare = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .trim_end_matches('.')
        .to_lowercase();
    if bare.is_empty() {
        return None;
    }
    for base in bases {
        if base.trim().is_empty() {
            continue;
        }
        let Some(rest) = bare.strip_suffix(format!(".{base}").as_str()) else {
            continue;
        };
        let Some((label, slug)) = rest.split_once('.') else {
            continue;
        };
        if label.is_empty() || slug.is_empty() || slug.contains('.') {
            continue;
        }
        // The labels the preview hosts own are refused here exactly as the
        // labeler refuses to mint them, so a hand-written host can never
        // shadow `preview.{slug}` or the pod host's label.
        if crate::host::env_label::RESERVED_LABELS.contains(&label) {
            continue;
        }
        return Some((slug.to_string(), label.to_string()));
    }
    None
}

/// Whether an environment host is served by its own fleet. A stopped or
/// never-deployed environment keeps its host — and its certificate — but
/// answers the fallback page, exactly like a tenant site with no live fleet.
pub fn env_live(route: &crate::db::EnvironmentRoute) -> bool {
    route.listen_port.is_some()
        && route.last_deployed_at.is_some()
        && route.desired_state != crate::models::DesiredState::Stopped.as_str()
}

pub(crate) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}
/// Control-plane base URL for the "back to Noite" link, derived from the
/// incoming Host (keeps dev ports working without configuration). Visitors
/// on a LAN/extra host link back to that host, not localhost — which would
/// resolve to their own machine.
pub(crate) fn control_url(
    host: &str,
    base_domain: &str,
    control_sub: &str,
    tenant_bases: &[String],
) -> String {
    let port = host
        .split_once(':')
        .map(|(_, p)| p)
        .filter(|p| !p.is_empty())
        .map(|p| format!(":{p}"))
        .unwrap_or_default();
    let bare = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .to_lowercase();
    // Extra-host visitor (LAN name): same host serves control there.
    if let Some(extra) = tenant_bases
        .iter()
        .find(|b| *b != base_domain && (bare == **b || bare.ends_with(format!(".{b}").as_str())))
    {
        if is_localhost_domain(base_domain) {
            return format!("http://{extra}{port}");
        }
        return format!("https://{extra}");
    }
    let name = if control_sub.is_empty() {
        base_domain.to_string()
    } else {
        format!("{control_sub}.{base_domain}")
    };
    if is_localhost_domain(base_domain) {
        format!("http://{name}{port}")
    } else {
        format!("https://{name}")
    }
}

pub(crate) fn page(
    status: StatusCode,
    title: &str,
    body: &str,
    control: &str,
) -> impl IntoResponse {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
        <title>{title} · Noite</title>\
        <style>\
        :root {{ color-scheme: dark; }}\
        body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;\
          background: #0b0e14; color: #e6e9f0;\
          font-family: ui-sans-serif, system-ui, sans-serif; }}\
        .card {{ text-align: center; max-width: 26rem; padding: 2.5rem 2rem;\
          border: 1px solid #232838; border-radius: 1rem; background: #11151f; }}\
        .code {{ font-size: 3.5rem; font-weight: 800; margin: 0; color: #7c8aff; }}\
        h1 {{ margin: 0.5rem 0; font-size: 1.5rem; }}\
        p {{ margin: 0.5rem 0 1.5rem; color: #9aa3b2; }}\
        code {{ color: #e6e9f0; }}\
        a {{ color: #7c8aff; }}\
        </style></head><body><main class=\"card\">\
        <p class=\"code\">{code}</p><h1>{title}</h1><p>{body}</p>\
        <p><a href=\"{control}\">Back to Noite</a></p>\
        </main></body></html>",
        title = escape(title),
        code = status.as_u16(),
        body = body,
        control = escape(control),
    );
    (status, Html(html))
}

/// Resolve a request host to its app: a tenant hostname by slug, anything
/// else as a registered custom hostname (`app_domain`). Returns the parsed
/// slug too (None for custom hosts) for the not-found page.
async fn app_for_host(
    state: &AppState,
    host: &str,
) -> (Option<String>, Option<crate::models::App>) {
    let cfg = &state.config;
    let bare = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .trim_end_matches('.')
        .to_lowercase();
    match parse_edge_slug(host, &cfg.tenant_bases(), &cfg.control_subdomain) {
        Some(slug) => {
            let app = crate::db::get_app_by_slug(&state.pool, &slug)
                .await
                .ok()
                .flatten();
            (Some(slug), app)
        }
        None => (
            None,
            crate::db::get_app_by_domain(&state.pool, &bare)
                .await
                .ok()
                .flatten(),
        ),
    }
}

/// `forward_auth` target for an asleep site (SPEC, Scale to zero).
/// Caddy holds the visitor's request while this runs: wake the fleet, wait
/// for its health gate, answer 200 — Caddy then proxies the held request
/// unchanged, so the visitor never sees that the app was asleep. Public like
/// the other edge routes: waking an app is exactly what a request to its
/// hostname does anyway. Only a failed wake is visible (503 page).
///
/// One hostname family per fleet: a tenant/custom host wakes the app's fleet,
/// an environment host (`<label>.<slug>.<base>`) wakes that environment's.
pub async fn wake(State(state): State<AppState>, headers: HeaderMap) -> axum::response::Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let host = header("x-forwarded-host")
        .or_else(|| header("host"))
        .unwrap_or_default();
    let cfg = &state.config;
    let control = control_url(
        &host,
        &cfg.base_domain,
        &cfg.control_subdomain,
        &cfg.tenant_bases(),
    );
    // An environment host wakes *its* fleet (its own bucket, its own ports),
    // not the app's: the environment id, not the app id, keys the wake.
    if let Some((slug, label)) = parse_env_host(&host, &cfg.tenant_bases()) {
        let route = match crate::db::environment_route(&state.pool, &slug, &label).await {
            Ok(Some(route)) => route,
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        let woken = crate::host::sleep::wake_environment(
            &state.pool,
            cfg,
            &state.procs,
            &state.logs,
            &route.id,
        )
        .await;
        return match woken {
            Ok(()) => StatusCode::OK.into_response(),
            Err(e) => {
                tracing::warn!(slug = %route.app_slug, label = %route.label, error = %e, "env wake failed");
                page(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Unavailable",
                    &format!(
                        "The preview <code>{}</code> could not start. Try again in a moment.",
                        escape(&route.label)
                    ),
                    &control,
                )
                .into_response()
            }
        };
    }
    let (_, app) = app_for_host(&state, &host).await;
    let Some(app) = app else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let woken =
        crate::host::sleep::wake_app(&state.pool, cfg, &state.procs, &state.logs, &app.id).await;
    match woken {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => {
            tracing::warn!(slug = %app.slug, error = %e, "wake failed");
            page(
                StatusCode::SERVICE_UNAVAILABLE,
                "Unavailable",
                &format!(
                    "<code>{}</code> could not start. Try again in a moment.",
                    escape(&app.name)
                ),
                &control,
            )
            .into_response()
        }
    }
}

pub async fn edge_fallback(State(state): State<AppState>, headers: HeaderMap) -> impl IntoResponse {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let cfg = &state.config;
    let bases = cfg.tenant_bases();
    let control = control_url(host, &cfg.base_domain, &cfg.control_subdomain, &bases);
    // An environment host (`<label>.<slug>.<base>`) resolves by environment:
    // the exact site exists for a live one, so this page answers a parked
    // environment, a label no environment owns, and the moment between a
    // change and the next Caddyfile rewrite.
    if let Some((slug, label)) = parse_env_host(host, &bases) {
        let route = crate::db::environment_route(&state.pool, &slug, &label)
            .await
            .ok()
            .flatten();
        let Some(route) = route else {
            return page(
                StatusCode::NOT_FOUND,
                "Not found",
                &format!(
                    "<code>{}</code> has no environment called <code>{}</code>.",
                    escape(&slug),
                    escape(&label)
                ),
                &control,
            );
        };
        if route.desired_state == crate::models::DesiredState::Stopped.as_str() {
            return page(
                StatusCode::SERVICE_UNAVAILABLE,
                "Paused",
                &format!(
                    "Preview <code>{}</code> is paused. Start it from the control panel to bring it back.",
                    escape(&route.label)
                ),
                &control,
            );
        }
        if !env_live(&route) {
            return page(
                StatusCode::NOT_FOUND,
                "Not deployed yet",
                &format!(
                    "Preview <code>{}</code> exists but has no deploy yet — push to its branch to launch it.",
                    escape(&route.label)
                ),
                &control,
            );
        }
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            "Starting",
            &format!(
                "Preview <code>{}</code> is starting — retry in a few seconds.",
                escape(&route.label)
            ),
            &control,
        );
    }
    // A tenant hostname resolves by slug; anything else may be a custom
    // hostname registered for one app (`app_domain`).
    let (slug, app) = app_for_host(&state, host).await;
    let Some(app) = app else {
        return match slug {
            Some(slug) => page(
                StatusCode::NOT_FOUND,
                "Not found",
                &format!(
                    "There&rsquo;s no app for this slug (<code>{}</code>).",
                    escape(&slug)
                ),
                &control,
            ),
            None => page(
                StatusCode::NOT_FOUND,
                "Not found",
                &format!("There&rsquo;s nothing at <code>{}</code>.", escape(host)),
                &control,
            ),
        };
    };
    if app.is_stopped() {
        return page(
            StatusCode::SERVICE_UNAVAILABLE,
            "Paused",
            &format!(
                "<code>{}</code> is paused. Start it from the control panel to bring it back.",
                escape(&app.name)
            ),
            &control,
        );
    }
    if !app.is_deployed() {
        return page(
            StatusCode::NOT_FOUND,
            "Not deployed yet",
            &format!(
                "<code>{}</code> exists but has no deploy yet — push to <code>main</code> to launch it.",
                escape(&app.name)
            ),
            &control,
        );
    }
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "Starting",
        &format!(
            "<code>{}</code> is starting — retry in a few seconds.",
            escape(&app.name)
        ),
        &control,
    )
}

/// Structural allowlist for the Caddy `on_demand_tls` ask gate: platform
/// hosts (control/api/git + extra) are always ours; tenant slugs need a DB
/// liveness check (done by the caller). Never the `localhost` family — dev
/// has no public TLS and must not trigger issuance attempts.
pub fn tls_ask_static_ok(
    host: &str,
    base_domain: &str,
    control_sub: &str,
    extra_hosts: &[String],
) -> bool {
    if is_localhost_domain(base_domain) || base_domain.trim().is_empty() {
        return false;
    }
    let bare = host
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .to_lowercase();
    if bare.is_empty() {
        return false;
    }
    let control = if control_sub.is_empty() {
        base_domain.to_owned()
    } else {
        format!("{control_sub}.{base_domain}")
    };
    bare == control
        || bare == format!("api.{base_domain}")
        || bare == format!("git.{base_domain}")
        || extra_hosts.iter().any(|h| h.trim().to_lowercase() == bare)
}

/// Caddy `on_demand_tls` gate (`GET /v1/edge/tls-ask?domain=`): 200 only
/// for hostnames that are really ours — platform hosts statically, tenant
/// slugs when deployed and running. Public (Caddy calls without
/// credentials), read-only; unknown names get 404 so no cert is minted.
pub async fn tls_ask(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = &state.config;
    let domain = params.get("domain").map(String::as_str).unwrap_or("");
    if tls_ask_static_ok(
        domain,
        &cfg.base_domain,
        &cfg.control_subdomain,
        &cfg.control_extra_hosts,
    ) {
        return StatusCode::OK;
    }
    // A preview host (`{instanceId}-{port}.{slug}.preview.{base}`) is the app's
    // own origin for the in-browser pod, so an existing app is enough — its
    // fleet need not be up. Anything else falls through to the tenant/custom
    // checks, and an unknown preview host gets 404 (no cert minted).
    if let Some(slug) = parse_preview_slug(domain, &cfg.tenant_bases()) {
        return match crate::db::get_app_by_slug(&state.pool, &slug).await {
            Ok(Some(_)) => StatusCode::OK,
            _ => StatusCode::NOT_FOUND,
        };
    }
    // An environment host (`<label>.<slug>.<base>`) is ours when the
    // environment exists: its own stable host means one certificate per
    // environment, and the fleet need not be up (a newly created environment
    // still gets the host it will serve on). A label no environment owns is
    // refused, so a typo can never drain CA issuance.
    if let Some((slug, label)) = parse_env_host(domain, &cfg.tenant_bases()) {
        return match crate::db::environment_route(&state.pool, &slug, &label).await {
            Ok(Some(_)) => StatusCode::OK,
            _ => StatusCode::NOT_FOUND,
        };
    }
    // A tenant hostname or a registered custom hostname. Both must belong to
    // an app that is deployed and running, so a certificate is never minted for
    // a name this fleet does not serve.
    match parse_edge_slug(domain, &cfg.tenant_bases(), &cfg.control_subdomain) {
        Some(slug) => {
            if !crate::lifecycle::slug_ok(&slug) {
                return StatusCode::NOT_FOUND;
            }
            match crate::db::get_app_by_slug(&state.pool, &slug).await {
                Ok(Some(app)) if !app.is_stopped() && app.is_deployed() => StatusCode::OK,
                _ => StatusCode::NOT_FOUND,
            }
        }
        None => {
            let bare = domain
                .split_once(':')
                .map(|(h, _)| h)
                .unwrap_or(domain)
                .trim()
                .trim_end_matches('.')
                .to_lowercase();
            match crate::db::get_app_by_domain(&state.pool, &bare).await {
                Ok(Some(app)) if !app.is_stopped() && app.is_deployed() => StatusCode::OK,
                _ => StatusCode::NOT_FOUND,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bases(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_tenant_hosts() {
        assert_eq!(
            parse_edge_slug("asdf.localhost:9080", &bases(&["localhost"]), ""),
            Some("asdf".to_string())
        );
        assert_eq!(
            parse_edge_slug("my-app.noite.now", &bases(&["noite.now"]), "app"),
            Some("my-app".to_string())
        );
    }

    #[test]
    fn parses_lan_extra_bases() {
        let lan = bases(&["localhost", "noite.local"]);
        assert_eq!(
            parse_edge_slug("test.noite.local:9080", &lan, ""),
            Some("test".to_string())
        );
        assert_eq!(parse_edge_slug("noite.local:9080", &lan, ""), None);
        assert_eq!(parse_edge_slug("api.noite.local", &lan, ""), None);
        assert_eq!(parse_edge_slug("a.b.noite.local", &lan, ""), None);
        assert_eq!(
            parse_edge_slug("test.localhost:9080", &lan, ""),
            Some("test".to_string())
        );
        assert_eq!(parse_edge_slug("test.evil.local", &lan, ""), None);
    }

    #[test]
    fn parses_environment_hosts() {
        let bases = bases(&["noite.now", "noite.local"]);
        assert_eq!(
            parse_env_host("feat-x.test.noite.now", &bases),
            Some(("test".to_string(), "feat-x".to_string()))
        );
        assert_eq!(
            parse_env_host("feat-x.test.noite.local:9080", &bases),
            Some(("test".to_string(), "feat-x".to_string()))
        );
        assert_eq!(
            parse_env_host("FEAT-X.Test.Noite.Now.", &bases),
            Some(("test".to_string(), "feat-x".to_string()))
        );
        // A label with a dash suffix (`unique_label`) still parses.
        assert_eq!(
            parse_env_host("feat-x-2.my--app.noite.now", &bases),
            Some(("my--app".to_string(), "feat-x-2".to_string()))
        );
    }

    #[test]
    fn environment_hosts_never_collide_with_tenant_pod_or_platform_hosts() {
        let bases = bases(&["noite.now", "localhost", "noite.local"]);
        // A tenant host has one label below the base.
        assert_eq!(parse_env_host("test.noite.now", &bases), None);
        assert_eq!(parse_env_host("app.noite.now", &bases), None);
        assert_eq!(parse_env_host("api.noite.now", &bases), None);
        assert_eq!(parse_env_host("git.noite.now", &bases), None);
        assert_eq!(parse_env_host("noite.now", &bases), None);
        // The pod host is one label deeper, and the label catch-all under it
        // (`*.preview.{slug}.{base}`) is not an environment either.
        assert_eq!(parse_env_host("app-0.preview.test.noite.now", &bases), None);
        assert_eq!(parse_env_host("pod-1.preview.test.noite.now", &bases), None);
        assert_eq!(parse_env_host("x.preview.test.noite.now", &bases), None);
        // Labels the preview hosts own are refused, like the labeler does.
        assert_eq!(parse_env_host("preview.test.noite.now", &bases), None);
        assert_eq!(parse_env_host("app-0.test.noite.now", &bases), None);
        // A custom domain is not on a tenant base at all.
        assert_eq!(parse_env_host("feat-x.test.example.com", &bases), None);
        assert_eq!(parse_env_host("feat-x.test.evil.noite.now", &bases), None);
        // Empty pieces, no slug, too many labels.
        assert_eq!(parse_env_host(".test.noite.now", &bases), None);
        assert_eq!(parse_env_host("feat-x..noite.now", &bases), None);
        assert_eq!(parse_env_host("a.b.c.noite.now", &bases), None);
        assert_eq!(parse_env_host("", &bases), None);
        // The dev base has tenant hosts too (`test.localhost`).
        assert_eq!(
            parse_env_host("feat-x.test.localhost", &bases),
            Some(("test".to_string(), "feat-x".to_string()))
        );
    }

    #[test]
    fn environment_host_threads_are_not_tenants() {
        // No host may resolve to two different fleets: whatever the tenant
        // parser claims, the environment parser must refuse, and the pod host
        // belongs to neither (`parse_preview_slug` owns it).
        let bases = bases(&["noite.now", "noite.local", "localhost"]);
        for host in [
            "feat-x.test.noite.now",
            "feat-x.test.noite.local",
            "feat-x.test.localhost",
            "test.noite.now",
            "shop.noite.local",
            "shop.localhost",
            // Two labels that are not a platform host: the environment parser
            // claims it (the app `b` would have to exist, which is a DB
            // question), the tenant parser never does.
            "a.b.noite.now",
        ] {
            let env = parse_env_host(host, &bases);
            let tenant = parse_edge_slug(host, &bases, "app");
            assert!(
                env.is_some() ^ tenant.is_some(),
                "{host}: env {env:?} tenant {tenant:?}"
            );
        }
        for host in ["app-0.preview.test.noite.now", "x.preview.test.noite.now"] {
            assert_eq!(parse_env_host(host, &bases), None);
            assert_eq!(parse_edge_slug(host, &bases, "app"), None);
        }
        assert_eq!(
            parse_preview_slug("app-0.preview.test.noite.now", &bases),
            Some("test".to_string()),
            "the pod host keeps its own parser"
        );
    }

    #[test]
    fn tls_gate_allows_platform_hosts() {
        let extra = vec!["xyz-123.wild.example".to_string()];
        assert!(tls_ask_static_ok("app.noite.now", "noite.now", "app", &[]));
        assert!(tls_ask_static_ok(
            "app.noite.now:443",
            "noite.now",
            "app",
            &[]
        ));
        assert!(tls_ask_static_ok("api.noite.now", "noite.now", "app", &[]));
        assert!(tls_ask_static_ok("git.noite.now", "noite.now", "app", &[]));
        assert!(tls_ask_static_ok(
            "XYZ-123.wild.example",
            "noite.now",
            "app",
            &extra
        ));
        assert!(!tls_ask_static_ok("evil.com", "noite.now", "app", &extra));
        assert!(!tls_ask_static_ok(
            "test.noite.now",
            "noite.now",
            "app",
            &[]
        ));
        assert!(!tls_ask_static_ok("noite.now", "noite.now", "app", &[]));
        assert!(!tls_ask_static_ok("app.noite.now", "localhost", "", &[]));
        // The dev `*.localhost` base mints nothing either: it is plain http.
        assert!(!tls_ask_static_ok(
            "app.noite.localhost",
            "noite.localhost",
            "",
            &[]
        ));
        assert!(!tls_ask_static_ok("anything", "", "app", &[]));
    }
    #[test]
    fn parses_preview_hosts() {
        let bases = bases(&["noite.now", "noite.local"]);
        assert_eq!(
            parse_preview_slug("app-0.preview.test.noite.now", &bases),
            Some("test".to_string())
        );
        assert_eq!(
            parse_preview_slug("app-0.preview.test.noite.local:9080", &bases),
            Some("test".to_string())
        );
        // One stable label per app: every other pod label is refused, and the
        // shape Nodepod used to need (`{instanceId}-{port}`) is not admitted.
        assert_eq!(
            parse_preview_slug("pod123-4444.preview.test.noite.now", &bases),
            None
        );
        assert_eq!(
            parse_preview_slug("app-1.preview.test.noite.now", &bases),
            None
        );
        // No pod label, a dotted slug, an empty slug, a foreign base.
        assert_eq!(parse_preview_slug("preview.test.noite.now", &bases), None);
        assert_eq!(
            parse_preview_slug("app-0.preview.a.b.noite.now", &bases),
            None
        );
        assert_eq!(parse_preview_slug("app-0.preview.noite.now", &bases), None);
        assert_eq!(
            parse_preview_slug("app-0.preview.test.evil.com", &bases),
            None
        );
        // A tenant host is never a preview host.
        assert_eq!(parse_preview_slug("test.noite.now", &bases), None);
        assert_eq!(parse_preview_slug("app-0.noite.now", &bases), None);
    }

    #[test]
    fn rejects_platform_hosts() {
        let dev = bases(&["localhost"]);
        assert_eq!(parse_edge_slug("localhost:9080", &dev, ""), None);
        // Dev has no control subdomain: `app` is just an unknown slug there.
        assert_eq!(
            parse_edge_slug("app.localhost", &dev, ""),
            Some("app".to_string())
        );
        let prod = bases(&["noite.now"]);
        assert_eq!(parse_edge_slug("api.noite.now", &prod, "app"), None);
        assert_eq!(parse_edge_slug("git.noite.now", &prod, "app"), None);
        assert_eq!(parse_edge_slug("app.noite.now", &prod, "app"), None);
        assert_eq!(parse_edge_slug("a.b.localhost", &dev, ""), None);
        assert_eq!(parse_edge_slug("", &dev, ""), None);
    }

    #[test]
    fn control_url_shapes() {
        assert_eq!(
            control_url(
                "asdf.localhost:9080",
                "localhost",
                "",
                &bases(&["localhost"])
            ),
            "http://localhost:9080"
        );
        // The dev stack's `*.localhost` base: plain http, the visitor's port.
        assert_eq!(
            control_url(
                "asdf.noite.localhost:9080",
                "noite.localhost",
                "",
                &bases(&["noite.localhost"])
            ),
            "http://noite.localhost:9080"
        );
        assert_eq!(
            control_url("x.noite.now", "noite.now", "app", &bases(&["noite.now"])),
            "https://app.noite.now"
        );
    }

    #[test]
    fn control_url_links_lan_visitors_home() {
        let lan = bases(&["localhost", "noite.local"]);
        assert_eq!(
            control_url("test.noite.local:9080", "localhost", "", &lan),
            "http://noite.local:9080"
        );
        assert_eq!(
            control_url("noite.local", "localhost", "", &lan),
            "http://noite.local"
        );
        // Base visitors are unaffected by the extra host.
        assert_eq!(
            control_url("asdf.localhost:9080", "localhost", "", &lan),
            "http://localhost:9080"
        );
    }

    #[test]
    fn escapes_html() {
        assert_eq!(escape("<a>&\""), "&lt;a&gt;&amp;&quot;");
    }
}
