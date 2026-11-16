//! Request feed from the Caddy access log.
//!
//! Caddy appends one JSON line per request to the file next to the Caddyfile
//! (see caddy.rs `push_block`). Each reconcile tick consumes new lines,
//! attributes tenant hosts to apps, and folds them into the fleet's hourly
//! counters (`metrics/hourly.rs`) and its per-dimension breakdown
//! (`metrics.app_hour_dim`): the status class, latency and timestamp inside
//! the line's own transaction, so a line is counted exactly once or not at
//! all. Only lines a fleet's own `reverse_proxy` answered count
//! ([`served_by_fleet`]) — a redirect, a gate refusal, an edge 429 or an
//! error page the edge rendered itself is not a request.
//!
//! Exactly-once is the transaction plus the cursor: a line's counters, its
//! four dimension upserts and its trace backfill commit in one transaction,
//! and the offset advances (and is persisted) only after that commit — so a
//! mid-loop DB error re-reads exactly the lines that were not applied, never
//! one that already was, and a retried line is all-or-nothing.
//!
//! The same line carries the trace → request join the error ingest backfills
//! with: a classified (browser, os) pair, the query-less path, method and
//! status. Privacy: raw user-agents and client IPs never leave this module
//! (neither is parsed), and the persisted breakdown keeps only classified
//! values — a coarse browser/OS name (an empty OS reads as `Other`), the
//! query-less path, and the referrer's bare host (named social/search
//! sources by name, empty as `Direct`); referrer paths and queries are never
//! stored, and each (app, environment, hour, kind) keeps at most 50 distinct
//! values before overflow counts under `(other)`.
//!
//! Offset tracking survives restarts via a sidecar file next to the log
//! (`access-log.offset`, holding `ino:off`). Caddy opens the log O_APPEND,
//! so truncating below can't strand its file offset; truncation still only
//! fires when the size is unchanged since the read, closing the usual race.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::edge::{parse_edge_slug, parse_env_host};
use crate::host::errors::{RequestCtx, RequestIndex};
use crate::host::metrics::hourly;
/// Log lines are tiny; past this the file is truncated after consuming.
const TRUNCATE_BYTES: u64 = 2 * 1024 * 1024;
/// Burst guard: past this, scan the skipped bytes for their fleets and jump
/// to the end, rather than buffering it all.
const MAX_CATCHUP_BYTES: u64 = 8 * 1024 * 1024;
/// The burst scan streams the skipped region through this chunk: it never
/// holds more than one chunk plus one bounded line prefix, however large the
/// burst is.
const SCAN_CHUNK_BYTES: usize = 64 * 1024;
/// A line's host lives in its first bytes — Caddy's default JSON access log
/// writes the fixed envelope (`level`, `ts`, `logger`, `msg`) then
/// `request.remote_ip/remote_port/client_ip/proto/method/host`, so
/// `request.host` lands within a few hundred bytes and the header block (the
/// part header inflation bloats) only follows `uri`. An over-long line still
/// attributes from this prefix; the rest is skipped without buffering.
const SCAN_LINE_PREFIX_MAX: usize = 8 * 1024;
/// Caddy writes here (its view of the shared volume); the runner reads the
/// same file. Single source of truth is `CADDY_ACCESS_LOG`.
pub fn access_log_path(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.caddy_access_log)
}

fn offset_path(cfg: &Config) -> PathBuf {
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
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%dT%H:00:00Z").to_string())
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

/// One parsed tenant line.
struct Line {
    app_id: String,
    environment_id: String,
    bucket: String,
    /// Classified browser/OS for the breakdown (and the trace join below).
    /// An empty os reads as `Other` at write time, so grouping never drops
    /// rows.
    browser: &'static str,
    os: &'static str,
    /// Query-less path (length-capped in `parse_line`) for the breakdown
    /// and the trace join.
    path: String,
    /// Referrer source for the breakdown: a named source, the bare host, or
    /// `Direct` — never a path or query.
    source: String,
    /// The request's own start, in epoch microseconds (the log's `ts`): the
    /// hourly counters key their bucket on it and keep the newest one for the
    /// sleep sweeper.
    ts_us: i64,
    /// Edge latency in milliseconds, when the line carries `duration`.
    /// Caddy always does; a line without it still counts as a request, just
    /// without a latency sample.
    duration_ms: Option<i64>,
    /// The edge's status class: 5xx is the error count the counters carry.
    error: bool,
    /// Whether the fleet's own `reverse_proxy` answered. Only these lines
    /// enter the hourly counters and the breakdown — see [`served_by_fleet`].
    served: bool,
    /// The `traceID` fleet sites log (`TENANT_TRACE` in the static edge
    /// config, `traceparent` on tenant/custom/env requests) with the request
    /// it names, for the error ingest (host/errors.rs). Non-fleet log lines
    /// carry no `traceID` (the log appender emits an empty value, which the
    /// parser filters).
    trace: Option<(String, RequestCtx)>,
}

/// True when a request's Host belongs to the control UI itself: the
/// `CONTROL_SUBDOMAIN` on any base domain, or a `CONTROL_EXTRA_HOSTS` entry.
/// `parse_edge_slug` already refuses these to keep them out of the tenant
/// space; the access-log tail uses this to attribute the control plane's own
/// traffic (its polling and SSE) to the reserved control key instead.
fn bare_host(host: &str) -> String {
    host.split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host)
        .trim()
        .to_lowercase()
}

fn is_control_host(host: &str, control_hosts: &[String]) -> bool {
    let bare = bare_host(host);
    if bare.is_empty() {
        return false;
    }
    control_hosts
        .iter()
        .any(|candidate| candidate.trim().to_lowercase() == bare)
}

/// Whether the line's response came from the fleet's own `reverse_proxy`.
///
/// The static edge config appends three fields to every serving-site line
/// (see `host::caddy`): `noite_upstream` is the upstream the last
/// `reverse_proxy` chose, `noite_edge_upstream` is the fleet upstream the
/// route table picked, and `noite_edge_error` marks a `handle_errors` page.
/// A fleet answered only when a proxy ran, on exactly the route's upstream,
/// that upstream is not the runner's own API (the `fallback`/`env-parked`
/// route proxies to the runner there, and the table publishes the same
/// address as the route's upstream), and the edge did not render its own
/// error page. The tenant's own 4xx/5xx still counts: its fleet produced the
/// response. A redirect, a gate refusal (the hop's API upstream), an edge 429
/// (no proxy ran), a fallback answer and the starting page do not — otherwise
/// one unauthenticated request per sleep window could keep any idle app awake
/// and inflate its counters.
fn served_by_fleet(v: &serde_json::Value, cfg: &Config) -> bool {
    let field = |name: &str| {
        v.pointer(&format!("/{name}"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
    };
    let upstream = field("noite_upstream");
    !upstream.is_empty()
        && upstream == field("noite_edge_upstream")
        && field("noite_edge_error").is_empty()
        && upstream != cfg.caddy_api_upstream
}

fn parse_line(
    line: &str,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
    domain_id: &HashMap<String, String>,
) -> Option<Line> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let host = v
        .pointer("/request/host")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    // A tenant host resolves to the app's production fleet; an environment
    // host (`<label>.<slug>.<base>`) to that environment's fleet, whose
    // rows key on the environment id. Slugs never contain dots, so the two
    // parsers never claim the same host (edge.rs pins this).
    let (app_id, environment_id) = attribute_host(host, cfg, slug_id, slug_env, domain_id)?;
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
    let ts = v.pointer("/ts").and_then(|x| x.as_f64()).unwrap_or(0.0);
    let ts_us = (ts * 1_000_000.0) as i64;
    let status = v
        .pointer("/status")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    // Caddy logs `duration` in seconds (float). Keep it in whole milliseconds:
    // the histogram behind the percentiles is millisecond-scale.
    let duration_ms = v
        .pointer("/duration")
        .and_then(serde_json::Value::as_f64)
        .map(|secs| (secs * 1_000.0).round().max(0.0) as i64);
    let (browser, os) = device_classify(ua);
    let served = served_by_fleet(&v, cfg);
    let trace = v
        .pointer("/traceID")
        .and_then(|x| x.as_str())
        .filter(|t| !t.is_empty())
        .map(|t| {
            let method = v
                .pointer("/request/method")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .chars()
                .take(16)
                .collect();
            (
                t.to_string(),
                RequestCtx {
                    method,
                    path: path.to_string(),
                    status,
                    browser,
                    os,
                },
            )
        });
    Some(Line {
        app_id,
        environment_id,
        bucket: hour_bucket(ts as i64),
        browser,
        os,
        path: path.to_string(),
        source,
        ts_us,
        duration_ms,
        error: status >= 500,
        served,
        trace,
    })
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

/// A host's fleet: the production fleet for a tenant host, the
/// environment's fleet for an environment host, the reserved control key
/// for the control plane's own hosts, the owning app for a verified custom
/// domain — the same rules the consuming tail uses, so the burst scan
/// touches exactly the fleets the tail would have counted.
fn attribute_host(
    host: &str,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
    domain_id: &HashMap<String, String>,
) -> Option<(String, String)> {
    match parse_edge_slug(host, &cfg.tenant_bases(), &cfg.control_subdomain) {
        Some(slug) => Some((slug_id.get(&slug)?.clone(), String::new())),
        None => match parse_env_host(host, &cfg.tenant_bases()) {
            Some((slug, label)) => {
                let key = format!("{slug}.{label}");
                Some((slug_id.get(&key)?.clone(), slug_env.get(&key)?.clone()))
            }
            // The control UI's own requests — its polling and SSE — are real load
            // on the control node, so they land on the reserved control key the
            // metrics ingest also uses. `api.`/`git.` hosts stay out (the runner's
            // own edge is not a dashboard).
            None if is_control_host(host, &cfg.control_hosts()) => {
                Some((crate::host::control::SLUG.to_string(), String::new()))
            }
            // A verified custom domain is the app's own traffic, served by the
            // same edge: without this the counters (and the idle clock that reads
            // them) would see nothing for an app on its own hostname.
            None => Some((domain_id.get(&bare_host(host))?.clone(), String::new())),
        },
    }
}

/// The line's request host, found with a byte search for Caddy's JSON
/// `request.host` field — no JSON parse of the dropped burst. The first
/// occurrence wins: the fixed envelope before it carries no `host` key, and
/// attacker-controlled header values only follow it. Returns `None` for a
/// missing, empty, unterminated or badly escaped value; never panics.
fn scan_line_host(line: &[u8]) -> Option<String> {
    const NEEDLE: &[u8] = b"\"host\":\"";
    let mut pos = line.windows(NEEDLE.len()).position(|w| w == NEEDLE)? + NEEDLE.len();
    let mut out = Vec::new();
    while let Some(&b) = line.get(pos) {
        match b {
            b'"' => {
                return if out.is_empty() {
                    None
                } else {
                    String::from_utf8(out).ok()
                };
            }
            b'\\' => {
                pos += 1;
                out.push(*line.get(pos)?);
                pos += 1;
            }
            0x00..=0x1f => return None,
            _ => {
                out.push(b);
                pos += 1;
            }
        }
    }
    None
}

/// Stream-scan at most `limit` bytes for request hosts, holding never more
/// than one chunk plus one bounded line prefix: whole lines attribute from
/// their bytes, over-long lines from their prefix (the host precedes the
/// header block), and a trailing partial line stays unread — the consume
/// loop picks it up once its newline lands. Returns each distinct attributed
/// fleet once.
fn scan_skipped_hosts(
    reader: &mut impl std::io::Read,
    mut limit: u64,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
    domain_id: &HashMap<String, String>,
) -> anyhow::Result<HashSet<(String, String)>> {
    let mut found = HashSet::new();
    let mut chunk = vec![0u8; SCAN_CHUNK_BYTES];
    let mut prefix: Vec<u8> = Vec::new();
    let mut over_long = false;
    while limit > 0 {
        let want = (chunk.len() as u64).min(limit) as usize;
        let n = reader.read(&mut chunk[..want])?;
        if n == 0 {
            break;
        }
        limit -= n as u64;
        let mut start = 0;
        for (i, b) in chunk[..n].iter().enumerate() {
            if *b != b'\n' {
                continue;
            }
            if !over_long {
                prefix.extend_from_slice(&chunk[start..i]);
            }
            // Whole lines attribute from their bytes, over-long lines from
            // the capped prefix they left behind.
            if let Some(host) = scan_line_host(&prefix) {
                if let Some(target) = attribute_host(&host, cfg, slug_id, slug_env, domain_id) {
                    found.insert(target);
                }
            }
            prefix.clear();
            over_long = false;
            start = i + 1;
        }
        if start < n && !over_long {
            if prefix.len() + (n - start) > SCAN_LINE_PREFIX_MAX {
                let take = SCAN_LINE_PREFIX_MAX.saturating_sub(prefix.len());
                prefix.extend_from_slice(&chunk[start..start + take]);
                over_long = true;
            } else {
                prefix.extend_from_slice(&chunk[start..n]);
            }
        }
    }
    Ok(found)
}

/// Open the log at `pos` and stream-scan the next `len` bytes for request
/// hosts (see `scan_skipped_hosts`). A replaced file mid-scan just ends the
/// scan early; the cursor still jumps past the burst.
fn scan_skipped_region(
    path: &std::path::Path,
    pos: u64,
    len: u64,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
    domain_id: &HashMap<String, String>,
) -> anyhow::Result<HashSet<(String, String)>> {
    use std::io::Seek;
    let mut file = std::fs::File::open(path)?;
    file.seek(std::io::SeekFrom::Start(pos))?;
    scan_skipped_hosts(&mut file, len, cfg, slug_id, slug_env, domain_id)
}

/// The access-log tail cursor, persisted as the `ino:off` sidecar. The pair
/// is the whole state: an inode change or a shrink resets to `Fresh`, and a
/// corrupt sidecar reads as `Fresh`.
///
/// stateDiagram-v2
///   [*] --> Fresh
///   Fresh --> At: first consumed line
///   At --> At: line consumed
///   At --> Fresh: inode changed / file shrank / burst skipped
///   Fresh --> At: next consumed line
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OffsetState {
    Fresh,
    At { ino: u64, off: u64 },
}

impl OffsetState {
    fn read(path: &std::path::Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let (ino, off) = text.trim().split_once(':').unwrap_or(("", ""));
        match (ino.parse(), off.parse()) {
            (Ok(ino), Ok(off)) => Self::At { ino, off },
            _ => Self::Fresh,
        }
    }

    /// Apply the file's identity and length: a replaced or shrunk file starts
    /// over.
    fn resolved(self, ino: u64, len: u64) -> Self {
        match self {
            Self::At { ino: saved, off } if saved == ino && off <= len => Self::At { ino, off },
            _ => Self::At { ino, off: 0 },
        }
    }

    fn pos(self) -> u64 {
        match self {
            Self::Fresh => 0,
            Self::At { off, .. } => off,
        }
    }

    /// Advance past one consumed line (its bytes plus the newline).
    fn advance(self, ino: u64, bytes: u64) -> Self {
        Self::At {
            ino,
            off: self.pos() + bytes,
        }
    }

    /// Skip to the end (burst guard): the bytes are dropped, not counted.
    fn skipped_to(ino: u64, len: u64) -> Self {
        Self::At { ino, off: len }
    }

    fn persist(self, path: &std::path::Path) -> std::io::Result<()> {
        match self {
            Self::Fresh => std::fs::write(path, "0:0"),
            Self::At { ino, off } => std::fs::write(path, format!("{ino}:{off}")),
        }
    }
}

/// Walk whole lines from `cursor`, applying each and persisting the cursor
/// immediately after its rows commit. Stops at the first failure or at a
/// trailing partial line, so no persisted cursor ever claims a line whose
/// writes did not land.
struct Tail<'a> {
    pool: &'a SqlitePool,
    cfg: &'a Config,
    slug_id: &'a HashMap<String, String>,
    slug_env: &'a HashMap<String, String>,
    /// Verified custom `hostname → app_id`: the edge serves those hosts too, so
    /// their requests belong to the owning app.
    domain_id: &'a HashMap<String, String>,
    requests: &'a mut RequestIndex,
}

/// Commit one access-log line: the trace backfill, the fleet's hourly
/// counters and its four breakdown values in one transaction. A failed
/// statement or commit applies nothing, so the retried line is not counted
/// twice.
async fn apply_line(tail: &mut Tail<'_>, l: &Line) -> anyhow::Result<()> {
    let mut tx = tail.pool.begin().await?;
    if let Some((trace_id, ctx)) = &l.trace {
        db::backfill_trace_request(
            &mut tx,
            &l.app_id,
            &l.environment_id,
            &db::AccessTrace {
                trace_id,
                method: &ctx.method,
                path: &ctx.path,
                http_status: ctx.status,
                browser: ctx.browser,
                os: ctx.os,
                backfill: tail.requests.is_pending(trace_id),
            },
        )
        .await?;
    }
    // The hourly counters, the breakdown and the idle clock they feed are
    // fleet activity: an edge-answered line (redirect, gate refusal, 429,
    // starting page) neither served the app nor proves anyone used it.
    if l.served {
        hourly::record_request(
            &mut tx,
            hourly::Key {
                app_id: &l.app_id,
                environment_id: &l.environment_id,
                bucket_hour: &l.bucket,
            },
            l.ts_us,
            l.duration_ms,
            l.error,
        )
        .await?;
        // An empty OS is a real slice of traffic (`Other`, `Bot`, `CLI`);
        // the classifier reports it empty, and the breakdown names it.
        let os = if l.os.is_empty() { "Other" } else { l.os };
        db::record_hour_dims(
            &mut tx,
            &l.app_id,
            &l.environment_id,
            &l.bucket,
            &[
                (db::DimKind::Browser, l.browser),
                (db::DimKind::Os, os),
                (db::DimKind::Path, l.path.as_str()),
                (db::DimKind::Referrer, l.source.as_str()),
            ],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn consume_lines(
    tail: &mut Tail<'_>,
    bytes: &[u8],
    ino: u64,
    mut cursor: OffsetState,
    offset_file: &std::path::Path,
) -> anyhow::Result<OffsetState> {
    let mut pos = cursor.pos() as usize;
    while pos < bytes.len() {
        let rest = &bytes[pos..];
        // Only whole lines move the cursor: an in-flight append is read next
        // tick, not counted without its newline.
        let Some(nl) = rest.iter().position(|b| *b == b'\n') else {
            break;
        };
        let line = &rest[..nl];
        let advance_by = nl as u64 + 1;
        if let Ok(text) = std::str::from_utf8(line) {
            if !text.is_empty() {
                if let Some(l) =
                    parse_line(text, tail.cfg, tail.slug_id, tail.slug_env, tail.domain_id)
                {
                    apply_line(tail, &l).await?;
                    if let Some((trace_id, ctx)) = l.trace {
                        tail.requests.clear_pending(&trace_id);
                        tail.requests.insert(trace_id, ctx);
                    }
                }
            }
        }
        cursor = cursor.advance(ino, advance_by);
        cursor.persist(offset_file)?;
        pos += advance_by as usize;
    }
    Ok(cursor)
}

/// Consume new access-log lines into the fleet's hourly counters and its
/// per-dimension breakdown. A missing log (Caddy not yet reloaded) is a
/// silent skip. Environment hosts attribute to the environment's own (app,
/// environment) rows; the trace → request index is shared (trace ids are
/// unique per request).
///
/// The offset advances (and is persisted) only after a line's rows commit, so
/// a mid-loop DB error re-reads exactly the lines that were not applied — never
/// one that already was. A trailing partial line stays unread until its
/// newline lands.
pub async fn tick(
    pool: &SqlitePool,
    cfg: &Config,
    slug_id: &HashMap<String, String>,
    slug_env: &HashMap<String, String>,
    domain_id: &HashMap<String, String>,
    requests: &mut RequestIndex,
) -> anyhow::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let path = access_log_path(cfg);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    let offset_file = offset_path(cfg);
    let mut cursor = OffsetState::read(&offset_file).resolved(meta.ino(), meta.len());
    let len = meta.len();
    if cursor.pos() == len {
        return Ok(());
    }
    if len - cursor.pos() > MAX_CATCHUP_BYTES {
        let skipped = len - cursor.pos();
        tracing::warn!(skipped, "access log burst skipped");
        // The skipped bytes are dropped, not counted — but they still name
        // their fleets. Stream-scan the region for request hosts and touch
        // each distinct fleet's idle clock at the skip time, so every fleet's
        // clock stays trustworthy through the burst. The scan holds one chunk
        // plus one bounded line prefix, never the burst; a scan or touch
        // failure aborts before the cursor moves, so the next tick retries
        // the whole skip instead of leaving a silent blind spot.
        let skip_us = Utc::now().timestamp_micros();
        let targets = scan_skipped_region(
            &path,
            cursor.pos(),
            skipped,
            cfg,
            slug_id,
            slug_env,
            domain_id,
        )?;
        if !targets.is_empty() {
            let mut tx = pool.begin().await?;
            let bucket = hour_bucket(skip_us / 1_000_000);
            for (app_id, environment_id) in &targets {
                hourly::touch_request(
                    &mut tx,
                    hourly::Key {
                        app_id,
                        environment_id,
                        bucket_hour: &bucket,
                    },
                    skip_us,
                )
                .await?;
            }
            tx.commit().await?;
        }
        cursor = OffsetState::skipped_to(meta.ino(), len);
        cursor.persist(&offset_file)?;
    }
    if cursor.pos() < len {
        let bytes = std::fs::read(&path)?;
        let mut tail = Tail {
            pool,
            cfg,
            slug_id,
            slug_env,
            domain_id,
            requests,
        };
        consume_lines(&mut tail, &bytes, meta.ino(), cursor, &offset_file).await?;
    }
    // Bound growth: truncate only when nothing was appended mid-tick and the
    // file is still the one we read (a rotation in the window is left alone).
    let unchanged = std::fs::metadata(&path)
        .map(|m| m.ino() == meta.ino() && m.len() == len)
        .unwrap_or(false);
    if len > TRUNCATE_BYTES && unchanged {
        // File::create truncates in place: the inode survives, so the saved
        // offset resets to zero under the same inode.
        std::fs::File::create(&path)?;
        OffsetState::At {
            ino: meta.ino(),
            off: 0,
        }
        .persist(&offset_file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P1: a mid-loop DB error must not re-consume the lines that already
    /// committed. The old tail wrote the offset only after the whole loop, so
    /// the retry double counted device/path/referrer stats.
    #[tokio::test]
    async fn a_mid_loop_db_error_never_double_counts_earlier_lines() {
        let dir = std::env::temp_dir().join(format!("noite-accesslog-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        // First line: commits. Second: its hourly write is what the trigger
        // below rejects, before that line's transaction commits.
        // Both are fleet-served (the log fields the counters gate on), so the
        // hourly row is what this test checks.
        let first = "{\"request\":{\"host\":\"blog.localhost\",\"uri\":\"/ok\",\"method\":\"GET\",\"headers\":{\"User-Agent\":[\"Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36\"]}},\"status\":200,\"noite_upstream\":\"127.0.0.1:9000\",\"noite_edge_upstream\":\"127.0.0.1:9000\"}\n";
        let second = "{\"request\":{\"host\":\"blog.localhost\",\"uri\":\"/bot\",\"method\":\"GET\",\"headers\":{\"User-Agent\":[\"Googlebot/2.1\"]}},\"status\":200,\"noite_upstream\":\"127.0.0.1:9000\",\"noite_edge_upstream\":\"127.0.0.1:9000\"}\n";
        let log = dir.join("access.log");
        std::fs::write(&log, format!("{first}{second}")).expect("write log");
        let mut cfg = crate::config::config_for_tests();
        cfg.caddy_access_log = log.display().to_string();
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("file db");
        let mut slug_id = HashMap::new();
        slug_id.insert("blog".to_string(), "app-id".to_string());
        let mut requests = RequestIndex::default();
        sqlx::query(
            "CREATE TRIGGER metrics.boom BEFORE INSERT ON app_hour \
             WHEN NEW.requests = 2 BEGIN SELECT RAISE(ABORT, 'injected'); END",
        )
        .execute(&pool)
        .await
        .expect("trigger");
        let result = super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await;
        assert!(result.is_err(), "the second line fails");
        let offset = std::fs::read_to_string(dir.join("access-log.offset")).expect("offset");
        assert_eq!(
            offset.split(':').nth(1).and_then(|o| o.parse::<u64>().ok()),
            Some(first.len() as u64),
            "the first line is persisted as consumed"
        );
        sqlx::query("DROP TRIGGER metrics.boom")
            .execute(&pool)
            .await
            .expect("drop trigger");
        super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect("retry succeeds");
        // Both lines count exactly once in the fleet's hourly counters: 2
        // requests, never 3. That row is the surviving product surface — it is
        // written in the same transaction as the line's analytics.
        let rows = crate::db::list_app_metrics(&pool, "app-id", "", "1970-01-01T00:00:00Z")
            .await
            .expect("read");
        assert_eq!(rows.len(), 1, "the fixtures' stamps share one hour");
        assert_eq!(rows[0].requests, 2, "no line is counted twice");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The line's own log fields decide whether the fleet answered. The
    /// static edge config logs the proxy's upstream, the route's fleet
    /// upstream and a marker on `handle_errors` pages.
    fn served_line(
        host: &str,
        status: u16,
        ts: f64,
        upstream: Option<&str>,
        edge_upstream: Option<&str>,
        edge_error: bool,
    ) -> String {
        let mut v = serde_json::json!({
            "request": {
                "host": host,
                "uri": "/x?y=1",
                "method": "GET",
                "headers": {"User-Agent": ["curl/8.18.0"], "Referer": [""]},
            },
            "status": status,
            "ts": ts,
            "duration": 0.012,
        });
        if let Some(upstream) = upstream {
            v["noite_upstream"] = upstream.into();
        }
        if let Some(edge) = edge_upstream {
            v["noite_edge_upstream"] = edge.into();
        }
        if edge_error {
            v["noite_edge_error"] = "1".into();
        }
        format!("{v}\n")
    }

    /// Fix: only a line the fleet's own `reverse_proxy` answered moves the
    /// hourly counters. The edge's own answers — the `:80` redirect, a
    /// `forward_auth` gate refusal, a rate-limit 429, the runner's
    /// `fallback`/`env-parked` endpoint, the starting page — used to count
    /// too, so one unauthenticated request per sleep window kept any app awake
    /// and inflated its metrics. The tenant's own 4xx still counts.
    #[tokio::test]
    async fn edge_answered_lines_never_move_the_counters() {
        let dir = std::env::temp_dir().join(format!(
            "noite-accesslog-served-{}",
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("access.log");
        let fleet = "127.0.0.1:9001";
        let api = "127.0.0.1:9000";
        let mut cfg = crate::config::config_for_tests();
        cfg.caddy_api_upstream = api.into();
        let ts = 1_767_225_600.0;
        let lines = [
            // The :80 site answers a 308 itself; no proxy ran.
            served_line("blog.localhost", 308, ts, None, None, false),
            // forward_auth refused: the hop's own upstream is the runner API.
            served_line("blog.localhost", 401, ts, Some(api), Some(fleet), false),
            // An edge rate-limit answer: the route's upstream is known, the
            // proxy never ran.
            served_line("blog.localhost", 429, ts, None, Some(fleet), false),
            // A fleet that is down still leaves its upstream in the
            // placeholder; `handle_errors` marks the page it rendered.
            served_line("blog.localhost", 503, ts, Some(fleet), Some(fleet), true),
            // The `fallback`/`env-parked` route proxies to the runner's own
            // endpoint, and the table publishes the same address as the
            // route's upstream: both fields agree, yet no fleet answered.
            served_line("blog.localhost", 200, ts + 5.0, Some(api), Some(api), false),
            // Served: 200 and the tenant's own 401 both count.
            served_line(
                "blog.localhost",
                200,
                ts + 10.0,
                Some(fleet),
                Some(fleet),
                false,
            ),
            served_line(
                "blog.localhost",
                401,
                ts + 20.0,
                Some(fleet),
                Some(fleet),
                false,
            ),
        ];
        std::fs::write(&log, lines.concat()).expect("write log");
        cfg.caddy_access_log = log.display().to_string();
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("file db");
        let slug_id = HashMap::from([("blog".to_string(), "app-id".to_string())]);
        let mut requests = RequestIndex::default();
        super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect("tick consumes the log");
        let mut conn = pool.acquire().await.expect("connection");
        let row = crate::db::get_app_hour(&mut conn, "app-id", "", &super::hour_bucket(ts as i64))
            .await
            .expect("read hour")
            .expect("the served lines created the hour");
        assert_eq!(row.requests, 2, "only the two fleet-served lines count");
        assert_eq!(
            row.errors, 0,
            "the edge's starting page is not an app error"
        );
        assert_eq!(
            row.last_request_us,
            (ts + 20.0) as i64 * 1_000_000,
            "the idle clock only sees a fleet-served request"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A burst skip drops every buffered line but still names its fleets: the
    /// scan touches each distinct fleet's idle clock at the skip time, while
    /// the burst stays uncounted — no counters, no dims.
    #[tokio::test]
    async fn a_burst_skip_touches_but_never_counts() {
        let dir =
            std::env::temp_dir().join(format!("noite-accesslog-skip-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("access.log");
        // Header-inflated lines: the host sits early, kilobytes of junk
        // follow it.
        let junk = "x".repeat(4096);
        let line = |host: &str| {
            format!(
                "{{\"request\":{{\"host\":\"{host}\",\"uri\":\"/\",\"method\":\"GET\",\"headers\":{{\"X-Junk\":[\"{junk}\"]}}}},\"status\":200,\"ts\":1.0}}\n"
            )
        };
        let mut burst = String::new();
        while burst.len() <= MAX_CATCHUP_BYTES as usize + 1024 {
            burst.push_str(&line("blog.localhost"));
            burst.push_str(&line("shop.localhost"));
        }
        std::fs::write(&log, &burst).expect("write an oversized log");
        let mut cfg = crate::config::config_for_tests();
        cfg.caddy_access_log = log.display().to_string();
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("file db");
        let slug_id = HashMap::from([
            ("blog".to_string(), "app-blog".to_string()),
            ("shop".to_string(), "app-shop".to_string()),
        ]);
        let before = Utc::now();
        let mut requests = RequestIndex::default();
        super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect("the skip is not an error");
        for app in ["app-blog", "app-shop"] {
            let touched = crate::db::last_request_us(&pool, app, "")
                .await
                .expect("clock readable")
                .expect("the burst touched this fleet");
            assert!(
                touched >= before.timestamp_micros(),
                "{app} is touched at the skip"
            );
            let mut conn = pool.acquire().await.expect("connection");
            let row = crate::db::get_app_hour(
                &mut conn,
                app,
                "",
                &super::hour_bucket((touched / 1_000_000) as i64),
            )
            .await
            .expect("read hour")
            .expect("the touch wrote the hour");
            assert_eq!(
                (row.requests, row.errors),
                (0, 0),
                "the burst stays uncounted for {app}"
            );
        }
        assert!(dim_counts(&pool).await.is_empty(), "and writes no dims");
        let offset = std::fs::read_to_string(dir.join("access-log.offset")).expect("offset");
        assert_eq!(
            offset.split(':').nth(1).and_then(|o| o.parse::<u64>().ok()),
            Some(0),
            "the oversized file is truncated in place after the skip"
        );
        assert_eq!(
            std::fs::metadata(&log).expect("log").len(),
            0,
            "and starts over empty"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The burst scan never holds more than one chunk plus one bounded line
    /// prefix: a reader that watches every read proves a 32 MiB burst
    /// streams through 64 KiB at a time and still attributes every fleet.
    #[tokio::test]
    async fn the_scan_is_bounded_for_a_large_burst() {
        use std::io::Write;
        struct Metered<R> {
            inner: R,
            max_read: usize,
        }
        impl<R: std::io::Read> std::io::Read for Metered<R> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.max_read = self.max_read.max(buf.len());
                self.inner.read(buf)
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "noite-accesslog-bounded-{}",
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let log = dir.join("access.log");
        let junk = "x".repeat(2048);
        let line = |host: &str| {
            format!(
                "{{\"request\":{{\"host\":\"{host}\",\"uri\":\"/\",\"method\":\"GET\",\"headers\":{{\"X-Junk\":[\"{junk}\"]}}}},\"status\":200,\"ts\":1.0}}\n"
            )
        };
        let mut out = std::io::BufWriter::new(std::fs::File::create(&log).expect("create"));
        while out.get_ref().metadata().expect("size").len() <= 32 * 1024 * 1024 {
            out.write_all(line("blog.localhost").as_bytes())
                .expect("write");
            out.write_all(line("shop.localhost").as_bytes())
                .expect("write");
        }
        out.flush().expect("flush");
        drop(out);
        let len = std::fs::metadata(&log).expect("log").len();
        assert!(len > 32 * 1024 * 1024, "the burst is really 32 MiB");
        let cfg = crate::config::config_for_tests();
        let slug_id = HashMap::from([
            ("blog".to_string(), "app-blog".to_string()),
            ("shop".to_string(), "app-shop".to_string()),
        ]);
        let mut metered = Metered {
            inner: std::fs::File::open(&log).expect("open"),
            max_read: 0,
        };
        let found = super::scan_skipped_hosts(
            &mut metered,
            len,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
        )
        .expect("the scan streams");
        assert_eq!(
            found,
            HashSet::from([
                ("app-blog".to_string(), String::new()),
                ("app-shop".to_string(), String::new()),
            ]),
            "every fleet in the burst is found"
        );
        assert!(
            metered.max_read <= super::SCAN_CHUNK_BYTES,
            "no single read exceeds the chunk: {}",
            metered.max_read
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An over-long line still attributes when its host sits in the prefix;
    /// an over-long garbage line and every malformed shape are ignored, and
    /// nothing here panics.
    #[test]
    fn oversized_and_malformed_lines_never_break_the_scan() {
        let cfg = crate::config::config_for_tests();
        let slug_id = HashMap::from([("blog".to_string(), "app-blog".to_string())]);
        let scan = |input: &[u8]| {
            let mut cursor = std::io::Cursor::new(input.to_vec());
            super::scan_skipped_hosts(
                &mut cursor,
                input.len() as u64,
                &cfg,
                &slug_id,
                &HashMap::new(),
                &HashMap::new(),
            )
            .expect("the scan never fails on content")
        };
        let blog = ("app-blog".to_string(), String::new());
        // A header-inflated line: the host is early, 200 KiB of junk follow.
        let fat = format!(
            "{{\"request\":{{\"host\":\"blog.localhost\",\"uri\":\"/\",\"headers\":{{\"X-Junk\":[\"{}\"]}}}}}}\n",
            "x".repeat(200 * 1024)
        );
        assert_eq!(
            scan(fat.as_bytes()),
            HashSet::from([blog.clone()]),
            "the host in the prefix still attributes"
        );
        // Same size, no host anywhere: ignored.
        let garbage = format!("{}\n", "y".repeat(200 * 1024));
        assert!(
            scan(garbage.as_bytes()).is_empty(),
            "oversized garbage is skipped"
        );
        // A line whose host starts on the far side of a chunk boundary still
        // attributes: the prefix carries across chunks.
        let mut split = vec![b'x'; super::SCAN_CHUNK_BYTES - 200];
        split.push(b'\n');
        split.extend_from_slice(b"{\"request\":{\"host\":\"blog.localhost\",\"uri\":\"/\"}}\n");
        assert_eq!(
            scan(&split),
            HashSet::from([blog.clone()]),
            "a host split across chunks attributes"
        );
        // Malformed shapes: truncated escape, control byte in the value,
        // empty host, non-UTF8 — all ignored, none panics.
        for bad in [
            "{\"request\":{\"host\":\"blog.localhost\\",
            "{\"request\":{\"host\":\"blo\ng.localhost\"}}",
            "{\"request\":{\"host\":\"\"}}",
            "{\"request\":{\"host\":\"\\ud800\"}}",
        ] {
            let mut line = bad.as_bytes().to_vec();
            line.push(b'\n');
            assert!(scan(&line).is_empty(), "malformed line ignored: {bad:?}");
        }
        // Non-UTF8 bytes where the host would be: ignored, not panicking.
        let mut binary = b"{\"request\":{\"host\":\"".to_vec();
        binary.extend_from_slice(&[0xff, 0xfe, b'"', b'}', b'}', b'\n']);
        assert!(scan(&binary).is_empty(), "non-UTF8 host ignored");
        // The host search takes the first occurrence; attacker header values
        // later in the line cannot reroute the attribution.
        let spoof = "{\"request\":{\"host\":\"blog.localhost\",\"headers\":{\"X-Evil\":[\"\\\"host\\\":\\\"shop.localhost\\\"\"]}}}\n";
        assert_eq!(
            scan(spoof.as_bytes()),
            HashSet::from([blog]),
            "the real host wins over a header value"
        );
        // A trailing partial line stays unread until its newline lands.
        let partial =
            b"{\"request\":{\"host\":\"blog.localhost\"}}\n{\"request\":{\"host\":\"blog.local"
                .to_vec();
        assert_eq!(
            {
                let mut cursor = std::io::Cursor::new(partial.clone());
                super::scan_skipped_hosts(
                    &mut cursor,
                    (partial.len() - 10) as u64,
                    &cfg,
                    &slug_id,
                    &HashMap::new(),
                    &HashMap::new(),
                )
                .expect("scan")
            },
            HashSet::from([("app-blog".to_string(), String::new())]),
            "only the whole line attributes; the partial tail stays unread"
        );
    }

    /// The scan reuses the consuming tail's attribution: tenant, environment,
    /// control and custom-domain hosts resolve the same way, and unknown
    /// hosts land nowhere.
    #[test]
    fn the_scan_reuses_tail_attribution() {
        let cfg = crate::config::config_for_tests();
        let slug_id = HashMap::from([
            ("blog".to_string(), "app-blog".to_string()),
            ("blog.feature".to_string(), "app-blog".to_string()),
        ]);
        let slug_env = HashMap::from([("blog.feature".to_string(), "env-1".to_string())]);
        let domains = HashMap::from([("example.com".to_string(), "app-blog".to_string())]);
        let attribute =
            |host: &str| super::attribute_host(host, &cfg, &slug_id, &slug_env, &domains);
        assert_eq!(
            attribute("blog.localhost"),
            Some(("app-blog".to_string(), String::new()))
        );
        assert_eq!(
            attribute("feature.blog.localhost"),
            Some(("app-blog".to_string(), "env-1".to_string()))
        );
        assert_eq!(
            attribute("example.com"),
            Some(("app-blog".to_string(), String::new()))
        );
        assert_eq!(
            attribute("localhost"),
            Some((crate::host::control::SLUG.to_string(), String::new())),
            "the control plane's own host resolves to the reserved key"
        );
        assert_eq!(attribute("unknown.localhost"), None);
        assert_eq!(attribute("ghost.blog.localhost"), None);
    }

    #[test]
    fn offset_resets_on_rotation_and_shrink_but_not_on_growth() {
        let at = OffsetState::At { ino: 9, off: 40 };
        assert_eq!(at.resolved(9, 100), at);
        assert_eq!(at.resolved(10, 100), OffsetState::Fresh.resolved(10, 100));
        assert_eq!(at.resolved(9, 10), OffsetState::At { ino: 9, off: 0 });
        // A corrupt or missing sidecar reads as fresh.
        let dir = std::env::temp_dir().join(format!("noite-offset-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("offset");
        std::fs::write(&path, "garbage").expect("write");
        assert_eq!(OffsetState::read(&path), OffsetState::Fresh);
        OffsetState::At { ino: 4, off: 12 }
            .persist(&path)
            .expect("persist");
        assert_eq!(
            OffsetState::read(&path),
            OffsetState::At { ino: 4, off: 12 }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One fleet-served line helper with caller-chosen UA, referrer and path.
    fn dim_line(ua: &str, referer: &str, uri: &str, ts: f64) -> String {
        let v = serde_json::json!({
            "request": {
                "host": "blog.localhost",
                "uri": uri,
                "method": "GET",
                "headers": {"User-Agent": [ua], "Referer": [referer]},
            },
            "status": 200,
            "ts": ts,
            "duration": 0.012,
            "noite_upstream": "127.0.0.1:9001",
            "noite_edge_upstream": "127.0.0.1:9001",
        });
        format!("{v}\n")
    }

    async fn dim_test_pool(dir: &std::path::Path) -> (crate::config::Config, sqlx::SqlitePool) {
        let mut cfg = crate::config::config_for_tests();
        cfg.caddy_access_log = dir.join("access.log").display().to_string();
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("file db");
        (cfg, pool)
    }

    async fn tick_one(pool: &sqlx::SqlitePool, cfg: &crate::config::Config) {
        let mut slug_id = HashMap::new();
        slug_id.insert("blog".to_string(), "app-id".to_string());
        let mut requests = RequestIndex::default();
        super::tick(
            pool,
            cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect("tick consumes the log");
    }

    async fn dim_counts(pool: &sqlx::SqlitePool) -> Vec<(String, String, i64)> {
        sqlx::query_as(
            "SELECT kind, value, requests FROM metrics.app_hour_dim ORDER BY kind, value",
        )
        .fetch_all(pool)
        .await
        .expect("read dims")
    }

    /// One served line increments the hourly counter and all four breakdown
    /// dimensions in the same transaction: the fleet-served population is
    /// exactly the request counter's.
    #[tokio::test]
    async fn one_served_line_counts_requests_and_all_four_dims() {
        let dir =
            std::env::temp_dir().join(format!("noite-accesslog-dims-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (cfg, pool) = dim_test_pool(&dir).await;
        std::fs::write(
            dir.join("access.log"),
            dim_line(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
                "https://www.google.com/search?q=noite",
                "/pricing?plan=team",
                1_767_225_600.0,
            ),
        )
        .expect("write log");
        tick_one(&pool, &cfg).await;
        let mut conn = pool.acquire().await.expect("connection");
        let row =
            crate::db::get_app_hour(&mut conn, "app-id", "", &super::hour_bucket(1_767_225_600))
                .await
                .expect("read hour")
                .expect("the served line created the hour");
        assert_eq!(row.requests, 1);
        assert_eq!(
            dim_counts(&pool).await,
            vec![
                ("browser".to_string(), "Chrome".to_string(), 1),
                ("os".to_string(), "macOS".to_string(), 1),
                ("path".to_string(), "/pricing".to_string(), 1),
                ("referrer".to_string(), "Google".to_string(), 1),
            ],
            "browser, os, query-less path and named referrer count once"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Edge-answered lines add no dims: the breakdown shares the request
    /// counter's fleet-served population, not the edge-wide one.
    #[tokio::test]
    async fn edge_answered_lines_add_no_dims() {
        let dir = std::env::temp_dir().join(format!(
            "noite-accesslog-edge-dims-{}",
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (mut cfg, pool) = dim_test_pool(&dir).await;
        cfg.caddy_api_upstream = "127.0.0.1:9000".into();
        let fleet = "127.0.0.1:9001";
        let api = "127.0.0.1:9000";
        let lines = [
            served_line("blog.localhost", 308, 1_767_225_600.0, None, None, false),
            served_line(
                "blog.localhost",
                401,
                1_767_225_600.0,
                Some(api),
                Some(fleet),
                false,
            ),
            served_line(
                "blog.localhost",
                429,
                1_767_225_600.0,
                None,
                Some(fleet),
                false,
            ),
            served_line(
                "blog.localhost",
                503,
                1_767_225_600.0,
                Some(fleet),
                Some(fleet),
                true,
            ),
            served_line(
                "blog.localhost",
                200,
                1_767_225_605.0,
                Some(api),
                Some(api),
                false,
            ),
        ];
        std::fs::write(dir.join("access.log"), lines.concat()).expect("write log");
        tick_one(&pool, &cfg).await;
        assert!(
            dim_counts(&pool).await.is_empty(),
            "no line a fleet answered, no dims"
        );
        assert!(
            crate::db::list_app_metrics(&pool, "app-id", "", "1970-01-01T00:00:00Z")
                .await
                .expect("read")
                .is_empty(),
            "and no counter row either"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A failed dimension write leaves neither the counter nor the dims: the
    /// line's rows commit together, so the retried line counts exactly once.
    #[tokio::test]
    async fn a_failed_dim_write_leaves_neither_counter_nor_dims() {
        let dir = std::env::temp_dir().join(format!(
            "noite-accesslog-dim-boom-{}",
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (cfg, pool) = dim_test_pool(&dir).await;
        std::fs::write(
            dir.join("access.log"),
            dim_line("curl/8.18.0", "", "/ok", 1_767_225_600.0),
        )
        .expect("write log");
        sqlx::query(
            "CREATE TRIGGER metrics.boom_dim BEFORE INSERT ON app_hour_dim \
             BEGIN SELECT RAISE(ABORT, 'injected'); END",
        )
        .execute(&pool)
        .await
        .expect("trigger");
        let mut slug_id = HashMap::new();
        slug_id.insert("blog".to_string(), "app-id".to_string());
        let mut requests = RequestIndex::default();
        super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect_err("the dim write fails");
        assert!(
            crate::db::list_app_metrics(&pool, "app-id", "", "1970-01-01T00:00:00Z")
                .await
                .expect("read")
                .is_empty(),
            "the counter rolls back with the dims"
        );
        assert!(dim_counts(&pool).await.is_empty());
        sqlx::query("DROP TRIGGER metrics.boom_dim")
            .execute(&pool)
            .await
            .expect("drop trigger");
        super::tick(
            &pool,
            &cfg,
            &slug_id,
            &HashMap::new(),
            &HashMap::new(),
            &mut requests,
        )
        .await
        .expect("retry succeeds");
        let rows = crate::db::list_app_metrics(&pool, "app-id", "", "1970-01-01T00:00:00Z")
            .await
            .expect("read");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].requests, 1, "the retried line counts once");
        assert_eq!(
            dim_counts(&pool).await,
            vec![
                ("browser".to_string(), "CLI".to_string(), 1),
                ("os".to_string(), "Other".to_string(), 1),
                ("path".to_string(), "/ok".to_string(), 1),
                ("referrer".to_string(), "Direct".to_string(), 1),
            ],
            "empty os reads as Other, empty referrer as Direct"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `ref_source` never leaks a path or query: named sources by name, an
    /// empty referrer as Direct, everything else as its bare lowercase host.
    #[test]
    fn ref_source_names_sources_and_hides_paths() {
        assert_eq!(super::ref_source(""), "Direct");
        assert_eq!(super::ref_source("   "), "Direct");
        assert_eq!(
            super::ref_source("https://www.google.com/search?q=noite"),
            "Google"
        );
        assert_eq!(super::ref_source("https://google.co.uk/"), "Google");
        assert_eq!(
            super::ref_source("http://m.facebook.com/post/1?x=2"),
            "Facebook"
        );
        assert_eq!(super::ref_source("https://x.com/a/b?c=d"), "X");
        assert_eq!(
            super::ref_source("https://blog.example.com/post?token=abc"),
            "blog.example.com"
        );
        assert_eq!(
            super::ref_source("https://example.com:8080/a"),
            "example.com"
        );
        assert_eq!(
            super::ref_source("HTTPS://WWW.YOUTUBE.COM/watch?v=x"),
            "YouTube"
        );
        assert_eq!(
            super::ref_source("https://user:pass@internal.example.org:8443/a?b=c#d"),
            "internal.example.org"
        );
    }
}

#[cfg(test)]
mod env_tests {
    use super::*;

    fn line(host: &str) -> String {
        serde_json::json!({
            "request": {
                "host": host,
                "uri": "/about?x=1",
                "method": "GET",
                "headers": {"User-Agent": ["curl/8.18.0"], "Referer": [""]},
            },
            "status": 200,
            "ts": 1_767_225_600.0,
            "traceID": "4bf92f3577b34da6a3ce929d0e0e4736",
        })
        .to_string()
    }

    /// A verified custom domain is the app's own traffic: the edge serves it,
    /// so its requests must count (and keep the idle clock honest). An
    /// unverified or unknown host still lands nowhere.
    #[test]
    fn custom_domains_attribute_to_their_app() {
        let cfg = crate::config::config_for_tests();
        let slug_id = HashMap::from([("blog".to_string(), "app1".to_string())]);
        let domains = HashMap::from([
            ("example.com".to_string(), "app1".to_string()),
            ("www.example.com".to_string(), "app1".to_string()),
        ]);
        let custom = parse_line(
            &line("example.com"),
            &cfg,
            &slug_id,
            &HashMap::new(),
            &domains,
        )
        .expect("custom host parses");
        assert_eq!(custom.app_id, "app1");
        assert_eq!(custom.environment_id, "");
        let ported = parse_line(
            &line("WWW.Example.COM:443"),
            &cfg,
            &slug_id,
            &HashMap::new(),
            &domains,
        )
        .expect("case and port do not matter");
        assert_eq!(ported.app_id, "app1");
        assert!(
            parse_line(
                &line("pending.example.org"),
                &cfg,
                &slug_id,
                &HashMap::new(),
                &domains
            )
            .is_none(),
            "an unverified host is dropped, never guessed"
        );
    }

    /// An environment host attributes to the environment's own (app,
    /// environment) rows; a tenant host stays production; an unknown
    /// label is dropped, never mis-keyed onto the app.
    #[test]
    fn environment_hosts_attribute_to_the_environment() {
        let cfg = crate::config::config_for_tests();
        let slug_id = HashMap::from([
            ("blog".to_string(), "app1".to_string()),
            ("blog.feature".to_string(), "app1".to_string()),
        ]);
        let slug_env = HashMap::from([("blog.feature".to_string(), "env-1".to_string())]);
        let env = parse_line(
            &line("feature.blog.localhost"),
            &cfg,
            &slug_id,
            &slug_env,
            &HashMap::new(),
        )
        .expect("env host parses");
        assert_eq!(env.app_id, "app1");
        assert_eq!(env.environment_id, "env-1");
        assert_eq!(
            env.trace.as_ref().map(|(_, ctx)| ctx.path.as_str()),
            Some("/about"),
            "the error join keeps the query-less path"
        );
        let prod = parse_line(
            &line("blog.localhost"),
            &cfg,
            &slug_id,
            &slug_env,
            &HashMap::new(),
        )
        .expect("tenant host parses");
        assert_eq!(prod.app_id, "app1");
        assert_eq!(prod.environment_id, "");
        assert!(
            parse_line(
                &line("ghost.blog.localhost"),
                &cfg,
                &slug_id,
                &slug_env,
                &HashMap::new()
            )
            .is_none(),
            "an unknown label is dropped, never production"
        );
        assert!(
            parse_line(
                &line("feature.blog.localhost"),
                &cfg,
                &slug_id,
                &HashMap::new(),
                &HashMap::new()
            )
            .is_none(),
            "an environment with no fleet key is dropped"
        );
    }
}
