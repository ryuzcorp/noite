//! Native S3 client (T2.1): rusty-s3 signs requests, one pooled reqwest client
//! sends them. No Python interpreter per call; streaming bodies for bundles
//! and snapshots. The `s3_*` helpers keep their signatures so call sites don't
//! change; listings keep the aws CLI's JSON shape for the same reason.

use anyhow::{bail, Context};
use std::future::Future;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

use crate::config::Config;
use crate::host::exec::work_root;

/// True when an S3 error means "the object does not exist", as opposed
/// to the store being unreachable. Native failures carry `HTTP 404` plus the
/// store's `NoSuchKey` body, which the same matchers catch. Callers that
/// treat "missing" as "start fresh" must not do so on a transport error, or
/// they overwrite good state.
///
/// The matchers are status-anchored on purpose: the target key rides inside
/// the same message (`s3 download 404.html failed: HTTP 500 ...`), so a bare
/// `"404"` reads a transport failure on a numeric key as "missing". `(404)`
/// is the legacy aws-CLI shape (`An error occurred (404) ...`), kept so old
/// snapshots still count as absent.
pub fn is_not_found(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}");
    text.contains("HTTP 404")
        || text.contains("(404)")
        || text.contains("NoSuchKey")
        || text.contains("NoSuchBucket")
        || text.contains("NotFound")
}

pub fn aws_env(cfg: &Config) -> Vec<(&str, String)> {
    vec![
        ("AWS_ACCESS_KEY_ID", cfg.aws_access_key_id.clone()),
        ("AWS_SECRET_ACCESS_KEY", cfg.aws_secret_access_key.clone()),
        ("AWS_DEFAULT_REGION", cfg.aws_region.clone()),
        ("AWS_EC2_METADATA_DISABLED", "true".into()),
        ("AWS_MAX_ATTEMPTS", "2".into()),
    ]
}

/// Connection-pooled HTTP client shared by every S3 call: one pool for the
/// process instead of one Python heap per call.
// Static invariant: the default builder carries no fallible configuration —
// a failure here is a process-start condition, never request data.
static HTTP_CLIENT: std::sync::LazyLock<reqwest::Client> =
    std::sync::LazyLock::new(|| reqwest::Client::builder().build().expect("reqwest client"));

fn http_client() -> &'static reqwest::Client {
    &HTTP_CLIENT
}

/// Bucket handle for one call: path-style addressing (the bundled RustFS
/// answers path-style; virtual-host would need wildcard DNS) with the
/// endpoint, region and credentials the CLI used.
fn s3_bucket(cfg: &Config, bucket: &str) -> anyhow::Result<(Bucket, Credentials)> {
    let endpoint: reqwest::Url = cfg
        .s3_endpoint
        .parse()
        .with_context(|| format!("S3_ENDPOINT is not a URL: {}", cfg.s3_endpoint))?;
    let handle = Bucket::new(
        endpoint,
        UrlStyle::Path,
        bucket.to_string(),
        cfg.aws_region.clone(),
    )
    .context("S3 bucket handle")?;
    let creds = Credentials::new(
        cfg.aws_access_key_id.clone(),
        cfg.aws_secret_access_key.clone(),
    );
    Ok((handle, creds))
}

/// Rich S3 failure: HTTP status plus the store's XML error body.
/// [`is_not_found`] matches on the status-anchored `HTTP 404`/`NoSuchKey`, so
/// "missing" vs "unreachable" keeps working without knowing the transport.
async fn s3_err(op: &str, target: &str, resp: reqwest::Response) -> anyhow::Error {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    s3_err_msg(op, target, status, &body)
}

/// Same failure without the response: the retryable attempts classify before
/// they would consume the body, so the message is built from parts.
fn s3_err_msg(op: &str, target: &str, status: u16, body: &str) -> anyhow::Error {
    let snippet: String = body.trim().chars().take(300).collect();
    anyhow::anyhow!("s3 {op} {target} failed: HTTP {status} {snippet}")
}

/// How many times an idempotent S3 call is attempted before giving up.
const S3_MAX_ATTEMPTS: u32 = 3;

/// Backoff between S3 attempts: 250 ms doubling per failure plus up to one
/// base of jitter, so a rustfs restart does not get every caller retrying in
/// lockstep.
fn s3_retry_delay(failed: u32) -> Duration {
    let base_ms: u64 = 250 << failed.min(3);
    let jitter_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::from(d.subsec_nanos()) % (base_ms + 1))
        .unwrap_or(0);
    Duration::from_millis(base_ms + jitter_ms)
}

/// One S3 attempt's outcome. Only idempotent calls retry — GET, PUT of a full
/// key (an overwrite, never an append) and LIST — so a repeated attempt can
/// never duplicate or corrupt state.
enum S3Fail {
    /// Worth one more attempt: a 5xx, a SlowDown body, or a request that
    /// never reached the store.
    Retryable(anyhow::Error),
    /// Retrying cannot help: 4xx, auth, local disk, XML parse.
    Final(anyhow::Error),
}

/// Run `run` until it succeeds, fails finally, or exhausts
/// [`S3_MAX_ATTEMPTS`] on retryable errors. 4xx responses are never retried:
/// a missing key or a refused credential comes back identically every time.
async fn with_s3_retry<T, F, Fut>(op: &str, target: &str, mut run: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, S3Fail>>,
{
    let mut attempt: u32 = 0;
    loop {
        match run().await {
            Ok(value) => return Ok(value),
            Err(S3Fail::Final(e)) => return Err(e),
            Err(S3Fail::Retryable(e)) => {
                attempt += 1;
                if attempt >= S3_MAX_ATTEMPTS {
                    return Err(e);
                }
                tracing::debug!(op, target, attempt, error = %e, "s3 attempt failed; retrying");
                tokio::time::sleep(s3_retry_delay(attempt)).await;
            }
        }
    }
}

/// Classify a non-success status: 5xx and SlowDown may be retried, everything
/// else (including every other 4xx) is final.
fn classify_status(op: &str, target: &str, status: reqwest::StatusCode, body: &str) -> S3Fail {
    let err = s3_err_msg(op, target, status.as_u16(), body);
    if status.is_server_error() || body.contains("SlowDown") {
        S3Fail::Retryable(err)
    } else {
        S3Fail::Final(err)
    }
}

/// Split an `s3://bucket/key` URI (callers pass `cfg.s3_uri(key)` results).
fn split_uri(uri: &str) -> anyhow::Result<(&str, &str)> {
    let rest = uri
        .strip_prefix("s3://")
        .with_context(|| format!("not an S3 URI: {uri}"))?;
    let (bucket, key) = rest
        .split_once('/')
        .with_context(|| format!("S3 URI has no key: {uri}"))?;
    if key.is_empty() {
        bail!("S3 URI has no key: {uri}");
    }
    Ok((bucket, key))
}

/// How long a presigned URL stays valid. The signature is checked when the
/// request starts, so one generous value covers slow streaming uploads.
const PRESIGN_SECS: u64 = 3600;

pub async fn ensure_buckets(cfg: &Config) -> anyhow::Result<()> {
    // Readiness is "the endpoint answers a signed HEAD on the bucket with
    // any non-5xx status". A fresh install has no bucket yet (404) and a BYOB
    // key may lack HEAD rights (403): both mean S3 is up — the create +
    // required HEAD below decide the rest. Waiting for a 2xx here never
    // creates the bucket, so a fresh install could never boot (the e2e lane
    // caught it: `s3 not ready … after 60s` forever).
    let mut ready = false;
    for i in 0..60 {
        if s3_endpoint_up(cfg).await {
            ready = true;
            break;
        }
        if i == 0 || i % 10 == 9 {
            tracing::info!(attempt = i + 1, "waiting for s3");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if !ready {
        bail!("s3 not ready at {} after 60s", cfg.s3_endpoint);
    }

    let bucket = cfg.s3_bucket.as_str();
    // Idempotent create, best-effort like before: a 409 (already owned) or a
    // 403 (BYOB key without create permission on an existing bucket) is fine
    // as long as the required HEAD below passes.
    if let Err(e) = s3_create_bucket(cfg).await {
        tracing::warn!(bucket, error = %format!("{e:#}"), "s3 create-bucket not confirmed (non-fatal)");
    }
    if !s3_head_bucket(cfg).await {
        bail!("head-bucket {bucket}");
    }
    // Versioning is deliberately *suspended*, not enabled. It was meant to
    // protect MANIFEST.json + fleet state from overwrites, but celld rewrites
    // hot keys continuously and the accumulated history is what takes the
    // install down: this bucket reached 647 objects / 72,390 versions, after
    // which RustFS (rc.6 `ServiceUnavailable`, 1.0.0 `SlowDownRead`) refused
    // to list the prefixes a node validates at boot as soon as one page passed
    // ~100 keys — the control plane and every tenant fleet then died on
    // `bucket unavailable or inaccessible`. The identical keys in a
    // version-free bucket list fine, which is how that was pinned down.
    // Suspending stops new versions while keeping the property that a delete
    // really removes the key: celld's state is append-only per segment
    // (`ltx/<seq>-<seq>.ltx`) and revert is a sha redeploy, so overwrite
    // protection bought nothing here. Versions already written are expired by
    // the lifecycle rule below. Best-effort: BYOB keys are often scoped
    // without versioning permission.
    match put_bucket_versioning(cfg).await {
        Ok(()) => tracing::info!(bucket, "s3 versioning suspended"),
        Err(e) => {
            tracing::warn!(bucket, error = %format!("{e:#}"), "s3 versioning not set (non-fatal)")
        }
    }
    // Versioning on its own is unbounded: a celld node rewrites its keys
    // continuously, and this fleet bucket reached 72,390 versions for 647
    // objects within a day. At that size RustFS 1.0.0-rc.6 answers a *flat*
    // listing of the prefixes a node validates at boot (`control/`, `fleets/`)
    // with 503 ServiceUnavailable — 100 keys fine, 500 not — while still
    // reporting itself ready, so the control plane and every tenant fleet die
    // on `bucket unavailable or inaccessible`. Expire noncurrent versions to
    // keep the history bounded, and abort parts an interrupted deploy left
    // behind. Both Filter.Prefix and NoncurrentVersionExpiration are present
    // on purpose: RustFS panics evaluating a rule that omits either. The
    // current version is never expired — that is the fleet's live state.
    // Best-effort like the versioning call above: BYOB keys are often scoped
    // without lifecycle permission.
    match put_bucket_lifecycle(cfg).await {
        Ok(()) => tracing::info!(
            bucket,
            "s3 lifecycle: noncurrent versions expire after a day"
        ),
        Err(e) => {
            tracing::warn!(bucket, error = %format!("{e:#}"), "s3 lifecycle not set (non-fatal)")
        }
    }
    tracing::info!(bucket, "s3 bucket ready (prefixes git/, fleets/)");
    Ok(())
}

/// `HEAD /bucket` probe: true when the bucket exists and the key reaches it.
/// Used for readiness, the required head-bucket check, and `/ready`.
pub async fn s3_head_bucket(cfg: &Config) -> bool {
    let bucket = cfg.s3_bucket.clone();
    super::stats::count_s3("head", 0, 0);
    let Ok((handle, creds)) = s3_bucket(cfg, &bucket) else {
        return false;
    };
    let url = handle
        .head_bucket(Some(&creds))
        .sign(Duration::from_secs(300));
    let Ok(resp) = http_client()
        .head(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    else {
        return false;
    };
    resp.status().is_success()
}

/// Whether the S3 endpoint is serving: a signed HEAD on the bucket gets any
/// HTTP answer below 500 (2xx, 403, 404 all count). Network errors and 5xx
/// (a store still starting) do not.
async fn s3_endpoint_up(cfg: &Config) -> bool {
    let bucket = cfg.s3_bucket.clone();
    super::stats::count_s3("head", 0, 0);
    let Ok((handle, creds)) = s3_bucket(cfg, &bucket) else {
        return false;
    };
    let url = handle
        .head_bucket(Some(&creds))
        .sign(Duration::from_secs(300));
    let Ok(resp) = http_client()
        .head(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    else {
        return false;
    };
    !resp.status().is_server_error()
}

/// Idempotent bucket create. Outside `us-east-1` S3 requires the
/// `LocationConstraint` body the CLI used to send.
async fn s3_create_bucket(cfg: &Config) -> anyhow::Result<()> {
    let bucket = cfg.s3_bucket.clone();
    let (handle, creds) = s3_bucket(cfg, &bucket)?;
    let url = handle.create_bucket(&creds).sign(Duration::from_secs(300));
    let body = if cfg.aws_region == "us-east-1" {
        String::new()
    } else {
        format!(
            r#"<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>{}</LocationConstraint></CreateBucketConfiguration>"#,
            cfg.aws_region
        )
    };
    let resp = http_client()
        .put(url)
        .body(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .context("s3 CreateBucket")?;
    if resp.status().is_success() {
        return Ok(());
    }
    Err(s3_err("create-bucket", &bucket, resp).await)
}

/// SigV4 `Authorization` header for the bucket-config PUTs rusty-s3 has no
/// action for (versioning, lifecycle). Presigned URLs cannot carry a request
/// body portably, so these two calls sign the headers instead.
#[allow(clippy::too_many_arguments)]
fn sigv4_authorization(
    method: &str,
    canonical_uri: &str,
    canonical_qs: &str,
    canonical_headers: &str,
    signed_headers: &str,
    amz_date: &str,
    date_stamp: &str,
    region: &str,
    service: &str,
    payload_hash: &str,
    access_key: &str,
    secret_key: &str,
) -> String {
    use hmac::{Hmac, Mac};
    use sha2::{Digest, Sha256};
    let canonical_request = format!(
        "{method}\n{canonical_uri}\n{canonical_qs}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let scope = format!("{date_stamp}/{region}/{service}/aws4_request");
    let mut hasher = Sha256::new();
    hasher.update(canonical_request.as_bytes());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{:x}",
        hasher.finalize()
    );
    let sign = |key: &[u8], msg: &[u8]| {
        // Static invariant: HMAC accepts keys of any length, so construction never fails.
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
        mac.update(msg);
        mac.finalize().into_bytes().to_vec()
    };
    let k_date = sign(
        format!("AWS4{secret_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = sign(&k_date, region.as_bytes());
    let k_service = sign(&k_region, service.as_bytes());
    let k_signing = sign(&k_service, b"aws4_request");
    let signature: String = sign(&k_signing, string_to_sign.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// One header-signed PUT to `/{bucket}?{subresource}` (versioning/lifecycle).
async fn put_bucket_config(cfg: &Config, subresource: &str, body: &str) -> anyhow::Result<()> {
    use sha2::{Digest, Sha256};
    let endpoint: reqwest::Url = cfg
        .s3_endpoint
        .parse()
        .with_context(|| format!("S3_ENDPOINT is not a URL: {}", cfg.s3_endpoint))?;
    let host = endpoint.host_str().context("S3_ENDPOINT has no host")?;
    // The signed `host` must be what the client sends: bare host on default
    // ports, host:port otherwise (reqwest's own Host header matches this).
    let host_header = match endpoint.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    let payload_hash = format!("{:x}", hasher.finalize());
    let canonical_uri = format!("/{}", cfg.s3_bucket);
    let canonical_qs = format!("{subresource}=");
    let canonical_headers =
        format!("host:{host_header}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n");
    let auth = sigv4_authorization(
        "PUT",
        &canonical_uri,
        &canonical_qs,
        &canonical_headers,
        "host;x-amz-content-sha256;x-amz-date",
        &amz_date,
        &date_stamp,
        &cfg.aws_region,
        "s3",
        &payload_hash,
        &cfg.aws_access_key_id,
        &cfg.aws_secret_access_key,
    );
    let url = format!(
        "{}{canonical_uri}?{subresource}",
        cfg.s3_endpoint.trim_end_matches('/')
    );
    let resp = http_client()
        .put(url)
        .header("x-amz-date", amz_date)
        .header("x-amz-content-sha256", payload_hash)
        .header("Authorization", auth)
        .body(body.to_string())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .with_context(|| format!("s3 put-bucket-{subresource}"))?;
    if resp.status().is_success() {
        return Ok(());
    }
    Err(s3_err("put-bucket-config", subresource, resp).await)
}

async fn put_bucket_versioning(cfg: &Config) -> anyhow::Result<()> {
    put_bucket_config(
        cfg,
        "versioning",
        r#"<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>"#,
    )
    .await
}

async fn put_bucket_lifecycle(cfg: &Config) -> anyhow::Result<()> {
    // Same rule the CLI sent as JSON: noncurrent versions expire after a day,
    // abandoned multipart uploads abort. Filter.Prefix stays (empty): RustFS
    // panics evaluating a rule that omits it (see ensure_buckets).
    put_bucket_config(
        cfg,
        "lifecycle",
        r#"<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>noite-fleet-retention</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration><AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>"#,
    )
    .await
}

/// Stream one object to `dest` (bundles, snapshots, manifests). The body is
/// written chunk by chunk, never buffered whole.
///
/// Retried on 5xx/SlowDown/transport only, never on 4xx: a missing key comes
/// back identically every time, while one transient 503 used to fail the
/// whole deploy/restore/compaction.
async fn s3_get_to_file(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    dest: &Path,
    timeout: Duration,
) -> anyhow::Result<u64> {
    with_s3_retry("download", key, || {
        get_once(cfg, bucket_name, key, dest, timeout)
    })
    .await
}

async fn get_once(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    dest: &Path,
    timeout: Duration,
) -> Result<u64, S3Fail> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    let (handle, creds) = s3_bucket(cfg, bucket_name).map_err(S3Fail::Final)?;
    let url = handle
        .get_object(Some(&creds), key)
        .sign(Duration::from_secs(PRESIGN_SECS));
    let resp = match http_client()
        .get(url)
        .timeout(timeout)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            return Err(S3Fail::Retryable(anyhow::anyhow!(
                "s3 download {key} transport: {e:#}"
            )));
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_status("download", key, status, &body));
    }
    // Created per attempt, so a retry truncates the partial body instead of
    // appending a second copy after it.
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| S3Fail::Final(anyhow::anyhow!("create {}: {e:#}", dest.display())))?;
    let mut stream = resp.bytes_stream();
    let mut bytes = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                return Err(S3Fail::Retryable(anyhow::anyhow!(
                    "s3 download {key} body: {e:#}"
                )));
            }
        };
        bytes += chunk.len() as u64;
        file.write_all(&chunk)
            .await
            .map_err(|e| S3Fail::Final(anyhow::anyhow!("write download: {e:#}")))?;
    }
    file.flush()
        .await
        .map_err(|e| S3Fail::Final(anyhow::anyhow!("flush download: {e:#}")))?;
    super::stats::count_s3("download", 0, bytes);
    Ok(bytes)
}

/// Chunked file body for PUT: 32 KiB pieces read as the request drains, so
/// bundles and snapshots never sit whole in memory.
struct FileChunks {
    file: tokio::fs::File,
}

impl futures::Stream for FileChunks {
    type Item = std::io::Result<bytes::Bytes>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        use std::task::Poll;
        use tokio::io::AsyncRead;
        let mut buf = [0u8; 32 * 1024];
        let mut read_buf = tokio::io::ReadBuf::new(&mut buf);
        match std::pin::Pin::new(&mut self.file).poll_read(cx, &mut read_buf) {
            Poll::Ready(Ok(())) => {
                let filled = read_buf.filled();
                if filled.is_empty() {
                    Poll::Ready(None)
                } else {
                    Poll::Ready(Some(Ok(bytes::Bytes::copy_from_slice(filled))))
                }
            }
            Poll::Ready(Err(e)) => Poll::Ready(Some(Err(e))),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Stream one file to `key` with its length up front (S3 needs it).
///
/// Retried like the download: a full-key PUT is an overwrite, so repeating
/// one is idempotent.
async fn s3_put_file(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    src: &Path,
    timeout: Duration,
) -> anyhow::Result<u64> {
    with_s3_retry("upload", key, || {
        put_once(cfg, bucket_name, key, src, timeout)
    })
    .await
}

async fn put_once(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    src: &Path,
    timeout: Duration,
) -> Result<u64, S3Fail> {
    let (handle, creds) = s3_bucket(cfg, bucket_name).map_err(S3Fail::Final)?;
    // Opened per attempt: the streaming body consumes the file, so a retry
    // must re-read it instead of uploading the first attempt's EOF.
    let file = tokio::fs::File::open(src)
        .await
        .map_err(|e| S3Fail::Final(anyhow::anyhow!("open {}: {e:#}", src.display())))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| S3Fail::Final(anyhow::anyhow!("stat upload: {e:#}")))?
        .len();
    let url = handle
        .put_object(Some(&creds), key)
        .sign(Duration::from_secs(PRESIGN_SECS));
    let resp = match http_client()
        .put(url)
        .header(reqwest::header::CONTENT_LENGTH, len)
        .body(reqwest::Body::wrap_stream(FileChunks { file }))
        .timeout(timeout)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            return Err(S3Fail::Retryable(anyhow::anyhow!(
                "s3 upload {key} transport: {e:#}"
            )));
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_status("upload", key, status, &body));
    }
    super::stats::count_s3("upload", len, 0);
    Ok(len)
}

pub async fn s3_cp_download(cfg: &Config, uri: &str, dest: &Path) -> anyhow::Result<()> {
    let (bucket, key) = split_uri(uri)?;
    s3_get_to_file(cfg, bucket, key, dest, Duration::from_secs(30))
        .await
        .map(|_| ())
}

pub async fn s3_cp_upload(cfg: &Config, src: &Path, key: &str) -> anyhow::Result<()> {
    let bucket = cfg.s3_bucket.clone();
    s3_put_file(cfg, &bucket, key, src, Duration::from_secs(70))
        .await
        .map(|_| ())
}

pub async fn s3_delete_key(cfg: &Config, key: &str) -> anyhow::Result<()> {
    let bucket = cfg.s3_bucket.clone();
    let (handle, creds) = s3_bucket(cfg, &bucket)?;
    let url = handle
        .delete_object(Some(&creds), key)
        .sign(Duration::from_secs(300));
    let resp = http_client()
        .delete(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("s3 DELETE")?;
    // Deleting a missing key is a no-op upstream too (`delete-object` on a
    // missing key returns 204), so 404 joins the success set.
    if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    Err(s3_err("delete", key, resp).await)
}

/// One S3 object plus the fields the CLI's JSON listing carried for it.
pub(crate) struct S3Object {
    pub(crate) key: String,
    pub(crate) last_modified: String,
    pub(crate) size: u64,
    pub(crate) etag: String,
}

/// One native LIST response: one request's objects, common prefixes and the
/// token that continues it. Callers that page keep the token; callers that
/// do not use `s3_list_raw`.
pub(crate) struct S3Page {
    pub(crate) objects: Vec<S3Object>,
    pub(crate) prefixes: Vec<String>,
    pub(crate) next: Option<String>,
}

/// One bounded LIST request (unlike `s3_list_raw`, which merges every page).
pub(crate) async fn s3_list_page(
    cfg: &Config,
    bucket_name: &str,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: usize,
    continuation: Option<&str>,
) -> anyhow::Result<S3Page> {
    let (handle, creds) = s3_bucket(cfg, bucket_name)?;
    super::stats::count_s3("list", 0, 0);
    let mut action = handle.list_objects_v2(Some(&creds));
    action.with_prefix(prefix.to_string());
    action.with_max_keys(max_keys.clamp(1, 1000));
    if let Some(delimiter) = delimiter {
        action.with_delimiter(delimiter.to_string());
    }
    if let Some(token) = continuation {
        action.with_continuation_token(token.to_string());
    }
    let url = action.sign(Duration::from_secs(300));
    let resp = http_client()
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .context("s3 LIST")?;
    if !resp.status().is_success() {
        return Err(s3_err("list", prefix, resp).await);
    }
    let text = resp.text().await.context("s3 LIST body")?;
    let parsed = rusty_s3::actions::ListObjectsV2::parse_response(&text)
        .with_context(|| "s3 LIST XML parse")?;
    Ok(S3Page {
        objects: parsed
            .contents
            .into_iter()
            .map(|object| S3Object {
                key: object.key,
                last_modified: object.last_modified,
                size: object.size,
                etag: object.etag,
            })
            .collect(),
        prefixes: parsed
            .common_prefixes
            .into_iter()
            .map(|prefix| prefix.prefix)
            .collect(),
        next: parsed.next_continuation_token,
    })
}

/// One object's record as a HEAD reports it: the size (S3 lists it too, but a
/// single-key lookup has no listing) and the real `content-type` header celld
/// writes for an R2 object.
pub(crate) struct S3Head {
    pub(crate) size: i64,
    pub(crate) content_type: Option<String>,
}

/// `HEAD` one object: `None` when it does not exist (or the store refused).
pub(crate) async fn s3_head_object(cfg: &Config, bucket: &str, key: &str) -> Option<S3Head> {
    let (handle, creds) = s3_bucket(cfg, bucket).ok()?;
    super::stats::count_s3("head", 0, 0);
    let url = handle
        .head_object(Some(&creds), key)
        .sign(Duration::from_secs(300));
    let resp = http_client()
        .head(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let size = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    Some(S3Head { size, content_type })
}

/// Download one object's whole body into memory.
pub(crate) async fn s3_get_bytes(cfg: &Config, full_key: &str) -> anyhow::Result<Vec<u8>> {
    let dir = work_root(cfg).join("r2-preview");
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!(
        "r2-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    s3_cp_download(cfg, &cfg.s3_uri(full_key), &dest).await?;
    let bytes = tokio::fs::read(&dest).await?;
    let _ = tokio::fs::remove_file(&dest).await;
    Ok(bytes)
}

/// Paginated native LIST (the CLI returned one 1000-key page; every caller
/// handles full arrays, so merging pages is strictly more correct).
///
/// Retried like the download: a listing reads nothing, so repeating one is
/// idempotent. A retry restarts from the first page — pages are small and a
/// partial merge could otherwise duplicate keys.
async fn s3_list_raw(
    cfg: &Config,
    bucket_name: &str,
    prefix: &str,
    delimiter: Option<&str>,
) -> anyhow::Result<(Vec<S3Object>, Vec<String>)> {
    with_s3_retry("list", prefix, || {
        list_once(cfg, bucket_name, prefix, delimiter)
    })
    .await
}

async fn list_once(
    cfg: &Config,
    bucket_name: &str,
    prefix: &str,
    delimiter: Option<&str>,
) -> Result<(Vec<S3Object>, Vec<String>), S3Fail> {
    let (handle, creds) = s3_bucket(cfg, bucket_name).map_err(S3Fail::Final)?;
    super::stats::count_s3("list", 0, 0);
    let mut objects = Vec::new();
    let mut prefixes = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let mut action = handle.list_objects_v2(Some(&creds));
        action.with_prefix(prefix.to_string());
        if let Some(d) = delimiter {
            action.with_delimiter(d.to_string());
        }
        if let Some(t) = continuation.take() {
            action.with_continuation_token(t);
        }
        let url = action.sign(Duration::from_secs(300));
        let resp = match http_client()
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                return Err(S3Fail::Retryable(anyhow::anyhow!(
                    "s3 list {prefix} transport: {e:#}"
                )));
            }
        };
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(classify_status("list", prefix, status, &body));
        }
        let text = resp
            .text()
            .await
            .map_err(|e| S3Fail::Final(anyhow::anyhow!("s3 LIST body: {e:#}")))?;
        let parsed = rusty_s3::actions::ListObjectsV2::parse_response(&text)
            .map_err(|e| S3Fail::Final(anyhow::anyhow!("s3 LIST XML parse: {e:#}")))?;
        objects.extend(parsed.contents.into_iter().map(|o| S3Object {
            key: o.key,
            last_modified: o.last_modified,
            size: o.size,
            etag: o.etag,
        }));
        prefixes.extend(parsed.common_prefixes.into_iter().map(|p| p.prefix));
        continuation = parsed.next_continuation_token;
        if continuation.is_none() {
            break;
        }
    }
    Ok((objects, prefixes))
}

/// The aws CLI's `list-objects-v2 --output json` shape (`Contents[].Key`,
/// `CommonPrefixes[].Prefix`), synthesized from the native listing so every
/// existing parser keeps working unchanged.
fn listings_json(objects: &[S3Object], prefixes: &[String]) -> String {
    let contents: Vec<serde_json::Value> = objects
        .iter()
        .map(|o| {
            serde_json::json!({
                "Key": o.key,
                "LastModified": o.last_modified,
                "Size": o.size,
                "ETag": o.etag,
            })
        })
        .collect();
    let common: Vec<serde_json::Value> = prefixes
        .iter()
        .map(|p| serde_json::json!({ "Prefix": p }))
        .collect();
    serde_json::json!({ "Contents": contents, "CommonPrefixes": common }).to_string()
}

/// One listing page with `/` as the delimiter: `CommonPrefixes` are the
/// directories below `prefix` and `Contents` the files in it. Cheaper than
/// walking every key when only one level matters (telemetry compaction).
pub async fn s3_list_delimited(cfg: &Config, bucket: &str, prefix: &str) -> anyhow::Result<String> {
    let (objects, prefixes) = s3_list_raw(cfg, bucket, prefix, Some("/")).await?;
    Ok(listings_json(&objects, &prefixes))
}

/// `HEAD` probe: true when the object exists.
pub async fn s3_object_exists(cfg: &Config, bucket: &str, key: &str) -> bool {
    let Ok((handle, creds)) = s3_bucket(cfg, bucket) else {
        return false;
    };
    super::stats::count_s3("head", 0, 0);
    let url = handle
        .head_object(Some(&creds), key)
        .sign(Duration::from_secs(300));
    let Ok(resp) = http_client()
        .head(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
    else {
        return false;
    };
    resp.status().is_success()
}

/// Batch delete (one `DeleteObjects` POST per 1000 keys). A 200 with per-key
/// `Error` entries is a failure, not a success: access problems surface that
/// way, and ignoring them would pretend a purge worked.
async fn s3_delete_keys(cfg: &Config, bucket_name: &str, keys: &[String]) -> anyhow::Result<()> {
    use rusty_s3::actions::{DeleteObjectsResponse, ObjectIdentifier};
    if keys.is_empty() {
        return Ok(());
    }
    super::stats::count_s3("delete", 0, 0);
    let (handle, creds) = s3_bucket(cfg, bucket_name)?;
    for chunk in keys.chunks(1000) {
        let ids: Vec<ObjectIdentifier> = chunk
            .iter()
            .map(|k| ObjectIdentifier::new(k.clone()))
            .collect();
        let action = handle.delete_objects(Some(&creds), ids.iter());
        let url = action.sign(Duration::from_secs(300));
        let (body, md5) = action.body_with_md5();
        let resp = http_client()
            .post(url)
            .header("Content-MD5", md5)
            .body(body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .context("s3 DeleteObjects")?;
        if !resp.status().is_success() {
            return Err(s3_err("delete-keys", bucket_name, resp).await);
        }
        let text = resp.text().await.context("s3 DeleteObjects body")?;
        let parsed =
            DeleteObjectsResponse::parse(&text).with_context(|| "s3 DeleteObjects XML parse")?;
        if let Some(first) = parsed.errors.first() {
            bail!(
                "s3 delete-keys {bucket_name} failed: {} {}",
                first.code,
                first.message
            );
        }
    }
    Ok(())
}

/// Recursive delete of one telemetry hour directory, keeping the compacted
/// file the copy just wrote.
pub async fn s3_rm_dir_except(
    cfg: &Config,
    bucket: &str,
    prefix: &str,
    keep: &str,
) -> anyhow::Result<()> {
    let (objects, _) = s3_list_raw(cfg, bucket, prefix, None).await?;
    let keep_full = format!("{prefix}{keep}");
    let victims: Vec<String> = objects
        .into_iter()
        .map(|o| o.key)
        .filter(|k| k != &keep_full)
        .collect();
    s3_delete_keys(cfg, bucket, &victims).await
}

/// Recursive delete of one prefix (app purge, deleted-ref cleanup). Empty
/// prefixes are a no-op, so retries after a partial delete stay quiet.
pub async fn s3_rm_prefix(cfg: &Config, bucket: &str, prefix: &str) -> anyhow::Result<()> {
    let (objects, _) = s3_list_raw(cfg, bucket, prefix, None).await?;
    let keys: Vec<String> = objects.into_iter().map(|o| o.key).collect();
    s3_delete_keys(cfg, bucket, &keys).await
}

/// Object copy for renames: download to a temp file, upload under the new
/// key, delete the old. No server-side COPY (its header must be signed, which
/// the presigned-URL flow cannot cover); renames are rare enough that the
/// extra hop doesn't matter.
pub async fn s3_copy_key(
    cfg: &Config,
    bucket: &str,
    from_key: &str,
    to_key: &str,
) -> anyhow::Result<()> {
    let tmp = std::env::temp_dir().join(format!("noite-s3-copy-{}", uuid::Uuid::new_v4()));
    s3_get_to_file(cfg, bucket, from_key, &tmp, Duration::from_secs(120)).await?;
    let uploaded = s3_put_file(cfg, bucket, to_key, &tmp, Duration::from_secs(120)).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    uploaded.map(|_| ())
}

pub async fn s3_list_prefix(cfg: &Config, bucket: &str, prefix: &str) -> anyhow::Result<String> {
    let (objects, _) = s3_list_raw(cfg, bucket, prefix, None).await?;
    Ok(listings_json(&objects, &[]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SigV4 header signer, cross-validated on the IAM ListUsers inputs below:
    /// the Rust `hmac` crate, Python's stdlib `hmac` and `openssl dgst`
    /// agree on the signature, and the construction (canonical request,
    /// scope, HMAC chain) follows the normative AWS reference
    /// (`reference_sigv-create-signed-request`). The test pins the value so
    /// refactors cannot drift the bytes the bucket-config PUTs sign.
    #[test]
    fn sigv4_matches_reference_inputs() {
        let auth = sigv4_authorization(
            "GET",
            "/",
            "Action=ListUsers&Version=2010-05-08",
            "content-type:application/x-www-form-urlencoded; charset=utf-8\nhost:iam.amazonaws.com\nx-amz-date:20150830T123600Z\n",
            "content-type;host;x-amz-date",
            "20150830T123600Z",
            "20150830",
            "us-east-1",
            "iam",
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, \
             SignedHeaders=content-type;host;x-amz-date, \
             Signature=33f5dad2191de0cb4b7ab912f876876c2c4f72e2991a458f9499233c7b992438"
        );
    }

    /// The synthesized listing carries exactly what the parsers read
    /// (`Contents[].Key/LastModified/Size`, `CommonPrefixes[].Prefix`).
    #[test]
    fn listings_json_matches_cli_shape() {
        let objects = vec![S3Object {
            key: "git/demo/refs/heads/main/abc1234.bundle".into(),
            last_modified: "2026-09-29T00:00:00.000Z".into(),
            size: 42,
            etag: "\"abc\"".into(),
        }];
        let v: serde_json::Value =
            serde_json::from_str(&listings_json(&objects, &["git/demo/refs/heads/".into()]))
                .unwrap();
        assert_eq!(
            v["Contents"][0]["Key"],
            "git/demo/refs/heads/main/abc1234.bundle"
        );
        assert_eq!(v["Contents"][0]["LastModified"], "2026-09-29T00:00:00.000Z");
        assert_eq!(v["Contents"][0]["Size"], 42);
        assert_eq!(v["CommonPrefixes"][0]["Prefix"], "git/demo/refs/heads/");
        let empty: serde_json::Value = serde_json::from_str(&listings_json(&[], &[])).unwrap();
        assert_eq!(empty["Contents"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn split_uri_rejects_non_keys() {
        assert!(split_uri("s3://b/k").is_ok());
        assert!(split_uri("https://b/k").is_err());
        assert!(split_uri("s3://b/").is_err());
        assert!(split_uri("s3://b").is_err());
    }

    fn is_retryable(fail: S3Fail) -> bool {
        matches!(fail, S3Fail::Retryable(_))
    }

    /// Only 5xx/SlowDown may be retried: a 4xx comes back identically every
    /// time, so retrying one just burns three timeouts before failing.
    #[test]
    fn retry_covers_5xx_and_slowdown_but_never_4xx() {
        use reqwest::StatusCode;
        assert!(is_retryable(classify_status(
            "download",
            "k",
            StatusCode::SERVICE_UNAVAILABLE,
            "ServiceUnavailable"
        )));
        assert!(is_retryable(classify_status(
            "upload",
            "k",
            StatusCode::INTERNAL_SERVER_ERROR,
            ""
        )));
        assert!(is_retryable(classify_status(
            "list",
            "p",
            StatusCode::SERVICE_UNAVAILABLE,
            "<Code>SlowDown</Code>"
        )));
        assert!(!is_retryable(classify_status(
            "download",
            "missing",
            StatusCode::NOT_FOUND,
            "<Code>NoSuchKey</Code>"
        )));
        assert!(!is_retryable(classify_status(
            "upload",
            "k",
            StatusCode::FORBIDDEN,
            "AccessDenied"
        )));
        assert!(!is_retryable(classify_status(
            "list",
            "p",
            StatusCode::BAD_REQUEST,
            "InvalidRequest"
        )));
    }

    /// Backoff grows per failure and stays bounded: three attempts cost
    /// seconds, not minutes, on top of the per-attempt timeout.
    #[test]
    fn retry_delay_backs_off_with_jitter() {
        let first = s3_retry_delay(1);
        let second = s3_retry_delay(2);
        assert!(first >= Duration::from_millis(250));
        assert!(second >= Duration::from_millis(500));
        assert!(second <= Duration::from_millis(2500));
    }

    /// A transport failure on a numeric key is unreachable, not missing: the
    /// old bare-`"404"` arm read `s3 download 404.html failed: HTTP 500` as
    /// "start fresh" and callers uploaded an empty database over a good one.
    #[test]
    fn not_found_ignores_key_names_and_transport_failures() {
        let missing = anyhow::anyhow!("s3 download tip.bundle failed: HTTP 404 <Code>NoSuchKey</Code>");
        assert!(is_not_found(&missing));
        let legacy =
            anyhow::anyhow!("aws exit 1\nfatal error: An error occurred (404) when calling the HeadObject operation");
        assert!(is_not_found(&legacy));
        let numeric_key_on_500 =
            anyhow::anyhow!("s3 download 404.html failed: HTTP 500 ServiceUnavailable");
        assert!(!is_not_found(&numeric_key_on_500));
        let down = anyhow::anyhow!(
            "s3 download tip.bundle transport: error sending request for url (http://rustfs:9000/noite)"
        );
        assert!(!is_not_found(&down));
    }
}
