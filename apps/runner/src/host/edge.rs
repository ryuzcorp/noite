//! Edge fallback page: Caddy's `*.{domain}` catch-all lands here for hosts
//! with no tenant route — unknown slugs, stopped apps, never-deployed apps.
//!
//! States by Host header: no app row → 404 Not found; app stopped → 503
//! Paused; app without a deploy → 404 Not deployed yet. Self-contained HTML
//! (no UI build involved), public route (own lookup, no bearer token).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
};

use crate::AppState;

/// Tenant slug from a Host header, if it addresses `{slug}.{base}` and is
/// not one of the platform hosts (control, api, git).
pub fn parse_edge_slug(host: &str, base_domain: &str, control_sub: &str) -> Option<String> {
    let bare = host.split_once(':').map(|(h, _)| h).unwrap_or(host);
    let bare = bare.trim().to_lowercase();
    if bare.is_empty() || bare == base_domain {
        return None;
    }
    let suffix = format!(".{base_domain}");
    let slug = bare.strip_suffix(&suffix)?;
    if slug.is_empty() || slug.contains('.') {
        return None;
    }
    if slug == control_sub || slug == "api" || slug == "git" {
        return None;
    }
    Some(slug.to_string())
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
/// incoming Host (keeps dev ports working without configuration).
fn control_url(host: &str, base_domain: &str, control_sub: &str) -> String {
    let port = host
        .split_once(':')
        .map(|(_, p)| p)
        .filter(|p| !p.is_empty())
        .map(|p| format!(":{p}"))
        .unwrap_or_default();
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
    let control = control_url(host, &cfg.base_domain, &cfg.control_subdomain);
    let Some(slug) = parse_edge_slug(host, &cfg.base_domain, &cfg.control_subdomain) else {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tenant_hosts() {
        assert_eq!(
            parse_edge_slug("asdf.localhost:9080", "localhost", ""),
            Some("asdf".to_string())
        );
        assert_eq!(
            parse_edge_slug("my-app.noite.now", "noite.now", "app"),
            Some("my-app".to_string())
        );
    }

    #[test]
    fn rejects_platform_hosts() {
        assert_eq!(parse_edge_slug("localhost:9080", "localhost", ""), None);
        // Dev has no control subdomain: `app` is just an unknown slug there.
        assert_eq!(
            parse_edge_slug("app.localhost", "localhost", ""),
            Some("app".to_string())
        );
        assert_eq!(parse_edge_slug("api.noite.now", "noite.now", "app"), None);
        assert_eq!(parse_edge_slug("git.noite.now", "noite.now", "app"), None);
        assert_eq!(parse_edge_slug("app.noite.now", "noite.now", "app"), None);
        assert_eq!(parse_edge_slug("a.b.localhost", "localhost", ""), None);
        assert_eq!(parse_edge_slug("", "localhost", ""), None);
    }

    #[test]
    fn control_url_shapes() {
        assert_eq!(
            control_url("asdf.localhost:9080", "localhost", ""),
            "http://localhost:9080"
        );
        assert_eq!(
            control_url("x.noite.now", "noite.now", "app"),
            "https://app.noite.now"
        );
    }

    #[test]
    fn escapes_html() {
        assert_eq!(escape("<a>&\""), "&lt;a&gt;&amp;&quot;");
    }
}
