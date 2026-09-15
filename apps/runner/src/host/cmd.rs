use anyhow::{bail, Context};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

use crate::config::Config;

pub async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> anyhow::Result<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
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
