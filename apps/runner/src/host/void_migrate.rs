//! D1 migrations for Void apps (SPEC, Deploy pipeline): before the deploy
//! is marked success, the runner drives the new generation's in-worker
//! migration endpoints — over the fleet's own listen port after activation,
//! or against the staged generation before it (see Ordering below) — the
//! same endpoints Void's platform calls, with the same auth
//! (`x-void-internal: __VOID_PROXY_TOKEN`, the per-fleet token
//! [`crate::host::void_deploy`] provisions) and the same wire protocol:
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
//! Ordering has two deliveries. On a redeploy (a previous generation is
//! serving) the runner migrates against the *staged* generation before
//! `activate`, through one `celld invoke` per exchange (needs celld
//! 0.6.3-ryuzcorp.7+): the fleet pointer moves only after the migrations
//! succeed, so the old version keeps serving and a failed migration fails
//! the deploy with nothing activated. On a first deploy — or when the prior
//! fleet is unreachable so no staged invoke is possible — the step runs
//! after activation against the fleet's own listen port, as before: between
//! adoption and this step the new code serves the old schema (Void migrates
//! the uploaded worker *before* traffic switches to it; celld has no
//! version-pinned invocation outside `invoke`, so Noite otherwise cannot):
//! keep migrations backward-compatible (expand before contract). Either
//! way, applied migrations are never rolled back (forward-only: redeploying
//! applies what is pending, skipping the rest).

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

/// The deploy-side migration caller: the platform's timeouts (10 s probes,
/// 300 s executions, 30 s reconciles) over one of two deliveries — the
/// fleet's own listen port after activation, or a staged generation through
/// `celld invoke` before it. The endpoints, headers and every decision
/// above the exchange (capability negotiation, attempt reconciliation, the
/// legacy retry shape) are shared, so both deliveries carry identical
/// semantics and only the transport differs.
///
/// No `Debug`: the token below is the fleet's proxy secret, and the staged
/// delivery adds the operator token and bucket credentials beside it.
#[derive(Clone)]
pub struct MigrationClient {
    transport: MigrateTransport,
    token: String,
    retry_delay: std::time::Duration,
}

/// Where one migration exchange runs. No `Debug`: the staged target below
/// holds the operator token and bucket credentials beside the proxy token.
#[derive(Clone)]
enum MigrateTransport {
    /// `POST`/`GET` against the fleet's own listen port with the per-fleet
    /// proxy token.
    Fleet {
        client: reqwest::Client,
        base: String,
    },
    /// One `celld invoke` per exchange against the staged generation: same
    /// endpoints and headers, the operator token and bucket credentials
    /// riding `CELLD_*` exactly as for `celld d1 execute`.
    Staged { target: StagedTarget },
}

/// Everything one staged migration exchange needs, grouped so the
/// constructor stays a plain function (`deploy.rs` groups `MigrateInputs`
/// for the same reason). Pins name the staged generation — the cohosted
/// scripts the request must see staged plus the app — with the app worker
/// as the `--target` receiving the migrate endpoints. No `Debug`: `env`
/// carries the operator token and bucket credentials.
#[derive(Clone)]
pub struct StagedTarget {
    pub celld_bin: String,
    pub env: Vec<(String, String)>,
    pub bucket: String,
    pub endpoint: String,
    pub region: String,
    /// `script=version` pins, deploy order (cohosted first, the app last).
    pub pins: Vec<(String, String)>,
    /// The app worker receiving the request.
    pub target: String,
}

/// One migration exchange's answer: the worker's status and body, however
/// delivered. The oversize case stays separate because an over-cap body of
/// an unknown outcome still reconciles (like the fleet cap path), while a
/// missing answer is always a transport failure.
enum CallAnswer {
    Answered { status: u16, body: String },
    TooLarge { message: String },
    Transport { message: String },
}

/// The pre-activation canary's pass rule: an answered status below 500
/// passes — the staged generation serves the probe path (2xx/3xx/4xx all
/// mean the staged worker answered as itself). A 5xx fails, and a missing
/// answer fails closed, so the deploy fails before any activate and the
/// previous generation keeps serving.
pub fn probe_status_passes(status: u16) -> bool {
    status < 500
}

impl MigrationClient {
    pub fn new(client: reqwest::Client, base: String, token: String) -> Self {
        Self {
            transport: MigrateTransport::Fleet { client, base },
            token,
            retry_delay: std::time::Duration::from_secs(1),
        }
    }

    pub fn staged(target: StagedTarget, token: String) -> Self {
        Self {
            transport: MigrateTransport::Staged { target },
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

    /// One exchange over whichever delivery this client carries: the
    /// platform's method, path, headers and timeout, answered with the
    /// worker's status and body. A `content-type: application/json` rides
    /// every exchange with a body, exactly as the fleet path always sent.
    async fn exchange(
        &self,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
        timeout: std::time::Duration,
    ) -> CallAnswer {
        match &self.transport {
            MigrateTransport::Fleet { client, base } => {
                let url = format!("{base}{path}");
                let mut request = match method {
                    "POST" => client.post(&url),
                    _ => client.get(&url),
                };
                request = request.header("x-void-internal", &self.token);
                if body.is_some() {
                    request = request.header("content-type", "application/json");
                }
                if let Some(body) = body {
                    request = request.body(body.to_vec());
                }
                let response = match request.timeout(timeout).send().await {
                    Ok(response) => response,
                    Err(e) => {
                        return CallAnswer::Transport {
                            message: one_line(&e.to_string()),
                        };
                    }
                };
                let status = response.status().as_u16();
                match read_capped(response).await {
                    Ok(text) => CallAnswer::Answered { status, body: text },
                    Err(message) => CallAnswer::TooLarge { message },
                }
            }
            MigrateTransport::Staged { target } => {
                invoke_exchange(target, &self.token, method, path, body, timeout).await
            }
        }
    }

    /// The platform's per-call timeout, with headroom for the staged
    /// delivery: every `celld invoke` builds a fresh isolate pool for the
    /// staged generation, so the sub-minute probes budget a cold build.
    /// Fast failures (no live node, a shed load) answer at once either way.
    /// Executions (300 s) keep the platform's timeout on both deliveries.
    fn probe_timeout(&self) -> std::time::Duration {
        match self.transport {
            MigrateTransport::Fleet { .. } => std::time::Duration::from_secs(10),
            MigrateTransport::Staged { .. } => std::time::Duration::from_secs(60),
        }
    }

    fn reconcile_timeout(&self) -> std::time::Duration {
        match self.transport {
            MigrateTransport::Fleet { .. } => std::time::Duration::from_secs(30),
            MigrateTransport::Staged { .. } => std::time::Duration::from_secs(60),
        }
    }

    /// `GET /__void/migrate/capabilities`: the platform's
    /// `probeWorkerMigrationCapabilities`.
    pub async fn capabilities(&self) -> Result<Capabilities, ProbeError> {
        let timeout = self.probe_timeout();
        let answer = self
            .exchange("GET", "/__void/migrate/capabilities", None, timeout)
            .await;
        let (status, text) = match answer {
            CallAnswer::Transport { message } => return Err(ProbeError::Transport { message }),
            CallAnswer::TooLarge { message } => return Err(ProbeError::TooLarge { message }),
            CallAnswer::Answered { status, body } => (status, body),
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
        let body =
            serde_json::json!({"attemptId": attempt_id, "deploymentId": deployment_id}).to_string();
        match self
            .exchange(
                "POST",
                "/__void/migrate/app",
                Some(body.as_bytes()),
                std::time::Duration::from_secs(300),
            )
            .await
        {
            // An oversized body is an unknown outcome, like garbage: the
            // migration may have applied, so reconcile rather than fail.
            CallAnswer::TooLarge { message: e } => {
                tracing::warn!(attempt_id, error = %e, "migration response past the cap; reconciling");
                self.reconcile_twice(attempt_id).await
            }
            CallAnswer::Answered { body: text, .. } => {
                if is_cf_asset_stub(&text) {
                    return self.reconcile_twice(attempt_id).await;
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(value) => normalize_response(value, &preview(&text, 500)),
                    Err(_) => self.reconcile_twice(attempt_id).await,
                }
            }
            CallAnswer::Transport { message } => {
                // The platform warns and reconciles once here (its nested
                // try/catch reconciles twice only when the first reconcile
                // itself throws — mirrored in `reconcile_twice`).
                tracing::warn!(attempt_id, error = %message, "migration attempt unknown");
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
            .unwrap_or_else(|e| MigrateResponse::transport_error(one_line(&e)))
    }

    /// The platform's `reconcileStableAppMigration`.
    async fn reconcile_request(&self, attempt_id: &str) -> Result<MigrateResponse, String> {
        let path = format!("/__void/migrate/app/attempt/{}", urlencoding(attempt_id));
        let timeout = self.reconcile_timeout();
        match self.exchange("GET", &path, None, timeout).await {
            CallAnswer::Transport { message } => Err(message),
            CallAnswer::TooLarge { message } => Ok(MigrateResponse {
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
            }),
            CallAnswer::Answered { status, body: text } => {
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
        }
    }

    /// `POST /__void/migrate/auth`: the platform's
    /// `dispatchStableAuthMigration`.
    pub async fn migrate_auth(&self) -> Result<(), String> {
        match self
            .exchange(
                "POST",
                "/__void/migrate/auth",
                None,
                std::time::Duration::from_secs(300),
            )
            .await
        {
            CallAnswer::Transport { message } => Err(one_line(&message)),
            CallAnswer::TooLarge { message } => Err(format!("auth migration failed: {}", message)),
            CallAnswer::Answered { status, body: text } => {
                let data: Value = serde_json::from_str(&text).map_err(|_| {
                    format!(
                        "auth migration failed ({}): {}",
                        status,
                        preview(&text, 200)
                    )
                })?;
                if (200..300).contains(&status)
                    && data.get("ok").and_then(Value::as_bool) == Some(true)
                {
                    Ok(())
                } else {
                    let detail = data
                        .get("error")
                        .and_then(Value::as_str)
                        .map_or_else(|| status.to_string(), one_line);
                    Err(format!("auth migration failed: {}", detail))
                }
            }
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
            match self
                .exchange(
                    "POST",
                    "/__void/migrate",
                    None,
                    std::time::Duration::from_secs(300),
                )
                .await
            {
                // A throw fails at once, with no retry.
                CallAnswer::Transport { message } => return Err(one_line(&message)),
                // A capped body is a verdict, not propagation: it fails at
                // once, with no retry.
                CallAnswer::TooLarge { message } => return Err(message),
                CallAnswer::Answered { status, body: text } => {
                    if is_cf_asset_stub(&text) {
                        tracing::warn!(attempt, "migration dispatch hit an asset stub; retrying");
                        continue;
                    }
                    match serde_json::from_str::<Value>(&text) {
                        Ok(value) => {
                            return Ok(normalize_response(value, &preview(&text, 500)));
                        }
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
            }
        }
        Err("migration dispatch failed after retries".to_string())
    }

    /// Pre-activation canary: `HEAD <path>` against the staged generation
    /// through `celld invoke` — the staged pins plus the app as `--target`,
    /// the same transport [`invoke_exchange`] the migrations ride. An
    /// answered status below 500 passes (returned, so the deploy log can
    /// name it); a 5xx or a missing answer (transport failure, over-cap
    /// body) fails closed, so the deploy fails before any activate.
    pub async fn probe_staged(
        &self,
        path: &str,
        timeout: std::time::Duration,
    ) -> Result<u16, ProbeError> {
        match self.exchange("HEAD", path, None, timeout).await {
            CallAnswer::Answered { status, .. } if probe_status_passes(status) => Ok(status),
            CallAnswer::Answered { status, body } => Err(ProbeError::Http {
                status,
                preview: preview(&body, 200),
            }),
            CallAnswer::TooLarge { message } => Err(ProbeError::TooLarge { message }),
            CallAnswer::Transport { message } => Err(ProbeError::Transport { message }),
        }
    }
}

/// One migration exchange over the staged generation: `celld invoke` with
/// the staged pins plus the app as `--target`, the fleet's proxy token on
/// `x-void-internal`, and `--json` so the worker's status and body come
/// back however the answer reads. The CLI waits up to ten minutes; the
/// runner's own timeout fires first (the platform's 10/300/30 s), and a
/// timeout is unknown, never failed — the invoke runs to completion on the
/// node, which is exactly what the reconcile path is for.
/// The environment variable carrying the fleet's proxy token to
/// `celld invoke --header-env`, never argv.
const PROXY_TOKEN_ENV: &str = "NOITE_VOID_PROXY_TOKEN";

async fn invoke_exchange(
    target: &StagedTarget,
    token: &str,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout: std::time::Duration,
) -> CallAnswer {
    let mut args: Vec<String> = Vec::with_capacity(target.pins.len() + 16);
    args.push("invoke".to_string());
    for (script, version) in &target.pins {
        args.push(format!("{script}={version}"));
    }
    args.push("--target".to_string());
    args.push(target.target.clone());
    args.push("--method".to_string());
    args.push(method.to_string());
    args.push("--path".to_string());
    args.push(path.to_string());
    // Nothing secret or tenant-derived rides argv: every local user reads
    // `/proc/<pid>/cmdline`, including concurrent tenant builds. The proxy
    // token travels in the child's environment (`--header-env`, celld
    // 0049), which only the runner's own uid can read, beside the operator
    // token and bucket credentials; the body travels on stdin.
    // A non-Void fleet has no proxy token: omit the header entirely rather
    // than hand celld `--header-env` for an unset variable (celld refuses
    // that as "environment variable ... is not set"). Void migrations and
    // the Void probe always carry one.
    if !token.is_empty() {
        args.push("--header-env".to_string());
        args.push(format!("x-void-internal={PROXY_TOKEN_ENV}"));
    }
    if body.is_some() {
        args.push("--header".to_string());
        args.push("content-type:application/json".to_string());
        args.push("--body-file".to_string());
        args.push("-".to_string());
    }
    args.push("--json".to_string());
    args.push("--bucket".to_string());
    args.push(target.bucket.clone());
    args.push("--endpoint".to_string());
    args.push(target.endpoint.clone());
    args.push("--region".to_string());
    args.push(target.region.clone());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let env: Vec<(&str, &str)> = target
        .env
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .chain((!token.is_empty()).then_some((PROXY_TOKEN_ENV, token)))
        .collect();
    let output = match crate::host::exec::run_cmd_output_stdin(
        &target.celld_bin,
        &arg_refs,
        body,
        None,
        &env,
        timeout,
    )
    .await
    {
        Ok(output) => output,
        Err(e) => {
            return CallAnswer::Transport {
                message: one_line(&format!("{e:#}")),
            };
        }
    };
    // A non-2xx answer still prints its envelope before the nonzero exit,
    // so the status decides like the fleet path's; only a missing envelope
    // — no live node, a shed load, a killed caller — is a transport
    // failure with an unknown outcome. Stderr is preview-capped: it is
    // celld's own error lines (tenant bytes arrive on stdout), and the
    // deploy error truncates it further downstream.
    match parse_invoke_answer(&output.stdout) {
        InvokeParse::Answered { status, body } => CallAnswer::Answered {
            status,
            body: String::from_utf8_lossy(&body).into_owned(),
        },
        InvokeParse::TooLarge { message } => CallAnswer::TooLarge { message },
        // No envelope also covers a celld without `invoke` or
        // `--header-env`: name the requirement rather than leave the
        // operator chasing the network.
        InvokeParse::NoEnvelope => CallAnswer::Transport {
            message: format!(
                "celld invoke gave no answer (staged migrations need celld \
                 0.6.3-ryuzcorp.7 or newer): {}",
                one_line(&preview(&String::from_utf8_lossy(&output.stderr), 500))
            ),
        },
    }
}

/// What `celld invoke --json` stdout carried.
#[derive(Debug)]
enum InvokeParse {
    Answered { status: u16, body: Vec<u8> },
    TooLarge { message: String },
    NoEnvelope,
}

/// Parse the `--json` result envelope (`{"status","headers","body"}` with
/// a base64 body), whatever the exit status. The body stays capped at
/// [`MAX_RESPONSE_BYTES`], like the fleet path's streaming cap: stdout
/// itself arrives whole from the child (bounded above by the node's 64 MiB
/// staged-answer cap), so anything past the largest envelope a within-cap
/// body can fill — base64 inflates 4/3, plus slack for the JSON frame —
/// verdicts oversized before a byte parses, and an answer past the cap is
/// known before a byte decodes.
fn parse_invoke_answer(stdout: &[u8]) -> InvokeParse {
    // Largest stdout a within-cap body can fill: the base64 alone, plus
    // slack for `{"status","headers","body"}`. Past it the body is over
    // the cap or the bytes never were an envelope — both verdict TooLarge,
    // as the fleet path's cap verdicts any over-cap body however it reads.
    if stdout.len() > MAX_RESPONSE_BYTES / 3 * 4 + 4 + 128 {
        return InvokeParse::TooLarge {
            message: format!(
                "migration invoke answer of {} bytes is over the {} MiB cap",
                stdout.len(),
                MAX_RESPONSE_BYTES / 1024 / 1024
            ),
        };
    }
    let value: Value = match serde_json::from_slice(stdout) {
        Ok(value) => value,
        Err(_) => return InvokeParse::NoEnvelope,
    };
    let Some(status) = value.get("status").and_then(Value::as_u64) else {
        return InvokeParse::NoEnvelope;
    };
    let Ok(status) = u16::try_from(status) else {
        return InvokeParse::NoEnvelope;
    };
    let Some(body_b64) = value.get("body").and_then(Value::as_str) else {
        return InvokeParse::NoEnvelope;
    };
    // Bound the decode before it runs: anything past the cap is TooLarge
    // with no buffer spent, like the fleet path's declared-length check.
    if body_b64.len() > MAX_RESPONSE_BYTES / 3 * 4 + 4 {
        return InvokeParse::TooLarge {
            message: format!(
                "migration invoke answer of ~{} bytes is over the {} MiB cap",
                body_b64.len() / 4 * 3,
                MAX_RESPONSE_BYTES / 1024 / 1024
            ),
        };
    }
    // Undecodable counts as garbage, like any unparsable fleet body: the
    // status still decides, and the body parses as nothing.
    let body = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        body_b64.as_bytes(),
    )
    .unwrap_or_default();
    if body.len() > MAX_RESPONSE_BYTES {
        return InvokeParse::TooLarge {
            message: format!(
                "migration invoke answer of {} bytes is over the {} MiB cap",
                body.len(),
                MAX_RESPONSE_BYTES / 1024 / 1024
            ),
        };
    }
    InvokeParse::Answered { status, body }
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

    fn scratch(name: &str) -> crate::testutil::TempDir {
        crate::testutil::TempDir::new(&format!("noite-void-migrate-{name}"))
    }

    /// The collector follows Void's rule byte for byte: sorted `.sql`,
    /// `seed.sql` excluded, case-sensitive suffix, non-recursive, missing
    /// dir collects nothing. The fixture mirrors the directory Void's own
    /// `collectMigrations` ran over for the golden `collector` section.
    #[test]
    fn collector_matches_void() {
        let guard_collect = scratch("collect");
        let dir = guard_collect.path().canonicalize().unwrap();
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
        let guard_collect_dir = scratch("collect-dir");
        let dir = guard_collect_dir.path().canonicalize().unwrap();
        std::fs::create_dir(dir.join("0001_oops.sql")).unwrap();
        assert!(collect_migrations(&dir).is_err());
    }

    /// `void.json`'s `sourceDir` moves the migrations root; anything
    /// escaping the worktree fails instead.
    #[test]
    fn migrations_dir_resolution() {
        let guard_paths = scratch("paths");
        let dir = guard_paths.path().canonicalize().unwrap();
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
        let guard_cap_file = scratch("cap-file");
        let dir = guard_cap_file.path().canonicalize().unwrap();
        std::fs::write(
            dir.join("big.sql"),
            vec![b'x'; MAX_MIGRATION_FILE_BYTES + 1],
        )
        .unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("per-file cap"), "{}", err);

        let guard_cap_total = scratch("cap-total");
        let dir = guard_cap_total.path().canonicalize().unwrap();
        for i in 0..5 {
            std::fs::write(
                dir.join(format!("{:04}.sql", i)),
                vec![b'x'; 14 * 1024 * 1024],
            )
            .unwrap();
        }
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("total cap"), "{}", err);

        let guard_cap_count = scratch("cap-count");
        let dir = guard_cap_count.path().canonicalize().unwrap();
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
        let guard_cap_links = scratch("cap-links");
        let dir = guard_cap_links.path().canonicalize().unwrap();
        std::fs::write(dir.join("real.sql"), "SELECT 1;\n").unwrap();
        symlink(dir.join("real.sql"), dir.join("link.sql")).unwrap();
        symlink("/dev/null", dir.join("null.sql")).unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);

        let guard_cap_fifo = scratch("cap-fifo");
        let dir = guard_cap_fifo.path().canonicalize().unwrap();
        let fifo = dir.join("stuck.sql");
        let raw = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);

        // Unix socket paths must fit SUN_LEN: the guard's
        // `/tmp/noite-cap-sock-<pid>-<id>/s.sql` stays well under it. The
        // guard is declared before the listener so the socket is closed
        // before the directory is removed.
        let guard_sock = crate::testutil::TempDir::new("noite-cap-sock");
        let dir = guard_sock.path().canonicalize().unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(dir.join("s.sql")).unwrap();
        let err = collect_migrations(&dir).unwrap_err().to_string();
        assert!(err.contains("not a regular file"), "{}", err);
    }

    /// A symlink anywhere in the migrations path below the root fails the
    /// deploy: neither a `sourceDir` component pointing outside the worktree
    /// nor a symlinked `db/` is followed.
    #[test]
    #[cfg(unix)]
    fn resolve_refuses_symlinked_source_dir() {
        use std::os::unix::fs::symlink;
        let guard_outside = scratch("resolve-outside");
        let outside = guard_outside.path().canonicalize().unwrap();
        std::fs::create_dir_all(outside.join("db").join("migrations")).unwrap();
        std::fs::write(
            outside.join("db").join("migrations").join("evil.sql"),
            "SELECT 1;\n",
        )
        .unwrap();

        let guard_resolve_link = scratch("resolve-link");
        let dir = guard_resolve_link.path().canonicalize().unwrap();
        symlink(&outside, dir.join("client")).unwrap();
        std::fs::write(dir.join("void.json"), r#"{"sourceDir": "client"}"#).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{}", err);

        let guard_resolve_dblink = scratch("resolve-dblink");
        let dir = guard_resolve_dblink.path().canonicalize().unwrap();
        symlink(&outside, dir.join("db")).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{}", err);
    }

    /// An oversized `void.json` fails the deploy instead of being parsed.
    #[test]
    fn resolve_refuses_huge_void_json() {
        let guard_resolve_big = scratch("resolve-big");
        let dir = guard_resolve_big.path().canonicalize().unwrap();
        std::fs::write(dir.join("void.json"), vec![b'x'; MAX_VOID_JSON_BYTES + 1]).unwrap();
        let err = resolve_migrations_dir(&dir).unwrap_err().to_string();
        assert!(err.contains("over the 1 MiB cap"), "{}", err);
    }

    /// The canary's pass rule: any answered status below 500 passes — the
    /// staged worker answered as itself — while a 5xx fails.
    #[test]
    fn probe_status_passes_below_500() {
        for status in [200, 201, 204, 301, 404, 499] {
            assert!(probe_status_passes(status), "{status}");
        }
        for status in [500, 502, 503] {
            assert!(!probe_status_passes(status), "{status}");
        }
    }

    // --- staged transport (`celld invoke`) ----------------------------------

    /// A fake `celld` for the staged transport: the committed cohost
    /// fixture, fixture-driven per `invoke --path` like the deploy seam.
    /// A token no argv may ever contain.
    const SECRET_TOKEN: &str = "proxy-secret-7f3a";

    struct FakeInvoke {
        dir: crate::testutil::TempDir,
    }

    impl FakeInvoke {
        fn spawn() -> Self {
            let dir = crate::testutil::TempDir::new("noite-staged-transport");
            // A symlink to the committed script, never a fresh file: the
            // cohost seam's rule (ETXTBSY under parallel load).
            let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fake-celld-cohost.sh");
            std::os::unix::fs::symlink(&fixture, dir.path().join("celld")).unwrap();
            Self { dir }
        }

        fn staged(&self) -> MigrationClient {
            let log = self
                .dir
                .path()
                .join("invocations.log")
                .to_string_lossy()
                .into_owned();
            let dir = self.dir.path().to_string_lossy().into_owned();
            MigrationClient::staged(
                StagedTarget {
                    celld_bin: self.dir.path().join("celld").to_string_lossy().into_owned(),
                    env: vec![
                        ("FAKE_CELLD_LOG".to_string(), log),
                        ("FAKE_CELLD_DIR".to_string(), dir),
                    ],
                    bucket: "s3://noite/fleets/staged".to_string(),
                    endpoint: "http://rustfs:9000".to_string(),
                    region: "us-east-1".to_string(),
                    pins: vec![
                        ("test-proxy".to_string(), "0000000000000001".to_string()),
                        ("test-app".to_string(), "0000000000000002".to_string()),
                    ],
                    target: "test-app".to_string(),
                },
                SECRET_TOKEN.to_string(),
            )
            .with_retry_delay(std::time::Duration::from_millis(0))
        }

        /// Write one `--json` invoke fixture: the full result envelope the
        /// fake cats to stdout for the endpoint `name`.
        fn write_invoke(&self, name: &str, status: u16, body: &str) {
            use base64::Engine as _;
            let envelope = serde_json::json!({
                "status": status,
                "headers": {},
                "body": base64::engine::general_purpose::STANDARD.encode(body),
            });
            std::fs::write(
                self.dir.path().join(name),
                serde_json::to_string(&envelope).unwrap(),
            )
            .unwrap();
        }

        fn fail_invoke(&self, name: &str, message: &str) {
            std::fs::write(self.dir.path().join(format!("{name}.fail")), message).unwrap();
        }

        /// One line per invoke: the proxy token celld got from its
        /// environment.
        fn tokens(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("invoke-token.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        /// The request bodies celld read from stdin, one per line.
        fn bodies(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("invoke-body.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }

        fn invocations(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("invocations.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    /// The staged capabilities probe parses v2 and pins the generation:
    /// every staged pin rides the argv with the app as `--target`, the
    /// fleet's proxy token reaches `x-void-internal` through the
    /// environment (`--header-env`, never argv, which every local user can
    /// read), and `--json` asks for the envelope.
    #[tokio::test]
    async fn staged_capabilities_parses_v2_and_pins_the_generation() {
        let fake = FakeInvoke::spawn();
        fake.write_invoke(
            "invoke-capabilities",
            200,
            &serde_json::json!({
                "protocolVersion": 2,
                "dialect": "sqlite",
                "classifierVersion": CLASSIFIER_VERSION,
                "migrationListHash": "list-hash",
                "destructiveValidation": "passed",
                "endpoints": {"auth": "/auth"},
            })
            .to_string(),
        );
        let caps = fake.staged().capabilities().await.expect("v2");
        assert_eq!(caps.dialect, "sqlite");
        assert_eq!(caps.migration_list_hash, "list-hash");
        assert_eq!(caps.auth_endpoint.as_deref(), Some("/auth"));
        let calls = fake.invocations();
        assert_eq!(calls.len(), 1, "{calls:?}");
        for expected in [
            "invoke test-proxy=0000000000000001 test-app=0000000000000002",
            "--target test-app",
            "--method GET",
            "--path /__void/migrate/capabilities",
            "--header-env x-void-internal=NOITE_VOID_PROXY_TOKEN",
            "--json",
            "--bucket s3://noite/fleets/staged",
            "--endpoint http://rustfs:9000",
            "--region us-east-1",
        ] {
            assert!(calls[0].contains(expected), "{}", calls[0]);
        }
        assert!(!calls[0].contains("--body"), "{}", calls[0]);
        assert!(
            !calls[0].contains(SECRET_TOKEN),
            "token on argv: {}",
            calls[0]
        );
        assert_eq!(fake.tokens(), vec![SECRET_TOKEN.to_string()]);
    }

    /// A non-2xx staged answer reads like the fleet path's: no v2 shape, so
    /// the deploy falls back to the legacy endpoint.
    #[tokio::test]
    async fn staged_capabilities_non_2xx_answers_without_v2() {
        let fake = FakeInvoke::spawn();
        fake.write_invoke("invoke-capabilities", 404, "not found");
        let err = fake.staged().capabilities().await.expect_err("no v2");
        match err {
            ProbeError::Http { status, .. } => assert_eq!(status, 404),
            other => panic!("expected an Http probe error, got {other:?}"),
        }
    }

    /// No envelope — no live node, a shed load, a killed caller — is a
    /// transport error with an unknown outcome, like the fleet path's.
    #[tokio::test]
    async fn staged_capabilities_without_envelope_is_a_transport_error() {
        let fake = FakeInvoke::spawn();
        fake.fail_invoke("invoke-capabilities", "no live node");
        let err = fake.staged().capabilities().await.expect_err("no node");
        match err {
            ProbeError::Transport { message } => {
                assert!(message.contains("no live node"), "{message}")
            }
            other => panic!("expected a Transport probe error, got {other:?}"),
        }
    }

    /// A garbage staged body reconciles through the attempt endpoint, like
    /// the fleet path's garbage: the outcome is unknown, never failed.
    #[tokio::test]
    async fn staged_migrate_app_garbage_body_reconciles() {
        let fake = FakeInvoke::spawn();
        fake.write_invoke("invoke-app", 200, "this is not json");
        fake.write_invoke(
            "invoke-attempt",
            200,
            r#"{"ok":true,"migrations":[{"name":"0001.sql","applied":true}]}"#,
        );
        let response = fake.staged().migrate_app("migatt_test", "deploy-id").await;
        assert!(response.ok, "{:?}", response.error);
        assert_eq!(response.attempt_id.as_deref(), None);
        let calls = fake.invocations();
        let attempts: Vec<_> = calls
            .iter()
            .filter(|call| call.contains("--path /__void/migrate/app/attempt/"))
            .collect();
        assert_eq!(attempts.len(), 1, "{calls:?}");
        // The attempt id rides the reconcile path; the POST carried it in
        // the JSON body.
        let posts: Vec<_> = calls
            .iter()
            .filter(|call| call.contains("--path /__void/migrate/app "))
            .collect();
        assert_eq!(posts.len(), 1, "{calls:?}");
        assert!(posts[0].contains("--body-file -"), "{}", posts[0]);
        assert!(
            posts[0].contains("--header content-type:application/json"),
            "{}",
            posts[0]
        );
        // The JSON body went over stdin, never argv; every call carried
        // the token through the environment only.
        assert!(
            !posts[0].contains("migatt_test"),
            "body on argv: {}",
            posts[0]
        );
        assert!(
            fake.bodies()
                .iter()
                .any(|body| body.contains("migatt_test")),
            "{:?}",
            fake.bodies()
        );
        assert!(
            calls.iter().all(|call| !call.contains(SECRET_TOKEN)),
            "{calls:?}"
        );
        assert!(fake.tokens().iter().all(|token| token == SECRET_TOKEN));
    }

    /// The legacy endpoint runs staged too: one POST with no body, the
    /// worker's answer parsed like the fleet path's.
    #[tokio::test]
    async fn staged_migrate_legacy_posts_without_a_body() {
        let fake = FakeInvoke::spawn();
        fake.write_invoke(
            "invoke-legacy",
            200,
            r#"{"ok":true,"migrations":[{"name":"0001.sql","applied":true}]}"#,
        );
        let response = fake.staged().migrate_legacy().await.expect("legacy");
        assert!(response.ok, "{:?}", response.error);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(calls[0].contains("--method POST"), "{}", calls[0]);
        assert!(calls[0].contains("--path /__void/migrate "), "{}", calls[0]);
        assert!(!calls[0].contains("--body"), "{}", calls[0]);
    }

    /// The `--json` envelope parses however the answer read: status and
    /// base64 body on any exit, since a non-2xx answer still prints its
    /// envelope before failing.
    #[test]
    fn invoke_answer_parses_the_json_envelope() {
        use base64::Engine as _;
        let body = br#"{"ok":true}"#;
        let stdout = serde_json::json!({
            "status": 404,
            "headers": {},
            "body": base64::engine::general_purpose::STANDARD.encode(body),
        })
        .to_string();
        match parse_invoke_answer(stdout.as_bytes()) {
            InvokeParse::Answered { status, body } => {
                assert_eq!(status, 404);
                assert_eq!(body, br#"{"ok":true}"#);
            }
            other => panic!("expected an answered envelope, got {other:?}"),
        }
    }

    /// Anything without an envelope — a CLI failure, a killed caller — is
    /// no answer, never a parsed one: unparsable stdout, a missing status,
    /// and a status wider than u16 all refuse alike.
    #[test]
    fn invoke_answer_without_an_envelope_is_no_answer() {
        match parse_invoke_answer(b"Error: no live node\n") {
            InvokeParse::NoEnvelope => {}
            other => panic!("expected no envelope, got {other:?}"),
        }
        match parse_invoke_answer(br#"{"status":"200","body":"e30="}"#) {
            InvokeParse::NoEnvelope => {}
            other => panic!("expected no envelope, got {other:?}"),
        }
        match parse_invoke_answer(br#"{"status":70000,"body":"e30="}"#) {
            InvokeParse::NoEnvelope => {}
            other => panic!("expected no envelope, got {other:?}"),
        }
    }

    /// An undecodable body counts as garbage, not as a missing answer: the
    /// status still decides and the body parses as nothing.
    #[test]
    fn invoke_answer_with_an_undecodable_body_parses_as_nothing() {
        match parse_invoke_answer(br#"{"status":200,"body":"!!!not-base64!!!"}"#) {
            InvokeParse::Answered { status, body } => {
                assert_eq!(status, 200);
                assert!(body.is_empty(), "{body:?}");
            }
            other => panic!("expected an answered envelope, got {other:?}"),
        }
    }

    /// An answer past the cap verdicts oversized twice: past the largest
    /// envelope a within-cap body can fill, stdout never parses; past the
    /// cap, the base64 length alone verdicts it, like the fleet path's
    /// declared-length check.
    #[test]
    fn invoke_answer_past_the_cap_is_oversized_before_it_decodes() {
        let huge = "A".repeat(MAX_RESPONSE_BYTES / 3 * 4 + 5);
        let stdout = format!(r#"{{"status":200,"body":"{huge}"}}"#);
        match parse_invoke_answer(stdout.as_bytes()) {
            InvokeParse::TooLarge { .. } => {}
            other => panic!("expected an oversized answer, got {other:?}"),
        }
    }

    /// Huge garbage never parses either: past the stdout bound it verdicts
    /// oversized, as the fleet path's cap verdicts any over-cap body
    /// however it reads.
    #[test]
    fn invoke_answer_huge_garbage_verdicts_oversized() {
        let stdout = vec![b'x'; MAX_RESPONSE_BYTES / 3 * 4 + 4 + 129];
        match parse_invoke_answer(&stdout) {
            InvokeParse::TooLarge { .. } => {}
            other => panic!("expected an oversized answer, got {other:?}"),
        }
    }

    /// The boundary holds: a body of exactly the cap parses answered.
    #[test]
    fn invoke_answer_at_exactly_the_cap_parses() {
        use base64::Engine as _;
        let body = vec![b'A'; MAX_RESPONSE_BYTES];
        let stdout = serde_json::json!({
            "status": 200,
            "headers": {},
            "body": base64::engine::general_purpose::STANDARD.encode(&body),
        })
        .to_string();
        match parse_invoke_answer(stdout.as_bytes()) {
            InvokeParse::Answered {
                status,
                body: parsed,
            } => {
                assert_eq!(status, 200);
                assert_eq!(parsed.len(), MAX_RESPONSE_BYTES);
            }
            other => panic!("expected an answered envelope, got {other:?}"),
        }
    }
}
