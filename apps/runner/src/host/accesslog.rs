//! Device breakdown from the Caddy access log.
//!
//! Caddy appends one JSON line per request to the file next to the Caddyfile
//! (see caddy.rs `push_block`). Each reconcile tick consumes new lines,
//! attributes tenant hosts to apps, classifies the User-Agent into a
//! (browser, os) pair, and accumulates hour buckets in SQLite.
//!
//! Privacy: only the classified pair is stored — raw user-agents and
//! client IPs never leave this module (neither is parsed).
//!
//! Offset tracking survives restarts via a sidecar file next to the log
//! (`access-log.offset`, holding `ino:off`). Caddy opens the log O_APPEND,
//! so truncating below can't strand its file offset; truncation still only
//! fires when the size is unchanged since the read, closing the usual race.
use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::edge::parse_edge_slug;

/// Log lines are tiny; past this the file is truncated after consuming.
const TRUNCATE_BYTES: u64 = 2 * 1024 * 1024;
/// Burst guard: past this, skip to the end rather than buffering it all.
const MAX_CATCHUP_BYTES: u64 = 8 * 1024 * 1024;

/// Caddy writes here (its view of the shared volume); the runner reads the
/// same file. Single source of truth is `CADDY_ACCESS_LOG`.
pub fn access_log_path(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.caddy_access_log)
}

fn offset_path(cfg: &Config) -> PathBuf {
    // Legacy name kept so upgrades don't re-ingest the whole file.
    std::path::Path::new(&cfg.caddy_access_log)
        .parent()
        .map(|p| p.join("access-log.offset"))
        .unwrap_or_else(|| PathBuf::from("access-log.offset"))
}

/// Coarse (browser, os) pair for a User-Agent. Order matters: mobile UAs
/// carry desktop browser tokens (Chrome UAs contain `Safari`, Edge contains
/// `Chrome`), and iPads in desktop mode are indistinguishable from Macs —
/// they count as macOS, a known blind spot of server-side detection.
/// Anything unrecognized keeps a non-empty browser (`Other`, `Bot`, `CLI`,
/// `Unknown`) with an empty os, so grouping never drops rows.
pub fn device_classify(ua: &str) -> (&'static str, &'static str) {
    let u = ua.to_lowercase();
    if u.trim().is_empty() {
        return ("Unknown", "");
    }
    if u.contains("bot")
        || u.contains("crawl")
        || u.contains("spider")
        || u.contains("slurp")
        || u.contains("mediapartners")
    {
        return ("Bot", "");
    }
    if u.contains("curl")
        || u.contains("wget")
        || u.contains("python")
        || u.contains("go-http")
        || u.contains("axios")
        || u.contains("httpie")
    {
        return ("CLI", "");
    }
    if u.contains("iphone") || u.contains("ipad") || u.contains("ipod") {
        let browser = if u.contains("crios") {
            "Chrome"
        } else if u.contains("fxios") {
            "Firefox"
        } else if u.contains("edgios") {
            "Edge"
        } else {
            "Safari"
        };
        return (browser, "iOS");
    }
    if u.contains("android") {
        let browser = if u.contains("edga") {
            "Edge"
        } else if u.contains("opr/") {
            "Opera"
        } else if u.contains("firefox") {
            "Firefox"
        } else if u.contains("samsungbrowser") {
            "Samsung"
        } else if u.contains("chrome") {
            "Chrome"
        } else {
            "Other"
        };
        return (browser, "Android");
    }
    let browser = if u.contains("edg/") {
        "Edge"
    } else if u.contains("opr/") || u.contains("opera mini") {
        "Opera"
    } else if u.contains("firefox") {
        "Firefox"
    } else if u.contains("chrome") || u.contains("crios") {
        "Chrome"
    } else if u.contains("safari") {
        "Safari"
    } else {
        return ("Other", "");
    };
    let os = if u.contains("windows") {
        "Windows"
    } else if u.contains("cros") {
        "ChromeOS"
    } else if u.contains("macintosh") || u.contains("mac os") {
        "macOS"
    } else if u.contains("linux") {
        "Linux"
    } else {
        return (browser, "");
    };
    (browser, os)
}

fn hour_bucket(ts_secs: i64) -> String {
    DateTime::<Utc>::from_timestamp(ts_secs, 0)
        .map(|d| d.format("%Y-%m-%dT%H:00:00Z").to_string())
        .unwrap_or_else(|| {
            Utc::now()
                .format("%Y-%m-%dT%H:00:00Z")
                .to_string()
        })
}

/// Request path with the query string stripped. Over-long paths (scan
/// noise) are rejected upstream by length.
fn split_path(uri: &str) -> &str {
    let path = uri.split('?').next().unwrap_or("/");
    if path.is_empty() {
        "/"
    } else {
        path
    }
}

/// Social networks and search engines served by name; everything else keeps
/// its bare host (paths and queries never stored — they can carry tokens).
/// Empty referrer (typed URL, bookmark, in-app navigation) is Direct.
fn ref_source(referrer: &str) -> String {
    let lower = referrer.trim().to_lowercase();
    if lower.is_empty() {
        return "Direct".to_string();
    }
    let host = lower
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(&lower);
    let host = host.split('/').next().unwrap_or(host);
    let host = host.split('@').next_back().unwrap_or(host);
    let host = host.split_once(':').map(|(h, _)| h).unwrap_or(host);
    const DOMAINS: &[(&str, &str)] = &[
        ("facebook.com", "Facebook"),
        ("fb.com", "Facebook"),
        ("fb.watch", "Facebook"),
        ("messenger.com", "Facebook"),
        ("instagram.com", "Instagram"),
        ("threads.com", "Threads"),
        ("threads.net", "Threads"),
        ("twitter.com", "X"),
        ("x.com", "X"),
        ("t.co", "X"),
        ("tiktok.com", "TikTok"),
        ("linkedin.com", "LinkedIn"),
        ("youtube.com", "YouTube"),
        ("youtu.be", "YouTube"),
        ("reddit.com", "Reddit"),
        ("pinterest.com", "Pinterest"),
        ("snapchat.com", "Snapchat"),
        ("whatsapp.com", "WhatsApp"),
        ("wa.me", "WhatsApp"),
        ("t.me", "Telegram"),
        ("discord.com", "Discord"),
        ("bsky.app", "Bluesky"),
        ("bing.com", "Bing"),
        ("duckduckgo.com", "DuckDuckGo"),
        ("baidu.com", "Baidu"),
        ("ecosia.org", "Ecosia"),
        ("search.brave.com", "Brave"),
    ];
    // Single-segment keys match any dot-separated segment — this is how
    // multi-TLD names (google.*, yahoo.*, yandex.*) work. Full-domain
    // matching above stays exact-or-dot-suffix, so `x.com` never matches
    // `x.company.com`.
    const SEGMENTS: &[(&str, &str)] = &[
        ("google", "Google"),
        ("yahoo", "Yahoo"),
        ("yandex", "Yandex"),
    ];
    for (key, label) in DOMAINS {
        if host == *key || host.ends_with(&format!(".{key}")) {
            return label.to_string();
        }
    }
    for seg in host.split('.') {
        if let Some((_, label)) = SEGMENTS.iter().find(|(k, _)| seg == *k) {
            return label.to_string();
        }
    }
    host.chars().take(64).collect()
}

/// One parsed line: (app_id, hour bucket, browser, os, path, ref source).
fn parse_line(
    line: &str,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
) -> Option<(String, String, &'static str, &'static str, String, String)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let host = v
        .pointer("/request/host")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let slug = parse_edge_slug(host, &cfg.tenant_bases(), &cfg.control_subdomain)?;
    let app_id = slug_id.get(&slug)?.clone();
    let ua = first_header(&v, "User-Agent");
    let uri = v
        .pointer("/request/uri")
        .and_then(|x| x.as_str())
        .unwrap_or("/");
    let path = split_path(uri);
    if path.len() > 256 {
        return None;
    }
    let source = ref_source(first_header(&v, "Referer"));
    let ts = v.pointer("/ts").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
    let (browser, os) = device_classify(ua);
    Some((
        app_id,
        hour_bucket(ts),
        browser,
        os,
        path.to_string(),
        source,
    ))
}

/// First value of a Caddy JSON header (arrays) or the plain string.
fn first_header<'a>(v: &'a serde_json::Value, name: &str) -> &'a str {
    v.pointer(&format!("/request/headers/{name}"))
        .map(|h| {
            if let Some(arr) = h.as_array() {
                arr.first().and_then(|x| x.as_str()).unwrap_or("")
            } else {
                h.as_str().unwrap_or("")
            }
        })
        .unwrap_or("")
}

fn read_offset(path: &std::path::Path) -> (u64, u64) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let (ino, off) = text.trim().split_once(':').unwrap_or(("", ""));
    (
        ino.parse().unwrap_or(0),
        off.parse().unwrap_or(0),
    )
}

/// Consume new access-log lines into device stats. Never fails the tick:
/// a missing log (Caddy not yet reloaded) is a silent skip.
pub async fn tick(
    pool: &SqlitePool,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let path = access_log_path(cfg);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let (saved_ino, mut off) = read_offset(&offset_path(cfg));
    if saved_ino != 0 && saved_ino != meta.ino() {
        off = 0;
    }
    let len = meta.len();
    if off > len {
        off = 0;
    }
    if off == len {
        return Ok(());
    }
    if len - off > MAX_CATCHUP_BYTES {
        tracing::warn!(skipped = len - off, "access log burst skipped");
        off = len;
    }
    let bytes = std::fs::read(&path)?;
    let mut consumed = 0usize;
    for line in bytes[off as usize..].split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        consumed += line.len() + 1;
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        if let Some((app_id, bucket, browser, os, path, source)) = parse_line(text, cfg, slug_id) {
            db::add_app_device(pool, &app_id, &bucket, browser, os).await?;
            db::add_app_path(pool, &app_id, &bucket, &path).await?;
            db::add_app_ref(pool, &app_id, &bucket, &source).await?;
        }
    }
    off += consumed as u64;
    let _ = std::fs::write(offset_path(cfg), format!("{}:{off}", meta.ino()));
    // Bound growth: truncate only when nothing was appended mid-tick.
    if len > TRUNCATE_BYTES && std::fs::metadata(&path).map(|m| m.len() == len).unwrap_or(false) {
        // File::create truncates in place: the inode survives, so the
        // saved offset resets to zero under the same inode.
        std::fs::File::create(&path)?;
        let _ = std::fs::write(offset_path(cfg), format!("{}:0", meta.ino()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_desktop_browsers() {
        assert_eq!(
            device_classify("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
            ("Chrome", "macOS")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15"),
            ("Safari", "macOS")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0"),
            ("Firefox", "Linux")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"),
            ("Edge", "Windows")
        );
    }

    #[test]
    fn classifies_mobile_browsers() {
        assert_eq!(
            device_classify("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1"),
            ("Safari", "iOS")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1"),
            ("Chrome", "iOS")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"),
            ("Chrome", "Android")
        );
        assert_eq!(
            device_classify("Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36"),
            ("Samsung", "Android")
        );
    }

    #[test]
    fn classifies_bots_cli_unknown_and_other() {
        assert_eq!(
            device_classify("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"),
            ("Bot", "")
        );
        assert_eq!(device_classify("curl/8.18.0"), ("CLI", ""));
        assert_eq!(device_classify(""), ("Unknown", ""));
        assert_eq!(device_classify("   "), ("Unknown", ""));
        assert_eq!(device_classify("MyCustomApp/2.0"), ("Other", ""));
    }

    #[test]
    fn strips_query_from_paths() {
        assert_eq!(split_path("/"), "/");
        assert_eq!(split_path(""), "/");
        assert_eq!(split_path("/about?ref=x&y=2"), "/about");
        assert_eq!(split_path("/a/b/c"), "/a/b/c");
    }

    #[test]
    fn classifies_referrer_sources() {
        assert_eq!(ref_source(""), "Direct");
        assert_eq!(ref_source("https://t.co/abc123"), "X");
        assert_eq!(
            ref_source("https://www.facebook.com/post/1?token=secret"),
            "Facebook"
        );
        assert_eq!(ref_source("https://m.instagram.com/x/"), "Instagram");
        assert_eq!(
            ref_source("https://www.google.com/search?q=noite"),
            "Google"
        );
        assert_eq!(ref_source("https://x.company.com/page"), "x.company.com");
        assert_eq!(
            ref_source("https://blog.example.com/post?utm=x"),
            "blog.example.com"
        );
    }
}
