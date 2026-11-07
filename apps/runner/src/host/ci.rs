//! Noite CI: a light GitHub-Actions-style `noite.ci.yaml` executed in
//! containers, one container per job.
//!
//! The parent (deploy pipeline) owns integration: it reads the repo-root
//! `noite.ci.yaml` after checkout, calls [`parse`], and on success calls
//! [`run`] instead of the built-in install/build. This module never touches
//! deploy state, config, or the UI.
//!
//! # Config shape (v1)
//!
//! ```yaml
//! on: [push]            # optional, ignored
//! jobs:
//!   build:              # job name; jobs run sequentially in file order
//!     image: oven/bun:1.4.4  # optional; defaults to settings, allowlisted at run time
//!     steps:
//!       - name: Install
//!         run: bun install --frozen-lockfile
//!         env: { NODE_ENV: production }
//!         working-directory: .
//!         timeout-minutes: 10
//!       - uses: checkout   # accepted no-op (the worktree is already checked out)
//! ```
//!
//! # Container contract (per job)
//!
//! ```text
//! docker create --cap-drop ALL --security-opt no-new-privileges \
//!   --pids-limit 2048 --memory <m>m --memory-swap <m>m --cpus <c> \
//!   --network <net> --user 0 --name <name> -v <cache>:/noite-home \
//!   -w /work -e <base env>... -e HOME=/noite-home <image> sh -lc 'sleep infinity'
//! docker start <name>
//! docker cp <work>/. <name>:/work
//! docker exec -u 0 <name> chown -R <uid>:<gid> /work /noite-home
//! docker exec --user <uid>:<gid> -w /work/<wd> -e K=V... <name> sh -lc <run>
//!   (per step; stdout/stderr streamed into `log`)
//! docker cp <name>:/work/dist <work>/dist   # best-effort, only on success
//! docker rm -f <name>                       # always
//! ```
//!
//! All argv is built as vectors and passed to the docker CLI directly: no
//! host shell ever interprets untrusted values. The `run` string is the only
//! shell text, and it runs inside the container.
//!
//! # Log protocol
//!
//! `log` receives, in order: `job: <name> (<image>)` per job, `step: <name>`
//! per step (unnamed steps log as `step #N`), the step's raw output lines,
//! `step failed with exit <code>` on failure, and
//! `artifact: copied dist/ -> <path>` / `artifact: no dist/ in container, skipping`
//! after a successful job.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_yaml_ng::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Config file name at the repo root (read by the parent, not here).
pub const CI_CONFIG_NAME: &str = "noite.ci.yaml";

/// A config larger than this is refused unread.
pub const MAX_CONFIG_BYTES: usize = 64 * 1024;

/// Most steps one job may carry.
pub const MAX_STEPS_PER_JOB: usize = 32;

/// Most jobs one workflow may carry.
pub const MAX_JOBS: usize = 32;

/// Longest single `run` script.
pub const MAX_RUN_BYTES: usize = 32 * 1024;

/// Longest step `name`.
pub const MAX_NAME_BYTES: usize = 512;

/// Longest `working-directory`.
pub const MAX_WORKING_DIR_BYTES: usize = 1024;

/// Most `env` entries one step may carry.
pub const MAX_ENV_VARS: usize = 256;

/// Longest single `env` value.
pub const MAX_ENV_VALUE_BYTES: usize = 64 * 1024;

/// Longest per-step `timeout-minutes`.
pub const MAX_TIMEOUT_MINUTES: u64 = 120;

/// Step timeout when the step sets no `timeout-minutes`.
pub const DEFAULT_STEP_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Cap for one logged output line; longer lines are truncated with a marker.
const MAX_LOG_LINE_BYTES: usize = 256 * 1024;

/// Cap for logged output per step; past it lines are drained, not logged.
const MAX_STEP_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// Timeout for the `docker kill` fired on a step timeout.
const KILL_TIMEOUT: Duration = Duration::from_secs(30);

/// Deploy-root directory copied back out of the container after a job.
const ARTIFACT_DIR: &str = "dist";

/// A parsed `noite.ci.yaml`: jobs in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiWorkflow {
    pub jobs: Vec<CiJob>,
}

/// One named job: one container, steps share `/work` in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiJob {
    pub name: String,
    pub image: Option<String>,
    pub steps: Vec<CiStep>,
}

/// One step: `sh -lc <run>` inside the job's container.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiStep {
    pub name: Option<String>,
    pub run: String,
    pub env: BTreeMap<String, String>,
    pub working_directory: Option<String>,
    pub timeout_minutes: Option<u64>,
    /// `uses: checkout`: accepted no-op, skipped at run time with a note.
    /// `run` is empty for these steps.
    pub checkout_noop: bool,
}

/// Container settings. The parent builds this from its own config/env
/// (docker socket, `RUNNER_CI_IMAGE`, `RUNNER_CI_IMAGES`, …).
#[derive(Debug, Clone)]
pub struct CiSettings {
    /// `docker` binary (a seam: tests point this at a fake script).
    pub docker_bin: String,
    /// Image when the job sets none.
    pub default_image: String,
    /// Exact allowlist; a job image outside it fails before any container starts.
    pub allowed_images: Vec<String>,
    /// `docker create --network`.
    pub network: String,
    /// `docker create --memory/--memory-swap` (MiB).
    pub memory_mb: u64,
    /// `docker create --cpus`.
    pub cpus: f64,
    /// Owner of `/work` inside the container; steps exec as this user.
    pub uid: u32,
    /// Group of `/work` inside the container.
    pub gid: u32,
    /// Named volume mounted at `/noite-home` (persists caches, no host path).
    pub cache_volume: String,
    /// Base container env (`-e` on create, e.g. tenant secrets from the
    /// deploy integration). `HOME=/noite-home` is appended after these, so
    /// the writable cache dir always wins and steps (exec'ing as the build
    /// uid) have a usable HOME.
    pub env: Vec<(String, String)>,
}

/// One finished step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiStepOutcome {
    pub name: Option<String>,
    pub exit_code: i32,
    pub duration: Duration,
}

/// One finished job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiJobOutcome {
    pub name: String,
    pub steps: Vec<CiStepOutcome>,
    pub success: bool,
    pub duration: Duration,
}

/// A finished workflow. `artifact_path` is the copied-back `dist/`
/// (`<work_dir>/dist`) when the run produced one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CiOutcome {
    pub jobs: Vec<CiJobOutcome>,
    pub artifact_path: Option<PathBuf>,
}

/// Everything `parse` and `run` can report.
#[derive(Debug, thiserror::Error)]
pub enum CiError {
    #[error("config is {bytes} bytes, larger than the {max}-byte cap")]
    TooLarge { bytes: usize, max: usize },
    #[error("{0}")]
    Config(String),
    #[error("job image `{0}` is not in the allowlist")]
    ImageNotAllowed(String),
    #[error("docker {argv}: {message}")]
    Docker { argv: String, message: String },
    #[error("job `{job}` step `{step}` failed with exit {code}")]
    StepFailed {
        job: String,
        step: String,
        code: i32,
    },
    #[error("job `{job}` step `{step}` exceeded its timeout of {timeout:?}")]
    StepTimeout {
        job: String,
        step: String,
        timeout: Duration,
    },
    #[error("work dir {0}: not a directory")]
    BadWorkDir(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/// Parse `noite.ci.yaml` contents. `on` is accepted and ignored; `jobs` is
/// required and keeps file order. Unknown keys are rejected with their path.
pub fn parse(contents: &str) -> Result<CiWorkflow, CiError> {
    if contents.len() > MAX_CONFIG_BYTES {
        return Err(CiError::TooLarge {
            bytes: contents.len(),
            max: MAX_CONFIG_BYTES,
        });
    }
    let value: Value = serde_yaml_ng::from_str(contents)
        .map_err(|e| CiError::Config(format!("invalid YAML: {e}")))?;
    let top = as_mapping(&value, "config")?;
    for (key, _) in top {
        let name = as_str(key, "config key")?;
        if name != "on" && name != "jobs" {
            return Err(CiError::Config(format!(
                "unknown key `{name}` (expected `on`, `jobs`)"
            )));
        }
    }
    let jobs_value = top
        .iter()
        .find_map(|(k, v)| (as_str(k, "config key").ok() == Some("jobs")).then_some(v));
    let Some(jobs_value) = jobs_value else {
        return Err(CiError::Config(
            "missing required `jobs` mapping".to_string(),
        ));
    };
    let jobs_map = as_mapping(jobs_value, "`jobs`")?;
    if jobs_map.is_empty() {
        return Err(CiError::Config("`jobs` defines no jobs".to_string()));
    }
    if jobs_map.len() > MAX_JOBS {
        return Err(CiError::Config(format!(
            "`jobs` defines {} jobs, more than the {MAX_JOBS}-job cap",
            jobs_map.len()
        )));
    }
    let mut jobs = Vec::with_capacity(jobs_map.len());
    for (key, value) in jobs_map {
        let name = as_str(key, "`jobs` key")?;
        if name.trim().is_empty() {
            return Err(CiError::Config("a job name is empty".to_string()));
        }
        jobs.push(parse_job(name, value)?);
    }
    Ok(CiWorkflow { jobs })
}

fn parse_job(name: &str, value: &Value) -> Result<CiJob, CiError> {
    let ctx = format!("jobs.{name}");
    let map = as_mapping(value, &ctx)?;
    let mut image: Option<String> = None;
    let mut steps_value: Option<&Value> = None;
    for (key, v) in map {
        let k = as_str(key, &ctx)?;
        match k {
            "image" => {
                let s = as_str(v, &format!("{ctx}.image"))?;
                if s.trim().is_empty() {
                    return Err(CiError::Config(format!("{ctx}.image is empty")));
                }
                image = Some(s.to_string());
            }
            "steps" => steps_value = Some(v),
            other => {
                return Err(CiError::Config(format!(
                    "{ctx}: unknown key `{other}` (expected `image`, `steps`)"
                )));
            }
        }
    }
    let Some(steps_value) = steps_value else {
        return Err(CiError::Config(format!("{ctx}: missing required `steps`")));
    };
    let steps_seq = as_sequence(steps_value, &format!("{ctx}.steps"))?;
    if steps_seq.is_empty() {
        return Err(CiError::Config(format!("{ctx}.steps defines no steps")));
    }
    if steps_seq.len() > MAX_STEPS_PER_JOB {
        return Err(CiError::Config(format!(
            "{ctx}.steps defines {} steps, more than the {MAX_STEPS_PER_JOB}-step cap",
            steps_seq.len()
        )));
    }
    let mut steps = Vec::with_capacity(steps_seq.len());
    for (i, step) in steps_seq.iter().enumerate() {
        steps.push(parse_step(name, i, step)?);
    }
    Ok(CiJob {
        name: name.to_string(),
        image,
        steps,
    })
}

fn parse_step(job: &str, index: usize, value: &Value) -> Result<CiStep, CiError> {
    let ctx = format!("jobs.{job}.steps[{index}]");
    let map = as_mapping(value, &ctx)?;
    let mut name: Option<String> = None;
    let mut run: Option<String> = None;
    let mut env = BTreeMap::new();
    let mut working_directory: Option<String> = None;
    let mut timeout_minutes: Option<u64> = None;
    let mut uses: Option<String> = None;
    for (key, v) in map {
        let k = as_str(key, &ctx)?;
        match k {
            "name" => {
                let s = as_str(v, &format!("{ctx}.name"))?;
                if s.len() > MAX_NAME_BYTES {
                    return Err(CiError::Config(format!(
                        "{ctx}.name is longer than the {MAX_NAME_BYTES}-byte cap"
                    )));
                }
                name = Some(s.to_string());
            }
            "run" => {
                let s = as_str(v, &format!("{ctx}.run"))?;
                if s.len() > MAX_RUN_BYTES {
                    return Err(CiError::Config(format!(
                        "{ctx}.run is longer than the {MAX_RUN_BYTES}-byte cap"
                    )));
                }
                run = Some(s.to_string());
            }
            "env" => {
                for (ek, ev) in as_mapping(v, &format!("{ctx}.env"))? {
                    let key = as_str(ek, &format!("{ctx}.env key"))?;
                    check_env_key(&ctx, key)?;
                    let val = as_env_value(ev, &format!("{ctx}.env.{key}"))?;
                    env.insert(key.to_string(), val);
                }
                if env.len() > MAX_ENV_VARS {
                    return Err(CiError::Config(format!(
                        "{ctx}.env defines more than the {MAX_ENV_VARS}-variable cap"
                    )));
                }
            }
            "working-directory" => {
                let s = as_str(v, &format!("{ctx}.working-directory"))?;
                working_directory = check_working_dir(&ctx, s)?;
            }
            "timeout-minutes" => {
                timeout_minutes = Some(parse_timeout(&ctx, v)?);
            }
            "uses" => {
                let s = as_str(v, &format!("{ctx}.uses"))?;
                uses = Some(s.to_string());
            }
            other => {
                return Err(CiError::Config(format!(
                    "{ctx}: unknown key `{other}` (expected `name`, `run`, `env`, `working-directory`, `timeout-minutes`, `uses`)"
                )));
            }
        }
    }
    if let Some(uses) = uses {
        if uses != "checkout" {
            return Err(CiError::Config(format!(
                "{ctx}: unsupported `uses: {uses}` (only `uses: checkout` is accepted, as a no-op: the worktree is already checked out)"
            )));
        }
        if run.is_some() {
            return Err(CiError::Config(format!(
                "{ctx}: a `uses: checkout` step takes no `run`"
            )));
        }
        if !env.is_empty() || working_directory.is_some() || timeout_minutes.is_some() {
            return Err(CiError::Config(format!(
                "{ctx}: a `uses: checkout` step takes only `name`"
            )));
        }
        return Ok(CiStep {
            name,
            run: String::new(),
            env: BTreeMap::new(),
            working_directory: None,
            timeout_minutes: None,
            checkout_noop: true,
        });
    }
    let Some(run) = run else {
        return Err(CiError::Config(format!("{ctx}: missing required `run`")));
    };
    if run.trim().is_empty() {
        return Err(CiError::Config(format!("{ctx}: `run` is empty")));
    }
    Ok(CiStep {
        name,
        run,
        env,
        working_directory,
        timeout_minutes,
        checkout_noop: false,
    })
}

fn parse_timeout(ctx: &str, value: &Value) -> Result<u64, CiError> {
    let err = || {
        CiError::Config(format!(
            "{ctx}.timeout-minutes must be 1..={MAX_TIMEOUT_MINUTES}"
        ))
    };
    let Value::Number(n) = value else {
        return Err(err());
    };
    let Some(m) = n.as_u64() else {
        return Err(err());
    };
    if !(1..=MAX_TIMEOUT_MINUTES).contains(&m) {
        return Err(err());
    }
    Ok(m)
}

fn check_env_key(ctx: &str, key: &str) -> Result<(), CiError> {
    let mut chars = key.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let rest_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !first_ok || !rest_ok {
        return Err(CiError::Config(format!(
            "{ctx}: env key `{key}` must match [A-Za-z_][A-Za-z0-9_]*"
        )));
    }
    if key.contains('\0') {
        return Err(CiError::Config(format!(
            "{ctx}: env key `{key}` contains NUL"
        )));
    }
    Ok(())
}

fn as_env_value(value: &Value, ctx: &str) -> Result<String, CiError> {
    let s = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => {
            return Err(CiError::Config(format!("{ctx} has no value")));
        }
        _ => {
            return Err(CiError::Config(format!(
                "{ctx} must be a string (quote it if it looks like a number or boolean)"
            )));
        }
    };
    if s.contains('\0') {
        return Err(CiError::Config(format!("{ctx} contains NUL")));
    }
    if s.len() > MAX_ENV_VALUE_BYTES {
        return Err(CiError::Config(format!(
            "{ctx} is longer than the {MAX_ENV_VALUE_BYTES}-byte cap"
        )));
    }
    Ok(s)
}

/// Best-effort `docker cp <container>:/work/dist <work>/dist`: a missing
/// `dist/` is skipped, never an error. Hands the copy to the build uid/gid
/// without following symlinks (a step could link at platform paths).
async fn copy_artifact(
    docker_bin: &str,
    container: &str,
    work: &str,
    uid: u32,
    gid: u32,
    log: impl Fn(String),
) {
    let dest = format!("{work}/{ARTIFACT_DIR}");
    let args: Vec<String> = vec![
        "cp".to_string(),
        format!("{container}:/work/{ARTIFACT_DIR}"),
        dest.clone(),
    ];
    match docker_output(docker_bin, &args).await {
        Ok(_) => {
            #[cfg(unix)]
            if !crate::host::exec::lchown_tree(Path::new(&dest), uid, gid) {
                log("artifact: copied dist/ but chown failed; continuing".to_string());
            }
            log(format!("artifact: copied dist/ -> {dest}"));
        }
        Err(e) => {
            log(format!("artifact: no dist/ in container, skipping ({e})"));
        }
    }
}
/// Normalize `working-directory`: `.`/empty means `/work` (`None`); anything
/// else must stay inside `/work` (relative, no `..`).
fn check_working_dir(ctx: &str, raw: &str) -> Result<Option<String>, CiError> {
    let err = |why: &str| CiError::Config(format!("{ctx}.working-directory {why}"));
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(None);
    }
    if trimmed.len() > MAX_WORKING_DIR_BYTES {
        return Err(err("is longer than the 1024-byte cap"));
    }
    if trimmed.contains('\0') {
        return Err(err("contains NUL"));
    }
    if trimmed.starts_with('/') {
        return Err(err(format!(
            "`{raw}` is absolute; it must be relative to /work"
        )
        .as_str()));
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(err(format!("`{raw}` escapes /work").as_str()));
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

fn as_mapping<'a>(value: &'a Value, ctx: &str) -> Result<&'a serde_yaml_ng::Mapping, CiError> {
    match value {
        Value::Mapping(m) => Ok(m),
        Value::Null => Err(CiError::Config(format!("{ctx} is empty"))),
        _ => Err(CiError::Config(format!("{ctx} must be a mapping"))),
    }
}

fn as_sequence<'a>(value: &'a Value, ctx: &str) -> Result<&'a Vec<Value>, CiError> {
    match value {
        Value::Sequence(s) => Ok(s),
        _ => Err(CiError::Config(format!("{ctx} must be a list of steps"))),
    }
}

fn as_str<'a>(value: &'a Value, ctx: &str) -> Result<&'a str, CiError> {
    match value {
        Value::String(s) => Ok(s),
        _ => Err(CiError::Config(format!("{ctx} must be a string"))),
    }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

static CONTAINER_COUNTER: AtomicU64 = AtomicU64::new(0);

fn step_timeout(step: &CiStep) -> Duration {
    step.timeout_minutes
        .map(|m| Duration::from_secs(m * 60))
        .unwrap_or(DEFAULT_STEP_TIMEOUT)
}

fn format_cpus(cpus: f64) -> String {
    if cpus.fract() == 0.0 {
        format!("{}", cpus as u64)
    } else {
        format!("{cpus}")
    }
}

fn validate_settings(settings: &CiSettings) -> Result<(), CiError> {
    if settings.docker_bin.trim().is_empty() {
        return Err(CiError::Config("docker binary path is empty".to_string()));
    }
    if settings.docker_bin.contains('\0') {
        return Err(CiError::Config(
            "docker binary path contains NUL".to_string(),
        ));
    }
    if settings.default_image.trim().is_empty() {
        return Err(CiError::Config("default image is empty".to_string()));
    }
    if settings.network.trim().is_empty() {
        return Err(CiError::Config("network is empty".to_string()));
    }
    if settings.memory_mb == 0 {
        return Err(CiError::Config("memory_mb must be nonzero".to_string()));
    }
    if !settings.cpus.is_finite() || settings.cpus <= 0.0 {
        return Err(CiError::Config(
            "cpus must be a positive number".to_string(),
        ));
    }
    if settings.cache_volume.trim().is_empty() {
        return Err(CiError::Config("cache_volume is empty".to_string()));
    }
    if settings.cache_volume.contains('\0') {
        return Err(CiError::Config("cache_volume contains NUL".to_string()));
    }
    for (key, value) in &settings.env {
        check_env_key("settings.env", key)?;
        if value.contains('\0') {
            return Err(CiError::Config(format!(
                "settings.env value for `{key}` contains NUL"
            )));
        }
        if value.len() > MAX_ENV_VALUE_BYTES {
            return Err(CiError::Config(format!(
                "settings.env value for `{key}` is longer than the {MAX_ENV_VALUE_BYTES}-byte cap"
            )));
        }
    }
    Ok(())
}

/// Run the workflow: one container per job, jobs in file order, failing fast.
/// Copies `<work_dir>/dist` back out of each successful job's container
/// (best-effort: a missing `dist/` is skipped, not an error).
pub async fn run(
    settings: &CiSettings,
    work_dir: &Path,
    workflow: &CiWorkflow,
    log: impl Fn(String),
) -> Result<CiOutcome, CiError> {
    validate_settings(settings)?;
    let work_str = work_dir
        .to_str()
        .ok_or_else(|| CiError::BadWorkDir(work_dir.to_string_lossy().into_owned()))?;
    if !tokio::fs::metadata(work_dir)
        .await
        .is_ok_and(|m| m.is_dir())
    {
        return Err(CiError::BadWorkDir(work_str.to_string()));
    }
    // Fail fast on images before any container starts.
    let mut images = Vec::with_capacity(workflow.jobs.len());
    for job in &workflow.jobs {
        let image = job.image.as_deref().unwrap_or(&settings.default_image);
        if !settings.allowed_images.iter().any(|a| a == image) {
            return Err(CiError::ImageNotAllowed(image.to_string()));
        }
        images.push(image.to_string());
    }

    let mut outcomes = Vec::with_capacity(workflow.jobs.len());
    let mut artifact_path: Option<PathBuf> = None;
    for (job, image) in workflow.jobs.iter().zip(images) {
        let outcome = run_job(settings, work_str, job, &image, &log).await?;
        if outcome.success {
            let dest = work_dir.join(ARTIFACT_DIR);
            if tokio::fs::metadata(&dest).await.is_ok_and(|m| m.is_dir()) {
                artifact_path = Some(dest);
            }
        }
        let success = outcome.success;
        outcomes.push(outcome);
        if !success {
            break;
        }
    }
    Ok(CiOutcome {
        jobs: outcomes,
        artifact_path,
    })
}

async fn run_job(
    settings: &CiSettings,
    work: &str,
    job: &CiJob,
    image: &str,
    log: impl Fn(String),
) -> Result<CiJobOutcome, CiError> {
    let id = CONTAINER_COUNTER.fetch_add(1, Ordering::Relaxed);
    let container = format!("noite-ci-{}-{id}", std::process::id());
    log(format!("job: {} ({image})", job.name));
    let started = Instant::now();
    let result = run_job_inner(settings, work, job, image, &container, &log).await;
    // The container never outlives its job, whatever happened inside.
    let _ = docker_output(
        &settings.docker_bin,
        &["rm".to_string(), "-f".to_string(), container.to_string()],
    )
    .await;
    let outcome = result?;
    log(format!("job: {} done", job.name));
    Ok(CiJobOutcome {
        name: job.name.clone(),
        steps: outcome,
        success: true,
        duration: started.elapsed(),
    })
}

async fn run_job_inner(
    settings: &CiSettings,
    work: &str,
    job: &CiJob,
    image: &str,
    container: &str,
    log: impl Fn(String),
) -> Result<Vec<CiStepOutcome>, CiError> {
    let memory = format!("{}m", settings.memory_mb);
    let cpus = format_cpus(settings.cpus);
    let cache_mount = format!("{}:/noite-home", settings.cache_volume);
    let mut create: Vec<String> = vec![
        "create".to_string(),
        "--cap-drop".to_string(),
        "ALL".to_string(),
        // The ownership prep runs as container root; CAP_CHOWN lets it hand
        // /work and the cache volume to the build uid. Steps run as that uid
        // with no capabilities, so this one never reaches tenant code.
        "--cap-add".to_string(),
        "CHOWN".to_string(),
        "--security-opt".to_string(),
        "no-new-privileges".to_string(),
        "--pids-limit".to_string(),
        "2048".to_string(),
        "--memory".to_string(),
        memory.clone(),
        "--memory-swap".to_string(),
        memory,
        "--cpus".to_string(),
        cpus,
        "--network".to_string(),
        settings.network.clone(),
        "--user".to_string(),
        "0".to_string(),
        "--name".to_string(),
        container.to_string(),
        "-v".to_string(),
        cache_mount,
    ];
    for (key, value) in &settings.env {
        create.push("-e".to_string());
        create.push(format!("{key}={value}"));
    }
    // HOME always points at the writable cache dir (last `-e HOME` wins),
    // so steps exec'ing as the build uid have a usable home.
    create.push("-e".to_string());
    create.push("HOME=/noite-home".to_string());
    create.push(image.to_string());
    create.push("sh".to_string());
    create.push("-lc".to_string());
    create.push("sleep infinity".to_string());
    docker_output(&settings.docker_bin, &create).await?;
    docker_output(
        &settings.docker_bin,
        &["start".to_string(), container.to_string()],
    )
    .await?;

    let cp_in: Vec<String> = vec![
        "cp".to_string(),
        format!("{work}/."),
        format!("{container}:/work"),
    ];
    docker_output(&settings.docker_bin, &cp_in).await?;

    let ownership = format!("{}:{}", settings.uid, settings.gid);
    let chown: Vec<String> = vec![
        "exec".to_string(),
        "-u".to_string(),
        "0".to_string(),
        container.to_string(),
        "chown".to_string(),
        "-R".to_string(),
        ownership.clone(),
        "/work".to_string(),
        "/noite-home".to_string(),
    ];
    docker_output(&settings.docker_bin, &chown).await?;

    let mut steps = Vec::with_capacity(job.steps.len());
    for (i, step) in job.steps.iter().enumerate() {
        let label = step
            .name
            .clone()
            .unwrap_or_else(|| format!("step #{}", i + 1));
        log(format!("step: {label}"));
        if step.checkout_noop {
            log(
                "uses: checkout is a no-op; the worktree is already checked out, skipping"
                    .to_string(),
            );
            steps.push(CiStepOutcome {
                name: step.name.clone(),
                exit_code: 0,
                duration: Duration::ZERO,
            });
            continue;
        }
        let timeout = step_timeout(step);
        match exec_step(settings, &job.name, &label, container, step, timeout, &log).await {
            Ok(outcome) => {
                if outcome.exit_code != 0 {
                    log(format!("step failed with exit {}", outcome.exit_code));
                    steps.push(outcome);
                    let outcome_steps = steps;
                    return Err(step_failed(&job.name, &label, &outcome_steps));
                }
                steps.push(outcome);
            }
            Err(CiError::StepTimeout { job, step, timeout }) => {
                log(format!(
                    "job `{job}` step `{step}` timed out after {timeout:?}"
                ));
                return Err(CiError::StepTimeout { job, step, timeout });
            }
            Err(e) => return Err(e),
        }
    }

    copy_artifact(
        &settings.docker_bin,
        container,
        work,
        settings.uid,
        settings.gid,
        &log,
    )
    .await;
    Ok(steps)
}

fn step_failed(job: &str, step: &str, steps: &[CiStepOutcome]) -> CiError {
    let code = steps.last().map(|s| s.exit_code).unwrap_or(-1);
    CiError::StepFailed {
        job: job.to_string(),
        step: step.to_string(),
        code,
    }
}

/// One `docker exec ... sh -lc <run>`: streams both pipes into `log`,
/// enforces `timeout` (kill on expiry), and reports the exit code.
async fn exec_step(
    settings: &CiSettings,
    job: &str,
    label: &str,
    container: &str,
    step: &CiStep,
    timeout: Duration,
    log: impl Fn(String),
) -> Result<CiStepOutcome, CiError> {
    let ownership = format!("{}:{}", settings.uid, settings.gid);
    let workdir = match &step.working_directory {
        Some(wd) => format!("/work/{wd}"),
        None => "/work".to_string(),
    };
    let mut args: Vec<String> = vec![
        "exec".to_string(),
        "--user".to_string(),
        ownership,
        "-w".to_string(),
        workdir,
    ];
    for (k, v) in &step.env {
        args.push("-e".to_string());
        args.push(format!("{k}={v}"));
    }
    args.push(container.to_string());
    args.push("sh".to_string());
    args.push("-lc".to_string());
    args.push(step.run.clone());

    let argv = args.join(" ");
    let mut child = Command::new(&settings.docker_bin)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CiError::Docker {
            argv: format!("spawn {argv}"),
            message: e.to_string(),
        })?;
    let started = Instant::now();
    let outcome = tokio::time::timeout(timeout, async {
        let stdout = child.stdout.take().expect("piped above");
        let stderr = child.stderr.take().expect("piped above");
        stream_to_log(stdout, stderr, &log).await?;
        let status = child.wait().await.map_err(|e| CiError::Docker {
            argv: argv.clone(),
            message: format!("wait: {e}"),
        })?;
        Ok::<i32, CiError>(status.code().unwrap_or(-1))
    })
    .await;
    match outcome {
        Err(_) => {
            let _ = tokio::time::timeout(
                KILL_TIMEOUT,
                docker_output(
                    &settings.docker_bin,
                    &["kill".to_string(), container.to_string()],
                ),
            )
            .await;
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(CiError::StepTimeout {
                job: job.to_string(),
                step: label.to_string(),
                timeout,
            })
        }
        Ok(Err(e)) => Err(e),
        Ok(Ok(code)) => Ok(CiStepOutcome {
            name: step.name.clone(),
            exit_code: code,
            duration: started.elapsed(),
        }),
    }
}

/// Drain both pipes concurrently into `log`. Past the per-step log cap,
/// output is still drained (so the child never blocks) but no longer logged.
async fn stream_to_log(
    stdout: impl tokio::io::AsyncRead + Unpin,
    stderr: impl tokio::io::AsyncRead + Unpin,
    log: impl Fn(String),
) -> Result<(), CiError> {
    let mut out_lines = BufReader::new(stdout).lines();
    let mut err_lines = BufReader::new(stderr).lines();
    let mut out_done = false;
    let mut err_done = false;
    let mut logged_bytes: u64 = 0;
    let push = |line: String, logged_bytes: &mut u64| {
        if *logged_bytes < MAX_STEP_LOG_BYTES {
            let mut line = line;
            if line.len() > MAX_LOG_LINE_BYTES {
                line.truncate(MAX_LOG_LINE_BYTES);
                line.push_str("…[truncated]");
            }
            *logged_bytes += line.len() as u64;
            log(line);
        }
    };
    while !out_done || !err_done {
        tokio::select! {
            line = out_lines.next_line(), if !out_done => {
                match line {
                    Ok(Some(line)) => push(line, &mut logged_bytes),
                    _ => out_done = true,
                }
            }
            line = err_lines.next_line(), if !err_done => {
                match line {
                    Ok(Some(line)) => push(line, &mut logged_bytes),
                    _ => err_done = true,
                }
            }
        }
    }
    Ok(())
}

/// Run docker to completion, returning stdout. Any failure (spawn, timeout,
/// nonzero exit) becomes [`CiError::Docker`] with the argv and stderr tail.
async fn docker_output(docker_bin: &str, args: &[String]) -> Result<String, CiError> {
    const DOCKER_TIMEOUT: Duration = Duration::from_secs(120);
    let argv = args.join(" ");
    let child = Command::new(docker_bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| CiError::Docker {
            argv: format!("spawn {docker_bin} {argv}"),
            message: e.to_string(),
        })?;
    let output = tokio::time::timeout(DOCKER_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| CiError::Docker {
            argv: format!("{docker_bin} {argv}"),
            message: "timed out after 120s".to_string(),
        })?
        .map_err(|e| CiError::Docker {
            argv: format!("{docker_bin} {argv}"),
            message: format!("wait: {e}"),
        })?;
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if stderr.len() > 2048 {
            stderr = format!("…{}", &stderr[stderr.len() - 2048..]);
        }
        return Err(CiError::Docker {
            argv: format!("{docker_bin} {argv}"),
            message: format!("exit {code}: {}", stderr.trim()),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn settings_for(script: &Path) -> CiSettings {
        CiSettings {
            docker_bin: script.to_string_lossy().into_owned(),
            default_image: "oven/bun:1.4.4".to_string(),
            allowed_images: vec!["oven/bun:1.4.4".to_string(), "oven/bun:1.4.3".to_string()],
            network: "bridge".to_string(),
            memory_mb: 512,
            cpus: 1.5,
            uid: 10030,
            gid: 10030,
            cache_volume: "noite-ci-cache-test".to_string(),
            env: vec![],
        }
    }

    fn logged() -> (Arc<Mutex<Vec<String>>>, impl Fn(String) + Clone) {
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        (lines, move |l: String| {
            sink.lock().expect("log lock").push(l);
        })
    }

    // --- parser tests ---

    #[test]
    fn valid_two_step_job() {
        let workflow = parse(
            "on: [push]\n\
             jobs:\n\
             \x20 build:\n\
             \x20\x20 image: oven/bun:1.4.4\n\
             \x20\x20 steps:\n\
             \x20\x20\x20 - name: Install\n\
             \x20\x20\x20\x20\x20 run: bun install --frozen-lockfile\n\
             \x20\x20\x20 - name: Build\n\
             \x20\x20\x20\x20\x20 run: bun run build\n\
             \x20\x20\x20\x20\x20 env: { NODE_ENV: production }\n\
             \x20\x20\x20\x20\x20 working-directory: .\n\
             \x20\x20\x20\x20\x20 timeout-minutes: 10\n",
        )
        .expect("parses");
        assert_eq!(workflow.jobs.len(), 1);
        let job = &workflow.jobs[0];
        assert_eq!(job.name, "build");
        assert_eq!(job.image.as_deref(), Some("oven/bun:1.4.4"));
        assert_eq!(job.steps.len(), 2);
        assert_eq!(job.steps[0].name.as_deref(), Some("Install"));
        assert_eq!(job.steps[0].run, "bun install --frozen-lockfile");
        let build = &job.steps[1];
        assert_eq!(
            build.env.get("NODE_ENV").map(String::as_str),
            Some("production")
        );
        assert_eq!(build.working_directory, None);
        assert_eq!(build.timeout_minutes, Some(10));
        assert!(!build.checkout_noop);
    }

    #[test]
    fn jobs_keep_file_order() {
        let workflow = parse(
            "jobs:\n\
             \x20 zebra:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - run: echo z\n\
             \x20 alpha:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - run: echo a\n\
             \x20 mango:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - run: echo m\n",
        )
        .expect("parses");
        let names: Vec<&str> = workflow.jobs.iter().map(|j| j.name.as_str()).collect();
        assert_eq!(names, vec!["zebra", "alpha", "mango"]);
    }

    #[test]
    fn env_values_coerce_scalars() {
        let workflow = parse(
            "jobs:\n  build:\n    steps:\n      - run: echo hi\n        env:\n          PORT: 8080\n          DEBUG: true\n          RATIO: 1.5\n",
        )
        .expect("parses");
        let env = &workflow.jobs[0].steps[0].env;
        assert_eq!(env.get("PORT").map(String::as_str), Some("8080"));
        assert_eq!(env.get("DEBUG").map(String::as_str), Some("true"));
        assert_eq!(env.get("RATIO").map(String::as_str), Some("1.5"));
    }

    #[test]
    fn working_directory_forms() {
        let workflow = parse(
            "jobs:\n  build:\n    steps:\n      - run: echo a\n        working-directory: packages/app\n      - run: echo b\n        working-directory: ./nested//dir/\n",
        )
        .expect("parses");
        assert_eq!(
            workflow.jobs[0].steps[0].working_directory.as_deref(),
            Some("packages/app")
        );
        assert_eq!(
            workflow.jobs[0].steps[1].working_directory.as_deref(),
            Some("nested/dir")
        );
    }

    #[test]
    fn rejects_unknown_keys_with_paths() {
        let err =
            parse("bogus: 1\njobs:\n\x20 a:\n\x20\x20\x20 steps:\n\x20\x20\x20\x20 - run: x\n")
                .expect_err("top-level key");
        assert!(err.to_string().contains("unknown key `bogus`"), "{err}");

        let err = parse(
            "jobs:\n\x20 a:\n\x20\x20 runs-on: ubuntu\n\x20\x20 steps:\n\x20\x20\x20 - run: x\n",
        )
        .expect_err("job key");
        assert!(
            err.to_string().contains("jobs.a: unknown key `runs-on`"),
            "{err}"
        );

        let err = parse("jobs:\n\x20 a:\n\x20\x20 steps:\n\x20\x20\x20 - shell: bash\n\x20\x20\x20\x20\x20 run: x\n")
            .expect_err("step key");
        assert!(err.to_string().contains("unknown key `shell`"), "{err}");
    }

    #[test]
    fn rejects_oversize_config() {
        let big = format!(
            "jobs:\n\x20 a:\n\x20\x20\x20 steps:\n\x20\x20\x20\x20 - run: {}\n",
            "x".repeat(70 * 1024)
        );
        let err = parse(&big).expect_err("oversize");
        assert!(matches!(err, CiError::TooLarge { .. }), "{err}");
    }

    #[test]
    fn rejects_empty_shapes() {
        assert!(parse("jobs: {}\n").is_err(), "empty jobs map");
        assert!(parse("on: push\n").is_err(), "missing jobs mapping");
        let err = parse("jobs:\n\x20 a:\n\x20\x20 steps: []\n").expect_err("empty steps");
        assert!(err.to_string().contains("defines no steps"), "{err}");
        let err = parse("jobs:\n\x20 a:\n\x20\x20 steps:\n\x20\x20\x20 - name: No run\n")
            .expect_err("missing run");
        assert!(err.to_string().contains("missing required `run`"), "{err}");
        let err = parse("jobs:\n\x20 a:\n\x20\x20 steps:\n\x20\x20\x20 - run: '   '\n")
            .expect_err("blank run");
        assert!(err.to_string().contains("`run` is empty"), "{err}");
    }

    #[test]
    fn rejects_too_many_steps() {
        let mut cfg = "jobs:\n\x20 a:\n\x20\x20\x20 steps:\n".to_string();
        for i in 0..33 {
            cfg.push_str(&format!("\x20\x20\x20\x20 - run: echo {i}\n"));
        }
        let err = parse(&cfg).expect_err("33 steps");
        assert!(
            err.to_string().contains("more than the 32-step cap"),
            "{err}"
        );
    }

    #[test]
    fn uses_checkout_is_noop_and_uses_marketplace_rejected() {
        let workflow = parse(
            "jobs:\n\
             \x20 build:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - uses: checkout\n\
             \x20\x20\x20\x20 - run: echo hi\n",
        )
        .expect("parses");
        assert!(workflow.jobs[0].steps[0].checkout_noop);
        assert!(!workflow.jobs[0].steps[1].checkout_noop);

        let err = parse(
            "jobs:\n\
             \x20 build:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - uses: actions/setup-node@v4\n",
        )
        .expect_err("marketplace uses");
        assert!(
            err.to_string()
                .contains("unsupported `uses: actions/setup-node@v4`"),
            "{err}"
        );

        let err =
            parse("jobs:\n  build:\n    steps:\n      - uses: checkout\n        run: echo hi\n")
                .expect_err("uses mixed with run");
        assert!(err.to_string().contains("takes no `run`"), "{err}");
    }

    #[test]
    fn rejects_bad_timeouts_env_and_dirs() {
        for bad in [
            "timeout-minutes: 0",
            "timeout-minutes: 999",
            "timeout-minutes: fast",
            "timeout-minutes: 1.5",
        ] {
            let cfg = format!("jobs:\n  a:\n    steps:\n      - run: x\n        {bad}\n");
            assert!(parse(&cfg).is_err(), "{bad}");
        }
        for bad in ["FOO-BAR: 1", "1ABC: 1", "has space: 1"] {
            let cfg =
                format!("jobs:\n  a:\n    steps:\n      - run: x\n        env:\n          {bad}\n");
            let err = parse(&cfg).expect_err(format!("env {bad}").as_str());
            assert!(err.to_string().contains("must match"), "{err}");
        }
        for bad in ["/abs", "../escape", "a/../../b"] {
            let cfg = format!(
                "jobs:\n  a:\n    steps:\n      - run: x\n        working-directory: {bad}\n"
            );
            assert!(parse(&cfg).is_err(), "{bad}");
        }
    }

    // --- engine tests (fake docker) ---

    /// Write a fake `docker` CLI into a fresh temp dir. Behavior is driven by
    /// files next to the script (no env mutation, so tests stay parallel):
    /// `step-exit` (exit code), `step-sleep` (seconds to sleep in exec),
    /// `step-stdout` (lines printed by step exec), `no-artifact` (cp-out
    /// of dist/ fails). Every invocation appends its argv, one arg per line
    /// plus a `---` separator, to `argv.log`.
    fn fake_docker() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "noite-ci-fake-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let script = dir.join("docker");
        std::fs::write(
            &script,
            r#"#!/bin/sh
DIR=$(dirname "$0")
{
printf -- '---\n'
printf '%s\n' "$@"
} >> "$DIR/argv.log"
cmd=$1
shift
case "$cmd" in
  create) echo "fake-container-id"; exit 0;;
  start|rm|kill) exit 0;;
  cp)
    case "$1" in
      *":/work/dist")
        if [ -e "$DIR/no-artifact" ]; then echo "no such file or directory" >&2; exit 1; fi
        mkdir -p "$2" && echo "fake-dist" > "$2/from-ci.txt"
        exit 0;;
      *) exit 0;;
    esac;;
  exec)
    case "$*" in
      *chown*) exit 0;;
    esac
    if [ -e "$DIR/step-stdout" ]; then cat "$DIR/step-stdout"; fi
    if [ -e "$DIR/step-sleep" ]; then sleep "$(cat "$DIR/step-sleep")"; fi
    if [ -e "$DIR/step-exit" ]; then exit "$(cat "$DIR/step-exit")"; fi
    exit 0;;
  *) echo "unexpected: $cmd" >&2; exit 99;;
esac
"#,
        )
        .expect("write fake docker");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        script
    }

    fn argv_log(script: &Path) -> Vec<Vec<String>> {
        let log = script.parent().expect("parent").join("argv.log");
        let text = std::fs::read_to_string(log).unwrap_or_default();
        text.split("\n---\n")
            .filter_map(|block| {
                let args: Vec<String> = block
                    .lines()
                    .filter(|l| *l != "---" && !l.is_empty())
                    .map(str::to_string)
                    .collect();
                (!args.is_empty()).then_some(args)
            })
            .collect()
    }

    fn test_workflow() -> CiWorkflow {
        parse(
            "jobs:\n  build:\n    steps:\n      - name: Install\n        run: bun install\n        env: { NODE_ENV: production }\n        working-directory: packages/app\n      - run: bun run build\n",
        )
        .expect("test workflow parses")
    }

    fn work_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "noite-ci-work-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("work dir");
        std::fs::write(dir.join("index.ts"), "export {};\n").expect("seed file");
        dir
    }

    #[tokio::test]
    async fn engine_builds_exact_argv_and_copies_artifact() {
        let script = fake_docker();
        let work = work_dir("argv");
        let (lines, log) = logged();
        let outcome = run(&settings_for(&script), &work, &test_workflow(), log)
            .await
            .expect("fake run succeeds");

        let invocations = argv_log(&script);
        let verbs: Vec<&str> = invocations.iter().map(|a| a[0].as_str()).collect();
        assert_eq!(
            verbs,
            vec!["create", "start", "cp", "exec", "exec", "exec", "cp", "rm"]
        );

        let create = &invocations[0];
        assert_eq!(
            create,
            &vec![
                "create",
                "--cap-drop",
                "ALL",
                "--cap-add",
                "CHOWN",
                "--security-opt",
                "no-new-privileges",
                "--pids-limit",
                "2048",
                "--memory",
                "512m",
                "--memory-swap",
                "512m",
                "--cpus",
                "1.5",
                "--network",
                "bridge",
                "--user",
                "0",
                "--name",
                create[20].as_str(),
                "-v",
                "noite-ci-cache-test:/noite-home",
                "-e",
                "HOME=/noite-home",
                "oven/bun:1.4.4",
                "sh",
                "-lc",
                "sleep infinity",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>(),
        );
        assert!(
            create[20].starts_with("noite-ci-"),
            "container name: {}",
            create[20]
        );

        let container = create[20].clone();
        assert_eq!(invocations[1], vec!["start".to_string(), container.clone()]);
        assert_eq!(
            invocations[2],
            vec![
                "cp".to_string(),
                format!("{}/.", work.to_string_lossy()),
                format!("{container}:/work"),
            ]
        );
        assert_eq!(
            invocations[3],
            vec![
                "exec",
                "-u",
                "0",
                container.as_str(),
                "chown",
                "-R",
                "10030:10030",
                "/work",
                "/noite-home"
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>(),
        );
        // Step 1 carries env and the working directory; both steps end in sh -lc <run>.
        let step1 = &invocations[4];
        assert_eq!(
            &step1[0..6],
            &[
                "exec",
                "--user",
                "10030:10030",
                "-w",
                "/work/packages/app",
                "-e"
            ]
        );
        assert_eq!(step1[6], "NODE_ENV=production");
        assert_eq!(
            &step1[7..11],
            &[
                container.clone(),
                "sh".to_string(),
                "-lc".to_string(),
                "bun install".to_string()
            ]
        );
        let step2 = &invocations[5];
        assert_eq!(
            &step2[0..4],
            &[
                "exec".to_string(),
                "--user".to_string(),
                "10030:10030".to_string(),
                "-w".to_string()
            ],
        );
        assert_eq!(step2[4], "/work");
        assert_eq!(
            &step2[5..8],
            &[container.clone(), "sh".to_string(), "-lc".to_string()]
        );
        assert_eq!(step2[8], "bun run build");
        // Artifact copied back out, container always removed.
        assert_eq!(
            invocations[6],
            vec![
                "cp".to_string(),
                format!("{container}:/work/dist"),
                format!("{}/dist", work.to_string_lossy()),
            ]
        );
        assert_eq!(
            invocations[7],
            vec!["rm".to_string(), "-f".to_string(), container.clone()]
        );

        // Outcome + artifact + log lines.
        assert_eq!(outcome.jobs.len(), 1);
        assert!(outcome.jobs[0].success);
        assert_eq!(outcome.jobs[0].steps.len(), 2);
        assert!(outcome.jobs[0].steps.iter().all(|s| s.exit_code == 0));
        let artifact = outcome.artifact_path.clone().expect("artifact path");
        assert_eq!(artifact, work.join("dist"));
        assert!(artifact.join("from-ci.txt").exists());
        let lines = lines.lock().expect("log lock");
        assert!(
            lines.iter().any(|l| l == "job: build (oven/bun:1.4.4)"),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l == "step: Install"), "{lines:?}");
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with("artifact: copied dist/")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn engine_streams_step_output_and_uses_custom_image() {
        let script = fake_docker();
        std::fs::write(
            script.parent().expect("parent").join("step-stdout"),
            "hello\nworld\n",
        )
        .expect("stdout");
        let work = work_dir("stream");
        let workflow =
            parse("jobs:\n  build:\n    image: oven/bun:1.4.3\n    steps:\n      - run: echo hi\n")
                .expect("parses");
        let (lines, log) = logged();
        let outcome = run(&settings_for(&script), &work, &workflow, log)
            .await
            .expect("succeeds");
        assert!(outcome.jobs[0].success);
        let lines = lines.lock().expect("log lock");
        assert!(
            lines.iter().any(|l| l == "job: build (oven/bun:1.4.3)"),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l == "step: step #1"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "hello"), "{lines:?}");
        assert!(lines.iter().any(|l| l == "world"), "{lines:?}");
    }

    #[tokio::test]
    async fn engine_passes_base_env_and_home_on_create() {
        let script = fake_docker();
        let work = work_dir("baseenv");
        let mut settings = settings_for(&script);
        settings.env = vec![
            ("FOO".to_string(), "bar".to_string()),
            ("HOME".to_string(), "/bogus".to_string()),
        ];
        let workflow =
            parse("jobs:\n  build:\n    steps:\n      - run: echo hi\n").expect("parses");
        let (_lines, log) = logged();
        run(&settings, &work, &workflow, log)
            .await
            .expect("succeeds");
        let invocations = argv_log(&script);
        let create = &invocations[0];
        assert_eq!(create[0], "create");
        let image_pos = create
            .iter()
            .position(|a| a == "oven/bun:1.4.4")
            .expect("image in create");
        // Tenant env in order, then HOME=/noite-home last so the writable
        // cache dir wins over a tenant HOME.
        assert_eq!(
            &create[image_pos - 6..image_pos],
            &[
                "-e".to_string(),
                "FOO=bar".to_string(),
                "-e".to_string(),
                "HOME=/bogus".to_string(),
                "-e".to_string(),
                "HOME=/noite-home".to_string(),
            ]
        );

        // A bad base-env key fails validation before docker is invoked.
        let script = fake_docker();
        let work = work_dir("badenv");
        let mut settings = settings_for(&script);
        settings.env = vec![("BAD-KEY".to_string(), "x".to_string())];
        let (_lines, log) = logged();
        let err = run(&settings, &work, &workflow, log)
            .await
            .expect_err("bad env key");
        assert!(err.to_string().contains("must match"), "{err}");
        assert!(
            !script.parent().expect("parent").join("argv.log").exists(),
            "docker never invoked"
        );
    }

    #[tokio::test]
    async fn engine_fails_job_on_nonzero_exit_and_still_cleans_up() {
        let script = fake_docker();
        std::fs::write(script.parent().expect("parent").join("step-exit"), "3").expect("exit");
        let work = work_dir("fail");
        let (lines, log) = logged();
        let err = run(&settings_for(&script), &work, &test_workflow(), log)
            .await
            .expect_err("step fails");
        assert!(matches!(err, CiError::StepFailed { code: 3, .. }), "{err}");
        assert!(err.to_string().contains("step `Install`"), "{err}");
        // Both the failing step and cleanup ran; the second step never did.
        let invocations = argv_log(&script);
        let verbs: Vec<&str> = invocations.iter().map(|a| a[0].as_str()).collect();
        assert_eq!(verbs, vec!["create", "start", "cp", "exec", "exec", "rm"]);
        assert_eq!(
            invocations.last().expect("rm")[0..2],
            vec!["rm".to_string(), "-f".to_string()]
        );
        let lines = lines.lock().expect("log lock");
        assert!(
            lines.iter().any(|l| l == "step failed with exit 3"),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn engine_kills_container_on_step_timeout() {
        // Call the step layer directly with a tiny timeout: `timeout-minutes`
        // cannot express milliseconds, and the resolution is covered below.
        let script = fake_docker();
        std::fs::write(script.parent().expect("parent").join("step-sleep"), "30").expect("sleep");
        let settings = settings_for(&script);
        let step = CiStep {
            name: Some("Hang".to_string()),
            run: "sleep 30".to_string(),
            env: BTreeMap::new(),
            working_directory: None,
            timeout_minutes: None,
            checkout_noop: false,
        };
        let (_lines, log) = logged();
        let err = exec_step(
            &settings,
            "probe",
            "Hang",
            "noite-ci-timeout-probe",
            &step,
            Duration::from_millis(200),
            log,
        )
        .await
        .expect_err("times out");
        assert!(matches!(err, CiError::StepTimeout { .. }), "{err}");
        let invocations = argv_log(&script);
        let verbs: Vec<&str> = invocations.iter().map(|a| a[0].as_str()).collect();
        assert!(verbs.contains(&"kill"), "kill fired: {verbs:?}");
    }

    #[test]
    fn step_timeout_resolution() {
        let plain = CiStep {
            name: None,
            run: "x".to_string(),
            env: BTreeMap::new(),
            working_directory: None,
            timeout_minutes: None,
            checkout_noop: false,
        };
        assert_eq!(step_timeout(&plain), DEFAULT_STEP_TIMEOUT);
        let capped = CiStep {
            timeout_minutes: Some(3),
            ..plain
        };
        assert_eq!(step_timeout(&capped), Duration::from_secs(180));
    }

    #[tokio::test]
    async fn engine_rejects_disallowed_image_without_touching_docker() {
        let script = fake_docker();
        let work = work_dir("allowlist");
        let workflow = parse(
            "jobs:\n  build:\n    image: evil/thing:latest\n    steps:\n      - run: echo hi\n",
        )
        .expect("parses");
        let (_lines, log) = logged();
        let err = run(&settings_for(&script), &work, &workflow, log)
            .await
            .expect_err("allowlist");
        assert!(matches!(err, CiError::ImageNotAllowed(_)), "{err}");
        assert!(
            !script.parent().expect("parent").join("argv.log").exists(),
            "docker never invoked"
        );
    }

    #[tokio::test]
    async fn engine_skips_missing_artifact_and_checkout_noop() {
        let script = fake_docker();
        std::fs::write(script.parent().expect("parent").join("no-artifact"), "").expect("flag");
        let work = work_dir("skip");
        let workflow = parse(
            "jobs:\n\
             \x20 build:\n\
             \x20\x20\x20 steps:\n\
             \x20\x20\x20\x20 - uses: checkout\n\
             \x20\x20\x20\x20 - run: echo hi\n",
        )
        .expect("parses");
        let (lines, log) = logged();
        let outcome = run(&settings_for(&script), &work, &workflow, log)
            .await
            .expect("succeeds");
        assert!(outcome.artifact_path.is_none());
        assert_eq!(outcome.jobs[0].steps.len(), 2);
        assert_eq!(outcome.jobs[0].steps[0].exit_code, 0);
        // No exec for the checkout no-op: create/start/cp-in/chown/exec/cp-out/rm.
        let invocations = argv_log(&script);
        let verbs: Vec<&str> = invocations.iter().map(|a| a[0].as_str()).collect();
        assert_eq!(
            verbs,
            vec!["create", "start", "cp", "exec", "exec", "cp", "rm"]
        );
        let lines = lines.lock().expect("log lock");
        assert!(
            lines
                .iter()
                .any(|l| l.contains("uses: checkout is a no-op")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|l| l.contains("no dist/ in container, skipping")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn real_docker_runs_two_steps_sharing_state() {
        let workflow = parse(
            "jobs:\n  build:\n    steps:\n      - name: Write\n        run: echo hello > msg.txt && mkdir -p dist && echo page > dist/index.html\n      - name: Read\n        run: cat msg.txt\n",
        )
        .expect("parses");
        // Opt-in: the real-container path pulls an image and needs a
        // working Docker daemon; CI stays hermetic and runs it only when
        // asked (`NOITE_CI_REAL_DOCKER=1` on a host with Docker).
        if std::env::var_os("NOITE_CI_REAL_DOCKER").is_none() {
            eprintln!("skipping: set NOITE_CI_REAL_DOCKER=1 to run real containers");
            return;
        }
        if std::process::Command::new("docker")
            .arg("info")
            .output()
            .is_ok_and(|o| !o.status.success())
        {
            eprintln!("skipping: `docker info` failed");
            return;
        }
        if std::process::Command::new("docker")
            .arg("info")
            .output()
            .is_err()
        {
            eprintln!("skipping: no docker binary");
            return;
        }
        let work = work_dir("real");
        let settings = CiSettings {
            docker_bin: "docker".to_string(),
            default_image: "oven/bun:1.4.4".to_string(),
            allowed_images: vec!["oven/bun:1.4.4".to_string()],
            network: "bridge".to_string(),
            memory_mb: 512,
            cpus: 1.0,
            uid: 1000,
            gid: 1000,
            cache_volume: format!("noite-ci-cache-real-{}", std::process::id()),
            env: vec![],
        };
        let (lines, log) = logged();
        let outcome = run(&settings, &work, &workflow, log)
            .await
            .expect("real run succeeds");
        assert!(outcome.jobs[0].success);
        let lines = lines.lock().expect("log lock");
        assert!(lines.iter().any(|l| l == "hello"), "{lines:?}");
        let artifact = outcome.artifact_path.expect("artifact");
        assert!(artifact.join("index.html").exists());
    }
}
