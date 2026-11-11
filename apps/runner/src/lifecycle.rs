//! App lifecycle constants and pure helpers shared by API, reconcile, and deploy.

use crate::config::Config;

/// Default install/build step bound is 300s (`RUNNER_BUILD_TIMEOUT_S`). The
/// reconcile sweep skips apps whose deploy is claimed in this process, so a
/// raised bound never fails a working deploy; the boot sweep only finds rows
/// a previous process abandoned.
pub const DEPLOY_STUCK_MS: i64 = 360_000;

/// Tip-poll / DB in-flight window: skip spawning another deploy while a recent
/// building|deploying row exists (Deploying lock is the hard gate).
pub const DEPLOY_IN_FLIGHT_MS: i64 = 360_000;

/// The last `max` bytes of `s`, cut forward to a char boundary: build output
/// is full of multi-byte glyphs (`✓`, box drawing), and slicing through one
/// panics.
pub fn tail_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Tool output without ANSI escape sequences (colors, cursor moves), for the
/// plain-text deploy log.
pub fn strip_ansi(s: &str) -> std::borrow::Cow<'_, str> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    // Static invariant: a compile-time literal, so construction never fails.
    let re = RE.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("ansi re"));
    re.replace_all(s, "")
}

/// True when two git SHAs name the same object (exact match only — prefix
/// equality silently skipped real tip changes when bundle names were short).
pub fn sha_same(a: &str, b: &str) -> bool {
    let a = a.trim().to_ascii_lowercase();
    let b = b.trim().to_ascii_lowercase();
    !a.is_empty() && a == b
}

/// Slug rules for create, rename and import: lowercase letters, digits and
/// hyphens, and never a label the edge routes as a platform host. The
/// reserved labels are derived from the edge table's own
/// [`crate::host::edge_table::platform_routes`], so a non-default
/// `CONTROL_SUBDOMAIN` (or an extra control host sitting under a tenant base)
/// reserves exactly what the edge serves — the two cannot drift.
pub fn slug_ok(cfg: &Config, slug: &str) -> bool {
    // `_control` is the control plane's telemetry/cgroup key, not a host:
    // no app may take it even if a future slug grammar would allow it.
    if slug == crate::host::control::SLUG {
        return false;
    }
    // The retired pod-origin namespace (`pod-<uuid>`): browsers may still hold
    // a certificate and origin storage for the host whose app had that id, so
    // no tenant may claim it. Other `pod-` names were never pod hosts.
    if crate::host::edge::retired_pod_label(slug) {
        return false;
    }
    let platform: std::collections::HashSet<String> = crate::host::edge_table::platform_routes(cfg)
        .into_iter()
        .map(|(host, _)| host)
        .collect();
    if cfg
        .tenant_bases()
        .iter()
        .any(|base| platform.contains(&format!("{slug}.{base}").to_lowercase()))
    {
        return false;
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        // Static invariant: a compile-time literal, so construction never fails.
        regex::Regex::new(r"^[a-z0-9]([a-z0-9\-]{0,46}[a-z0-9])?$").expect("slug re")
    });
    re.is_match(slug)
}

/// A hostname an app may serve on. Lowercase DNS shape only: at least two
/// labels, letters/digits/hyphens, no leading or trailing hyphen, no wildcard,
/// no scheme, no port, no path, and never an IP literal. Platform-owned hosts
/// (the base domain, api./git./control) are rejected by the API handler, which
/// is the only place that knows the configured domain.
pub fn hostname_ok(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 || !name.is_ascii() {
        return false;
    }
    if name.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    if !name.contains('.') {
        return false;
    }
    name.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::config_for_tests;

    #[test]
    fn tail_utf8_never_splits_a_char() {
        // `✓` is 3 bytes; a 4-byte tail starts inside the first one.
        assert_eq!(tail_utf8("✓✓", 4), "✓");
        assert_eq!(tail_utf8("abc", 10), "abc");
        assert_eq!(tail_utf8("abcdef", 3), "def");
    }

    #[test]
    fn only_the_retired_pod_host_shape_is_unclaimable() {
        // `pod-<uuid>` served a pod origin: a stale tab or bookmark there
        // still loads whatever owns the name, so it stays reserved.
        assert!(!slug_ok(
            &config_for_tests(),
            "pod-0f4b0f6e-5a8e-4a0e-9c3f-2b1d0c9e8f7a"
        ));
        // Every other `pod-` name was never a pod host and stays available.
        for ok in ["pod", "podcast", "pod-staging", "pod-123", "mypod-x"] {
            assert!(slug_ok(&config_for_tests(), ok), "should accept {ok}");
        }
    }

    #[test]
    fn strip_ansi_removes_colors() {
        assert_eq!(
            strip_ansi("\x1b[32m✓\x1b[39m built in \x1b[1m34ms\x1b[22m"),
            "✓ built in 34ms"
        );
    }

    #[test]
    fn custom_hostname_shape() {
        for ok in [
            "app.example.com",
            "a-b.example.dev",
            "deep.sub.domain.co.uk",
            "x1.example.io",
        ] {
            assert!(hostname_ok(ok), "should accept {ok}");
        }
        for bad in [
            "example.com.",   // trailing dot is not a label
            "-a.example.com", // leading hyphen
            "a-.example.com", // trailing hyphen
            "a..example.com", // empty label
            "example",        // single label
            "Example.com",    // uppercase (the API lowercases first)
            "*.example.com",  // wildcard
            "a_b.example.com",
            "192.168.1.1",       // IP literal
            "a.example.com:443", // port
            "a.example.com/path",
            "",
        ] {
            assert!(!hostname_ok(bad), "should reject {bad}");
        }
    }

    #[test]
    fn sha_same_exact_only() {
        assert!(sha_same("abc", "abc"));
        assert!(sha_same("ABC", "abc"));
        assert!(!sha_same("abcdef0", "abcdef01"));
        assert!(!sha_same("abcdef01", "abcdef0"));
        assert!(!sha_same("", ""));
    }

    #[test]
    fn slug_rules() {
        let cfg = config_for_tests();
        assert!(slug_ok(&cfg, "test"));
        assert!(slug_ok(&cfg, "a"));
        assert!(slug_ok(&cfg, "my-app"));
        assert!(slug_ok(&cfg, "my-app-1"));
        assert!(slug_ok(&cfg, "app2"));
        assert!(slug_ok(&cfg, "2fast"));
        assert!(!slug_ok(&cfg, "_control"));
        // The API and Git hosts exist under every tenant base.
        assert!(!slug_ok(&cfg, "api"));
        assert!(!slug_ok(&cfg, "git"));
        // A default install serves control on the bare base, so `app` is a
        // free tenant label there (prod sets CONTROL_SUBDOMAIN=app).
        assert!(slug_ok(&cfg, "app"));
        assert!(!slug_ok(&cfg, "-bad"));
        assert!(!slug_ok(&cfg, "bad-"));
        assert!(!slug_ok(&cfg, "under_score"));
        assert!(!slug_ok(&cfg, "Bad"));
        assert!(!slug_ok(&cfg, ""));
    }

    /// The slug gate reads the live config, so a custom control subdomain is
    /// reserved exactly as the edge table serves it.
    #[test]
    fn control_host_labels_are_reserved() {
        let mut cfg = config_for_tests();
        assert!(slug_ok(&cfg, "console"));
        cfg.control_subdomain = "console".into();
        assert!(!slug_ok(&cfg, "console"));
        assert!(slug_ok(&cfg, "console2"));
        // An extra control host under a tenant base reserves its own label,
        // even when the operator wrote it dotted or uppercase.
        cfg.control_extra_hosts = vec!["Panel.Localhost.".into()];
        assert!(!slug_ok(&cfg, "panel"));
        // Tenant bases gain API and Git hosts too.
        assert!(!slug_ok(&cfg, "git"));
        assert!(!slug_ok(&cfg, "api"));
        // A dotted base domain is canonicalized before both sides compare.
        let mut dotted = config_for_tests();
        dotted.base_domain = "example.com.".into();
        dotted.control_subdomain = "console".into();
        assert!(!slug_ok(&dotted, "console"));
    }
}
