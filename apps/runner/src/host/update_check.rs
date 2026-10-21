//! Opt-out "new version available" notice (no telemetry): the runner fetches
//! GitHub's public release list at most once a day and remembers the newest
//! promoted release, so the control UI can show admins a dismissible banner.
//!
//! Nothing is sent about the instance: the request is a plain anonymous GET
//! of public release metadata (fixed URL, fixed User-Agent, no auth, no
//! identifiers). The check is on by default (opt-out); `NOITE_UPDATE_CHECK=off`
//! forces it off.
//!
//! The decision inputs are pure and unit-tested with no network
//! (`parse_version`, `is_dev_build`, `select_update`, `should_check`); the
//! one network leg — the release list — goes through `fetch_releases`, and
//! tests inject the fetch itself (`tick`/`check_now` take it as a closure),
//! plus the clock.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::config::Config;
use crate::db;

/// The public release list. Fixed: never tenant-controlled, never carrying
/// instance data (no version in the query, nothing identifying).
pub const RELEASES_URL: &str = "https://api.github.com/repos/ryuzcorp/noite/releases";
/// Hard bound on the one network leg.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// The only custom header on the request (GitHub's API requires a UA).
const USER_AGENT: &str = "noite-update-check";
/// First attempt five minutes after boot, then hourly checks.
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(5 * 60);
const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How stale the last check must be for the next one: at most one request a
/// day, plus one at enable.
const CHECK_AFTER_HOURS: i64 = 24;

/// Test-only base-URL override, honored on local/dev domains only (the e2e
/// lane runs on `noite.localhost`, as does `make dev`). Public installs
/// always use the fixed URL above, so no tenant or operator input can steer
/// the outbound fetch off its fixed path.
const OVERRIDE_ENV: &str = "NOITE_UPDATE_CHECK_URL";

/// One entry of the GitHub release list. Only the promotion state and the
/// link are read; everything else in the payload is ignored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Release {
    /// `tag_name`, e.g. `v0.1.0-alpha.9`.
    #[serde(rename = "tag_name")]
    pub tag: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub published_at: Option<String>,
}

impl Release {
    #[cfg(test)]
    fn test(tag: &str, draft: bool, prerelease: bool) -> Self {
        Self {
            tag: tag.to_string(),
            draft,
            prerelease,
            html_url: format!("https://github.com/ryuzcorp/noite/releases/tag/{tag}"),
            published_at: None,
        }
    }
}

/// `instance.update_status` / `GET /v1/admin/update`: the toggle state, the
/// running version, and the newest release seen (if any is newer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateStatus {
    /// Effective state: stored preference AND not locked off.
    pub enabled: bool,
    /// What the operator stored.
    pub setting: bool,
    /// Whether `NOITE_UPDATE_CHECK=off` forces the check off.
    pub locked: bool,
    pub lock_reason: Option<String>,
    /// `NOITE_BUILD_VERSION` (`dev` for a source checkout).
    pub current: String,
    /// Newest promoted release newer than `current`, if one was seen.
    pub latest: Option<String>,
    /// When the release list was last fetched successfully.
    pub checked_at: Option<String>,
    /// Release-notes link for `latest`.
    pub notes_url: Option<String>,
}

/// The cached check result (`instance_setting` row `update_check_result`):
/// the newest qualifying release. Empty when nothing newer was seen. The
/// check time lives in `update_check_last_at`, so a check with no news
/// still records when it ran.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedResult {
    latest: String,
    notes_url: String,
}

/// One dot-separated pre-release identifier: numeric identifiers order
/// numerically (`alpha.10` > `alpha.9`), never as strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrePart {
    Num(u64),
    Str(String),
}

impl Ord for PrePart {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            // Semver: numeric identifiers order below alphanumeric ones.
            (PrePart::Num(a), PrePart::Num(b)) => a.cmp(b),
            (PrePart::Str(a), PrePart::Str(b)) => a.cmp(b),
            (PrePart::Num(_), PrePart::Str(_)) => std::cmp::Ordering::Less,
            (PrePart::Str(_), PrePart::Num(_)) => std::cmp::Ordering::Greater,
        }
    }
}

impl PartialOrd for PrePart {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// A parsed release tag: `v` prefix and pre-release part optional.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVersion {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<PrePart>,
}

impl Ord for ParsedVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                // A final release outranks its own pre-releases.
                (true, true) => std::cmp::Ordering::Equal,
                (true, false) => std::cmp::Ordering::Greater,
                (false, true) => std::cmp::Ordering::Less,
                (false, false) => {
                    // A longer pre-release part wins when all shared parts
                    // are equal (`alpha.1` < `alpha.1.1`).
                    for pair in self.pre.iter().zip(other.pre.iter()) {
                        let order = pair.0.cmp(pair.1);
                        if order != std::cmp::Ordering::Equal {
                            return order;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for ParsedVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Parse a release tag (`v0.1.0-alpha.9` or `0.1.0-alpha.9`). `None` for
/// anything that is not a dotted numeric version — unparseable tags never
/// notify.
pub fn parse_version(tag: &str) -> Option<ParsedVersion> {
    let tag = tag.strip_prefix('v').unwrap_or(tag);
    let (core, pre) = match tag.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (tag, None),
    };
    // Build tags (`noite-a1b2c3d`, `edge`) and empty parts are not versions.
    if core.is_empty() || core.split('.').any(str::is_empty) {
        return None;
    }
    let mut numbers = Vec::with_capacity(3);
    for part in core.split('.') {
        numbers.push(part.parse::<u64>().ok()?);
    }
    if numbers.len() != 3 {
        return None;
    }
    let pre = match pre {
        None => Vec::new(),
        Some(pre) => pre
            .split('.')
            .map(|part| {
                if part.is_empty() {
                    None
                } else if let Ok(n) = part.parse::<u64>() {
                    Some(PrePart::Num(n))
                } else {
                    Some(PrePart::Str(part.to_string()))
                }
            })
            .collect::<Option<Vec<_>>>()?,
    };
    Some(ParsedVersion {
        major: numbers[0],
        minor: numbers[1],
        patch: numbers[2],
        pre,
    })
}

/// Whether the running version never notifies: `dev` (a source checkout,
/// including empty/unset) or a bare SHA build.
pub fn is_dev_build(version: &str) -> bool {
    let version = version.trim();
    if version.is_empty() || version == "dev" {
        return true;
    }
    // A bare commit SHA: 7-40 hex chars with no version punctuation.
    (7..=40).contains(&version.len()) && version.chars().all(|c| c.is_ascii_hexdigit())
}

/// The newest release the install should hear about: drafts are ignored
/// always, GitHub pre-releases are not yet promoted so they never count, and
/// a stable install (a final running version) only hears about finals — an
/// alpha install hears about every promoted release (SPEC, release
/// channels). `None` when nothing newer qualifies, the build is dev, or the
/// running version is unparseable.
pub fn select_update<'a>(current: &str, releases: &'a [Release]) -> Option<&'a Release> {
    if is_dev_build(current) {
        return None;
    }
    let running = parse_version(current)?;
    let stable_install = running.pre.is_empty();
    let mut best: Option<(&'a Release, ParsedVersion)> = None;
    for release in releases {
        if release.draft || release.prerelease {
            continue;
        }
        let Some(version) = parse_version(&release.tag) else {
            continue;
        };
        if stable_install && !version.pre.is_empty() {
            continue;
        }
        if version > running && best.as_ref().is_none_or(|(_, v)| version > *v) {
            best = Some((release, version));
        }
    }
    best.map(|(release, _)| release)
}

/// Whether a tick at `now` fetches: the preference is on, nothing locks it,
/// and the last successful check is absent or at least a day old. Locked
/// beats everything, including a due window.
pub fn should_check(
    now: DateTime<Utc>,
    last_check: Option<DateTime<Utc>>,
    enabled: bool,
    locked: bool,
) -> bool {
    if locked || !enabled {
        return false;
    }
    match last_check {
        None => true,
        Some(at) => now.signed_duration_since(at) >= chrono::Duration::hours(CHECK_AFTER_HOURS),
    }
}

/// Whether a tick at `now` is due: the stored preference (absent = on — the
/// check is opt-out), the env lock, and the last successful check. No network.
pub async fn due(pool: &SqlitePool, cfg: &Config, now: DateTime<Utc>) -> sqlx::Result<bool> {
    let stored = db::get_setting(pool, db::UPDATE_CHECK_ENABLED).await?;
    let enabled = stored.as_deref() != Some("0");
    let last_check = db::get_setting(pool, db::UPDATE_CHECK_LAST_AT)
        .await?
        .and_then(|raw| parse_iso(&raw));
    Ok(should_check(
        now,
        last_check,
        enabled,
        cfg.update_check_lock_reason().is_some(),
    ))
}

/// The release-list URL: the fixed public list, unless the test-only
/// override is set on a local/dev domain (the e2e lane).
pub fn releases_url(cfg: &Config) -> String {
    if let Some(url) = non_empty_env(OVERRIDE_ENV) {
        if crate::config::is_local_domain(&cfg.base_domain) {
            return url;
        }
        tracing::debug!("ignoring {OVERRIDE_ENV} on a public domain");
    }
    RELEASES_URL.to_string()
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// GET the release list: fixed URL, fixed User-Agent, no auth, no instance
/// data. The timeout bounds the one network leg.
pub async fn fetch_releases(client: &reqwest::Client, url: &str) -> anyhow::Result<Vec<Release>> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("update check fetch failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("update check answered {status}");
    }
    let text = response
        .text()
        .await
        .map_err(|e| anyhow::anyhow!("update check body unreadable: {e}"))?;
    parse_releases(&text)
}

/// Decode one release-list body. Unknown fields are ignored; a body that is
/// not a list (an HTML error page, a rate-limit object) is an error.
pub fn parse_releases(text: &str) -> anyhow::Result<Vec<Release>> {
    serde_json::from_str(text).map_err(|e| anyhow::anyhow!("update check list unreadable: {e}"))
}

/// Store a fetch outcome: a success caches the newest qualifying release (or
/// clears a stale one) with its fetch time; a failure is a debug log and
/// keeps the last result.
pub async fn apply_fetch(
    pool: &SqlitePool,
    now: DateTime<Utc>,
    current: &str,
    fetched: anyhow::Result<Vec<Release>>,
) {
    let releases = match fetched {
        Ok(releases) => releases,
        Err(e) => {
            tracing::debug!(error = %e, "update check failed; keeping the last result");
            return;
        }
    };
    let stamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    if let Err(e) = db::set_setting(pool, db::UPDATE_CHECK_LAST_AT, &stamp).await {
        tracing::warn!(error = %e, "update check: could not record the check");
        return;
    }
    let cached = select_update(current, &releases).map(|release| CachedResult {
        latest: release.tag.clone(),
        notes_url: release.html_url.clone(),
    });
    let write = match &cached {
        Some(result) => serde_json::to_string(result).expect("cached result serializes"),
        None => String::new(),
    };
    if let Err(e) = db::set_setting(pool, db::UPDATE_CHECK_RESULT, &write).await {
        tracing::warn!(error = %e, "update check: could not cache the result");
    }
}

/// One scheduler tick: fetch only when due, through the injected fetch (tests
/// pass a stub and assert whether it was called).
pub async fn tick<F, Fut>(pool: &SqlitePool, cfg: &Config, now: DateTime<Utc>, fetch: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<Release>>>,
{
    match due(pool, cfg, now).await {
        Ok(true) => {
            let current = crate::host::telemetry_report::build_version();
            apply_fetch(pool, now, &current, fetch().await).await;
        }
        Ok(false) => {}
        Err(e) => tracing::warn!(error = %e, "update check: state"),
    }
}

/// One immediate check, ignoring the daily gate: the "once at enable" fetch.
/// A failure keeps the last result, like every other fetch.
pub async fn check_now<F, Fut>(pool: &SqlitePool, now: DateTime<Utc>, fetch: F)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<Vec<Release>>>,
{
    let current = crate::host::telemetry_report::build_version();
    apply_fetch(pool, now, &current, fetch().await).await;
}

fn http_client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| anyhow::anyhow!("update check http client: {e}"))
}

/// The status behind `instance.update_status`: stored preference, env lock,
/// running version, and the cached newest release.
pub async fn status(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<UpdateStatus> {
    let stored = db::get_setting(pool, db::UPDATE_CHECK_ENABLED).await?;
    let setting = stored.as_deref() != Some("0");
    let lock_reason = cfg.update_check_lock_reason().map(str::to_string);
    let cached: Option<CachedResult> = db::get_setting(pool, db::UPDATE_CHECK_RESULT)
        .await?
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(UpdateStatus {
        enabled: setting && lock_reason.is_none(),
        setting,
        locked: lock_reason.is_some(),
        lock_reason,
        current: crate::host::telemetry_report::build_version(),
        latest: cached.as_ref().map(|c| c.latest.clone()),
        checked_at: db::get_setting(pool, db::UPDATE_CHECK_LAST_AT).await?,
        notes_url: cached.as_ref().map(|c| c.notes_url.clone()),
    })
}

/// The enable-time fetch: store the preference, then check once right away
/// (bounded by the fetch timeout) when the check is effectively on.
pub async fn set(pool: &SqlitePool, cfg: &Config, enabled: bool) -> anyhow::Result<UpdateStatus> {
    let stored = if enabled { "1" } else { "0" };
    db::set_setting(pool, db::UPDATE_CHECK_ENABLED, stored).await?;
    if enabled && cfg.update_check_lock_reason().is_none() {
        match http_client() {
            Ok(client) => {
                let url = releases_url(cfg);
                check_now(pool, Utc::now(), || fetch_releases(&client, &url)).await;
            }
            Err(e) => tracing::debug!(error = %e, "update check: no http client at enable"),
        }
    }
    self::status(pool, cfg).await
}

/// The update-check task: first attempt five minutes after boot, then hourly
/// checks. Spawned after the REST listener binds, off the boot critical
/// path; a failed fetch is retried at the next tick and nothing about it is
/// fatal.
pub async fn run_scheduler(pool: SqlitePool, cfg: Arc<Config>) {
    let client = match http_client() {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(error = %e, "update check: http client");
            return;
        }
    };
    tokio::time::sleep(FIRST_CHECK_DELAY).await;
    loop {
        let now = Utc::now();
        let url = releases_url(&cfg);
        tick(&pool, &cfg, now, || fetch_releases(&client, &url)).await;
        tokio::time::sleep(CHECK_INTERVAL).await;
    }
}

/// An RFC3339 stamp as UTC; an unparsable one (hand-edited row) reads as
/// never.
fn parse_iso(raw: &str) -> Option<DateTime<Utc>> {
    raw.parse::<DateTime<Utc>>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn releases() -> Vec<Release> {
        vec![
            Release::test("v0.1.0-alpha.7", false, false),
            Release::test("v0.1.0-alpha.8", false, false),
            Release::test("v0.1.0-alpha.9", false, false),
            Release::test("v0.1.0-alpha.10", false, false),
        ]
    }

    #[test]
    fn alpha_numbers_order_numerically_not_lexically() {
        let nine = parse_version("v0.1.0-alpha.9").expect("parses");
        let ten = parse_version("v0.1.0-alpha.10").expect("parses");
        assert!(ten > nine, "alpha.10 outranks alpha.9");
        assert!(nine < ten, "alpha.9 ranks below alpha.10");
        assert_eq!(
            parse_version("0.1.0-alpha.9"),
            parse_version("v0.1.0-alpha.9")
        );
    }

    #[test]
    fn finals_outrank_their_own_prereleases() {
        let pre = parse_version("0.1.0-alpha.10").expect("parses");
        let final_ = parse_version("0.1.0").expect("parses");
        let next = parse_version("0.1.1-alpha.1").expect("parses");
        assert!(final_ > pre, "a final outranks its own pre-releases");
        assert!(next > final_, "the next pre-release outranks the final");
    }

    #[test]
    fn unparseable_tags_never_parse() {
        for tag in [
            "",
            "dev",
            "latest",
            "v1.2",
            "0.1.0-alpha.",
            "noite-a1b2c3d",
            "edge",
        ] {
            assert!(parse_version(tag).is_none(), "{tag:?} is not a version");
        }
    }

    #[test]
    fn dev_and_sha_builds_never_notify() {
        for build in [
            "dev",
            "",
            "  ",
            "a1b2c3d",
            "9f3a1b2c4d5e6f7890123456789abcdef1234567",
        ] {
            assert!(is_dev_build(build), "{build:?} is a dev build");
            assert!(
                select_update(build, &releases()).is_none(),
                "{build:?} never selects an update"
            );
        }
        assert!(!is_dev_build("0.1.0-alpha.8"), "a release build is not dev");
        assert!(!is_dev_build("0.1.0"), "a final build is not dev");
    }

    #[test]
    fn unpromoted_releases_never_notify() {
        let current = "0.1.0-alpha.8";
        // A newer draft, a newer unpromoted (GitHub pre-release) entry and a
        // build tag must not notify; the newest *promoted* one wins.
        let feed = vec![
            Release::test("v0.1.0-alpha.9", true, false),
            Release::test("v0.1.0-alpha.10", false, true),
            Release::test("v0.1.0-alpha.11", false, true),
            Release::test("v0.1.0-alpha.9", false, false),
        ];
        let selected = select_update(current, &feed).expect("a promoted release qualifies");
        assert_eq!(selected.tag, "v0.1.0-alpha.9");
    }

    #[test]
    fn newest_promoted_release_wins() {
        let feed = releases();
        let selected = select_update("0.1.0-alpha.8", &feed).expect("an update exists");
        assert_eq!(selected.tag, "v0.1.0-alpha.10");
        assert!(select_update("0.1.0-alpha.10", &feed).is_none());
        assert!(select_update("0.2.0", &feed).is_none());
    }

    #[test]
    fn stable_installs_only_hear_about_finals() {
        let feed = vec![
            Release::test("v0.2.1-alpha.1", false, false),
            Release::test("v0.2.1", false, false),
        ];
        let selected = select_update("0.2.0", &feed).expect("the final qualifies");
        assert_eq!(selected.tag, "v0.2.1");
        let pre_only = vec![Release::test("v0.2.1-alpha.1", false, false)];
        assert!(
            select_update("0.2.0", &pre_only).is_none(),
            "a stable install ignores promoted pre-releases"
        );
        // An alpha install hears about every promoted release, finals included.
        let selected = select_update("0.1.0-alpha.8", &feed).expect("alpha hears about finals");
        assert_eq!(selected.tag, "v0.2.1");
    }

    #[test]
    fn garbage_running_version_never_notifies() {
        assert!(select_update("nope", &releases()).is_none());
    }

    #[test]
    fn check_gate_is_daily_and_locked_beats_due() {
        let now = Utc::now();
        assert!(should_check(now, None, true, false), "first check is due");
        let recent = now - chrono::Duration::hours(23);
        assert!(
            !should_check(now, Some(recent), true, false),
            "23h is not due"
        );
        let stale = now - chrono::Duration::hours(25);
        assert!(should_check(now, Some(stale), true, false), "25h is due");
        assert!(
            !should_check(now, None, false, false),
            "disabled never fetches"
        );
        assert!(
            !should_check(now, Some(stale), false, false),
            "disabled never fetches"
        );
        assert!(
            !should_check(now, None, true, true),
            "locked beats a due window"
        );
    }

    async fn memory_pool() -> SqlitePool {
        crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db")
    }

    #[tokio::test]
    async fn fresh_install_checks_once_with_nothing_stored() {
        // Opt-out: no setting row, yet the first tick fetches — and the
        // second tick the same day stays quiet.
        let pool = memory_pool().await;
        let cfg = crate::config::config_for_tests();
        let calls = Arc::new(AtomicUsize::new(0));
        let now = Utc::now();
        for _ in 0..2 {
            let seen = Arc::clone(&calls);
            tick(&pool, &cfg, now, || {
                seen.fetch_add(1, Ordering::SeqCst);
                async { Ok(releases()) }
            })
            .await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1, "one check a day");
        let status = self::status(&pool, &cfg).await.expect("status");
        assert!(status.enabled, "absent preference is on");
        assert!(status.setting, "absent preference reads as on");
        // Tests run a source checkout (`dev`), which never shows a notice —
        // but the fetch still ran and was recorded.
        assert_eq!(status.latest, None, "a dev build shows no notice");
        assert!(status.checked_at.is_some(), "the check was recorded");
        pool.close().await;
    }

    #[tokio::test]
    async fn toggle_off_stops_further_checks() {
        let pool = memory_pool().await;
        db::set_setting(&pool, db::UPDATE_CHECK_ENABLED, "0")
            .await
            .expect("disable");
        let cfg = crate::config::config_for_tests();
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        tick(&pool, &cfg, Utc::now(), || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { Ok(releases()) }
        })
        .await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "opted out means no request"
        );
        let status = self::status(&pool, &cfg).await.expect("status");
        assert!(!status.enabled, "the toggle turns the check off");
        assert!(!status.setting, "the stored preference is off");
        assert_eq!(status.checked_at, None, "nothing was ever checked");
        pool.close().await;
    }

    #[tokio::test]
    async fn tick_makes_no_request_when_locked() {
        // `NOITE_UPDATE_CHECK=off` means no request ever — not even with
        // nothing stored (the default-on preference loses to the lock).
        let pool = memory_pool().await;
        let mut cfg = crate::config::config_for_tests();
        cfg.update_check_disabled = true;
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&calls);
        tick(&pool, &cfg, Utc::now(), || {
            seen.fetch_add(1, Ordering::SeqCst);
            async { Ok(releases()) }
        })
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), 0, "locked means no request");
        let status = self::status(&pool, &cfg).await.expect("status");
        assert!(
            !status.enabled,
            "the lock wins over the default-on preference"
        );
        assert!(status.setting, "the stored preference still reads on");
        assert_eq!(
            status.lock_reason.as_deref(),
            Some("NOITE_UPDATE_CHECK=off")
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn failure_keeps_the_last_result() {
        let pool = memory_pool().await;
        let now = Utc::now();
        // Seed a good result, then fail: the cache and its time survive.
        apply_fetch(&pool, now, "0.1.0-alpha.8", Ok(releases())).await;
        let before = db::get_setting(&pool, db::UPDATE_CHECK_RESULT)
            .await
            .expect("read");
        let before_at = db::get_setting(&pool, db::UPDATE_CHECK_LAST_AT)
            .await
            .expect("read");
        apply_fetch(
            &pool,
            now + chrono::Duration::hours(25),
            "0.1.0-alpha.8",
            Err(anyhow::anyhow!("boom")),
        )
        .await;
        assert_eq!(
            db::get_setting(&pool, db::UPDATE_CHECK_RESULT)
                .await
                .expect("read"),
            before
        );
        assert_eq!(
            db::get_setting(&pool, db::UPDATE_CHECK_LAST_AT)
                .await
                .expect("read"),
            before_at
        );
        let cached: serde_json::Value =
            serde_json::from_str(&before.expect("seeded")).expect("cached json");
        assert_eq!(cached["latest"], "v0.1.0-alpha.10");
        pool.close().await;
    }

    #[tokio::test]
    async fn nothing_newer_clears_a_stale_notice() {
        let pool = memory_pool().await;
        let now = Utc::now();
        apply_fetch(&pool, now, "0.1.0-alpha.8", Ok(releases())).await;
        let cfg = crate::config::config_for_tests();
        let status = self::status(&pool, &cfg).await.expect("status");
        assert_eq!(status.latest.as_deref(), Some("v0.1.0-alpha.10"));
        assert!(status
            .notes_url
            .as_deref()
            .is_some_and(|u| u.contains("alpha.10")));
        // Caught up: the notice clears.
        apply_fetch(&pool, now, "0.1.0-alpha.10", Ok(releases())).await;
        let status = self::status(&pool, &cfg).await.expect("status");
        assert_eq!(status.latest, None, "no newer release, no notice");
        pool.close().await;
    }

    #[test]
    fn github_bodies_decode_and_non_lists_fail() {
        let body = r#"[{"tag_name":"v0.1.0-alpha.9","draft":false,"prerelease":false,"html_url":"https://github.com/ryuzcorp/noite/releases/tag/v0.1.0-alpha.9","published_at":"2026-10-21T00:00:00Z","extra":true}]"#;
        let releases = parse_releases(body).expect("decodes");
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag, "v0.1.0-alpha.9");
        assert!(parse_releases(r#"{"message":"rate limited"}"#).is_err());
        assert!(parse_releases("<html>nope</html>").is_err());
    }

    #[test]
    fn override_url_is_local_only() {
        let local = crate::config::config_for_tests();
        assert_eq!(local.base_domain, "localhost");
        // NOTE: this mutates process env; restored before returning so no
        // other test in the process sees the override.
        std::env::set_var(OVERRIDE_ENV, "http://127.0.0.1:9/stub");
        assert_eq!(releases_url(&local), "http://127.0.0.1:9/stub");
        let mut public = local.clone();
        public.base_domain = "noite.now".to_string();
        assert_eq!(releases_url(&public), RELEASES_URL);
        std::env::remove_var(OVERRIDE_ENV);
        assert_eq!(releases_url(&local), RELEASES_URL);
    }

    /// One-shot stub release feed: serves `body` to a single connection and
    /// hands back the raw request for header assertions.
    fn stub_feed(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("stub binds");
        let addr = listener.local_addr().expect("stub addr");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("one connection");
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .ok();
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&chunk[..n]);
                        if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            tx.send(String::from_utf8_lossy(&raw).into_owned()).ok();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).ok();
        });
        (format!("http://{addr}/releases"), rx)
    }

    #[tokio::test]
    async fn fetch_uses_a_fixed_user_agent_and_no_auth() {
        let body = r#"[{"tag_name":"v0.1.0-alpha.9","draft":false,"prerelease":false,"html_url":"https://example.invalid/notes","published_at":"2026-10-21T00:00:00Z"}]"#;
        let (url, request) = stub_feed(body);
        let client = http_client().expect("client");
        let releases = fetch_releases(&client, &url).await.expect("stub feed");
        assert_eq!(releases.len(), 1);
        assert_eq!(releases[0].tag, "v0.1.0-alpha.9");
        let seen = request
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("request");
        assert!(
            seen.contains("noite-update-check"),
            "fixed User-Agent: {seen}"
        );
        assert!(
            !seen.to_ascii_lowercase().contains("authorization"),
            "no auth: {seen}"
        );
    }

    #[tokio::test]
    async fn check_now_caches_through_a_stub_fetch() {
        let pool = memory_pool().await;
        let now = Utc::now();
        check_now(&pool, now, || async { Ok(releases()) }).await;
        let cfg = crate::config::config_for_tests();
        let status = self::status(&pool, &cfg).await.expect("status");
        // Tests run a source checkout (`dev`): no notice, but the check ran.
        assert_eq!(status.latest, None);
        assert_eq!(
            status.checked_at,
            db::get_setting(&pool, db::UPDATE_CHECK_LAST_AT)
                .await
                .expect("read"),
            "the enable-time check is recorded"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn set_stores_the_preference_even_when_the_fetch_fails() {
        let pool = memory_pool().await;
        let cfg = crate::config::config_for_tests();
        // The enable-time fetch runs against the real list (or fails without
        // network); either way the preference is stored and a dev build
        // shows no notice.
        let status = self::set(&pool, &cfg, true).await.expect("set");
        assert!(status.setting, "preference stored");
        assert!(status.enabled, "test config is not locked");
        assert_eq!(status.latest, None, "a dev build never shows a notice");
        assert_eq!(
            db::get_setting(&pool, db::UPDATE_CHECK_ENABLED)
                .await
                .expect("read"),
            Some("1".to_string())
        );
        pool.close().await;
    }
}
