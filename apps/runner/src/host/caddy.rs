use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::{is_localhost_domain, Config};
use crate::db::EnvironmentRoute;
use crate::models::{App, AppDomain, AppLimit};

/// Whether the Caddy binary has the `rate_limit` handler
/// (github.com/mholt/caddy-ratelimit, built into the image). A stock Caddy
/// rejects the whole Caddyfile at the first `rate_limit`, which would leave
/// the edge serving its bootstrap config, so without the module the limits
/// are left out instead. Set once at boot by [`detect_modules`].
static RATE_LIMIT_MODULE: AtomicBool = AtomicBool::new(true);

/// Ask the Caddy binary for its modules and record whether edge rate limits
/// can be written.
pub async fn detect_modules() {
    let out = tokio::process::Command::new("caddy")
        .arg("list-modules")
        .output()
        .await;
    let has = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .any(|l| l.trim() == "http.handlers.rate_limit"),
        _ => false,
    };
    if !has {
        tracing::warn!(
            "caddy has no http.handlers.rate_limit module: edge rate limits are off \
             (the image builds it in with github.com/mholt/caddy-ratelimit)"
        );
    }
    RATE_LIMIT_MODULE.store(has, Ordering::Relaxed);
}

/// Sliding window the edge counts requests over. Limits are configured per
/// minute and enforced as a sixth of that per 10 s: the ring buffer the
/// module keeps per client is sized by the event count, so a per-minute
/// window would cost six times the memory for every address in a wide flood,
/// and a burst still gets a whole window's budget at once.
const RATE_WINDOW_S: u32 = 10;

/// One `rate_limit` zone. Zones are shared by name across every site block
/// (the module keeps limiter state in a process-wide pool), so an app's
/// subdomain, custom domains and plaintext twins draw from one budget.
struct Zone {
    name: String,
    /// `{client_ip}` for a per-client limit, a constant for one shared limit.
    key: &'static str,
    rpm: u32,
}

impl Zone {
    /// A per-client zone; off when the edge cannot tell clients apart
    /// ([`Config::edge_sees_clients`]).
    fn per_client(cfg: &Config, name: impl Into<String>, rpm: u32) -> Self {
        let rpm = if cfg.edge_sees_clients() { rpm } else { 0 };
        Self {
            name: name.into(),
            key: "{client_ip}",
            rpm,
        }
    }
    fn shared(name: impl Into<String>, rpm: u32) -> Self {
        Self {
            name: name.into(),
            key: "all",
            rpm,
        }
    }
}

/// A site's `rate_limit` block (a zone at 0 rpm is off). Over the limit, the
/// module answers 429 with `Retry-After`.
///
/// No `request_body` cap next to it: measured on Caddy 2.10 behind
/// `reverse_proxy`, an oversized body reaches the upstream or fails as a 502
/// rather than a 413, and on a tenant site a 502 renders the "starting" page.
fn guard_lines(zones: &[Zone]) -> Vec<String> {
    guard_lines_with(zones, RATE_LIMIT_MODULE.load(Ordering::Relaxed))
}

fn guard_lines_with(zones: &[Zone], rate_limit_module: bool) -> Vec<String> {
    let zones: Vec<&Zone> = zones.iter().filter(|z| z.rpm > 0).collect();
    if zones.is_empty() || !rate_limit_module {
        return Vec::new();
    }
    let mut lines = vec!["rate_limit {".to_string()];
    for zone in zones {
        let per_window = zone.rpm.div_ceil(60 / RATE_WINDOW_S).max(1);
        lines.push(format!("\tzone {} {{", zone.name));
        lines.push(format!("\t\tkey {}", zone.key));
        lines.push(format!("\t\twindow {RATE_WINDOW_S}s"));
        lines.push(format!("\t\tevents {per_window}"));
        if zone.key == "{client_ip}" {
            // One IPv6 subscriber holds a whole /64: counting addresses
            // separately would let one client rotate past the limit.
            lines.push("\t\tipv6_prefix 64".into());
        }
        lines.push("\t}".into());
    }
    lines.push("}".into());
    lines
}

/// An app's effective limits: its own setting when it has one, else the
/// platform default.
fn app_zones(cfg: &Config, app: &App, limits: &[AppLimit]) -> Vec<Zone> {
    let own = limits.iter().find(|l| l.app_id == app.id);
    let pick = |own: Option<i64>, default: u32| {
        own.map_or(default, |v| u32::try_from(v.max(0)).unwrap_or(u32::MAX))
    };
    vec![
        Zone::per_client(
            cfg,
            format!("client_{}", app.slug),
            pick(own.and_then(|l| l.client_rpm), cfg.edge.client_rpm),
        ),
        Zone::shared(
            format!("app_{}", app.slug),
            pick(own.and_then(|l| l.app_rpm), cfg.edge.app_rpm),
        ),
    ]
}

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

/// One reverse-proxy site block. `tls` adds an on-demand TLS gate so the site
/// serves HTTPS with per-hostname certs (no wildcard cert needed); a tls-gated
/// site does NOT proxy plaintext :80 (empty 200s), which is what [`push_site`]
/// compensates for. Site-level extras (e.g. `rewrite`) go in the site block;
/// proxy options (e.g. `header_up`) MUST go inside `reverse_proxy` — Caddy
/// rejects them at site level and then keeps serving the stale config.
///
/// Free functions rather than closures: the environment sites (and their
/// plaintext twins) are emitted from the same `lines` buffer, and a closure
/// capturing it mutably would lock every other writer out.
fn push_block(
    lines: &mut Vec<String>,
    cfg: &Config,
    addr: &str,
    tls: bool,
    site_extra: &[&str],
    proxy_extra: &[&str],
    upstream: &str,
) {
    lines.push(format!("{addr} {{"));
    // Access log per site as JSON into the file the runner tails
    // (`CADDY_ACCESS_LOG`: one path for writer and reader, since they share
    // this container), feeding the device/path/ref breakdown. The tailer
    // bounds its size itself (host/accesslog.rs truncates after consuming), so
    // no Caddy-side rolling. Per-request lines leave `docker logs`; tail the
    // file instead.
    lines.push("\tlog {".into());
    lines.push(format!("\t\toutput file {}", cfg.caddy_access_log));
    lines.push("\t\tformat json".into());
    lines.push("\t}".into());
    // Compression, because celld does not compress an asset response and the
    // docs point at a compressing ingress proxy for clients that want gzip or
    // brotli. Measured through this edge: the control UI's content-hashed
    // bundle drops from 462 KiB to 144 KiB and its CSS from 129 KiB to 22 KiB,
    // while the `text/event-stream` log/deploy/metric endpoints stay
    // uncompressed, chunked and unbuffered (the proxy below keeps
    // `flush_interval -1`, and Caddy skips an event stream).
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
    // Bound the upstream waits, but keep the connection pool. celld answers a
    // subset of concurrent requests never at all (measured on the production
    // install: every failure is exactly the timeout below, while the ones that
    // answer take 0.55-0.88 s), and with no bound Caddy holds such a request
    // until the browser gives up — the client sees a hang rather than an error
    // it could retry. `dial_timeout` bounds a stalled connect. Pooling stays ON
    // deliberately: measured against a 0.6.0 node, an upstream per request
    // (`keepalive off`) costs ~590 ms per request where the pool costs ~11 ms,
    // because celld charges a new connection to the Worker, and it also
    // multiplies simultaneous connections to a node that is already the
    // bottleneck. `flush_interval -1` below only affects response streaming.
    lines.push("\t\ttransport http {".into());
    lines.push("\t\t\tdial_timeout 5s".into());
    lines.push("\t\t\tresponse_header_timeout 30s".into());
    lines.push("\t\t}".into());
    lines.push("\t\tflush_interval -1".into());
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());
}

/// [`push_block`] plus, behind a terminating proxy, the plaintext twin that
/// carries the same handlers in clear. Behind a proxy only: with direct TLS,
/// Caddy's own :80 → HTTPS redirect must answer instead (a `http://*.{base}`
/// twin would shadow it for every host).
fn push_site(
    lines: &mut Vec<String>,
    cfg: &Config,
    addr: &str,
    tls: bool,
    site_extra: &[&str],
    proxy_extra: &[&str],
    upstream: &str,
) {
    // `rewrite_caddy`'s own definition of "behind a terminating proxy".
    let edge_tls = !is_localhost_domain(&cfg.base_domain) && !cfg.auto_https;
    if tls && edge_tls && !addr.starts_with("http://") {
        push_block(
            lines,
            cfg,
            &plaintext_hosts(addr),
            false,
            site_extra,
            proxy_extra,
            upstream,
        );
    }
    push_block(lines, cfg, addr, tls, site_extra, proxy_extra, upstream);
}

pub async fn rewrite_caddy(
    cfg: &Config,
    apps: &[App],
    domains: &[AppDomain],
    limits: &[AppLimit],
    envs: &[EnvironmentRoute],
) -> anyhow::Result<()> {
    let local = is_localhost_domain(&cfg.base_domain);
    let plain = local || !cfg.auto_https;
    // Control plane lives on the bare domain when CONTROL_SUBDOMAIN is empty
    // (dev `noite.localhost` — the only hostname family Bitwarden's matcher
    // accepts without https) or on `{sub}.{domain}` in prod (`app`, apex stays
    // free for marketing). `http://` pins plain HTTP for dev; prod uses bare
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
    // Every public site is gated by on-demand TLS, also when Caddy terminates
    // TLS directly: since Caddy 2.10 a managed wildcard (`*.{base}`, the
    // fallback below) stops Caddy from obtaining certificates for the
    // subdomains it covers, and an on-demand wildcard is never issued — so
    // app/api/git and every tenant served no certificate at all (TLS alert
    // `internal_error`). The ask gate already admits exactly those names.
    let on_demand = !local;
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
    let mut lines = vec!["# noite (generated by the runner)".into(), "{".into()];
    // `auto_https` accepts only disable-style values — "on" is Caddy's
    // default and NOT a valid token, so the directive is emitted only when
    // HTTPS must be off (a `localhost`-family dev base, behind-proxy installs).
    if !cfg.auto_https {
        lines.push("\tauto_https off".into());
    }
    // Server-wide request bounds. `read_header` drops a client that trickles
    // its headers (slowloris) instead of holding the connection open; no
    // read/write timeout, because event streams and large uploads are
    // legitimately long. Behind a proxy, `trusted_proxies` makes
    // `{client_ip}` (the rate-limit key) the visitor, not the proxy.
    lines.push("\tservers {".into());
    lines.push("\t\ttimeouts {".into());
    lines.push("\t\t\tread_header 10s".into());
    lines.push("\t\t\tidle 2m".into());
    lines.push("\t\t}".into());
    let proxies = &cfg.edge.trusted_proxies;
    if !proxies.is_empty() {
        lines.push(format!(
            "\t\ttrusted_proxies static {}",
            proxies.ranges.join(" ")
        ));
        if proxies.cloudflare {
            lines.push("\t\tclient_ip_headers CF-Connecting-IP X-Forwarded-For".into());
        }
        lines.push("\t\ttrusted_proxies_strict".into());
    }
    lines.push("\t}".into());
    // One line per rejected request would flood `docker logs` during the
    // very attack the limit is absorbing; the access log records each 429.
    lines.push("\tlog default {".into());
    lines.push("\t\texclude http.handlers.rate_limit".into());
    lines.push("\t}".into());
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
    let edge = &cfg.edge;
    // Per-client zones vanish without a word when the edge cannot tell
    // clients apart (`guard_lines` drops every 0-rpm zone): say so loudly,
    // or an operator behind a proxy believes each client is capped while the
    // shared per-app ceiling is the only limit standing.
    if !cfg.edge_sees_clients()
        && (edge.client_rpm > 0 || limits.iter().any(|l| l.client_rpm.is_some_and(|v| v > 0)))
    {
        tracing::warn!(
            "per-client rate limits disabled: the edge sees one client IP (no trusted_proxies); \
             set trusted_proxies or rely on the per-app shared limits"
        );
    }
    // The pod assets no control site ever serves: the edge answers 404 before
    // proxying, in every mode. The worker's own `02-pod-host` gate answers 404
    // too, but Void's generated entry wraps every app response in
    // `createAssetFallback`, which retries an app 404 against `env.ASSETS` —
    // so the gate's 404 still serves the static file's 200, and the edge is
    // the real enforcement (edge.spec.ts "cross-origin isolated"). The deny is
    // origin policy, not bundle layout: the dev site (`vite dev`, no control
    // bundle) carries it as well, because dev serves the same pod files on
    // this origin — while the preview host, which serves them in dev too, is
    // untouched. `respond` with a matcher is terminal and ordered before
    // `reverse_proxy`, so these two site lines 404 exactly the six paths and
    // everything else still proxies.
    let control_deny_matcher = format!("@control_denied path {}", control_denied_assets());
    let mut control_extra =
        guard_lines(&[Zone::per_client(cfg, "client_control", edge.client_rpm)]);
    control_extra.push(control_deny_matcher.clone());
    control_extra.push("respond @control_denied 404".into());
    // The control worker keys its own auth limits on the right-most
    // X-Forwarded-For entry. Behind a trusted proxy Caddy appends the
    // proxy's address there, so hand the worker the resolved visitor instead.
    let control_proxy: Vec<String> = if edge.trusted_proxies.is_empty() {
        Vec::new()
    } else {
        vec!["header_up X-Forwarded-For {client_ip}".into()]
    };
    let control_extra_refs: Vec<&str> = control_extra.iter().map(String::as_str).collect();
    let control_proxy_refs: Vec<&str> = control_proxy.iter().map(String::as_str).collect();
    push_site(
        &mut lines,
        cfg,
        // Per-host scheme mapping is handled inside `push_site`, so the joined
        // control list needs no special casing here.
        &control_site,
        on_demand,
        &control_extra_refs,
        &control_proxy_refs,
        &cfg.caddy_control_upstream,
    );
    // Plaintext loopback for container healthchecks, independent of TLS mode.
    // It proxies the same control upstream, so it carries the same deny.
    let loopback_deny = [control_deny_matcher.as_str(), "respond @control_denied 404"];
    push_site(
        &mut lines,
        cfg,
        "http://127.0.0.1",
        false,
        &loopback_deny,
        &[],
        &cfg.caddy_control_upstream,
    );
    // Tenants serve under every DNS base (dev `noite.localhost` plus LAN names
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
            // The Code mode Preview panel frames production for the default
            // branch, so a frame load gets the same opt-in an environment
            // site carries (see `PRODUCTION_FRAME_HEADERS`).
            let mut extra: Vec<String> = PRODUCTION_FRAME_HEADERS
                .iter()
                .map(|l| (*l).to_string())
                .collect();
            extra.extend(tenant_site_extra(cfg, app));
            extra.extend(guard_lines(&app_zones(cfg, app, limits)));
            let extra: Vec<&str> = extra.iter().map(String::as_str).collect();
            push_site(
                &mut lines,
                cfg,
                &addr_of(&format!("{}.{}", app.slug, base)),
                on_demand,
                &extra,
                tenant_proxy(app),
                &upstream,
            );
        }
    }
    // Custom hostnames (app_domain): one site per *verified* name, routed to
    // its app's port. Same rule as the tenant sites — a stopped or
    // never-deployed app gets no route, so the request lands on the wildcard
    // fallback page instead of a dead upstream (host/edge.rs resolves custom
    // hosts there too). A pending (unverified) claim gets no site at all:
    // no route, and the ask gate mints no certificate for it.
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
        if app.is_stopped() || !app.is_deployed() {
            continue;
        }
        let upstream = format!("{}:{}", cfg.caddy_upstream_host, port);
        let mut extra = tenant_site_extra(cfg, app);
        extra.extend(guard_lines(&app_zones(cfg, app, limits)));
        let extra: Vec<&str> = extra.iter().map(String::as_str).collect();
        push_site(
            &mut lines,
            cfg,
            &addr_of(&domain.hostname),
            on_demand,
            &extra,
            tenant_proxy(app),
            &upstream,
        );
    }

    // Preview environments (ROADMAP, Preview environments → Phase 2): one
    // site per environment at `<label>.<slug>.<base>`, routed to that
    // environment's own fleet port, under every tenant base. `main` is the app
    // itself and never an environment, so no host here can collide with a
    // tenant host (`parse_edge_slug` refuses a dotted slug) or with the pod
    // host (one label deeper).
    //
    // Same rate-limit zones as the app — an environment is the same app's
    // traffic and the caps are per app — the same trace header and the same
    // wake-on-request hop; members-only environments (the default) additionally
    // put the access gate in front (host/env_gate.rs).
    let env_fallback = {
        let mut extra = guard_lines(&[Zone::per_client(cfg, "client_fallback", edge.client_rpm)]);
        extra.push("rewrite * /v1/edge/fallback".into());
        extra
    };
    let env_fallback: Vec<&str> = env_fallback.iter().map(String::as_str).collect();
    for base in cfg.tenant_bases() {
        for env in envs {
            let Some(app) = apps.iter().find(|a| a.id == env.app_id) else {
                continue;
            };
            let live = crate::host::edge::env_live(env);
            let addr = addr_of(&format!("{}.{}.{}", env.label, app.slug, base));
            // Site-level lines, in the order they are written: the frameable
            // header, then (live) the trace + retry page or (parked) the
            // rewrite to the runner's page, then the app's rate-limit zones.
            let mut extras: Vec<String> = FRAME_HEADERS.iter().map(|l| (*l).to_string()).collect();
            if live {
                extras.extend(fleet_site_extra());
            } else {
                extras.push("rewrite * /v1/edge/fallback".into());
            }
            extras.extend(guard_lines(&app_zones(cfg, app, limits)));
            let shape = EnvShape {
                live,
                gated: !env.public,
                asleep: env.asleep_since.is_some(),
                proxy: if !live {
                    &[]
                } else if env.asleep_since.is_some() {
                    TENANT_PROXY_WAKE
                } else {
                    TENANT_PROXY
                },
            };
            // A parked environment has no fleet of its own to proxy to; the
            // runner answers on the same host.
            let upstream = match env.listen_port {
                Some(port) if live => format!("{}:{}", cfg.caddy_upstream_host, port),
                _ => cfg.caddy_api_upstream.clone(),
            };
            // Behind a terminating proxy the same plaintext twin a tenant site
            // gets: a tls-gated site answers :80 with empty 200s, so the twin
            // carries the same handlers in clear (gate and `/__noite/auth`
            // included — the browser is admitted on the http origin it was
            // redirected to).
            if on_demand && edge_tls && !addr.starts_with("http://") {
                push_env_block(
                    &mut lines,
                    cfg,
                    &plaintext_hosts(&addr),
                    false,
                    &extras,
                    &shape,
                    &upstream,
                );
            }
            push_env_block(
                &mut lines, cfg, &addr, on_demand, &extras, &shape, &upstream,
            );
        }
        // Every label under an app that owns an environment resolves: one no
        // environment owns (a deleted environment, a typo) answers the runner's
        // page instead of Caddy's empty 404, exactly like the tenant wildcard.
        for app in apps {
            if !envs.iter().any(|env| env.app_id == app.id) {
                continue;
            }
            push_site(
                &mut lines,
                cfg,
                &addr_of(&format!("*.{}.{}", app.slug, base)),
                on_demand,
                &env_fallback,
                &[],
                &cfg.caddy_api_upstream,
            );
        }
    }

    // API → runner (Bearer-protected REST)
    let api_guard = guard_lines(&[Zone::per_client(cfg, "client_api", edge.client_rpm)]);
    let api_guard: Vec<&str> = api_guard.iter().map(String::as_str).collect();
    push_site(
        &mut lines,
        cfg,
        &addr_of(&format!("api.{}", cfg.base_domain)),
        on_demand,
        &api_guard,
        &[],
        &cfg.caddy_api_upstream,
    );

    // Git smart-HTTP → runner `/v1/git/{slug}/…` (Basic auth inside runner)
    let mut git_extra = guard_lines(&[Zone::per_client(cfg, "client_git", edge.git_rpm)]);
    git_extra.push("rewrite * /v1/git{uri}".into());
    let git_extra: Vec<&str> = git_extra.iter().map(String::as_str).collect();
    push_site(
        &mut lines,
        cfg,
        &addr_of(&format!("git.{}", cfg.base_domain)),
        on_demand,
        &git_extra,
        &[],
        &cfg.caddy_api_upstream,
    );

    // Fallback: unknown slugs + stopped apps → runner edge page (per-Host,
    // on every tenant base). Tenant TLS is minted on demand (ask-gated), so
    // no wildcard cert or DNS-challenge module is needed on any platform.
    // Random subdomains land here, and each is a runner lookup: the same
    // per-client budget as a site.
    let mut fallback_extra =
        guard_lines(&[Zone::per_client(cfg, "client_fallback", edge.client_rpm)]);
    fallback_extra.push("rewrite * /v1/edge/fallback".into());
    let fallback_extra: Vec<&str> = fallback_extra.iter().map(String::as_str).collect();
    for base in cfg.tenant_bases() {
        push_site(
            &mut lines,
            cfg,
            &addr_of(&format!("*.{base}")),
            on_demand,
            &fallback_extra,
            &[],
            &cfg.caddy_api_upstream,
        );
    }

    // Preview: one *stable* host per app, `<PREVIEW_LABEL>.preview.<slug>.<base>`,
    // serving ONLY the pod's own assets (the pod host document and its bundle,
    // Nodepod's worker and service worker, and the `/assets/*` chunks the frame
    // bundle loads) from the control deployment, so guest code never runs on
    // the control UI's origin — it runs *here*, in the pod host document's own
    // agent cluster; every other path 404s. Stable
    // on purpose: on-demand TLS then issues one certificate per app, not one per
    // preview session. `preview.<slug>.<base>` is one extra label under the
    // instance wildcard (no new DNS, the same on-demand TLS) and can never be a
    // tenant host — `parse_edge_slug` rejects a slug containing a dot. Preview
    // needs no fleet, so it is emitted for every app, deployed or not.
    let preview_guard = guard_lines(&[Zone::per_client(cfg, "client_preview", edge.client_rpm)]);
    for base in cfg.tenant_bases() {
        for app in apps {
            // Any other label under the app's preview suffix answers 404, and
            // plaintext-only so it never asks Caddy for a certificate. The
            // exact host below is more specific, so it still wins.
            lines.push(format!("http://*.preview.{}.{} {{", app.slug, base));
            lines.push("\trespond 404".into());
            lines.push("}".into());
            lines.push(String::new());
            let addr = addr_of(&format!(
                "{}.preview.{}.{}",
                crate::host::edge::PREVIEW_LABEL,
                app.slug,
                base
            ));
            // Behind a terminating proxy the same plaintext twin a tenant site
            // gets, so a preview host is reachable on :80 too.
            if on_demand && edge_tls && !addr.starts_with("http://") {
                push_preview_block(
                    &mut lines,
                    cfg,
                    &plaintext_hosts(&addr),
                    false,
                    &preview_guard,
                    &control_proxy,
                    &cfg.caddy_control_upstream,
                );
            }
            push_preview_block(
                &mut lines,
                cfg,
                &addr,
                on_demand,
                &preview_guard,
                &control_proxy,
                &cfg.caddy_control_upstream,
            );
        }
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
    tokio::fs::write(path, &next).await?;
    tracing::info!(path = %cfg.caddyfile_path, n = apps.len(), "caddyfile updated");
    // POST the changed config to Caddy's admin (127.0.0.1:2019). A non-2xx
    // is logged with Caddy's body and surfaced in /ready; the previous config
    // keeps serving (Caddy applies loads atomically). `--watch` on the file
    // above applies it too, so a Caddy that is still starting loses nothing.
    load_admin(cfg, &next).await;
    Ok(())
}

/// The dead Nodepod preview bridge (document + script): never created by this
/// build, but still emitted into the client bundle — and a bridge document is
/// a registerable service worker on whatever origin serves it, so neither the
/// preview host nor any control site serves it. Must match `POD_BRIDGE_PATHS`
/// in `apps/noite/src/lib/preview-host.ts`.
const POD_BRIDGE_ASSETS: &str = "/__nodepod_bridge__.html /__nodepod_bridge__.js";

/// The only paths a preview origin serves (everything else 404s): the pod's
/// own files below plus the `/assets/*` chunks the frame bundle loads at
/// runtime (Vite's own runtime and preload helper, and any module it shares
/// with the control UI). The pod paths here must match `PREVIEW_HOST_ASSETS`
/// in `apps/noite/src/lib/preview-host.ts`. The dev image has no control
/// bundle and takes the plain proxy branch below instead.
const PREVIEW_ASSETS: &str = concat!(
    "/noite-pod-host.html /noite-pod-host.js ",
    "/__sw__.js /__worker__.js ",
    "/assets/*"
);

/// Every path a control site answers 404 for: the preview host's pod assets
/// minus the frame chunks (on this origin `/assets/*` is the control UI's own
/// bundle, served exactly as before), plus the dead bridge pair. Derived from
/// `PREVIEW_ASSETS` so the pod paths live in one place on this side too; the
/// result must match `CONTROL_HOST_DENIED_ASSETS` in
/// `apps/noite/src/lib/preview-host.ts` (a test below pins the shape).
fn control_denied_assets() -> String {
    let mut denied: Vec<&str> = PREVIEW_ASSETS
        .split_whitespace()
        .filter(|p| *p != "/assets/*")
        .collect();
    denied.extend(POD_BRIDGE_ASSETS.split_whitespace());
    denied.join(" ")
}

/// One app's preview host: the host document and those Nodepod assets proxied
/// from the control deployment with the headers their document, workers and
/// service worker need, and a 404 for every other path, so a guest app can
/// never reach the control UI.
fn push_preview_block(
    lines: &mut Vec<String>,
    cfg: &Config,
    addr: &str,
    tls: bool,
    guard: &[String],
    proxy_extra: &[String],
    upstream: &str,
) {
    lines.push(format!("{addr} {{"));
    lines.push("\tlog {".into());
    lines.push(format!("\t\toutput file {}", cfg.caddy_access_log));
    lines.push("\t\tformat json".into());
    lines.push("\t}".into());
    lines.push("\tencode zstd gzip".into());
    if tls {
        lines.push("\ttls {".into());
        lines.push("\t\ton_demand".into());
        lines.push("\t}".into());
    }
    for line in guard {
        lines.push(format!("\t{line}"));
    }
    // The dev image carries no control bundle (`bundle_present`): `vite dev`
    // answers this host — the pod's document, its module graph and Nodepod's
    // assets — so the site is a plain proxy. Matchers would have to enumerate
    // the dev server's own URL space (`/src/*`, the prebundled deps,
    // `/@fs/*`, Vite's client), and a preview that 404s one of those never
    // boots. Production takes the matcher path below: there the deployment's
    // assets are the whole answer, and every path but the pod's own is a 404
    // by design.
    if !crate::host::control::bundle_present(cfg) {
        lines.push(format!("\treverse_proxy {upstream} {{"));
        for line in proxy_extra {
            lines.push(format!("\t\t\t{line}"));
        }
        lines.push("\t\t\ttransport http {".into());
        lines.push("\t\t\t\tdial_timeout 5s".into());
        lines.push("\t\t\t\tresponse_header_timeout 30s".into());
        lines.push("\t\t\t}".into());
        lines.push("\t\t\tflush_interval -1".into());
        lines.push("\t\t}".into());
        lines.push("}".into());
        lines.push(String::new());
        return;
    }
    // `handle` blocks are exclusive: the asset matcher wins, everything else
    // 404s. Per-path headers use matchers, and every block is `defer`red so the
    // operation runs after the upstream response — a plain `header` would
    // *append* to a value the control deployment already set (two
    // `Cross-Origin-Resource-Policy` lines make browsers refuse the frame).
    lines.push(format!("\t@nodepod path {PREVIEW_ASSETS}"));
    lines.push("\thandle @nodepod {".into());
    lines.push("\t\t@sw path /__sw__.js".into());
    lines.push("\t\theader @sw {".into());
    lines.push("\t\t\tdefer".into());
    lines.push("\t\t\tService-Worker-Allowed /".into());
    lines.push("\t\t\tCache-Control no-cache".into());
    lines.push("\t\t}".into());
    // The control UI embeds the pod host document, and the document's *workers*
    // keep their `SharedArrayBuffer` only in a cross-origin-isolated agent
    // cluster, so the document must be frameable (`cross-origin`) *and*
    // isolated (`require-corp` + `same-origin`).
    lines.push("\t\t@hostframe path /noite-pod-host.html /noite-pod-host.js".into());
    lines.push("\t\theader @hostframe {".into());
    lines.push("\t\t\tdefer".into());
    lines.push("\t\t\tCross-Origin-Resource-Policy cross-origin".into());
    lines.push("\t\t\tCross-Origin-Embedder-Policy require-corp".into());
    lines.push("\t\t\tCross-Origin-Opener-Policy same-origin".into());
    lines.push("\t\t\tCache-Control no-store".into());
    lines.push("\t\t}".into());
    lines.push(format!("\t\treverse_proxy {upstream} {{"));
    for line in proxy_extra {
        lines.push(format!("\t\t\t{line}"));
    }
    lines.push("\t\t\ttransport http {".into());
    lines.push("\t\t\t\tdial_timeout 5s".into());
    lines.push("\t\t\t\tresponse_header_timeout 30s".into());
    lines.push("\t\t\t}".into());
    lines.push("\t\t\tflush_interval -1".into());
    lines.push("\t\t}".into());
    lines.push("\t}".into());
    lines.push("\thandle {".into());
    lines.push("\t\trespond 404".into());
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());
}

/// Site-level header lines every environment site carries: the Code mode page
/// is cross-origin-isolated (`COEP: require-corp`), so it can only frame a
/// document that opted in — `Cross-Origin-Resource-Policy` for the embed, and
/// a COEP of its own on the framed document. The COEP is `credentialless` and
/// only on frame loads (`Sec-Fetch-Dest: iframe`): the app's cross-origin
/// subresources still load (without credentials) inside the frame, and a
/// top-level visit gets no COEP at all. `defer` *replaces* rather than
/// appends — two `Cross-Origin-Resource-Policy` lines make a browser refuse
/// the frame. Plus [`PREVIEW_DEST`].
const FRAME_HEADERS: &[&str] = &[
    "header {",
    "\tdefer",
    "\tCross-Origin-Resource-Policy same-site",
    "}",
    "@noite_framed header Sec-Fetch-Dest iframe",
    "header @noite_framed {",
    "\tdefer",
    "\tCross-Origin-Embedder-Policy credentialless",
    "}",
    PREVIEW_DEST[0],
    PREVIEW_DEST[1],
    PREVIEW_DEST[2],
    PREVIEW_DEST[3],
    PREVIEW_DEST[4],
];

/// The Preview panel's frame reaches the app as a top-level page load. The
/// browser marks a framed load `Sec-Fetch-Dest: iframe`, and a server that
/// renders only `document` navigations (the control worker, for one)
/// answers the frame with its own 404 while the same URL renders in a tab. A
/// same-site frame — the control UI framing it — is rewritten to `document`
/// on the way upstream; a cross-site embedder's request is left as sent.
/// Only the request changes: the app's own framing headers (X-Frame-Options,
/// CSP `frame-ancestors`) still decide whether the browser shows it. Caddy
/// runs `header` before `request_header`, so `@noite_framed` above still
/// sees `iframe`.
const PREVIEW_DEST: [&str; 5] = [
    "@noite_preview {",
    "\theader Sec-Fetch-Dest iframe",
    "\theader Sec-Fetch-Site same-site",
    "}",
    "request_header @noite_preview Sec-Fetch-Dest document",
];

/// [`FRAME_HEADERS`] for a production tenant site, frame loads only: the Code
/// mode Preview panel frames production for the default branch, and its
/// cross-origin-isolated page refuses a frame without both headers. Production
/// keeps its own `Cross-Origin-Resource-Policy` everywhere else, so another
/// site embedding the app's images or scripts behaves as before. Plus
/// [`PREVIEW_DEST`].
const PRODUCTION_FRAME_HEADERS: &[&str] = &[
    "@noite_framed header Sec-Fetch-Dest iframe",
    "header @noite_framed {",
    "\tdefer",
    "\tCross-Origin-Resource-Policy same-site",
    "\tCross-Origin-Embedder-Policy credentialless",
    "}",
    PREVIEW_DEST[0],
    PREVIEW_DEST[1],
    PREVIEW_DEST[2],
    PREVIEW_DEST[3],
    PREVIEW_DEST[4],
];

/// What one environment's site must do, all of it from the environment row —
/// never from the request.
struct EnvShape<'a> {
    /// Deployed and desired running: its own fleet serves it.
    live: bool,
    /// Members-only (the default): the access gate in front.
    gated: bool,
    /// Parked by scale-to-zero: the request wakes the fleet first.
    asleep: bool,
    /// `reverse_proxy` health/retry options for a live fleet.
    proxy: &'a [&'a str],
}

/// One environment's site (`<label>.<slug>.<base>`).
///
/// A live site reuses the tenant shape — the same rate-limit zones, the trace
/// header, the fleet-ready gate — plus [`FRAME_HEADERS`]. A members-only
/// environment puts the access gate in front: `/__noite/auth` is served by the
/// runner itself (the token the control UI hands back), and every other path
/// goes through `forward_auth /v1/edge/env-gate`. Both branches are `handle`
/// blocks, and Caddy runs at most one sibling `handle`, so a request never
/// reaches both the gate and the app.
///
/// A parked environment (never deployed, or stopped) keeps its host — the
/// certificate is per environment — and answers the runner's page instead of a
/// dead upstream.
fn push_env_block(
    lines: &mut Vec<String>,
    cfg: &Config,
    addr: &str,
    tls: bool,
    site_extra: &[String],
    shape: &EnvShape,
    upstream: &str,
) {
    lines.push(format!("{addr} {{"));
    lines.push("\tlog {".into());
    lines.push(format!("\t\toutput file {}", cfg.caddy_access_log));
    lines.push("\t\tformat json".into());
    lines.push("\t}".into());
    lines.push("\tencode zstd gzip".into());
    if tls {
        lines.push("\ttls {".into());
        lines.push("\t\ton_demand".into());
        lines.push("\t}".into());
    }
    for line in site_extra {
        lines.push(format!("\t{line}"));
    }
    if !shape.live {
        lines.push(format!("\treverse_proxy {upstream} {{"));
        lines.push("\t\ttransport http {".into());
        lines.push("\t\t\tdial_timeout 5s".into());
        lines.push("\t\t\tresponse_header_timeout 30s".into());
        lines.push("\t\t}".into());
        lines.push("\t\tflush_interval -1".into());
        lines.push("\t}".into());
        lines.push("}".into());
        lines.push(String::new());
        return;
    }
    if shape.gated {
        // The runner owns this path: it verifies the token the control UI
        // redirects with, sets the gate cookie and 302s to the return path. It
        // must never be proxied to the app, and it must never be gated.
        lines.push(format!("\thandle {}* {{", crate::host::env_gate::AUTH_PATH));
        lines.push("\t\trewrite * /v1/edge/env-auth".into());
        lines.push(format!("\t\treverse_proxy {} {{", cfg.caddy_api_upstream));
        lines.push("\t\t\ttransport http {".into());
        lines.push("\t\t\t\tdial_timeout 5s".into());
        lines.push("\t\t\t\tresponse_header_timeout 30s".into());
        lines.push("\t\t\t}".into());
        lines.push("\t\t}".into());
        lines.push("\t}".into());
    }
    lines.push("\thandle {".into());
    // `route` keeps the written order: the gate reads the cookie, the strip
    // removes it, the fleet never sees it. A plain directive list would sort
    // `map`/`request_header` *before* `forward_auth` and the gate would never
    // find the cookie it just set.
    lines.push("\t\troute {".into());
    if shape.gated {
        // Members-only: every request is admitted by the runner's gate (and a
        // gate that admits an asleep environment wakes it, so a members-only
        // site needs no second hop — and an unauthenticated visitor never
        // spawns a fleet).
        push_forward_auth(lines, cfg, "/v1/edge/env-gate", "\t\t\t");
        for line in COOKIE_STRIP {
            lines.push(format!("\t\t\t{line}"));
        }
    } else if shape.asleep {
        push_forward_auth(lines, cfg, "/v1/edge/wake", "\t\t\t");
    }
    lines.push(format!("\t\t\treverse_proxy {upstream} {{"));
    for line in shape.proxy {
        lines.push(format!("\t\t\t\t{line}"));
    }
    lines.push("\t\t\t\ttransport http {".into());
    lines.push("\t\t\t\t\tdial_timeout 5s".into());
    lines.push("\t\t\t\t\tresponse_header_timeout 30s".into());
    lines.push("\t\t\t\t}".into());
    lines.push("\t\t\t\tflush_interval -1".into());
    lines.push("\t\t\t}".into());
    lines.push("\t\t}".into());
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());
}

/// Removes the gate's own cookie from the request before it reaches the app
/// (ROADMAP: "the gate strips its own cookie and path before the request
/// reaches the app"). Caddy can only address the whole `Cookie` field, so this
/// is a `map` over that header covering the three shapes the cookie can take —
/// first, middle, last — with the input itself as the `default`, which leaves
/// every other cookie (and an app with no cookies at all) exactly as it was.
///
/// These lines must run *after* `forward_auth` (the gate reads the cookie) and
/// *before* the fleet, which is why they live in a `route` block: it is the one
/// Caddyfile construct that keeps the order it is written in.
const COOKIE_STRIP: &[&str] = &[
    "map {http.request.header.Cookie} {noite_env_cookie} {",
    "\t~^__noite_env=[^;]*;?\\s*(.*)$ ${1}",
    "\t~^(.*)__noite_env=[^;]*;\\s*(.*)$ ${1}${2}",
    "\t~^(.*);\\s*__noite_env=[^;]*$ ${1}",
    "\tdefault {http.request.header.Cookie}",
    "}",
    "request_header Cookie {noite_env_cookie}",
];

/// Proxy options for a tenant fleet. celld answers its public
/// `/.well-known/celld/health` 503 until its ready gate opens (memory
/// headroom, a live lease, ownership settled: up to `CELLD_READY_FLEET_GATE_MS`,
/// 120 s), and a request routed before that reaches cells it cannot place yet
/// (D1 calls fail with `CapacityExhausted`). Caddy checks the health route on
/// config load and every second after, and while a fleet is not ready holds a
/// request for up to `lb_try_duration` before giving up; a ready fleet is
/// proxied with no added wait. POSTs are safe: a held request is never sent.
const TENANT_PROXY: &[&str] = &[
    "health_uri /.well-known/celld/health",
    "health_interval 1s",
    "health_timeout 2s",
    "lb_try_duration 20s",
    "lb_try_interval 250ms",
];

/// Site-level answer when a fleet stays unready past `lb_try_duration` (503)
/// or refuses the connection while it restarts (502): a page that retries by
/// itself, and `Retry-After` for API clients, instead of Caddy's empty error.
/// celld's own 503s (load shedding) are responses, not errors, and pass
/// through unchanged.
/// Trace id per tenant request, from the request's UUID with the dashes
/// dropped (32 hex = a W3C trace id; the last 16 double as the parent span
/// id). Not Caddy's `tracing` directive: that one always runs an OTLP
/// exporter (it dials 127.0.0.1:4317 every few seconds, whatever
/// `OTEL_TRACES_EXPORTER` says), and an always-off sampler would mark the
/// trace unsampled, which celld's parent-based sampler honours by recording
/// nothing. `request_header` replaces any client-sent `traceparent`, so a
/// client cannot pick the id an error is filed under.
const TENANT_TRACE: &[&str] = &[
    "map {http.request.uuid} {noite_trace} {noite_span} {",
    "\t~^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$ \"${1}${2}${3}${4}${5}\" \"${4}${5}\"",
    "}",
    "request_header traceparent \"00-{noite_trace}-{noite_span}-01\"",
    "log_append traceID {noite_trace}",
];

const TENANT_STARTING: &[&str] = &[
    "handle_errors 502 503 {",
    "\theader Retry-After 5",
    "\theader Cache-Control no-store",
    "\theader Content-Type \"text/html; charset=utf-8\"",
    "\trespond `<!doctype html><meta http-equiv=\"refresh\" content=\"5\"><title>Starting</title><p>This app is starting. The page reloads by itself.</p>` 503",
    "}",
];

/// Proxy options for an asleep app's sites: no active health checks. While
/// the fleet is parked the checker marks it down, and a held request that
/// `forward_auth` releases would meet that stale "unhealthy" state (then the
/// starting page) — measured on the dev stack. The wake hop already waited
/// for celld's health route to answer 200, so the fleet is ready by
/// construction; `lb_try_*` still retries a transient dial failure.
const TENANT_PROXY_WAKE: &[&str] = &["lb_try_duration 20s", "lb_try_interval 250ms"];

fn tenant_proxy(app: &App) -> &'static [&'static str] {
    if app.is_asleep() {
        TENANT_PROXY_WAKE
    } else {
        TENANT_PROXY
    }
}

/// Site-level lines every fleet site shares: the W3C `traceparent` celld
/// adopts as its span's trace id (the access log records the same `traceID`, so
/// the error ingest joins an exception to its method, path and status —
/// host/errors.rs), and the retry page a fleet that stays unready answers.
fn fleet_site_extra() -> Vec<String> {
    let mut lines: Vec<String> = TENANT_TRACE.iter().map(|l| (*l).to_string()).collect();
    lines.extend(TENANT_STARTING.iter().map(|l| (*l).to_string()));
    lines
}

/// `forward_auth` hop into the runner, indented for its site or handle block.
///
/// Caddy holds the original request (body included) while the hop runs and
/// proxies it unchanged when the hop answers 200; any other status — the
/// gate's 302, a failed wake's 503 — is copied back to the visitor. The header
/// timeout sits above the runner's own wake budget, so Caddy never gives up
/// first. The trace header above covers the wake case too: a held request
/// carries no trace of its own until it is released.
fn push_forward_auth(lines: &mut Vec<String>, cfg: &Config, uri: &str, indent: &str) {
    lines.push(format!(
        "{indent}forward_auth {} {{",
        cfg.caddy_api_upstream
    ));
    lines.push(format!("{indent}\turi {uri}"));
    lines.push(format!("{indent}\ttransport http {{"));
    lines.push(format!(
        "{indent}\t\tresponse_header_timeout {}s",
        cfg.wake_timeout_s.max(1) + 15
    ));
    lines.push(format!("{indent}\t}}"));
    lines.push(format!("{indent}}}"));
}

/// Site-level lines for a tenant or custom-domain site. An asleep app
/// (SPEC, Scale to zero) keeps its route but gains a `forward_auth` hop:
/// Caddy holds the original request (body included) while the runner's
/// `/v1/edge/wake` spawns the fleet and waits for its health gate, then
/// proxies it as if the app had never slept. The header timeout sits above
/// the runner's own wake budget, so Caddy never gives up first.
///
/// Every tenant request also carries a W3C `traceparent` that celld adopts
/// as its span's trace id, and the access log records the same `traceID`:
/// the error ingest joins an exception to its method, path and status that
/// way (host/errors.rs).
fn tenant_site_extra(cfg: &Config, app: &App) -> Vec<String> {
    let mut lines = fleet_site_extra();
    if app.is_asleep() {
        push_forward_auth(&mut lines, cfg, "/v1/edge/wake", "\t");
    }
    lines
}

static CADDY_ADMIN_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static CADDY_ADMIN_ERR: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

/// Last admin-load result for /ready.
pub fn admin_status() -> (bool, String) {
    let ok = CADDY_ADMIN_OK.load(std::sync::atomic::Ordering::Relaxed);
    let detail = CADDY_ADMIN_ERR
        .get()
        .map(|m| m.lock().map(|s| s.clone()).unwrap_or_default())
        .unwrap_or_default();
    (ok, detail)
}

fn admin_note(ok: bool, detail: String) {
    CADDY_ADMIN_OK.store(ok, std::sync::atomic::Ordering::Relaxed);
    if let Some(m) = CADDY_ADMIN_ERR.get() {
        if let Ok(mut g) = m.lock() {
            *g = detail;
        }
    } else {
        let _ = CADDY_ADMIN_ERR.set(std::sync::Mutex::new(detail));
    }
}

async fn load_admin(cfg: &Config, caddyfile: &str) {
    let url = format!("{}/load", cfg.caddy_admin_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    match client
        .post(&url)
        .header("Content-Type", "text/caddyfile")
        .body(caddyfile.to_string())
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            admin_note(true, String::new());
        }
        Ok(resp) => {
            // Connection worked but Caddy rejected the config: real problem.
            // Distinguish "nothing listening" (connection error below) from
            // a bad config by only marking unhealthy on HTTP responses.
            let code = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let tail = body.chars().take(500).collect::<String>();
            admin_note(false, format!("caddy /load {code}: {tail}"));
            tracing::warn!(%code, body = %tail, "caddy admin load rejected config");
        }
        Err(e) => {
            // Caddy is (re)starting under supervision; it reads the file on
            // start, so this is not a failure.
            tracing::debug!(error = %e, "caddy admin not reachable yet");
        }
    }
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
            fleet_port_min: 20000,
            fleet_port_max: 29999,
            poll_ms: 5000,
            tip_sweep_s: 60,
            caddy_upstream_host: "127.0.0.1".into(),
            http_port: 9080,
            https_port: 9443,
            auto_https,
            caddy_control_upstream: "127.0.0.1:8090".into(),
            caddy_api_upstream: "127.0.0.1:8080".into(),
            caddy_admin_url: "http://127.0.0.1:2019".into(),
            git_public_base: format!("https://git.{base}"),
            caddy_access_log: "/data/caddy/access.log".into(),
            fleet_log: "error,celld=warn".into(),
            max_apps_per_user: 10,
            fleet_max_rss_mb: 0,
            max_environments_per_app: 5,
            max_environments: 25,
            environment_ttl_h: 168,
            fleet_idle_evict_s: 300,
            fleet_deploy_poll_s: 300,
            sleep_after_h: 24,
            sleep_sweep_s: 3600,
            wake_timeout_s: 120,
            fleet_asset_cache_mb: 64,
            tenancy: crate::config::Tenancy::Single,
            stop_budget_ms: 25000,
            build_max_mb: 2048,
            build_cache_mb: 512,
            build_timeout_s: 300,
            telemetry_retention_days: 14,
            otel_flush_ms: 30_000,
            build_uid_base: None,
            build_uid_range: crate::config::BUILD_UID_RANGE,
            fleet_uid: None,
            fleet_gid: None,
            control_bundle_dir: "/opt/noite/control/dist".into(),
            better_auth_url: "".into(),
            edge: crate::config::EdgeLimits::default(),
            telemetry_disabled: false,
            do_not_track: false,
            env_problems: Vec::new(),
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
            asleep_since: None,
            woke_at: None,
            deployed_config: None,
            import_source: None,
            imported: false,
        }
    }

    fn test_domain(app_id: &str, hostname: &str) -> AppDomain {
        AppDomain {
            app_id: app_id.into(),
            hostname: hostname.into(),
            status: crate::models::DOMAIN_STATUS_VERIFIED.into(),
            token: "tok".into(),
            verified_at: Some("2026-09-15T00:00:00Z".into()),
            created_at: "2026-09-15T00:00:00Z".into(),
        }
    }

    fn test_pending_domain(app_id: &str, hostname: &str) -> AppDomain {
        AppDomain {
            status: crate::models::DOMAIN_STATUS_PENDING.into(),
            verified_at: None,
            ..test_domain(app_id, hostname)
        }
    }

    async fn rendered(cfg: &Config, apps: &[App]) -> String {
        rendered_with(cfg, apps, &[]).await
    }

    async fn rendered_with(cfg: &Config, apps: &[App], domains: &[AppDomain]) -> String {
        rendered_envs(cfg, apps, domains, &[]).await
    }

    async fn rendered_envs(
        cfg: &Config,
        apps: &[App],
        domains: &[AppDomain],
        envs: &[EnvironmentRoute],
    ) -> String {
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
        rewrite_caddy(cfg, apps, domains, &[], envs)
            .await
            .expect("rewrite");
        tokio::fs::read_to_string(&cfg.caddyfile_path)
            .await
            .expect("read back")
    }

    /// One environment route, deployed and members-only unless a test says
    /// otherwise (its own fleet on 127.0.0.1:8200).
    fn test_env(app: &App, label: &str) -> EnvironmentRoute {
        EnvironmentRoute {
            id: format!("env-{label}"),
            app_id: app.id.clone(),
            app_slug: app.slug.clone(),
            label: label.into(),
            listen_port: Some(8200),
            public: false,
            desired_state: "running".into(),
            asleep_since: None,
            last_deployed_at: Some("2026-10-13T00:00:00Z".into()),
        }
    }

    #[tokio::test]
    async fn preview_sites_serve_only_the_nodepod_assets() {
        let mut cfg = test_config("noite.now", "app", true, "/tmp/noite-test-preview");
        // The production shape: a control bundle is present (`bundle_present`),
        // so the preview site takes the asset matcher, not the dev proxy.
        cfg.control_bundle_dir = "/tmp/noite-test-preview-bundle".into();
        std::fs::create_dir_all(Path::new(&cfg.control_bundle_dir)).expect("bundle dir");
        std::fs::write(
            Path::new(&cfg.control_bundle_dir).join("wrangler.json"),
            "{}",
        )
        .expect("bundle marker");
        let out = rendered(&cfg, &[test_app()]).await;
        let addr = "app-0.preview.test.noite.now";
        let start = out
            .find(&format!("\n{addr} {{"))
            .unwrap_or_else(|| panic!("no site {addr}:\n{out}"));
        let rest = &out[start + 1..];
        let block = rest[..rest.find("\n}\n").expect("site end")].to_string();
        // Only the pod's own paths come from the control deployment: the pod
        // host document and bundle, Nodepod's worker and service worker, and
        // the frame bundle's own chunks under `/assets/`.
        assert!(
            block.contains("reverse_proxy 127.0.0.1:8090"),
            "preview must proxy the control upstream:\n{block}"
        );
        for path in [
            "/noite-pod-host.html",
            "/noite-pod-host.js",
            "/__sw__.js",
            "/__worker__.js",
            "/assets/*",
        ] {
            assert!(block.contains(path), "{addr} misses {path}:\n{block}");
        }
        assert!(block.contains("respond 404"), "{block}");
        // Headers the service worker needs, exactly.
        assert!(block.contains("Service-Worker-Allowed /"), "{block}");
        assert!(block.contains("Cache-Control no-cache"), "{block}");
        // The pod host document is embedded by the control UI and its process
        // workers keep `SharedArrayBuffer`: frameable cross-origin, isolated
        // itself.
        assert!(
            block.contains("@hostframe path /noite-pod-host.html /noite-pod-host.js"),
            "{block}"
        );
        assert!(
            block.contains("Cross-Origin-Embedder-Policy require-corp"),
            "{block}"
        );
        assert!(
            block.contains("Cross-Origin-Opener-Policy same-origin\n"),
            "{block}"
        );
        assert!(
            block.contains("Cross-Origin-Resource-Policy cross-origin"),
            "{block}"
        );
        assert!(block.contains("Cache-Control no-store"), "{block}");
        // Deferred, so they replace what the control deployment set: a plain
        // `header` appends in Caddy 2.10, and a duplicated
        // Cross-Origin-Resource-Policy makes browsers refuse the iframe.
        assert!(block.contains("defer"), "{block}");
        // The bridge is gone, and with it the `mode=` query headers it needed:
        // the pod host boots its own service worker on this origin, so no
        // bridge document is ever created.
        assert!(!block.contains("__nodepod_bridge__"), "{block}");
        assert!(!block.contains("mode=top"), "{block}");
        assert!(!block.contains("mode=parent"), "{block}");
        assert!(
            !block.contains("Cross-Origin-Opener-Policy unsafe-none"),
            "{block}"
        );
        assert!(block.contains("tls {"), "on-demand TLS:\n{block}");
        // A preview runs in the browser: no fleet gate, no tenant trace.
        assert!(!block.contains("health_uri"), "{block}");
        assert!(!block.contains("traceparent"), "{block}");

        // Only that exact host serves assets; every other label under the
        // suffix is refused, plaintext-only so it never asks for a certificate.
        assert!(
            out.contains("http://*.preview.test.noite.now {") && out.contains("respond 404"),
            "no label catch-all:\n{out}"
        );
        // Behind a terminating proxy, the same plaintext twin a tenant site
        // gets, so the preview host answers on :80 as well.
        let mut proxied = test_config("noite.now", "app", false, "/tmp/noite-test-preview-proxy");
        proxied.control_bundle_dir = "/tmp/noite-test-preview-bundle".into();
        let out = rendered(&proxied, &[test_app()]).await;
        assert!(
            out.contains("\napp-0.preview.test.noite.now {"),
            "no TLS site:\n{out}"
        );
        assert!(
            out.contains("\nhttp://app-0.preview.test.noite.now {"),
            "no plaintext twin:\n{out}"
        );

        // The dev image (no control bundle) proxies this host whole instead:
        // `vite dev` serves the pod's document, its module graph and Nodepod's
        // assets, and a matcher cannot know the dev server's URL space.
        let dev = test_config("noite.now", "app", true, "/tmp/noite-test-preview-dev");
        let out = rendered(&dev, &[test_app()]).await;
        let start = out
            .find("\napp-0.preview.test.noite.now {")
            .unwrap_or_else(|| panic!("no dev site:\n{out}"));
        let rest = &out[start + 1..];
        let dev_block = rest[..rest.find("\n}\n").expect("site end")].to_string();
        assert!(
            dev_block.contains("reverse_proxy 127.0.0.1:8090"),
            "dev preview must proxy the dev upstream:\n{dev_block}"
        );
        assert!(
            !dev_block.contains("@nodepod") && !dev_block.contains("respond 404"),
            "dev preview must not match paths:\n{dev_block}"
        );
    }

    /// Control sites answer 404 for the pod assets before proxying: the
    /// worker's own gate 404s them too, but Void's `createAssetFallback`
    /// retries an app 404 against `env.ASSETS`, so the gate's 404 would still
    /// serve the file — the edge is the real enforcement (edge.spec.ts
    /// "cross-origin isolated"). The preview host keeps serving them (pinned
    /// by the test above).
    #[tokio::test]
    async fn control_sites_deny_the_pod_assets() {
        let denied = [
            "/noite-pod-host.html",
            "/noite-pod-host.js",
            "/__sw__.js",
            "/__worker__.js",
            "/__nodepod_bridge__.html",
            "/__nodepod_bridge__.js",
        ];
        // The runner-side derivation holds: the preview host's pod list minus
        // the frame chunks, plus the dead bridge pair — one source of truth,
        // pinned so a const edit that drops a path fails here, not in the lane.
        let derived: Vec<&str> = PREVIEW_ASSETS
            .split_whitespace()
            .filter(|p| *p != "/assets/*")
            .chain(POD_BRIDGE_ASSETS.split_whitespace())
            .collect();
        assert_eq!(derived.join(" "), denied.join(" "), "deny list drifted");
        assert_eq!(control_denied_assets(), denied.join(" "));
        // The production shape: a control bundle is present (`bundle_present`),
        // matching the e2e lane the edge spec runs in.
        let mut cfg = test_config("noite.now", "app", true, "/tmp/noite-test-control-deny");
        cfg.control_bundle_dir = "/tmp/noite-test-control-deny-bundle".into();
        std::fs::create_dir_all(Path::new(&cfg.control_bundle_dir)).expect("bundle dir");
        std::fs::write(
            Path::new(&cfg.control_bundle_dir).join("wrangler.json"),
            "{}",
        )
        .expect("bundle marker");
        let out = rendered(&cfg, &[test_app()]).await;
        let block = site_block(&out, "app.noite.now");
        // The deny is a terminal `respond` ahead of the proxy: the six paths
        // 404, everything else still reaches the control upstream.
        let matcher = denied.join(" ");
        assert!(
            block.contains(&format!("@control_denied path {}", matcher)),
            "control misses the deny matcher:\n{block}"
        );
        assert!(block.contains("respond @control_denied 404"), "{block}");
        assert!(
            block.contains("reverse_proxy 127.0.0.1:8090"),
            "control must still proxy:\n{block}"
        );
        // The control UI's own bundle is not denied: `/assets/*` stays
        // proxyable (edge.spec.ts "still serves its own bundle").
        let deny_line = block
            .lines()
            .find(|l| l.contains("@control_denied path"))
            .expect("deny line");
        assert!(!deny_line.contains("/assets/"), "{deny_line}");
        for path in denied {
            assert!(deny_line.contains(path), "{path} missing:\n{deny_line}");
        }
        // The container loopback proxies the same upstream, so it denies too.
        let loopback = site_block(&out, "http://127.0.0.1");
        assert!(
            loopback.contains("respond @control_denied 404"),
            "{loopback}"
        );
        assert!(
            loopback.contains("reverse_proxy 127.0.0.1:8090"),
            "{loopback}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
        // Behind a terminating proxy the plaintext twin carries the same deny,
        // including across joined extra control hosts.
        let mut proxied = test_config(
            "noite.now",
            "app",
            false,
            "/tmp/noite-test-control-deny-proxy",
        );
        proxied.control_bundle_dir = "/tmp/noite-test-control-deny-bundle".into();
        proxied.control_extra_hosts = vec!["lab.netbird.cloud".into()];
        let out = rendered(&proxied, &[test_app()]).await;
        let twin = site_block(&out, "http://app.noite.now, http://lab.netbird.cloud");
        assert!(twin.contains("respond @control_denied 404"), "{twin}");
        assert!(
            twin.contains("reverse_proxy 127.0.0.1:8090"),
            "twin must still proxy:\n{twin}"
        );
        let _ = tokio::fs::remove_file(&proxied.caddyfile_path).await;
        // Dev (`vite dev`, no control bundle) denies as well: the deny is
        // origin policy, not bundle layout — dev serves the same pod files on
        // this origin, while the dev preview host still proxies whole.
        let dev = test_config("noite.now", "app", true, "/tmp/noite-test-control-deny-dev");
        let out = rendered(&dev, &[test_app()]).await;
        let block = site_block(&out, "app.noite.now");
        assert!(
            block.contains("respond @control_denied 404"),
            "dev control must deny too:\n{block}"
        );
        assert!(
            block.contains("reverse_proxy 127.0.0.1:8090"),
            "dev control must still proxy:\n{block}"
        );
        let _ = tokio::fs::remove_file(&dev.caddyfile_path).await;
    }

    /// Tenant sites wait for celld's ready gate: a request routed before it
    /// opens reaches cells the fleet cannot place yet (`CapacityExhausted`).
    /// Control, API and Git sites are not fleets and must not be gated.
    #[tokio::test]
    async fn tenant_sites_are_gated_on_fleet_readiness() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-ready-gate");
        let app = test_app();
        let domains = [test_domain(&app.id, "shop.example.com")];
        let out = rendered_with(&cfg, &[app], &domains).await;
        let site = |addr: &str| {
            let start = out
                .find(&format!("\n{addr} {{"))
                .unwrap_or_else(|| panic!("no site {addr}:\n{out}"));
            let rest = &out[start + 1..];
            rest[..rest.find("\n}\n").expect("site end")].to_string()
        };
        for addr in ["test.noite.now", "shop.example.com"] {
            let block = site(addr);
            assert!(
                block.contains("health_uri /.well-known/celld/health"),
                "{addr} ungated:\n{block}"
            );
            assert!(
                block.contains("handle_errors 502 503"),
                "{addr} has no starting page:\n{block}"
            );
            // Error ingest join (host/errors.rs): trace id sent and logged.
            assert!(
                block.contains("request_header traceparent"),
                "{addr} sends no trace:\n{block}"
            );
            assert!(
                block.contains("log_append traceID"),
                "{addr} logs no trace:\n{block}"
            );
        }
        for addr in ["app.noite.now", "api.noite.now", "git.noite.now"] {
            assert!(
                !site(addr).contains("health_uri"),
                "{addr} must not be gated"
            );
            assert!(
                !site(addr).contains("traceparent"),
                "{addr} is not a tenant"
            );
        }
    }

    #[tokio::test]
    async fn asleep_apps_wake_on_request_instead_of_falling_back() {
        let cfg = test_config("localhost", "", false, "/tmp/noite-caddy-sleep-test");
        let mut asleep = test_app();
        asleep.asleep_since = Some("2026-09-28T00:00:00Z".into());
        asleep.status = "sleeping".into();
        let out = rendered(&cfg, &[asleep.clone()]).await;
        // Still routed to its own port (the held request is proxied there
        // after the wake), with the wake hop in front of the proxy.
        assert!(
            out.contains("reverse_proxy 127.0.0.1:"),
            "asleep app lost its route:\n{out}"
        );
        assert!(
            out.contains("forward_auth"),
            "asleep app has no wake hop:\n{out}"
        );
        assert!(out.contains("uri /v1/edge/wake"), "{out}");
        assert!(
            out.contains("response_header_timeout 135s"),
            "wake timeout not above the runner budget:\n{out}"
        );
        // No active health checks on the wake route: their stale "down"
        // state would turn the released request into the starting page.
        assert!(
            !out.contains("health_uri"),
            "asleep route still health-checks:\n{out}"
        );
        // Awake apps pay no wake hop.
        let awake = rendered(&cfg, &[test_app()]).await;
        assert!(
            !awake.contains("forward_auth"),
            "awake app got a wake hop:\n{awake}"
        );
        // A stopped app is parked by its owner: no route, no wake.
        let mut stopped = asleep;
        stopped.desired_state = "stopped".into();
        let parked = rendered(&cfg, &[stopped]).await;
        assert!(
            !parked.contains("forward_auth"),
            "stopped app must not wake:\n{parked}"
        );
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
    async fn pending_domains_get_no_route() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-domains");
        let app = test_app();
        let domains = [
            test_domain(&app.id, "www.example.com"),
            test_pending_domain(&app.id, "draft.example.com"),
        ];
        let out = rendered_with(&cfg, &[app], &domains).await;
        assert!(out.contains("www.example.com {"), "verified gets a site");
        assert!(
            !out.contains("draft.example.com"),
            "a pending claim gets no route, even on a live app"
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
        // Caddy 2.10 skips managed certs for names a wildcard covers, so
        // every public site must carry the on-demand gate itself.
        for site in [
            "app.noite.now {",
            "api.noite.now {",
            "git.noite.now {",
            "test.noite.now {",
            "*.noite.now {",
        ] {
            let block = out.split(&format!("\n{site}\n")).nth(1).expect(site);
            let block = block.split("\n}\n").next().unwrap_or_default();
            assert!(block.contains("\t\ton_demand"), "{site} is on-demand gated");
        }
        // No public plaintext twins: Caddy's own :80 -> HTTPS redirect answers.
        // The one intentional exception is the preview label catch-all, which is
        // plaintext-only so it never asks for a certificate (the stable preview
        // host itself is on-demand gated above).
        let plaintext = out
            .lines()
            .filter(|l| l.starts_with("http://") && l.ends_with(" {"))
            .collect::<Vec<_>>();
        assert_eq!(
            plaintext,
            vec!["http://127.0.0.1 {", "http://*.preview.test.noite.now {"],
            "only the loopback healthcheck and the preview label catch-all are plaintext"
        );
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

    fn site_block(out: &str, addr: &str) -> String {
        let start = out
            .find(&format!("\n{addr} {{"))
            .unwrap_or_else(|| panic!("no site {addr}:\n{out}"));
        let rest = &out[start + 1..];
        rest[..rest.find("\n}\n").expect("site end")].to_string()
    }

    /// Production is framed by Code mode's Preview for the default branch: a
    /// frame load opts in (CORP + COEP, replacing the app's own), while every
    /// other request keeps whatever CORP the app sets.
    #[tokio::test]
    async fn production_site_opts_frame_loads_into_code_mode() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-prod-frame");
        let out = rendered(&cfg, &[test_app()]).await;
        let block = site_block(&out, "test.noite.now");
        let framed = block
            .find("header @noite_framed {")
            .map(|at| &block[at..])
            .and_then(|rest| rest.find("\n\t}").map(|end| &rest[..end]))
            .unwrap_or_else(|| panic!("no framed header block:\n{block}"));
        assert!(framed.contains("defer"), "{framed}");
        assert!(
            framed.contains("Cross-Origin-Resource-Policy same-site"),
            "{framed}"
        );
        assert!(
            framed.contains("Cross-Origin-Embedder-Policy credentialless"),
            "{framed}"
        );
        assert!(
            block.contains("@noite_framed header Sec-Fetch-Dest iframe"),
            "{block}"
        );
        // A same-site frame (the control UI) reaches the app as a page load.
        assert!(
            block.contains("\theader Sec-Fetch-Site same-site")
                && block.contains("request_header @noite_preview Sec-Fetch-Dest document"),
            "{block}"
        );
        // Only the frame load: no site-wide CORP on production.
        assert_eq!(
            block.matches("Cross-Origin-Resource-Policy").count(),
            1,
            "{block}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    /// A public environment is exactly a tenant site plus the frameable
    /// header: its own port, the app's rate-limit zones, the fleet-ready gate,
    /// the trace header, on-demand TLS — and no gate at all.
    #[tokio::test]
    async fn public_environment_site_is_a_tenant_site_on_its_own_port() {
        let mut cfg = test_config("noite.now", "app", true, "/tmp/noite-test-env-public");
        // The shared per-app ceiling is off by default; turn it on so the site
        // proves it draws from the app's own zones.
        cfg.edge.app_rpm = 600;
        let app = test_app();
        let mut env = test_env(&app, "staging");
        env.public = true;
        let out = rendered_envs(&cfg, &[app], &[], &[env]).await;
        let block = site_block(&out, "staging.test.noite.now");
        assert!(
            block.contains("reverse_proxy 127.0.0.1:8200"),
            "environment must route to its own fleet port:\n{block}"
        );
        assert!(
            block.contains("health_uri /.well-known/celld/health"),
            "an environment fleet waits for its ready gate too:\n{block}"
        );
        assert!(block.contains("handle_errors 502 503"), "{block}");
        assert!(block.contains("request_header traceparent"), "{block}");
        // The app's own zones: an environment is the same app's traffic.
        assert!(block.contains("zone client_test {"), "{block}");
        assert!(block.contains("zone app_test {"), "{block}");
        // Frameable by the cross-origin-isolated Code mode page, replacing any
        // header the app set (a duplicate CORP breaks the frame).
        assert!(
            block.contains("\tCross-Origin-Resource-Policy same-site"),
            "{block}"
        );
        assert!(block.contains("\tdefer"), "{block}");
        // A framed load also carries a COEP of its own (a require-corp page
        // refuses a frame without one); a top-level visit does not.
        assert!(
            block.contains("@noite_framed header Sec-Fetch-Dest iframe"),
            "{block}"
        );
        assert!(
            block.contains("\tCross-Origin-Embedder-Policy credentialless"),
            "{block}"
        );
        assert!(block.contains("tls {"), "on-demand certificate:\n{block}");
        // No gate, and no wake hop while it is awake.
        assert!(!block.contains("env-gate"), "{block}");
        assert!(!block.contains("/__noite/auth"), "{block}");
        assert!(!block.contains("forward_auth"), "{block}");
        // Nothing set a cookie here, so nothing strips one either.
        assert!(!block.contains("{noite_env_cookie}"), "{block}");
        // A label under an app that owns environments resolves to the runner's
        // page rather than Caddy's empty 404.
        assert!(
            out.contains("\n*.test.noite.now {") && out.contains("rewrite * /v1/edge/fallback"),
            "no label catch-all:\n{out}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    /// A members-only environment (the default) is gated: the runner owns
    /// `/__noite/auth` on the environment's own host, and every other path
    /// passes through `forward_auth /v1/edge/env-gate` before the fleet.
    #[tokio::test]
    async fn members_only_environment_site_is_gated() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-env-gated");
        let app = test_app();
        let out = rendered_envs(
            &cfg,
            std::slice::from_ref(&app),
            &[],
            &[test_env(&app, "feat-x")],
        )
        .await;
        let block = site_block(&out, "feat-x.test.noite.now");
        // The auth path is the runner's, never the app's.
        assert!(block.contains("handle /__noite/auth* {"), "{block}");
        assert!(block.contains("rewrite * /v1/edge/env-auth"), "{block}");
        assert!(
            block.contains("forward_auth 127.0.0.1:8080 {"),
            "no gate hop:\n{block}"
        );
        assert!(block.contains("uri /v1/edge/env-gate"), "{block}");
        // The gate owns the wake: one hop, and it holds the request while the
        // gate answers, so the timeout must cover the runner's wake budget.
        assert!(!block.contains("/v1/edge/wake"), "{block}");
        assert!(block.contains("response_header_timeout 135s"), "{block}");
        // The fleet is still the upstream of the catch-all branch.
        assert!(block.contains("reverse_proxy 127.0.0.1:8200"), "{block}");
        assert!(block.contains("zone client_test {"), "{block}");
        assert!(
            block.contains("Cross-Origin-Resource-Policy same-site"),
            "{block}"
        );
        // The gate's own cookie is stripped before the app (ROADMAP): the
        // strip has to run after `forward_auth` (which reads the cookie) and
        // before the fleet, which is what the `route` block is for.
        assert!(
            block.contains("map {http.request.header.Cookie} {noite_env_cookie} {"),
            "{block}"
        );
        assert!(
            block.contains("request_header Cookie {noite_env_cookie}"),
            "{block}"
        );
        let strip = block.find("request_header Cookie").expect("strip");
        let gate = block.find("uri /v1/edge/env-gate").expect("gate");
        let fleet = block.find("reverse_proxy 127.0.0.1:8200").expect("fleet");
        assert!(
            gate < strip && strip < fleet,
            "gate → strip → fleet:\n{block}"
        );
        assert!(
            block.contains("handle {\n\t\troute {"),
            "the ordered block is a route:\n{block}"
        );

        // Behind a terminating proxy the same plaintext twin a tenant site
        // gets, gate and hand-back included (the visitor was admitted on that
        // origin, so the cookie must be set there).
        let proxied = test_config("noite.now", "app", false, "/tmp/noite-test-env-gated-proxy");
        let out = rendered_envs(&proxied, &[app], &[], &[test_env(&test_app(), "feat-x")]).await;
        assert!(out.contains("\nfeat-x.test.noite.now {"), "{out}");
        let twin = site_block(&out, "http://feat-x.test.noite.now");
        assert!(twin.contains("handle /__noite/auth* {"), "{twin}");
        assert!(twin.contains("uri /v1/edge/env-gate"), "{twin}");
        assert!(twin.contains("reverse_proxy 127.0.0.1:8200"), "{twin}");
        assert!(!twin.contains("\ttls {"), "the twin is plaintext:\n{twin}");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn asleep_environments_wake_on_request() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-env-asleep");
        let app = test_app();
        // Public and asleep: the tenant wake hop, inside the catch-all handle.
        let mut public = test_env(&app, "staging");
        public.public = true;
        public.asleep_since = Some("2026-10-13T00:00:00Z".into());
        let out = rendered_envs(&cfg, std::slice::from_ref(&app), &[], &[public]).await;
        let block = site_block(&out, "staging.test.noite.now");
        assert!(block.contains("uri /v1/edge/wake"), "{block}");
        assert!(
            !block.contains("health_uri"),
            "a woken route must skip the stale health check:\n{block}"
        );
        assert!(block.contains("reverse_proxy 127.0.0.1:8200"), "{block}");
        // Members-only and asleep: the gate woke it, so no second hop.
        let mut gated = test_env(&app, "feat-x");
        gated.asleep_since = Some("2026-10-13T00:00:00Z".into());
        let out = rendered_envs(&cfg, &[app], &[], &[gated]).await;
        let block = site_block(&out, "feat-x.test.noite.now");
        assert!(block.contains("uri /v1/edge/env-gate"), "{block}");
        assert!(!block.contains("/v1/edge/wake"), "{block}");
        assert!(!block.contains("health_uri"), "{block}");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    /// A never-deployed or stopped environment keeps its host (the certificate
    /// is per environment) and answers the runner's page.
    #[tokio::test]
    async fn parked_environments_answer_the_fallback_page() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-env-parked");
        let app = test_app();
        let mut fresh = test_env(&app, "wip");
        fresh.last_deployed_at = None;
        let mut stopped = test_env(&app, "paused");
        stopped.desired_state = "stopped".into();
        let out = rendered_envs(&cfg, &[app], &[], &[fresh, stopped]).await;
        for addr in ["wip.test.noite.now", "paused.test.noite.now"] {
            let block = site_block(&out, addr);
            assert!(
                block.contains("rewrite * /v1/edge/fallback"),
                "{addr} must answer the runner's page:\n{block}"
            );
            assert!(
                block.contains("reverse_proxy 127.0.0.1:8080"),
                "{addr} must go to the runner:\n{block}"
            );
            assert!(!block.contains("health_uri"), "{addr}:\n{block}");
            assert!(!block.contains("env-gate"), "{addr}:\n{block}");
            assert!(!block.contains("8200"), "{addr} proxies no fleet:\n{block}");
            assert!(
                block.contains("tls {"),
                "{addr} keeps its certificate:\n{block}"
            );
            assert!(
                block.contains("Cross-Origin-Resource-Policy same-site"),
                "{addr}:\n{block}"
            );
            assert!(block.contains("zone client_test {"), "{addr}:\n{block}");
        }
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn environments_without_an_app_or_without_envs_emit_nothing() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-env-none");
        let app = test_app();
        // No environments: no label catch-all, no environment site.
        let out = rendered(&cfg, std::slice::from_ref(&app)).await;
        assert!(!out.contains("env-gate"), "{out}");
        assert!(!out.contains("staging.test"), "{out}");
        // An environment whose app row is gone is skipped, not emitted with a
        // guessed host.
        let env = test_env(&app, "orphan");
        let out = rendered_envs(&cfg, &[], &[], &[env]).await;
        assert!(!out.contains("orphan.test"), "{out}");
        assert!(
            !out.contains("*.test.noite.now"),
            "no app, no label catch-all:\n{out}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn every_public_site_is_rate_limited() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-limits");
        let app = test_app();
        let domains = [test_domain(&app.id, "shop.example.com")];
        let out = rendered_with(&cfg, &[app], &domains).await;
        // 1800 rpm per client is 300 per 10 s window.
        for (addr, zone) in [
            ("app.noite.now", "client_control"),
            ("api.noite.now", "client_api"),
            ("test.noite.now", "client_test"),
            ("shop.example.com", "client_test"),
            ("*.noite.now", "client_fallback"),
        ] {
            let block = site_block(&out, addr);
            assert!(
                block.contains(&format!("zone {zone} {{")),
                "{addr} lacks {zone}:\n{block}"
            );
            assert!(block.contains("key {client_ip}"), "{addr}:\n{block}");
            assert!(block.contains("events 300"), "{addr}:\n{block}");
        }
        // Git: its own tighter budget (120 rpm = 20 per window).
        let git = site_block(&out, "git.noite.now");
        assert!(
            git.contains("zone client_git {") && git.contains("events 20"),
            "{git}"
        );
        // The shared per-app ceiling is off by default.
        assert!(
            !out.contains("zone app_test"),
            "app ceiling is off by default:\n{out}"
        );
        // The container healthcheck is never limited.
        assert!(!site_block(&out, "http://127.0.0.1").contains("rate_limit"));
        // Slowloris bound, and 429s stay out of the process log.
        assert!(out.contains("read_header 10s"), "{out}");
        assert!(out.contains("exclude http.handlers.rate_limit"), "{out}");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn app_limits_override_the_platform_defaults() {
        let mut cfg = test_config("noite.now", "app", true, "/tmp/noite-test-app-limits");
        cfg.edge.app_rpm = 6000;
        let app = test_app();
        let mut other = test_app();
        other.id = "other-id".into();
        other.slug = "other".into();
        let limits = [AppLimit {
            app_id: app.id.clone(),
            client_rpm: Some(0),
            app_rpm: Some(60),
        }];
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
        rewrite_caddy(&cfg, &[app, other], &[], &limits, &[])
            .await
            .expect("rewrite");
        let out = tokio::fs::read_to_string(&cfg.caddyfile_path)
            .await
            .expect("read");
        let own = site_block(&out, "test.noite.now");
        assert!(
            !own.contains("zone client_test"),
            "0 turns the per-client limit off:\n{own}"
        );
        assert!(
            own.contains("zone app_test {") && own.contains("key all") && own.contains("events 10"),
            "{own}"
        );
        let other = site_block(&out, "other.noite.now");
        assert!(other.contains("zone client_other {"), "{other}");
        assert!(
            other.contains("zone app_other {") && other.contains("events 1000"),
            "platform app ceiling:\n{other}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[tokio::test]
    async fn trusted_proxies_resolve_the_visitor() {
        let mut cfg = test_config("noite.now", "app", true, "/tmp/noite-test-proxies");
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(!out.contains("trusted_proxies"), "{out}");
        assert!(!out.contains("header_up X-Forwarded-For"), "{out}");
        cfg.edge.trusted_proxies = crate::config::TrustedProxies {
            cloudflare: true,
            ranges: vec!["173.245.48.0/20".into(), "private_ranges".into()],
        };
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(
            out.contains("trusted_proxies static 173.245.48.0/20 private_ranges"),
            "{out}"
        );
        assert!(
            out.contains("client_ip_headers CF-Connecting-IP X-Forwarded-For"),
            "{out}"
        );
        assert!(out.contains("trusted_proxies_strict"), "{out}");
        // The control worker keys auth limits on X-Forwarded-For.
        let control = site_block(&out, "app.noite.now");
        assert!(
            control.contains("header_up X-Forwarded-For {client_ip}"),
            "{control}"
        );
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }

    #[test]
    fn without_the_module_no_limits_are_written() {
        let cfg = test_config("noite.now", "app", true, "/tmp/noite-test-unused");
        let zones = [Zone::per_client(&cfg, "client_x", 600)];
        let with = guard_lines_with(&zones, true).join("\n");
        assert!(
            with.contains("rate_limit {") && with.contains("events 100"),
            "{with}"
        );
        assert!(guard_lines_with(&zones, false).is_empty());
        assert!(guard_lines_with(&[Zone::per_client(&cfg, "off", 0)], true).is_empty());
    }

    #[tokio::test]
    async fn behind_a_blind_proxy_only_app_ceilings_apply() {
        // Coolify/Railway: every request arrives from the proxy. Per-client
        // limits would throttle the whole install as one client.
        let mut cfg = test_config("noite.now", "app", false, "/tmp/noite-test-blind");
        cfg.edge.app_rpm = 600;
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(!out.contains("key {client_ip}"), "{out}");
        assert!(
            out.contains("zone app_test {"),
            "the app ceiling still applies:\n{out}"
        );
        // Naming the proxy restores them.
        cfg.edge.trusted_proxies.ranges = vec!["private_ranges".into()];
        let out = rendered(&cfg, &[test_app()]).await;
        assert!(out.contains("zone client_test {"), "{out}");
        let _ = tokio::fs::remove_file(&cfg.caddyfile_path).await;
    }
}
