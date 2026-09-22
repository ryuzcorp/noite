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
    Json,
};

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

fn escape(text: &str) -> String {
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
fn control_url(host: &str, base_domain: &str, control_sub: &str, tenant_bases: &[String]) -> String {
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
        if base_domain == "localhost" {
            return format!("http://{extra}{port}");
        }
        return format!("https://{extra}");
    }
    let name = if control_sub.is_empty() {
        base_domain.to_string()
    } else {
        format!("{control_sub}.{base_domain}")
    };
    if base_domain == "localhost" {
        format!("http://{name}{port}")
    } else {
        format!("https://{name}")
    }
}

fn page(status: StatusCode, title: &str, body: &str, control: &str) -> impl IntoResponse {
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

pub async fn edge_fallback(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let cfg = &state.config;
    let bases = cfg.tenant_bases();
    let control = control_url(host, &cfg.base_domain, &cfg.control_subdomain, &bases);
    let Some(slug) = parse_edge_slug(host, &bases, &cfg.control_subdomain) else {
        return page(
            StatusCode::NOT_FOUND,
            "Not found",
            &format!("There&rsquo;s nothing at <code>{}</code>.", escape(host)),
            &control,
        );
    };
    let app = crate::db::get_app_by_slug(&state.pool, &slug).await.ok().flatten();
    let Some(app) = app else {
        return page(
            StatusCode::NOT_FOUND,
            "Not found",
            &format!(
                "There&rsquo;s no app for this slug (<code>{}</code>).",
                escape(&slug)
            ),
            &control,
        );
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
/// liveness check (done by the caller). Never localhost — dev has no public
/// TLS and must not trigger issuance attempts.
pub fn tls_ask_static_ok(
    host: &str,
    base_domain: &str,
    control_sub: &str,
    extra_hosts: &[String],
) -> bool {
    if base_domain == "localhost" || base_domain.trim().is_empty() {
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
        || extra_hosts
            .iter()
            .any(|h| h.trim().to_lowercase() == bare)
}

/// Worker route table for container dispatch (`GET /v1/edge/routes`,
/// bearer-gated): slug → fleet ports for deployed running apps. The control
/// worker DO caches this (~5 s TTL) and targets tenants via
/// `getTcpPort(listenPort)`. Stopped/never-deployed apps are omitted so the
/// worker falls through to the edge fallback page.
pub async fn edge_routes(State(state): State<AppState>) -> impl IntoResponse {
    let apps = crate::db::list_apps(&state.pool).await.unwrap_or_default();
    let mut routes = Vec::new();
    for app in &apps {
        if app.is_stopped() || !app.is_deployed() {
            continue;
        }
        let (Some(listen), Some(internal)) = (app.listen_port, app.internal_port) else {
            continue;
        };
        routes.push(serde_json::json!({
            "slug": app.slug,
            "listenPort": listen,
            "internalPort": internal,
            "status": app.status,
        }));
    }
    Json(serde_json::json!({ "routes": routes }))
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
    let Some(slug) = parse_edge_slug(domain, &cfg.tenant_bases(), &cfg.control_subdomain) else {
        return StatusCode::NOT_FOUND;
    };
    if !crate::lifecycle::slug_ok(&slug) {
        return StatusCode::NOT_FOUND;
    }
    match crate::db::get_app_by_slug(&state.pool, &slug).await {
        Ok(Some(app)) if !app.is_stopped() && app.is_deployed() => StatusCode::OK,
        _ => StatusCode::NOT_FOUND,
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
        assert_eq!(parse_edge_slug("test.localhost:9080", &lan, ""), Some("test".to_string()));
        assert_eq!(parse_edge_slug("test.evil.local", &lan, ""), None);
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
        assert!(!tls_ask_static_ok("test.noite.now", "noite.now", "app", &[]));
        assert!(!tls_ask_static_ok("noite.now", "noite.now", "app", &[]));
        assert!(!tls_ask_static_ok("app.noite.now", "localhost", "", &[]));
        assert!(!tls_ask_static_ok("anything", "", "app", &[]));
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
            control_url("asdf.localhost:9080", "localhost", "", &bases(&["localhost"])),
            "http://localhost:9080"
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
