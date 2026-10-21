//! Static edge config + per-request string sources for it.
//!
//! Caddy's config is static after boot: [`write_static_caddyfile`] renders
//! two catch-all sites (per scheme) once, and app lifecycle events push the
//! route table in `host/edge_table.rs` through Caddy's admin API instead of
//! reloading. The Go module (`edge/`) publishes `{http.vars.edge_route}` /
//! `{http.vars.edge_upstream}`; this file's directives branch on them.

use std::path::Path;

use crate::config::{is_localhost_domain, Config};
use crate::host::{control, env_gate};

/// W3C trace header for fleet requests, from the request UUID with the
/// dashes dropped (32 hex = a W3C trace id; the last 16 double as the span
/// id). Not Caddy's `tracing` directive: that one always runs an OTLP
/// exporter, and an always-off sampler would mark the trace unsampled, which
/// celld's parent-based sampler honours by recording nothing.
/// `request_header` replaces any client-sent `traceparent`, so a client
/// cannot pick the id an error is filed under.
pub(crate) const TRACE_MAP: &[&str] = &[
    "map {http.request.uuid} {noite_trace} {noite_span} {",
    "\t~^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$ \"${1}${2}${3}${4}${5}\" \"${4}${5}\"",
    "}",
];
pub(crate) const TRACE_HEADER: &str = "traceparent \"00-{noite_trace}-{noite_span}-01\"";
pub(crate) const TRACE_LOG_APPEND: &str = "log_append traceID {noite_trace}";

/// Answer when a fleet stays unready past `lb_try_duration` (503) or refuses
/// the connection while it restarts (502): a page that retries by itself,
/// and `Retry-After` for API clients, instead of Caddy's empty error.
/// celld's own 503s (load shedding) are responses, not errors, and pass
/// through unchanged (this lives in `handle_errors`, never `handle_response`).
///
/// No status codes on the `handle_errors` block itself: `parseHandleErrors`
/// overwrites every inner route's matchers with the status expression when
/// codes are given, so a gated `handle` inside would silently match
/// everything. The status gate lives in the combined matcher instead.
pub(crate) const STARTING_HEADERS: &[&str] = &[
    "header Retry-After 5",
    "header Cache-Control no-store",
    "header Content-Type \"text/html; charset=utf-8\"",
];
pub(crate) const STARTING_RESPOND: &str = "respond `<!doctype html><meta http-equiv=\"refresh\" content=\"5\"><title>Starting</title><p>This app is starting. The page reloads by itself.</p>` 503";

/// Proxy options for a tenant fleet. celld answers its public
/// `/.well-known/celld/health` 503 until its ready gate opens, and a request
/// routed before that reaches cells it cannot place yet. The module holds
/// such requests (same 20 s / 250 ms numbers); `lb_try_*` still retries a
/// transient dial failure. POSTs are safe: a held request is never sent.
pub(crate) const LB_TRY: &[&str] = &["lb_try_duration 20s", "lb_try_interval 250ms"];

/// Bounds for every proxied upstream. `dial_timeout` bounds a stalled
/// connect; the pool stays ON deliberately (measured: a new connection per
/// request costs ~590 ms where the pool costs ~11 ms). `flush_interval -1`
/// keeps event streams unbuffered.
pub(crate) const PROXY_TRANSPORT: &[&str] = &[
    "transport http {",
    "\tdial_timeout 5s",
    "\tresponse_header_timeout 30s",
    "}",
    "flush_interval -1",
];

/// `forward_auth` hop into the runner, for a named matcher. Caddy holds the
/// original request (body included) while the hop runs and proxies it
/// unchanged when the hop answers 200; any other status is copied back to
/// the visitor. The header timeout sits above the runner's own wake budget,
/// so Caddy never gives up first.
fn forward_auth_for(matcher: &str, uri: &str, cfg: &Config) -> Vec<String> {
    vec![
        format!("forward_auth {matcher} {} {{", cfg.caddy_api_upstream),
        format!("\turi {uri}"),
        "\ttransport http {".into(),
        format!(
            "\t\tresponse_header_timeout {}s",
            cfg.wake_timeout_s.max(1) + 15
        ),
        "\t}".into(),
        "}".into(),
    ]
}

/// Removes the gate's own cookie from the request before it reaches the app.
/// Caddy can only address the whole `Cookie` field, so this is a `map` over
/// that header covering the three shapes the cookie can take — first,
/// middle, last — with the input itself as the `default`, which leaves every
/// other cookie (and an app with no cookies at all) exactly as it was. Runs
/// *after* `forward_auth` (the gate reads the cookie) and *before* the fleet.
pub(crate) const COOKIE_STRIP_MAP: &[&str] = &[
    "map {http.request.header.Cookie} {noite_env_cookie} {",
    "\t~^__noite_env=[^;]*;?\\s*(.*)$ ${1}",
    "\t~^(.*)__noite_env=[^;]*;\\s*(.*)$ ${1}${2}",
    "\t~^(.*);\\s*__noite_env=[^;]*$ ${1}",
    "\tdefault {http.request.header.Cookie}",
    "}",
];
pub(crate) const COOKIE_STRIP_HEADER: &str = "request_header @is_gated Cookie {noite_env_cookie}";

/// Per-response headers for environment sites: the Code mode page is
/// cross-origin-isolated, so it can only frame a document that opted in.
/// The COEP is `credentialless` and only on frame loads.
pub(crate) const ENV_CORP: &[&str] = &[
    "header @env_corp {",
    "\tdefer",
    "\tCross-Origin-Resource-Policy same-site",
    "}",
];
pub(crate) const ENV_COEP: &[&str] = &[
    "header @env_framed {",
    "\tdefer",
    "\tCross-Origin-Embedder-Policy credentialless",
    "}",
];

/// Frame headers for a production tenant site, frame loads only: the Code
/// mode Preview panel frames production for the default branch, and its
/// cross-origin-isolated page refuses a frame without both headers.
/// Production keeps its own `Cross-Origin-Resource-Policy` everywhere else.
pub(crate) const PRODUCTION_FRAME: &[&str] = &[
    "header @tenant_framed {",
    "\tdefer",
    "\tCross-Origin-Resource-Policy same-site",
    "\tCross-Origin-Embedder-Policy credentialless",
    "}",
];

/// The Preview panel's frame reaches the app as a top-level page load; a
/// same-site frame is rewritten to `document` on the way upstream.
pub(crate) const PREVIEW_DEST: &str = "request_header @preview_rewrite Sec-Fetch-Dest document";

/// The dead Nodepod preview bridge: never served by the preview host nor any
/// control site. Must match `POD_BRIDGE_PATHS` in
/// `apps/noite/src/lib/preview-host.ts`.
const POD_BRIDGE_ASSETS: &[&str] = &["/__nodepod_bridge__.html", "/__nodepod_bridge__.js"];

/// The only pod files a preview origin serves (plus the `/assets/*` chunks
/// the frame bundle loads at runtime). Must match `PREVIEW_HOST_ASSETS` in
/// `apps/noite/src/lib/preview-host.ts`.
pub(crate) const POD_FILES: &[&str] = &[
    "/noite-pod-host.html",
    "/noite-pod-host.js",
    "/__sw__.js",
    "/__worker__.js",
];
pub(crate) const PREVIEW_ASSETS_GLOB: &str = "/assets/*";

/// Every path a control site answers 404 for: the preview host's pod assets
/// minus the frame chunks (on this origin `/assets/*` is the control UI's
/// own bundle, served exactly as before), plus the dead bridge pair. Must
/// match `CONTROL_HOST_DENIED_ASSETS` in `apps/noite/src/lib/preview-host.ts`.
pub(crate) fn control_denied_assets() -> Vec<&'static str> {
    let mut denied = POD_FILES.to_vec();
    denied.extend_from_slice(POD_BRIDGE_ASSETS);
    denied
}

/// Pod response headers: the service worker registration scope and the
/// agent-cluster headers the pod document and its workers need.
pub(crate) const POD_HEADERS: &[&str] = &[
    "header @sw {",
    "\tdefer",
    "\tService-Worker-Allowed /",
    "\tCache-Control no-cache",
    "}",
    "header @hostframe {",
    "\tdefer",
    "\tCross-Origin-Resource-Policy cross-origin",
    "\tCross-Origin-Embedder-Policy require-corp",
    "\tCross-Origin-Opener-Policy same-origin",
    "\tCache-Control no-store",
    "}",
];

static CADDY_ADMIN_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static CADDY_ADMIN_ERR: std::sync::OnceLock<std::sync::Mutex<String>> = std::sync::OnceLock::new();

/// Last edge admin-write result, for /ready.
pub fn admin_status() -> (bool, String) {
    let ok = CADDY_ADMIN_OK.load(std::sync::atomic::Ordering::Relaxed);
    let detail = CADDY_ADMIN_ERR
        .get()
        .map(|m| m.lock().map(|s| s.clone()).unwrap_or_default())
        .unwrap_or_default();
    (ok, detail)
}

pub(crate) fn admin_note(ok: bool, detail: String) {
    CADDY_ADMIN_OK.store(ok, std::sync::atomic::Ordering::Relaxed);
    if let Some(m) = CADDY_ADMIN_ERR.get() {
        if let Ok(mut g) = m.lock() {
            *g = detail;
        }
    } else {
        let _ = CADDY_ADMIN_ERR.set(std::sync::Mutex::new(detail));
    }
}

/// Matchers branching the static config on the module's vars. Each combines
/// a request shape (path/header, from today's constants) with the route kind.
fn matchers() -> Vec<String> {
    let denied = control_denied_assets().join(" ");
    let pod_allow = POD_FILES.join(" ");
    vec![
        "@deny {".into(),
        "\texpression {http.vars.edge_route} == 'deny'".into(),
        "}".into(),
        "@podblocked {".into(),
        format!("\tnot path {pod_allow} {PREVIEW_ASSETS_GLOB}"),
        "\texpression {http.vars.edge_route} == 'preview'".into(),
        "}".into(),
        "@controlblocked {".into(),
        format!("\tpath {denied}"),
        "\texpression {http.vars.edge_route} == 'control'".into(),
        "}".into(),
        "@auth {".into(),
        format!("\tpath {}*", env_gate::AUTH_PATH),
        "\texpression {http.vars.edge_gate} == '1'".into(),
        "}".into(),
        "@is_gated {".into(),
        "\texpression {http.vars.edge_gate} == '1'".into(),
        "}".into(),
        "@is_asleep {".into(),
        "\texpression {http.vars.edge_wake} == '1'".into(),
        "}".into(),
        "@fleetish {".into(),
        "\texpression {http.vars.edge_route} == 'tenant' || {http.vars.edge_route} == 'custom' || {http.vars.edge_route} == 'env'".into(),
        "}".into(),
        "@controish {".into(),
        "\texpression {http.vars.edge_route} == 'control' || {http.vars.edge_route} == 'preview'".into(),
        "}".into(),
        "@tenant_framed {".into(),
        "\theader Sec-Fetch-Dest iframe".into(),
        "\texpression {http.vars.edge_route} == 'tenant'".into(),
        "}".into(),
        "@env_framed {".into(),
        "\theader Sec-Fetch-Dest iframe".into(),
        "\texpression {http.vars.edge_route} == 'env'".into(),
        "}".into(),
        "@env_corp {".into(),
        "\texpression {http.vars.edge_route} == 'env'".into(),
        "}".into(),
        "@preview_rewrite {".into(),
        "\theader Sec-Fetch-Dest iframe".into(),
        "\theader Sec-Fetch-Site same-site".into(),
        "\texpression {http.vars.edge_route} == 'tenant' || {http.vars.edge_route} == 'env'".into(),
        "}".into(),
        "@sw {".into(),
        "\tpath /__sw__.js".into(),
        "\texpression {http.vars.edge_route} == 'preview'".into(),
        "}".into(),
        "@hostframe {".into(),
        "\tpath /noite-pod-host.html /noite-pod-host.js".into(),
        "\texpression {http.vars.edge_route} == 'preview'".into(),
        "}".into(),
        "@gitrewrite {".into(),
        "\texpression {http.vars.edge_route} == 'git'".into(),
        "}".into(),
        "@fallbackrewrite {".into(),
        "\texpression {http.vars.edge_route} == 'fallback' || {http.vars.edge_route} == 'env-parked'".into(),
        "}".into(),
        "@fleetish_err {".into(),
        // One `expression` only: a second `expression` line in a named
        // matcher silently drops (only the first survives adapt).
        "\texpression ({http.error.status_code} == 502 || {http.error.status_code} == 503) && ({http.vars.edge_route} == 'tenant' || {http.vars.edge_route} == 'custom' || {http.vars.edge_route} == 'env')".into(),
        "}".into(),
    ]
}

fn proxy_block(upstream: &str, extra: &[&str]) -> Vec<String> {
    let mut out = vec![format!("reverse_proxy {upstream} {{")];
    for line in extra {
        out.push(format!("\t{line}"));
    }
    for line in PROXY_TRANSPORT {
        out.push(format!("\t{line}"));
    }
    out.push("}".into());
    out
}

/// The one reverse-proxy branch every site shares, with the module's vars
/// already set. Order matters (this runs inside `route`): 404s, then the
/// runner-owned auth path, then the wake/gate hops, then the request
/// mutations, then the proxy. `handle` blocks are mutually exclusive, so at
/// most one answers.
fn route_block(cfg: &Config) -> Vec<String> {
    let mut out = vec![
        "route {".into(),
        "\tedge_routes {".into(),
        format!("\t\ttable {}", cfg.routes_path),
        "\t}".into(),
        "\thandle @deny {".into(),
        "\t\trespond 404".into(),
        "\t}".into(),
    ];
    if control::bundle_present(cfg) {
        out.push("\thandle @podblocked {".into());
        out.push("\t\trespond 404".into());
        out.push("\t}".into());
    }
    out.extend([
        "\thandle @controlblocked {".into(),
        "\t\trespond 404".into(),
        "\t}".into(),
        "\thandle @auth {".into(),
        "\t\trewrite * /v1/edge/env-auth".into(),
    ]);
    for line in proxy_block(&cfg.caddy_api_upstream, &[]) {
        out.push(format!("\t{line}"));
    }
    out.push("\t}".into());
    for line in forward_auth_for("@is_gated", "/v1/edge/env-gate", cfg) {
        out.push(format!("\t{line}"));
    }
    for line in forward_auth_for("@is_asleep", "/v1/edge/wake", cfg) {
        out.push(format!("\t{line}"));
    }
    for line in COOKIE_STRIP_MAP {
        out.push(format!("\t{line}"));
    }
    out.push(format!("\t{COOKIE_STRIP_HEADER}"));
    out.push(format!("\trequest_header @fleetish {TRACE_HEADER}"));
    for line in PRODUCTION_FRAME {
        out.push(format!("\t{line}"));
    }
    for line in ENV_CORP {
        out.push(format!("\t{line}"));
    }
    for line in ENV_COEP {
        out.push(format!("\t{line}"));
    }
    out.push(format!("\t{PREVIEW_DEST}"));
    if control::bundle_present(cfg) {
        for line in POD_HEADERS {
            out.push(format!("\t{line}"));
        }
    }
    out.push("\trewrite @gitrewrite /v1/git{uri}".into());
    out.push("\trewrite @fallbackrewrite /v1/edge/fallback".into());
    // The readiness hold runs here: after the wake/gate hops (so an
    // anonymous request to a gated env with a down fleet gets the gate's
    // answer immediately) and immediately before the proxy. Asleep routes
    // skip it (the wake hop already waited); limits already ran in
    // `edge_routes`, preserving limits → gate/wake → readiness order.
    out.push("\tedge_hold".into());
    out.push("\thandle @fleetish {".into());
    for line in proxy_block("{http.vars.edge_upstream}", LB_TRY) {
        out.push(format!("\t\t{line}"));
    }
    out.push("\t}".into());
    if cfg.edge.trusted_proxies.is_empty() {
        out.push("\thandle {".into());
        for line in proxy_block("{http.vars.edge_upstream}", &[]) {
            out.push(format!("\t\t{line}"));
        }
        out.push("\t}".into());
    } else {
        // The control worker keys its own auth limits on the right-most
        // X-Forwarded-For entry. Behind a trusted proxy Caddy appends the
        // proxy's address there, so hand the worker the resolved visitor
        // instead (fleets keep Caddy's default X-Forwarded-For).
        out.push("\thandle @controish {".into());
        for line in proxy_block(
            "{http.vars.edge_upstream}",
            &["header_up X-Forwarded-For {client_ip}"],
        ) {
            out.push(format!("\t\t{line}"));
        }
        out.push("\t}".into());
        out.push("\thandle {".into());
        for line in proxy_block("{http.vars.edge_upstream}", &[]) {
            out.push(format!("\t\t{line}"));
        }
        out.push("\t}".into());
    }
    out.push("}".into());
    out
}

/// `handle_errors`, not `handle_response`: this catches only Caddy-generated
/// errors (refused dial, no available upstream), while celld's own 503
/// responses (load shedding) pass through unchanged. Fleet/env routes get
/// the starting page; control/api keep Caddy's default 502.
fn errors_block() -> Vec<String> {
    let mut out = vec!["handle_errors {".into(), "\thandle @fleetish_err {".into()];
    for line in STARTING_HEADERS {
        out.push(format!("\t\t{line}"));
    }
    out.push(format!("\t\t{STARTING_RESPOND}"));
    out.push("\t}".into());
    out.push("}".into());
    out
}

/// One serving site: access log (with the trace id), compression, the trace
/// map, then the shared branch.
fn serving_site(addr: &str, tls: bool, cfg: &Config) -> Vec<String> {
    let mut out = vec![format!("{addr} {{")];
    if tls {
        out.push("\ttls {".into());
        out.push("\t\ton_demand".into());
        out.push("\t}".into());
    }
    out.push("\tlog {".into());
    out.push(format!("\t\toutput file {}", cfg.caddy_access_log));
    out.push("\t\tformat json".into());
    out.push("\t}".into());
    out.push(format!("\t{TRACE_LOG_APPEND}"));
    out.push("\tencode zstd gzip".into());
    for line in TRACE_MAP {
        out.push(format!("\t{line}"));
    }
    out.extend(matchers().iter().map(|l| format!("\t{l}")));
    for line in route_block(cfg) {
        out.push(format!("\t{line}"));
    }
    for line in errors_block() {
        out.push(format!("\t{line}"));
    }
    out.push("}".into());
    out
}

/// The static Caddyfile: everything here derives from platform config (env
/// vars), never from app rows. App events must never rewrite it.
fn static_caddyfile(cfg: &Config) -> String {
    let local = is_localhost_domain(&cfg.base_domain);
    let edge_tls = !local && !cfg.auto_https;
    let mut lines = vec![
        "# noite edge (static; app routes arrive via the edge_routes table, never a reload)".into(),
        "{".into(),
    ];
    // `auto_https` accepts only disable-style values — "on" is Caddy's
    // default and NOT a valid token, so the directive is emitted only when
    // HTTPS must be off.
    if !cfg.auto_https {
        lines.push("\tauto_https off".into());
    }
    lines.push("\tadmin 127.0.0.1:2019".into());
    // Server-wide request bounds. `read_header` drops a client that trickles
    // its headers (slowloris) instead of holding the connection open; only
    // `read_header` and `idle` are set, so Caddy 2.11's progress-based
    // `read_body_idle`/`write_idle` (1m) still apply: a stalled body or
    // response is cut, a quiet event stream between writes is not. Behind
    // a proxy, `trusted_proxies` makes `{client_ip}` (the rate-limit key)
    // the visitor, not the proxy.
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
    lines.push("\ton_demand_tls {".into());
    lines.push(format!(
        "\t\task http://{}/v1/edge/tls-ask",
        cfg.caddy_api_upstream
    ));
    lines.push("\t}".into());
    lines.push("}".into());
    lines.push(String::new());
    if local {
        // Plain HTTP only; no :443 listener at all.
        lines.extend(serving_site(":80", false, cfg));
    } else if edge_tls {
        // Behind a terminating proxy: plaintext :80 plus TLS on :443.
        lines.extend(serving_site(":80", false, cfg));
        lines.push(String::new());
        lines.extend(serving_site(":443", true, cfg));
    } else {
        // Direct TLS: :80 redirects (ACME challenges are answered by
        // Caddy itself before the handler chain), :443 serves.
        // Caddy's own automatic redirect is a 308; match it. The
        // redirect drops an explicit port only when it is the default.
        let target = if cfg.https_port == 443 {
            "https://{host}{uri}".to_string()
        } else {
            format!("https://{{host}}:{}{{uri}}", cfg.https_port)
        };
        lines.push(":80 {".into());
        lines.push("\tlog {".into());
        lines.push(format!("\t\toutput file {}", cfg.caddy_access_log));
        lines.push("\t\tformat json".into());
        lines.push("\t}".into());
        lines.push(format!("\t{TRACE_LOG_APPEND}"));
        for line in TRACE_MAP {
            lines.push(format!("\t{line}"));
        }
        lines.push(format!("\tredir {target} 308"));
        lines.push("}".into());
        lines.push(String::new());
        lines.extend(serving_site(":443", true, cfg));
    }
    lines.join("\n")
}

/// Write the static Caddyfile at boot. Returns whether it changed (a change
/// means the platform config changed; Caddy boots from the file, so no
/// `/load` is ever needed — app events never touch this file at all).
pub async fn write_static_caddyfile(cfg: &Config) -> anyhow::Result<bool> {
    let next = static_caddyfile(cfg);
    if tokio::fs::read_to_string(&cfg.caddyfile_path)
        .await
        .is_ok_and(|prev| prev == next)
    {
        return Ok(false);
    }
    let path = Path::new(&cfg.caddyfile_path);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, &next).await?;
    tracing::info!(path = %cfg.caddyfile_path, "edge static config written");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{config_for_tests, TrustedProxies};

    fn prod_config() -> Config {
        let mut cfg = config_for_tests();
        cfg.base_domain = "example.com".into();
        cfg.auto_https = true;
        cfg
    }

    #[test]
    fn local_plain_http_has_no_tls_site() {
        let cfg = config_for_tests();
        let out = static_caddyfile(&cfg);
        assert!(out.contains(":80 {"), "{out}");
        assert!(!out.contains(":443 {"), "{out}");
        assert!(!out.contains("redir https://"), "{out}");
        assert!(!out.contains("\ttls {"), "{out}");
    }

    #[test]
    fn direct_tls_redirects_port_80_with_308() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        assert!(out.contains(":443 {"), "{out}");
        assert!(out.contains("\ttls {\n\t\ton_demand"), "{out}");
        // Non-default test HTTPS port is carried, like a browser would show.
        assert!(out.contains("redir https://{host}:9443{uri} 308"), "{out}");
        assert!(!out.contains("auto_https off"), "{out}");
    }

    #[test]
    fn behind_a_proxy_both_schemes_serve() {
        let mut cfg = prod_config();
        cfg.auto_https = false;
        let out = static_caddyfile(&cfg);
        assert!(out.contains("auto_https off"), "{out}");
        assert!(!out.contains("redir https://"), "{out}");
        assert!(out.contains(":443 {"), "{out}");
    }

    #[test]
    fn no_reloads_no_connection_close_no_per_host_sites() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        assert!(!out.contains("rate_limit"), "{out}");
        assert!(!out.contains("Connection"), "{out}");
        assert!(!out.contains("myapp"), "{out}");
        assert!(out.contains("edge_routes {"), "{out}");
        assert!(out.contains("table /tmp/noite-test-routes.json"), "{out}");
        assert!(out.contains("admin 127.0.0.1:2019"), "{out}");
        // Placeholder upstreams only; the module sets the real one per request.
        assert!(
            out.contains("reverse_proxy {http.vars.edge_upstream}"),
            "{out}"
        );
    }

    #[test]
    fn starting_page_only_catches_caddy_errors_on_fleet_routes() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        assert!(!out.contains("handle_response"), "{out}");
        assert!(out.contains("handle_errors {"), "{out}");
        // No status codes on the block: they would overwrite the inner
        // matchers (Caddy overwrites, so the gate would match everything).
        assert!(!out.contains("handle_errors 502"), "{out}");
        assert!(out.contains("handle @fleetish_err {"), "{out}");
        // Status and kind gate combined in one matcher.
        assert!(out.contains("({http.error.status_code} == 502 || {http.error.status_code} == 503) && ({http.vars.edge_route}"), "{out}");
        assert!(out.contains("handle @fleetish {"), "{out}");
        assert!(out.contains("This app is starting"), "{out}");
        assert!(out.contains("header Retry-After 5"), "{out}");
    }

    #[test]
    fn readiness_hold_runs_after_hops_before_proxy() {
        // F3: limits (edge_routes) → gate/wake (forward_auth) → readiness
        // (edge_hold) → proxy. An anonymous gated request with a down fleet
        // meets the gate first, never a 20 s hold.
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        let edge_routes = out.find("edge_routes {").expect("edge_routes");
        let gate = out.find("forward_auth @is_gated").expect("gate hop");
        let wake = out.find("forward_auth @is_asleep").expect("wake hop");
        let hold = out.find("\n\t\tedge_hold\n").expect("edge_hold");
        let proxy = out.find("handle @fleetish {").expect("fleet proxy");
        assert!(edge_routes < gate, "{out}");
        assert!(gate < hold && wake < hold, "{out}");
        assert!(hold < proxy, "{out}");
    }

    #[test]
    fn fleet_proxy_retries_but_plain_proxy_does_not_hold() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        let fleet = out
            .split("handle @fleetish {")
            .nth(1)
            .expect("fleet handle")
            .split("handle {")
            .next()
            .unwrap_or("");
        assert!(fleet.contains("lb_try_duration 20s"), "{fleet}");
        assert!(fleet.contains("lb_try_interval 250ms"), "{fleet}");
        // The plain branch carries the same timeouts and pooling, no hold.
        assert!(out.contains("dial_timeout 5s"), "{out}");
        assert!(out.contains("flush_interval -1"), "{out}");
    }

    #[test]
    fn trace_frame_cookie_and_rewrites_keep_their_legacy_strings() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        assert!(
            out.contains("traceparent \"00-{noite_trace}-{noite_span}-01\""),
            "{out}"
        );
        assert!(out.contains("log_append traceID {noite_trace}"), "{out}");
        assert!(
            out.contains("Cross-Origin-Resource-Policy same-site"),
            "{out}"
        );
        assert!(
            out.contains("Cross-Origin-Embedder-Policy credentialless"),
            "{out}"
        );
        assert!(
            out.contains("request_header @preview_rewrite Sec-Fetch-Dest document"),
            "{out}"
        );
        assert!(out.contains("__noite_env=[^;]*"), "{out}");
        assert!(out.contains("rewrite @gitrewrite /v1/git{uri}"), "{out}");
        assert!(
            out.contains("rewrite @fallbackrewrite /v1/edge/fallback"),
            "{out}"
        );
        assert!(out.contains("forward_auth @is_gated"), "{out}");
        assert!(out.contains("uri /v1/edge/env-gate"), "{out}");
        assert!(out.contains("forward_auth @is_asleep"), "{out}");
        assert!(out.contains("uri /v1/edge/wake"), "{out}");
        assert!(out.contains("handle @auth {"), "{out}");
        assert!(out.contains("rewrite * /v1/edge/env-auth"), "{out}");
        // Wake/gate hop timeout sits above the runner's wake budget.
        assert!(out.contains("response_header_timeout 135s"), "{out}");
    }

    #[test]
    fn visitor_header_only_behind_a_trusted_proxy() {
        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        assert!(!out.contains("header_up X-Forwarded-For"), "{out}");
        let mut cfg = prod_config();
        cfg.edge.trusted_proxies = TrustedProxies {
            cloudflare: true,
            ranges: vec!["private_ranges".into()],
        };
        let out = static_caddyfile(&cfg);
        assert!(
            out.contains("trusted_proxies static private_ranges"),
            "{out}"
        );
        assert!(
            out.contains("client_ip_headers CF-Connecting-IP X-Forwarded-For"),
            "{out}"
        );
        assert!(
            out.contains("header_up X-Forwarded-For {client_ip}"),
            "{out}"
        );
    }

    #[test]
    fn control_denied_and_preview_allowlist_match_the_ts_lists() {
        // Must match CONTROL_HOST_DENIED_ASSETS / PREVIEW_HOST_ASSETS in
        // apps/noite/src/lib/preview-host.ts (pod paths live in one place).
        let denied = control_denied_assets();
        assert!(denied.contains(&"/noite-pod-host.html"));
        assert!(denied.contains(&"/__sw__.js"));
        assert!(!denied.iter().any(|p| p.contains('*')));
        assert!(denied.contains(&"/__nodepod_bridge__.html"));

        let cfg = prod_config();
        let out = static_caddyfile(&cfg);
        for path in denied {
            assert!(out.contains(path), "{path} missing\n{out}");
        }
        if control::bundle_present(&cfg) {
            assert!(out.contains("@podblocked"), "{out}");
        }
    }
}
