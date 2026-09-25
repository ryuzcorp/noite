use std::path::Path;

use crate::config::Config;
use crate::models::{App, AppDomain};

/// Pin `http://` on every address of a site line.
///
/// Caddy applies an address line's scheme to the **first** address only, so
/// `http://a, b` binds `b` on `:443` — the same address the site's own
/// bare-hosts block claims — and the whole file is rejected with
/// `Error: ambiguous site definition: b`. Caddy then keeps serving whatever it
/// loaded last (the bootstrap config), which reads as a blank edge. The
/// plaintext twin of a tls-gated site therefore needs the scheme per host.
fn plaintext_hosts(addr: &str) -> String {
    addr.split(',')
        .map(str::trim)
        .map(|host| {
            if host.starts_with("http://") || host.starts_with("https://") {
                host.to_string()
            } else {
                format!("http://{host}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub async fn rewrite_caddy(
    cfg: &Config,
    apps: &[App],
    domains: &[AppDomain],
) -> anyhow::Result<()> {
    let local = cfg.base_domain == "localhost";
    let plain = local || !cfg.auto_https;
    // Control plane lives on the bare domain when CONTROL_SUBDOMAIN is empty
    // (dev `localhost` — the only hostname Bitwarden's matcher accepts
    // without https) or on `{sub}.{domain}` in prod (`app`, apex stays free
    // for marketing). `http://` pins plain HTTP for dev; prod uses bare
    // hostnames so TLS serves https://app.{domain} + https://{app}.{domain}
    // (automatic certs, or on-demand behind a proxy).
    // Scheme is pinned PER HOST: Caddy binds a schemeless address to :443,
    // so one `http://` prefix across a comma-joined list strands every host
    // after the first on :443 (unreachable behind the :80 edge publish).
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
    let mut control_hosts = vec![if cfg.control_subdomain.is_empty() {
        cfg.base_domain.clone()
    } else {
        format!("{}.{}", cfg.control_subdomain, cfg.base_domain)
    }];
    // Extra control hostnames (e.g. Coolify's assigned domain, `dev-host`
    // LAN IP) share the control site so the route serves the UI, not the
    // unknown-host fallback. Consecutive duplicates are dropped: an install
    // that sets the extra host to the control host itself (Coolify's domain on
    // the bare domain) would otherwise emit `lab.example.com, lab.example.com`.
    control_hosts.extend(cfg.control_extra_hosts.iter().cloned());
    control_hosts.dedup();
    let control_site = control_hosts
        .iter()
        .map(|h| addr_of(h))
        .collect::<Vec<_>>()
        .join(", ");
    let mut lines = vec!["# noite-edge".into(), "{".into()];
    // `auto_https` accepts only disable-style values — "on" is Caddy's
    // default and NOT a valid token, so the directive is emitted only when
    // HTTPS must be off (localhost dev, behind-proxy installs).
    if !cfg.auto_https {
        lines.push("\tauto_https off".into());
    }
    lines.push("\ton_demand_tls {".into());
    lines.push(format!(
        "\t\task http://{}/v1/edge/tls-ask",
        cfg.caddy_api_upstream
    ));
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());
    // One reverse-proxy site block; `tls` adds an on-demand TLS gate so the
    // site serves HTTPS with per-hostname certs (no wildcard cert needed).
    // A tls-gated site does NOT proxy plaintext :80 (empty 200s) — so it
    // always gets an `http://` twin serving the same handlers in clear.
    // Site-level extras (e.g. `rewrite`) go in the site block; proxy options
    // (e.g. `header_up`) MUST go inside `reverse_proxy` — Caddy rejects
    // them at site level and then keeps serving the stale config.
    let mut push_block = |addr: &str, tls: bool, site_extra: &[&str], proxy_extra: &[&str], upstream: &str| {
        lines.push(format!("{addr} {{"));
        // Access log per site as JSON into the shared file (same volume as
        // the Caddyfile), feeding the runner's device breakdown. Tradeoff:
        // per-request lines leave `docker logs` (Caddy process logs like
        // reloads and errors still go to stdout); tail them via
        // `podman exec <caddy> tail -f /etc/caddy/access.log` instead.
        lines.push("\tlog {".into());
        lines.push("\t\toutput file /etc/caddy/access.log".into());
        lines.push("\t\tformat json".into());
        lines.push("\t}".into());
        // Compression, because celld does not compress an asset response and
        // the docs point at a compressing ingress proxy for clients that want
        // gzip or brotli. Measured through this edge: the control UI's
        // content-hashed bundle drops from 462 KiB to 144 KiB and its CSS from
        // 129 KiB to 22 KiB, while the `text/event-stream` log/deploy/metric
        // endpoints stay uncompressed, chunked and unbuffered (the proxy below
        // keeps `flush_interval -1`, and Caddy skips an event stream).
        lines.push("\tencode zstd gzip".into());
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
    let mut push_site = |addr: &str,
                         tls: bool,
                         site_extra: &[&str],
                         proxy_extra: &[&str],
                         upstream: &str| {
        if tls && !addr.starts_with("http://") {
            push_block(
                &plaintext_hosts(addr),
                false,
                site_extra,
                proxy_extra,
                upstream,
            );
        }
        push_block(addr, tls, site_extra, proxy_extra, upstream);
    };
    push_site(
        // Per-host scheme mapping is handled inside `push_site`, so the joined
        // control list needs no special casing here.
        &control_site,
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
    // Tenants serve under every DNS base (dev `localhost` plus LAN names
    // like `noite.local` and Coolify domains) — same per-app routes and
    // wildcard fallback on each, so LAN URLs work without a second topology.
    for base in cfg.tenant_bases() {
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
            // No header_up lines: Caddy's reverse_proxy already forwards Host
            // and sets X-Forwarded-For/Proto/Host by default (it warns on
            // explicit duplicates, and site-level ones fail the whole adapt).
            push_site(
                &addr_of(&format!("{}.{}", app.slug, base)),
                edge_tls,
                &[],
                &[],
                &upstream,
            );
        }
    }
    // Custom hostnames (app_domain): one site per registered name, routed to
    // its app's port. Same rule as the tenant sites — a stopped or
    // never-deployed app gets no route, so the request lands on the wildcard
    // fallback page instead of a dead upstream (host/edge.rs resolves custom
    // hosts there too).
    for domain in domains {
        let Some(app) = apps.iter().find(|a| a.id == domain.app_id) else {
            continue;
        };
        let Some(port) = app.listen_port else {
            continue;
        };
        if app.is_stopped() || !app.is_deployed() {
            continue;
        }
        let upstream = format!("{}:{}", cfg.caddy_upstream_host, port);
        push_site(&addr_of(&domain.hostname), edge_tls, &[], &[], &upstream);
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

    // Fallback: unknown slugs + stopped apps → runner edge page (per-Host,
    // on every tenant base). Tenant TLS is minted on demand (ask-gated), so
    // no wildcard cert or DNS-challenge module is needed on any platform.
    for base in cfg.tenant_bases() {
        push_site(
            &addr_of(&format!("*.{base}")),
            !local,
            &["rewrite * /v1/edge/fallback"],
            &[],
            &cfg.caddy_api_upstream,
        );
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::models::{App, AppDomain};

    fn test_config(base: &str, sub: &str, auto_https: bool, path: &str) -> Config {
        Config {
            bind: "0.0.0.0:8080".into(),
            runner_token: "test-token".into(),
            database_url: "sqlite::memory:".into(),
            s3_endpoint: "http://rustfs:9000".into(),
            s3_public_endpoint: "http://rustfs:9000".into(),
            s3_bucket: "noite".into(),
            aws_region: "us-east-1".into(),
            aws_access_key_id: "key".into(),
            aws_secret_access_key: "secret".into(),
            base_domain: base.into(),
            control_subdomain: sub.into(),
            control_extra_hosts: vec![],
            work_dir: "/tmp/noite-test".into(),
            caddyfile_path: path.into(),
            celld_bin: "celld".into(),
            port_base: 8100,
            poll_ms: 5000,
            caddy_upstream_host: "runner".into(),
            auto_https,
            caddy_control_upstream: "ui:8080".into(),
            caddy_api_upstream: "runner:8080".into(),
            git_public_base: format!("https://git.{base}"),
            ui_url: "http://ui:8080".into(),
            caddy_access_log: "/caddy/access.log".into(),
            fleet_log: "error,celld=warn".into(),
            max_apps_per_user: 10,
            fleet_max_rss_mb: 512,
            fleet_idle_evict_s: 300,
        }
    }

    fn test_app() -> App {
        App {
            id: "app-id".into(),
            slug: "test".into(),
            name: "Test".into(),
            user_id: "local".into(),
            status: "running".into(),
            subdomain: "test.noite.now".into(),
            git_prefix: "git/test/".into(),
            fleet_bucket: "s3://noite/fleets/test".into(),
            listen_port: Some(8100),
            internal_port: Some(8101),
            last_deploy_sha: Some("abc123".into()),
            last_error: None,
            desired_state: "running".into(),
            created_at: "2026-09-15T00:00:00Z".into(),
            updated_at: "2026-09-15T00:00:00Z".into(),
        }
    }

    fn test_domain(app_id: &str, hostname: &str) -> AppDomain {
        AppDomain {
            app_id: app_id.into(),
            hostname: hostname.into(),
            created_at: "2026-09-15T00:00:00Z".into(),
        }
    }

    async fn rendered(cfg: &Config, apps: &[App]) -> String {
        rendered_with(cfg, apps, &[]).await
    }

    async fn rendered_with(cfg: &Config, apps: &[App], domains: &[AppDomain]) -> String {
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
        rewrite_caddy(cfg, apps, domains).await.expect("rewrite");
        tokio::fs::read_to_string(&cfg.caddyfile_path)
            .await
            .expect("read back")
    }

    #[tokio::test]
    async fn custom_domains_route_only_live_apps() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-domains");
        let live = test_app();
        let mut stopped = test_app();
        stopped.id = "stopped-id".into();
        stopped.slug = "parked".into();
        stopped.desired_state = "stopped".into();
        let mut undeployed = test_app();
        undeployed.id = "fresh-id".into();
        undeployed.slug = "fresh".into();
        // Provisioned but never pushed: `is_deployed()` is status-or-sha, so
        // both have to be unset to model a fresh app.
        undeployed.status = "pending".into();
        undeployed.last_deploy_sha = None;
        let domains = [
            test_domain("app-id", "www.example.com"),
            test_domain("stopped-id", "parked.example.com"),
            test_domain("fresh-id", "fresh.example.com"),
            test_domain("gone-id", "orphan.example.com"),
        ];
        let out = rendered_with(&cfg, &[live, stopped, undeployed], &domains).await;
        assert!(out.contains("www.example.com {"), "live app gets a site");
        assert!(
            !out.contains("parked.example.com"),
            "a stopped app gets no route"
        );
        assert!(
            !out.contains("fresh.example.com"),
            "a never-deployed app gets no route"
        );
        assert!(
            !out.contains("orphan.example.com"),
            "a domain without an app gets no route"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn coolify_shape() {
        let cfg = test_config("noite.now", "app", false, "/tmp/noite-test-coolify");
        let out = rendered_with(
            &cfg,
            &[test_app()],
            &[test_domain("app-id", "www.example.com")],
        )
        .await;
        println!("--- coolify Caddyfile ---\n{out}\n--- end ---");
        // Behind-proxy: bare hostnames + on-demand TLS for :443, plus an
        // `http://` twin per site — tls-gated sites answer plaintext :80
        // with empty 200s, so the twin carries the cleartext handlers.
        // (Never an `http://` pin combined with a `tls` directive in one
        // block: Caddy refuses to adapt that.)
        assert!(out.contains("app.noite.now {"), "control TLS site");
        assert!(out.contains("http://app.noite.now {"), "control plain twin");
        assert!(out.contains("test.noite.now {"), "tenant TLS site");
        assert!(out.contains("http://test.noite.now {"), "tenant plain twin");
        assert!(out.contains("api.noite.now {"), "api TLS site");
        assert!(out.contains("www.example.com {"), "custom domain TLS site");
        assert!(
            out.contains("http://www.example.com {"),
            "custom domain plaintext twin behind the proxy"
        );
        assert!(out.contains("on_demand"), "on-demand gate");
        assert!(out.contains("tls-ask"), "ask endpoint");
        assert!(out.contains("http://127.0.0.1 {"), "loopback health site");
        assert!(!out.contains("header_up Host"), "no redundant Host");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[test]
    fn plaintext_twin_pins_the_scheme_per_host() {
        assert_eq!(plaintext_hosts("app.noite.now"), "http://app.noite.now");
        assert_eq!(
            plaintext_hosts("app.noite.now, lab.netbird.cloud"),
            "http://app.noite.now, http://lab.netbird.cloud"
        );
        // Already-mapped input is left alone (that branch skips the twin).
        assert_eq!(
            plaintext_hosts("http://a.example.com, http://b.example.com"),
            "http://a.example.com, http://b.example.com"
        );
    }

    #[tokio::test]
    async fn behind_proxy_extra_control_host_keeps_a_valid_twin() {
        // A Coolify install sets CONTROL_EXTRA_HOSTS to the domain Coolify
        // gave the caddy service, and that host is also a tenant base — so the
        // control site becomes a joined list. Prefixing that list once put
        // every host after the first on :443, where the same site's bare hosts
        // live, and Caddy rejected the whole file:
        //   Error: ambiguous site definition: lab.netbird.cloud
        // It then kept serving the bootstrap config, so the edge answered the
        // placeholder (or, for an unmatched Host, an empty 200) instead of the
        // control UI.
        let mut cfg = test_config("noite.now", "app", false, "/tmp/noite-test-extra");
        cfg.control_extra_hosts = vec!["lab.netbird.cloud".into()];
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            out.contains("http://app.noite.now, http://lab.netbird.cloud {"),
            "plaintext twin pins the scheme per control host:\n{out}"
        );
        assert!(
            !out.contains("http://app.noite.now, lab.netbird.cloud {"),
            "a joined list must never carry a single scheme"
        );
        assert!(
            out.contains("app.noite.now, lab.netbird.cloud {"),
            "the tls-gated site still lists both hosts"
        );
        assert!(
            out.contains("http://*.lab.netbird.cloud {"),
            "the extra host keeps its tenant wildcard twin"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn direct_tls_omits_auto_https_directive() {
        // Caddy's `auto_https` takes only disable-style values — "on" is the
        // default and is REJECTED at adapt time, which killed every
        // real-domain install the moment the runner owned the Caddyfile.
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-direct");
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            !out.contains("auto_https"),
            "no auto_https directive when HTTPS is on"
        );
        assert!(out.contains("\ttls {"), "on-demand TLS site");
        assert!(out.contains("tls-ask"), "ask endpoint");
        assert!(out.contains("\tencode zstd gzip"), "compressing edge");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn local_shape_unchanged() {
        let cfg = test_config("localhost", "", false, "/tmp/noite-test-local");
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(out.contains("http://test.localhost {"), "tenant plain site");
        assert!(!out.contains("\ttls {"), "no TLS site in dev");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn local_extra_hosts_each_get_plain_scheme() {
        // Caddy binds a schemeless address to :443, stranding it behind the
        // :80 edge publish — every control host needs its own `http://` pin.
        let mut cfg = test_config("localhost", "", false, "/tmp/noite-test-local-extra");
        cfg.control_extra_hosts = vec!["192.168.10.62".into()];
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            out.contains("http://localhost, http://192.168.10.62 {"),
            "control site pins plain HTTP per host:\n{out}"
        );
        assert!(
            !out.contains("http://http://"),
            "no doubled scheme from mapping the joined list again:\n{out}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }
    #[tokio::test]
    async fn tenants_serve_under_dns_extra_hosts() {
        let mut cfg = test_config("localhost", "", false, "/tmp/noite-test-tenant-lan");
        cfg.control_extra_hosts = vec!["noite.local".into()];
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            out.contains("http://test.noite.local {"),
            "tenant plain site on LAN base:\n{out}"
        );
        assert!(
            out.contains("http://*.noite.local {"),
            "wildcard fallback on LAN base:\n{out}"
        );
        // Base shape untouched.
        assert!(out.contains("http://test.localhost {"), "tenant plain site");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn ip_extra_hosts_get_no_tenant_sites() {
        let mut cfg = test_config("localhost", "", false, "/tmp/noite-test-tenant-ip");
        cfg.control_extra_hosts = vec!["192.168.10.62".into()];
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            !out.contains("*.192.168") && !out.contains("test.192.168"),
            "bare IPs are control-only, never tenant bases:\n{out}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }
}
