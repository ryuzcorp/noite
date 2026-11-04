//! D1 migrations for Void apps (SPEC, Deploy pipeline): after the staged
//! deploy, the one activate, and a successful reload adoption, before the
//! deploy is marked success, the runner drives the new generation's in-worker
//! migration endpoints over the fleet's own listen port — the same endpoints
//! Void's platform calls, with the same auth (`x-void-internal:
//! __VOID_PROXY_TOKEN`, the per-fleet token [`crate::host::void_deploy`]
//! provisions) and the same wire protocol:
//!
//! - protocol v2 where the worker advertises it (`GET
//!   /__void/migrate/capabilities`, then `POST /__void/migrate/app` with an
//!   attempt id, reconcile-on-unknown via `GET
//!   /__void/migrate/app/attempt/:attemptId`, then `POST /__void/migrate/auth`
//!   when advertised),
//! - legacy `POST /__void/migrate` otherwise (older sqlite runtimes only).
//!
//! Execution stays in-worker, so `_void_migrations` and the v2
//! attempt/lock/fence tables match Void exactly. The runner only verifies:
//! for v2 it recomputes the migration list hash from the pushed tree's
//! `db/migrations/*.sql` (the classifier below, a line-for-line port of
//! Void's `deploy-core` classifier plus `migrations/plan.ts`) and refuses a
//! worker whose dialect, classifier version or list hash differs — the
//! platform's capability negotiation, mirrored.
//!
//! Postgres/MySQL apps (a `hyperdrive` binding, no D1) are refused loudly:
//! their in-worker handlers need a Hyperdrive `connectionString` Noite does
//! not provide, and deploying them anyway would serve an empty database.
//! Previews run the same step against their own fleet (each environment has
//! its own bucket, ports and D1), so preview and production migrate
//! independently.
//!
//! Ordering (SPEC documents the window): the fleet pointer moves atomically
//! at `activate` — staged versions serve nothing until then — but execution
//! stays in-worker, so this step still runs after reload adoption: only the
//! adopted worker can run its bundled migrations. Between adoption and this
//! step the new code serves the old schema (Void migrates the uploaded
//! worker *before* traffic switches to it; celld has no version-pinned
//! invocation, so Noite cannot): keep migrations backward-compatible
//! (expand before contract). A failed migration fails the deploy with the
//! new generation serving; applied migrations are never rolled back
//! (forward-only: redeploying applies what is pending, skipping the rest).

use std::path::{Component, Path, PathBuf};

use anyhow::Context;
use serde_json::Value;
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/// One migration file: Void's `collectMigrations` entry (`{name, sql}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationFile {
    pub name: String,
    pub sql: String,
}

/// Bounds on the migration tree read: pushed trees are untrusted, and an
/// unbounded collect lets one app OOM the runner (a symlink to `/dev/zero`)
/// or wedge an executor thread (a fifo). Real trees hold dozens of kilobyte
/// files; these caps sit orders of magnitude above that.
pub const MAX_MIGRATION_FILES: usize = 10_000;
/// Per-file SQL cap.
pub const MAX_MIGRATION_FILE_BYTES: usize = 16 * 1024 * 1024;
/// Total SQL cap across the directory.
pub const MAX_MIGRATION_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// `void.json` is a small manifest; anything past this is hostile or broken.
pub const MAX_VOID_JSON_BYTES: usize = 1024 * 1024;

/// Collect `*.sql` from `dir`, sorted by filename, excluding `seed.sql` —
/// Void's `migrations/collect.ts` rule, confirmed by running it (see the
/// `collector` golden vectors): the match is case-sensitive (`.SQL` is not
/// collected), the read is non-recursive (a `meta/` dir contributes nothing),
/// and a missing directory collects nothing. File bytes decode lossy, as
/// Node's `readFileSync(..., 'utf-8')` does, so hashes match even for
/// non-UTF-8 files. Blocking file I/O: callers run this off the async
/// executor. Any other I/O error fails loudly, as does anything that is not
/// a regular file (a symlink, fifo, device or *directory* named `*.sql` —
/// Node chokes on the directory too, and follows the symlink, where this
/// refuses it) or anything past the caps above.
pub fn collect_migrations(dir: &Path) -> anyhow::Result<Vec<MigrationFile>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };
    // Rust byte order equals Node's UTF-16 code-unit order for every string
    // without lone surrogates (impossible here: names decode lossy, as the
    // lone-surrogate-free U+FFFD, on both sides).
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("read {}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".sql") && name != "seed.sql" {
            names.push(name);
            if names.len() > MAX_MIGRATION_FILES {
                anyhow::bail!(
                    "refusing to collect migrations from {}: more than {} files",
                    dir.display(),
                    MAX_MIGRATION_FILES
                );
            }
        }
    }
    names.sort();
    let mut files = Vec::with_capacity(names.len());
    let mut total = 0usize;
    for name in names {
        let path = dir.join(&name);
        // `symlink_metadata` follows nothing (as the runner's other tree
        // readers): only a regular file is ever collected.
        let file_type = std::fs::symlink_metadata(&path)
            .with_context(|| format!("read {}", name))?
            .file_type();
        if !file_type.is_file() {
            anyhow::bail!("refusing to collect {}: not a regular file", name);
        }
        let bytes = read_capped_file(&path, &name, MAX_MIGRATION_FILE_BYTES)?;
        total += bytes.len();
        if total > MAX_MIGRATION_TOTAL_BYTES {
            anyhow::bail!(
                "refusing to collect migrations from {}: over the {} MiB total cap",
                dir.display(),
                MAX_MIGRATION_TOTAL_BYTES / 1024 / 1024
            );
        }
        files.push(MigrationFile {
            name,
            sql: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    Ok(files)
}

/// Read one file with a hard byte cap. `take(limit + 1)` cuts both a plain
/// oversized file and a stream that never ends (a fifo); the pre-check reads
/// nothing, so there is no stat-then-read race to win.
fn read_capped_file(path: &Path, name: &str, limit: usize) -> anyhow::Result<Vec<u8>> {
    use std::io::Read as _;
    let file = std::fs::File::open(path).with_context(|| format!("read {}", name))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {}", name))?;
    if bytes.len() > limit {
        anyhow::bail!(
            "refusing to collect {}: over the {} MiB per-file cap",
            name,
            limit / 1024 / 1024
        );
    }
    Ok(bytes)
}

/// The tree's migrations directory: `<root>/db/migrations`, or under
/// `void.json`'s `sourceDir` when set (Void's `readProjectPaths`). An
/// absolute `sourceDir`, or one escaping the root via `..`, fails the deploy
/// instead of taking the runner outside the worktree, as does a symlink
/// anywhere in the resolved path below the root (a `sourceDir` component
/// pointing at `/`, a symlinked `db/`); a missing or unreadable `void.json`
/// falls back to the root (the build already parsed it, and the
/// capabilities-first flow still runs the worker's bundled migrations when
/// the tree has none). Only an oversized `void.json` fails instead of
/// falling back. Blocking file I/O, like the collect call.
pub fn resolve_migrations_dir(src_dir: &Path) -> anyhow::Result<PathBuf> {
    let mut root = src_dir.to_path_buf();
    if let Some(text) = read_void_json(src_dir)? {
        if let Some(dir) = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
            value
                .get("sourceDir")
                .and_then(Value::as_str)
                .map(str::to_string)
        }) {
            let rel = Path::new(&dir);
            if rel.is_absolute() || rel.components().any(|c| matches!(c, Component::ParentDir)) {
                anyhow::bail!(
                    "void.json \"sourceDir\" {:?} must be a relative path without `..`",
                    dir
                );
            }
            root = src_dir.join(rel);
        }
    }
    let dir = root.join("db").join("migrations");
    refuse_symlinked_components(src_dir, &dir)?;
    Ok(dir)
}

/// `void.json`'s text, or `None` when it is missing, unreadable or not
/// UTF-8 (all fall back to the root, as before). Only an oversized manifest
/// fails the deploy instead.
fn read_void_json(src_dir: &Path) -> anyhow::Result<Option<String>> {
    use std::io::Read as _;
    let Ok(file) = std::fs::File::open(src_dir.join("void.json")) else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    let Ok(_) = file
        .take(MAX_VOID_JSON_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
    else {
        return Ok(None);
    };
    if bytes.len() > MAX_VOID_JSON_BYTES {
        anyhow::bail!(
            "void.json is over the {} MiB cap; refusing to parse it",
            MAX_VOID_JSON_BYTES / 1024 / 1024
        );
    }
    Ok(String::from_utf8(bytes).ok())
}

/// Refuse a symlink anywhere in `dir` below `src_dir`: following one could
/// hash bytes from outside the worktree. Missing components are fine —
/// collection treats a missing directory as no migrations.
fn refuse_symlinked_components(src_dir: &Path, dir: &Path) -> anyhow::Result<()> {
    let mut current = dir;
    while let Ok(suffix) = current.strip_prefix(src_dir) {
        if suffix.as_os_str().is_empty() {
            break;
        }
        if std::fs::symlink_metadata(current).is_ok_and(|meta| meta.file_type().is_symlink()) {
            anyhow::bail!(
                "refusing to collect migrations: {} is a symlink",
                suffix.display()
            );
        }
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Deploy-facing small helpers
// ---------------------------------------------------------------------------

/// Flatten tenant- or engine-controlled text to one log line: the deploy log
/// is a line stream, and a raw newline would forge lines past the `ERROR:`
/// prefix. Every line separator becomes a space — CR, LF, CRLF (one space),
/// vertical tab, form feed, NEL, U+2028/U+2029 — everything else verbatim.
pub fn one_line(text: &str) -> String {
    text.replace("\r\n", " ").replace(
        ['\r', '\n', '\x0b', '\x0c', '\u{85}', '\u{2028}', '\u{2029}'],
        " ",
    )
}

/// Mint a v2 attempt id: Void's `generateId('migatt')` shape
/// (`migatt_` + 12 base36 chars).
pub fn mint_attempt_id() -> String {
    use rand::TryRng as _;
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = [0u8; 12];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    let mut id = String::with_capacity(19);
    id.push_str("migatt_");
    for byte in bytes {
        id.push(ALPHABET[usize::from(byte % 36)] as char);
    }
    id
}

/// True when the deployed config declares a `hyperdrive` binding (a
/// Postgres/MySQL app: Void emits the binding exactly then).
pub fn config_has_hyperdrive(config: &Value) -> bool {
    config
        .get("hyperdrive")
        .and_then(Value::as_array)
        .is_some_and(|bindings| !bindings.is_empty())
}

/// True when the deployed config declares a `d1_databases` binding.
pub fn config_has_d1(config: &Value) -> bool {
    config
        .get("d1_databases")
        .and_then(Value::as_array)
        .is_some_and(|bindings| !bindings.is_empty())
}

// ---------------------------------------------------------------------------
// Classifier (a port of Void's `deploy-core` migration classifier plus
// `packages/void/src/migrations/plan.ts`)
// ---------------------------------------------------------------------------
//
// Only the list-hash check runs here; execution stays in-worker. Every hash
// must be byte-identical to Void's: the golden vectors
// (`testdata/void_migration_vectors.json`, generated by running Void's own
// functions) pin each step. Where JavaScript string semantics could differ,
// they are matched exactly (JS-space trimming, ASCII word boundaries, lossy
// reads); the one unobservable difference is documented on
// [`executable_sql`].

/// Void's `MIGRATION_CLASSIFIER_VERSION`.
pub const CLASSIFIER_VERSION: u32 = 1;

/// `sha256:`-prefixed hex over the string's UTF-8 bytes (Void's `sha256Hex`;
/// `TextEncoder` bytes are UTF-8 by definition).
fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let hex: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect();
    format!("sha256:{}", hex)
}

/// Void's `canonicalSql`: strip one leading BOM, normalize CRLF and lone CR.
fn canonical_sql(sql: &str) -> String {
    sql.strip_prefix('\u{feff}')
        .unwrap_or(sql)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

/// JavaScript `\s` (WhiteSpace plus LineTerminator): the exact set
/// `String.trim` and the transaction-control regex use.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// JavaScript `String.trim` over the exact space set.
fn trim_js(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// Void's `canonicalJson`: objects recurse with sorted keys, no whitespace.
/// `serde_json` maps sort keys (no `preserve_order` feature) and its string
/// escaping matches `JSON.stringify` over valid UTF-8 (short escapes plus
/// `\u00xx` for the remaining controls, raw UTF-8 otherwise); the golden
/// plan hashes prove it.
fn canonical_json(value: &Value) -> String {
    serde_json::to_string(value).expect("canonical JSON of a JSON value")
}

/// One [`tokenize_sql`] segment: byte offsets into the input (all delimiters
/// are ASCII, so byte and UTF-16 offsets slice identically).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Segment {
    kind: SegmentKind,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SegmentKind {
    Sql,
    LineComment,
    BlockComment,
    String,
    IdentQuote,
}

/// Emit the pending `sql` run, if any (Void's `flushRun`).
fn flush_run(segments: &mut Vec<Segment>, run_start: usize, up_to: usize) {
    if up_to > run_start {
        segments.push(Segment {
            kind: SegmentKind::Sql,
            start: run_start,
            end: up_to,
        });
    }
}

/// Void's `tokenizeSql`, 1:1: `--` line comments (to `\n` or EOF), `/*`
/// block comments (unterminated spans to EOF), `'...'` strings with `''`
/// escape, `"..."` / `` `...` `` identifier quotes with doubled-close
/// escape, `[...]` bracket identifiers with no escape (one `]` closes).
fn tokenize_sql(sql: &str) -> Vec<Segment> {
    let bytes = sql.as_bytes();
    let len = bytes.len();
    let mut segments = Vec::new();
    let mut index = 0;
    let mut run_start = 0;
    while index < len {
        let c = bytes[index];
        let next = bytes.get(index + 1).copied().unwrap_or(0);
        if c == b'-' && next == b'-' {
            flush_run(&mut segments, run_start, index);
            let mut scan = index + 2;
            while scan < len && bytes[scan] != b'\n' {
                scan += 1;
            }
            segments.push(Segment {
                kind: SegmentKind::LineComment,
                start: index,
                end: scan,
            });
            index = scan;
            run_start = index;
            continue;
        }
        if c == b'/' && next == b'*' {
            flush_run(&mut segments, run_start, index);
            let mut scan = index + 2;
            while scan + 1 < len && !(bytes[scan] == b'*' && bytes[scan + 1] == b'/') {
                scan += 1;
            }
            let end = (scan + 2).min(len);
            segments.push(Segment {
                kind: SegmentKind::BlockComment,
                start: index,
                end,
            });
            index = end;
            run_start = index;
            continue;
        }
        if c == b'\'' {
            flush_run(&mut segments, run_start, index);
            let mut scan = index + 1;
            while scan < len {
                if bytes.get(scan) == Some(&b'\'') && bytes.get(scan + 1) == Some(&b'\'') {
                    scan += 2;
                    continue;
                }
                if bytes.get(scan) == Some(&b'\'') {
                    scan += 1;
                    break;
                }
                scan += 1;
            }
            segments.push(Segment {
                kind: SegmentKind::String,
                start: index,
                end: scan,
            });
            index = scan;
            run_start = index;
            continue;
        }
        if c == b'"' || c == b'`' || c == b'[' {
            flush_run(&mut segments, run_start, index);
            let close = if c == b'[' { b']' } else { c };
            let mut scan = index + 1;
            while scan < len {
                if close != b']'
                    && bytes.get(scan) == Some(&close)
                    && bytes.get(scan + 1) == Some(&close)
                {
                    scan += 2;
                    continue;
                }
                if bytes.get(scan) == Some(&close) {
                    scan += 1;
                    break;
                }
                scan += 1;
            }
            segments.push(Segment {
                kind: SegmentKind::IdentQuote,
                start: index,
                end: scan,
            });
            index = scan;
            run_start = index;
            continue;
        }
        index += 1;
    }
    flush_run(&mut segments, run_start, len);
    segments
}

/// The `--> statement-breakpoint` line comments outside literals.
fn breakpoint_comments(normalized: &str) -> Vec<Segment> {
    tokenize_sql(normalized)
        .into_iter()
        .filter(|segment| {
            segment.kind == SegmentKind::LineComment
                && trim_js(&normalized[segment.start..segment.end]) == "--> statement-breakpoint"
        })
        .collect()
}

/// Void's `splitBreakpointFramedSql`.
fn split_breakpoint_framed_sql(sql: &str) -> Vec<String> {
    let normalized = canonical_sql(sql);
    let mut statements = Vec::new();
    let mut cursor = 0;
    for segment in breakpoint_comments(&normalized) {
        let statement = trim_js(&normalized[cursor..segment.start]);
        if !statement.is_empty() {
            statements.push(statement.to_string());
        }
        cursor = segment.end;
    }
    let statement = trim_js(&normalized[cursor..]);
    if !statement.is_empty() {
        statements.push(statement.to_string());
    }
    statements
}

/// ASCII word characters: JavaScript `\w` (and thus `\b`) is exactly this
/// set, so matching it manually is exact where a Unicode-aware regex would
/// diverge.
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// True when `text` holds `BEGIN` or `TRIGGER` as standalone words
/// (case-insensitive): Void's `/\b(?:BEGIN|TRIGGER)\b/i` over one `sql`
/// segment.
fn has_compound_keyword(text: &str) -> bool {
    let bytes = text.as_bytes();
    for window in [b"begin".as_slice(), b"trigger".as_slice()] {
        if bytes.len() < window.len() {
            continue;
        }
        for start in 0..=bytes.len() - window.len() {
            if !bytes[start..start + window.len()].eq_ignore_ascii_case(window) {
                continue;
            }
            let before = start.checked_sub(1).map(|i| bytes[i]);
            let after = bytes.get(start + window.len()).copied();
            if before.is_none_or(|b| !is_word_byte(b)) && after.is_none_or(|b| !is_word_byte(b)) {
                return true;
            }
        }
    }
    false
}

/// Statement ranges over the canonical SQL plus whether bare SQL holds a
/// compound-body keyword: Void's `scanStatements`. Only space, tab, LF and
/// CR separate statements there (vertical tab and form feed count as
/// statement text), mirrored exactly.
fn scan_statements(sql: &str) -> (String, Vec<(usize, usize)>, bool) {
    let normalized = canonical_sql(sql);
    let bytes = normalized.as_bytes();
    let mut ranges = Vec::new();
    let mut cursor = 0;
    let mut in_statement = false;
    let mut has_compound_body = false;
    for segment in tokenize_sql(&normalized) {
        match segment.kind {
            SegmentKind::LineComment | SegmentKind::BlockComment => continue,
            SegmentKind::String | SegmentKind::IdentQuote => {
                in_statement = true;
                continue;
            }
            SegmentKind::Sql => {}
        }
        if has_compound_keyword(&normalized[segment.start..segment.end]) {
            has_compound_body = true;
        }
        for (offset, &c) in bytes[segment.start..segment.end].iter().enumerate() {
            let index = segment.start + offset;
            if c == b';' {
                if in_statement {
                    ranges.push((cursor, index + 1));
                    in_statement = false;
                }
                cursor = index + 1;
                continue;
            }
            if c != b' ' && c != b'\t' && c != b'\n' && c != b'\r' {
                in_statement = true;
            }
        }
    }
    if in_statement {
        ranges.push((cursor, normalized.len()));
    }
    (normalized, ranges, has_compound_body)
}

/// Void's `isSingleStatement`.
fn is_single_statement(sql: &str) -> bool {
    scan_statements(sql).1.len() == 1
}

/// Void's `splitSqlStatements`: top-level `;` split, or `None` when a
/// compound `BEGIN ... END` body may hide inner semicolons.
fn split_sql_statements(sql: &str) -> Option<Vec<String>> {
    let (normalized, ranges, has_compound_body) = scan_statements(sql);
    if has_compound_body {
        return None;
    }
    Some(
        ranges
            .into_iter()
            .map(|(start, end)| trim_js(&normalized[start..end]).to_string())
            .collect(),
    )
}

/// Blank comments, strings and quoted identifiers to spaces, keeping offsets
/// stable: Void's `getExecutableSql`. Void repeats one space per UTF-16 unit
/// and this port one per char; the count is unobservable (the transaction
/// regex only classifies adjacency, and keywords are never inside blanked
/// regions).
fn executable_sql(sql: &str) -> String {
    let mut out = String::new();
    for segment in tokenize_sql(sql) {
        if segment.kind == SegmentKind::Sql {
            out.push_str(&sql[segment.start..segment.end]);
        } else {
            out.extend(std::iter::repeat_n(
                ' ',
                sql[segment.start..segment.end].chars().count(),
            ));
        }
    }
    out
}

/// Void's `includesTransactionControl`: the first `BEGIN [DEFERRED|IMMEDIATE|
/// EXCLUSIVE|TRANSACTION]`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or `RELEASE` at
/// a statement start (after `^` or `;`), uppercased with its `BEGIN` suffix,
/// over the executable SQL.
fn transaction_control(sql: &str) -> Option<String> {
    let executable = executable_sql(&canonical_sql(sql));
    for statement in executable.split(';') {
        let mut chars = statement.char_indices();
        let mut start = None;
        for (i, c) in chars.by_ref() {
            if !is_js_space(c) {
                start = Some(i);
                break;
            }
        }
        let Some(word_start) = start else {
            continue;
        };
        let rest = &statement[word_start..];
        // Word characters are ASCII-only (as in JavaScript `\w`); comparing
        // on chars keeps astral low bytes from aliasing ASCII letters.
        let word: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let upper = word.to_ascii_uppercase();
        let after_word = &rest[word.len()..];
        if upper == "BEGIN" {
            let suffix_start = after_word.find(|c: char| !is_js_space(c));
            if let Some(offset) = suffix_start {
                let suffix_rest = &after_word[offset..];
                let suffix: String = suffix_rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                let suffix_upper = suffix.to_ascii_uppercase();
                if ["DEFERRED", "IMMEDIATE", "EXCLUSIVE", "TRANSACTION"]
                    .contains(&suffix_upper.as_str())
                {
                    // Void's trailing `\b` applies to the suffixed BEGIN as
                    // well, so the boundary past the suffix must hold.
                    let after_suffix = &suffix_rest[suffix.len()..];
                    let boundary = after_suffix
                        .chars()
                        .next()
                        .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
                    if boundary {
                        return Some(format!("BEGIN {}", suffix_upper));
                    }
                }
            }
            let boundary = after_word
                .chars()
                .next()
                .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            if boundary {
                return Some("BEGIN".to_string());
            }
        } else if ["COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"].contains(&upper.as_str()) {
            let boundary = after_word
                .chars()
                .next()
                .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            if boundary {
                return Some(upper);
            }
        }
    }
    None
}

/// One classified migration: Void's `MigrationExecutionPlan` (the hash
/// preimage fields; the policy marker `allowLegacy` is deliberately not
/// modeled — it is not hashed, and execution policy stays in-worker).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedMigration {
    pub kind: &'static str,
    pub stability: &'static str,
    pub statements: Option<Vec<String>>,
    pub classifier_version: u32,
    pub name: String,
    pub sql_hash: String,
    pub plan_hash: String,
    pub warnings: Vec<String>,
}

impl PlannedMigration {
    /// Void's `getMigrationPlanHashInput`: the preserved classifier-v1 hash
    /// preimage (policy markers and warnings are not hashed).
    fn hash_input(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert(
            "classifierVersion".to_string(),
            Value::Number(self.classifier_version.into()),
        );
        map.insert("dialect".to_string(), Value::String("sqlite".to_string()));
        map.insert("kind".to_string(), Value::String(self.kind.to_string()));
        map.insert("name".to_string(), Value::String(self.name.clone()));
        map.insert("sqlHash".to_string(), Value::String(self.sql_hash.clone()));
        map.insert(
            "stability".to_string(),
            Value::String(self.stability.to_string()),
        );
        if let Some(statements) = &self.statements {
            map.insert(
                "statements".to_string(),
                Value::Array(
                    statements
                        .iter()
                        .map(|statement| Value::String(statement.clone()))
                        .collect(),
                ),
            );
        }
        Value::Object(map)
    }
}

/// Classify one migration: Void's `migrations/plan.ts classifyMigration`,
/// messages included.
pub fn classify_migration(name: &str, sql: &str) -> Result<PlannedMigration, String> {
    let canonical = canonical_sql(sql);
    let sql_hash = sha256_hex(&canonical);
    if let Some(keyword) = transaction_control(sql) {
        return Err(format!(
            "Migration {} contains {}; Void owns the stable D1 transaction boundary.",
            name, keyword
        ));
    }
    let has_breakpoints = !breakpoint_comments(&canonical).is_empty();
    let (kind, stability, statements) = if has_breakpoints {
        let statements = split_breakpoint_framed_sql(sql);
        if statements.is_empty() {
            return Err(format!(
                "Migration {} has statement breakpoints but no SQL statements.",
                name
            ));
        }
        ("breakpoint-framed", "stable", Some(statements))
    } else if is_single_statement(sql) {
        ("single-statement", "stable", None)
    } else {
        ("legacy-unsplit-multi-statement", "legacy", None)
    };
    let mut plan = PlannedMigration {
        kind,
        stability,
        statements,
        classifier_version: CLASSIFIER_VERSION,
        name: name.to_string(),
        sql_hash,
        plan_hash: String::new(),
        warnings: Vec::new(),
    };
    plan.plan_hash = sha256_hex(&canonical_json(&plan.hash_input()));
    if kind == "legacy-unsplit-multi-statement" && split_sql_statements(sql).is_none() {
        plan.warnings.push(format!(
            "Add a `--> statement-breakpoint` line after each complete SQL statement in migration {}.",
            name
        ));
    }
    Ok(plan)
}

/// The deploy-side plan bundle: Void's `MigrationPlanBundle`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanBundle {
    pub classifier_version: u32,
    pub migration_list_hash: String,
    pub plans: Vec<PlannedMigration>,
}

/// Plan every migration and hash the list: Void's `buildMigrationPlanBundle`.
/// The list hash commits to `[name, sqlHash, planHash]` per migration.
pub fn build_plan_bundle(migrations: &[MigrationFile]) -> Result<PlanBundle, String> {
    let mut plans = Vec::with_capacity(migrations.len());
    for migration in migrations {
        plans.push(classify_migration(&migration.name, &migration.sql)?);
    }
    let list = Value::Array(
        plans
            .iter()
            .map(|plan| {
                Value::Array(vec![
                    Value::String(plan.name.clone()),
                    Value::String(plan.sql_hash.clone()),
                    Value::String(plan.plan_hash.clone()),
                ])
            })
            .collect(),
    );
    Ok(PlanBundle {
        classifier_version: CLASSIFIER_VERSION,
        migration_list_hash: sha256_hex(&canonical_json(&list)),
        plans,
    })
}

// ---------------------------------------------------------------------------
// Protocol (a port of the platform's deploy-side caller:
// `platform/packages/api/src/deploy/migrate-worker.ts` + `migrations.ts`)
// ---------------------------------------------------------------------------

/// Bounds on worker migration responses: the worker is tenant-influenced,
/// so every body is stream-read with a hard byte cap and every parsed array
/// truncated — an unbounded `response.text()` plus per-warning DB writes
/// once let one app OOM the runner or stall the shared sqlite writer.
/// Healthy responses are kilobytes; these caps sit far above that.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// Parsed-array caps: entries past the cap are dropped and counted in
/// `migrations_dropped` / `warnings_dropped` on the response.
pub const MAX_RESPONSE_MIGRATIONS: usize = 10_000;
pub const MAX_RESPONSE_WARNINGS: usize = 50;
/// Log lines per deploy: the first warnings and migration names plus a
/// count, in one write — never one write per tenant-controlled entry.
pub const MAX_LOGGED_WARNINGS: usize = 20;
pub const MAX_LOGGED_MIGRATION_NAMES: usize = 20;

/// The migration HTTP client: it never follows redirects, so a
/// tenant-influenced worker cannot steer the fleet token in
/// `x-void-internal` to another host (reqwest's default follows up to ten,
/// keeping that header). Void's platform caller uses a redirect-less fetch,
/// so this matches the reference too.
pub fn migration_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("migration HTTP client builds")
}

/// Read one migration response body with the hard cap: a declared
/// `Content-Length` past the cap fails before a byte is buffered, and a
/// chunked body is cut mid-stream. A mid-body transport error keeps today's
/// shape (an empty body, which each caller's existing garbage/unknown
/// handling decides), so only the cap itself is a new failure.
async fn read_capped(response: reqwest::Response) -> Result<String, String> {
    if let Some(declared) = response.content_length() {
        if declared > MAX_RESPONSE_BYTES as u64 {
            return Err(format!(
                "migration response declares {} bytes, over the {} MiB cap",
                declared,
                MAX_RESPONSE_BYTES / 1024 / 1024
            ));
        }
    }
    use futures::StreamExt as _;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Ok(String::new());
        };
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "migration response body exceeded the {} MiB cap",
                MAX_RESPONSE_BYTES / 1024 / 1024
            ));
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// What the capabilities probe concluded. Like the platform, only a valid v2
/// shape counts as advertised; anything else (a 404 from the app router, a
/// legacy-only handler, garbage) falls back to the tree-driven decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    pub dialect: String,
    pub classifier_version: u32,
    pub migration_list_hash: String,
    pub auth_endpoint: Option<String>,
}

/// Why the capabilities probe did not yield v2: the fleet answered without
/// one (`Http`/`Shape`), answered with a body past the cap (`TooLarge`),
/// or did not answer at all (`Transport`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    Http { status: u16, preview: String },
    Shape { preview: String },
    TooLarge { message: String },
    Transport { message: String },
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Http { status, preview } => {
                write!(f, "worker capabilities probe HTTP {}: {}", status, preview)
            }
            ProbeError::Shape { preview } => {
                write!(f, "worker capabilities probe shape invalid: {}", preview)
            }
            ProbeError::TooLarge { message } => {
                write!(f, "worker capabilities response too large: {}", message)
            }
            ProbeError::Transport { message } => {
                write!(f, "worker capabilities probe request failed: {}", message)
            }
        }
    }
}

/// One migration entry of a worker response. Every field defaults: the
/// platform casts the wire shape without validating past the `migrations`
/// array, so a sparse entry must behave the same here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MigrationOutcome {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub applied: bool,
    #[serde(default, rename = "durationMs")]
    pub duration_ms: u64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub stability: Option<String>,
}

impl MigrationOutcome {
    /// Counts as applied, as the platform counts it (`applied` or the v2
    /// `applied` status).
    pub fn is_applied(&self) -> bool {
        self.applied || self.status.as_deref() == Some("applied")
    }

    pub fn is_skipped(&self) -> bool {
        self.status.as_deref() == Some("skipped")
    }
}

/// A worker migration response: the platform's
/// `UserWorkerMigrationResult`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct MigrateResponse {
    #[serde(default)]
    pub ok: bool,
    #[serde(default, rename = "attemptId")]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub migrations: Vec<MigrationOutcome>,
    #[serde(default, rename = "confirmedApplied")]
    pub confirmed_applied: Vec<String>,
    #[serde(default, rename = "confirmedSkipped")]
    pub confirmed_skipped: Vec<String>,
    #[serde(default)]
    pub stability: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Entries dropped by the parsed-array caps: the arrays above hold the
    /// first `MAX_RESPONSE_*` entries. Never from the wire (a hostile worker
    /// must not set its own counts).
    #[serde(skip)]
    pub warnings_dropped: usize,
    #[serde(skip)]
    pub migrations_dropped: usize,
}

impl MigrateResponse {
    fn transport_error(message: String) -> Self {
        Self {
            ok: false,
            attempt_id: None,
            migrations: Vec::new(),
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: Some(message),
            warnings_dropped: 0,
            migrations_dropped: 0,
        }
    }

    /// Drop parsed entries past the array caps, counting them: a worker
    /// returning a million warnings must cost a bounded Vec, not a million
    /// log writes downstream.
    fn truncate_arrays(&mut self) {
        if self.migrations.len() > MAX_RESPONSE_MIGRATIONS {
            self.migrations_dropped = self.migrations.len() - MAX_RESPONSE_MIGRATIONS;
            self.migrations.truncate(MAX_RESPONSE_MIGRATIONS);
        }
        if self.warnings.len() > MAX_RESPONSE_WARNINGS {
            self.warnings_dropped = self.warnings.len() - MAX_RESPONSE_WARNINGS;
            self.warnings.truncate(MAX_RESPONSE_WARNINGS);
        }
        // The confirmed lists mirror the migrations array; bound them the
        // same way (they are never logged, so they need no counter).
        self.confirmed_applied.truncate(MAX_RESPONSE_MIGRATIONS);
        self.confirmed_skipped.truncate(MAX_RESPONSE_MIGRATIONS);
    }
}

/// Validate one worker response body: the platform's
/// `normalizeUserWorkerMigrationResult` (object, with a `migrations` array),
/// plus the parsed-array caps (a valid shape with a million warnings parses
/// into the first fifty and a count).
pub fn normalize_response(value: Value, body_preview: &str) -> MigrateResponse {
    if !value.is_object() {
        return MigrateResponse {
            ok: false,
            attempt_id: None,
            migrations: Vec::new(),
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: Some(format!(
                "migration endpoint returned invalid response: {}",
                body_preview
            )),
            warnings_dropped: 0,
            migrations_dropped: 0,
        };
    }
    if value.get("migrations").and_then(Value::as_array).is_none() {
        return MigrateResponse {
            ok: false,
            attempt_id: None,
            migrations: Vec::new(),
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: Some(format!(
                "migration endpoint returned invalid response: missing migrations array ({})",
                body_preview
            )),
            warnings_dropped: 0,
            migrations_dropped: 0,
        };
    }
    let mut response: MigrateResponse =
        serde_json::from_value(value).unwrap_or_else(|_| MigrateResponse {
            ok: false,
            attempt_id: None,
            migrations: Vec::new(),
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: Some(format!(
                "migration endpoint returned invalid response: missing migrations array ({})",
                body_preview
            )),
            warnings_dropped: 0,
            migrations_dropped: 0,
        });
    response.truncate_arrays();
    response
}

/// Render a failed worker response for the deploy log: the platform's
/// `formatMigrationFailure` (`migration <name> failed: <error>`), sanitized
/// — the name is tenant-controlled, so it is Debug-quoted as
/// [`crate::host::worker_vars`] quotes required names, and the whole line is
/// flattened (engine errors carry newlines, e.g. MySQL's breakpoint note).
pub fn format_migration_failure(response: &MigrateResponse) -> String {
    let failed = response
        .migrations
        .iter()
        .find(|migration| migration.error.as_deref().is_some_and(|e| !e.is_empty()));
    let raw = match failed {
        Some(migration) => {
            let detail = migration.error.as_deref().unwrap_or_default();
            let name = &migration.name;
            if response
                .error
                .as_deref()
                .is_some_and(|e| e.contains(detail))
            {
                response.error.clone().unwrap_or_default()
            } else {
                format!("migration {:?} failed: {}", name, detail)
            }
        }
        None => response
            .error
            .clone()
            .unwrap_or_else(|| "unknown error".to_string()),
    };
    one_line(&raw)
}

/// Cloudflare's Workers-for-Platform asset-propagation stub, which the
/// platform's caller treats as "the worker is not serving its own code yet":
/// kept so an identical body can never parse as a migration result.
fn is_cf_asset_stub(text: &str) -> bool {
    text.trim_start().starts_with("Assets have")
}

fn preview(text: &str, len: usize) -> String {
    one_line(&text.chars().take(len).collect::<String>())
}

/// The deploy-side migration caller: `POST`/`GET` against the fleet's own
/// listen port with the per-fleet proxy token, mirroring the platform's
/// timeouts (10 s probes, 300 s executions, 30 s reconcile).
#[derive(Debug, Clone)]
pub struct MigrationClient {
    client: reqwest::Client,
    base: String,
    token: String,
    retry_delay: std::time::Duration,
}

impl MigrationClient {
    pub fn new(client: reqwest::Client, base: String, token: String) -> Self {
        Self {
            client,
            base,
            token,
            retry_delay: std::time::Duration::from_secs(1),
        }
    }

    /// Override the legacy retry base delay (the platform's
    /// `CF_MIGRATION_RETRY`: 1 s, doubled per attempt). Tests shorten it,
    /// so it exists only there.
    #[cfg(test)]
    pub fn with_retry_delay(mut self, delay: std::time::Duration) -> Self {
        self.retry_delay = delay;
        self
    }

    /// `GET /__void/migrate/capabilities`: the platform's
    /// `probeWorkerMigrationCapabilities`.
    pub async fn capabilities(&self) -> Result<Capabilities, ProbeError> {
        let url = format!("{}/__void/migrate/capabilities", self.base);
        let response = self
            .client
            .get(&url)
            .header("x-void-internal", &self.token)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| ProbeError::Transport {
                message: one_line(&e.to_string()),
            })?;
        let status = response.status().as_u16();
        let text = match read_capped(response).await {
            Ok(text) => text,
            Err(message) => return Err(ProbeError::TooLarge { message }),
        };
        if !(200..300).contains(&status) {
            return Err(ProbeError::Http {
                status,
                preview: preview(&text, 200),
            });
        }
        if is_cf_asset_stub(&text) {
            return Err(ProbeError::Shape {
                preview: "worker not serving its own code yet".to_string(),
            });
        }
        let data: Value = serde_json::from_str(&text).map_err(|_| ProbeError::Shape {
            preview: preview(&text, 200),
        })?;
        let protocol = data.get("protocolVersion").and_then(Value::as_u64);
        let dialect = data.get("dialect").and_then(Value::as_str);
        let classifier = data.get("classifierVersion").and_then(Value::as_u64);
        let list_hash = data.get("migrationListHash").and_then(Value::as_str);
        let destructive = data.get("destructiveValidation").and_then(Value::as_str);
        let auth = data
            .get("endpoints")
            .and_then(|endpoints| endpoints.get("auth"))
            .and_then(Value::as_str);
        let dialect_ok = matches!(dialect, Some("sqlite" | "postgresql" | "mysql"));
        match (protocol, dialect, classifier, list_hash, destructive) {
            (Some(2), Some(dialect), Some(classifier), Some(list_hash), Some("passed"))
                if dialect_ok =>
            {
                Ok(Capabilities {
                    dialect: dialect.to_string(),
                    classifier_version: u32::try_from(classifier).unwrap_or(u32::MAX),
                    migration_list_hash: list_hash.to_string(),
                    auth_endpoint: auth.map(str::to_string),
                })
            }
            _ => Err(ProbeError::Shape {
                preview: preview(&text, 200),
            }),
        }
    }

    /// `POST /__void/migrate/app`, reconciling unknown outcomes: the
    /// platform's `dispatchStableAppMigration`. A transport error or an
    /// unparsable body reconciles via `GET .../attempt/:attemptId`; a parsed
    /// `ok: false` is definitive and returns as is.
    pub async fn migrate_app(&self, attempt_id: &str, deployment_id: &str) -> MigrateResponse {
        let url = format!("{}/__void/migrate/app", self.base);
        let body = serde_json::json!({"attemptId": attempt_id, "deploymentId": deployment_id});
        match self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("x-void-internal", &self.token)
            .timeout(std::time::Duration::from_secs(300))
            .json(&body)
            .send()
            .await
        {
            Ok(response) => {
                // An oversized body is an unknown outcome, like garbage: the
                // migration may have applied, so reconcile rather than fail.
                let text = match read_capped(response).await {
                    Ok(text) => text,
                    Err(e) => {
                        tracing::warn!(attempt_id, error = %e, "migration response past the cap; reconciling");
                        return self.reconcile_twice(attempt_id).await;
                    }
                };
                if is_cf_asset_stub(&text) {
                    return self.reconcile_twice(attempt_id).await;
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(value) => normalize_response(value, &preview(&text, 500)),
                    Err(_) => self.reconcile_twice(attempt_id).await,
                }
            }
            Err(e) => {
                // The platform warns and reconciles once here (its nested
                // try/catch reconciles twice only when the first reconcile
                // itself throws — mirrored in `reconcile_twice`).
                tracing::warn!(attempt_id, error = %e, "migration attempt unknown");
                self.reconcile_once(attempt_id).await
            }
        }
    }

    /// `GET /__void/migrate/app/attempt/:attemptId`, twice when the first
    /// attempt fails to answer: the platform's nested try/catch calls the
    /// reconcile a second time when the first throws.
    async fn reconcile_twice(&self, attempt_id: &str) -> MigrateResponse {
        match self.reconcile_request(attempt_id).await {
            Ok(response) => response,
            Err(e) => {
                tracing::warn!(attempt_id, error = %e, "migration reconcile failed; retrying once");
                self.reconcile_once(attempt_id).await
            }
        }
    }

    async fn reconcile_once(&self, attempt_id: &str) -> MigrateResponse {
        self.reconcile_request(attempt_id)
            .await
            .unwrap_or_else(|e| MigrateResponse::transport_error(one_line(&e.to_string())))
    }

    /// The platform's `reconcileStableAppMigration`.
    async fn reconcile_request(&self, attempt_id: &str) -> Result<MigrateResponse, reqwest::Error> {
        let url = format!(
            "{}/__void/migrate/app/attempt/{}",
            self.base,
            urlencoding(attempt_id)
        );
        let response = self
            .client
            .get(&url)
            .header("x-void-internal", &self.token)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?;
        let status = response.status().as_u16();
        let text = match read_capped(response).await {
            Ok(text) => text,
            Err(message) => {
                return Ok(MigrateResponse {
                    ok: false,
                    attempt_id: Some(attempt_id.to_string()),
                    migrations: Vec::new(),
                    confirmed_applied: Vec::new(),
                    confirmed_skipped: Vec::new(),
                    stability: Some("stable".to_string()),
                    warnings: Vec::new(),
                    error: Some(format!("migration outcome unknown and {}", message)),
                    warnings_dropped: 0,
                    migrations_dropped: 0,
                });
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => Ok(normalize_response(value, &preview(&text, 500))),
            Err(_) => Ok(MigrateResponse {
                ok: false,
                attempt_id: Some(attempt_id.to_string()),
                migrations: Vec::new(),
                confirmed_applied: Vec::new(),
                confirmed_skipped: Vec::new(),
                stability: Some("stable".to_string()),
                warnings: Vec::new(),
                error: Some(format!(
                    "migration outcome unknown and reconciliation returned {}: {}",
                    status,
                    preview(&text, 200)
                )),
                warnings_dropped: 0,
                migrations_dropped: 0,
            }),
        }
    }

    /// `POST /__void/migrate/auth`: the platform's
    /// `dispatchStableAuthMigration`.
    pub async fn migrate_auth(&self) -> Result<(), String> {
        let url = format!("{}/__void/migrate/auth", self.base);
        let response = self
            .client
            .post(&url)
            .header("x-void-internal", &self.token)
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| one_line(&e.to_string()))?;
        let status = response.status().as_u16();
        let text = match read_capped(response).await {
            Ok(text) => text,
            Err(message) => return Err(format!("auth migration failed: {}", message)),
        };
        let data: Value = serde_json::from_str(&text).map_err(|_| {
            format!(
                "auth migration failed ({}): {}",
                status,
                preview(&text, 200)
            )
        })?;
        if (200..300).contains(&status) && data.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            let detail = data
                .get("error")
                .and_then(Value::as_str)
                .map_or_else(|| status.to_string(), one_line);
            Err(format!("auth migration failed: {}", detail))
        }
    }

    /// Legacy `POST /__void/migrate` with the platform's retry shape
    /// (`CF_MIGRATION_RETRY`: two retries, 1 s doubling, of the asset stub
    /// and of 2xx non-JSON only — a throw or a non-2xx fails at once).
    pub async fn migrate_legacy(&self) -> Result<MigrateResponse, String> {
        for attempt in 0..=2 {
            if attempt > 0 {
                tokio::time::sleep(self.retry_delay * 2u32.pow(attempt - 1)).await;
            }
            let url = format!("{}/__void/migrate", self.base);
            let response = self
                .client
                .post(&url)
                .header("x-void-internal", &self.token)
                .timeout(std::time::Duration::from_secs(300))
                .send()
                .await
                .map_err(|e| one_line(&e.to_string()))?;
            let status = response.status().as_u16();
            // A capped body is a verdict, not propagation: it fails at once,
            // with no retry.
            let text = match read_capped(response).await {
                Ok(text) => text,
                Err(message) => return Err(message),
            };
            if is_cf_asset_stub(&text) {
                tracing::warn!(attempt, "migration dispatch hit an asset stub; retrying");
                continue;
            }
            match serde_json::from_str::<Value>(&text) {
                Ok(value) => return Ok(normalize_response(value, &preview(&text, 500))),
                Err(_) => {
                    if (200..300).contains(&status) {
                        tracing::warn!(
                            attempt,
                            status,
                            "migration dispatch non-JSON 2xx; retrying"
                        );
                        continue;
                    }
                    return Err(format!(
                        "migration failed ({}): {}",
                        status,
                        preview(&text, 200)
                    ));
                }
            }
        }
        Err("migration dispatch failed after retries".to_string())
    }
}

/// Percent-encode one path segment (the attempt id): what
/// `encodeURIComponent` does to it. Attempt ids are `migatt_`-alphanumeric
/// by construction, so this only ever matters to a test passing stranger
/// ids — but an unencoded `/` would route off the endpoint.
fn urlencoding(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const VECTORS: &str = include_str!("testdata/void_migration_vectors.json");

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "noite-void-migrate-{}-{}-{:?}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The collector follows Void's rule byte for byte: sorted `.sql`,
    /// `seed.sql` excluded, case-sensitive suffix, non-recursive, missing
    /// dir collects nothing. The fixture mirrors the directory Void's own
    /// `collectMigrations` ran over for the golden `collector` section.
    #[test]
    fn collector_matches_void() {
        let dir = scratch("collect").canonicalize().unwrap();
        let migrations = dir.join("db").join("migrations");
        std::fs::create_dir_all(migrations.join("meta")).unwrap();
        std::fs::write(
            migrations.join("0002_second.sql"),
            "CREATE TABLE a (id INTEGER);\n",
        )
        .unwrap();
        std::fs::write(
            migrations.join("0001_first.sql"),
            "CREATE TABLE b (id INTEGER);\n",
        )
        .unwrap();
        std::fs::write(migrations.join("seed.sql"), "INSERT INTO a VALUES (1);\n").unwrap();
        std::fs::write(migrations.join("notes.txt"), "not sql\n").unwrap();
        std::fs::write(
            migrations.join("0003_UPPER.SQL"),
            "CREATE TABLE c (id INTEGER);\n",
        )
        .unwrap();
        std::fs::write(
            migrations.join("meta").join("_journal.json"),
            "{\"version\":\"7\",\"dialect\":\"sqlite\",\"entries\":[]}\n",
        )
        .unwrap();

        let collected = collect_migrations(&migrations).unwrap();
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        let expected: Vec<&str> = vectors["collector"]["sorted_names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect();
        let names: Vec<&str> = collected
            .iter()
            .map(|migration| migration.name.as_str())
            .collect();
        assert_eq!(names, expected);
        for migration in &collected {
            assert_eq!(
                migration.sql,
                vectors["collector"]["sql_by_name"][&migration.name]
                    .as_str()
                    .unwrap(),
                "{}",
                migration.name
            );
        }
        assert!(collect_migrations(&dir.join("missing")).unwrap().is_empty());
    }

    /// A directory named `*.sql` fails loudly, as Node's `readFileSync`
    /// throws on it.
    #[test]
    fn collector_refuses_a_directory_named_sql() {
        let dir = scratch("collect-dir").canonicalize().unwrap();
        std::fs::create_dir(dir.join("0001_oops.sql")).unwrap();
        assert!(collect_migrations(&dir).is_err());
    }

    /// `void.json`'s `sourceDir` moves the migrations root; anything
    /// escaping the worktree fails instead.
    #[test]
    fn migrations_dir_resolution() {
        let dir = scratch("paths").canonicalize().unwrap();
        assert_eq!(
            resolve_migrations_dir(&dir).unwrap(),
            dir.join("db").join("migrations")
        );
        std::fs::write(dir.join("void.json"), r#"{"sourceDir": "client"}"#).unwrap();
        assert_eq!(
            resolve_migrations_dir(&dir).unwrap(),
            dir.join("client").join("db").join("migrations")
        );
        for evil in ["../escape", "/absolute", "a/../../escape"] {
            std::fs::write(
                dir.join("void.json"),
                format!(r#"{{"sourceDir": "{}"}}"#, evil),
            )
            .unwrap();
            assert!(
                resolve_migrations_dir(&dir).is_err(),
                "{} must not escape the worktree",
                evil
            );
        }
        // Unparseable or non-string `sourceDir` falls back to the root.
        for body in ["{oops", r#"{"sourceDir": 3}"#, r#"{"other": true}"#] {
            std::fs::write(dir.join("void.json"), body).unwrap();
            assert_eq!(
                resolve_migrations_dir(&dir).unwrap(),
                dir.join("db").join("migrations"),
                "{}",
                body
            );
        }
    }

    /// Every plan and bundle hash is byte-identical to Void's own
    /// classifier: each vector below was produced by running Void's
    /// `classifyMigration` / `buildMigrationPlanBundle`, and the test
    /// replays the same inputs through the port.
    #[test]
    fn classifier_matches_void_goldens() {
        let vectors: Value = serde_json::from_str(VECTORS).unwrap();
        assert_eq!(
            vectors["classifierVersion"].as_u64().unwrap(),
            u64::from(CLASSIFIER_VERSION)
        );
        for (case, entry) in vectors["plans"].as_object().unwrap() {
            let name = format!("{}.sql", case);
            let input = entry["input"].as_str().unwrap();
            match classify_migration(&name, input) {
                Ok(plan) => {
                    let expected = &entry["plan"];
                    assert_eq!(plan.kind, expected["kind"].as_str().unwrap(), "{}", case);
                    assert_eq!(
                        plan.stability,
                        expected["stability"].as_str().unwrap(),
                        "{}",
                        case
                    );
                    let statements: Option<Vec<String>> =
                        expected.get("statements").map(|statements| {
                            statements
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|s| s.as_str().unwrap().to_string())
                                .collect()
                        });
                    assert_eq!(plan.statements, statements, "{}", case);
                    assert_eq!(
                        u64::from(plan.classifier_version),
                        expected["classifierVersion"].as_u64().unwrap(),
                        "{}",
                        case
                    );
                    assert_eq!(plan.name, expected["name"].as_str().unwrap(), "{}", case);
                    assert_eq!(
                        plan.sql_hash,
                        expected["sqlHash"].as_str().unwrap(),
                        "{}",
                        case
                    );
                    assert_eq!(
                        plan.plan_hash,
                        expected["planHash"].as_str().unwrap(),
                        "{}",
                        case
                    );
                    let warnings: Vec<String> = expected
                        .get("warnings")
                        .map(|warnings| {
                            warnings
                                .as_array()
                                .unwrap()
                                .iter()
                                .map(|w| w.as_str().unwrap().to_string())
                                .collect()
                        })
                        .unwrap_or_default();
                    assert_eq!(plan.warnings, warnings, "{}", case);
                }
                Err(error) => assert_eq!(
                    error,
                    entry["error"].as_str().unwrap(),
                    "{} must fail exactly as Void's",
                    case
                ),
            }
        }
        let input = |case: &str| {
            vectors["plans"][case]["input"]
                .as_str()
                .unwrap()
                .to_string()
        };
        for (bundle, members) in [
            (
                "two",
                vec![
                    ("0001_init.sql", input("single")),
                    ("0002_queue.sql", input("breakpoints")),
                ],
            ),
            (
                "mixed",
                vec![
                    ("0001_init.sql", input("single")),
                    ("0002_queue.sql", input("breakpoints")),
                    ("0003_trigger.sql", input("trigger")),
                ],
            ),
            ("empty", Vec::new()),
        ] {
            let files: Vec<MigrationFile> = members
                .into_iter()
                .map(|(name, sql)| MigrationFile {
                    name: name.to_string(),
                    sql,
                })
                .collect();
            let built = build_plan_bundle(&files).unwrap();
            let expected = &vectors["bundles"][bundle];
            assert_eq!(
                built.migration_list_hash,
                expected["migrationListHash"].as_str().unwrap(),
                "{}",
                bundle
            );
            assert_eq!(
                built.plans.len(),
                expected["plans"].as_array().unwrap().len()
            );
            for (plan, expected_plan) in built
                .plans
                .iter()
                .zip(expected["plans"].as_array().unwrap())
            {
                assert_eq!(plan.plan_hash, expected_plan["planHash"].as_str().unwrap());
                assert_eq!(plan.sql_hash, expected_plan["sqlHash"].as_str().unwrap());
            }
        }
    }

    #[test]
    fn small_helpers() {
        assert_eq!(one_line("a\r\nb\rc\nd"), "a b c d");
        assert_eq!(one_line("plain"), "plain");
        let id = mint_attempt_id();
        assert!(id.starts_with("migatt_"), "{}", id);
        assert_eq!(id.len(), 19, "{}", id);
        assert!(
            id.bytes()
                .skip(7)
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "{}",
            id
        );
        assert!(config_has_hyperdrive(
            &serde_json::json!({"hyperdrive": [{"binding": "HYPERDRIVE"}]})
        ));
        assert!(!config_has_hyperdrive(
            &serde_json::json!({"hyperdrive": []})
        ));
        assert!(!config_has_hyperdrive(
            &serde_json::json!({"d1_databases": [{"binding": "DB"}]})
        ));
        assert!(config_has_d1(
            &serde_json::json!({"d1_databases": [{"binding": "DB"}]})
        ));
        assert!(!config_has_d1(&serde_json::json!({"d1_databases": []})));
        assert_eq!(urlencoding("migatt_abc123"), "migatt_abc123");
        assert_eq!(urlencoding("a/b c?"), "a%2Fb%20c%3F");
    }

    /// The response validator mirrors the platform's: only an object with a
    /// `migrations` array parses, with the same error shapes.
    #[test]
    fn normalize_response_matrix() {
        for (value, error) in [
            (
                serde_json::json!([1]),
                "migration endpoint returned invalid response: [1]",
            ),
            (
                serde_json::json!("x"),
                "migration endpoint returned invalid response: \"x\"",
            ),
            (
                serde_json::json!({"ok": true}),
                "migration endpoint returned invalid response: missing migrations array ({\"ok\":true})",
            ),
        ] {
            let preview = value.to_string();
            let response = normalize_response(value, &preview);
            assert!(!response.ok);
            assert_eq!(response.error.as_deref(), Some(error));
            assert!(response.migrations.is_empty());
        }
        let response = normalize_response(
            serde_json::json!({"ok": true, "migrations": [{"name": "a.sql"}]}),
            "preview",
        );
        assert!(response.ok);
        assert_eq!(response.migrations.len(), 1);
        assert_eq!(response.migrations[0].name, "a.sql");
        assert!(!response.migrations[0].applied);
    }

    /// Failure rendering is the platform's `migration <name> failed:
    /// <error>`, with the tenant name quoted and newlines flattened.
    #[test]
    fn format_migration_failure_matrix() {
        let failed = |name: &str, error: Option<&str>, top: Option<&str>| MigrateResponse {
            ok: false,
            attempt_id: None,
            migrations: vec![MigrationOutcome {
                name: name.to_string(),
                applied: false,
                duration_ms: 3,
                error: error.map(str::to_string),
                status: Some("failed".to_string()),
                stability: Some("stable".to_string()),
            }],
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: top.map(str::to_string),
            warnings_dropped: 0,
            migrations_dropped: 0,
        };
        assert_eq!(
            format_migration_failure(&failed(
                "0002_bad.sql",
                Some("near \"x\": syntax error"),
                Some("migration 0002_bad.sql failed")
            )),
            "migration \"0002_bad.sql\" failed: near \"x\": syntax error"
        );
        // A hostile name cannot forge log lines: it is Debug-quoted.
        let rendered = format_migration_failure(&failed(
            "a.sql\nERROR: forged",
            Some("boom"),
            Some("migration failed"),
        ));
        assert_eq!(rendered, "migration \"a.sql\\nERROR: forged\" failed: boom");
        assert!(!rendered.contains('\n'));
        // Engine errors carry newlines (MySQL's breakpoint note): flattened.
        let rendered = format_migration_failure(&failed(
            "a.sql",
            Some("syntax error\nThis deploy runs one statement per query."),
            Some("migration failed"),
        ));
        assert!(!rendered.contains('\n'));
        assert!(
            rendered.contains("syntax error This deploy runs"),
            "{}",
            rendered
        );
        // When the top error already carries the detail, it wins (as the
        // platform's), still flattened.
        assert_eq!(
            format_migration_failure(&failed("a.sql", Some("boom"), Some("top: boom\ntail"))),
            "top: boom tail"
        );
        // No failed entry: the top error, or `unknown error`.
        let mut bare = failed("a.sql", None, Some("migration outcome unknown"));
        assert_eq!(format_migration_failure(&bare), "migration outcome unknown");
        bare.error = None;
        assert_eq!(format_migration_failure(&bare), "unknown error");
        // An empty error is falsy, as in JavaScript: it counts as no entry.
        assert_eq!(
            format_migration_failure(&failed("a.sql", Some(""), Some("top"))),
            "top"
        );
    }

    // --- protocol client against a fake handler ---------------------------

    async fn serve(router: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
        // The listener is already listening when `bind` returns, so the
        // first connection never races the serve task (no sleep needed).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (base, handle)
    }

    fn client(base: &str) -> MigrationClient {
        MigrationClient::new(
            migration_http_client(),
            base.to_string(),
            "token".to_string(),
        )
        .with_retry_delay(std::time::Duration::from_millis(0))
    }

    fn authed(
        headers: &axum::http::HeaderMap,
        yes: impl axum::response::IntoResponse,
    ) -> axum::response::Response {
        use axum::response::IntoResponse as _;
        if headers.get("x-void-internal").and_then(|v| v.to_str().ok()) == Some("token") {
            yes.into_response()
        } else {
            axum::http::StatusCode::UNAUTHORIZED.into_response()
        }
    }

    #[tokio::test]
    async fn capabilities_parse_and_carry_auth() {
        let router = axum::Router::new().route(
            "/__void/migrate/capabilities",
            axum::routing::get(
                |headers: axum::http::HeaderMap| async move {
                    authed(
                        &headers,
                        axum::Json(serde_json::json!({
                            "protocolVersion": 2,
                            "dialect": "sqlite",
                            "classifierVersion": 1,
                            "migrationListHash": "sha256:abc",
                            "destructiveValidation": "passed",
                            "endpoints": {"app": "/__void/migrate/app", "auth": "/__void/migrate/auth", "reconcile": "/__void/migrate/app/attempt/:attemptId"},
                        })),
                    )
                },
            ),
        );
        let (base, handle) = serve(router).await;
        let caps = client(&base).capabilities().await.unwrap();
        assert_eq!(
            caps,
            Capabilities {
                dialect: "sqlite".to_string(),
                classifier_version: 1,
                migration_list_hash: "sha256:abc".to_string(),
                auth_endpoint: Some("/__void/migrate/auth".to_string()),
            }
        );
        // The token header is the auth the handler expects: wrong token 401s.
        let denied = MigrationClient::new(migration_http_client(), base, "wrong".to_string())
            .capabilities()
            .await;
        assert!(matches!(denied, Err(ProbeError::Http { status: 401, .. })));
        handle.abort();
    }

    #[tokio::test]
    async fn capabilities_reject_non_v2() {
        let router = axum::Router::new()
            .route(
                "/__void/migrate/capabilities",
                axum::routing::get(|| async { "not json" }),
            )
            .route(
                "/legacy-only",
                axum::routing::get(|| async { axum::http::StatusCode::NOT_FOUND }),
            );
        let (base, handle) = serve(router).await;
        assert!(matches!(
            client(&base).capabilities().await,
            Err(ProbeError::Shape { .. })
        ));
        let legacy = MigrationClient::new(
            migration_http_client(),
            format!("{}/legacy-only", base),
            "token".to_string(),
        );
        // A 404 under a prefix still surfaces as an answered probe: the
        // caller falls back to the tree-driven decision.
        assert!(matches!(
            legacy.capabilities().await,
            Err(ProbeError::Http { status: 404, .. })
        ));
        handle.abort();
    }

    #[tokio::test]
    async fn app_success_counts_applied_and_skipped() {
        let seen = Arc::new(AtomicUsize::new(0));
        let seen_body = Arc::new(std::sync::Mutex::new(String::new()));
        let router = {
            let seen = seen.clone();
            let seen_body = seen_body.clone();
            axum::Router::new().route(
                "/__void/migrate/app",
                axum::routing::post(
                    move |headers: axum::http::HeaderMap, body: String| async move {
                        seen.fetch_add(1, Ordering::SeqCst);
                        *seen_body.lock().unwrap() = body.clone();
                        authed(
                            &headers,
                            axum::Json(serde_json::json!({
                                "ok": true,
                                "protocolVersion": 2,
                                "attemptId": "migatt_test",
                                "confirmedApplied": ["0002_queue.sql"],
                                "confirmedSkipped": ["0001_init.sql"],
                                "migrations": [
                                    {"name": "0001_init.sql", "applied": false, "durationMs": 0, "status": "skipped", "stability": "stable"},
                                    {"name": "0002_queue.sql", "applied": true, "durationMs": 12, "status": "applied", "stability": "stable"},
                                ],
                                "stability": "stable",
                                "warnings": ["a warning"],
                            })),
                        )
                    },
                ),
            )
        };
        let (base, handle) = serve(router).await;
        let response = client(&base).migrate_app("migatt_test", "deploy-1").await;
        assert!(response.ok);
        assert_eq!(response.confirmed_applied, ["0002_queue.sql"]);
        assert_eq!(response.confirmed_skipped, ["0001_init.sql"]);
        assert_eq!(response.warnings, ["a warning"]);
        assert_eq!(
            response
                .migrations
                .iter()
                .filter(|m| m.is_applied())
                .count(),
            1
        );
        assert_eq!(
            response
                .migrations
                .iter()
                .filter(|m| m.is_skipped())
                .count(),
            1
        );
        assert_eq!(seen.load(Ordering::SeqCst), 1);
        let body: Value = serde_json::from_str(&seen_body.lock().unwrap()).unwrap();
        assert_eq!(body["attemptId"], "migatt_test");
        assert_eq!(body["deploymentId"], "deploy-1");
        handle.abort();
    }

    #[tokio::test]
    async fn app_definitive_failure_never_reconciles() {
        let reconciled = Arc::new(AtomicUsize::new(0));
        let router = {
            let reconciled = reconciled.clone();
            axum::Router::new()
                .route(
                    "/__void/migrate/app",
                    axum::routing::post(|| async {
                        axum::Json(serde_json::json!({
                            "ok": false,
                            "protocolVersion": 2,
                            "attemptId": "migatt_test",
                            "confirmedApplied": [],
                            "confirmedSkipped": [],
                            "error": "migration 0002_bad.sql failed",
                            "migrations": [
                                {"name": "0002_bad.sql", "applied": false, "durationMs": 1, "status": "failed", "stability": "stable", "error": "near \"x\": syntax error"},
                            ],
                            "stability": "stable",
                        }))
                    }),
                )
                .route(
                    "/__void/migrate/app/attempt/{attempt}",
                    axum::routing::get(move || async move {
                        reconciled.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({"ok": true}))
                    }),
                )
        };
        let (base, handle) = serve(router).await;
        let response = client(&base).migrate_app("migatt_test", "deploy-1").await;
        assert!(!response.ok);
        assert_eq!(reconciled.load(Ordering::SeqCst), 0);
        assert_eq!(
            format_migration_failure(&response),
            "migration \"0002_bad.sql\" failed: near \"x\": syntax error"
        );
        handle.abort();
    }

    /// Unknown outcomes reconcile: garbage (even with a 500 status) and the
    /// CF asset stub both send the client to the attempt endpoint.
    #[tokio::test]
    async fn app_unknown_outcomes_reconcile() {
        for body in [
            "this is not json".to_string(),
            "Assets have not yet been deployed".to_string(),
        ] {
            let reconciled = Arc::new(AtomicUsize::new(0));
            let router = {
                let reconciled = reconciled.clone();
                axum::Router::new()
                    .route(
                        "/__void/migrate/app",
                        axum::routing::post(move || async move {
                            (
                                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                                body.clone(),
                            )
                        }),
                    )
                    .route(
                        "/__void/migrate/app/attempt/{attempt}",
                        axum::routing::get(
                            move |axum::extract::Path(attempt): axum::extract::Path<String>| async move {
                                reconciled.fetch_add(1, Ordering::SeqCst);
                                assert_eq!(attempt, "migatt_test");
                                axum::Json(serde_json::json!({
                                    "ok": true,
                                    "protocolVersion": 2,
                                    "attemptId": "migatt_test",
                                    "confirmedApplied": [],
                                    "confirmedSkipped": ["0001_init.sql"],
                                    "migrations": [
                                        {"name": "0001_init.sql", "applied": false, "durationMs": 0, "status": "skipped"},
                                    ],
                                }))
                            },
                        ),
                    )
            };
            let (base, handle) = serve(router).await;
            let response = client(&base).migrate_app("migatt_test", "deploy-1").await;
            assert!(response.ok, "reconciled outcome must win");
            assert_eq!(response.confirmed_skipped, ["0001_init.sql"]);
            assert_eq!(reconciled.load(Ordering::SeqCst), 1);
            handle.abort();
        }
    }

    #[tokio::test]
    async fn auth_success_and_failure_shapes() {
        let router = axum::Router::new().route(
            "/__void/migrate/auth",
            axum::routing::post(|headers: axum::http::HeaderMap| async move {
                authed(
                    &headers,
                    axum::Json(serde_json::json!({"ok": true, "protocolVersion": 2})),
                )
            }),
        );
        let (base, handle) = serve(router).await;
        assert_eq!(client(&base).migrate_auth().await, Ok(()));
        handle.abort();

        let router = axum::Router::new().route(
            "/__void/migrate/auth",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({"ok": false, "error": "auth boom"})),
                )
            }),
        );
        let (base, handle) = serve(router).await;
        assert_eq!(
            client(&base).migrate_auth().await,
            Err("auth migration failed: auth boom".to_string())
        );
        handle.abort();

        let router = axum::Router::new().route(
            "/__void/migrate/auth",
            axum::routing::post(|| async {
                (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "not json")
            }),
        );
        let (base, handle) = serve(router).await;
        assert_eq!(
            client(&base).migrate_auth().await,
            Err("auth migration failed (500): not json".to_string())
        );
        handle.abort();
    }

    #[tokio::test]
    async fn legacy_success_and_immediate_non_2xx() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = {
            let hits = hits.clone();
            axum::Router::new()
                .route(
                    "/__void/migrate",
                    axum::routing::post(|| async {
                        axum::Json(serde_json::json!({
                            "ok": true,
                            "migrations": [
                                {"name": "0001_init.sql", "applied": false, "durationMs": 0},
                                {"name": "0002_more.sql", "applied": true, "durationMs": 5},
                            ],
                        }))
                    }),
                )
                .route(
                    "/failing/__void/migrate",
                    axum::routing::post(move || async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        (
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            "worker blew up",
                        )
                    }),
                )
        };
        let (base, handle) = serve(router).await;
        let response = client(&base).migrate_legacy().await.unwrap();
        assert!(response.ok);
        assert_eq!(response.migrations.iter().filter(|m| m.applied).count(), 1);
        let failing = MigrationClient::new(
            migration_http_client(),
            format!("{}/failing", base),
            "token".to_string(),
        )
        .with_retry_delay(std::time::Duration::from_millis(0));
        assert_eq!(
            failing.migrate_legacy().await,
            Err("migration failed (500): worker blew up".to_string())
        );
        // Non-2xx fails at once: only the stub and 2xx garbage retry.
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        handle.abort();
    }

    /// 2xx garbage retries to exhaustion (three posts), then the platform's
    /// own give-up message. The retry delay is zero, so the test never
    /// sleeps.
    #[tokio::test]
    async fn legacy_garbage_retries_then_gives_up() {
        let hits = Arc::new(AtomicUsize::new(0));
        let router = {
            let hits = hits.clone();
            axum::Router::new().route(
                "/__void/migrate",
                axum::routing::post(move || async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "still propagating"
                }),
            )
        };
        let (base, handle) = serve(router).await;
        assert_eq!(
            client(&base).migrate_legacy().await,
            Err("migration dispatch failed after retries".to_string())
        );
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        handle.abort();
    }

    /// A transport failure fails the legacy call at once (the platform's
    /// `retryWithBackoff` only retries `undefined` returns; a throw
    /// propagates).
    #[tokio::test]
    async fn legacy_transport_error_fails_fast() {
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", probe.local_addr().unwrap());
        drop(probe);
        assert!(client(&base).migrate_legacy().await.is_err());
    }

    // --- response and tree bounds ------------------------------------------

    /// Every line separator flattens: CR/LF plus vertical tab, form feed,
    /// NEL and U+2028/U+2029. A hostile name smuggling U+2028 (which Debug
    /// leaves raw) still renders as one log line.
    #[test]
    fn one_line_flattens_every_separator() {
        assert_eq!(one_line("a\x0bb\x0cc"), "a b c");
        assert_eq!(one_line("a\u{85}b"), "a b");
        assert_eq!(one_line("a\u{2028}b\u{2029}c"), "a b c");
        let response = MigrateResponse {
            ok: false,
            attempt_id: None,
            migrations: vec![MigrationOutcome {
                name: "a\u{2028}b.sql".to_string(),
                applied: false,
                duration_ms: 1,
                error: Some("boom".to_string()),
                status: Some("failed".to_string()),
                stability: Some("stable".to_string()),
            }],
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: Vec::new(),
            error: Some("top".to_string()),
            warnings_dropped: 0,
            migrations_dropped: 0,
        };
        let rendered = format_migration_failure(&response);
        assert!(!rendered.contains('\u{2028}'), "{:?}", rendered);
        assert_eq!(rendered.lines().count(), 1);
    }

    /// Huge parsed arrays truncate with counts: the first fifty warnings and
    /// the first ten thousand migrations survive, the rest becomes a number.
    /// A hostile worker cannot set its own drop counts.
    #[test]
    fn normalize_response_truncates_huge_arrays() {
        let warnings: Vec<Value> = (0..MAX_RESPONSE_WARNINGS + 10)
            .map(|i| Value::String(format!("w{}", i)))
            .collect();
        let migrations: Vec<Value> = (0..MAX_RESPONSE_MIGRATIONS + 5)
            .map(|i| serde_json::json!({"name": format!("{:05}.sql", i)}))
            .collect();
        let confirmed: Vec<Value> = (0..MAX_RESPONSE_MIGRATIONS + 5)
            .map(|i| Value::String(format!("c{}", i)))
            .collect();
        let response = normalize_response(
            serde_json::json!({
                "ok": true,
                "migrations": migrations,
                "warnings": warnings,
                "confirmedApplied": confirmed,
            }),
            "preview",
        );
        assert!(response.ok);
        assert_eq!(response.warnings.len(), MAX_RESPONSE_WARNINGS);
        assert_eq!(response.warnings_dropped, 10);
        assert_eq!(response.warnings[0], "w0");
        assert_eq!(response.migrations.len(), MAX_RESPONSE_MIGRATIONS);
        assert_eq!(response.migrations_dropped, 5);
        assert_eq!(response.migrations[0].name, "00000.sql");
        assert_eq!(response.confirmed_applied.len(), MAX_RESPONSE_MIGRATIONS);
        let sneaky = normalize_response(
            serde_json::json!({"ok": true, "migrations": [], "warnings_dropped": 99}),
            "preview",
        );
        assert_eq!(sneaky.warnings_dropped, 0);
        assert_eq!(sneaky.migrations_dropped, 0);
    }

    /// A body past the cap, streamed with no `Content-Length` (the worst
    /// case: nothing to reject up front).
    fn flood_stream() -> axum::body::Body {
        let chunks = (0..MAX_RESPONSE_BYTES / (1024 * 1024) + 1).map(|_| {
            Ok::<_, std::convert::Infallible>(bytes::Bytes::from(vec![b'x'; 1024 * 1024]))
        });
        axum::body::Body::from_stream(futures::stream::iter(chunks))
    }

    /// Oversized bodies fail the deploy with a clear error instead of
    /// buffering unbounded: the capabilities probe (fixed and streamed
    /// bodies), the legacy call (failing fast, with no retry) and auth.
    #[tokio::test]
    async fn oversized_bodies_are_capped() {
        let router = axum::Router::new()
            .route(
                "/fixed/__void/migrate/capabilities",
                axum::routing::get(|| async { vec![b'x'; MAX_RESPONSE_BYTES + 1] }),
            )
            .route(
                "/streamed/__void/migrate/capabilities",
                axum::routing::get(|| async { flood_stream() }),
            );
        let (base, handle) = serve(router).await;
        for prefix in ["/fixed", "/streamed"] {
            let probe = MigrationClient::new(
                migration_http_client(),
                format!("{}{}", base, prefix),
                "token".to_string(),
            )
            .capabilities()
            .await;
            assert!(
                matches!(probe, Err(ProbeError::TooLarge { .. })),
                "{}: {:?}",
                prefix,
                probe
            );
            assert!(
                probe.unwrap_err().to_string().contains("4 MiB"),
                "{}",
                prefix
            );
        }
        handle.abort();

        let hits = Arc::new(AtomicUsize::new(0));
        let router = {
            let hits = hits.clone();
            axum::Router::new()
                .route(
                    "/__void/migrate",
                    axum::routing::post(move || async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        flood_stream()
                    }),
                )
                .route(
                    "/__void/migrate/auth",
                    axum::routing::post(|| async { flood_stream() }),
                )
        };
        let (base, handle) = serve(router).await;
        let err = client(&base).migrate_legacy().await.unwrap_err();
        assert!(err.contains("4 MiB cap"), "{}", err);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let err = client(&base).migrate_auth().await.unwrap_err();
        assert!(err.contains("auth migration failed"), "{}", err);
        assert!(err.contains("4 MiB cap"), "{}", err);
        handle.abort();
    }

    /// An oversized app body is an unknown outcome, like garbage: the
    /// migration may have applied, so the client reconciles — a clean
    /// reconcile verdict stands, and a capped reconcile fails the deploy.
    #[tokio::test]
    async fn oversized_app_body_reconciles() {
        for reconcile_floods in [false, true] {
            let reconciled = Arc::new(AtomicUsize::new(0));
            let router = {
                let reconciled = reconciled.clone();
                axum::Router::new()
                    .route(
                        "/__void/migrate/app",
                        axum::routing::post(|| async { flood_stream() }),
                    )
                    .route(
                        "/__void/migrate/app/attempt/{attempt}",
                        axum::routing::get(move || async move {
                            reconciled.fetch_add(1, Ordering::SeqCst);
                            if reconcile_floods {
                                return flood_stream();
                            }
                            axum::body::Body::from(
                                serde_json::json!({
                                    "ok": true,
                                    "attemptId": "migatt_test",
                                    "confirmedApplied": ["0001_init.sql"],
                                    "migrations": [
                                        {"name": "0001_init.sql", "applied": true, "durationMs": 1, "status": "applied"},
                                    ],
                                })
                                .to_string(),
                            )
                        }),
                    )
            };
            let (base, handle) = serve(router).await;
            let response = client(&base).migrate_app("migatt_test", "deploy-1").await;
            assert_eq!(reconciled.load(Ordering::SeqCst), 1);
            if reconcile_floods {
                assert!(!response.ok);
                let error = response.error.unwrap_or_default();
                assert!(error.contains("4 MiB cap"), "{}", error);
            } else {
                assert!(response.ok);
                assert_eq!(response.confirmed_applied, ["0001_init.sql"]);
            }
            handle.abort();
        }
    }

    /// The migration client never follows redirects: a 302 answers as a 302,
    /// and the redirect target (which would otherwise receive the fleet
    /// token) is never hit.
    #[tokio::test]
    async fn redirects_are_not_followed() {
        let marker = Arc::new(AtomicUsize::new(0));
        let router = {
            let marker = marker.clone();
            axum::Router::new()
                .route(
                    "/__void/migrate/capabilities",
                    axum::routing::get(|| async {
                        (
                            axum::http::StatusCode::FOUND,
                            [("location", "/marker")],
                            "go away",
                        )
                    }),
                )
                .route(
                    "/marker",
                    axum::routing::get(move || async move {
                        marker.fetch_add(1, Ordering::SeqCst);
                        axum::Json(serde_json::json!({
                            "protocolVersion": 2,
                            "dialect": "sqlite",
                            "classifierVersion": 1,
                            "migrationListHash": "sha256:abc",
                            "destructiveValidation": "passed",
                        }))
                    }),
                )
        };
        let (base, handle) = serve(router).await;
        let probe = client(&base).capabilities().await;
        assert!(
            matches!(probe, Err(ProbeError::Http { status: 302, .. })),
            "{:?}",
            probe
        );
        assert_eq!(marker.load(Ordering::SeqCst), 0);
        handle.abort();
    }

    /// File count, per-file and total caps: each refuses the deploy with a
    /// message naming the cap.
    #[test]
    fn collector_caps_files_and_bytes() {
        let dir = scratch("cap-file").canonicalize().unwrap();
        std::fs::write(
            dir.join("big.sql"),
            vec![b'x'; MAX_MIGRATION_FILE_BYTES + 1],
        )
        .unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("per-file cap"), "{}", err);

        let dir = scratch("cap-total").canonicalize().unwrap();
        for i in 0..5 {
            std::fs::write(
                dir.join(format!("{:04}.sql", i)),
                vec![b'x'; 14 * 1024 * 1024],
            )
            .unwrap();
        }
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("total cap"), "{}", err);

        let dir = scratch("cap-count").canonicalize().unwrap();
        for i in 0..=MAX_MIGRATION_FILES {
            std::fs::write(dir.join(format!("{:06}.sql", i)), "SELECT 1;\n").unwrap();
        }
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("more than"), "{}", err);
    }

    /// Only regular files are collected: symlinks (wherever they point),
    /// fifos and sockets fail the deploy instead of being read. The type
    /// check runs before any open, so the fifo never blocks.
    #[test]
    #[cfg(unix)]
    fn collector_refuses_symlinks_fifos_and_sockets() {
        use std::os::unix::fs::symlink;
        let dir = scratch("cap-links").canonicalize().unwrap();
        std::fs::write(dir.join("real.sql"), "SELECT 1;\n").unwrap();
        symlink(dir.join("real.sql"), dir.join("link.sql")).unwrap();
        symlink("/dev/null", dir.join("null.sql")).unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);

        let dir = scratch("cap-fifo").canonicalize().unwrap();
        let fifo = dir.join("stuck.sql");
        let raw = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);

        // Unix socket paths must fit SUN_LEN, so this one skips the long
        // unique scratch prefix.
        let dir = std::env::temp_dir().join(format!("noite-cap-sock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(dir.join("s.sql")).unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A symlink anywhere in the migrations path below the root fails the
    /// deploy: neither a `sourceDir` component pointing outside the worktree
    /// nor a symlinked `db/` is followed.
    #[test]
    #[cfg(unix)]
    fn resolve_refuses_symlinked_source_dir() {
        use std::os::unix::fs::symlink;
        let outside = scratch("resolve-outside").canonicalize().unwrap();
        std::fs::create_dir_all(outside.join("db").join("migrations")).unwrap();
        std::fs::write(
            outside.join("db").join("migrations").join("evil.sql"),
            "SELECT 1;\n",
        )
        .unwrap();

        let dir = scratch("resolve-link").canonicalize().unwrap();
        symlink(&outside, dir.join("client")).unwrap();
        std::fs::write(dir.join("void.json"), r#"{"sourceDir": "client"}"#).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{}", err);

        let dir = scratch("resolve-dblink").canonicalize().unwrap();
        symlink(&outside, dir.join("db")).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{}", err);
    }

    /// An oversized `void.json` fails the deploy instead of being parsed.
    #[test]
    fn resolve_refuses_huge_void_json() {
        let dir = scratch("resolve-big").canonicalize().unwrap();
        std::fs::write(dir.join("void.json"), vec![b'x'; MAX_VOID_JSON_BYTES + 1]).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("over the 1 MiB cap"), "{}", err);
    }
}
