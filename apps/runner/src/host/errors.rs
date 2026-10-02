//! Error tracking from celld telemetry, no SDK required.
//!
//! Two signals carry an exception (verified against celld 0.6.0; since
//! 0.6.1 the log level is a severity column, and the ingest puts the prefix
//! back, host/metrics.rs `ingest_all`):
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
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::db;

/// Occurrences kept per issue (newest first).
pub const EVENTS_PER_ISSUE: i64 = 20;
/// Log lines of the failing trace kept with one occurrence.
const LOGS_PER_EVENT: usize = 20;
/// Frames kept per occurrence: V8 captures 10 by default, a custom
/// `Error.stackTraceLimit` can raise it arbitrarily.
const MAX_FRAMES: usize = 50;
/// Bound on logged errors recorded per app per ingest pass (a hot loop of
/// `console.error(err)` must not turn into thousands of writes).
const MAX_LOGGED_PER_PASS: usize = 200;
/// Stored message cap: messages can embed whole payloads.
const MAX_MESSAGE: usize = 2000;
/// Frames that feed the fingerprint.
const FINGERPRINT_FRAMES: usize = 5;
/// Trace → request entries: kept long enough to outlive the telemetry flush
/// lag (flush + 10 s, 40 s by default), bounded against bursts.
const REQUEST_TTL: Duration = Duration::from_secs(15 * 60);
const REQUEST_CAP: usize = 50_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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
    Frame { function, location, in_app }
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
    let ids = IDS.get_or_init(|| regex::Regex::new(r"[0-9a-fA-F][0-9a-fA-F-]{7,}").expect("ids re"));
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
}

/// `celld.cell_fetch` → `cell_fetch`: the handler that failed.
fn handler_of(span_name: &str) -> String {
    span_name.strip_prefix("celld.").unwrap_or(span_name).to_string()
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
        };
        record(pool, &occ).await?;
        touched.push(app_id.clone());
    }
    let mut logged: HashMap<&str, usize> = HashMap::new();
    for row in logs {
        let Some(app_id) = slug_id.get(&row.slug) else {
            continue;
        };
        let Some(parsed) = parse_log_error(&row.body) else {
            continue;
        };
        let n = logged.entry(app_id.as_str()).or_default();
        if *n >= MAX_LOGGED_PER_PASS {
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
        };
        record(pool, &occ).await?;
        touched.push(app_id.clone());
    }
    touched.sort();
    touched.dedup();
    Ok(touched)
}

async fn record(pool: &SqlitePool, occ: &Occurrence<'_>) -> anyhow::Result<()> {
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
    let hour = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(occ.last_us)
        .map(|d| d.format("%Y-%m-%dT%H:00:00Z").to_string())
        .unwrap_or_default();
    db::add_error_hour(pool, occ.app_id, &fp, &hour, occ.count).await?;
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
        },
    )
    .await?;
    db::prune_error_events(pool, occ.app_id, &fp, EVENTS_PER_ISSUE).await?;
    Ok(())
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
        assert_eq!(p.message, "Expected property name or '}' in JSON at position 1 (line 1 column 2)");
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
}
