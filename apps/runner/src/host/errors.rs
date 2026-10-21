//! Error tracking from celld telemetry, no SDK required.
//!
//! Two signals carry an exception (verified against celld 0.6.0; since
//! 0.6.1 the log level is a severity column, and the ingest puts the prefix
//! back, host/metrics/ingest.rs `ingest_all`):
//!
//! 1. A failed span's `error` column for anything a handler throws or
//!    rejects — `rejected: PaymentError: declined [at chargeCard
//!    (worker.js:21:27) <- at fetch (worker.js:34:9)]`. A Durable Object
//!    failure shows on both the `celld.cell_fetch` span and, wrapped as
//!    `rejected: Error: rejected: …`, on its parent `celld.fetch`; the
//!    ingest groups them per trace so one request counts once.
//! 2. A log record for `console.error(err)` and for rejected `waitUntil`
//!    work — `ERROR <context> <Name>: <message>\n    at …` with a full V8
//!    stack. Only lines that carry a stack count: a bare `console.error`
//!    string is a log, not an error.
//!
//! Request context comes from the edge: tenant sites send a `traceparent`
//! that celld adopts as the span's trace id and log the same `traceID` in
//! the access log (host/caddy.rs `TENANT_TRACE`), so an error joins its
//! method/path/status by trace id (`RequestIndex`).
//!
//! Issues group by fingerprint (type + in-app function names, or the
//! normalized message when no in-app frame exists), keep the last
//! `EVENTS_PER_ISSUE` occurrences, and reopen when a resolved issue fires
//! again. Everything lives in `metrics.sqlite` and ages out with the
//! telemetry retention.
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use ts_rs::TS;

use crate::db;

/// Occurrences kept per issue (newest first).
pub const EVENTS_PER_ISSUE: i64 = 20;
/// Log lines of the failing trace kept with one occurrence.
const LOGS_PER_EVENT: usize = 20;
/// Frames kept per occurrence: V8 captures 10 by default, a custom
/// `Error.stackTraceLimit` can raise it arbitrarily.
const MAX_FRAMES: usize = 50;
/// Bound on logged errors recorded per app per hour bucket (a hot loop of
/// `console.error(err)` must not turn into thousands of writes). Per hour,
/// not per pass, so a day-long catch-up chunk keeps the same bound as the
/// steady-state partial-hour pass.
const MAX_LOGGED_PER_HOUR: usize = 200;
/// Stored message cap: messages can embed whole payloads.
const MAX_MESSAGE: usize = 2000;
/// Frames that feed the fingerprint.
const FINGERPRINT_FRAMES: usize = 5;
/// Trace → request entries: kept long enough to outlive the telemetry flush
/// lag (flush + 10 s, 40 s by default), bounded against bursts.
const REQUEST_TTL: Duration = Duration::from_secs(15 * 60);
const REQUEST_CAP: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Frame {
    pub function: String,
    pub location: String,
    pub in_app: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedError {
    pub kind: String,
    pub message: String,
    pub frames: Vec<Frame>,
    /// `console.error` text logged before the error itself.
    pub context: String,
}

/// Drop celld's rejection wrappers: `rejected: ` on every failed span and
/// `Error: rejected: ` where a parent span re-wraps a child's failure.
pub fn strip_rejected(raw: &str) -> &str {
    let mut s = raw.trim();
    loop {
        if let Some(rest) = s.strip_prefix("rejected: ") {
            s = rest;
        } else if let Some(rest) = s.strip_prefix("Error: rejected: ") {
            s = rest;
        } else {
            return s;
        }
    }
}

/// `Name` in `Name: message`: an identifier, as JS error names are.
fn is_error_name(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    s.len() <= 64
        && (first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.')
}

/// `TypeError: boom` → (`TypeError`, `boom`); anything else is a plain
/// `Error` whose message is the whole text (e.g. `throw "string"`).
fn split_header(head: &str) -> (String, String) {
    if let Some((name, message)) = head.split_once(": ") {
        if is_error_name(name) {
            return (name.to_string(), message.to_string());
        }
    }
    ("Error".to_string(), head.to_string())
}

fn is_internal(location: &str) -> bool {
    location.is_empty()
        || location.starts_with("<anonymous>")
        || location.starts_with("node:")
        || location.starts_with("cloudflare:")
        || location == "native"
}

/// One V8 frame, `at` prefix already removed: `fn (file:line:col)` or a
/// bare `file:line:col`.
pub fn parse_frame(raw: &str) -> Frame {
    let s = raw.trim();
    let s = s.strip_prefix("at ").unwrap_or(s);
    let s = s.strip_prefix("async ").unwrap_or(s);
    let (function, location) = match s.rfind(" (") {
        Some(i) if s.ends_with(')') => (s[..i].to_string(), s[i + 2..s.len() - 1].to_string()),
        _ => (String::new(), s.to_string()),
    };
    let in_app = !is_internal(&location);
    Frame {
        function,
        location,
        in_app,
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// A failed span's `error`: `Name: message [at f (loc) <- at g (loc)]`.
pub fn parse_span_error(raw: &str) -> ParsedError {
    let s = strip_rejected(raw);
    let (head, frames) = match s.rfind(" [at ") {
        Some(i) if s.ends_with(']') => {
            let frames = s[i + 2..s.len() - 1]
                .split(" <- ")
                .take(MAX_FRAMES)
                .map(parse_frame)
                .collect();
            (&s[..i], frames)
        }
        _ => (s, Vec::new()),
    };
    let (kind, message) = split_header(head);
    ParsedError {
        kind,
        message: clip(&message, MAX_MESSAGE),
        frames,
        context: String::new(),
    }
}

/// A log body from `console.error(…, err)` or a rejected `waitUntil`:
/// `ERROR <context> Name: message\n    at …`. None unless it carries a
/// stack — that is what separates an exception from a logged string.
pub fn parse_log_error(body: &str) -> Option<ParsedError> {
    let rest = body.strip_prefix("ERROR ")?;
    if !rest.contains("\n    at ") {
        return None;
    }
    let mut lines = rest.lines();
    let first = lines.next()?;
    // The error header is the first `<Name>: ` whose name looks like an
    // error type; the words before it are the console message.
    let mut context = String::new();
    let mut kind = "Error".to_string();
    let mut message = first.to_string();
    let mut from = 0;
    while let Some(off) = first[from..].find(": ") {
        let colon = from + off;
        let start = first[..colon].rfind(' ').map(|i| i + 1).unwrap_or(0);
        let name = &first[start..colon];
        if is_error_name(name) && (name.ends_with("Error") || name.ends_with("Exception")) {
            context = first[..start].trim().to_string();
            kind = name.to_string();
            message = first[colon + 2..].to_string();
            break;
        }
        from = colon + 2;
    }
    let mut frames = Vec::new();
    for line in lines {
        let t = line.trim();
        if t.starts_with("at ") {
            if frames.len() < MAX_FRAMES {
                frames.push(parse_frame(t));
            }
        } else if frames.is_empty() && !t.is_empty() {
            // Multi-line message: continuation lines precede the stack.
            message.push('\n');
            message.push_str(t);
        }
    }
    Some(ParsedError {
        kind,
        message: clip(&message, MAX_MESSAGE),
        frames,
        context: clip(&context, 500),
    })
}

/// `worker.js:21:27` → `worker.js`.
fn file_of(location: &str) -> &str {
    let mut s = location;
    for _ in 0..2 {
        match s.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
                s = head;
            }
            _ => break,
        }
    }
    s
}

/// Digits and id-like tokens vary per occurrence (`amount 500`, a UUID);
/// grouping on the raw text would split one bug into many issues.
fn normalize_message(message: &str) -> String {
    static IDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static DIGITS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    // Static invariant: both patterns are compile-time literals, so construction never fails.
    let ids =
        IDS.get_or_init(|| regex::Regex::new(r"[0-9a-fA-F][0-9a-fA-F-]{7,}").expect("ids re"));
    let digits = DIGITS.get_or_init(|| regex::Regex::new(r"\d+").expect("digits re"));
    let line = message.lines().next().unwrap_or("");
    let line = ids.replace_all(line, "<id>");
    digits.replace_all(&line, "0").chars().take(200).collect()
}

/// Stable issue key. In-app function names (not line numbers, which move
/// with every deploy) when the stack has them, else the normalized message.
pub fn fingerprint(p: &ParsedError) -> String {
    let names: Vec<&str> = p
        .frames
        .iter()
        .filter(|f| f.in_app)
        .take(FINGERPRINT_FRAMES)
        .map(|f| {
            if f.function.is_empty() {
                file_of(&f.location)
            } else {
                f.function.as_str()
            }
        })
        .collect();
    let basis = if names.is_empty() {
        format!("{}|m|{}", p.kind, normalize_message(&p.message))
    } else {
        format!("{}|f|{}", p.kind, names.join(">"))
    };
    let digest = Sha256::digest(basis.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Where it broke: the first in-app frame, `fn (file:line)`.
pub fn culprit(p: &ParsedError) -> String {
    let Some(f) = p.frames.iter().find(|f| f.in_app) else {
        return String::new();
    };
    let line = f
        .location
        .rsplit_once(':')
        .map(|(head, _)| head)
        .unwrap_or(&f.location);
    if f.function.is_empty() {
        line.to_string()
    } else {
        format!("{} ({line})", f.function)
    }
}

/// Edge view of one request, as the access log saw it. Only what the
/// device/path breakdown already keeps: no IPs, no raw user-agents, no
/// query strings.
#[derive(Debug, Clone)]
pub struct RequestCtx {
    pub method: String,
    pub path: String,
    pub status: i64,
    pub browser: &'static str,
    pub os: &'static str,
}

/// Trace id → request, filled by the access-log tail and read by the
/// error ingest one flush later. In memory only: a runner restart loses at
/// most the context of errors still in flight.
#[derive(Default)]
pub struct RequestIndex {
    map: HashMap<String, RequestCtx>,
    order: VecDeque<(Instant, String)>,
}

impl RequestIndex {
    pub fn insert(&mut self, trace_id: String, ctx: RequestCtx) {
        let now = Instant::now();
        while let Some((at, _)) = self.order.front() {
            if self.order.len() < REQUEST_CAP && now.duration_since(*at) < REQUEST_TTL {
                break;
            }
            if let Some((_, old)) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
        if self.map.insert(trace_id.clone(), ctx).is_none() {
            self.order.push_back((now, trace_id));
        }
    }

    pub fn get(&self, trace_id: &str) -> Option<&RequestCtx> {
        self.map.get(trace_id)
    }
}

/// One failed-span group from the ingest pass: every failed span of a slug
/// with the same (unwrapped) error text in the window.
#[derive(Clone)]
pub struct SpanErrorRow {
    pub slug: String,
    pub error: String,
    pub name: String,
    pub cell: String,
    pub trace_id: String,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
}

/// One log record from the ingest pass.
#[derive(Clone)]
pub struct LogRow {
    pub slug: String,
    pub ts_us: i64,
    pub body: String,
    pub trace_id: String,
}

/// One occurrence (or a same-text group of them) ready to store.
pub struct Occurrence<'a> {
    pub app_id: &'a str,
    pub parsed: ParsedError,
    pub source: &'static str,
    pub handler: String,
    pub cell: String,
    pub trace_id: String,
    pub count: i64,
    pub first_us: i64,
    pub last_us: i64,
    pub logs: Vec<String>,
    pub request: Option<RequestCtx>,
    pub sha: Option<&'a str>,
    /// SDK extras (phase 2): the page URL with its query stripped, and the
    /// release/environment the SDK reported. Empty on telemetry occurrences.
    pub url: String,
    pub release: String,
    pub environment: String,
}

/// `celld.cell_fetch` → `cell_fetch`: the handler that failed.
fn handler_of(span_name: &str) -> String {
    span_name
        .strip_prefix("celld.")
        .unwrap_or(span_name)
        .to_string()
}

/// The hourly bucket an occurrence timestamp falls in, matching the ingest's
/// `strftime('%Y-%m-%dT%H:00:00Z', …)`.
fn hour_bucket(us: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_micros(us)
        .map(|d| d.format("%Y-%m-%dT%H:00:00Z").to_string())
        .unwrap_or_default()
}

/// Turn one ingest pass into stored issues. Returns the app ids that got
/// new occurrences.
pub async fn ingest(
    pool: &SqlitePool,
    slug_id: &HashMap<String, String>,
    app_sha: &HashMap<String, String>,
    spans: &[SpanErrorRow],
    logs: &[LogRow],
    requests: &RequestIndex,
) -> anyhow::Result<Vec<String>> {
    let mut by_trace: HashMap<&str, Vec<&str>> = HashMap::new();
    for row in logs {
        if !row.trace_id.is_empty() {
            let lines = by_trace.entry(row.trace_id.as_str()).or_default();
            if lines.len() < LOGS_PER_EVENT {
                lines.push(row.body.as_str());
            }
        }
    }
    let trace_logs = |trace: &str| -> Vec<String> {
        by_trace
            .get(trace)
            .map(|lines| lines.iter().map(|l| (*l).to_string()).collect())
            .unwrap_or_default()
    };
    let mut touched = Vec::new();
    // (app_id, fingerprint, hour) -> occurrences, and the issues whose derived
    // count must be refreshed. Kept in memory for the pass so one hour-bucket
    // is written exactly once (replace semantics), however many span groups
    // and log lines fold into it.
    let mut hours: HashMap<(String, String, String), i64> = HashMap::new();
    let mut issues: HashSet<(String, String)> = HashSet::new();
    for row in spans {
        let Some(app_id) = slug_id.get(&row.slug) else {
            continue;
        };
        let occ = Occurrence {
            app_id,
            parsed: parse_span_error(&row.error),
            source: "uncaught",
            handler: handler_of(&row.name),
            cell: row.cell.clone(),
            trace_id: row.trace_id.clone(),
            count: row.count.max(1),
            first_us: row.first_us,
            last_us: row.last_us,
            logs: trace_logs(&row.trace_id),
            request: requests.get(&row.trace_id).cloned(),
            sha: app_sha.get(app_id).map(String::as_str),
            url: String::new(),
            release: String::new(),
            environment: String::new(),
        };
        let (fp, hour, n) = record(pool, &occ).await?;
        *hours.entry((app_id.clone(), fp.clone(), hour)).or_default() += n;
        issues.insert((app_id.clone(), fp));
        touched.push(app_id.clone());
    }
    let mut logged: HashMap<(&str, String), usize> = HashMap::new();
    for row in logs {
        let Some(app_id) = slug_id.get(&row.slug) else {
            continue;
        };
        let Some(parsed) = parse_log_error(&row.body) else {
            continue;
        };
        let n = logged
            .entry((app_id.as_str(), hour_bucket(row.ts_us)))
            .or_default();
        if *n >= MAX_LOGGED_PER_HOUR {
            continue;
        }
        *n += 1;
        let occ = Occurrence {
            app_id,
            parsed,
            source: "logged",
            handler: String::new(),
            cell: String::new(),
            trace_id: row.trace_id.clone(),
            count: 1,
            first_us: row.ts_us,
            last_us: row.ts_us,
            logs: trace_logs(&row.trace_id),
            request: requests.get(&row.trace_id).cloned(),
            sha: app_sha.get(app_id).map(String::as_str),
            url: String::new(),
            release: String::new(),
            environment: String::new(),
        };
        let (fp, hour, c) = record(pool, &occ).await?;
        *hours.entry((app_id.clone(), fp.clone(), hour)).or_default() += c;
        issues.insert((app_id.clone(), fp));
        touched.push(app_id.clone());
    }
    // Hour buckets first (replace), then the issue counts derived from them:
    // a re-read or replay of a window rewrites the same buckets and leaves the
    // counts where they were.
    for ((app_id, fp, hour), n) in &hours {
        db::set_error_hour(pool, app_id, fp, hour, *n).await?;
    }
    for (app_id, fp) in &issues {
        db::refresh_error_issue_count(pool, app_id, fp).await?;
    }
    touched.sort();
    touched.dedup();
    Ok(touched)
}

/// Store one occurrence: fold the issue (min/max, latest wins), insert the
/// occurrence event unless it is already stored, and keep the newest
/// `EVENTS_PER_ISSUE`. Returns `(fingerprint, hour bucket, count)` so the
/// caller can aggregate hour buckets and refresh the derived issue count.
async fn record(pool: &SqlitePool, occ: &Occurrence<'_>) -> anyhow::Result<(String, String, i64)> {
    let fp = fingerprint(&occ.parsed);
    db::upsert_error_issue(
        pool,
        occ.app_id,
        &fp,
        &occ.parsed.kind,
        &occ.parsed.message,
        &culprit(&occ.parsed),
        &occ.handler,
        occ.source,
        occ.count,
        occ.first_us,
        occ.last_us,
        occ.sha,
    )
    .await?;
    let hour = hour_bucket(occ.last_us);
    let req = occ.request.as_ref();
    db::insert_error_event(
        pool,
        &db::NewErrorEvent {
            app_id: occ.app_id,
            fingerprint: &fp,
            ts_us: occ.last_us,
            trace_id: &occ.trace_id,
            source: occ.source,
            handler: &occ.handler,
            cell: &occ.cell,
            kind: &occ.parsed.kind,
            message: &occ.parsed.message,
            context: &occ.parsed.context,
            frames: &serde_json::to_string(&occ.parsed.frames)?,
            logs: &serde_json::to_string(&occ.logs)?,
            method: req.map(|r| r.method.as_str()).unwrap_or(""),
            path: req.map(|r| r.path.as_str()).unwrap_or(""),
            http_status: req.map(|r| r.status).unwrap_or(0),
            browser: req.map(|r| r.browser).unwrap_or(""),
            os: req.map(|r| r.os).unwrap_or(""),
            sha: occ.sha.unwrap_or(""),
            url: &occ.url,
            release: &occ.release,
            environment: &occ.environment,
        },
    )
    .await?;
    db::prune_error_events(pool, occ.app_id, &fp, EVENTS_PER_ISSUE).await?;
    Ok((fp, hour, occ.count))
}

/// One Sentry stack frame as the UI forwards it: oldest-first, exactly as the
/// SDK sends it, with the SDK's own `in_app` flag (trusted per the phase-2
/// mapping, like phase 1 trusts V8 order).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkFrame {
    #[serde(default)]
    pub function: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub in_app: bool,
}

/// One Sentry event item as the UI forwards it (already parsed from the
/// envelope and mapped: type/message, not-yet-reversed frames, the page URL
/// with its query stripped, release, environment and the raw user agent,
/// which is classified here and never stored raw).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SdkEvent {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub frames: Vec<SdkFrame>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub release: String,
    #[serde(default)]
    pub environment: String,
    #[serde(default)]
    pub user_agent: String,
    #[serde(default)]
    pub trace_id: String,
    #[serde(default)]
    pub timestamp_us: i64,
    /// `browser` for browser SDK events, `sdk` for server SDKs.
    #[serde(default)]
    pub source: String,
}

/// Strip the query string and fragment the UI was supposed to remove already:
/// defense in depth, so a query never reaches storage through this path.
fn strip_url_query(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or("")
}

/// The URL's path for the `path` column (the breakdown the Metrics tab
/// already keeps), defaulting to `/` when the URL carries none.
fn url_path(url: &str) -> String {
    let clean = strip_url_query(url);
    let after_scheme = clean.split("://").nth(1).unwrap_or(clean);
    let path = after_scheme.split_once('/').map(|(_, rest)| rest).unwrap_or("");
    format!("/{path}")
}

/// An SDK event as the stored parse: kind/message clipped like phase 1, no
/// log context, and frames reversed from Sentry's oldest-first to phase 1's
/// newest-first so the fingerprint reads the same in-app names in the same
/// order. Pure, so the grouping parity with `parse_span_error` is a unit
/// test, not an integration one.
fn sdk_parsed(event: &SdkEvent) -> ParsedError {
    let frames: Vec<Frame> = event
        .frames
        .iter()
        .rev()
        .take(MAX_FRAMES)
        .map(|f| Frame {
            function: clip(&f.function, MAX_MESSAGE),
            location: clip(&f.location, MAX_MESSAGE),
            in_app: f.in_app,
        })
        .collect();
    ParsedError {
        kind: if event.kind.is_empty() {
            "Error".to_string()
        } else {
            clip(&event.kind, MAX_MESSAGE)
        },
        message: clip(&event.message, MAX_MESSAGE),
        frames,
        context: String::new(),
    }
}

/// Turn one envelope batch into stored issues through the same `record` path
/// as the telemetry ingest, so fingerprints match phase 1's for the same
/// exception. Returns the fingerprints that gained occurrences. Hour buckets
/// aggregate in memory first (replace semantics, like `ingest`), so two
/// events of one issue in one envelope count twice instead of overwriting
/// each other.
pub async fn ingest_sdk(
    pool: &SqlitePool,
    app_id: &str,
    sha: Option<&str>,
    events: &[SdkEvent],
) -> anyhow::Result<Vec<String>> {
    let mut counts: HashMap<(String, String, String), i64> = HashMap::new();
    let mut issues: HashSet<(String, String)> = HashSet::new();
    let mut fps = Vec::new();
    for event in events {
        // Sentry lists frames oldest-first; phase 1 stores newest-first, and
        // the fingerprint reads the first in-app frames — reverse so the same
        // exception groups with its telemetry twin (see `sdk_parsed`).
        let parsed = sdk_parsed(event);
        let source: &'static str = if event.source == "browser" { "browser" } else { "sdk" };
        let (browser, os) = super::accesslog::device_classify(&event.user_agent);
        let url = strip_url_query(&event.url).to_string();
        let ts = if event.timestamp_us > 0 {
            event.timestamp_us
        } else {
            super::metrics::now_us()
        };
        let occ = Occurrence {
            app_id,
            parsed,
            source,
            handler: source.to_string(),
            cell: String::new(),
            trace_id: event.trace_id.clone(),
            count: 1,
            first_us: ts,
            last_us: ts,
            logs: Vec::new(),
            request: Some(RequestCtx {
                method: String::new(),
                path: url_path(&url),
                status: 0,
                browser,
                os,
            }),
            sha,
            url,
            release: clip(&event.release, MAX_MESSAGE),
            environment: clip(&event.environment, MAX_MESSAGE),
        };
        let (fp, hour, n) = record(pool, &occ).await?;
        *counts.entry((app_id.to_string(), fp.clone(), hour)).or_default() += n;
        issues.insert((app_id.to_string(), fp.clone()));
        fps.push(fp);
    }
    for ((app_id, fp, hour), n) in &counts {
        db::set_error_hour(pool, app_id, fp, hour, *n).await?;
    }
    for (app_id, fp) in &issues {
        db::refresh_error_issue_count(pool, app_id, fp).await?;
    }
    Ok(fps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uncaught_span_errors() {
        let p = parse_span_error(
            "rejected: PaymentError: card declined for amount 500 [at chargeCard (worker.js:21:27) <- at fetch (worker.js:34:9)]",
        );
        assert_eq!(p.kind, "PaymentError");
        assert_eq!(p.message, "card declined for amount 500");
        assert_eq!(p.frames.len(), 2);
        assert_eq!(p.frames[0].function, "chargeCard");
        assert_eq!(p.frames[0].location, "worker.js:21:27");
        assert!(p.frames[0].in_app);
        assert_eq!(culprit(&p), "chargeCard (worker.js:21)");
    }

    #[test]
    fn marks_runtime_frames_internal() {
        let p = parse_span_error(
            "rejected: SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2) [at JSON.parse (<anonymous>) <- at fetch (worker.js:38:21)]",
        );
        assert_eq!(p.kind, "SyntaxError");
        assert_eq!(
            p.message,
            "Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        );
        assert!(!p.frames[0].in_app);
        assert!(p.frames[1].in_app);
        assert_eq!(culprit(&p), "fetch (worker.js:38)");
    }

    #[test]
    fn durable_object_parent_and_child_share_a_fingerprint() {
        let child = parse_span_error(
            "rejected: TypeError: durable object blew up [at Counter.fetch (worker.js:26:11) <- at <anonymous>:5300:51 <- at __ctxRun (<anonymous>:3760:12)]",
        );
        let parent = parse_span_error(
            "rejected: Error: rejected: TypeError: durable object blew up [at Counter.fetch (worker.js:26:11) <- at <anonymous>:5300:51 <- at __ctxRun (<anonymous>:3760:12)]",
        );
        assert_eq!(child, parent);
        assert_eq!(child.kind, "TypeError");
        assert_eq!(child.frames[1].function, "");
        assert!(!child.frames[1].in_app);
        assert!(!child.frames[2].in_app);
    }

    #[test]
    fn stackless_and_non_error_throws() {
        let p = parse_span_error("rejected: something odd happened");
        assert_eq!(p.kind, "Error");
        assert_eq!(p.message, "something odd happened");
        assert!(p.frames.is_empty());
        assert_eq!(culprit(&p), "");
    }

    #[test]
    fn parses_logged_errors_with_context() {
        let p = parse_log_error(
            "ERROR charge failed PaymentError: card declined for amount 900\n    at chargeCard (worker.js:21:27)\n    at fetch (worker.js:43:11)",
        )
        .expect("logged error");
        assert_eq!(p.context, "charge failed");
        assert_eq!(p.kind, "PaymentError");
        assert_eq!(p.message, "card declined for amount 900");
        assert_eq!(p.frames.len(), 2);

        let w = parse_log_error(
            "ERROR waitUntil rejected RangeError: background task failed\n    at worker.js:52:17\n    at fetch (worker.js:53:11)",
        )
        .expect("waitUntil error");
        assert_eq!(w.context, "waitUntil rejected");
        assert_eq!(w.kind, "RangeError");
        assert_eq!(w.frames[0].function, "");
        assert_eq!(w.frames[0].location, "worker.js:52:17");
        assert_eq!(culprit(&w), "worker.js:52");
    }

    #[test]
    fn ignores_logs_without_a_stack() {
        assert!(parse_log_error("hello from spike").is_none());
        assert!(parse_log_error("ERROR plain string, no stack").is_none());
        assert!(parse_log_error("WARN TypeError: x\n    at f (a.js:1:1)").is_none());
    }

    #[test]
    fn logged_and_uncaught_forms_of_one_bug_group_together() {
        let thrown = parse_span_error(
            "rejected: PaymentError: card declined for amount 500 [at chargeCard (worker.js:21:27) <- at fetch (worker.js:34:9)]",
        );
        let logged = parse_log_error(
            "ERROR charge failed PaymentError: card declined for amount 900\n    at chargeCard (worker.js:21:27)\n    at fetch (worker.js:43:11)",
        )
        .expect("logged");
        assert_eq!(fingerprint(&thrown), fingerprint(&logged));
    }

    #[test]
    fn fingerprint_ignores_line_numbers_but_not_types() {
        let a = parse_span_error("rejected: TypeError: x [at f (worker.js:1:1)]");
        let b = parse_span_error("rejected: TypeError: y [at f (worker.js:99:4)]");
        let c = parse_span_error("rejected: RangeError: x [at f (worker.js:1:1)]");
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn stackless_fingerprint_normalizes_ids_and_numbers() {
        let a = parse_span_error("rejected: Error: user 42 not found (id 3f2a9c1e-77aa-4b1e)");
        let b = parse_span_error("rejected: Error: user 7 not found (id 9b1d0c2f-11ee-4c2a)");
        let c = parse_span_error("rejected: Error: quota exceeded");
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
    }

    #[test]
    fn request_index_expires_by_capacity() {
        let mut idx = RequestIndex::default();
        let ctx = RequestCtx {
            method: "GET".into(),
            path: "/".into(),
            status: 500,
            browser: "CLI",
            os: "",
        };
        idx.insert("a".into(), ctx.clone());
        assert_eq!(idx.get("a").map(|r| r.status), Some(500));
        for i in 0..REQUEST_CAP {
            idx.insert(format!("t{i}"), ctx.clone());
        }
        assert!(idx.get("a").is_none());
        assert!(idx.map.len() <= REQUEST_CAP);
    }

    fn sdk_twin() -> SdkEvent {
        // The same exception as `parses_uncaught_span_errors`, in Sentry's
        // oldest-first frame order with the SDK's in_app flags.
        SdkEvent {
            kind: "PaymentError".to_string(),
            message: "card declined for amount 500".to_string(),
            frames: vec![
                SdkFrame {
                    function: "fetch".to_string(),
                    location: "worker.js:34:9".to_string(),
                    in_app: true,
                },
                SdkFrame {
                    function: "chargeCard".to_string(),
                    location: "worker.js:21:27".to_string(),
                    in_app: true,
                },
            ],
            url: "https://shop.example.com/checkout?plan=pro#pay".to_string(),
            release: "shop@2.0.1".to_string(),
            environment: "production".to_string(),
            user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36".to_string(),
            trace_id: "sdk-trace-1".to_string(),
            timestamp_us: 1_789_000_000_000_000,
            source: "browser".to_string(),
        }
    }

    #[test]
    fn sdk_events_group_with_their_telemetry_twin() {
        let twin = parse_span_error(
            "rejected: PaymentError: card declined for amount 500 [at chargeCard (worker.js:21:27) <- at fetch (worker.js:34:9)]",
        );
        let parsed = sdk_parsed(&sdk_twin());
        assert_eq!(parsed.kind, "PaymentError");
        assert_eq!(parsed.frames[0].function, "chargeCard");
        assert_eq!(parsed.frames[1].function, "fetch");
        assert_eq!(fingerprint(&parsed), fingerprint(&twin));
        assert_eq!(culprit(&parsed), "chargeCard (worker.js:21)");
    }

    #[test]
    fn sdk_urls_lose_query_and_fragment_but_keep_path() {
        assert_eq!(strip_url_query("https://a.example/x?y=1#z"), "https://a.example/x");
        assert_eq!(url_path("https://shop.example.com/checkout?plan=pro"), "/checkout");
        assert_eq!(url_path("https://shop.example.com"), "/");
        assert_eq!(url_path("/already/a/path"), "/already/a/path");
    }

    /// In-memory pool with the metrics schema attached (the `db::errors`
    /// tests' pattern): `ingest_sdk` writes issues, events and hour buckets
    /// there, never to the main schema.
    async fn metrics_pool() -> SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .after_connect(|conn: &mut sqlx::sqlite::SqliteConnection, _| {
                Box::pin(async move {
                    crate::db::attach_metrics!(conn, ":memory:");
                    Ok::<_, sqlx::Error>(())
                })
            })
            .connect("sqlite::memory:")
            .await
            .expect("in-memory db")
    }

    #[tokio::test]
    async fn ingest_sdk_stores_browser_occurrences_with_extras() {
        let pool = metrics_pool().await;
        let fps = ingest_sdk(&pool, "app-x", Some("abc123"), &[sdk_twin()])
            .await
            .expect("ingest");
        assert_eq!(fps.len(), 1);
        let twin = parse_span_error(
            "rejected: PaymentError: card declined for amount 500 [at chargeCard (worker.js:21:27) <- at fetch (worker.js:34:9)]",
        );
        assert_eq!(fps[0], fingerprint(&twin));
        let issue = crate::db::get_error_issue(&pool, "app-x", &fps[0])
            .await
            .expect("issue read")
            .expect("issue");
        assert_eq!(issue.source, "browser");
        assert_eq!(issue.count, 1);
        let events = crate::db::list_error_events(&pool, "app-x", &fps[0])
            .await
            .expect("events read");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].url, "https://shop.example.com/checkout");
        assert_eq!(events[0].release, "shop@2.0.1");
        assert_eq!(events[0].environment, "production");
        assert_eq!(events[0].path, "/checkout");
        assert_eq!(events[0].browser, "Chrome");
        assert_eq!(events[0].os, "macOS");
        assert_eq!(events[0].sha, "abc123");
    }

    #[tokio::test]
    async fn ingest_sdk_counts_two_envelope_events_in_one_hour() {
        let pool = metrics_pool().await;
        let mut second = sdk_twin();
        second.trace_id = "sdk-trace-2".to_string();
        let fps = ingest_sdk(&pool, "app-x", None, &[sdk_twin(), second])
            .await
            .expect("ingest");
        assert_eq!(fps[0], fps[1]);
        let issue = crate::db::get_error_issue(&pool, "app-x", &fps[0])
            .await
            .expect("issue read")
            .expect("issue");
        // Replace-semantics buckets aggregate in memory first: both events
        // count instead of the second hour write overwriting the first.
        assert_eq!(issue.count, 2);
    }
}
