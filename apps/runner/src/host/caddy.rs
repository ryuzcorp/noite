use std::path::Path;

use crate::config::Config;
use crate::models::App;

pub async fn rewrite_caddy(cfg: &Config, apps: &[App]) -> anyhow::Result<()> {
    let local = cfg.base_domain == "localhost";
    let auto_https = if local { "off" } else { "on" };
    // Control plane lives on the bare domain when CONTROL_SUBDOMAIN is empty
    // (dev `localhost` — the only hostname Bitwarden's matcher accepts
    // without https) or on `{sub}.{domain}` in prod (`app`, apex stays free
    // for marketing). `http://` pins plain HTTP for dev; prod uses bare
    // hostnames so auto_https serves https://app.{domain} + https://{app}.{domain}.
    let control_host = if cfg.control_subdomain.is_empty() {
        cfg.base_domain.clone()
    } else {
        format!("{}.{}", cfg.control_subdomain, cfg.base_domain)
    };
    let site = |host: &str| -> String {
        if local {
            format!("http://{host}")
        } else {
            host.to_string()
        }
    };
    let mut lines = vec![
        "# noite-edge".into(),
        "{".into(),
        format!("\tauto_https {auto_https}"),
        "}".into(),
        String::new(),
        format!("{}, http://127.0.0.1 {{", site(&control_host)),
        format!("\treverse_proxy {} {{", cfg.caddy_control_upstream),
        "\t\theader_up Host {http.request.hostport}".into(),
        "\t\tflush_interval -1".into(),
        "\t}".into(),
        "}".into(),
        String::new(),
    ];
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
        lines.push(format!("{} {{", site(&format!("{}.{}", app.slug, cfg.base_domain))));
        lines.push(format!(
            "\treverse_proxy {}:{} {{",
            cfg.caddy_upstream_host, port
        ));
        lines.push("\t\theader_up Host {http.request.hostport}".into());
        lines.push("\t\theader_up X-Forwarded-Host {http.request.hostport}".into());
        lines.push("\t\theader_up X-Forwarded-Proto {http.request.scheme}".into());
        lines.push("\t\tflush_interval -1".into());
        lines.push("\t}".into());
        lines.push("}".into());
        lines.push(String::new());
    }
    // API → runner (Bearer-protected REST)
    lines.push(format!("{} {{", site(&format!("api.{}", cfg.base_domain))));
    lines.push(format!("\treverse_proxy {} {{", cfg.caddy_api_upstream));
    lines.push("\t\theader_up Host {http.request.hostport}".into());
    lines.push("\t\tflush_interval -1".into());
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());

    // Git smart-HTTP → runner `/v1/git/{slug}/…` (Basic auth inside runner)
    lines.push(format!("{} {{", site(&format!("git.{}", cfg.base_domain))));
    lines.push("\trewrite * /v1/git{uri}".into());
    lines.push(format!("\treverse_proxy {} {{", cfg.caddy_api_upstream));
    lines.push("\t\theader_up Host {http.request.hostport}".into());
    lines.push("\t\tflush_interval -1".into());
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());

    // Fallback: unknown slugs + stopped apps → runner edge page (per-Host).
    // NOTE: a wildcard site needs a DNS-challenge module for auto_https in
    // prod; without one only the concrete sites above get certificates.
    lines.push(format!("{} {{", site(&format!("*.{}", cfg.base_domain))));
    lines.push("\trewrite * /v1/edge/fallback".into());
    lines.push(format!("\treverse_proxy {} {{", cfg.caddy_api_upstream));
    lines.push("\t\theader_up Host {http.request.hostport}".into());
    lines.push("\t\tflush_interval -1".into());
    lines.push("}".into());
    lines.push("}".into());
    lines.push(String::new());

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
