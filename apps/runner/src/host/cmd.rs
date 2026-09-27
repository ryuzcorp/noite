use anyhow::{bail, Context};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

use crate::config::Config;

/// Bucket retention for a fleet bucket: expire noncurrent versions and abort
/// multipart uploads abandoned mid-deploy, so an unbounded version history
/// cannot grow into a listing the object store refuses (see `ensure_buckets`).
pub const LIFECYCLE_RULE: &str = r#"{"Rules":[{"ID":"noite-fleet-retention","Status":"Enabled","Filter":{"Prefix":""},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}"#;

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
pub struct Sandbox<'a> {
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub env: &'a [(&'a str, &'a str)],
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

/// True when an aws CLI error means "the object does not exist", as opposed
/// to the store being unreachable. Callers that treat "missing" as "start
/// fresh" must not do so on a transport error, or they overwrite good state.
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
    use std::os::unix::process::CommandExt;
    let tmp = cwd.join(".tmp-sandbox");
    let _ = std::fs::create_dir_all(&tmp);
    let cache = cwd.join(".bun-cache");
    let _ = std::fs::create_dir_all(&cache);
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

pub async fn ensure_buckets(cfg: &Config) -> anyhow::Result<()> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let _ = run_cmd(
        "aws",
        &["configure", "set", "default.s3.addressing_style", "path"],
        None,
        &env,
        Duration::from_secs(10),
    )
    .await;

    let mut ready = false;
    for i in 0..60 {
        match run_cmd(
            "aws",
            &[
                "--endpoint-url",
                &cfg.s3_endpoint,
                "s3api",
                "list-buckets",
            ],
            None,
            &env,
            Duration::from_secs(10),
        )
        .await
        {
            Ok(_) => {
                ready = true;
                break;
            }
            Err(e) => {
                if i == 0 || i % 10 == 9 {
                    tracing::info!(attempt = i + 1, error = %e, "waiting for s3");
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    if !ready {
        // BYOB keys are often scoped to one bucket without ListAllMyBuckets:
        // accept a reachable bucket instead of failing readiness.
        let bucket = cfg.s3_bucket.as_str();
        let headed = run_cmd(
            "aws",
            &[
                "--endpoint-url",
                &cfg.s3_endpoint,
                "s3api",
                "head-bucket",
                "--bucket",
                bucket,
            ],
            None,
            &env,
            Duration::from_secs(15),
        )
        .await
        .is_ok();
        if headed {
            tracing::info!(bucket, "s3 list denied but bucket reachable (BYOB?) — continuing");
        } else {
            bail!("s3 not ready at {} after 60s", cfg.s3_endpoint);
        }
    }

    let bucket = cfg.s3_bucket.as_str();
    let _ = run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "create-bucket",
            "--bucket",
            bucket,
        ],
        None,
        &env,
        Duration::from_secs(15),
    )
    .await;
    run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "head-bucket",
            "--bucket",
            bucket,
        ],
        None,
        &env,
        Duration::from_secs(15),
    )
    .await
    .with_context(|| format!("head-bucket {bucket}"))?;
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
    match run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "put-bucket-versioning",
            "--bucket",
            bucket,
            "--versioning-configuration",
            "Status=Suspended",
        ],
        None,
        &env,
        Duration::from_secs(15),
    )
    .await
    {
        Ok(_) => tracing::info!(bucket, "s3 versioning enabled"),
        Err(e) => tracing::warn!(bucket, error = %e, "s3 versioning not enabled (non-fatal)"),
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
    match run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "put-bucket-lifecycle-configuration",
            "--bucket",
            bucket,
            "--lifecycle-configuration",
            LIFECYCLE_RULE,
        ],
        None,
        &env,
        Duration::from_secs(15),
    )
    .await
    {
        Ok(_) => tracing::info!(bucket, "s3 lifecycle: noncurrent versions expire after a day"),
        Err(e) => tracing::warn!(bucket, error = %e, "s3 lifecycle not set (non-fatal)"),
    }
    tracing::info!(bucket, "s3 bucket ready (prefixes git/, fleets/)");
    Ok(())
}

pub async fn s3_cp_download(cfg: &Config, uri: &str, dest: &Path) -> anyhow::Result<()> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "25",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3",
            "cp",
            uri,
            dest.to_str().unwrap(),
        ],
        None,
        &env,
        Duration::from_secs(30),
    )
    .await?;
    Ok(())
}

pub async fn s3_cp_upload(cfg: &Config, src: &Path, key: &str) -> anyhow::Result<()> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let uri = cfg.s3_uri(key);
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "60",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3",
            "cp",
            src.to_str().unwrap(),
            &uri,
        ],
        None,
        &env,
        Duration::from_secs(70),
    )
    .await?;
    Ok(())
}

pub async fn s3_delete_key(cfg: &Config, key: &str) -> anyhow::Result<()> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "delete-object",
            "--bucket",
            &cfg.s3_bucket,
            "--key",
            key,
        ],
        None,
        &env,
        Duration::from_secs(20),
    )
    .await?;
    Ok(())
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

/// One listing page with `/` as the delimiter: `CommonPrefixes` are the
/// directories below `prefix` and `Contents` the files in it. Cheaper than
/// walking every key when only one level matters (telemetry compaction).
pub async fn s3_list_delimited(cfg: &Config, bucket: &str, prefix: &str) -> anyhow::Result<String> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "15",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "list-objects-v2",
            "--bucket",
            bucket,
            "--prefix",
            prefix,
            "--delimiter",
            "/",
            "--output",
            "json",
        ],
        None,
        &env,
        Duration::from_secs(20),
    )
    .await
}

/// `s3api head-object` probe: Ok(true) when the object exists.
pub async fn s3_object_exists(cfg: &Config, bucket: &str, key: &str) -> bool {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "15",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "head-object",
            "--bucket",
            bucket,
            "--key",
            key,
            "--output",
            "json",
        ],
        None,
        &env,
        Duration::from_secs(20),
    )
    .await
    .is_ok()
}

/// Recursive delete of one telemetry hour directory, keeping the compacted
/// file the copy just wrote.
pub async fn s3_rm_dir_except(cfg: &Config, bucket: &str, prefix: &str, keep: &str) -> anyhow::Result<()> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "60",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3",
            "rm",
            &format!("s3://{bucket}/{prefix}"),
            "--recursive",
            "--exclude",
            keep,
        ],
        None,
        &env,
        Duration::from_secs(90),
    )
    .await
    .map(|_| ())
}

pub async fn s3_list_prefix(cfg: &Config, bucket: &str, prefix: &str) -> anyhow::Result<String> {
    let env_owned = aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    run_cmd(
        "timeout",
        &[
            "-k",
            "2",
            "15",
            "aws",
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3api",
            "list-objects-v2",
            "--bucket",
            bucket,
            "--prefix",
            prefix,
            "--output",
            "json",
        ],
        None,
        &env,
        Duration::from_secs(20),
    )
    .await
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
