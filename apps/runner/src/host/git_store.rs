//! S3 [`ObjectStore`](ryuz_git::store::ObjectStore) for the git WAL, over the
//! runner's native S3 transport (`host::s3`: rusty-s3 presigning + the one
//! pooled reqwest client).
//!
//! [`GitStore`] implements `ryuz_git`'s conditional object contract with
//! standard S3 conditional headers on presigned URLs:
//!
//! - `PutMode::Create` sends `If-None-Match: *`; `Update(version)` sends
//!   `If-Match: <etag>`. The ETag string is the store's own (S3 returns it
//!   quoted); it is stored verbatim in [`Version`](ryuz_git::store::Version)
//!   and sent back unchanged.
//! - `GetOptions::if_none_match` sends `If-None-Match` (304 becomes
//!   [`GetResult::NotModified`](ryuz_git::store::GetResult)), `if_match`
//!   sends `If-Match` (412 becomes `PreconditionFailed`), `range` sends a
//!   `Range` header (206 keeps the whole-object size).
//!
//! Failure mapping keeps "missing" and "unreachable" apart: 404 (or S3's
//! `NoSuchKey`) is [`StoreError::NotFound`](ryuz_git::store::StoreError),
//! transport errors, timeouts and 5xx are `Retryable`, everything else is
//! `Other`. A store that cannot be reached is therefore never reported as
//! "no manifest", so a WAL reader can never mistake an outage for a fresh
//! repository and restart its sequence.
//! [`build_wal`] builds the process's one WAL over this store: mirrors under
//! `<work>/git-http/{slug}.git` (the same canonical path the push-mirror
//! tests seed at), the `git/` layout (manifest `git/{slug}/MANIFEST.json`,
//! tip bundles `git/{slug}/{refname}/{sha}.bundle`), bundle storage, and the
//! preview-ref tracking/hiding the smart-HTTP adapter has always used, so
//! existing mirrors, manifests and tip bundles keep working unchanged.

use std::ops::Range;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt as _;
use rusty_s3::S3Action as _;
use ryuz_git::store::{
    BoxStream, ByteStream, DynStore, GetOptions, GetResult, ObjectMeta, ObjectStore, PutBody,
    PutMode, PutOptions, StoreError, Version,
};

use crate::config::Config;
use crate::host::{exec, s3};

/// The WAL handle every git flow shares.
pub type GitWal = ryuz_git::Wal<ryuz_git::RefsCodec>;

/// Build the process's git WAL over [`GitStore`].
///
/// Mirror root, layout and storage mode match what the smart-HTTP adapter has
/// always used, so existing mirrors, manifests and tip bundles keep working
/// unchanged. The retired `refs/previews/*` refs are no longer hidden here:
/// nothing lists or writes them, and source reads refuse them (`valid_ref`).
pub fn build_wal(cfg: &Config) -> GitWal {
    let store: DynStore = Arc::new(GitStore::new(cfg));
    let config = ryuz_git::WalConfig::new(
        exec::work_root(cfg).join("git-http"),
        ryuz_git::Layout::new("git"),
    )
    // The storage layer still recognizes the retired namespace so the boot
    // sweep can delete the refs an upgrade left (and so a manifest refresh
    // does not lose track of them before that); no writer creates them, pushes
    // to the namespace are denied, and Git never advertises it.
    .with_hidden_refs([crate::host::git_http::PREVIEW_REF_PREFIX.to_string()])
    .with_extra_ref_prefixes([crate::host::git_http::PREVIEW_REF_PREFIX.to_string()])
    .with_storage(ryuz_git::StorageMode::Bundle);
    GitWal::new(store, Arc::new(config), Arc::new(ryuz_git::RefsCodec))
}

/// `ryuz_git`'s object contract over the runner's S3 transport.
#[derive(Clone)]
pub struct GitStore {
    config: Arc<Config>,
}

impl GitStore {
    pub fn new(cfg: &Config) -> Self {
        Self {
            config: Arc::new(cfg.clone()),
        }
    }
}

/// Conditional request headers for one write: `If-None-Match: *` gates
/// creation, `If-Match: <etag>` gates a compare-and-swap update.
pub(crate) fn put_conditional_headers(
    mode: &PutMode,
) -> Vec<(reqwest::header::HeaderName, String)> {
    match mode {
        PutMode::Overwrite => Vec::new(),
        PutMode::Create => vec![(reqwest::header::IF_NONE_MATCH, "*".to_string())],
        PutMode::Update(version) => vec![(reqwest::header::IF_MATCH, version.as_str().to_string())],
    }
}

/// Conditional request headers for one read: `If-None-Match` is the cheap
/// freshness check (304), `If-Match` fails a stale read (412).
pub(crate) fn get_conditional_headers(
    opts: &GetOptions,
) -> Vec<(reqwest::header::HeaderName, String)> {
    let mut headers = Vec::new();
    if let Some(version) = &opts.if_none_match {
        headers.push((reqwest::header::IF_NONE_MATCH, version.as_str().to_string()));
    }
    if let Some(version) = &opts.if_match {
        headers.push((reqwest::header::IF_MATCH, version.as_str().to_string()));
    }
    headers
}

/// `Range` request header for a half-open byte range. Empty ranges fetch
/// whole and slice client-side: S3 answers `bytes=a-b` with `b < a` with 416.
pub(crate) fn range_header_value(range: &Range<u64>) -> Option<String> {
    if range.start < range.end {
        Some(format!("bytes={}-{}", range.start, range.end - 1))
    } else {
        None
    }
}

fn etag_of(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)?
        .to_str()
        .ok()
        .map(str::to_string)
}

/// Sentinel version for responses with neither ETag nor body (HEAD against
/// an ETag-less fake). Never compared against a real store's ETags.
fn no_etag_version() -> Version {
    Version::new("no-etag".to_string())
}

/// Parse a `Content-Range: bytes a-b/total` total; `None` when the header is
/// absent or malformed.
fn content_range_total(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    value.rsplit('/').next()?.parse().ok()
}

/// Classify a LIST failure: transport errors, timeouts and 5xx are retryable;
/// anything else (a refused credential, a missing bucket) is final. A failed
/// listing is never "missing".
fn list_error(err: anyhow::Error) -> StoreError {
    let msg = format!("{err:#}");
    if msg.contains("HTTP 5")
        || msg.contains("SlowDown")
        || msg.contains("timed out")
        || msg.contains("transport")
        || msg.contains("connection")
    {
        StoreError::Retryable(err)
    } else {
        StoreError::Other(err)
    }
}

/// Best-effort current ETag for a 412: the conflicting version, when the
/// store still serves the key. Never fails the caller.
async fn current_version(store: &GitStore, key: &str) -> Option<String> {
    store
        .head(key)
        .await
        .ok()?
        .map(|meta| meta.version.as_str().to_string())
}

/// One upload body, sized up front. Files stream from disk (a tip bundle can
/// be hundreds of MiB and the runner is memory-bounded); byte and stream
/// bodies are small and stay buffered so a declared-length mismatch is
/// rejected before anything reaches the store.
enum UploadBody {
    Body(reqwest::Body, u64),
}

/// A file upload streamed in 64 KiB chunks; the length comes from metadata so
/// `Content-Length` is exact and `size` is known without reading it.
fn file_body(path: std::path::PathBuf) -> Result<UploadBody, StoreError> {
    use tokio::io::AsyncReadExt as _;

    let file = std::fs::File::open(&path)
        .map_err(|e| StoreError::Other(anyhow::anyhow!("open upload body {path:?}: {e:#}")))?;
    let len = file
        .metadata()
        .map_err(|e| StoreError::Other(anyhow::anyhow!("stat upload body {path:?}: {e:#}")))?
        .len();
    let file = tokio::fs::File::from_std(file);
    let chunks = futures::stream::try_unfold(
        (file, vec![0u8; 64 * 1024]),
        |(mut file, mut buf)| async move {
            let read = file
                .read(&mut buf)
                .await
                .map_err(|e| StoreError::Other(anyhow::anyhow!("read upload body: {e:#}")))?;
            if read == 0 {
                return Ok(None);
            }
            Ok::<_, StoreError>(Some((Bytes::copy_from_slice(&buf[..read]), (file, buf))))
        },
    );
    Ok(UploadBody::Body(reqwest::Body::wrap_stream(chunks), len))
}

/// Buffer one byte/stream upload, enforcing a stream's declared length: a
/// mismatch never reaches the store.
async fn collect_body(body: PutBody) -> Result<UploadBody, StoreError> {
    match body {
        PutBody::Bytes(bytes) => {
            let len = bytes.len() as u64;
            Ok(UploadBody::Body(reqwest::Body::from(bytes), len))
        }
        PutBody::File(path) => file_body(path),
        PutBody::Stream { len, stream } => {
            let mut out = Vec::new();
            let mut stream = stream;
            while let Some(chunk) = stream.next().await {
                let chunk =
                    chunk.map_err(|e| StoreError::Other(anyhow::anyhow!("read stream: {e:#}")))?;
                out.extend_from_slice(&chunk);
                if out.len() as u64 > len {
                    return Err(StoreError::invalid(format!(
                        "stream body longer than declared {len} bytes"
                    )));
                }
            }
            if out.len() as u64 != len {
                return Err(StoreError::invalid(format!(
                    "stream body is {} bytes, declared {len}",
                    out.len()
                )));
            }
            Ok(UploadBody::Body(reqwest::Body::from(out), len))
        }
    }
}

fn retryable(context: &str, err: impl Into<anyhow::Error>) -> StoreError {
    StoreError::Retryable(anyhow::anyhow!("{context}: {:#}", err.into()))
}

#[async_trait::async_trait]
impl ObjectStore for GitStore {
    fn backend(&self) -> &'static str {
        "noite-s3"
    }

    async fn get(&self, key: &str, opts: GetOptions) -> Result<GetResult, StoreError> {
        let cfg = &self.config;
        let (handle, creds) = s3::s3_bucket(cfg, &cfg.s3_bucket).map_err(StoreError::Other)?;
        let url = handle
            .get_object(Some(&creds), key)
            .sign(Duration::from_secs(3600));
        let mut req = s3::http_client().get(url).timeout(Duration::from_secs(30));
        for (name, value) in get_conditional_headers(&opts) {
            req = req.header(name, value);
        }
        let empty_range = opts.range.as_ref().is_some_and(Range::is_empty);
        let ranged = opts.range.clone().filter(|range| !range.is_empty());
        if let Some(range) = ranged.as_ref().and_then(range_header_value) {
            req = req.header(reqwest::header::RANGE, range);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| retryable(&format!("s3 GET {key}"), e))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_MODIFIED {
            let version = opts.if_none_match.clone().unwrap_or_else(no_etag_version);
            return Ok(GetResult::NotModified { version });
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(StoreError::not_found(key));
        }
        if status == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(StoreError::precondition(key, etag_of(resp.headers())));
        }
        if !status.is_success() {
            if status.is_server_error() {
                return Err(retryable(
                    &format!("s3 GET {key} failed: HTTP {status}"),
                    anyhow::anyhow!("HTTP {status}"),
                ));
            }
            return Err(StoreError::Other(anyhow::anyhow!(
                "s3 GET {key} failed: HTTP {status}"
            )));
        }
        let headers = resp.headers().clone();
        let version = etag_of(&headers)
            .map(Version::new)
            .unwrap_or_else(|| opts.if_none_match.clone().unwrap_or_else(no_etag_version));
        // A store that ignores the conditionals still answers 200: enforce
        // the freshness check client-side so `get_if_changed` stays cheap.
        if let Some(known) = &opts.if_none_match {
            if &version == known {
                return Ok(GetResult::NotModified {
                    version: version.clone(),
                });
            }
        }
        let whole = content_range_total(&headers)
            .or_else(|| {
                headers
                    .get(reqwest::header::CONTENT_LENGTH)?
                    .to_str()
                    .ok()?
                    .parse()
                    .ok()
            })
            .unwrap_or(0);
        if empty_range {
            // S3 answers `bytes=a-b` with `b < a` with 416, so an empty
            // range is served without a Range header: no bytes, whole size.
            let meta = ObjectMeta {
                key: key.to_string(),
                size: whole,
                version,
                checksum: None,
            };
            let stream: ByteStream =
                Box::pin(futures::stream::once(async move { Ok(Bytes::new()) }));
            return Ok(GetResult::Object { meta, body: stream });
        }
        if ranged.is_some() && status != reqwest::StatusCode::PARTIAL_CONTENT {
            // The store ignored the Range header: buffer and slice. Whole
            // objects stream below; a ranged read against such a store pays
            // one buffered read.
            let body = resp
                .bytes()
                .await
                .map_err(|e| retryable(&format!("s3 GET {key} body"), e))?;
            let range = ranged.unwrap_or_default();
            let start = range.start.min(body.len() as u64) as usize;
            let end = range.end.min(body.len() as u64).max(range.start) as usize;
            let meta = ObjectMeta {
                key: key.to_string(),
                size: whole.max(body.len() as u64),
                version,
                checksum: None,
            };
            let stream: ByteStream =
                Box::pin(futures::stream::once(
                    async move { Ok(body.slice(start..end)) },
                ));
            return Ok(GetResult::Object { meta, body: stream });
        }
        let stream: ByteStream = Box::pin(resp.bytes_stream().map(|chunk| {
            chunk.map_err(|e| StoreError::Retryable(anyhow::anyhow!("s3 GET stream: {e:#}")))
        }));
        let meta = ObjectMeta {
            key: key.to_string(),
            size: whole,
            version,
            checksum: None,
        };
        Ok(GetResult::Object { meta, body: stream })
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        let cfg = &self.config;
        let (handle, creds) = s3::s3_bucket(cfg, &cfg.s3_bucket).map_err(StoreError::Other)?;
        let url = handle
            .head_object(Some(&creds), key)
            .sign(Duration::from_secs(300));
        let resp = s3::http_client()
            .head(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| retryable(&format!("s3 HEAD {key}"), e))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            if status.is_server_error() {
                return Err(retryable(
                    &format!("s3 HEAD {key} failed: HTTP {status}"),
                    anyhow::anyhow!("HTTP {status}"),
                ));
            }
            return Err(StoreError::Other(anyhow::anyhow!(
                "s3 HEAD {key} failed: HTTP {status}"
            )));
        }
        crate::host::stats::count_s3("head", 0, 0);
        let headers = resp.headers().clone();
        Ok(Some(ObjectMeta {
            key: key.to_string(),
            size: headers
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            version: etag_of(&headers)
                .map(Version::new)
                .unwrap_or_else(no_etag_version),
            checksum: None,
        }))
    }

    async fn put(
        &self,
        key: &str,
        body: PutBody,
        opts: PutOptions,
    ) -> Result<ObjectMeta, StoreError> {
        let UploadBody::Body(body, len) = collect_body(body).await?;
        let cfg = &self.config;
        let (handle, creds) = s3::s3_bucket(cfg, &cfg.s3_bucket).map_err(StoreError::Other)?;
        let url = handle
            .put_object(Some(&creds), key)
            .sign(Duration::from_secs(3600));
        let mut req = s3::http_client()
            .put(url)
            .timeout(Duration::from_secs(70))
            .header(reqwest::header::CONTENT_LENGTH, len);
        for (name, value) in put_conditional_headers(&opts.mode) {
            req = req.header(name, value);
        }
        if let Some(content_type) = opts.content_type {
            req = req.header(reqwest::header::CONTENT_TYPE, content_type);
        }
        let resp = req
            .body(body)
            .send()
            .await
            .map_err(|e| retryable(&format!("s3 PUT {key}"), e))?;
        let status = resp.status();
        if status == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(StoreError::precondition(
                key,
                current_version(self, key).await,
            ));
        }
        if !status.is_success() {
            if status.is_server_error() {
                return Err(retryable(
                    &format!("s3 PUT {key} failed: HTTP {status}"),
                    anyhow::anyhow!("HTTP {status}"),
                ));
            }
            return Err(StoreError::Other(anyhow::anyhow!(
                "s3 PUT {key} failed: HTTP {status}"
            )));
        }
        crate::host::stats::count_s3("upload", len, 0);
        let version = match etag_of(resp.headers()) {
            Some(etag) => Version::new(etag),
            // A store that omits ETag on PUT must still give the caller a
            // usable version for the next conditional write; ask HEAD rather
            // than inventing one (a wrong version would fail closed, but an
            // empty one would obscure the store's state).
            None => self
                .head(key)
                .await
                .map_err(|e| StoreError::Other(anyhow::anyhow!("HEAD after PUT {key}: {e:?}")))?
                .map(|meta| meta.version)
                .ok_or_else(|| {
                    StoreError::Other(anyhow::anyhow!(
                        "s3 PUT {key}: neither an ETag nor a readable object"
                    ))
                })?,
        };
        Ok(ObjectMeta {
            key: key.to_string(),
            size: len,
            version,
            checksum: None,
        })
    }

    async fn delete(&self, key: &str, if_version: Option<Version>) -> Result<(), StoreError> {
        if let Some(want) = &if_version {
            // Deterministic on every store, including ones that ignore
            // conditional headers: check-then-delete. The WAL holds the slug
            // lock across contested deletes, so no writer can interleave.
            match self.head(key).await? {
                None => return Err(StoreError::not_found(key)),
                Some(meta) if &meta.version != want => {
                    return Err(StoreError::precondition(
                        key,
                        Some(meta.version.as_str().to_string()),
                    ));
                }
                Some(_) => {}
            }
        }
        let cfg = &self.config;
        let (handle, creds) = s3::s3_bucket(cfg, &cfg.s3_bucket).map_err(StoreError::Other)?;
        let url = handle
            .delete_object(Some(&creds), key)
            .sign(Duration::from_secs(300));
        let mut req = s3::http_client()
            .delete(url)
            .timeout(Duration::from_secs(20));
        if let Some(want) = &if_version {
            req = req.header(reqwest::header::IF_MATCH, want.as_str());
        }
        let resp = req
            .send()
            .await
            .map_err(|e| retryable(&format!("s3 DELETE {key}"), e))?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND && if_version.is_none() {
            return Ok(());
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(StoreError::not_found(key));
        }
        if status == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(StoreError::precondition(
                key,
                current_version(self, key).await,
            ));
        }
        if !status.is_success() {
            if status.is_server_error() {
                return Err(retryable(
                    &format!("s3 DELETE {key} failed: HTTP {status}"),
                    anyhow::anyhow!("HTTP {status}"),
                ));
            }
            return Err(StoreError::Other(anyhow::anyhow!(
                "s3 DELETE {key} failed: HTTP {status}"
            )));
        }
        crate::host::stats::count_s3("delete", 0, 0);
        Ok(())
    }

    fn list(
        &self,
        prefix: &str,
        start_after: Option<&str>,
    ) -> BoxStream<'static, Result<ObjectMeta, StoreError>> {
        struct Cursor {
            store: GitStore,
            prefix: String,
            start_after: Option<String>,
            continuation: Option<String>,
            buffered: std::vec::IntoIter<ObjectMeta>,
            done: bool,
        }
        let cursor = Cursor {
            store: self.clone(),
            prefix: prefix.to_string(),
            start_after: start_after.map(str::to_string),
            continuation: None,
            buffered: Vec::new().into_iter(),
            done: false,
        };
        Box::pin(futures::stream::unfold(cursor, |mut cursor| async move {
            loop {
                if let Some(meta) = cursor.buffered.next() {
                    return Some((Ok(meta), cursor));
                }
                if cursor.done {
                    return None;
                }
                let bucket = cursor.store.config.s3_bucket.clone();
                let page = s3::s3_list_page(
                    &cursor.store.config,
                    &bucket,
                    &cursor.prefix,
                    None,
                    1000,
                    cursor.continuation.clone().as_deref(),
                )
                .await;
                match page {
                    Err(e) => {
                        cursor.done = true;
                        return Some((Err(list_error(e)), cursor));
                    }
                    Ok(page) => {
                        cursor.continuation = page.next;
                        if cursor.continuation.is_none() {
                            cursor.done = true;
                        }
                        let mut metas: Vec<ObjectMeta> = page
                            .objects
                            .into_iter()
                            .filter(|object| {
                                cursor
                                    .start_after
                                    .as_deref()
                                    .is_none_or(|after| object.key.as_str() > after)
                            })
                            .map(|object| ObjectMeta {
                                key: object.key,
                                size: object.size,
                                version: Version::new(object.etag),
                                checksum: None,
                            })
                            .collect();
                        metas.sort_by(|left, right| left.key.cmp(&right.key));
                        cursor.buffered = metas.into_iter();
                    }
                }
            }
        }))
    }

    async fn list_prefixes(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        let bucket = self.config.s3_bucket.clone();
        let json = s3::s3_list_delimited(&self.config, &bucket, prefix)
            .await
            .map_err(list_error)?;
        let value: serde_json::Value =
            serde_json::from_str(&json).map_err(|e| StoreError::Other(e.into()))?;
        let prefixes = value
            .get("CommonPrefixes")
            .and_then(|prefixes| prefixes.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|entry| entry.get("Prefix")?.as_str().map(str::to_string))
            .collect();
        Ok(prefixes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use axum::{
        body::Bytes as AxumBytes,
        extract::{Path as AxumPath, Query as AxumQuery, State as AxumState},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::get,
    };
    use tokio::sync::Mutex;

    /// In-memory S3 fake with real conditional semantics: content-hash ETags,
    /// `If-Match`/`If-None-Match` enforcement, byte ranges, and paginated
    /// listings. The forge fake answers every write with blind success; this
    /// one answers like a store, so the contract suite means something.
    type FakeObjects = Arc<Mutex<HashMap<String, (Bytes, String)>>>;

    fn fake_etag(body: &[u8]) -> String {
        use sha2::Digest as _;
        let mut hasher = sha2::Sha256::new();
        hasher.update(body);
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(digest.len() * 2 + 2);
        hex.push('"');
        for byte in digest {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex.push('"');
        hex
    }

    fn match_header(headers: &HeaderMap, name: &str) -> Option<String> {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    }

    async fn put_object(
        AxumState(store): AxumState<FakeObjects>,
        AxumPath((bucket, key)): AxumPath<(String, String)>,
        headers: HeaderMap,
        body: AxumBytes,
    ) -> Response {
        let full = format!("{bucket}/{key}");
        let mut store = store.lock().await;
        if match_header(&headers, "if-none-match").as_deref() == Some("*")
            && store.contains_key(&full)
        {
            return (StatusCode::PRECONDITION_FAILED, "exists").into_response();
        }
        if let Some(want) = match_header(&headers, "if-match") {
            if store.get(&full).map(|(_, etag)| etag) != Some(&want) {
                return (StatusCode::PRECONDITION_FAILED, "stale").into_response();
            }
        }
        let etag = fake_etag(&body);
        store.insert(full, (Bytes::from(body.to_vec()), etag.clone()));
        ([("etag", etag)], StatusCode::OK).into_response()
    }

    async fn get_object(
        AxumState(store): AxumState<FakeObjects>,
        AxumPath((bucket, key)): AxumPath<(String, String)>,
        headers: HeaderMap,
    ) -> Response {
        let full = format!("{bucket}/{key}");
        let store = store.lock().await;
        let Some((body, etag)) = store.get(&full) else {
            return (
                StatusCode::NOT_FOUND,
                "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
            )
                .into_response();
        };
        if let Some(want) = match_header(&headers, "if-match") {
            if &want != etag {
                return (StatusCode::PRECONDITION_FAILED, "stale").into_response();
            }
        }
        if let Some(known) = match_header(&headers, "if-none-match") {
            if &known == etag {
                return (StatusCode::NOT_MODIFIED, [("etag", etag.clone())]).into_response();
            }
        }
        let total = body.len();
        if let Some(range) = match_header(&headers, "range") {
            let range = range.strip_prefix("bytes=").unwrap_or("");
            let (start, end) = range.split_once('-').unwrap_or(("0", "0"));
            let (Ok(start), Ok(end)) = (start.parse::<usize>(), end.parse::<usize>()) else {
                return (StatusCode::RANGE_NOT_SATISFIABLE, "bad range").into_response();
            };
            if start >= total || end < start {
                return (StatusCode::RANGE_NOT_SATISFIABLE, "bad range").into_response();
            }
            let end = end.min(total - 1);
            let slice = body.slice(start..=end);
            return (
                StatusCode::PARTIAL_CONTENT,
                [
                    ("etag", etag.clone()),
                    ("content-range", format!("bytes {start}-{end}/{total}")),
                ],
                slice.to_vec(),
            )
                .into_response();
        }
        (
            StatusCode::OK,
            [
                ("etag", etag.clone()),
                ("content-length", total.to_string()),
            ],
            body.to_vec(),
        )
            .into_response()
    }

    async fn delete_object(
        AxumState(store): AxumState<FakeObjects>,
        AxumPath((bucket, key)): AxumPath<(String, String)>,
        headers: HeaderMap,
    ) -> Response {
        let full = format!("{bucket}/{key}");
        let mut store = store.lock().await;
        if let Some(want) = match_header(&headers, "if-match") {
            if store.get(&full).map(|(_, etag)| etag) != Some(&want) {
                return (StatusCode::PRECONDITION_FAILED, "stale or missing").into_response();
            }
        }
        store.remove(&full);
        StatusCode::NO_CONTENT.into_response()
    }

    async fn list_objects(
        AxumState(store): AxumState<FakeObjects>,
        AxumPath(bucket): AxumPath<String>,
        AxumQuery(query): AxumQuery<HashMap<String, String>>,
    ) -> Response {
        let prefix = query.get("prefix").cloned().unwrap_or_default();
        let delimiter = query.get("delimiter").cloned().unwrap_or_default();
        let start_after = query.get("start-after").cloned().unwrap_or_default();
        let max_keys: usize = query
            .get("max-keys")
            .and_then(|value| value.parse().ok())
            .unwrap_or(1000)
            .max(1);
        let offset: usize = query
            .get("continuation-token")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        // Tiny pages so the adapter's continuation loop is always exercised.
        let max_keys = max_keys.min(2);
        let store = store.lock().await;
        let mut keys: Vec<&str> = store
            .keys()
            .filter_map(|full| full.strip_prefix(&format!("{bucket}/")))
            .filter(|key| key.starts_with(prefix.as_str()))
            .filter(|key| *key > start_after.as_str())
            .collect();
        keys.sort();
        let total = keys.len();
        let end = (offset + max_keys).min(total);
        let page = &keys[offset.min(total)..end];
        let mut prefixes: Vec<String> = Vec::new();
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
             <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        xml.push_str(&format!(
            "<Name>{bucket}</Name><Prefix>{prefix}</Prefix>\
             <KeyCount>{}</KeyCount><MaxKeys>{max_keys}</MaxKeys>",
            page.len()
        ));
        for key in page {
            if !delimiter.is_empty() {
                if let Some(rest) = key.strip_prefix(prefix.as_str()) {
                    if let Some((head, _)) = rest.split_once(&delimiter) {
                        let child = format!("{prefix}{head}{delimiter}");
                        if !prefixes.contains(&child) {
                            prefixes.push(child);
                        }
                        continue;
                    }
                }
            }
            let full = format!("{bucket}/{key}");
            let (body, etag) = &store[&full];
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key>\
                 <LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                 <ETag>{etag}</ETag><Size>{}</Size>\
                 <StorageClass>STANDARD</StorageClass></Contents>",
                body.len()
            ));
        }
        if end < total {
            xml.push_str(&format!(
                "<IsTruncated>true</IsTruncated><NextContinuationToken>{end}</NextContinuationToken>"
            ));
        } else {
            xml.push_str("<IsTruncated>false</IsTruncated>");
        }
        for child in prefixes {
            xml.push_str(&format!(
                "<CommonPrefixes><Prefix>{child}</Prefix></CommonPrefixes>"
            ));
        }
        xml.push_str("</ListBucketResult>");
        (StatusCode::OK, xml).into_response()
    }

    async fn spawn_fake_s3() -> (String, FakeObjects) {
        let store: FakeObjects = Arc::new(Mutex::new(HashMap::new()));
        let bucket_routes = get(list_objects);
        let app = axum::Router::new()
            .route("/{bucket}", bucket_routes.clone())
            .route("/{bucket}/", bucket_routes)
            .route(
                "/{bucket}/{*key}",
                get(get_object).put(put_object).delete(delete_object),
            )
            .with_state(store.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fake s3");
        let addr = listener.local_addr().expect("fake s3 addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), store)
    }

    fn test_config(endpoint: &str) -> Config {
        let mut cfg = crate::config::config_for_tests();
        cfg.s3_endpoint = endpoint.to_string();
        cfg.s3_public_endpoint = endpoint.to_string();
        cfg.s3_bucket = "git-store-test".to_string();
        cfg
    }

    #[test]
    fn create_sends_if_none_match_star() {
        let headers = put_conditional_headers(&PutMode::Create);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, reqwest::header::IF_NONE_MATCH);
        assert_eq!(headers[0].1, "*");
    }

    #[test]
    fn update_sends_if_match_with_the_store_etag_verbatim() {
        let version = Version::new("\"abc123\"");
        let headers = put_conditional_headers(&PutMode::Update(version));
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, reqwest::header::IF_MATCH);
        assert_eq!(headers[0].1, "\"abc123\"");
    }

    #[test]
    fn overwrite_sends_no_conditionals() {
        assert!(put_conditional_headers(&PutMode::Overwrite).is_empty());
    }

    #[test]
    fn range_header_covers_the_half_open_interval() {
        assert_eq!(range_header_value(&(6..11)).as_deref(), Some("bytes=6-10"));
        assert_eq!(range_header_value(&(0..1)).as_deref(), Some("bytes=0-0"));
        // Empty ranges fetch whole and slice client-side (S3 answers 416).
        assert_eq!(range_header_value(&(5..5)), None);
    }

    #[test]
    fn get_headers_carry_both_conditionals_verbatim() {
        let opts = GetOptions {
            if_none_match: Some(Version::new("\"one\"")),
            if_match: Some(Version::new("\"two\"")),
            range: None,
        };
        let headers = get_conditional_headers(&opts);
        assert_eq!(headers.len(), 2);
        assert!(headers.contains(&(reqwest::header::IF_NONE_MATCH, "\"one\"".to_string())));
        assert!(headers.contains(&(reqwest::header::IF_MATCH, "\"two\"".to_string())));
    }

    #[tokio::test]
    async fn store_contract_against_the_conditional_fake() {
        let (endpoint, _store) = spawn_fake_s3().await;
        let store = GitStore::new(&test_config(&endpoint));
        ryuz_git::store::contract::run(&store, "contract/").await;
    }

    /// Live conformance against RustFS (the e2e lane). Opt-in: only runs
    /// when `NOITE_LIVE_S3` names the endpoint; credentials and bucket come
    /// from the usual `AWS_*`/`NOITE_S3_BUCKET` environment.
    #[tokio::test]
    async fn store_contract_against_live_s3() {
        let endpoint = std::env::var("NOITE_LIVE_S3").unwrap_or_default();
        if endpoint.trim().is_empty() {
            eprintln!("skipping live S3 contract (NOITE_LIVE_S3 is unset)");
            return;
        }
        let mut cfg = crate::config::config_for_tests();
        cfg.s3_endpoint = endpoint.clone();
        cfg.s3_public_endpoint = endpoint;
        if let Ok(bucket) = std::env::var("NOITE_S3_BUCKET") {
            if !bucket.trim().is_empty() {
                cfg.s3_bucket = bucket;
            }
        }
        if let Ok(key) = std::env::var("AWS_ACCESS_KEY_ID") {
            cfg.aws_access_key_id = key;
        }
        if let Ok(secret) = std::env::var("AWS_SECRET_ACCESS_KEY") {
            cfg.aws_secret_access_key = secret;
        }
        let store = GitStore::new(&cfg);
        let prefix = format!("git-store-live-{}/", std::process::id());
        ryuz_git::store::contract::run(&store, &prefix).await;
        use ryuz_git::store::ObjectStoreExt as _;
        let _ = store.delete_prefix(&prefix).await;
    }
}
