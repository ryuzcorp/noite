//! App lifecycle constants and pure helpers shared by API, reconcile, and deploy.

/// Longest deploy step is bun install/build at 300s; stuck sweep must exceed that
/// so an in-flight deploy is never marked failed while still working.
pub const DEPLOY_STUCK_MS: i64 = 360_000;

/// Tip-poll / DB in-flight window: skip spawning another deploy while a recent
/// building|deploying row exists (Deploying lock is the hard gate).
pub const DEPLOY_IN_FLIGHT_MS: i64 = 360_000;

/// True when two git SHAs name the same object (exact match only — prefix
/// equality silently skipped real tip changes when bundle names were short).
pub fn sha_same(a: &str, b: &str) -> bool {
    let a = a.trim().to_ascii_lowercase();
    let b = b.trim().to_ascii_lowercase();
    !a.is_empty() && a == b
}

/// Slug rules for create: DNS-ish label, not the reserved control prefix.
/// Slugs that would collide with edge routes and must never become apps.
const RESERVED_SLUGS: &[&str] = &["_control", "app", "api", "git"];

pub fn slug_ok(slug: &str) -> bool {
    if RESERVED_SLUGS.contains(&slug) {
        return false;
    }
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"^[a-z0-9]([a-z0-9\-]{0,46}[a-z0-9])?$").expect("slug re")
    });
    re.is_match(slug)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(slug_ok("test"));
        assert!(slug_ok("a"));
        assert!(slug_ok("my-app-1"));
        assert!(!slug_ok("_control"));
        assert!(!slug_ok("app"));
        assert!(!slug_ok("api"));
        assert!(!slug_ok("git"));
        assert!(!slug_ok("-bad"));
        assert!(!slug_ok("Bad"));
        assert!(!slug_ok(""));
    }
}
