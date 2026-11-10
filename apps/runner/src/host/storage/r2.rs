//! R2 bucket browsing: prefix/delimiter listing, download, upload, delete.
//!
//! celld serves an `r2_buckets` binding out of the fleet bucket under the
//! reserved `r2/<bucket_name>/` prefix: the body is a plain object, the five
//! content headers are real headers, and the rest of the record travels in
//! the `celld-r2` user-metadata entry (`docs/services/r2`). Every read and
//! write here goes through the `celld r2` CLI, which owns both the stored
//! key form and the record — the runner never encodes a key or touches the
//! store directly, so a folder listing is one `list --page` call with the
//! keys already decoded and the content types in-band.
use std::path::Path;
use std::time::Duration;

use anyhow::Context;
use serde::Deserialize;
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
#[derive(Debug)]
pub struct R2Raw {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
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

/// Run one `celld` subcommand against the fleet's own bucket.
async fn run_celld(
    cfg: &Config,
    app: &App,
    args: &[&str],
    timeout: Duration,
) -> anyhow::Result<String> {
    let scope_key = crate::host::credentials::Scope::app(app).key();
    let env_owned = s3::celld_cli_env(cfg, &scope_key);
    let env: Vec<(&str, &str)> = env_owned
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    exec::run_cmd(&cfg.celld_bin, args, None, &env, timeout).await
}

/// Run one `celld` subcommand and return its output however it exited. An
/// absent key prints its verdict on stdout with exit 1, so the reads —
/// not the spawn — decide what the status means. `stdin` feeds the child's
/// input when present (`r2 get` passes an empty one to close the pipe —
/// `celld r2 get` never reads stdin, so the closed pipe is never observed);
/// `None` leaves stdin inherited.
async fn run_celld_output(
    cfg: &Config,
    app: &App,
    args: &[&str],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> anyhow::Result<exec::CmdOutput> {
    let scope_key = crate::host::credentials::Scope::app(app).key();
    let env_owned = s3::celld_cli_env(cfg, &scope_key);
    let env: Vec<(&str, &str)> = env_owned
        .iter()
        .map(|(key, value)| (*key, value.as_str()))
        .collect();
    exec::run_cmd_output_stdin(&cfg.celld_bin, args, stdin, None, &env, timeout).await
}

/// The absent-key object `celld r2 head|get --json` prints on stdout with
/// exit 1 (`{"error":"not_found","bucket":...,"key":...}`): match the
/// error field, never the English stderr.
fn is_not_found(stdout: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stdout) else {
        return false;
    };
    value
        .get("error")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|error| error == "not_found")
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

/// The `httpMetadata` half of a listed object. Only the content type reaches
/// the browser; the other headers stay unread rather than unparsed.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CelldHttp {
    content_type: Option<String>,
}

/// One object of a `celld r2 list --page` answer: the binding's `list()` row
/// minus `version`, `checksums` and `storageClass`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CelldPageObject {
    key: String,
    size: u64,
    etag: Option<String>,
    /// Milliseconds since the epoch, as R2 spells it.
    uploaded: i64,
    #[serde(default)]
    http_metadata: CelldHttp,
}

/// One `celld r2 list --page` answer: the files in the folder, the prefixes
/// the delimiter rolled up, and the in-band cursor that continues a
/// truncated page (absent when the listing is complete).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CelldPage {
    objects: Vec<CelldPageObject>,
    delimited_prefixes: Vec<String>,
    truncated: bool,
    cursor: Option<String>,
}

/// The rows a browser shows from one `--page` answer: `delimitedPrefixes`
/// are the folders below the listed prefix, `objects` the files in it. The
/// zero-byte marker that makes an empty folder visible answers as an object
/// whose key is the folder itself and is dropped — the folder comes back as
/// a prefix. Pure so the shape rules stay unit-testable without a store.
fn shape_page(app: &App, bucket: &str, prefix: &str, page: CelldPage) -> anyhow::Result<R2Preview> {
    let mut folders: Vec<R2Folder> = page
        .delimited_prefixes
        .into_iter()
        .map(|entry| {
            // A prefix always ends in `/`; the name is the segment before
            // it, and an empty one (a key with an empty segment) still
            // browses.
            let trimmed = entry.strip_suffix('/').unwrap_or(&entry);
            let name = trimmed.rsplit('/').next().unwrap_or("");
            R2Folder {
                name: if name.is_empty() {
                    "(empty)".to_string()
                } else {
                    name.to_string()
                },
                prefix: entry,
            }
        })
        .collect();
    folders.sort_by(|a, b| a.name.cmp(&b.name));

    let mut objects = Vec::new();
    for object in page.objects {
        if object.key.ends_with('/') {
            continue;
        }
        let name = object.key.rsplit('/').next().unwrap_or("").to_string();
        let uploaded = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(object.uploaded)
            .context("celld r2 list answered an out-of-range upload time")?;
        objects.push(R2Object {
            key: object.key,
            name,
            size: i64::try_from(object.size).unwrap_or(i64::MAX),
            last_modified: uploaded.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            content_type: object.http_metadata.content_type,
            etag: object.etag,
        });
    }
    objects.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(R2Preview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        bucket: bucket.to_string(),
        prefix: prefix.to_string(),
        folders,
        objects,
        next_cursor: if page.truncated { page.cursor } else { None },
    })
}

/// One page of a bucket folder: the keys below `/` roll up into
/// `delimitedPrefixes`, the files in the folder answer with their content
/// types, and the answered `cursor` continues a truncated page past exactly
/// what it consumed.
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
    let fleet = fleet_args(app, cfg);
    let limit_arg = limit.clamp(1, R2_PAGE_LIMIT).to_string();
    let mut args: Vec<&str> = vec![
        "r2",
        "list",
        bucket,
        "--delimiter",
        "/",
        "--page",
        "--limit",
        &limit_arg,
    ];
    if !prefix.is_empty() {
        args.push("--prefix");
        args.push(&prefix);
    }
    if let Some(token) = cursor {
        args.push("--cursor");
        args.push(token);
    }
    args.extend(fleet);
    let out = run_celld(cfg, app, &args, CELD_TIMEOUT).await?;
    let page: CelldPage = serde_json::from_str(&out).context("parse celld r2 list --page")?;
    shape_page(app, bucket, &prefix, page)
}

/// One object record as `celld r2 head --json` reports it: the size (a
/// single-key lookup has no listing) and the real `content-type` header the
/// record carries.
struct R2Head {
    size: u64,
    content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CelldHead {
    size: u64,
    #[serde(default)]
    http: CelldHttp,
}

/// The record for one key, or the not-found bail the service maps to 404.
/// A missing key prints the not-found object on stdout with exit 1; the
/// runner keeps the old `object not found` bail, detected from the
/// object's error field instead of the English stderr.
async fn r2_head(cfg: &Config, app: &App, bucket: &str, key: &str) -> anyhow::Result<R2Head> {
    let fleet = fleet_args(app, cfg);
    let mut args: Vec<&str> = vec!["r2", "head", bucket, key, "--json"];
    args.extend(fleet);
    let output = run_celld_output(cfg, app, &args, None, CELD_TIMEOUT).await?;
    if output.status.success() {
        let out = String::from_utf8_lossy(&output.stdout);
        let head: CelldHead = serde_json::from_str(&out).context("parse celld r2 head --json")?;
        return Ok(R2Head {
            size: head.size,
            content_type: head.http.content_type,
        });
    }
    if is_not_found(&output.stdout) {
        anyhow::bail!("object not found")
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let out = String::from_utf8_lossy(&output.stdout);
    anyhow::bail!(
        "{} {:?} exit {:?}\n{err}{out}",
        cfg.celld_bin,
        args,
        output.status.code()
    )
}

/// One object's bytes, or the not-found bail when a racing delete removed
/// the key between the head and the read. `--json` leaves a found key's
/// bytes untouched; a missing key prints the not-found object instead.
async fn r2_get_bytes(cfg: &Config, app: &App, bucket: &str, key: &str) -> anyhow::Result<Vec<u8>> {
    let fleet = fleet_args(app, cfg);
    let mut args: Vec<&str> = vec!["r2", "get", bucket, key, "--json"];
    args.extend(fleet);
    let output = run_celld_output(cfg, app, &args, Some(&[]), CELD_UPLOAD_TIMEOUT).await?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    if is_not_found(&output.stdout) {
        anyhow::bail!("object not found")
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let out = String::from_utf8_lossy(&output.stdout);
    anyhow::bail!(
        "{} {:?} exit {:?}\n{err}{out}",
        cfg.celld_bin,
        args,
        output.status.code()
    )
}

/// Download one object's bytes (capped) and the media type to re-serve it.
pub async fn r2_raw(cfg: &Config, app: &App, bucket: &str, key: &str) -> anyhow::Result<R2Raw> {
    if !r2_key_ok(key) {
        anyhow::bail!("invalid key");
    }
    let head = r2_head(cfg, app, bucket, key).await?;
    if head.size > R2_RAW_CAP as u64 {
        anyhow::bail!("object too large to download");
    }
    let bytes = r2_get_bytes(cfg, app, bucket, key).await?;
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
    let head = r2_head(cfg, app, bucket, key).await?;
    let bytes = r2_get_bytes(cfg, app, bucket, key).await?;
    let truncated = bytes.len() > R2_PREVIEW_CAP;
    let preview = &bytes[..bytes.len().min(R2_PREVIEW_CAP)];
    Ok(R2File {
        key: key.to_string(),
        size: i64::try_from(head.size).unwrap_or(i64::MAX),
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
    run_celld(cfg, app, &args, CELD_UPLOAD_TIMEOUT).await?;
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
    run_celld(cfg, app, &args, CELD_TIMEOUT).await?;
    Ok(keys.len())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::models::{AppStatus, DesiredState};

    fn test_app() -> App {
        App {
            id: "app-r2".into(),
            slug: "r2app".into(),
            name: "r2app".into(),
            user_id: "local".into(),
            status: AppStatus::Running,
            subdomain: "r2app.localhost".into(),
            git_prefix: "git/r2app".into(),
            fleet_bucket: "s3://noite/fleets/r2app".into(),
            listen_port: None,
            internal_port: None,
            last_deploy_sha: None,
            last_error: None,
            desired_state: DesiredState::Running,
            created_at: "t".into(),
            updated_at: "t".into(),
            asleep_since: None,
            woke_at: None,
            deployed_config: None,
            import_source: None,
            imported: false,
            fleet_hold: None,
            auto_deploy: crate::models::AutoDeploy::Eligible,
        }
    }

    /// A fake `celld`: appends its argv to `invocations.log`, fails once
    /// when `fail-next` exists (file content to stderr, exit 1), and
    /// otherwise answers `list`/`head` from `<verb>.json` and `get` from
    /// `body.bin`. Fixtures live next to the script so no env injection is
    /// needed — the runner clears the environment it spawns with.
    struct FakeCelld {
        dir: PathBuf,
    }

    /// The committed fake script every R2 seam test links to.
    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-celld-r2.sh")
    }

    impl FakeCelld {
        fn spawn() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("noite-fake-r2-celld-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            // A symlink to the committed script, never a fresh file:
            // exec'ing freshly-written files under parallel load
            // spuriously fails with ETXTBSY, while the committed inode
            // stays stable.
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(fixture(), dir.join("celld")).unwrap();
            }
            #[cfg(not(unix))]
            {
                std::fs::copy(fixture(), dir.join("celld")).unwrap();
            }
            Self { dir }
        }

        fn cfg(&self) -> Config {
            let mut cfg = crate::config::config_for_tests();
            cfg.celld_bin = self.dir.join("celld").to_string_lossy().into_owned();
            cfg
        }

        fn write(&self, name: &str, bytes: &[u8]) {
            std::fs::write(self.dir.join(name), bytes).unwrap();
        }

        fn fail_next(&self, message: &str) {
            self.write("fail-next", message.as_bytes());
        }

        fn fail_next_stdout(&self, bytes: &[u8]) {
            self.write("fail-next-stdout", bytes);
        }

        fn invocations(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.join("invocations.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    impl Drop for FakeCelld {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The root page a real fork binary answered (shape captured from
    /// 0.6.3-ryuzcorp.6): folders roll up sorted by name, files carry
    /// their content types, the folder marker answers as an object and is
    /// dropped, and a complete page carries no cursor.
    #[test]
    fn page_shapes_folders_files_and_content_types() {
        let page: CelldPage = serde_json::from_str(
            r#"{"delimitedPrefixes":["photos/","dir/","a/"],"objects":[
{"key":"top.txt","size":6,"etag":"\"abc\"","uploaded":1767225600000,"httpMetadata":{"contentType":"text/plain"},"customMetadata":{}},
{"key":"photos/","size":0,"etag":"\"d41\"","uploaded":1767225600000,"httpMetadata":{},"customMetadata":{}},
{"key":"bin.dat","size":9,"etag":null,"uploaded":1767225601000,"httpMetadata":{},"customMetadata":{}}
],"truncated":false}"#,
        )
        .unwrap();
        let preview = shape_page(&test_app(), "uploads", "", page).unwrap();
        let names: Vec<String> = preview
            .folders
            .iter()
            .map(|folder| folder.name.clone())
            .collect();
        assert_eq!(names, ["a", "dir", "photos"]);
        assert_eq!(preview.folders[0].prefix, "a/");
        let keys: Vec<String> = preview
            .objects
            .iter()
            .map(|object| object.key.clone())
            .collect();
        assert_eq!(keys, ["bin.dat", "top.txt"]);
        assert_eq!(preview.objects[1].name, "top.txt");
        assert_eq!(preview.objects[1].size, 6);
        assert_eq!(
            preview.objects[1].content_type.as_deref(),
            Some("text/plain")
        );
        assert_eq!(preview.objects[1].etag.as_deref(), Some("\"abc\""));
        assert_eq!(preview.objects[1].last_modified, "2026-01-01T00:00:00.000Z");
        assert_eq!(preview.objects[0].content_type, None);
        assert_eq!(preview.objects[0].etag, None);
        assert_eq!(preview.objects[0].last_modified, "2026-01-01T00:00:01.000Z");
        assert_eq!(preview.next_cursor, None);
    }

    /// The truncated shape (`--limit 2` against the real binary): the
    /// cursor is in-band only while the page is truncated.
    #[test]
    fn truncated_page_carries_its_cursor() {
        let page: CelldPage = serde_json::from_str(
            r#"{"delimitedPrefixes":["a/","dir/"],"objects":[],"truncated":true,"cursor":"dir/hello.txt"}"#,
        )
        .unwrap();
        let preview = shape_page(&test_app(), "uploads", "", page).unwrap();
        assert_eq!(preview.next_cursor.as_deref(), Some("dir/hello.txt"));
    }

    /// The `a/` listing answers the empty segment as the `a//` prefix,
    /// which keeps its old label.
    #[test]
    fn empty_segment_prefix_browses_as_empty() {
        let page: CelldPage =
            serde_json::from_str(r#"{"delimitedPrefixes":["a//"],"objects":[],"truncated":false}"#)
                .unwrap();
        let preview = shape_page(&test_app(), "uploads", "a/", page).unwrap();
        assert_eq!(preview.folders.len(), 1);
        assert_eq!(preview.folders[0].name, "(empty)");
        assert_eq!(preview.folders[0].prefix, "a//");
        assert!(preview.objects.is_empty());
        assert_eq!(preview.prefix, "a/");
    }

    /// A listing runs exactly the fork's spelling: delimiter, page shape,
    /// limit and prefix, with the fleet's bucket and endpoint — and the
    /// answered page shapes into folders, files and no cursor.
    #[tokio::test]
    async fn list_shells_out_to_celld_r2_list() {
        let fake = FakeCelld::spawn();
        fake.write(
            "list.json",
            br#"{"delimitedPrefixes":["dir/"],"objects":[{"key":"top.txt","size":6,"etag":null,"uploaded":1767225600000,"httpMetadata":{"contentType":"text/plain"}}],"truncated":false}"#,
        );
        let preview = r2_list(&fake.cfg(), &test_app(), "uploads", "", None, 100)
            .await
            .unwrap();
        assert_eq!(preview.objects.len(), 1);
        assert_eq!(
            preview.objects[0].content_type.as_deref(),
            Some("text/plain")
        );
        assert_eq!(preview.folders.len(), 1);
        assert_eq!(preview.next_cursor, None);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(
            calls[0].starts_with("r2 list uploads --delimiter / --page --limit 100"),
            "{calls:?}"
        );
        assert!(
            calls[0].contains("--bucket s3://noite/fleets/r2app"),
            "{calls:?}"
        );
        assert!(
            calls[0].contains("--endpoint http://rustfs:9000"),
            "{calls:?}"
        );
        assert!(!calls[0].contains("--prefix"), "{calls:?}");
        assert!(!calls[0].contains("--cursor"), "{calls:?}");
    }

    /// Prefix navigation and paging ride on `--prefix`/`--cursor`: the
    /// second page is asked for the cursor the first one answered.
    #[tokio::test]
    async fn list_pages_with_prefix_and_cursor() {
        let fake = FakeCelld::spawn();
        fake.write(
            "list.json",
            br#"{"delimitedPrefixes":[],"objects":[{"key":"dir/a.txt","size":1,"etag":null,"uploaded":1767225600000,"httpMetadata":{}}],"truncated":true,"cursor":"dir/a.txt"}"#,
        );
        let first = r2_list(&fake.cfg(), &test_app(), "uploads", "dir/", None, 1)
            .await
            .unwrap();
        assert_eq!(first.prefix, "dir/");
        assert_eq!(first.next_cursor.as_deref(), Some("dir/a.txt"));
        fake.write(
            "list.json",
            br#"{"delimitedPrefixes":[],"objects":[{"key":"dir/b.txt","size":2,"etag":null,"uploaded":1767225600000,"httpMetadata":{}}],"truncated":false}"#,
        );
        let second = r2_list(
            &fake.cfg(),
            &test_app(),
            "uploads",
            "dir/",
            first.next_cursor.as_deref(),
            1,
        )
        .await
        .unwrap();
        assert_eq!(second.objects[0].key, "dir/b.txt");
        assert_eq!(second.next_cursor, None);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(calls[0].contains("--prefix dir/"), "{calls:?}");
        assert!(calls[0].contains("--limit 1"), "{calls:?}");
        assert!(calls[1].contains("--cursor dir/a.txt"), "{calls:?}");
    }

    #[tokio::test]
    async fn invalid_prefix_bails_before_spawning() {
        let fake = FakeCelld::spawn();
        let error = r2_list(&fake.cfg(), &test_app(), "uploads", "../", None, 100)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("invalid prefix"));
        assert!(fake.invocations().is_empty());
    }

    /// A preview is a head for the record plus a get for the bytes.
    #[tokio::test]
    async fn get_returns_preview_and_content_type() {
        let fake = FakeCelld::spawn();
        fake.write(
            "head.json",
            br#"{"key":"dir/a.txt","size":6,"etag":"\"abc\"","uploaded":1767225600000,"http":{"contentType":"text/plain"},"custom":{}}"#,
        );
        fake.write("body.bin", b"hello\n");
        let file = r2_get(&fake.cfg(), &test_app(), "uploads", "dir/a.txt")
            .await
            .unwrap();
        assert_eq!(file.size, 6);
        assert_eq!(file.content_type.as_deref(), Some("text/plain"));
        assert_eq!(file.text.as_deref(), Some("hello\n"));
        assert!(!file.truncated);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert!(
            calls[0].starts_with("r2 head uploads dir/a.txt --json"),
            "{calls:?}"
        );
        assert!(
            calls[1].starts_with("r2 get uploads dir/a.txt --json"),
            "{calls:?}"
        );
    }

    #[tokio::test]
    async fn get_reports_binary_bodies_as_no_text() {
        let fake = FakeCelld::spawn();
        fake.write("head.json", br#"{"key":"bin.dat","size":3,"http":{}}"#);
        fake.write("body.bin", &[0xff, 0xfe, 0x00]);
        let file = r2_get(&fake.cfg(), &test_app(), "uploads", "bin.dat")
            .await
            .unwrap();
        assert_eq!(file.size, 3);
        assert_eq!(file.text, None);
        assert_eq!(file.content_type, None);
    }

    #[tokio::test]
    async fn raw_serves_bytes_and_refuses_over_the_cap() {
        let fake = FakeCelld::spawn();
        fake.write(
            "head.json",
            br#"{"key":"logo.png","size":4,"http":{"contentType":"image/png"}}"#,
        );
        fake.write("body.bin", &[0x89, b'P', b'N', b'G']);
        let raw = r2_raw(&fake.cfg(), &test_app(), "uploads", "logo.png")
            .await
            .unwrap();
        assert_eq!(raw.bytes, vec![0x89, b'P', b'N', b'G']);
        assert_eq!(raw.content_type.as_deref(), Some("image/png"));

        fake.write(
            "head.json",
            format!(
                r#"{{"key":"huge.bin","size":{},"http":{{}}}}"#,
                R2_RAW_CAP + 1
            )
            .as_bytes(),
        );
        let error = r2_raw(&fake.cfg(), &test_app(), "uploads", "huge.bin")
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("object too large"));
        // The refused key never downloads: two heads and one get.
        assert_eq!(fake.invocations().len(), 3);
    }

    /// A missing key prints the not-found object on stdout with exit 1;
    /// the runner keeps the old `object not found` the service maps to
    /// 404, detected from the object's error field — the English stderr
    /// is gone from the matching entirely.
    #[tokio::test]
    async fn missing_keys_read_as_not_found() {
        let fake = FakeCelld::spawn();
        fake.fail_next_stdout(br#"{"error":"not_found","bucket":"uploads","key":"gone.txt"}"#);
        let error = r2_get(&fake.cfg(), &test_app(), "uploads", "gone.txt")
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("object not found"),
            "{error:#}"
        );
        fake.fail_next_stdout(br#"{"error":"not_found","bucket":"uploads","key":"gone.txt"}"#);
        let error = r2_raw(&fake.cfg(), &test_app(), "uploads", "gone.txt")
            .await
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("object not found"),
            "{error:#}"
        );
    }

    /// Anything without the not-found error field still fails loudly: a
    /// stderr-only failure and a foreign error object both propagate
    /// instead of reading as absent.
    #[tokio::test]
    async fn non_not_found_failures_propagate() {
        let fake = FakeCelld::spawn();
        fake.fail_next("Error: transport blew up");
        let error = r2_get(&fake.cfg(), &test_app(), "uploads", "gone.txt")
            .await
            .unwrap_err();
        assert!(
            !format!("{error:#}").contains("object not found"),
            "{error:#}"
        );
        assert!(
            format!("{error:#}").contains("transport blew up"),
            "{error:#}"
        );
        fake.fail_next_stdout(br#"{"error":"forbidden","bucket":"uploads","key":"gone.txt"}"#);
        let error = r2_get(&fake.cfg(), &test_app(), "uploads", "gone.txt")
            .await
            .unwrap_err();
        assert!(
            !format!("{error:#}").contains("object not found"),
            "{error:#}"
        );
    }

    #[test]
    fn not_found_matches_the_error_field_only() {
        assert!(is_not_found(
            br#"{"error":"not_found","bucket":"uploads","key":"gone.txt"}"#
        ));
        assert!(!is_not_found(br#"{"error":"forbidden"}"#));
        assert!(!is_not_found(br#"{"bucket":"uploads"}"#));
        assert!(!is_not_found(b"Error: no object \"gone.txt\""));
        assert!(!is_not_found(b""));
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

    #[test]
    fn nested_page_prefix_is_normalized() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("dir"), "dir/");
        assert_eq!(normalize_prefix("dir/"), "dir/");
    }
}
