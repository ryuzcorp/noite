//! Runner-owned cohosted scripts (SPEC, Void platform proxy): the one
//! reusable mechanism that deploys extra Worker scripts into a fleet before
//! the tenant app.
//!
//! A Void fleet carries the tenant app plus runner-owned scripts —
//! `noite-void-proxy` ([`super::void_proxy`]) and, for Void apps with a
//! managed sandbox, `noite-void-sandbox` ([`super::void_sandbox`]) — each
//! with its sources and a per-fleet rendered config. Every script of a
//! generation is staged first with `celld deploy --no-activate` — the
//! cohosted scripts in [`CohostedScript::order`] (lowest first), the tenant
//! app last — and one `celld activate SCRIPT=VERSION...` then serves the
//! whole generation with a single atomic fleet-pointer write, after which
//! the one `/reload` (whose outcome the deploy already checks) adopts it.
//! A later script only adds its [`CohostedScript`] and its render: the
//! order, the skip rule and the invocation below stay untouched.
//!
//! Skip-when-unchanged: the bundle and rendered config are the runner's
//! own, so a script whose [`RenderedCohost::content_hash`] matches the
//! stored one (per fleet, the `void_cohost_hash` table) is not re-staged:
//! the activate does not name it and its activated version carries into
//! the generation. Steady state is one app stage plus the one activate.
//! The hash covers the sources and the rendered config with secret values
//! substituted by their hashes, so a rotation re-stages the script while
//! the stored row holds a digest only — never a secret. Per-deploy
//! container-image paths are excluded from the hash (their stable content
//! rides [`RenderedCohost::extra_hash_input`]), so identical content in
//! another build dir still skips.
//!
//! Failure handling: staged versions move no pointer and are invisible to
//! serving, so a failed stage — cohosted or app, tenant or infra — runs no
//! activate and the previous generation keeps serving. Tenant-code failures
//! are pre-pointer (celld bundles before writing anything) and fail at
//! once, with no retry; anything reading as infra (S3/CAS errors, timeouts,
//! a lost pointer race) retries once ([`run_with_infra_retry`], idempotent
//! both ways — content-versioned stages, an activate that reports unchanged
//! when its generation already committed); anything else fails loudly.
//! Stored hashes name activated content — written only after the activate
//! commits — so the next deploy heals by staging again from the same
//! content.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db;
use crate::host::exec;

/// One embedded source file: its path inside the deploy project and its
/// bytes. Paths are relative and never escape the project root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CohostSource {
    pub path: &'static str,
    pub contents: &'static str,
}

/// One runtime-loaded source file: the same shape as [`CohostSource`] with
/// owned bytes, for scripts whose bundle is built outside the runner
/// compile (the sandbox controller's image-build bundle, read from disk at
/// deploy time). Written and hashed exactly like an embedded source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeSource {
    pub path: String,
    pub contents: Vec<u8>,
}

/// A runner-owned script: its celld identity, its embedded sources, and
/// its place in the deploy order (lowest first; the tenant app always
/// deploys last, after every cohosted script).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CohostedScript {
    pub name: &'static str,
    pub main: &'static str,
    pub sources: &'static [CohostSource],
    pub order: u32,
}

/// One script's rendered deploy project: the script, its `wrangler.json`,
/// and the names of the vars holding secrets. Secret values are
/// substituted by their hashes for the content hash, so a rotation
/// redeploys the script without the secret itself entering the digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedCohost {
    pub script: &'static CohostedScript,
    pub secret_vars: &'static [&'static str],
    pub config: Value,
    /// Runtime-loaded sources, written beside the embedded ones and hashed
    /// in order after them. Empty for fully-embedded scripts like the proxy.
    pub extra_sources: Vec<RuntimeSource>,
    /// Extra content-hash inputs beyond sources and config: the sandbox
    /// render feeds its image digest composite here, so an image change
    /// redeploys the script even though the config's `image` string (a
    /// per-deploy pinned path) is excluded from the hash. Empty for
    /// scripts whose config carries every input.
    pub extra_hash_input: Vec<u8>,
    /// Whether the rendered config declares containers: such a script gets
    /// the container deploy timeout (a first image pull), like the app.
    pub declares_containers: bool,
    /// The directory `celld deploy --read-root` admits beyond the staging
    /// dir: the sandbox controller's vetted build context, which holds its
    /// pinned Dockerfile. `None` for scripts that read nothing outside.
    pub read_root: Option<PathBuf>,
}

/// The `celld deploy` timeout for a script whose config declares
/// containers: a first image pull dwarfs the 120 s default. The tenant app
/// uses the same bound (see the ordered deploy in [`super::deploy`]).
pub const CONTAINER_DEPLOY_TIMEOUT: Duration = Duration::from_secs(600);

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Strip per-deploy container-image paths from a config copy before
/// hashing: a Dockerfile entry's `image` is the pinned file's absolute
/// path (`/data/runner/builds/<slug>/<timestamp>/…`), which differs on
/// every deploy while the content is identical — hashing it redeploys the
/// script (and its fence image) every time and lets two concurrent
/// deploys race celld's fence-image build. The stable content — pinned
/// Dockerfile bytes plus build-context digest — rides `extra_hash_input`
/// instead, so the path carries no signal. Digest-pinned registry refs
/// are stable content and stay hashed, as does everything outside
/// `containers[]`: only absolute-path strings (refs never start with
/// `/`) and the path-valued `dockerfile`/`build_context` keys go.
fn normalize_container_paths(config: &mut Value) {
    /// Strip the per-deploy paths from one entry-shaped object.
    fn strip(entry: &mut serde_json::Map<String, Value>) {
        entry.remove("dockerfile");
        entry.remove("build_context");
        if entry
            .get("image")
            .and_then(Value::as_str)
            .is_some_and(|image| image.starts_with('/'))
        {
            entry.remove("image");
        }
    }
    let Some(entries) = config.get_mut("containers").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in entries {
        let Some(entry) = entry.as_object_mut() else {
            continue;
        };
        strip(entry);
        // Planned values never carry `images` (planning normalizes it
        // away), but a direct render caller might — same rule there.
        if let Some(default) = entry
            .get_mut("images")
            .and_then(|images| images.get_mut("default"))
            .and_then(Value::as_object_mut)
        {
            strip(default);
        }
    }
}

impl RenderedCohost {
    /// The `wrangler.json` written beside the sources.
    pub fn config_json(&self) -> anyhow::Result<String> {
        serde_json::to_string_pretty(&self.config).map_err(anyhow::Error::from)
    }

    /// The skip-when-unchanged digest: SHA-256 over the source paths and
    /// bytes in order (embedded sources, then runtime ones), then the
    /// extra hash input, then the rendered config with every secret var's
    /// value substituted by its hash and per-deploy container-image paths
    /// excluded ([`normalize_container_paths`]). Deterministic: same
    /// inputs, same digest — and any source, config, image or secret
    /// change flips it.
    pub fn content_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        for source in self.script.sources {
            hasher.update(source.path.as_bytes());
            hasher.update([0]);
            hasher.update(source.contents.as_bytes());
            hasher.update([0]);
        }
        for source in &self.extra_sources {
            hasher.update(source.path.as_bytes());
            hasher.update([0]);
            hasher.update(&source.contents);
            hasher.update([0]);
        }
        hasher.update(&self.extra_hash_input);
        let mut config = self.config.clone();
        if let Some(vars) = config.get_mut("vars").and_then(Value::as_object_mut) {
            for name in self.secret_vars {
                let digest = vars
                    .get(*name)
                    .and_then(Value::as_str)
                    .map(|value| sha256_hex(value.as_bytes()));
                if let Some(digest) = digest {
                    vars.insert((*name).to_string(), Value::String(digest));
                }
            }
        }
        normalize_container_paths(&mut config);
        // `serde_json::Map` without `preserve_order` is a `BTreeMap`: keys
        // serialize sorted, so this is canonical across renders.
        hasher.update(
            serde_json::to_string(&config)
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }

    /// Write the deploy project: every embedded and runtime-loaded source
    /// at its path plus the rendered `wrangler.json`. Embedded paths are
    /// compile-time constants from the script's own module, but a path
    /// escaping the root is still refused — a deploy project that writes
    /// outside itself is never run.
    pub fn write_project(&self, dir: &Path) -> anyhow::Result<()> {
        use std::path::Component;
        std::fs::create_dir_all(dir)?;
        let write_source = |dir: &Path, path: &str, contents: &[u8]| -> anyhow::Result<()> {
            // A lexical `starts_with` cannot see through `..` (`join` never
            // normalizes), so the path itself must be all normal components.
            let inside = Path::new(path)
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
            if !inside {
                anyhow::bail!(
                    "cohosted script `{}` source path {:?} escapes its project",
                    self.script.name,
                    path
                );
            }
            let target = dir.join(path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, contents)?;
            Ok(())
        };
        for source in self.script.sources {
            write_source(dir, source.path, source.contents.as_bytes())?;
        }
        for source in &self.extra_sources {
            write_source(dir, &source.path, &source.contents)?;
        }
        std::fs::write(dir.join("wrangler.json"), self.config_json()?)?;
        Ok(())
    }
}

/// What the fleet's `celld` invocations need: the binary, the fleet bucket
/// and the env. One value serves the staged deploys and the one activate
/// alike — same binary, same bucket, same invocation shape.
#[derive(Clone, Copy)]
pub struct CelldDeploy<'a> {
    pub celld_bin: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub bucket: &'a str,
    pub endpoint: &'a str,
    pub region: &'a str,
    pub timeout: Duration,
    /// Where `celld deploy --sourcemap` writes the bundled Worker's external
    /// map. Set for the tenant app only: cohosted scripts are runner-owned
    /// and need no symbolication, so their stage forces this to `None`.
    pub sourcemap: Option<&'a Path>,
}

/// One staged script version: celld's script name and deployment version,
/// as `celld deploy --no-activate --json` printed them. The pair is what
/// the one `celld activate` names as `SCRIPT=VERSION`.
pub struct StagedVersion {
    pub worker: String,
    pub version: String,
}

/// celld's script-name rule (`deploy.rs` `valid_script_name`, pinned
/// celld): at most 63 bytes of lowercase ASCII letters, digits and
/// internal hyphens.
fn valid_worker_name(name: &str) -> bool {
    name.len() <= 63
        && name
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name
            .bytes()
            .last()
            .is_some_and(|last| last.is_ascii_lowercase() || last.is_ascii_digit())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Parse `celld deploy --no-activate --json` stdout: one JSON object
/// (`fleet.rs` `Deployed` — stdout carries the datum, the narrative goes to
/// stderr). The version is validated — the 16-lowercase-hex deployment
/// version `activate` expects (`deploy.rs` `parse_version_ref`) — and the
/// worker against celld's script-name rule, so a malformed row fails the
/// deploy here instead of reaching `activate` as a corrupt `SCRIPT=VERSION`
/// (a leading-`-` name would otherwise parse as a flag there).
fn parse_staged_version(stdout: &str) -> anyhow::Result<StagedVersion> {
    let row: Value = serde_json::from_str(stdout)
        .with_context(|| format!("parse staged deploy output: {stdout:?}"))?;
    let worker = row
        .get("worker")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version = row
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    anyhow::ensure!(
        valid_worker_name(worker),
        "staged deploy output names no valid worker: {stdout:?}"
    );
    let hex16 = version.len() == 16
        && version
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    anyhow::ensure!(
        hex16,
        "staged deploy output carries no 16-hex version: {stdout:?}"
    );
    // A celld that accepted `--no-activate` without staging would move the
    // pointer here and silently reopen the window this sequence closes.
    anyhow::ensure!(
        row.get("staged").and_then(Value::as_bool) == Some(true)
            && row.get("dry_run").and_then(Value::as_bool) == Some(false),
        "staged deploy output does not report a staged version: {stdout:?}"
    );
    Ok(StagedVersion {
        worker: worker.to_string(),
        version: version.to_string(),
    })
}

/// One `celld` invocation — a stage or the activate — retried once when the
/// failure reads as infra (S3/CAS errors, timeouts, a lost pointer race
/// whose error says to re-run: this retry IS the re-run —
/// [`is_tenant_error`] decides). Both commands are idempotent
/// (content-versioned stages; an activate whose generation already committed
/// reports unchanged), so the retry is safe. Returns the attempt count and
/// the command's stdout: 1, or 2 when the retry ran. Tenant failures return
/// at once, unretried; a twice-failed command carries both attempts'
/// errors. The stages and the activate share this — one classification, one
/// retry.
async fn run_with_infra_retry(
    celld: &CelldDeploy<'_>,
    args: &[&str],
    cwd: Option<&Path>,
) -> anyhow::Result<(u32, String)> {
    let subcommand = args.first().copied().unwrap_or("celld");
    match exec::run_cmd(celld.celld_bin, args, cwd, celld.env, celld.timeout).await {
        Ok(stdout) => Ok((1, stdout)),
        Err(first) => {
            if is_tenant_error(&format!("{:#}", first)) {
                return Err(first);
            }
            tracing::warn!("celld {subcommand} failed (infra); retrying once");
            match exec::run_cmd(celld.celld_bin, args, cwd, celld.env, celld.timeout).await {
                Ok(stdout) => Ok((2, stdout)),
                Err(second) => Err(anyhow::anyhow!(
                    "celld {subcommand} failed twice (one infra retry):\nfirst: {:#}\nsecond: {:#}",
                    first,
                    second
                )),
            }
        }
    }
}

/// Stage one project dir into the fleet bucket: `celld deploy --no-activate
/// --json` uploads and validates a version without moving any pointer — no
/// queue attachment, no named pointer, no fleet pointer — so the staged
/// version is invisible to serving until the one activate names it. Returns
/// the attempt count and the staged version. `read_root` names the one
/// directory beyond `project_dir` that build inputs may come from (celld's
/// `--read-root`); every other project read stays inside `project_dir`.
pub async fn celld_stage(
    celld: &CelldDeploy<'_>,
    project_dir: &Path,
    cwd: Option<&Path>,
    read_root: Option<&Path>,
) -> anyhow::Result<(u32, StagedVersion)> {
    let Some(dir) = project_dir.to_str() else {
        anyhow::bail!("deploy root is not valid UTF-8: {}", project_dir.display());
    };
    let mut args = vec![
        "deploy",
        dir,
        "--bucket",
        celld.bucket,
        "--endpoint",
        celld.endpoint,
        "--region",
        celld.region,
        "--no-activate",
        "--json",
    ];
    if let Some(path) = celld.sourcemap {
        let Some(map) = path.to_str() else {
            anyhow::bail!("source map path is not valid UTF-8: {}", path.display());
        };
        args.push("--sourcemap");
        args.push(map);
    }
    if let Some(root) = read_root {
        let Some(root) = root.to_str() else {
            anyhow::bail!("read root is not valid UTF-8: {}", root.display());
        };
        args.push("--read-root");
        args.push(root);
    }
    let (attempts, stdout) = run_with_infra_retry(celld, &args, cwd).await?;
    Ok((attempts, parse_staged_version(&stdout)?))
}

/// Serve one generation: `celld activate SCRIPT=VERSION... --primary APP`
/// replaces the fleet-wide pointer with one compare-and-swap write naming
/// every script's version, so nodes adopt either the whole old generation
/// or the whole new one — never a mix. Scripts the call does not name keep
/// their activated versions (carried from the pointer's component map, or
/// from the named pointers on a legacy fleet), so skipped cohosted scripts
/// are simply not named. `--primary` is always the app: it is required on
/// a first deploy naming several scripts, and it heals a legacy pointer a
/// stranded cohosted deploy left behind. celld's own stdout is discarded —
/// the generation is known from the inputs — and the attempt count is
/// returned for the log.
pub async fn celld_activate(
    celld: &CelldDeploy<'_>,
    staged: &[(String, String)],
    primary: &str,
) -> anyhow::Result<u32> {
    let refs: Vec<String> = staged
        .iter()
        .map(|(script, version)| format!("{script}={version}"))
        .collect();
    let mut args: Vec<&str> = Vec::with_capacity(refs.len() + 8);
    args.push("activate");
    for version_ref in &refs {
        args.push(version_ref);
    }
    args.extend([
        "--bucket",
        celld.bucket,
        "--endpoint",
        celld.endpoint,
        "--region",
        celld.region,
        "--primary",
        primary,
    ]);
    Ok(run_with_infra_retry(celld, &args, None).await?.0)
}

/// `celld deploy` failures that come from the project itself: bundling a
/// broken entry or a malformed config. All deterministic and pre-pointer
/// (celld bundles before writing anything), so retrying cannot help and
/// the deploy fails at once. The markers are celld's own error strings
/// (pinned celld, `deploy.rs`), quoted narrowly enough that no S3, CAS or
/// transport error matches them.
const TENANT_ERROR_MARKERS: &[&str] = &[
    "esbuild failed:",
    "is not a JSON object",
    "`name` must contain",
    "has no `",
    "has an invalid",
    "has an empty",
    "has a non-string",
    "must be a ",
    "must be an ",
    "must be between",
    "binding name",
    "does not support these config keys",
    "wrangler.toml is not supported",
    "is not a regular file",
    "escapes the project",
    "config has neither",
    "is a runtime class",
    "without `main`",
    "which celld does not model",
    "duplicate kv namespace id",
    "takes one project path",
    "unknown argument",
];

/// True when a `celld` failure reads as tenant-caused (no retry).
/// Everything else — S3/CAS answers, timeouts, a hung celld, a lost
/// pointer race — reads as infra and the command retries once. The one
/// activate shares this classification: nothing it reports matches a
/// tenant marker, so every activate failure retries once (a lost race's
/// re-run error included — the retry IS the re-run).
pub fn is_tenant_error(output: &str) -> bool {
    TENANT_ERROR_MARKERS.iter().any(|m| output.contains(m))
}

/// What one cohosted script's stage did, for the deploy log.
#[derive(Debug, PartialEq, Eq)]
pub struct CohostOutcome {
    pub script: &'static str,
    pub skipped: bool,
    /// The content hash staged (or matched, when skipped).
    pub hash: String,
    /// The staged deployment version: `None` when skipped (the activated
    /// version carries into the generation unnamed).
    pub version: Option<String>,
    /// `celld deploy --no-activate` attempts: 0 when skipped, else 1 — or
    /// 2 when the first attempt failed on infra and the retry ran.
    pub attempts: u32,
}

impl CohostOutcome {
    /// The deploy-log line: names and a hash prefix only, never values.
    pub fn log_line(&self) -> String {
        let short = &self.hash[..12.min(self.hash.len())];
        if self.skipped {
            format!(
                "void: cohosted script `{}` unchanged ({}); keeping the activated version\n",
                self.script, short
            )
        } else {
            format!(
                "void: staged cohosted script `{}` ({})\n",
                self.script, short
            )
        }
    }
}

/// One render's stage timeout: the shared default, stretched over a
/// first image pull for scripts declaring containers.
fn render_timeout(celld: &CelldDeploy<'_>, render: &RenderedCohost) -> Duration {
    if render.declares_containers {
        CONTAINER_DEPLOY_TIMEOUT
    } else {
        celld.timeout
    }
}

/// Stage the fleet's runner-owned scripts in order (lowest `order` first):
/// each renders to a fresh temp project and stages with `celld deploy
/// --no-activate` into the fleet bucket — unless its content hash matches
/// the stored one, in which case the script is skipped and its activated
/// version carries into the generation unnamed. Each stage retries once on
/// infra errors, like the app's and the activate's; a tenant failure fails
/// the deploy at once, before the app stages. Staged versions move no
/// pointer, so a failed stage leaves the previous generation serving — and
/// no hashes are stored here: they name activated content, so
/// [`activate_staged`] stores them only after the activate commits.
/// The temp project holds the fleet's secrets in plaintext, so it is
/// owner-only from birth and removed on every path — success or failure —
/// and failed deploys leave nothing on runner disk.
pub async fn stage_cohosted(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    celld: &CelldDeploy<'_>,
    renders: &[RenderedCohost],
) -> anyhow::Result<Vec<CohostOutcome>> {
    let mut ordered: Vec<&RenderedCohost> = renders.iter().collect();
    ordered.sort_by_key(|render| render.script.order);
    let mut outcomes = Vec::with_capacity(ordered.len());
    for render in ordered {
        let hash = render.content_hash();
        let stored = db::get_cohost_hash(pool, app_id, environment_id, render.script.name).await?;
        if stored.as_deref() == Some(hash.as_str()) {
            outcomes.push(CohostOutcome {
                script: render.script.name,
                skipped: true,
                hash,
                version: None,
                attempts: 0,
            });
            continue;
        }
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "noite-cohost-{}-{}",
            render.script.name,
            crate::models::new_id()
        ));
        // Owner-only from birth: the rendered config carries the fleet's
        // token and proxy credentials in plaintext.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&dir)?;
        }
        render.write_project(&dir)?;
        let render_celld = CelldDeploy {
            timeout: render_timeout(celld, render),
            sourcemap: None,
            ..*celld
        };
        let (attempts, staged) =
            match celld_stage(&render_celld, &dir, None, render.read_root.as_deref()).await {
                Ok(staged) => staged,
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&dir);
                    return Err(anyhow::anyhow!(
                        "cohosted script `{}` stage failed: {:#}",
                        render.script.name,
                        e
                    ));
                }
            };
        let _ = std::fs::remove_dir_all(&dir);
        // The staged version must identify the script just rendered: celld
        // read its name from the same `wrangler.json`, so anything else is
        // a wiring bug, failed loudly before the activate names it.
        anyhow::ensure!(
            staged.worker == render.script.name,
            "cohosted script `{}` staged as worker {:?}",
            render.script.name,
            staged.worker
        );
        outcomes.push(CohostOutcome {
            script: render.script.name,
            skipped: false,
            hash,
            version: Some(staged.version),
            attempts,
        });
    }
    Ok(outcomes)
}

/// The tenant app's side of the ordered deploy: its project dir, the cwd
/// the app stage runs from, its own (container-aware) timeout, and where
/// `--sourcemap` writes the Worker's map (`None` writes no map).
pub struct FleetApp<'a> {
    pub dir: &'a Path,
    pub cwd: Option<&'a Path>,
    pub timeout: Duration,
    pub sourcemap: Option<&'a Path>,
    /// The checkout the deploy root sits in: build inputs (hoisted
    /// packages, a root-level Dockerfile) may come from anywhere in it.
    pub read_root: Option<&'a Path>,
}

/// What the ordered fleet deploy did, for the deploy log.
#[derive(Debug)]
pub struct FleetDeployStats {
    pub cohosted: Vec<CohostOutcome>,
    /// `celld deploy --no-activate` attempts for the app: 1, or 2 when the
    /// first attempt failed on infra and the retry ran.
    pub app_attempts: u32,
    /// `celld activate` attempts: 1, or 2 when the first attempt failed on
    /// infra and the retry ran.
    pub activate_attempts: u32,
    /// The generation the one activate named, deploy order (cohosted
    /// first, the app last); skipped scripts carry unnamed and are absent.
    pub generation: Vec<(String, String)>,
    /// The activate's `--primary`: the app script, which ingress serves.
    pub primary: String,
}

impl FleetDeployStats {
    /// The deploy-log lines: one per cohosted script, one for the
    /// generation the activate served, plus a retry note per command whose
    /// second attempt ran (cohosted first, then the app stage, then the
    /// activate).
    pub fn log_lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.cohosted.iter().map(CohostOutcome::log_line).collect();
        for outcome in &self.cohosted {
            if !outcome.skipped && outcome.attempts > 1 {
                lines.push(format!(
                    "void: cohosted script `{}` succeeded on attempt {} after an infra failure\n",
                    outcome.script, outcome.attempts
                ));
            }
        }
        if self.app_attempts > 1 {
            lines.push(format!(
                "void: app stage succeeded on attempt {} after an infra failure\n",
                self.app_attempts
            ));
        }
        let generation = self
            .generation
            .iter()
            .map(|(script, version)| format!("{script}={version}"))
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!(
            "void: activated generation: {generation} (primary {})\n",
            self.primary
        ));
        if self.activate_attempts > 1 {
            lines.push(format!(
                "void: activate succeeded on attempt {} after an infra failure\n",
                self.activate_attempts
            ));
        }
        lines
    }
}

/// What the ordered fleet stage produced: every script of the generation
/// staged with `celld deploy --no-activate` — the cohosted scripts first
/// (each skipped when unchanged), the tenant app last — with no pointer
/// moved yet. [`activate_staged`] serves exactly this generation; anything
/// the deploy runs between the two (the staged Void migrations) sees these
/// staged versions and nothing else.
pub struct StagedFleet {
    pub cohosted: Vec<CohostOutcome>,
    pub app_attempts: u32,
    /// The generation the one activate names, deploy order (cohosted
    /// first, the app last); skipped scripts carry unnamed and are absent.
    pub generation: Vec<(String, String)>,
    /// The activate's `--primary`: the app script, which ingress serves —
    /// and the staged invoke's `--target`, which receives the migrate
    /// endpoints.
    pub primary: String,
}

/// Stage the whole generation without serving it: the cohosted scripts in
/// order (each skipped when unchanged), the tenant app last. A failed
/// stage runs no activate, so the previous generation keeps serving — and
/// the caller decides what runs before [`activate_staged`] commits this
/// generation, or fails the deploy leaving it unactivated.
pub async fn stage_fleet_in_order(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    celld: &CelldDeploy<'_>,
    cohosted: &[RenderedCohost],
    app: &FleetApp<'_>,
) -> anyhow::Result<StagedFleet> {
    let outcomes = stage_cohosted(pool, app_id, environment_id, celld, cohosted).await?;
    let app_celld = CelldDeploy {
        timeout: app.timeout,
        sourcemap: app.sourcemap,
        ..*celld
    };
    let (app_attempts, app_staged) =
        celld_stage(&app_celld, app.dir, app.cwd, app.read_root).await?;
    let mut generation: Vec<(String, String)> = Vec::with_capacity(outcomes.len() + 1);
    for outcome in &outcomes {
        if let Some(version) = outcome.version.as_ref() {
            generation.push((outcome.script.to_string(), version.clone()));
        }
    }
    generation.push((app_staged.worker.clone(), app_staged.version.clone()));
    Ok(StagedFleet {
        primary: app_staged.worker,
        cohosted: outcomes,
        app_attempts,
        generation,
    })
}

/// Serve one staged generation: one `celld activate SCRIPT=VERSION...`
/// with a single atomic pointer write, then store the cohost hashes — only
/// after the activate commits, so a stored hash always names activated
/// content. Staged versions a failed deploy leaves behind are inert — no
/// pointer names them — and the next deploy reproduces them from the same
/// content (versions are content-addressed); the fork's docs recommend no
/// post-failure discard (they warn to hold superseded versions as rollback
/// targets instead), so none runs.
pub async fn activate_staged(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    celld: &CelldDeploy<'_>,
    staged: StagedFleet,
) -> anyhow::Result<FleetDeployStats> {
    let activate_attempts = celld_activate(celld, &staged.generation, &staged.primary).await?;
    for outcome in &staged.cohosted {
        if !outcome.skipped {
            db::set_cohost_hash(pool, app_id, environment_id, outcome.script, &outcome.hash)
                .await?;
        }
    }
    Ok(FleetDeployStats {
        cohosted: staged.cohosted,
        app_attempts: staged.app_attempts,
        activate_attempts,
        generation: staged.generation,
        primary: staged.primary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The tests' whole ordered fleet deploy: stage plus the one activate,
    /// with nothing between — production's deploys prove the staged
    /// generation with the pre-activation canary first (`host/deploy.rs`),
    /// so only this seam keeps the bare sequence.
    async fn deploy_fleet_in_order(
        pool: &SqlitePool,
        app_id: &str,
        environment_id: Option<&str>,
        celld: &CelldDeploy<'_>,
        cohosted: &[RenderedCohost],
        app: &FleetApp<'_>,
    ) -> anyhow::Result<FleetDeployStats> {
        let staged =
            stage_fleet_in_order(pool, app_id, environment_id, celld, cohosted, app).await?;
        activate_staged(pool, app_id, environment_id, celld, staged).await
    }

    const SOURCES: &[CohostSource] = &[
        CohostSource {
            path: "worker.ts",
            contents: "export default { fetch: () => new Response('ok') }",
        },
        CohostSource {
            path: "src/util.ts",
            contents: "export const one = 1;",
        },
    ];

    const SCRIPT: CohostedScript = CohostedScript {
        name: "noite-test-cohost",
        main: "worker.ts",
        sources: SOURCES,
        order: 10,
    };

    const EARLY_SCRIPT: CohostedScript = CohostedScript {
        name: "noite-test-early",
        main: "worker.js",
        sources: &[],
        order: 5,
    };

    fn render(token: &str) -> RenderedCohost {
        RenderedCohost {
            script: &SCRIPT,
            secret_vars: &["__VOID_PROXY_TOKEN"],
            config: json!({
                "name": "noite-test-cohost",
                "main": "worker.ts",
                "vars": {"__VOID_PROXY_TOKEN": token, "MODE": "prod"},
            }),
            extra_sources: Vec::new(),
            extra_hash_input: Vec::new(),
            declares_containers: false,
            read_root: None,
        }
    }

    /// The digest is stable, and any source, config or secret change flips
    /// it — including a token rotation, which is what redeploys the proxy
    /// beside a rotated app.
    #[test]
    fn content_hash_is_stable_and_flips_on_any_change() {
        let base = render("tok-1").content_hash();
        assert_eq!(base.len(), 64);
        assert_eq!(render("tok-1").content_hash(), base);
        assert_ne!(render("tok-2").content_hash(), base);

        let mut config_changed = render("tok-1");
        config_changed.config["vars"]["MODE"] = json!("dev");
        assert_ne!(config_changed.content_hash(), base);

        const OTHER_SOURCES: &[CohostSource] = &[CohostSource {
            path: "worker.ts",
            contents: "export default { fetch: () => new Response('changed') }",
        }];
        const OTHER: CohostedScript = CohostedScript {
            name: "noite-test-cohost",
            main: "worker.ts",
            sources: OTHER_SOURCES,
            order: 10,
        };
        let mut source_changed = render("tok-1");
        source_changed.script = &OTHER;
        assert_ne!(source_changed.content_hash(), base);
    }

    /// Per-deploy container paths are not hash inputs: an absolute
    /// `image` (or `dockerfile`/`build_context`, here or under an
    /// unplanned `images.default`) reads the same whatever the build dir,
    /// while a registry ref is stable content and still flips the digest
    /// when it changes.
    #[test]
    fn container_image_paths_are_not_hash_inputs() {
        let with_entry = |entry: Value| {
            let mut rendered = render("tok");
            rendered.config["containers"] = json!([entry]);
            rendered
        };
        let first = with_entry(json!({
            "name": "noite-void-sandbox-v1",
            "class_name": "SandboxController",
            "image": "/data/runner/builds/blog/t1/ctx/.noite-image-0.Dockerfile",
            "max_instances": 4,
        }));
        let second = with_entry(json!({
            "name": "noite-void-sandbox-v1",
            "class_name": "SandboxController",
            "image": "/data/runner/builds/blog/t2/ctx/.noite-image-0.Dockerfile",
            "max_instances": 4,
        }));
        assert_eq!(first.content_hash(), second.content_hash());

        // An unplanned shape's path keys go the same way.
        let unplanned = with_entry(json!({
            "name": "void-sandbox-v1",
            "class_name": "SandboxV1",
            "images": {"default": {
                "dockerfile": "/data/runner/builds/blog/t3/img/Dockerfile",
                "build_context": "/data/runner/builds/blog/t3/img",
            }},
        }));
        let unplanned_other = with_entry(json!({
            "name": "void-sandbox-v1",
            "class_name": "SandboxV1",
            "images": {"default": {
                "dockerfile": "/data/runner/builds/blog/t4/img/Dockerfile",
                "build_context": "/data/runner/builds/blog/t4/img",
            }},
        }));
        assert_eq!(unplanned.content_hash(), unplanned_other.content_hash());

        // A registry ref is stable content: changing it flips the digest,
        // and the same ref in another render reads the same.
        let pinned = with_entry(json!({
            "name": "noite-void-sandbox-v1",
            "class_name": "SandboxController",
            "image": format!("registry.example/x@sha256:{}", "aa".repeat(32)),
            "max_instances": 4,
        }));
        assert_ne!(pinned.content_hash(), first.content_hash());
        let repinned = with_entry(json!({
            "name": "noite-void-sandbox-v1",
            "class_name": "SandboxController",
            "image": format!("registry.example/x@sha256:{}", "bb".repeat(32)),
            "max_instances": 4,
        }));
        assert_ne!(repinned.content_hash(), pinned.content_hash());
        assert_eq!(
            with_entry(json!({
                "name": "noite-void-sandbox-v1",
                "class_name": "SandboxController",
                "image": format!("registry.example/x@sha256:{}", "bb".repeat(32)),
                "max_instances": 4,
            }))
            .content_hash(),
            repinned.content_hash()
        );
    }

    /// Runtime-loaded sources and the extra hash input feed the digest
    /// like embedded sources do: a bundle change or an image change flips
    /// the hash and redeploys the script.
    #[test]
    fn extra_sources_and_hash_input_flip_the_digest() {
        let base = render("tok-1").content_hash();
        let mut bundle_changed = render("tok-1");
        bundle_changed.extra_sources.push(RuntimeSource {
            path: "worker.js".to_string(),
            contents: b"bundle-bytes".to_vec(),
        });
        let with_bundle = bundle_changed.content_hash();
        assert_ne!(with_bundle, base);

        bundle_changed.extra_sources[0].contents = b"bundle-bytes-2".to_vec();
        assert_ne!(bundle_changed.content_hash(), with_bundle);

        let mut image_changed = render("tok-1");
        image_changed.extra_sources.push(RuntimeSource {
            path: "worker.js".to_string(),
            contents: b"bundle-bytes".to_vec(),
        });
        assert_eq!(image_changed.content_hash(), with_bundle);
        image_changed.extra_hash_input = vec![1, 2, 3];
        assert_ne!(image_changed.content_hash(), with_bundle);
    }

    /// The project lands exactly: sources at their paths with their bytes,
    /// the rendered config beside them — and a path escaping the root is
    /// refused instead of written.
    #[test]
    fn write_project_lays_out_sources_and_config() {
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-project-{}", crate::models::new_id()));
        render("tok").write_project(&dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("worker.ts")).unwrap(),
            "export default { fetch: () => new Response('ok') }"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("src/util.ts")).unwrap(),
            "export const one = 1;"
        );
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.json")).unwrap())
                .unwrap();
        assert_eq!(config["name"], "noite-test-cohost");
        assert_eq!(config["vars"]["__VOID_PROXY_TOKEN"], "tok");
        std::fs::remove_dir_all(&dir).unwrap();

        const ESCAPING: &[CohostSource] = &[CohostSource {
            path: "../escape.ts",
            contents: "x",
        }];
        const EVIL: CohostedScript = CohostedScript {
            name: "noite-test-cohost",
            main: "worker.ts",
            sources: ESCAPING,
            order: 10,
        };
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-escape-{}", crate::models::new_id()));
        let evil = RenderedCohost {
            script: &EVIL,
            secret_vars: &[],
            config: json!({"name": "x"}),
            extra_sources: Vec::new(),
            extra_hash_input: Vec::new(),
            declares_containers: false,
            read_root: None,
        };
        let err = evil.write_project(&dir).unwrap_err();
        assert!(format!("{:#}", err).contains("escapes"), "{:#}", err);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Runtime-loaded sources land beside the embedded ones — and the same
    /// escape rule refuses an escaping runtime path.
    #[test]
    fn write_project_lays_out_runtime_sources() {
        let mut rendered = render("tok");
        rendered.extra_sources.push(RuntimeSource {
            path: "worker.js".to_string(),
            contents: b"bundle-bytes".to_vec(),
        });
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-runtime-{}", crate::models::new_id()));
        rendered.write_project(&dir).unwrap();
        assert_eq!(
            std::fs::read(dir.join("worker.js")).unwrap(),
            b"bundle-bytes"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("worker.ts")).unwrap(),
            "export default { fetch: () => new Response('ok') }"
        );
        std::fs::remove_dir_all(&dir).unwrap();

        let mut evil = render("tok");
        evil.extra_sources.push(RuntimeSource {
            path: "../escape.js".to_string(),
            contents: Vec::new(),
        });
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-rtesc-{}", crate::models::new_id()));
        let err = evil.write_project(&dir).unwrap_err();
        assert!(format!("{:#}", err).contains("escapes"), "{:#}", err);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A render declaring containers gets the container deploy timeout (a
    /// first image pull); anything else keeps the shared default.
    #[test]
    fn container_scripts_get_the_container_timeout() {
        let celld = CelldDeploy {
            celld_bin: "celld",
            env: &[],
            bucket: "s3://noite/fleets/x",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(120),
            sourcemap: None,
        };
        assert_eq!(
            render_timeout(&celld, &render("tok")),
            Duration::from_secs(120)
        );
        let mut containers = render("tok");
        containers.declares_containers = true;
        assert_eq!(
            render_timeout(&celld, &containers),
            CONTAINER_DEPLOY_TIMEOUT
        );
        assert_eq!(CONTAINER_DEPLOY_TIMEOUT, Duration::from_secs(600));
    }

    /// celld's own project failures (bundling, config shape) read as
    /// tenant — no retry — while store, CAS and transport failures read
    /// as infra, including every activate failure (a lost pointer race's
    /// re-run error heals through the retry). Markers are quoted from the
    /// pinned celld's `deploy.rs`.
    #[test]
    fn tenant_and_infra_errors_classify() {
        for tenant in [
            "celld [\"deploy\"] exit Some(1)\nesbuild failed:\nERROR: Could not resolve \"x\"",
            "/w/wrangler.json is not a JSON object",
            "config has no `name`",
            "config `name` must contain 1 to 63 bytes of lowercase ASCII",
            "`celld deploy` does not support these config keys: secrets.",
            "wrangler.toml is not supported; convert it to wrangler.jsonc",
            "invalid service binding name: \"x\"",
            "service binding __VOID_PROXY has no `service`",
            "config `services` must be an array",
            "config `kv_namespaces` must be an object",
            "entry point main.js is not a regular file",
            "d1 database \"db\" has an invalid `database_id`",
            "d1 binding data has an empty `database_name`",
            "d1 database \"db\" has a non-string `migrations_dir`",
            "queue producer delivery_delay must be between 0 and 86400 seconds",
            "config has neither `main` nor `assets`",
            "`room` is a runtime class; remove it from `migrations`",
            "config sets `triggers.crons` without `main`; a cron trigger needs a `scheduled` handler to call",
            "config `queues` declares `x`, which celld does not model",
            "duplicate kv namespace id: \"a\"",
            "`celld deploy` takes one project path, and already has one: x",
            "unknown argument for `celld deploy`: --nope",
        ] {
            assert!(is_tenant_error(tenant), "tenant not recognized: {}", tenant);
        }
        for infra in [
            "Error communicating with S3: service error: SlowDown: Please reduce your request rate",
            "put deploy/current.json: connection refused (os error 111)",
            "command timeout: celld [\"deploy\", \"/w\"] timed out after 120s",
            "500 Internal Server Error",
            "If-Match precondition failed: 412",
            "failed to lookup address information",
            "TLS handshake failed",
            "esbuild not found (esbuild). `celld deploy` bundles with esbuild; install it and retry",
            "save container image failed:\nError: daemon not running",
            "thread 'main' panicked at crates/celld/deploy.rs:973",
            "write s3://noite/fleets/x/deploy/current.json lost a race\nAnother deploy or activate landed first; re-run `celld activate`.",
            "no staged version \"0123456789abcdef\" of script \"test-app\"; run `celld deploy --no-activate` first",
            "the generation committed, but its named pointers did not converge: put deploy/test-app/current.json: connection refused; re-run `celld activate` to converge them",
        ] {
            assert!(!is_tenant_error(infra), "infra misread as tenant: {}", infra);
        }
    }

    /// The staged row parses to its worker and version — and anything else
    /// (garbage, a missing field, a non-16-hex version, a worker outside
    /// celld's script-name rule) fails the deploy here instead of reaching
    /// `activate` as a corrupt `SCRIPT=VERSION`.
    #[test]
    fn staged_output_parses_or_fails_loudly() {
        let staged = parse_staged_version(
            "{\"worker\": \"test-app\", \"version\": \"0123456789abcdef\", \"location\": \"s3://x\", \"dry_run\": false, \"staged\": true}\n",
        )
        .unwrap();
        assert_eq!(staged.worker, "test-app");
        assert_eq!(staged.version, "0123456789abcdef");
        // A single lowercase char is a valid script name.
        assert_eq!(
            parse_staged_version(
                "{\"worker\": \"a\", \"version\": \"0123456789abcdef\", \"dry_run\": false, \"staged\": true}"
            )
            .unwrap()
            .worker,
            "a"
        );

        for bad in [
            "not json",
            "{\"worker\": \"test-app\"}",
            "{\"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"test-app\", \"version\": \"0123456789ABCDEF\"}",
            "{\"worker\": \"test-app\", \"version\": \"abc\"}",
            "{\"worker\": \"test-app\", \"version\": 42}",
            // Outside the script-name rule: a leading `-` would parse as
            // an `activate` flag, the rest never survives celld either.
            "{\"worker\": \"--bucket\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"-app\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"app-\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"Test-App\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"app_name\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"a b\", \"version\": \"0123456789abcdef\"}",
            "{\"worker\": \"app=1\", \"version\": \"0123456789abcdef\"}",
            // A version celld did not stage (pointer moved, or a dry run).
            "{\"worker\": \"test-app\", \"version\": \"0123456789abcdef\", \"staged\": false, \"dry_run\": false}",
            "{\"worker\": \"test-app\", \"version\": \"0123456789abcdef\", \"staged\": true, \"dry_run\": true}",
        ] {
            assert!(
                parse_staged_version(bad).is_err(),
                "accepted malformed staged output: {}",
                bad
            );
        }
        // 63 bytes is the cap: one more fails.
        assert!(valid_worker_name(&"a".repeat(63)));
        assert!(parse_staged_version(&format!(
            "{{\"worker\": \"{}\", \"version\": \"0123456789abcdef\"}}",
            "a".repeat(64)
        ))
        .is_err());
    }

    /// A fake `celld` (`tests/fixtures/fake-celld-cohost.sh`): appends its
    /// argv to `$FAKE_CELLD_LOG`, then fails invocation `n` (zero-based)
    /// when `$FAKE_CELLD_DIR/fail-<n>` exists (file content to stderr, exit
    /// 1). A `deploy` answers like `celld deploy --no-activate --json` — one
    /// JSON object whose worker is the project dir's `wrangler.json` name
    /// and whose version is the invocation index as 16-hex, deterministic
    /// per invocation — and an `activate` answers a text line the caller
    /// discards. The control files and the deterministic versions make
    /// order, skip, retry and the generation the activate names observable
    /// without sleeps.
    struct FakeCelld {
        dir: PathBuf,
    }

    impl FakeCelld {
        fn spawn() -> Self {
            let dir =
                std::env::temp_dir().join(format!("noite-fake-celld-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            // A symlink to the committed script, never a fresh file: exec'ing
            // a just-written file while another test thread forks fails
            // with ETXTBSY, which the infra retry then hides as a second
            // attempt.
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fake-celld-cohost.sh");
            std::os::unix::fs::symlink(fixture, dir.join("celld")).unwrap();
            Self { dir }
        }

        fn bin(&self) -> String {
            self.dir.join("celld").to_string_lossy().into_owned()
        }

        fn log(&self) -> String {
            self.dir
                .join("invocations.log")
                .to_string_lossy()
                .into_owned()
        }

        /// Fail invocation `n` with `message` on stderr.
        fn fail(&self, n: usize, message: &str) {
            std::fs::write(self.dir.join(format!("fail-{}", n)), message).unwrap();
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

    async fn seed(pool: &SqlitePool) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "cohost-app",
                slug: "cohost-app",
                user_id: "local",
                subdomain: "cohost-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    /// One app project dir: a `wrangler.json` naming the app, as every real
    /// deploy root has — the fake stages its worker from it.
    fn app_dir() -> crate::testutil::TempDir {
        let guard = crate::testutil::TempDir::new("noite-cohost-app");
        std::fs::write(
            guard.path().join("wrangler.json"),
            r#"{"name": "test-app", "main": "worker.js"}"#,
        )
        .unwrap();
        guard
    }

    /// The `activate` invocations among the fake's log lines.
    fn activates(calls: &[String]) -> Vec<&String> {
        calls
            .iter()
            .filter(|call| call.starts_with("activate "))
            .collect()
    }

    /// Proxy first, app last, one activate: the ordered deploy stages the
    /// cohosted project before the app's with `celld deploy --no-activate`
    /// into the same bucket, then serves both with a single `celld
    /// activate` naming each staged version — and the cohosted temp project
    /// is removed afterwards.
    #[tokio::test]
    async fn ordered_deploy_runs_cohosted_before_the_app() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();

        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok")],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: None,
                read_root: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.app_attempts, 1);
        assert_eq!(stats.activate_attempts, 1);
        assert_eq!(stats.cohosted.len(), 1);
        assert!(!stats.cohosted[0].skipped);
        assert_eq!(
            stats.cohosted[0].version.as_deref(),
            Some("0000000000000001")
        );
        assert_eq!(
            stats.generation,
            [
                (
                    "noite-test-cohost".to_string(),
                    "0000000000000001".to_string()
                ),
                ("test-app".to_string(), "0000000000000002".to_string()),
            ]
        );
        assert_eq!(stats.primary, "test-app");

        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        assert!(
            calls[0].starts_with("deploy ")
                && calls[0].contains("noite-cohost-noite-test-cohost-")
                && calls[0].contains("--no-activate")
                && calls[0].contains("s3://noite/fleets/cohost-app"),
            "{:?}",
            calls
        );
        assert!(
            calls[1].starts_with("deploy ")
                && calls[1].contains(&app_dir.to_string_lossy().into_owned())
                && calls[1].contains("--no-activate")
                && calls[1].contains("s3://noite/fleets/cohost-app"),
            "{:?}",
            calls
        );
        // One activate, last, naming both staged versions with the app as
        // primary.
        let activated = activates(&calls);
        assert_eq!(activated.len(), 1, "{:?}", calls);
        assert!(
            activated[0].contains("noite-test-cohost=0000000000000001")
                && activated[0].contains("test-app=0000000000000002")
                && activated[0].contains("--primary test-app"),
            "{:?}",
            calls
        );
        assert!(calls[2].starts_with("activate "), "{:?}", calls);
        // The cohosted temp project is gone: argv[1] is its dir.
        let project = calls[0].split(' ').nth(1).expect("deploy argv");
        assert!(!Path::new(project).exists(), "{} left behind", project);
        drop(guard_app);
    }

    /// Two cohosted scripts stage lowest order first no matter the input
    /// order — the sandbox controller (5) before the proxy (10) — the app
    /// still stages last, and the one activate names all three versions.
    #[tokio::test]
    async fn two_cohosted_scripts_deploy_lowest_order_first() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();

        let early = RenderedCohost {
            script: &EARLY_SCRIPT,
            secret_vars: &[],
            config: json!({"name": "noite-test-early", "main": "worker.js"}),
            extra_sources: vec![RuntimeSource {
                path: "worker.js".to_string(),
                contents: b"early".to_vec(),
            }],
            extra_hash_input: Vec::new(),
            declares_containers: true,
            read_root: None,
        };
        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok"), early],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: None,
                read_root: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.app_attempts, 1);
        assert_eq!(stats.cohosted.len(), 2);
        assert_eq!(stats.cohosted[0].script, "noite-test-early");
        assert_eq!(stats.cohosted[1].script, "noite-test-cohost");

        let calls = fake.invocations();
        assert_eq!(calls.len(), 4, "{:?}", calls);
        assert!(
            calls[0].starts_with("deploy ") && calls[0].contains("noite-cohost-noite-test-early-"),
            "{:?}",
            calls
        );
        assert!(
            calls[1].starts_with("deploy ") && calls[1].contains("noite-cohost-noite-test-cohost-"),
            "{:?}",
            calls
        );
        assert!(
            calls[2].starts_with("deploy ")
                && calls[2].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        // Every stage precedes the one activate, which names all three.
        let activated = activates(&calls);
        assert_eq!(activated.len(), 1, "{:?}", calls);
        assert!(calls[3].starts_with("activate "), "{:?}", calls);
        assert!(
            activated[0].contains("noite-test-early=0000000000000001")
                && activated[0].contains("noite-test-cohost=0000000000000002")
                && activated[0].contains("test-app=0000000000000003")
                && activated[0].contains("--primary test-app"),
            "{:?}",
            calls
        );
        drop(guard_app);
    }

    /// Second deploy with the same content: the cohosted script is
    /// skipped (one stage total — the app's — and the activate does not
    /// name it, so its activated version carries), and a rotation
    /// re-stages it.
    #[tokio::test]
    async fn unchanged_cohost_is_skipped_rotation_redeploys() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };

        let first =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(!first.cohosted[0].skipped);
        assert_eq!(fake.invocations().len(), 3);

        let second =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(second.cohosted[0].skipped);
        assert_eq!(second.cohosted[0].version, None);
        assert_eq!(
            second.generation,
            [("test-app".to_string(), "0000000000000004".to_string())]
        );
        let lines = second.log_lines().join("");
        assert!(lines.contains("keeping the activated version"), "{}", lines);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 5, "{:?}", calls);
        assert!(
            calls[3].starts_with("deploy ")
                && calls[3].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        // The skipped script is absent from the activate: its activated
        // version carries unnamed.
        assert!(calls[4].starts_with("activate "), "{:?}", calls);
        assert!(!calls[4].contains("noite-test-cohost"), "{:?}", calls);
        assert!(
            calls[4].contains("test-app=0000000000000004"),
            "{:?}",
            calls
        );

        // A rotation flips the hash: the proxy stages again beside the app.
        let third =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok-2")], &app_side)
                .await
                .unwrap();
        assert!(!third.cohosted[0].skipped);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 8, "{:?}", calls);
        assert!(calls[7].starts_with("activate "), "{:?}", calls);
        assert!(
            calls[7].contains("noite-test-cohost=0000000000000006")
                && calls[7].contains("test-app=0000000000000007"),
            "{:?}",
            calls
        );
        drop(guard_app);
    }

    /// The app stage retries once on infra and then succeeds; the stats
    /// carry the attempt count for the log, and the activate names the
    /// retried stage's version.
    #[tokio::test]
    async fn app_deploy_retries_once_on_infra() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        // Invocation 1 is the app's first attempt (0 is the cohosted one).
        fake.fail(
            1,
            "put deploy/current.json: connection refused (os error 111)",
        );
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();

        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok")],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: None,
                read_root: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.app_attempts, 2);
        assert_eq!(stats.activate_attempts, 1);
        let lines = stats.log_lines().join("");
        assert!(lines.contains("attempt 2"), "{}", lines);
        assert!(lines.contains("activated generation"), "{}", lines);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 4, "{:?}", calls);
        // The cohosted script staged once — the retry is the app's alone.
        assert!(calls[0].contains("noite-cohost-"), "{:?}", calls);
        assert!(
            calls[1].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        assert!(
            calls[2].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        // The activate names the retry's version, not the failed attempt's
        // (which staged nothing).
        assert!(calls[3].starts_with("activate "), "{:?}", calls);
        assert!(
            calls[3].contains("noite-test-cohost=0000000000000001")
                && calls[3].contains("test-app=0000000000000003"),
            "{:?}",
            calls
        );
        drop(guard_app);
    }

    /// Tenant failures fail at once (no retry), and a twice-failed app
    /// stage carries both attempts' errors. Both run no activate, so the
    /// previous generation keeps serving.
    #[tokio::test]
    async fn tenant_failures_fail_fast_twice_failed_carries_both() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        fake.fail(1, "esbuild failed:\nERROR: Could not resolve \"x\"");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };

        let err = deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
            .await
            .unwrap_err();
        assert!(format!("{:#}", err).contains("esbuild failed"), "{:#}", err);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{:?}", calls);
        assert!(activates(&calls).is_empty(), "{:?}", calls);

        // Both app attempts fail on infra: one retry, then both errors.
        // A fresh token keeps the cohosted stage (invocation 0) so the
        // app's attempts stay 1 and 2.
        let fake = FakeCelld::spawn();
        fake.fail(1, "first: connection refused");
        fake.fail(2, "second: 503 SlowDown");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let err =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok-2")], &app_side)
                .await
                .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.contains("failed twice"), "{}", text);
        assert!(text.contains("first: connection refused"), "{}", text);
        assert!(text.contains("second: 503 SlowDown"), "{}", text);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        assert!(activates(&calls).is_empty(), "{:?}", calls);
        drop(guard_app);
    }

    /// A failed cohosted stage fails the deploy before the app stages:
    /// no app invocation, no activate, no stored hash, the secret-bearing
    /// temp project removed — and the next deploy starts over. Tenant
    /// failures fail at once, with no retry.
    #[tokio::test]
    async fn cohost_failure_fails_before_the_app() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        fake.fail(0, "config `services` must be an array");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };

        let err = deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
            .await
            .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.contains("noite-test-cohost"), "{}", text);
        assert!(!text.contains("project kept at"), "{}", text);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 1, "{:?}", calls);
        assert!(activates(&calls).is_empty(), "{:?}", calls);
        // The temp project is gone on the failure path too.
        let project = fake.invocations()[0]
            .split(' ')
            .nth(1)
            .expect("deploy argv")
            .to_string();
        assert!(!Path::new(&project).exists(), "{}", project);
        // Nothing stored: the next deploy tries the cohosted script again.
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap(),
            None
        );
        drop(guard_app);
    }

    /// A cohosted script retries once on infra, and the stats carry the
    /// attempt count for the log. A twice-failed cohosted stage carries
    /// both attempts' errors and still fails before the app.
    #[tokio::test]
    async fn cohosted_deploy_retries_once_on_infra() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        // Invocation 0 is the cohosted script's first attempt.
        fake.fail(
            0,
            "Error communicating with S3: service error: SlowDown: Please reduce your request rate",
        );
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };

        let stats =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(!stats.cohosted[0].skipped);
        assert_eq!(stats.cohosted[0].attempts, 2);
        assert_eq!(stats.app_attempts, 1);
        assert_eq!(stats.activate_attempts, 1);
        let lines = stats.log_lines().join("");
        assert!(lines.contains("noite-test-cohost"), "{}", lines);
        assert!(lines.contains("attempt 2"), "{}", lines);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 4, "{:?}", calls);
        // The cohosted script staged twice (first attempt, retry — same
        // temp project), then the app once, then the one activate.
        assert!(calls[0].contains("noite-cohost-"), "{:?}", calls);
        assert!(calls[1].contains("noite-cohost-"), "{:?}", calls);
        let first_project = calls[0].split(' ').nth(1).expect("deploy argv");
        let retry_project = calls[1].split(' ').nth(1).expect("deploy argv");
        assert_eq!(first_project, retry_project);
        assert!(
            calls[2].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        assert!(calls[3].starts_with("activate "), "{:?}", calls);
        assert!(
            calls[3].contains("noite-test-cohost=0000000000000002")
                && calls[3].contains("test-app=0000000000000003"),
            "{:?}",
            calls
        );
        // The retry still stores the hash.
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap()
                .as_deref(),
            Some(stats.cohosted[0].hash.as_str())
        );

        // Both cohosted attempts fail on infra: one retry, then both
        // errors — before the app stages anything. A fresh token keeps
        // the cohosted stage (invocations 0 and 1).
        let fake = FakeCelld::spawn();
        fake.fail(0, "first: connection refused");
        fake.fail(1, "second: 503 SlowDown");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let err =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok-2")], &app_side)
                .await
                .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.contains("noite-test-cohost"), "{}", text);
        assert!(text.contains("failed twice"), "{}", text);
        assert!(text.contains("first: connection refused"), "{}", text);
        assert!(text.contains("second: 503 SlowDown"), "{}", text);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{:?}", calls);
        assert!(activates(&calls).is_empty(), "{:?}", calls);
        // The failed render stored nothing: the earlier hash still stands.
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap()
                .as_deref(),
            Some(stats.cohosted[0].hash.as_str())
        );
        // The temp project is gone on the failure path too.
        let project = calls[0].split(' ').nth(1).expect("deploy argv").to_string();
        assert!(!Path::new(&project).exists(), "{}", project);
        drop(guard_app);
    }

    /// A failed deploy stores nothing and runs no activate: the cohosted
    /// script staged fine but the app stage failed, so no pointer moved —
    /// the previous generation keeps serving — and the cohost's hash is
    /// not stored (stored hashes name activated content), so the next
    /// deploy stages it again instead of skipping it.
    #[tokio::test]
    async fn failed_deploy_stores_nothing_and_runs_no_activate() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        fake.fail(1, "esbuild failed:\nERROR: Could not resolve \"x\"");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };

        let err = deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
            .await
            .unwrap_err();
        assert!(format!("{:#}", err).contains("esbuild failed"), "{:#}", err);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{:?}", calls);
        assert!(activates(&calls).is_empty(), "{:?}", calls);
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap(),
            None
        );

        // The retry stages the cohosted script again (nothing was stored)
        // and activates the generation.
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let stats =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(!stats.cohosted[0].skipped);
        assert_eq!(stats.activate_attempts, 1);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        assert_eq!(activates(&calls).len(), 1, "{:?}", calls);
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap()
                .as_deref(),
            Some(stats.cohosted[0].hash.as_str())
        );
        drop(guard_app);
    }

    /// An app with no cohosted scripts (any non-Void app): one stage, one
    /// activate naming only the app with itself as primary.
    #[tokio::test]
    async fn app_without_cohosted_scripts_activates_alone() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();

        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: None,
                read_root: None,
            },
        )
        .await
        .unwrap();
        assert!(stats.cohosted.is_empty());
        assert_eq!(stats.app_attempts, 1);
        assert_eq!(stats.activate_attempts, 1);
        assert_eq!(
            stats.generation,
            [("test-app".to_string(), "0000000000000001".to_string())]
        );
        assert_eq!(stats.primary, "test-app");

        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{:?}", calls);
        assert!(
            calls[0].starts_with("deploy ") && calls[0].contains("--no-activate"),
            "{:?}",
            calls
        );
        let activated = activates(&calls);
        assert_eq!(activated.len(), 1, "{:?}", calls);
        assert!(
            activated[0].contains("test-app=0000000000000001")
                && activated[0].contains("--primary test-app"),
            "{:?}",
            calls
        );
        drop(guard_app);
    }

    /// The app stage carries `--sourcemap <path>` so the Errors tab can
    /// symbolicate Worker stacks; the cohosted stages are runner-owned and
    /// the activate stages nothing, so neither takes it.
    #[tokio::test]
    async fn app_stage_passes_sourcemap_while_cohosted_and_activate_skip_it() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let map_path = app_dir.join("worker.js.map");

        deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok")],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: Some(&map_path),
                read_root: None,
            },
        )
        .await
        .unwrap();
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        let flag = format!("--sourcemap {}", map_path.to_string_lossy());
        assert!(
            !calls[0].contains("--sourcemap"),
            "the cohosted stage must not take --sourcemap: {:?}",
            calls
        );
        assert!(
            calls[1].starts_with("deploy ") && calls[1].contains(&flag),
            "the app stage must carry {flag:?}: {:?}",
            calls
        );
        assert!(
            calls[2].starts_with("activate ") && !calls[2].contains("--sourcemap"),
            "the activate must not take --sourcemap: {:?}",
            calls
        );
    }

    /// Each stage names its own read root and no other: the app its
    /// checkout, a cohosted script the directory its render carries (the
    /// sandbox controller's vetted build context), and the activate none.
    #[tokio::test]
    async fn each_stage_passes_only_its_own_read_root() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-read-root",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
            sourcemap: None,
        };
        let guard_app = app_dir();
        let app_dir = guard_app.path().to_path_buf();
        let checkout = app_dir.join("checkout");
        let context = app_dir.join("controller-context");
        let mut cohosted = render("tok");
        cohosted.read_root = Some(context.clone());

        deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[cohosted],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
                sourcemap: None,
                read_root: Some(&checkout),
            },
        )
        .await
        .unwrap();
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        let roots: Vec<usize> = calls
            .iter()
            .map(|call| call.matches("--read-root").count())
            .collect();
        assert_eq!(roots, vec![1, 1, 0], "{calls:?}");
        assert!(
            calls[0].contains(&format!("--read-root {}", context.display())),
            "the cohosted stage reads its context: {calls:?}"
        );
        assert!(
            calls[1].contains(&format!("--read-root {}", checkout.display())),
            "the app stage reads its checkout: {calls:?}"
        );
    }
}
