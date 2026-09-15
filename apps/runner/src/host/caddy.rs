use std::path::Path;

use crate::config::Config;
use crate::models::App;

pub async fn rewrite_caddy(cfg: &Config, apps: &[App]) -> anyhow::Result<()> {
    let local = cfg.base_domain == "localhost";
    let auto_https = if cfg.auto_https { "on" } else { "off" };
    let plain = local || !cfg.auto_https;
    // Control plane lives on the bare domain when CONTROL_SUBDOMAIN is empty
    // (dev `localhost` — the only hostname Bitwarden's matcher accepts
    // without https) or on `{sub}.{domain}` in prod (`app`, apex stays free
    // for marketing). `http://` pins plain HTTP for dev; prod uses bare
    // hostnames so auto_https serves https://app.{domain} + https://{app}.{domain}.
    let mut control_hosts = vec![if cfg.control_subdomain.is_empty() {
        cfg.base_domain.clone()
    } else {
        format!("{}.{}", cfg.control_subdomain, cfg.base_domain)
    }];
    // Extra control hostnames (e.g. Coolify's generated domain) share the
    // control site so the auto-provisioned route serves the UI, not the
    // unknown-host fallback.
    control_hosts.extend(cfg.control_extra_hosts.iter().cloned());
    let control_site = control_hosts.join(", ");
    let site = |host: &str| -> String {
        if plain {
            format!("http://{host}")
        } else {
            host.to_string()
        }
    };
    // Behind a terminating edge proxy (Coolify/Traefik) our Caddy terminates
    // TLS itself for every hostname via on-demand certs; the proxy only
    // TCP-forwards SNI. Those sites use bare hostnames (both :80 plaintext
    // and :443 TLS) — never an `http://` pin combined with a `tls`
    // directive, which Caddy refuses to adapt. Everywhere else keep the
    // existing scheme behavior.
    let edge_tls = !local && !cfg.auto_https;
    let addr_of = |host: &str| -> String {
        if edge_tls {
            host.to_string()
        } else {
            site(host)
        }
    };
    let mut lines = vec![
        "# noite-edge".into(),
        "{".into(),
        format!("\tauto_https {auto_https}"),
        "\ton_demand_tls {".into(),
        format!("\t\task http://{}/v1/edge/tls-ask", cfg.caddy_api_upstream),
        "\t}".into(),
        "}".into(),
        String::new(),
    ];
    // One reverse-proxy site block; `tls` adds an on-demand TLS gate so the
    // site serves HTTPS with per-hostname certs (no wildcard cert needed).
    // Site-level extras (e.g. `rewrite`) go in the site block; proxy options
    // (e.g. `header_up`) MUST go inside `reverse_proxy` — Caddy rejects
    // them at site level and then keeps serving the stale config.
    let mut push_site = |addr: &str,
                         tls: bool,
                         site_extra: &[&str],
                         proxy_extra: &[&str],
                         upstream: &str| {
        lines.push(format!("{addr} {{"));
        if tls {
            lines.push("\ttls {".into());
            lines.push("\t\ton_demand".into());
            lines.push("\t}".into());
        }
        for line in site_extra {
            lines.push(format!("\t{line}"));
        }
        lines.push(format!("\treverse_proxy {upstream} {{"));
        for line in proxy_extra {
            lines.push(format!("\t\t{line}"));
        }
        lines.push("\t\tflush_interval -1".into());
        lines.push("\t}".into());
        lines.push("}".into());
        lines.push(String::new());
    };
    push_site(
        &addr_of(&control_site),
        edge_tls,
        &[],
        &[],
        &cfg.caddy_control_upstream,
    );
    // Plaintext loopback for container healthchecks, independent of TLS mode.
    push_site(
        "http://127.0.0.1",
        false,
        &[],
        &[],
        &cfg.caddy_control_upstream,
    );
    for app in apps {
        let Some(port) = app.listen_port else {
            continue;
        };
        // Only deployed apps can serve: stopped ones are parked and
        // never-deployed ones have no fleet — both fall through to the
        // wildcard fallback page instead of a dead route.
        if app.is_stopped() || !app.is_deployed() {
            continue;
        }
        let upstream = format!("{}:{}", cfg.caddy_upstream_host, port);
        push_site(
            &addr_of(&format!("{}.{}", app.slug, cfg.base_domain)),
            edge_tls,
            &[],
            &[
                "header_up X-Forwarded-Host {http.request.hostport}",
                "header_up X-Forwarded-Proto {http.request.scheme}",
            ],
            &upstream,
        );
    }
    // API → runner (Bearer-protected REST)
    push_site(
        &addr_of(&format!("api.{}", cfg.base_domain)),
        edge_tls,
        &[],
        &[],
        &cfg.caddy_api_upstream,
    );

    // Git smart-HTTP → runner `/v1/git/{slug}/…` (Basic auth inside runner)
    push_site(
        &addr_of(&format!("git.{}", cfg.base_domain)),
        edge_tls,
        &["rewrite * /v1/git{uri}"],
        &[],
        &cfg.caddy_api_upstream,
    );

    // Fallback: unknown slugs + stopped apps → runner edge page (per-Host).
    // Tenant TLS is minted on demand (ask-gated), so no wildcard cert or
    // DNS-challenge module is needed on any platform.
    push_site(
        &addr_of(&format!("*.{}", cfg.base_domain)),
        !local,
        &["rewrite * /v1/edge/fallback"],
        &[],
        &cfg.caddy_api_upstream,
    );

    let next = lines.join("\n");
    let path = Path::new(&cfg.caddyfile_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let prev = tokio::fs::read_to_string(path).await.unwrap_or_default();
    if prev == next {
        return Ok(());
    }
    tokio::fs::write(path, next).await?;
    tracing::info!(path = %cfg.caddyfile_path, n = apps.len(), "caddyfile updated");
    Ok(())
}
