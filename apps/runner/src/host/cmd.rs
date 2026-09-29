use anyhow::{bail, Context};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

use crate::config::Config;

/// Explicit base environment for tenant builds (SPEC, Build and release sandbox).
/// Nothing is inherited: `run_sandboxed` starts from `env_clear()` plus
/// these, then the already-denylisted tenant vars.
pub fn base_env(work_tmp: &str, bun_cache: &str) -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()),
        ("HOME".into(), "/home/build".into()),
        ("TMPDIR".into(), work_tmp.into()),
        ("LANG".into(), "C.UTF-8".into()),
        ("CI".into(), "1".into()),
        ("NODE_ENV".into(), "production".into()),
        ("BUN_INSTALL_CACHE_DIR".into(), bun_cache.into()),
    ]
}

/// Tenant sandbox: uid/gid drop + explicit env (SPEC, Build and release sandbox).
/// `uid: None` = current user (dev only, single-tenant).
/// `bun_cache: None` = a throwaway `.bun-cache` inside the worktree (the old
/// path); `Some` = the persistent per-app cache (T5.1).
pub struct Sandbox<'a> {
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub env: &'a [(&'a str, &'a str)],
    pub bun_cache: Option<&'a Path>,
}

/// Probe whether uid drops work (needs CAP_SETUID/CAP_SETGID or root).
pub fn can_drop_uid(uid: u32, gid: u32) -> bool {
    #[cfg(unix)]
    {
        // Fork-free probe: try setuid in a child `id` process via `su`-less
        // `setpriv`-style check is overkill; attempt a no-op `sh` with uid
        // set and see if it spawns. Cheap and cached by the caller.
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("/bin/true");
        cmd.uid(uid).gid(gid);
        cmd.status().map(|s| s.success()).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = (uid, gid);
        false
    }
}

/// True when an S3 error means "the object does not exist", as opposed
/// to the store being unreachable. Native failures carry `HTTP 404` plus the
/// store's `NoSuchKey` body, which the same matchers catch. Callers that
/// treat "missing" as "start fresh" must not do so on a transport error, or
/// they overwrite good state.
pub fn is_not_found(err: &anyhow::Error) -> bool {
    let text = format!("{err:#}");
    text.contains("404")
        || text.contains("Not Found")
        || text.contains("NoSuchKey")
        || text.contains("does not exist")
}

/// Recursively hand `path` to (uid, gid) without following symlinks: a tenant
/// tree can contain `x -> /data/noite.sqlite`, and a following chown run by
/// the runner (CAP_CHOWN) would give the build user the platform database.
/// `lchown` changes the link itself, and links are never descended into.
/// Returns false when any entry could not be changed.
#[cfg(unix)]
pub fn lchown_tree(path: &Path, uid: u32, gid: u32) -> bool {
    let mut ok = true;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&p) else {
            ok = false;
            continue;
        };
        if std::os::unix::fs::lchown(&p, Some(uid), Some(gid)).is_err() {
            ok = false;
        }
        if meta.file_type().is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for entry in rd.flatten() {
                    stack.push(entry.path());
                }
            }
        }
    }
    ok
}

/// Total bytes under `dir` (symlinks not followed).
pub fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            let Ok(m) = entry.metadata() else {
                continue;
            };
            if m.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(m.len());
            }
        }
    }
    total
}

/// Refuse a worktree above the disk quota (SPEC, Build and release sandbox).
pub fn check_work_quota(work: &Path, max_mb: u64) -> anyhow::Result<()> {
    let max = max_mb.saturating_mul(1024 * 1024);
    let used = dir_bytes(work);
    if used > max {
        anyhow::bail!("build worktree {used} bytes exceeds RUNNER_BUILD_MAX_MB={max_mb}");
    }
    Ok(())
}

/// Persistent per-app bun cache (T5.1): `/data/runner/cache/<slug>/bun`.
/// Per app, never shared across tenants (a shared cache would let one
/// tenant's build poison another's packages). Deleted with the app
/// (`purge_slug`) and moved on rename.
pub fn build_cache_dir(cfg: &Config, slug: &str) -> PathBuf {
    work_root(cfg).join("cache").join(slug).join("bun")
}

/// Prune the persistent bun cache oldest-first until it fits `max_mb`
/// (RUNNER_BUILD_CACHE_MB). Symlinks are never followed: like `lchown_tree`,
/// a tenant tree can link at `/data/noite.sqlite`, and following it here
/// would delete platform state. Missing dir is a no-op.
pub fn prune_build_cache(dir: &Path, max_mb: u64) {
    let max = max_mb.saturating_mul(1024 * 1024);
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            // symlink_metadata: never follow tenant links.
            let Ok(m) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if m.is_dir() {
                stack.push(entry.path());
            } else if m.is_file() {
                files.push((m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH), m.len(), entry.path()));
            }
        }
    }
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= max {
        return;
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut pruned_files = 0u64;
    let mut pruned_bytes = 0u64;
    for (_, len, path) in files {
        if total <= max {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            pruned_files += 1;
            pruned_bytes += len;
        }
    }
    // Empty dirs left behind are harmless; the next build recreates them.
    tracing::info!(dir = %dir.display(), pruned_files, pruned_bytes, max_mb, "pruned bun build cache");
}

/// Tenant build/release sandbox: `env_clear`, BASE_ENV + tenant vars, uid/gid
/// drop, new process group (whole tree dies on timeout via killpg), rlimits
/// (NPROC, FSIZE). Network egress is closed by the nft policy in
/// `host::netisolation`, which also covers this uid.
pub async fn run_sandboxed(
    program: &str,
    args: &[&str],
    cwd: &Path,
    sb: &Sandbox<'_>,
    timeout: Duration,
 ) -> anyhow::Result<String> {
    super::stats::count_spawn(program);
    use std::os::unix::process::CommandExt;
    let tmp = cwd.join(".tmp-sandbox");
    let _ = std::fs::create_dir_all(&tmp);
    // Persistent per-app cache (T5.1) when the caller hands one over;
    // otherwise the old throwaway inside the worktree.
    let cache_owned;
    let cache: &Path = match sb.bun_cache {
        Some(dir) => {
            let _ = std::fs::create_dir_all(dir);
            dir
        }
        None => {
            cache_owned = cwd.join(".bun-cache");
            let _ = std::fs::create_dir_all(&cache_owned);
            &cache_owned
        }
    };
    // Created by the runner after the worktree was handed over: give them to
    // the sandbox user too, or TMPDIR and the bun cache are unwritable.
    if let Some(uid) = sb.uid {
        let gid = sb.gid.unwrap_or(uid);
        lchown_tree(&tmp, uid, gid);
        lchown_tree(&cache, uid, gid);
    }
    let drops_uid = sb.uid.is_some();
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .env_clear()
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in base_env(&tmp.to_string_lossy(), &cache.to_string_lossy()) {
        cmd.env(k, v);
    }
    for (k, v) in sb.env {
        cmd.env(k, v);
    }
    {
        let std_cmd = cmd.as_std_mut();
        if let Some(uid) = sb.uid {
            std_cmd.uid(uid);
        }
        if let Some(gid) = sb.gid {
            std_cmd.gid(gid);
        }
        std_cmd.process_group(0);
        // SAFETY: pre_exec runs between fork and exec; only async-signal-safe
        // libc calls. setrlimit bounds fork bombs (NPROC) and runaway
        // outputs (FSIZE 4 GiB).
        unsafe {
            std_cmd.pre_exec(move || {
                // RLIMIT_NPROC counts every process of the real uid, so it is
                // only meaningful for the dedicated build user; on the
                // runner's own uid (dev, single tenancy) it would cap the
                // runner and its fleets too.
                if drops_uid {
                    let nproc = libc::rlimit { rlim_cur: 512, rlim_max: 512 };
                    libc::setrlimit(libc::RLIMIT_NPROC, &nproc);
                }
                let fsize = libc::rlimit {
                    rlim_cur: 4 * 1024 * 1024 * 1024,
                    rlim_max: 4 * 1024 * 1024 * 1024,
                };
                libc::setrlimit(libc::RLIMIT_FSIZE, &fsize);
                Ok(())
            });
        }
    }
    let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    let pid = child.id();
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
    // Whatever happened, nothing the step started may outlive it: a build
    // that leaves a watcher or a server behind would keep running as the
    // build user between steps. The group id is the child's pid
    // (process_group(0)); ESRCH when the group is already empty is fine.
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: signals only the process group this call created.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    match result {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                let out = String::from_utf8_lossy(&output.stdout);
                bail!("{program} {:?} exit {:?}\n{err}{out}", args, output.status.code());
            }
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Err(e)) => Err(e).context("wait output"),
        Err(_) => Err(anyhow::anyhow!(
            "{program} {:?} timed out after {:?}",
            args,
            timeout
        )),
    }
}

 pub async fn run_cmd(
     program: &str,
     args: &[&str],
     cwd: Option<&Path>,
     env: &[(&str, &str)],
     timeout: Duration,
 ) -> anyhow::Result<String> {
    super::stats::count_spawn(program);
    let mut cmd = Command::new(program);
     cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
         .stdout(std::process::Stdio::piped())
         .stderr(std::process::Stdio::piped())
         .kill_on_drop(true);
     if let Some(cwd) = cwd {
         cmd.current_dir(cwd);
     }
     for (k, v) in env {
         cmd.env(k, v);
     }
     let child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
     let output = tokio::time::timeout(timeout, child.wait_with_output())
         .await
         .context("command timeout")?
         .context("wait output")?;
     if !output.status.success() {
         let err = String::from_utf8_lossy(&output.stderr);
         let out = String::from_utf8_lossy(&output.stdout);
         bail!(
             "{program} {:?} exit {:?}\n{err}{out}",
             args,
             output.status.code()
         );
     }
     Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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

// ---------------------------------------------------------------------------
// Native S3 (T2.1): rusty-s3 signs requests, one pooled reqwest client sends
// them. No Python interpreter per call; streaming bodies for bundles and
// snapshots. The `s3_*` helpers keep their signatures so call sites don't
// change; listings keep the aws CLI's JSON shape for the same reason.
// ---------------------------------------------------------------------------

/// Connection-pooled HTTP client shared by every S3 call: one pool for the
/// process instead of one Python heap per call.
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
    let handle = Bucket::new(endpoint, UrlStyle::Path, bucket.to_string(), cfg.aws_region.clone())
        .context("S3 bucket handle")?;
    let creds = Credentials::new(cfg.aws_access_key_id.clone(), cfg.aws_secret_access_key.clone());
    Ok((handle, creds))
}

/// Rich S3 failure: HTTP status plus the store's XML error body. `is_not_found`
/// matches on "404"/"NoSuchKey", so "missing" vs "unreachable" keeps working
/// without knowing the transport.
async fn s3_err(op: &str, target: &str, resp: reqwest::Response) -> anyhow::Error {
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.trim().chars().take(300).collect();
    anyhow::anyhow!("s3 {op} {target} failed: HTTP {status} {snippet}")
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
        Err(e) => tracing::warn!(bucket, error = %format!("{e:#}"), "s3 versioning not set (non-fatal)"),
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
        Ok(()) => tracing::info!(bucket, "s3 lifecycle: noncurrent versions expire after a day"),
        Err(e) => tracing::warn!(bucket, error = %format!("{e:#}"), "s3 lifecycle not set (non-fatal)"),
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
    let url = handle.head_bucket(Some(&creds)).sign(Duration::from_secs(300));
    let Ok(resp) = http_client().head(url).timeout(Duration::from_secs(10)).send().await else {
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
    let url = handle.head_bucket(Some(&creds)).sign(Duration::from_secs(300));
    let Ok(resp) = http_client().head(url).timeout(Duration::from_secs(10)).send().await else {
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
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{:x}", hasher.finalize());
    let sign = |key: &[u8], msg: &[u8]| {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
        mac.update(msg);
        mac.finalize().into_bytes().to_vec()
    };
    let k_date = sign(format!("AWS4{secret_key}").as_bytes(), date_stamp.as_bytes());
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
    let url = format!("{}{canonical_uri}?{subresource}", cfg.s3_endpoint.trim_end_matches('/'));
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
async fn s3_get_to_file(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    dest: &Path,
    timeout: Duration,
) -> anyhow::Result<u64> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;
    let (handle, creds) = s3_bucket(cfg, bucket_name)?;
    let url = handle
        .get_object(Some(&creds), key)
        .sign(Duration::from_secs(PRESIGN_SECS));
    let resp = http_client()
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .context("s3 GET")?;
    if !resp.status().is_success() {
        return Err(s3_err("download", key, resp).await);
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("create {}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    let mut bytes = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("s3 download body")?;
        bytes += chunk.len() as u64;
        file.write_all(&chunk).await.context("write download")?;
    }
    file.flush().await.context("flush download")?;
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
async fn s3_put_file(
    cfg: &Config,
    bucket_name: &str,
    key: &str,
    src: &Path,
    timeout: Duration,
) -> anyhow::Result<u64> {
    let (handle, creds) = s3_bucket(cfg, bucket_name)?;
    let file = tokio::fs::File::open(src)
        .await
        .with_context(|| format!("open {}", src.display()))?;
    let len = file.metadata().await.context("stat upload")?.len();
    let url = handle
        .put_object(Some(&creds), key)
        .sign(Duration::from_secs(PRESIGN_SECS));
    let resp = http_client()
        .put(url)
        .header(reqwest::header::CONTENT_LENGTH, len)
        .body(reqwest::Body::wrap_stream(FileChunks { file }))
        .timeout(timeout)
        .send()
        .await
        .context("s3 PUT")?;
    if !resp.status().is_success() {
        return Err(s3_err("upload", key, resp).await);
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

/// Run a command with stdin bytes; returns raw stdout (no UTF-8 requirement).
pub async fn run_cmd_stdin(
    program: &str,
    args: &[&str],
    stdin: &[u8],
    cwd: Option<&Path>,
    timeout: Duration,
) -> anyhow::Result<Vec<u8>> {
    use tokio::io::AsyncWriteExt;
    super::stats::count_spawn(program);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {program}"))?;
    if let Some(mut pipe) = child.stdin.take() {
        pipe.write_all(stdin).await.context("write stdin")?;
        pipe.shutdown().await.ok();
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .context("command timeout")?
        .context("wait output")?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{program} {:?} exit {:?}\n{err}",
            args,
            output.status.code()
        );
    }
    Ok(output.stdout)
}

/// One S3 object plus the fields the CLI's JSON listing carried for it.
struct S3Object {
    key: String,
    last_modified: String,
    size: u64,
    etag: String,
}

/// Paginated native LIST (the CLI returned one 1000-key page; every caller
/// handles full arrays, so merging pages is strictly more correct).
async fn s3_list_raw(
    cfg: &Config,
    bucket_name: &str,
    prefix: &str,
    delimiter: Option<&str>,
) -> anyhow::Result<(Vec<S3Object>, Vec<String>)> {
    let (handle, creds) = s3_bucket(cfg, bucket_name)?;
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
    let common: Vec<serde_json::Value> =
        prefixes.iter().map(|p| serde_json::json!({ "Prefix": p })).collect();
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
    let url = handle.head_object(Some(&creds), key).sign(Duration::from_secs(300));
    let Ok(resp) = http_client().head(url).timeout(Duration::from_secs(20)).send().await else {
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
        let ids: Vec<ObjectIdentifier> =
            chunk.iter().map(|k| ObjectIdentifier::new(k.clone())).collect();
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
        let parsed = DeleteObjectsResponse::parse(&text).with_context(|| "s3 DeleteObjects XML parse")?;
        if let Some(first) = parsed.errors.first() {
            bail!("s3 delete-keys {bucket_name} failed: {} {}", first.code, first.message);
        }
    }
    Ok(())
}

/// Recursive delete of one telemetry hour directory, keeping the compacted
/// file the copy just wrote.
pub async fn s3_rm_dir_except(cfg: &Config, bucket: &str, prefix: &str, keep: &str) -> anyhow::Result<()> {
    let (objects, _) = s3_list_raw(cfg, bucket, prefix, None).await?;
    let keep_full = format!("{prefix}{keep}");
    let victims: Vec<String> =
        objects.into_iter().map(|o| o.key).filter(|k| k != &keep_full).collect();
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
pub async fn s3_copy_key(cfg: &Config, bucket: &str, from_key: &str, to_key: &str) -> anyhow::Result<()> {
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

#[derive(Debug, Clone)]
pub struct TipBundle {
    pub key: String,
    pub sha: String,
}

pub async fn head_main_bundle(cfg: &Config, slug: &str) -> anyhow::Result<Option<TipBundle>> {
    let prefix = format!("git/{slug}/refs/heads/main/");
    let json = s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await?;
    if json.trim().is_empty() || json.trim() == "null" {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) else {
        return Ok(None);
    };
    let re = regex_lite_bundle();
    let mut best: Option<(String, String, String)> = None; // key, sha, last_modified
    for obj in contents {
        let Some(key) = obj.get("Key").and_then(|k| k.as_str()) else {
            continue;
        };
        let name = key.strip_prefix(&prefix).unwrap_or(key);
        let Some(caps) = re.captures(name) else {
            continue;
        };
        let sha = caps.get(1).unwrap().as_str().to_lowercase();
        let lm = obj
            .get("LastModified")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if best.as_ref().map(|b| lm.as_str() >= b.2.as_str()).unwrap_or(true) {
            best = Some((key.to_string(), sha, lm));
        }
    }
    Ok(best.map(|(key, sha, _)| TipBundle { key, sha }))
}

fn regex_lite_bundle() -> regex::Regex {
    regex::Regex::new(r"(?i)^([0-9a-f]{7,40})\.bundle$").expect("bundle re")
}

pub fn work_root(cfg: &Config) -> PathBuf {
    PathBuf::from(&cfg.work_dir)
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
            serde_json::from_str(&listings_json(&objects, &["git/demo/refs/heads/".into()])).unwrap();
        assert_eq!(v["Contents"][0]["Key"], "git/demo/refs/heads/main/abc1234.bundle");
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
}
