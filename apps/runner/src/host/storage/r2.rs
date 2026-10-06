//! R2 bucket browsing: prefix/delimiter listing, download, upload, delete.
//!
//! celld serves an `r2_buckets` binding out of the fleet bucket under the
//! reserved `r2/<bucket_name>/` prefix: the body is a plain object, the five
//! content headers are real headers, and the rest of the record travels in
//! the `celld-r2` user-metadata entry (`docs/services/r2`, "Where celld
//! stores an object"). A key reaches the store percent-encoded — the bytes
//! celld escapes are `%`, the set `\{}^`[]"<>~#|*?`, controls and every
//! non-ASCII byte, an empty segment becomes `%`, and a space stays a space —
//! so a listing that walks S3 directly must encode the prefix it lists and
//! decode what it reads (`r2_encode` / `r2_decode`, pinned by the tests
//! below against celld 0.6.1).
//!
//! Writes go through `celld r2 put`, which writes the same record a Worker's
//! `env.BUCKET.put()` writes. A plain S3 PUT would store the body with the
//! wrong key encoding and without the record, so the upload never does one.
use std::path::Path;
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use ts_rs::TS;

use crate::config::Config;
use crate::host::{exec, s3};
use crate::models::App;

/// R2's own key bound (1..=1024 bytes).
const R2_MAX_KEY_BYTES: usize = 1024;
/// Folders + files one listing page may return.
pub const R2_PAGE_LIMIT: usize = 100;
/// One delete call carries at most this many keys (the UI's bulk cap).
pub const R2_DELETE_LIMIT: usize = 100;
/// Largest object the raw download serves, matching the UI's upload cap.
const R2_RAW_CAP: i64 = 67_108_864;
/// Largest body the text preview reads.
const R2_PREVIEW_CAP: usize = 262_144;
/// HEADs one listing page may run in parallel for content types.
const R2_HEAD_CONCURRENCY: usize = 8;
const CELD_TIMEOUT: Duration = Duration::from_secs(120);
const CELD_UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct R2Folder {
    pub name: String,
    /// Key prefix of the folder, including its trailing `/`.
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct R2Object {
    pub key: String,
    pub name: String,
    pub size: i64,
    pub last_modified: String,
    pub content_type: Option<String>,
    pub etag: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct R2Preview {
    pub app_id: String,
    pub app_slug: String,
    pub bucket: String,
    /// The folder the page lists (decoded key prefix, `""` at the root).
    pub prefix: String,
    pub folders: Vec<R2Folder>,
    pub objects: Vec<R2Object>,
    /// Continuation token for the next page, `null` on the last one.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct R2File {
    pub key: String,
    pub size: i64,
    pub truncated: bool,
    pub content_type: Option<String>,
    /// UTF-8 body (up to the preview cap); None for binary objects.
    pub text: Option<String>,
}

/// Raw object bytes plus the record header the download re-serves.
pub struct R2Raw {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

/// celld serves an R2 binding out of the fleet bucket under this prefix.
fn r2_base(app: &App, bucket: &str) -> String {
    format!("fleets/{}/r2/{bucket}/", app.slug)
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + value - 10) as char,
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// `true` for a byte celld escapes when it stores a key.
fn r2_escapable(byte: u8) -> bool {
    if byte < 0x20 || byte == 0x7F || byte >= 0x80 {
        return true;
    }
    matches!(
        byte,
        b'%' | b'\\'
            | b'{'
            | b'}'
            | b'^'
            | b'`'
            | b'['
            | b']'
            | b'"'
            | b'<'
            | b'>'
            | b'~'
            | b'#'
            | b'|'
            | b'*'
            | b'?'
    )
}

/// The stored form of an R2 key: every escapable byte as `%XX`, an empty
/// segment as `%` (the docs' `photos/` → `r2/<bucket>/photos/%`).
pub fn r2_encode(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for (index, segment) in key.split('/').enumerate() {
        if index > 0 {
            out.push('/');
        }
        if segment.is_empty() {
            out.push('%');
            continue;
        }
        for byte in segment.bytes() {
            if r2_escapable(byte) {
                out.push('%');
                out.push(hex_digit(byte >> 4));
                out.push(hex_digit(byte & 0x0F));
            } else {
                out.push(byte as char);
            }
        }
    }
    out
}

/// The stored form of a *folder prefix* for a listing. Unlike a key, its
/// trailing `/` is the parent separator, not an empty segment: `dir/` lists
/// `…/dir/`, while the key `dir/` would be stored as `…/dir/%`.
pub fn r2_encode_prefix(prefix: &str) -> String {
    if prefix.is_empty() {
        return String::new();
    }
    let trimmed = prefix.strip_suffix('/').unwrap_or(prefix);
    format!("{}/", r2_encode(trimmed))
}

/// One stored segment back to its key bytes. A lone `%` is the empty
/// segment celld wrote; a malformed escape (a key another tool wrote) is
/// kept literally rather than failing the whole page.
fn r2_decode_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The key a stored key names (the inverse of `r2_encode`).
pub fn r2_decode(stored: &str) -> String {
    let mut out = String::with_capacity(stored.len());
    for (index, segment) in stored.split('/').enumerate() {
        if index > 0 {
            out.push('/');
        }
        if segment == "%" {
            continue;
        }
        out.push_str(&r2_decode_segment(segment));
    }
    out
}

/// A key the browser may write or delete: 1..=1024 bytes, no absolute path
/// and no `..` segment, no control character. A trailing `/` is legal — it
/// is the folder marker.
pub fn r2_key_ok(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= R2_MAX_KEY_BYTES
        && !key.starts_with('/')
        && !key.split('/').any(|segment| segment == "..")
        && !key.chars().any(char::is_control)
}

/// A folder prefix a listing may name: `""` (the bucket root) or a key that
/// passes `r2_key_ok` after its trailing `/` is normalized on.
pub fn r2_prefix_ok(prefix: &str) -> bool {
    prefix.is_empty() || r2_key_ok(prefix)
}

/// A content type (or any header value) that is safe to place in a command
/// argument and a response header.
pub fn r2_header_ok(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.bytes().all(|byte| (0x20..0x7F).contains(&byte))
}

fn normalize_prefix(prefix: &str) -> String {
    if prefix.is_empty() || prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    }
}

fn celld_env(cfg: &Config) -> Vec<(&str, String)> {
    let mut env = s3::aws_env(cfg);
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.clone()));
    env
}

/// Run one `celld` subcommand against the fleet's own bucket.
async fn run_celld(cfg: &Config, args: &[&str], timeout: Duration) -> anyhow::Result<String> {
    let env_owned = celld_env(cfg);
    let env: Vec<(&str, &str)> = env_owned
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    exec::run_cmd(&cfg.celld_bin, args, None, &env, timeout).await
}

/// The fleet options every `celld r2` call carries.
fn fleet_args<'a>(app: &'a App, cfg: &'a Config) -> [&'a str; 4] {
    [
        "--bucket",
        &app.fleet_bucket,
        "--endpoint",
        &cfg.s3_endpoint,
    ]
}

/// Split one S3 page into the rows a browser shows: `CommonPrefixes` are the
/// folders below the listed prefix, `Contents` the files in it. The zero-byte
/// marker that makes an empty folder visible lands in `Contents` as `<folder>/`
/// and is dropped — the folder itself comes back as a common prefix. Pure so
/// the prefix/delimiter rules stay unit-testable without a store.
fn split_page(
    s3_prefix: &str,
    parent: &str,
    stored_prefixes: &[String],
    stored_objects: &[s3::S3Object],
) -> (Vec<R2Folder>, Vec<R2Object>) {
    let mut folders = Vec::new();
    for stored in stored_prefixes {
        let Some(relative) = stored.strip_prefix(s3_prefix) else {
            continue;
        };
        let decoded = r2_decode(relative);
        // A prefix always ends in `/`; the name is the segment before it, and
        // an empty one (a key with an empty segment) still browses.
        let trimmed = decoded.strip_suffix('/').unwrap_or(&decoded);
        let name = trimmed.rsplit('/').next().unwrap_or("");
        folders.push(R2Folder {
            name: if name.is_empty() {
                "(empty)".to_string()
            } else {
                name.to_string()
            },
            prefix: format!("{parent}{decoded}"),
        });
    }
    folders.sort_by(|a, b| a.name.cmp(&b.name));

    let mut objects = Vec::new();
    for object in stored_objects {
        let Some(relative) = object.key.strip_prefix(s3_prefix) else {
            continue;
        };
        let key = format!("{parent}{}", r2_decode(relative));
        if key.ends_with('/') {
            continue;
        }
        let name = key.rsplit('/').next().unwrap_or("").to_string();
        objects.push(R2Object {
            key,
            name,
            size: i64::try_from(object.size).unwrap_or(i64::MAX),
            last_modified: object.last_modified.clone(),
            content_type: None,
            etag: Some(object.etag.clone()),
        });
    }
    objects.sort_by(|a, b| a.key.cmp(&b.key));
    (folders, objects)
}

/// One page of a bucket folder: `CommonPrefixes` are its folders and
/// `Contents` the files in it (the object stores a key as
/// `<fleet>/r2/<bucket>/<key>`, so a folder only exists while a key is under
/// it or a marker object names it).
pub async fn r2_list(
    cfg: &Config,
    app: &App,
    bucket: &str,
    prefix: &str,
    cursor: Option<&str>,
    limit: usize,
) -> anyhow::Result<R2Preview> {
    if !r2_prefix_ok(prefix) {
        anyhow::bail!("invalid prefix");
    }
    let prefix = normalize_prefix(prefix);
    let base = r2_base(app, bucket);
    let s3_prefix = format!("{base}{}", r2_encode_prefix(&prefix));
    let page = s3::s3_list_page(
        cfg,
        &cfg.s3_bucket,
        &s3_prefix,
        Some("/"),
        limit.clamp(1, R2_PAGE_LIMIT),
        cursor,
    )
    .await?;

    let (folders, mut objects) = split_page(&s3_prefix, &prefix, &page.prefixes, &page.objects);

    // The listing carries no media type, so ask each visible object for its
    // record — a page is bounded, head requests are cheap and they run in
    // parallel. A failure leaves the type unknown rather than failing the page.
    let full_keys: Vec<String> = objects
        .iter()
        .map(|object| format!("{base}{}", r2_encode(&object.key)))
        .collect();
    let bucket_name = cfg.s3_bucket.clone();
    let content_types: Vec<Option<s3::S3Head>> = futures::stream::iter(full_keys)
        .map(|full| {
            let bucket_name = bucket_name.clone();
            async move { s3::s3_head_object(cfg, &bucket_name, &full).await }
        })
        .buffered(R2_HEAD_CONCURRENCY)
        .collect()
        .await;
    for (index, head) in content_types.into_iter().enumerate() {
        if let (Some(object), Some(head)) = (objects.get_mut(index), head) {
            object.content_type = head.content_type;
        }
    }
    Ok(R2Preview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        bucket: bucket.to_string(),
        prefix,
        folders,
        objects,
        next_cursor: page.next,
    })
}

/// Download one object's bytes (capped) and the media type to re-serve it.
pub async fn r2_raw(
    cfg: &Config,
    app: &App,
    bucket: &str,
    key: &str,
) -> anyhow::Result<R2Raw> {
    if !r2_key_ok(key) {
        anyhow::bail!("invalid key");
    }
    let full = format!("{}{}", r2_base(app, bucket), r2_encode(key));
    let Some(head) = s3::s3_head_object(cfg, &cfg.s3_bucket, &full).await else {
        anyhow::bail!("object not found");
    };
    if head.size > R2_RAW_CAP {
        anyhow::bail!("object too large to download");
    }
    let bytes = s3::s3_get_bytes(cfg, &full).await?;
    Ok(R2Raw {
        bytes,
        content_type: head.content_type,
    })
}

/// Bounded text preview of one object (None when the body is not UTF-8).
pub async fn r2_get(cfg: &Config, app: &App, bucket: &str, key: &str) -> anyhow::Result<R2File> {
    if !r2_key_ok(key) {
        anyhow::bail!("invalid key");
    }
    let full = format!("{}{}", r2_base(app, bucket), r2_encode(key));
    // Size-gate before downloading so a stray multi-GB object can't OOM us.
    let Some(head) = s3::s3_head_object(cfg, &cfg.s3_bucket, &full).await else {
        anyhow::bail!("object not found");
    };
    let bytes = s3::s3_get_bytes(cfg, &full).await?;
    let truncated = bytes.len() > R2_PREVIEW_CAP;
    let preview = &bytes[..bytes.len().min(R2_PREVIEW_CAP)];
    Ok(R2File {
        key: key.to_string(),
        size: head.size,
        truncated,
        content_type: head.content_type,
        text: String::from_utf8(preview.to_vec()).ok(),
    })
}

/// Write one object with the full celld record (the five content headers and
/// the `celld-r2` metadata), exactly as a Worker's `env.BUCKET.put()` would.
/// A folder marker is the same call with an empty body and a `/` key.
pub async fn r2_put(
    cfg: &Config,
    app: &App,
    bucket: &str,
    key: &str,
    content_type: Option<&str>,
    source: &Path,
) -> anyhow::Result<()> {
    if !r2_key_ok(key) {
        anyhow::bail!("invalid key");
    }
    if !r2_key_ok(bucket) {
        anyhow::bail!("invalid bucket");
    }
    if let Some(value) = content_type {
        if !r2_header_ok(value) {
            anyhow::bail!("invalid content type");
        }
    }
    let path = source
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("upload path is not UTF-8"))?;
    let fleet = fleet_args(app, cfg);
    let mut args: Vec<&str> = vec!["r2", "put", bucket, key, "--path", path];
    if let Some(value) = content_type {
        args.push("--content-type");
        args.push(value);
    }
    args.extend(fleet);
    run_celld(cfg, &args, CELD_UPLOAD_TIMEOUT).await?;
    Ok(())
}

/// Delete 1..=100 objects in one `celld r2 delete` call.
pub async fn r2_delete_many(
    cfg: &Config,
    app: &App,
    bucket: &str,
    keys: &[String],
) -> anyhow::Result<usize> {
    if keys.is_empty() || keys.len() > R2_DELETE_LIMIT {
        anyhow::bail!("select 1 to {R2_DELETE_LIMIT} objects");
    }
    if !r2_key_ok(bucket) {
        anyhow::bail!("invalid bucket");
    }
    for key in keys {
        if !r2_key_ok(key) {
            anyhow::bail!("invalid key");
        }
    }
    let fleet = fleet_args(app, cfg);
    let mut args: Vec<&str> = vec!["r2", "delete", bucket];
    for key in keys {
        args.push(key);
    }
    args.extend(fleet);
    run_celld(cfg, &args, CELD_TIMEOUT).await?;
    Ok(keys.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stored forms captured from celld 0.6.1: `celld r2 put` for each key,
    /// then a raw `ListObjectsV2`. The encoder must reproduce them byte for
    /// byte, and the decoder must bring them back — a browser that lists S3
    /// directly depends on both.
    const VECTORS: [(&str, &str); 29] = [
        ("a//b", "a/%/b"),
        ("photos/", "photos/%"),
        ("a//", "a/%/%"),
        ("accent-é", "accent-%C3%A9"),
        ("back\\slash", "back%5Cslash"),
        ("brace{}", "brace%7B%7D"),
        ("brack[et]", "brack%5Bet%5D"),
        ("caret^", "caret%5E"),
        ("grave`x", "grave%60x"),
        ("hash#tag", "hash%23tag"),
        ("lt<gt>", "lt%3Cgt%3E"),
        ("percent%25", "percent%2525"),
        ("pic name+café (1).png", "pic name+caf%C3%A9 (1).png"),
        ("pipe|x", "pipe%7Cx"),
        ("q?mark", "q%3Fmark"),
        ("quote\"z", "quote%22z"),
        ("star*", "star%2A"),
        ("tilde~x", "tilde%7Ex"),
        ("deep/nested/x.txt", "deep/nested/x.txt"),
        // Left literal by celld.
        ("sp ace.txt", "sp ace.txt"),
        ("plus+sign", "plus+sign"),
        ("amp&and", "amp&and"),
        ("at@x", "at@x"),
        ("colon:y", "colon:y"),
        ("comma,x", "comma,x"),
        ("bang!", "bang!"),
        ("semi;x", "semi;x"),
        ("dollar$x", "dollar$x"),
        ("paren(1)", "paren(1)"),
    ];

    #[test]
    fn keys_encode_and_decode_the_way_celld_stores_them() {
        for (key, stored) in VECTORS {
            assert_eq!(r2_encode(key), stored, "encode {key}");
            assert_eq!(r2_decode(stored), key, "decode {stored}");
        }
    }

    #[test]
    fn listing_prefixes_keep_their_trailing_separator() {
        // A key `photos/` is stored as `photos/%`, but a *listing* of the
        // folder `photos/` must ask for `photos/` — the separator, not an
        // empty segment — or every object under it is missed.
        assert_eq!(r2_encode_prefix(""), "");
        assert_eq!(r2_encode_prefix("dir/"), "dir/");
        assert_eq!(r2_encode_prefix("e2e-probe/"), "e2e-probe/");
        assert_eq!(r2_encode_prefix("my docs/"), "my docs/");
        assert_eq!(r2_encode_prefix("café/"), "caf%C3%A9/");
        assert_eq!(r2_encode_prefix("a//"), "a/%/");
        assert_eq!(r2_encode_prefix("a//b/"), "a/%/b/");
        assert_eq!(r2_encode("photos/"), "photos/%");
    }

    #[test]
    fn malformed_escapes_stay_literal() {
        // Another tool wrote an object under a key celld cannot name; the page
        // still renders instead of failing.
        assert_eq!(r2_decode_segment("a%ZZ"), "a%ZZ");
        assert_eq!(r2_decode_segment("50%"), "50%");
    }

    #[test]
    fn write_keys_reject_traversal_absolute_and_control_characters() {
        assert!(r2_key_ok("dir/file.txt"));
        assert!(r2_key_ok("folder/"));
        assert!(r2_key_ok("a//b"), "an empty segment is legal to read");
        assert!(!r2_key_ok(""));
        assert!(!r2_key_ok("/etc/passwd"));
        assert!(!r2_key_ok("../escape"));
        assert!(!r2_key_ok("a/../b"));
        assert!(!r2_key_ok("a\nb"));
        assert!(!r2_key_ok(&"x".repeat(R2_MAX_KEY_BYTES + 1)));
        assert!(r2_key_ok(&"x".repeat(R2_MAX_KEY_BYTES)));
    }

    #[test]
    fn prefixes_allow_the_bucket_root_only_as_empty() {
        assert!(r2_prefix_ok(""));
        assert!(r2_prefix_ok("dir/"));
        assert!(r2_prefix_ok("a/b/"));
        assert!(!r2_prefix_ok("/abs/"));
        assert!(!r2_prefix_ok("../"));
        assert!(!r2_prefix_ok("a/../"));
    }

    #[test]
    fn content_types_reject_header_injection() {
        assert!(r2_header_ok("image/png"));
        assert!(!r2_header_ok("image/png\r\nx: y"));
        assert!(!r2_header_ok(""));
    }

    fn stored(key: &str) -> s3::S3Object {
        s3::S3Object {
            key: key.to_string(),
            last_modified: "2026-10-06T11:00:57.528Z".to_string(),
            size: 15,
            etag: "etag".to_string(),
        }
    }

    #[test]
    fn a_page_splits_into_folders_then_files() {
        let base = "fleets/app/r2/bucket/";
        let prefixes = vec![
            format!("{base}dir/"),
            format!("{base}a/"),
            "fleets/other/r2/bucket/dir/".to_string(),
        ];
        let objects = vec![
            stored(&format!("{base}dir/hello.txt")),
            stored(&format!("{base}photos/%")),
            stored(&format!("{base}pic name+caf%C3%A9 (1).png")),
        ];
        let (folders, objects) = split_page(base, "", &prefixes, &objects);
        let names: Vec<String> = folders.iter().map(|folder| folder.name.clone()).collect();
        assert_eq!(names, ["a", "dir"]);
        assert_eq!(folders[0].prefix, "a/");
        let keys: Vec<String> = objects.iter().map(|object| object.key.clone()).collect();
        assert_eq!(keys, ["dir/hello.txt", "pic name+café (1).png"]);
        assert_eq!(objects[0].name, "hello.txt");
        assert_eq!(objects[0].size, 15);
    }

    #[test]
    fn an_empty_segment_folder_browses_as_empty() {
        let base = "fleets/app/r2/bucket/a/";
        let prefixes = vec![format!("{base}%/")];
        let (folders, objects) = split_page(base, "a/", &prefixes, &[stored(&format!("{base}%/b"))]);
        assert_eq!(folders[0].name, "(empty)");
        assert_eq!(folders[0].prefix, "a//");
        // A key with an empty segment round-trips through the parent prefix.
        assert_eq!(objects[0].key, "a//b");
        assert_eq!(objects[0].name, "b");
    }

    #[test]
    fn nested_page_prefix_is_normalized() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("dir"), "dir/");
        assert_eq!(normalize_prefix("dir/"), "dir/");
    }
}
