//! Preview-environment access gate (ROADMAP, Preview environments → Phase 2).
//!
//! A members-only environment (the default) is served by its own celld fleet on
//! `<label>.<slug>.<base>`, and the control UI's session cookie — host-only on
//! the control origin — can never reach it. The gate therefore hands off:
//!
//! 1. Caddy holds the request and calls `GET /v1/edge/env-gate`
//!    (`forward_auth` on every members-only environment site). No valid
//!    `__noite_env` cookie → 302 to
//!    `<control>/api/env-auth?env=&app=&return=<absolute env url>`.
//! 2. The control UI checks its session and the app's `view` role, mints a
//!    token with the `environments.grant` RPC and redirects the browser to
//!    `<env host>/__noite/auth?token=&return=<path>`.
//! 3. `/v1/edge/env-auth` verifies the token, sets the host-only
//!    `__noite_env` cookie and 302s to the return path.
//!
//! Both token and cookie are HMAC-SHA256 over the runner token (domain
//! separated), so the gate adds no secret to configure or leak: the runner
//! mints and verifies, and neither value is replayable as a bearer token.
//! The cookie is host-only on the environment host and bounded to 12 h; Caddy
//! 2.10 cannot edit one cookie out of a header (its `header` ops work on the
//! whole `Cookie` field), so the app does see it — acceptable, since the app
//! *is* the environment the cookie admits to, and the value is worthless on
//! any other host.
//!
//! Open redirects: the gate builds `return` itself from Caddy's
//! `X-Forwarded-*` headers (path-only inputs), and [`safe_return_path`] refuses
//! anything the control UI could not have meant — a token is never followed
//! off the environment host.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::config::{is_localhost_domain, Config};
use crate::{db, AppState};

use super::edge::{control_url, page, parse_env_host};

/// The gate's cookie: host-only on the environment host, so it never travels
/// to the control UI, to production, or to another environment.
pub const COOKIE_NAME: &str = "__noite_env";

/// How long a hand-back token stays valid (`environments.grant` → the control
/// UI's 302 → `/__noite/auth`): one browser redirect, so seconds.
pub const GRANT_TTL_S: i64 = 60;

/// How long a browser stays admitted to one environment.
pub const COOKIE_TTL_S: i64 = 12 * 3600;

/// The path Caddy routes to [`env_auth`] (`handle /__noite/auth*`).
pub const AUTH_PATH: &str = "/__noite/auth";

type HmacSha256 = Hmac<Sha256>;

/// `grant` and `cookie` are separate MAC domains: a token the control UI hands
/// back can never be replayed as a cookie, and vice versa.
fn key(cfg: &Config) -> String {
    format!("noite-env-gate-v1:{}", cfg.runner_token)
}

/// Hex-encoded MAC over the kind, the environment, its subject (the user for a
/// grant; empty for a cookie) and the expiry.
fn mac(cfg: &Config, kind: &str, env_id: &str, subject: &str, exp: i64) -> String {
    let mut h = HmacSha256::new_from_slice(key(cfg).as_bytes()).expect("hmac accepts any key");
    for part in [kind, env_id, subject] {
        h.update(part.as_bytes());
        h.update(b"\n");
    }
    h.update(exp.to_string().as_bytes());
    h.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn now_unix() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Hex so a user id can never smuggle a `.` into a token's dotted shape.
fn hex_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 2);
    for b in value.bytes() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(value: &str) -> Option<String> {
    let (pairs, rest) = value.as_bytes().as_chunks::<2>();
    if !rest.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let hi = char::from(pair[0]).to_digit(16)?;
        let lo = char::from(pair[1]).to_digit(16)?;
        out.push(u8::try_from(hi * 16 + lo).ok()?);
    }
    String::from_utf8(out).ok()
}

fn mac_ok(cfg: &Config, kind: &str, env_id: &str, subject: &str, exp: i64, claimed: &str) -> bool {
    let expected = mac(cfg, kind, env_id, subject, exp);
    constant_time_eq::constant_time_eq(claimed.as_bytes(), expected.as_bytes())
}

/// Verify a `{env_id}.{exp}.{mac}` value, returning the environment it admits
/// to. The MAC covers the expiry, so tampering with either is one failure, and
/// the comparison is constant-time. The environment id is a generated id, so
/// it never contains a `.`.
fn verify(cfg: &Config, kind: &str, value: &str, subject: &str) -> Option<String> {
    let mut parts = value.split('.');
    let env_id = parts.next()?;
    let exp = parts.next()?.parse::<i64>().ok()?;
    let claimed = parts.next()?;
    if parts.next().is_some() || env_id.is_empty() {
        return None;
    }
    if !mac_ok(cfg, kind, env_id, subject, exp, claimed) {
        return None;
    }
    if exp < now_unix() {
        return None;
    }
    Some(env_id.to_string())
}

/// The token `environments.grant` returns, bound to one environment and one
/// user, valid for [`GRANT_TTL_S`]. Shape: `{hex(id)}.{exp}.{hex(user)}.{mac}`.
pub fn mint_grant(cfg: &Config, env_id: &str, user_id: &str) -> String {
    let exp = now_unix() + GRANT_TTL_S;
    format!(
        "{}.{exp}.{}.{}",
        hex_encode(env_id),
        hex_encode(user_id),
        mac(cfg, "grant", env_id, user_id, exp)
    )
}

/// Verify a grant token → `(environment, user)`. Expired, tampered, or
/// foreign tokens are `None`.
pub fn verify_grant(cfg: &Config, token: &str) -> Option<(String, String)> {
    let mut parts = token.split('.');
    let env_hex = parts.next()?;
    let exp = parts.next()?.parse::<i64>().ok()?;
    let user_hex = parts.next()?;
    let claimed = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let env_id = hex_decode(env_hex)?;
    let user_id = hex_decode(user_hex)?;
    if env_id.is_empty() || !mac_ok(cfg, "grant", &env_id, &user_id, exp, claimed) {
        return None;
    }
    if exp < now_unix() {
        return None;
    }
    Some((env_id, user_id))
}

/// The cookie value for an environment, valid for [`COOKIE_TTL_S`].
pub fn mint_cookie(cfg: &Config, env_id: &str) -> String {
    let exp = now_unix() + COOKIE_TTL_S;
    format!("{env_id}.{exp}.{}", mac(cfg, "cookie", env_id, "", exp))
}

/// Verify a cookie value → the environment it admits to.
pub fn verify_cookie(cfg: &Config, value: &str) -> Option<String> {
    verify(cfg, "cookie", value, "")
}

/// The one cookie of ours in a request, if any.
fn cookie_value(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for pair in raw.split(';') {
        let pair = pair.trim();
        if let Some(value) = pair
            .strip_prefix(COOKIE_NAME)
            .and_then(|rest| rest.strip_prefix('='))
        {
            return Some(value.trim());
        }
    }
    None
}

/// The environment host a request arrived on, as `(slug, label)`. Caddy's
/// `forward_auth` names the original host in `X-Forwarded-Host`.
fn request_host(cfg: &Config, headers: &HeaderMap) -> Option<(String, String)> {
    let raw = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())?;
    parse_env_host(raw, &cfg.tenant_bases())
}

/// The return path a token was minted for, or `/`. An attacker-controlled
/// value is refused outright (open-redirect safety): only a rooted same-host
/// path survives, never `//host`, a scheme, a backslash or a fragment.
pub fn safe_return_path(raw: Option<&str>) -> String {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return "/".into();
    };
    let rooted = raw.starts_with('/') && !raw.starts_with("//") && !raw.starts_with("/\\");
    let clean = !raw.contains('\\')
        && !raw.contains('#')
        && !raw.contains("://")
        && !raw.chars().any(char::is_control);
    if rooted && clean {
        raw.to_string()
    } else {
        "/".into()
    }
}

/// Percent-encode a query value (RFC 3986 unreserved set).
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The origin (scheme + host) of the request Caddy is holding.
fn request_origin(cfg: &Config, headers: &HeaderMap, host: &str) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .filter(|s| *s == "http" || *s == "https")
        .unwrap_or(if is_localhost_domain(&cfg.base_domain) {
            "http"
        } else {
            "https"
        });
    format!("{scheme}://{host}")
}

/// The absolute URL of the request Caddy is holding (origin + path): what the
/// visitor asked for, so the control UI can send them back to it after signing
/// in.
fn absolute_url(cfg: &Config, headers: &HeaderMap, host: &str) -> String {
    // Caddy sets `X-Forwarded-Uri` from the request line; a client that sent an
    // absolute-form target lands outside `/`, so anything not rooted is dropped
    // rather than pasted into a redirect.
    let uri = headers
        .get("x-forwarded-uri")
        .and_then(|v| v.to_str().ok())
        .filter(|u| u.starts_with('/'))
        .unwrap_or("/");
    format!("{}{uri}", request_origin(cfg, headers, host))
}

/// `Set-Cookie` for the gate cookie: host-only on the environment (no
/// `Domain`), unreadable by scripts, `Lax` so the hand-back redirect carries it
/// while cross-site subresource requests do not.
fn cookie_header(cfg: &Config, value: &str) -> String {
    let secure = if is_localhost_domain(&cfg.base_domain) {
        ""
    } else {
        "; Secure"
    };
    format!("{COOKIE_NAME}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={COOKIE_TTL_S}{secure}")
}

/// A 302 with header values that came from request headers: an unrepresentable
/// value is a bug in the caller, not something to forward.
fn redirect(location: &str, set_cookie: Option<&str>) -> Response {
    let mut resp = StatusCode::FOUND.into_response();
    let headers = resp.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    match header::HeaderValue::from_str(location) {
        Ok(value) => headers.insert(header::LOCATION, value),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if let Some(cookie) = set_cookie {
        match header::HeaderValue::from_str(cookie) {
            Ok(value) => headers.insert(header::SET_COOKIE, value),
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        };
    }
    resp
}

/// Caddy `forward_auth` for a members-only environment site.
///
/// Anything but a valid cookie is a 302 into the control UI's hand-off route;
/// a valid one is a 200 and Caddy proxies the held request unchanged. An
/// environment that is asleep is woken *after* the cookie check, so an
/// unauthenticated visitor can never spawn someone else's preview fleet.
pub async fn env_gate(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let cfg = &state.config;
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let Some((slug, label)) = request_host(cfg, &headers) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let route = match db::environment_route(&state.pool, &slug, &label).await {
        Ok(Some(route)) => route,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    // Public environments render no gate at all; this is the defensive answer
    // for a direct call, not a route the Caddyfile emits.
    if route.public {
        return StatusCode::OK.into_response();
    }
    let admitted = cookie_value(&headers).and_then(|value| verify_cookie(cfg, value));
    if admitted.as_deref() != Some(route.id.as_str()) {
        let control = control_url(
            host,
            &cfg.base_domain,
            &cfg.control_subdomain,
            &cfg.tenant_bases(),
        );
        // Scheme-relative: the browser keeps the scheme it reached this
        // environment on. Behind a TLS-terminating proxy Caddy only sees http,
        // and an `http://` hop inside the Code mode frame (an https page) is
        // mixed content the browser refuses to navigate to.
        let control_authority = control
            .split_once("://")
            .map_or(control.as_str(), |(_, rest)| rest);
        // The control UI cannot see the environment row (it is the runner's),
        // so the app id travels beside the environment id: that is what it
        // resolves its `view` role with before calling `environments.grant`.
        let target = format!(
            "//{control_authority}/api/env-auth?env={}&app={}&return={}",
            percent_encode(&route.id),
            percent_encode(&route.app_id),
            percent_encode(&absolute_url(cfg, &headers, host))
        );
        return redirect(&target, None);
    }
    if route.asleep_since.is_some() {
        if let Err(e) = crate::host::sleep::wake_environment(
            &state.pool,
            cfg,
            &state.procs,
            &state.logs,
            &route.id,
        )
        .await
        {
            tracing::warn!(slug = %route.app_slug, label = %route.label, error = %e, "env wake failed");
            let control = control_url(
                host,
                &cfg.base_domain,
                &cfg.control_subdomain,
                &cfg.tenant_bases(),
            );
            return page(
                StatusCode::SERVICE_UNAVAILABLE,
                "Unavailable",
                &format!(
                    "The preview <code>{}</code> could not start. Try again in a moment.",
                    crate::host::edge::escape(&route.label)
                ),
                &control,
            )
            .into_response();
        }
    }
    StatusCode::OK.into_response()
}

/// `/__noite/auth` on an environment host: verify the token the control UI was
/// handed, set the gate cookie and send the browser on to the path it asked
/// for. Caddy routes this path to the runner, so it never reaches the app.
pub async fn env_auth(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let cfg = &state.config;
    let Some((slug, label)) = request_host(cfg, &headers) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let token = params.get("token").map(String::as_str).unwrap_or("");
    let Some((env_id, user_id)) = verify_grant(cfg, token) else {
        return (
            StatusCode::BAD_REQUEST,
            "This preview link expired or was tampered with. Open the environment again from Noite.",
        )
            .into_response();
    };
    // A token is bound to one environment and only good news on that
    // environment's own host, so a token for `a.test` can never admit a visitor
    // to `b.test` (or to production).
    let route = match db::environment_route(&state.pool, &slug, &label).await {
        Ok(Some(route)) if route.id == env_id => route,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    tracing::info!(
        slug = %route.app_slug,
        label = %route.label,
        user = %user_id,
        "environment access granted"
    );
    // A rooted path, not an absolute URL: the browser stays on the scheme and
    // host it reached this environment on (an `http://` URL built from what
    // Caddy sees behind a TLS-terminating proxy is mixed content in a frame).
    redirect(
        &safe_return_path(params.get("return").map(String::as_str)),
        Some(&cookie_header(cfg, &mint_cookie(cfg, &route.id))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_for_tests;

    fn cfg() -> Config {
        let mut cfg = config_for_tests();
        cfg.base_domain = "noite.now".into();
        cfg.control_subdomain = "app".into();
        cfg
    }

    #[test]
    fn grant_round_trips() {
        let cfg = cfg();
        let token = mint_grant(&cfg, "env-1", "user-1");
        assert_eq!(
            verify_grant(&cfg, &token),
            Some(("env-1".to_string(), "user-1".to_string()))
        );
        // A user id with a dot or a space survives the dotted token shape.
        let token = mint_grant(&cfg, "env-1", "user.with.dots and spaces");
        assert_eq!(
            verify_grant(&cfg, &token),
            Some(("env-1".to_string(), "user.with.dots and spaces".to_string()))
        );
        assert_eq!(verify_grant(&cfg, ""), None);
        assert_eq!(verify_grant(&cfg, "env-1.9999999999.deadbeef"), None);
        assert_eq!(verify_grant(&cfg, "env-1.9999999999"), None);
        assert_eq!(verify_grant(&cfg, "env-1.9999999999.user.dead"), None);
        assert_eq!(
            verify_grant(&cfg, "invalid.9999999999.user.mac"),
            None,
            "bad hex"
        );
    }

    #[test]
    fn grant_rejects_tampering_of_any_field() {
        let cfg = cfg();
        let token = mint_grant(&cfg, "env-1", "user-1");
        let parts: Vec<&str> = token.split('.').collect();
        for forged in [
            format!(
                "{}.{}.{}.{}",
                parts[0], 9_999_999_999i64, parts[2], parts[3]
            ),
            format!(
                "{}.{}.{}.{}",
                hex_encode("env-2"),
                parts[1],
                parts[2],
                parts[3]
            ),
            format!(
                "{}.{}.{}.{}",
                parts[0],
                parts[1],
                hex_encode("user-2"),
                parts[3]
            ),
            format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], "00".repeat(32)),
            format!("{}.{}.{}", parts[0], parts[1], parts[3]),
        ] {
            assert_eq!(verify_grant(&cfg, &forged), None, "must refuse {forged}");
        }
        // A token minted by another instance (different secret) is refused.
        let mut other = cfg.clone();
        other.runner_token = "someone-else".into();
        assert_eq!(
            verify_grant(&other, &mint_grant(&cfg, "env-1", "user-1")),
            None
        );
    }

    #[test]
    fn grant_expires() {
        let cfg = cfg();
        let token = |exp: i64| {
            format!(
                "{}.{exp}.{}.{}",
                hex_encode("env-1"),
                hex_encode("user-1"),
                mac(&cfg, "grant", "env-1", "user-1", exp)
            )
        };
        assert_eq!(
            verify_grant(&cfg, &token(now_unix() - 1)),
            None,
            "past expiry"
        );
        assert!(
            verify_grant(&cfg, &token(now_unix() + GRANT_TTL_S)).is_some(),
            "the minted window is valid"
        );
    }

    #[test]
    fn cookie_round_trips_expires_and_is_a_separate_domain() {
        let cfg = cfg();
        let cookie = mint_cookie(&cfg, "env-1");
        assert_eq!(verify_cookie(&cfg, &cookie), Some("env-1".to_string()));
        assert_eq!(verify_cookie(&cfg, "env-2.9999999999.dead"), None);
        // A grant token is not a cookie: the MAC kind separates them both ways.
        assert_eq!(
            verify_cookie(&cfg, &mint_grant(&cfg, "env-1", "user-1")),
            None
        );
        assert_eq!(verify_grant(&cfg, &mint_cookie(&cfg, "env-1")), None);
        let exp = now_unix() - 1;
        let expired = format!("env-1.{exp}.{}", mac(&cfg, "cookie", "env-1", "", exp));
        assert_eq!(verify_cookie(&cfg, &expired), None);
    }

    #[test]
    fn reads_only_its_own_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=1; __noite_env=env-1.5.mac".parse().unwrap(),
        );
        assert_eq!(cookie_value(&headers), Some("env-1.5.mac"));
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "__noite_env_extra=1".parse().unwrap());
        assert_eq!(cookie_value(&headers), None);
        assert_eq!(cookie_value(&HeaderMap::new()), None);
    }

    #[test]
    fn return_path_refuses_open_redirects() {
        assert_eq!(safe_return_path(Some("/a/b?c=1")), "/a/b?c=1");
        assert_eq!(safe_return_path(Some("/")), "/");
        assert_eq!(safe_return_path(None), "/");
        assert_eq!(safe_return_path(Some("")), "/");
        assert_eq!(safe_return_path(Some("   ")), "/");
        for hostile in [
            "//evil.com/x",
            "https://evil.com",
            "http://evil.com/",
            "/\\evil.com",
            "\\\\evil.com",
            "javascript:alert(1)",
            "a/b",
            "/x#@evil.com",
            "/x\r\nLocation: https://evil.com",
        ] {
            assert_eq!(
                safe_return_path(Some(hostile)),
                "/",
                "must refuse {hostile:?}"
            );
        }
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(percent_encode("env-1"), "env-1");
        assert_eq!(
            percent_encode("https://a.test.noite.now/x?y=1"),
            "https%3A%2F%2Fa.test.noite.now%2Fx%3Fy%3D1"
        );
        assert_eq!(percent_encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn cookie_attributes_are_host_only() {
        let mut cfg = cfg();
        let value = mint_cookie(&cfg, "env-1");
        let line = cookie_header(&cfg, &value);
        assert!(line.starts_with("__noite_env=env-1."), "{line}");
        assert!(line.contains("; Path=/"), "{line}");
        assert!(line.contains("; HttpOnly"), "{line}");
        assert!(line.contains("; SameSite=Lax"), "{line}");
        assert!(line.contains("; Secure"), "{line}");
        assert!(!line.contains("Domain="), "host-only: {line}");
        cfg.base_domain = "localhost".into();
        let line = cookie_header(&cfg, &value);
        assert!(
            !line.contains("; Secure"),
            "plain-http dev base must not set Secure: {line}"
        );
    }

    #[test]
    fn hex_round_trips() {
        for value in ["", "env-1", "user with spaces", "üñî"] {
            assert_eq!(hex_decode(&hex_encode(value)).as_deref(), Some(value));
        }
        assert_eq!(hex_decode("abc"), None, "odd length");
        assert_eq!(hex_decode("zz"), None, "not hex");
    }
}
