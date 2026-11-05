use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

use crate::config::{Config, Tenancy};
use crate::db;
use crate::host::build_output;
use crate::host::credentials;
use crate::host::exec::{self, Sandbox};
use crate::host::generated_config;
use crate::host::logs::LogState;
use crate::host::package_manager;
use crate::host::s3;
use crate::host::supervisor::{self, ProcMap};
use crate::host::tips::TipBundle;
use crate::host::void_cohost;
use crate::host::void_deploy;
use crate::host::void_migrate;
use crate::host::void_proxy;
use crate::host::void_sandbox;
use crate::host::worker_vars;
use crate::lifecycle::{self, sha_same};
use crate::models::{App, AppStatus, DeployStatus, Environment};
use sqlx::SqlitePool;

/// Per-app exclusive lock shared by deploy and purge/delete so S3 fleets/git
/// never see overlapping writers (ghost LTX / RestoreFailed after partial wipe).
/// A plain mutex: every critical section below is brief and never held across
/// an await, so a blocking lock here always succeeds promptly (and it lets
/// the guard below release synchronously on drop).
pub type AppLock = Arc<Mutex<HashSet<String>>>;

pub type Deploying = AppLock;

pub fn new_deploying() -> Deploying {
    Arc::new(Mutex::new(HashSet::new()))
}

/// Holding the per-app build/delete/rename claim. The claim releases when
/// this drops, so a cancelled, failed or panicked task can never wedge later
/// callers behind a stale "deploy in flight" — a retried delete finishes
/// instead of 409ing forever.
pub struct AppClaim {
    app_id: String,
    deploying: Deploying,
}

impl AppClaim {
    fn take(deploying: &Deploying, app_id: &str) -> Option<Self> {
        let mut claimed = deploying
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if claimed.contains(app_id) {
            return None;
        }
        claimed.insert(app_id.to_string());
        Some(Self {
            app_id: app_id.to_string(),
            deploying: deploying.clone(),
        })
    }
}

impl Drop for AppClaim {
    fn drop(&mut self) {
        deploying_remove(&self.deploying, &self.app_id);
    }
}

fn deploying_remove(deploying: &Deploying, app_id: &str) {
    deploying
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(app_id);
}

pub async fn claim_owned(deploying: &Deploying, app_id: &str) -> Option<AppClaim> {
    AppClaim::take(deploying, app_id)
}

/// Wait up to `timeout` to acquire the lock (delete waits out an in-flight deploy).
pub async fn claim_wait_owned(
    deploying: &Deploying,
    app_id: &str,
    timeout: Duration,
) -> Option<AppClaim> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if let Some(claim) = claim_owned(deploying, app_id).await {
            return Some(claim);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

pub async fn snapshot_claimed(deploying: &Deploying) -> HashSet<String> {
    deploying
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Why a deploy runs. A tip deploy is deduped against the sha already live
/// (the push fast-path and the reconcile poll can both fire for one push); an
/// explicit one (rollback, redeploy) always builds, so redeploying the live
/// sha rebuilds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployTrigger {
    Tip,
    Explicit,
}

/// Where a deploy lands: production (the app itself), or one preview
/// environment with its own bucket, ports and git ref. An environment deploy
/// can never rewrite production's bucket, ports or `last_deploy_sha` — the two
/// targets share only the build (serialized per app by [`AppLock`]).
#[derive(Debug, Clone)]
pub enum DeployTarget {
    Production,
    Environment(Box<crate::models::Environment>),
}

impl DeployTarget {
    /// The deploy row's target: `None` (NULL) for production.
    pub fn environment_id(&self) -> Option<&str> {
        match self {
            Self::Production => None,
            Self::Environment(env) => Some(&env.id),
        }
    }

    /// The celld bucket this deploy writes durability into.
    pub fn bucket(&self, app: &App) -> String {
        match self {
            Self::Production => app.fleet_bucket.clone(),
            Self::Environment(env) => env.fleet_bucket.clone(),
        }
    }

    /// The ref the worktree is materialized at.
    pub fn git_ref(&self) -> &str {
        match self {
            Self::Production => "refs/heads/main",
            Self::Environment(env) => &env.git_ref,
        }
    }

    /// The sha already live for this target (a tip deploy dedupes against it).
    pub fn last_deploy_sha(&self, app: &App) -> Option<String> {
        match self {
            Self::Production => app.last_deploy_sha.clone(),
            Self::Environment(env) => env.last_deploy_sha.clone(),
        }
    }

    pub fn environment(&self) -> Option<&crate::models::Environment> {
        match self {
            Self::Production => None,
            Self::Environment(env) => Some(env),
        }
    }
}

#[allow(clippy::too_many_arguments)] // shared deps threaded by reference; a context struct would only obfuscate this one call site
pub async fn deploy_app(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    target: DeployTarget,
    object_key: &str,
    tip_sha: Option<&str>,
    trigger: DeployTrigger,
    // A deploy row the caller already created (so it could hand the id back
    // immediately). `None` = this run creates its own.
    deploy_id: Option<&str>,
) {
    // One deploy per app at a time: its builds share the app's build cache,
    // which every deploy prunes when it ends. A deploy someone is watching —
    // the caller pre-created its "queued" row (a rollback, an environment's
    // create or redeploy, a workspace preview) — waits its turn: a preview
    // must not fail because production is building. A background tip deploy
    // has no row and skips; the next reconcile tick picks the tip up again.
    let claimed = match deploy_id {
        Some(_) => {
            let wait = Duration::from_millis(crate::lifecycle::DEPLOY_STUCK_MS.unsigned_abs());
            claim_wait_owned(deploying, &app.id, wait).await
        }
        None => claim_owned(deploying, &app.id).await,
    };
    let Some(_claim) = claimed else {
        // The caller may be waiting on that pre-created row: close it, or it
        // sits "building" until the stuck-deploy sweep.
        if let Some(id) = deploy_id {
            let _ = db::upsert_deploy(
                pool,
                Some(id),
                &app.id,
                target.environment_id(),
                DeployStatus::Failed.as_str(),
                tip_sha,
                "ERROR: deploy skipped, another deploy of this app did not finish in time\n",
            )
            .await;
        }
        tracing::info!(slug = %app.slug, "deploy skip (in flight)");
        return;
    };
    // A deploy is activity (SPEC, Scale to zero): wake an asleep app — or
    // preview environment — so the reconcile loop spawns the fleet this
    // release lands in.
    match &target {
        DeployTarget::Production => crate::host::sleep::wake_for_deploy(pool, &app).await,
        DeployTarget::Environment(env) => {
            crate::host::sleep::wake_environment_for_deploy(pool, env).await;
        }
    }
    let mut progress = Progress {
        pool,
        app_id: &app.id,
        environment_id: target.environment_id().map(str::to_string),
        sha: tip_sha.map(str::to_string),
        id: deploy_id.map(str::to_string),
        step: "fetch",
    };
    let result = deploy_inner(
        pool,
        cfg,
        procs,
        logs,
        &app,
        &target,
        object_key,
        &mut progress,
        trigger,
    )
    .await;
    if let Err(e) = &result {
        let fleet = fleet_label(&app, &target);
        tracing::error!(slug = %fleet, step = progress.step, error = %e, "deploy failed");
        if let Err(db_e) = progress.fail(e).await {
            tracing::error!(slug = %fleet, error = %db_e, "failed to record deploy failure");
        }
    }
    // T5.1: the build just populated the persistent cache; prune it back to
    // the cap now, on success and on failure alike. The claim releases when
    // `_claim` drops at the end of this function (or on any early return,
    // cancel or panic above).
    exec::prune_build_cache(&exec::build_cache_dir(cfg, &app.slug), cfg.build_cache_mb);
}

/// Log label for a target: the slug, or `slug.label` for an environment.
fn fleet_label(app: &App, target: &DeployTarget) -> String {
    match target.environment() {
        Some(env) => format!("{}.{}", app.slug, env.label),
        None => app.slug.clone(),
    }
}

/// The row the deploy targets, re-read after staging: for a preview, the
/// environment's row (a delete raced this build). The fleet must still be
/// wanted before it (re)starts — the staged migrate below can start a
/// stopped fleet — so the Void path checks before its migrate, and every
/// other path right after its own stage-and-activate.
async fn load_deploy_target(
    pool: &SqlitePool,
    app: &App,
    target: &DeployTarget,
) -> anyhow::Result<Option<Environment>> {
    match target {
        DeployTarget::Production => {
            if db::get_app(pool, &app.id).await?.is_none() {
                anyhow::bail!("app {} deleted during deploy; skipping fleet start", app.id);
            }
            Ok(None)
        }
        DeployTarget::Environment(env) => match db::get_environment(pool, &env.id).await? {
            Some(fresh) => Ok(Some(fresh)),
            None => anyhow::bail!(
                "environment {} deleted during deploy; skipping fleet start",
                env.id
            ),
        },
    }
}

/// The deploy row one run writes to and the step it is in: every line of the
/// run, its failure included, lands on that one row, and the failure names
/// the step (`fetch`, `install`, `build`, `convert`, `generate`, `release`, `deploy`,
/// `start`, `migrate`).
struct Progress<'a> {
    pool: &'a SqlitePool,
    app_id: &'a str,
    /// The environment this run targets; `None` is production. Decides which
    /// row the status lands on (the app, or the environment).
    environment_id: Option<String>,
    sha: Option<String>,
    id: Option<String>,
    step: &'static str,
}

impl Progress<'_> {
    async fn log(&mut self, status: DeployStatus, text: &str) -> sqlx::Result<()> {
        let id = db::upsert_deploy(
            self.pool,
            self.id.as_deref(),
            self.app_id,
            self.environment_id.as_deref(),
            status.as_str(),
            self.sha.as_deref(),
            text,
        )
        .await?;
        self.id = Some(id);
        Ok(())
    }

    /// Enter `step`, logged as `▸ step: detail`.
    async fn step(
        &mut self,
        step: &'static str,
        status: DeployStatus,
        detail: &str,
    ) -> sqlx::Result<()> {
        self.step = step;
        self.log(status, &format!("▸ {step}: {detail}\n")).await
    }

    /// A step's output tail, for the log of a step that succeeded.
    async fn output(&mut self, out: &str) -> sqlx::Result<()> {
        let out = lifecycle::strip_ansi(out);
        let tail = lifecycle::tail_utf8(out.trim_end(), STEP_OUTPUT_TAIL);
        if tail.is_empty() {
            return Ok(());
        }
        self.log(DeployStatus::Building, &format!("{tail}\n")).await
    }

    /// Record `err` on the row and a one-line summary on the target (the app
    /// for production, the environment for a preview).
    async fn fail(&mut self, err: &anyhow::Error) -> sqlx::Result<()> {
        let detail = lifecycle::strip_ansi(&format!("{err:#}")).into_owned();
        let detail = lifecycle::tail_utf8(detail.trim_end(), FAILURE_TAIL);
        self.log(
            DeployStatus::Failed,
            &format!("ERROR: {} failed\n{detail}\n", self.step),
        )
        .await?;
        let summary = failure_summary(self.step, detail);
        match self.environment_id.as_deref() {
            // `upsert_deploy` already moved the environment to failed with the
            // log tail; this adds the one-line summary the UI lists.
            Some(env_id) => {
                db::update_environment_status_if_wanted(
                    self.pool,
                    env_id,
                    AppStatus::Failed.as_str(),
                    Some(&summary),
                )
                .await?;
            }
            None => {
                db::update_app_status_if_wanted(
                    self.pool,
                    self.app_id,
                    AppStatus::Failed.as_str(),
                    Some(&summary),
                )
                .await?;
            }
        }
        Ok(())
    }
}

/// One bound over pulling and vetting every Dockerfile image of a deploy.
const PREPARE_IMAGES_TIMEOUT: Duration = Duration::from_secs(600);

/// Output kept per successful step, and for a failure: the deploy row keeps
/// a 64 KB tail, and earlier steps should survive a noisy failure.
const STEP_OUTPUT_TAIL: usize = 4 * 1024;
const FAILURE_TAIL: usize = 24 * 1024;

/// One line for the app panel: the failed step and the first line of its
/// output that names an error (the line after it for a heading like Vite's
/// `error during build:`), else the error's own first line.
fn failure_summary(step: &str, detail: &str) -> String {
    let lines: Vec<&str> = detail
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut pick = lines.first().copied().unwrap_or("");
    for (i, line) in lines.iter().enumerate().skip(1) {
        if !line.to_ascii_lowercase().contains("error") {
            continue;
        }
        pick = if line.ends_with(':') {
            lines.get(i + 1).copied().unwrap_or(line)
        } else {
            line
        };
        break;
    }
    let line: String = pick.chars().take(300).collect();
    format!("{step} failed: {line}")
}

#[allow(clippy::too_many_arguments)] // the deploy_app deps plus the trigger; same rationale as deploy_app
async fn deploy_inner(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
    target: &DeployTarget,
    object_key: &str,
    progress: &mut Progress<'_>,
    trigger: DeployTrigger,
) -> anyhow::Result<()> {
    let fleet = fleet_label(app, target);
    let commit_sha = progress
        .sha
        .clone()
        .or_else(|| {
            let re = regex::Regex::new(r"(?i)/([0-9a-f]{7,40})\.bundle$").ok()?;
            re.captures(object_key)
                .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        })
        .ok_or_else(|| anyhow::anyhow!("could not parse commit sha from {object_key}"))?;
    progress.sha = Some(commit_sha.clone());

    // Dedupe: webhook + tip-poll can both fire; claim serializes, re-read sha.
    // An explicit deploy of the live sha is a rebuild and runs. Production
    // dedupes against `app.last_deploy_sha`; an environment against its own,
    // so a preview can never make production skip (or the reverse).
    let (live_sha, production_bucket) = match target {
        DeployTarget::Production => {
            let Some(fresh) = db::get_app(pool, &app.id).await? else {
                anyhow::bail!("app {} gone before deploy (deleted?)", app.id);
            };
            (fresh.last_deploy_sha.clone(), Some(fresh.fleet_bucket))
        }
        DeployTarget::Environment(env) => match db::get_environment(pool, &env.id).await? {
            Some(fresh) => (fresh.last_deploy_sha, None),
            None => anyhow::bail!("environment {} gone before deploy", env.id),
        },
    };
    if trigger == DeployTrigger::Tip
        && live_sha
            .as_deref()
            .is_some_and(|s| sha_same(s, &commit_sha))
    {
        tracing::info!(
            slug = %fleet,
            sha = %&commit_sha[..12.min(commit_sha.len())],
            "deploy skip (already at sha)"
        );
        return Ok(());
    }
    // An environment deploy writes its own bucket; production keeps the app's
    // (re-read above so a concurrent rename cannot leave us writing the old
    // prefix).
    let bucket = match production_bucket {
        Some(bucket) => bucket,
        None => target.bucket(app),
    };

    let root = exec::work_root(cfg);
    // A clock before the epoch (operator-set time) must not panic the deploy
    // task: fall back to zero instead of unwrapping.
    let work = root.join("builds").join(&app.slug).join(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string(),
    );
    tokio::fs::create_dir_all(&work).await?;
    // builds/<slug>/ is created private (umask 077); the app's build uid must
    // be able to reach its worktree through it, and bun lists parent
    // directories to resolve a project (see isolation::harden_data_dir).
    #[cfg(unix)]
    if let Some(slug_dir) = work.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(slug_dir, std::fs::Permissions::from_mode(0o755));
    }

    progress
        .step(
            "fetch",
            DeployStatus::Building,
            &format!(
                "{} via {} (work={})",
                cfg.s3_uri(object_key),
                cfg.s3_endpoint,
                work.display()
            ),
        )
        .await?;

    // T5.2: the bare mirror (`repos/<slug>.git`, same one the source preview
    // reads) already has this sha on a warm app — fetch from it instead of
    // re-downloading the full bundle from S3. The mirror only ever gains the
    // shas deploys fetched, so `cat-file -e` is the whole check.
    let bare = exec::work_root(cfg)
        .join("repos")
        .join(format!("{}.git", app.slug));
    let mirror_warm = bare.join("HEAD").exists()
        && exec::run_cmd(
            "git",
            &[
                &format!("--git-dir={}", bare.display()),
                "cat-file",
                "-e",
                &commit_sha,
            ],
            Some(&work),
            &[],
            Duration::from_secs(30),
        )
        .await
        .is_ok();
    let bundle_path = work.join(format!("{commit_sha}.bundle"));
    let fetch_from = if mirror_warm {
        tracing::info!(slug = %app.slug, sha = %&commit_sha[..12.min(commit_sha.len())], "mirror warm; skipping bundle download");
        progress
            .log(
                DeployStatus::Building,
                &format!(
                    "mirror warm ({}); skipping bundle download\n",
                    &commit_sha[..12.min(commit_sha.len())]
                ),
            )
            .await?;
        bare.clone()
    } else {
        let uri = cfg.s3_uri(object_key);
        s3::s3_cp_download(cfg, &uri, &bundle_path).await?;
        let bytes = tokio::fs::metadata(&bundle_path).await?.len();
        progress
            .log(
                DeployStatus::Building,
                &format!(
                    "downloaded {bytes} bytes · {}\n",
                    &commit_sha[..12.min(commit_sha.len())]
                ),
            )
            .await?;
        bundle_path.clone()
    };

    let src_dir =
        materialize_bundle(cfg, app, &work, &fetch_from, &commit_sha, target.git_ref()).await?;
    // Tenant env (`.dev.vars` model): build + release see the same vars the
    // fleet gets at spawn. Reserved platform names filtered in db (now
    // including RUNNER_*/NOITE_*/BETTER_AUTH_*/CADDY_*/LD_*/NODE_OPTIONS/BUN_*).
    // An environment inherits the app's variables with its own overrides on
    // top.
    let tenant = match target.environment() {
        Some(env) => db::environment_tenant_env(pool, &app.id, &env.id).await,
        None => db::tenant_env(pool, &app.id).await,
    };
    let tenant_refs: Vec<(&str, &str)> = tenant
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    // Tenancy gate (SPEC, Tenancy mode): multi-tenant builds require the uid
    // drop. Without CAP_SETUID/CAP_SETGID the runner refuses builds rather
    // than running tenant scripts as itself with platform secrets in reach.
    let multi = cfg.tenancy == Tenancy::Multi;
    if multi && cfg.build_uid_base.is_none() {
        anyhow::bail!("build sandbox unavailable (RUNNER_BUILD_UID_BASE=none); refusing build in multi-tenant mode");
    }
    // One uid per app (db::ensure_app_build_uid): builds of two different
    // apps never share an identity, so neither can read the other's worktree
    // or cache. gid mirrors the uid (a group per app).
    let build_uid =
        db::alloc::ensure_app_build_uid(pool, cfg.build_uid_base, cfg.build_uid_range, &app.id)
            .await?;
    let sandbox_ok = match build_uid {
        Some(u) => exec::can_drop_uid(u, u),
        None => false,
    };
    if multi && build_uid.is_none() {
        anyhow::bail!(
            "build sandbox unavailable (no per-app build uid); refusing build in multi-tenant mode"
        );
    }
    if multi && !sandbox_ok {
        anyhow::bail!("build sandbox unavailable (no CAP_SETUID/SETGID for build uid); refusing build in multi-tenant mode");
    }
    let sandbox_id = build_uid.filter(|_| sandbox_ok);

    // The package manager (package_manager.rs). An unpinned project's spec
    // goes beside the tree, not in it, and is written before the handover
    // below so the build uid can read it.
    let package = read_package_json(&src_dir).await?;
    let manager = package
        .as_ref()
        .map(|p| package_manager::detect(&src_dir, p));
    let spec_path = work.join("package-manager.json");
    let spec_env = match manager
        .as_ref()
        .and_then(package_manager::PackageManager::spec_file)
    {
        Some(spec) => {
            tokio::fs::write(&spec_path, spec).await?;
            Some(spec_path.to_string_lossy().into_owned())
        }
        None => None,
    };
    let mut step_env = tenant_refs.clone();
    if let Some(path) = &spec_env {
        step_env.push(("JUP_SPEC_FILE", path.as_str()));
    }

    // Hand the worktree to the app's build uid before tenant scripts run;
    // 0700 (the runner's umask) means no other app's uid can read into it.
    if let Some(uid) = sandbox_id {
        if !exec::lchown_tree(&work, uid, uid) {
            tracing::warn!(slug = %app.slug, "chown worktree to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    // T5.1: persistent per-app build cache (bun, jup's package managers, and
    // HOME for npm/pnpm/Yarn; exec::base_env). Created root-owned (umask 077,
    // so the fleet uid can never read it) and handed to the build uid exactly
    // like the worktree. It outlives the per-deploy worktree wiped below.
    let cache = exec::build_cache_dir(cfg, &app.slug);
    tokio::fs::create_dir_all(&cache).await?;
    // Bundled npm/pnpm (SPEC, Package managers): seed the app's JUP_HOME from
    // the image's read-only store before the handover below, so the install
    // step runs the bundled release with no registry request. A missing seed
    // (dev, old image) only warns: jup then downloads the release. The copy
    // is tens of MB of blocking file I/O, so it runs off the async workers.
    if let Some((name, version)) = manager
        .as_ref()
        .and_then(package_manager::PackageManager::bundled)
    {
        let (seed_cache, seed_name, seed_version) =
            (cache.clone(), name.to_string(), version.to_string());
        let seeded = tokio::task::spawn_blocking(move || {
            exec::seed_bundled_manager(
                Path::new(exec::BUNDLED_SEED_DIR),
                &seed_cache,
                &seed_name,
                &seed_version,
            )
        })
        .await
        .unwrap_or(false);
        if !seeded {
            tracing::warn!(slug = %app.slug, name, version, "bundled manager seed missing; jup will download the release");
        }
    }
    #[cfg(unix)]
    if let Some(parent) = cache.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755));
    }
    if let Some(uid) = sandbox_id {
        if !exec::lchown_tree(&cache, uid, uid) {
            tracing::warn!(slug = %app.slug, "chown build cache to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    let sb = Sandbox {
        uid: sandbox_id,
        gid: sandbox_id,
        env: &step_env,
        cache: Some(&cache),
    };

    exec::check_work_quota(&work, cfg.build_max_mb)?;
    let step_timeout = Duration::from_secs(cfg.build_timeout_s);
    let wrangler_build = wrangler_build(&src_dir).await?;
    if let Some(pm) = &manager {
        let (program, args) = pm.install();
        progress
            .step(
                "install",
                DeployStatus::Building,
                &format!("{} install ({})", pm.name, pm.reason),
            )
            .await?;
        let out = exec::run_sandboxed(program, &args, &src_dir, &sb, step_timeout).await?;
        progress.output(&out).await?;
        exec::check_work_quota(&work, cfg.build_max_mb)?;
    }
    // Wrangler's own custom build (`build.command`, run from `build.cwd`)
    // wins over the package `build` script, as it does for `wrangler deploy`.
    let mut built = false;
    if let Some(build) = &wrangler_build {
        progress
            .step("build", DeployStatus::Building, &build.command)
            .await?;
        let cwd = src_dir.join(&build.cwd);
        let out =
            exec::run_sandboxed("sh", &["-c", &build.command], &cwd, &sb, step_timeout).await?;
        progress.output(&out).await?;
        built = true;
    } else if let Some(pm) = manager
        .as_ref()
        .filter(|_| package.as_ref().is_some_and(has_build_script))
    {
        let (program, args) = pm.run("build");
        progress
            .step(
                "build",
                DeployStatus::Building,
                &format!("{} run build", pm.name),
            )
            .await?;
        let out = exec::run_sandboxed(program, &args, &src_dir, &sb, step_timeout).await?;
        progress.output(&out).await?;
        built = true;
    }
    if built {
        exec::check_work_quota(&work, cfg.build_max_mb)?;
    }

    // `cf` CLI apps declare the Worker in cloudflare.config.ts; generate the
    // wrangler.json celld deploys, unless the tree or the build has one.
    if tokio::fs::try_exists(src_dir.join(CF_CONFIG)).await?
        && !has_wrangler_config(&src_dir).await?
    {
        progress
            .step(
                "convert",
                DeployStatus::Building,
                &format!("{CF_CONFIG} → wrangler.json"),
            )
            .await?;
        exec::run_sandboxed(
            "node",
            &["--input-type=module", "-e", CF_CONFIG_CONVERTER, CF_CONFIG],
            &src_dir,
            &sb,
            Duration::from_secs(60),
        )
        .await
        // The failure message starts with the argv, i.e. the whole script.
        .map_err(|e| {
            let msg = e.to_string();
            let detail = msg.split_once('\n').map_or(msg.as_str(), |(_, rest)| rest);
            anyhow::anyhow!("{CF_CONFIG}: {}", detail.trim())
        })?;
    }

    // What the build produced outranks the source config (build_output.rs).
    let built_root = if built {
        build_output::built_deploy_root(&src_dir)?
    } else {
        None
    };
    // No config anywhere: generate one from what the build left
    // (generated_config.rs). Decided now, so a tree with nothing to deploy
    // fails before its release command; written only once the tree is the
    // runner's again, below.
    let mut generated = None;
    // Void's required secrets, captured before the build-output rewrite
    // dropped the key celld refuses: checked against settings below.
    let required_secrets = built_root
        .as_ref()
        .map(|built| built.required_secrets.clone())
        .unwrap_or_default();
    // The Void gate for the runner-owned injections below: only a root from
    // Void's own build output gets identity vars, provisioned secrets and
    // the `ISR_CACHE` namespace.
    let void_app = void_deploy::is_void_build(built_root.as_ref());
    let deploy_root = match built_root {
        Some(built) => {
            progress
                .log(DeployStatus::Building, &format!("config: {}\n", built.note))
                .await?;
            built.dir
        }
        None => match find_deploy_root(&src_dir).await? {
            Some(root) => root,
            None => {
                progress
                    .step(
                        "generate",
                        DeployStatus::Building,
                        "no Wrangler config: generating one",
                    )
                    .await?;
                let plan =
                    generated_config::plan(&src_dir, package.as_ref())?.ok_or_else(|| {
                        anyhow::anyhow!(
                        "nothing to deploy: no Wrangler config, no index.html in dist/, build/ or \
                         out/, and no package.json main exporting a fetch handler"
                    )
                    })?;
                progress
                    .log(
                        DeployStatus::Building,
                        &format!("config: {}\n", plan.note()),
                    )
                    .await?;
                generated = Some(plan);
                src_dir.clone()
            }
        },
    };

    if db::get_app(pool, &app.id).await?.is_none() {
        anyhow::bail!("app {} deleted during build; aborting celld deploy", app.id);
    }

    // One-shot release command (`"release": "bun run db:migrate"` in the
    // tenant wrangler config), run once after build, before `celld deploy`.
    // Failure aborts: the old release keeps serving. 10 min hard timeout.
    // Release must not see root keys (SPEC, Build and release sandbox): in multi it gets the scoped
    // credential or is disabled with a clear log line; single keeps root.
    if let Some(release) = release_cmd(&src_dir).await {
        // The scope whose key the release holds: the environment's own
        // prefix for a preview deploy, the app's for production.
        let scope = match target.environment() {
            Some(env) => credentials::Scope::environment(env),
            None => credentials::Scope::app(app),
        };
        progress
            .step("release", DeployStatus::Building, &release)
            .await?;
        let scoped = credentials::tenant_process_credentials(pool, cfg, &scope)
            .await
            .ok()
            .flatten();
        if scoped.is_none() {
            progress
                .log(
                    DeployStatus::Building,
                    "release skipped: multi-tenant mode runs release commands only with scoped bucket credentials (SPEC, Scoped credentials)\n",
                )
                .await?;
        } else {
            let mut owned: Vec<(String, String)> = Vec::new();
            if let Some(s) = scoped {
                owned.push(("AWS_ACCESS_KEY_ID".into(), s.access_key));
                owned.push(("AWS_SECRET_ACCESS_KEY".into(), s.secret_key));
                owned.push(("AWS_REGION".into(), cfg.aws_region.clone()));
                owned.push(("AWS_DEFAULT_REGION".into(), cfg.aws_region.clone()));
                owned.push(("AWS_EC2_METADATA_DISABLED".into(), "true".into()));
            }
            owned.push(("S3_ENDPOINT".into(), cfg.s3_endpoint.clone()));
            owned.push(("NOITE_S3_BUCKET".into(), cfg.s3_bucket.clone()));
            // The prefix this deploy owns: production's fleet bucket, or the
            // environment's own — a release command must never touch the
            // other.
            let prefix = match target.environment() {
                Some(env) => format!("envs/{}/{}", app.slug, env.label),
                None => format!("fleets/{}", app.slug),
            };
            owned.push(("NOITE_APP_PREFIX".into(), prefix));
            let mut cmd_env: Vec<(&str, &str)> = owned
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            cmd_env.extend(step_env.iter().copied());
            let sb_release = Sandbox {
                uid: sb.uid,
                gid: sb.gid,
                env: &cmd_env,
                cache: sb.cache,
            };
            let out = exec::run_sandboxed(
                "sh",
                &["-c", &release],
                &src_dir,
                &sb_release,
                Duration::from_secs(600),
            )
            .await?;
            progress.output(&out).await?;
        }
    }

    // Tenant steps are over: take the tree back from the build uid, so
    // nothing it left behind can change the bundle `celld deploy` uploads.
    #[cfg(unix)]
    if sb.uid.is_some() {
        // SAFETY: geteuid/getegid cannot fail.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        if !exec::lchown_tree(&work, uid, gid) {
            anyhow::bail!(
                "could not take the worktree back from the build uid; refusing to deploy it"
            );
        }
    }
    // Only now, with no tenant process left to swap it, is the deploy root
    // final: `celld deploy` runs as the runner, so neither the root nor its
    // config may lead out of the worktree (a `dist` symlink into /data would
    // otherwise ship platform files into the tenant's bucket).
    let src_dir = src_dir.canonicalize()?;
    if let Some(plan) = &generated {
        generated_config::write(&src_dir, &app.slug, plan)?;
    }
    let deploy_root = contained_deploy_root(&src_dir, &deploy_root)?;
    // `release` and `build` are keys the runner consumes: celld deploy
    // refuses any config key it does not know, so drop them once they ran.
    strip_runner_keys(&deploy_root).await?;
    if deploy_root != src_dir {
        strip_runner_keys(&src_dir).await?;
    }
    progress
        .step(
            "deploy",
            DeployStatus::Deploying,
            &format!("celld deploy → {bucket}"),
        )
        .await?;

    // Managed Void sandbox (SPEC, Void sandbox controller): a Void app
    // whose built config carries a `durable_object`-policy containers
    // entry gets a controller cohosted in its fleet. The entry moves out
    // of the app config now — the merges below never touch `containers`,
    // so stripping first changes nothing they see — and the held entry
    // stages the controller after the merges. Detected once, here: the
    // required-secrets check, the runner-owned merge and the staging all
    // key on this one value.
    let sandbox_entry = if void_app {
        void_sandbox::take_sandbox_entry(&deploy_root)?
    } else {
        None
    };
    let has_sandbox = sandbox_entry.is_some();

    // Settings → Worker `vars` (SPEC, Tenant env): the app's settings, or the
    // environment's overrides over them, become the deployed config's `vars`
    // (a setting wins over the config's own value), so Worker code reads them
    // as `env.NAME`. Reserved platform names and required secrets with no
    // value fail the deploy here, before `celld deploy`, naming the variables
    // — never their values — in the log.
    let settings_label = match target.environment() {
        Some(_) => "Settings → Environment or this environment's Variable overrides",
        None => "Settings → Environment",
    };
    // A Void app's `BETTER_AUTH_SECRET` provisions before the load: minted
    // once per fleet (the app row for production, the environment's own
    // override row for a preview — a preview deploy never writes the app
    // row), unless a value already exists, so it flows through the ordinary
    // settings load into the merge below like a setting. Gated on Void, not
    // on the name's presence in `secrets.required`: Void's auth signal is
    // build-time source inference (`manifest.auth`), which plain builds do
    // not repeat into `required` (only `VOID_CLOUDFLARE_DEPLOY_BUILD=1`
    // does), while the auth middleware fails every request without the
    // secret — so an unread extra var on a non-auth app beats a broken auth
    // app.
    if void_app {
        let environment_id = target.environment().map(|env| env.id.as_str());
        if void_deploy::ensure_auth_secret(pool, &app.id, environment_id).await? {
            let provisioned_label = match target.environment() {
                Some(_) => "this environment's Variable overrides",
                None => "Settings → Environment",
            };
            progress
                .log(
                    DeployStatus::Deploying,
                    &format!(
                        "worker vars: no BETTER_AUTH_SECRET setting, so one was generated and stored in {} (set your own value there to replace it)\n",
                        provisioned_label
                    ),
                )
                .await?;
        }
    }
    let worker_settings = match target.environment() {
        Some(env) => db::environment_worker_settings(pool, &app.id, &env.id).await,
        None => db::worker_settings(pool, &app.id).await,
    }
    .map_err(|e| anyhow::Error::new(e).context("read the app's settings for the Worker"))?;
    worker_vars::check_required(
        &required_secrets,
        &worker_settings,
        &worker_vars::provisioned_names(
            void_app,
            !cfg.void_proxy.email_domain.is_empty(),
            has_sandbox,
        ),
        settings_label,
    )?;
    // Proxy-only settings (Void apps): the three credential names split
    // out for the proxy render before the app merges — they are refused
    // as app Worker vars, so the merges must never see them. The
    // required check above already ran on the full list; anything else
    // `VOID_PROXY_*` stays in the remainder and fails its merge loudly.
    let (proxy_settings, worker_settings) = if void_app {
        void_proxy::split_proxy_settings(worker_settings)
    } else {
        (void_proxy::ProxySettings::default(), worker_settings)
    };
    if let Some(stats) =
        worker_vars::merge_deploy_root(&deploy_root, &worker_settings, settings_label)?
    {
        if stats.merged > 0 {
            progress
                .log(DeployStatus::Deploying, &stats.log_line())
                .await?;
        }
    }
    // Runner-owned Void entries (SPEC, Deploy pipeline): identity vars,
    // runner-owned `services` and the `ISR_CACHE` namespace, merged into
    // the same config file the settings merge just wrote. Void apps only.
    // A TOML-only root merges nothing (`celld deploy` itself refuses it):
    // the `None` below keeps such a doomed deploy from running its
    // cohosted scripts first. The ensured token rides along so the proxy
    // render below reuses this deploy's value instead of re-reading the
    // row (a rotation landing between the two would split app and proxy).
    let void_proxy_token: Option<String> = if void_app {
        let merged = void_deploy::merge_void_root(
            pool,
            app,
            target.environment(),
            &void_deploy::VoidMergeCtx {
                deploy_root: &deploy_root,
                settings: &worker_settings,
                email_domain: (!cfg.void_proxy.email_domain.is_empty())
                    .then_some(cfg.void_proxy.email_domain.as_str()),
                settings_label,
                sandbox: has_sandbox,
            },
        )
        .await?;
        if let Some((stats, _)) = &merged {
            progress
                .log(DeployStatus::Deploying, &stats.log_line(settings_label))
                .await?;
        }
        merged.map(|(_, token)| token)
    } else {
        None
    };

    // The sandbox controller stages after the merges (SPEC, Void sandbox
    // controller): protocol check, bundle load, admission name, and the
    // mapped entry written to a staging dir. Only for a merged root: a
    // TOML-only root stages nothing (celld refuses it, as before).
    let staged_sandbox = match (&void_proxy_token, sandbox_entry) {
        (Some(_), Some(entry)) => {
            let staged = void_sandbox::StagedSandbox::stage(
                pool,
                &app.id,
                target.environment_id(),
                &void_sandbox::StageInputs {
                    entry,
                    app_root: &deploy_root,
                    src_dir: &src_dir,
                    bundle_dir: Path::new(&cfg.void_sandbox_bundle_dir),
                    max_concurrent: cfg.void_sandbox_max_concurrent,
                },
            )
            .await?;
            progress
                .log(DeployStatus::Deploying, &staged.log_line())
                .await?;
            Some(staged)
        }
        _ => None,
    };

    // celld pulls container images for linux/amd64 unless told otherwise;
    // pin the pull to the nodes' own arch so arm64 installs pull native
    // images. Without containers celld never reads it.
    let container_platform = format!("linux/{}", go_arch(std::env::consts::ARCH));
    // Sandbox containers (SPEC, Tenant isolation): refuse what tenants must
    // not deploy before celld sees it, normalize Void's shape, and prepare
    // each Dockerfile (checked to run nothing, its images vetted and
    // pinned). A config that declares containers also stretches the
    // timeout over a first image pull. The staged controller entry plans
    // through the same step (its `NOITE_SANDBOX` gate refuses a sandbox app
    // on an install with containers off), with an unpinned registry ref
    // refused before anything prepares.
    let mut app_plan = build_output::plan_containers(&deploy_root, cfg.sandbox_disabled)?;
    let mut sandbox_plan = match &staged_sandbox {
        None => None,
        Some(staged) => build_output::plan_containers(staged.dir(), cfg.sandbox_disabled)
            .with_context(|| "the managed sandbox containers entry")?,
    };
    if let Some(plan) = &sandbox_plan {
        void_sandbox::check_registry_pin(plan)?;
    }
    // The pinned Dockerfile behind the staged entry, if it builds from
    // one: the render hashes it beside its build context.
    let mut sandbox_pinned: Option<(crate::host::container_image::Request, PathBuf)> = None;
    if app_plan.is_some() || sandbox_plan.is_some() {
        // One bound over every pull and vet, like the deploy's own.
        tokio::time::timeout(PREPARE_IMAGES_TIMEOUT, async {
            if let Some(plan) = app_plan.as_mut() {
                for (index, request) in plan.dockerfiles.clone() {
                    let dockerfile = crate::host::container_image::prepare(
                        &src_dir,
                        index,
                        &request,
                        &container_platform,
                    )
                    .await
                    .map_err(|e| e.context(format!("containers[{}] image", index)))?;
                    plan.set_dockerfile(index, &dockerfile);
                }
            }
            if let Some(plan) = sandbox_plan.as_mut() {
                for (index, request) in plan.dockerfiles.clone() {
                    let dockerfile = crate::host::container_image::prepare(
                        &src_dir,
                        index,
                        &request,
                        &container_platform,
                    )
                    .await
                    .map_err(|e| e.context("prepare the managed sandbox image"))?;
                    plan.set_dockerfile_absolute(index, &dockerfile);
                    sandbox_pinned = Some((request, dockerfile));
                }
            }
            anyhow::Ok(())
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "preparing container images took longer than {} s",
                PREPARE_IMAGES_TIMEOUT.as_secs()
            )
        })??;
    }
    if let Some(plan) = &app_plan {
        plan.write()?;
    }
    let declares_containers = app_plan.is_some();

    let scope_key = match target.environment() {
        Some(env) => crate::host::credentials::Scope::environment(env).key(),
        None => crate::host::credentials::Scope::app(app).key(),
    };
    let env_owned = s3::celld_cli_env(cfg, &scope_key);
    let mut env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("CELLD_CONTAINER_PLATFORM", container_platform.as_str()));
    // The ordered fleet deploy (SPEC, Void platform proxy): every script
    // staged with `celld deploy --no-activate` — the cohosted scripts first
    // (each skipped when unchanged), the tenant app last — the Void
    // migrations of a redeploy running against that staged generation
    // through `celld invoke`, then one `celld activate` serving the
    // generation. A Void app with a merged root renders its proxy here —
    // with the token the merge above ensured, read once for the whole
    // deploy — plus its sandbox controller when one staged (the
    // controller's lower order stages it first), while any other app
    // stages exactly one script, as before. The shared invocation fails
    // the deploy on a non-UTF-8 deploy root (work-dir-derived paths are
    // operator-influenced) instead of panicking the deploy task.
    let cohosted = if let Some(proxy_token) = &void_proxy_token {
        let mut scripts = Vec::new();
        if let Some(staged) = &staged_sandbox {
            let planned = sandbox_plan
                .as_ref()
                .context("staged sandbox controller declares no containers")?;
            // Blocking tree I/O (the build context walk): off the async
            // workers, as the other blocking reads in this pipeline.
            let image_digest = match sandbox_pinned.clone() {
                None => None,
                Some((request, pinned)) => {
                    let src = src_dir.clone();
                    let context = tokio::task::spawn_blocking(move || {
                        crate::host::container_image::context_digest(&src, &request)
                    })
                    .await
                    .map_err(|e| anyhow::anyhow!("build context digest failed: {}", e))??;
                    Some(void_sandbox::dockerfile_image_digest(&pinned, &context)?)
                }
            };
            let mut rendered = staged.render(planned.value(), image_digest)?;
            // The controller deploys from a staging dir while its pinned
            // Dockerfile sits in the vetted build context: celld builds it
            // only with that context named as a read root.
            rendered.read_root = sandbox_pinned
                .as_ref()
                .and_then(|(_, pinned)| pinned.parent())
                .map(Path::to_path_buf);
            scripts.push(rendered);
        }
        scripts.push(void_proxy::render_proxy(&void_proxy::ProxyRenderCtx {
            app_id: &app.id,
            app_slug: &app.slug,
            proxy_token,
            operator: &cfg.void_proxy,
            settings: &proxy_settings,
        }));
        scripts
    } else {
        Vec::new()
    };
    let celld = void_cohost::CelldDeploy {
        celld_bin: cfg.celld_bin.as_str(),
        env: &env,
        bucket: bucket.as_str(),
        endpoint: cfg.s3_endpoint.as_str(),
        region: cfg.aws_region.as_str(),
        timeout: Duration::from_secs(120),
        sourcemap: None,
    };
    // The Worker map celld writes for the Errors tab: in the work dir beside
    // the checkout, never inside the deploy root. celld warns and writes
    // nothing for asset-only, `no_bundle`, and Python projects; a missing
    // file below then means no worker map.
    let worker_map_path = work.join("worker.js.map");
    // A tenant build script runs with the whole work dir writable, so it may
    // have planted this path — a decoy file celld would leave in place for
    // unmapped projects, or a symlink celld's runner-owned write would
    // follow. The tree is runner-owned again by now and no tenant process
    // runs past this point, so drop whatever sits there: whatever celld
    // writes afterwards is its own. If anything survives, refuse to deploy:
    // celld's write would follow a surviving symlink.
    let _ = tokio::fs::remove_file(&worker_map_path).await;
    let _ = tokio::fs::remove_dir_all(&worker_map_path).await;
    match tokio::fs::symlink_metadata(&worker_map_path).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => anyhow::bail!("could not clear the worker source map path before deploy"),
        Err(e) => return Err(e).context("check the worker source map path before deploy"),
    }
    let app_side = void_cohost::FleetApp {
        dir: &deploy_root,
        cwd: Some(&work),
        timeout: if declares_containers {
            void_cohost::CONTAINER_DEPLOY_TIMEOUT
        } else {
            Duration::from_secs(120)
        },
        sourcemap: Some(&worker_map_path),
        read_root: Some(&src_dir),
    };
    let mut migrated_staged = false;
    // Void apps split the ordered deploy around their migrations: every
    // script staged first, the migrations driven against that staged
    // generation, then the one activate serving it. Every other app stages
    // and activates as one step, as before.
    let (stats, environment) = if void_app {
        let staged = void_cohost::stage_fleet_in_order(
            pool,
            &app.id,
            target.environment_id(),
            &celld,
            &cohosted,
            &app_side,
        )
        .await?;
        // The row the deploy targets must still be there before the fleet
        // starts: for a preview, the environment's row (a delete raced
        // this build). The staged migrate below can (re)start the fleet,
        // so the check runs before it.
        let environment = load_deploy_target(pool, app, target).await?;
        // A redeploy has a previous generation that could be serving: run
        // the migrations against the staged generation now, before the
        // activate moves traffic to it. A migrate failure fails the deploy
        // here — the old version keeps serving, nothing activates. A
        // first deploy (or a fleet with no servable generation — wiped
        // bucket, fleet that cannot boot) has no old schema to protect, so
        // the migrate step stays after activation there, as before.
        let previously_deployed = match target.environment() {
            Some(env) => env.is_deployed(),
            None => app.is_deployed(),
        };
        if previously_deployed {
            match ensure_prior_fleet_healthy(pool, cfg, procs, logs, app, environment.as_ref())
                .await
            {
                Ok(()) => {
                    migrate_void_app_staged(
                        MigrateInputs {
                            pool,
                            cfg,
                            app,
                            target,
                            src_dir: &src_dir,
                            deploy_root: &deploy_root,
                            commit_sha: &commit_sha,
                            progress: &mut *progress,
                        },
                        &celld,
                        &staged,
                    )
                    .await?;
                    migrated_staged = true;
                }
                Err(error) => {
                    progress
                        .log(
                            DeployStatus::Deploying,
                            &format!(
                                "migrate: staged invoke unavailable ({error:#}); migrating after activation\n"
                            ),
                        )
                        .await?;
                }
            }
        }
        let stats =
            activate_after_staged_migrate(pool, app, target, &celld, staged, progress).await?;
        (stats, environment)
    } else {
        let stats = void_cohost::deploy_fleet_in_order(
            pool,
            &app.id,
            target.environment_id(),
            &celld,
            &cohosted,
            &app_side,
        )
        .await?;
        let environment = load_deploy_target(pool, app, target).await?;
        (stats, environment)
    };
    for line in stats.log_lines() {
        progress.log(DeployStatus::Deploying, &line).await?;
    }
    // The deploy succeeded, so celld's map (when it wrote one) is final:
    // read it now, chained through the build's own entry map when one
    // exists. The bytes upload with the rest of the maps below.
    let worker_map = crate::host::sourcemaps::read_celld_worker_map(&deploy_root, &worker_map_path)
        .await
        .map_err(|e| format!("{e:#}"));

    // Only production records the deployed Wrangler config: it is what the
    // app's storage views render, and a preview's config must not overwrite it.
    if environment.is_none() {
        db::set_deployed_config(
            pool,
            &app.id,
            effective_config(&deploy_root).await.as_deref(),
        )
        .await?;
    }

    progress.step = "start";
    match &environment {
        Some(_) => {
            let Some(env) = target.environment() else {
                anyhow::bail!("environment deploy without its environment row");
            };
            supervisor::ensure_environment_fleet(pool, cfg, procs, logs, env).await?;
            // A failed adoption fails the deploy with celld's error: without
            // this the old generation keeps serving and the row still says
            // Success.
            supervisor::reload_environment_fleet(env)
                .await
                .fail_deploy_on_failed(&supervisor::env_fleet_key(&env.app_slug, &env.label))?;
        }
        None => {
            supervisor::ensure_fleet(pool, cfg, procs, logs, app).await?;
            supervisor::reload_fleet(app)
                .await
                .fail_deploy_on_failed(&app.slug)?;
        }
    }

    // "Running" (and this row's success) means the fleet answers its
    // health/ready gate — not just that celld was spawned. The reload above
    // races a cold boot (`started celld` then `reload failed (connection
    // error)` within milliseconds), so confirm the gate before calling the
    // deploy live. This deploy holds the app's claim, so the wait ends the
    // moment the fleet is no longer a live child: a crash fails the deploy at
    // once, and a stop or teardown in the window (nobody wants it serving,
    // and a delete is queued on the claim) completes it as before.
    let fleet_port = match &environment {
        Some(env) => env.listen_port,
        None => app.listen_port,
    };
    let mut fleet_stopped_early = false;
    if let Some(port) = fleet_port {
        let budget = std::time::Duration::from_secs(cfg.wake_timeout_s.max(1));
        tokio::select! {
            healthy = crate::host::sleep::wait_healthy(cfg, port, budget) => {
                if !healthy {
                    anyhow::bail!("fleet not healthy within {}s", cfg.wake_timeout_s);
                }
            }
            fate = supervisor::fleet_gone(procs, &fleet) => match fate {
                supervisor::FleetFate::Removed => {
                    tracing::info!(fleet = %fleet, "fleet stopped before its health gate; deploy recorded");
                    fleet_stopped_early = true;
                }
                supervisor::FleetFate::Exited(why) => {
                    anyhow::bail!("celld exited before answering its health gate: {why}");
                }
            },
        }
    }

    // D1 migrations for Void apps (SPEC, Deploy pipeline): a redeploy
    // already ran them against the staged generation above, so only a
    // first deploy — or a fleet no staged invoke could reach — runs them
    // here, against the adopted fleet, before the deploy is marked
    // success. A stop in the window skips them like it skips the gate
    // (redeploy to run them); anything else failing fails the deploy.
    if void_app && !migrated_staged && !fleet_stopped_early {
        migrate_void_app(MigrateInputs {
            pool,
            cfg,
            app,
            target,
            src_dir: &src_dir,
            deploy_root: &deploy_root,
            commit_sha: &commit_sha,
            progress: &mut *progress,
        })
        .await?;
    } else if void_app && !migrated_staged {
        progress
            .log(
                DeployStatus::Deploying,
                "migrate: skipped (the fleet stopped before its health gate; redeploy to run migrations)\n",
            )
            .await?;
    }

    // Healthy: route it at the edge before the row says so. Every Success
    // write below re-applies the same transition, but a client that waits
    // for the row (the CLI's push note, the UI, the e2e) must not reach the
    // edge before its table carries the new target and get "Starting".
    route_live(pool, cfg, &app.id, target.environment_id(), &commit_sha).await?;

    // Per-deploy source maps for the Errors tab (symbolication at read
    // time): the Worker map `celld deploy --sourcemap` wrote, plus every
    // client map the build emitted. Best-effort — the deploy already
    // succeeded — so a failure is a log line, never a failed deploy.
    match crate::host::sourcemaps::store_deploy_maps(
        pool,
        cfg,
        &crate::host::sourcemaps::StoreMaps {
            app_id: &app.id,
            environment_id: target.environment_id(),
            bucket_uri: &bucket,
            sha: &commit_sha,
            deploy_root: &deploy_root,
        },
        worker_map,
    )
    .await
    {
        Ok(summary) => {
            progress
                .log(DeployStatus::Success, &format!("sourcemaps: {summary}\n"))
                .await?;
        }
        Err(e) => {
            progress
                .log(
                    DeployStatus::Success,
                    &format!("sourcemaps skipped: {e:#}\n"),
                )
                .await?;
        }
    }

    progress
        .log(DeployStatus::Success, "deploy complete\n")
        .await?;
    tracing::info!(fleet = %fleet, sha = %&commit_sha[..12.min(commit_sha.len())], "deploy ok");
    // It is live: status, fleet and reload are all done above, so the
    // worktree wipe runs detached. Nothing that waits on this deploy — the app
    // lock, the next push, a delete — is held open by it.
    tokio::spawn(wipe_worktree(work));
    Ok(())
}

/// Everything the `migrate` step borrows, grouped so each delivery stays a
/// plain function (eight loose parameters would need a lint exception,
/// which the repo does not add).
struct MigrateInputs<'a, 'b, 'c> {
    pool: &'a SqlitePool,
    cfg: &'a Config,
    app: &'a App,
    target: &'a DeployTarget,
    src_dir: &'a Path,
    deploy_root: &'a Path,
    commit_sha: &'a str,
    progress: &'b mut Progress<'c>,
}

/// What both migrate deliveries share: the pushed tree's migration files
/// plus the fleet's proxy token the worker checks.
struct MigrateSetup {
    files: Vec<void_migrate::MigrationFile>,
    proxy_token: String,
}

/// Open the `migrate` step: the step line, the pushed tree's migration
/// files, and the fleet's token. The tree walk is blocking I/O, off the
/// async workers like the other blocking reads in this pipeline; the token
/// comes from the runner-owned merge earlier in this deploy (reused here,
/// never re-minted).
async fn begin_migrate(
    inputs: &mut MigrateInputs<'_, '_, '_>,
    detail: &str,
) -> anyhow::Result<MigrateSetup> {
    inputs
        .progress
        .step("migrate", DeployStatus::Deploying, detail)
        .await?;
    let environment_id = inputs.target.environment().map(|env| env.id.as_str());
    let src_dir = inputs.src_dir.to_path_buf();
    let files = tokio::task::spawn_blocking(move || {
        void_migrate::collect_migrations(&void_migrate::resolve_migrations_dir(&src_dir)?)
    })
    .await
    .map_err(|e| anyhow::anyhow!("migration collection failed: {}", e))??;
    let (proxy_token, _) =
        void_deploy::ensure_proxy_token(inputs.pool, &inputs.app.id, environment_id).await?;
    Ok(MigrateSetup { files, proxy_token })
}

/// Run the migration protocol over one delivery: the capabilities probe
/// (retried twice on transport failure), then v2 against the staged or
/// new worker (negotiated against the pushed tree) or the legacy endpoint
/// for older sqlite runtimes, with the Hyperdrive refusal before the
/// empty-tree return. The attempt/reconcile semantics live in the client;
/// this drives the same sequence for both deliveries.
async fn drive_migration_protocol(
    progress: &mut Progress<'_>,
    fleet: &str,
    files: &[void_migrate::MigrationFile],
    client: &void_migrate::MigrationClient,
    deploy_root: &Path,
    deployment_id: &str,
) -> anyhow::Result<()> {
    // Any answered probe without a v2 shape means no v2 handler (a 404
    // from the inputs.app router, a legacy-only runtime), decided below
    // from the tree; a transport failure retries the probe twice before
    // the deploy fails.
    let mut capabilities = None;
    let mut answered_without_v2 = false;
    let mut unreachable = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        match client.capabilities().await {
            Ok(caps) => {
                capabilities = Some(caps);
                break;
            }
            Err(void_migrate::ProbeError::Transport { message }) => {
                tracing::warn!(
                    fleet = %fleet,
                    attempt,
                    error = %message,
                    "migration capabilities probe failed"
                );
                unreachable = message;
            }
            Err(void_migrate::ProbeError::TooLarge { message }) => {
                anyhow::bail!("migration capabilities response too large: {}", message);
            }
            Err(_) => {
                answered_without_v2 = true;
                break;
            }
        }
    }
    if let Some(caps) = capabilities {
        // Capability negotiation, as the platform's: the worker's dialect,
        // classifier and list hash must match the pushed tree's. Without
        // tree files (a CLI deploy of a prebuilt bundle) there is nothing
        // to check against, so the worker's self-verified bundle runs
        // unchecked — and says so in the log.
        let mut diffs = Vec::new();
        if caps.dialect != "sqlite" {
            diffs.push(format!(
                "dialect worker={} manifest=sqlite",
                void_migrate::one_line(&caps.dialect)
            ));
        }
        if caps.classifier_version != void_migrate::CLASSIFIER_VERSION {
            diffs.push(format!(
                "classifierVersion worker={} manifest={}",
                caps.classifier_version,
                void_migrate::CLASSIFIER_VERSION
            ));
        }
        if !files.is_empty() {
            let bundle =
                void_migrate::build_plan_bundle(files).map_err(|e| anyhow::anyhow!("{}", e))?;
            if caps.migration_list_hash != bundle.migration_list_hash {
                diffs.push(format!(
                    "migrationListHash worker={} manifest={}",
                    void_migrate::one_line(&caps.migration_list_hash),
                    bundle.migration_list_hash
                ));
            }
        }
        if !diffs.is_empty() {
            anyhow::bail!(
                "migration protocol v2 capability negotiation failed: deployed worker build differs from the pushed tree ({})",
                diffs.join("; ")
            );
        }
        if files.is_empty() {
            progress
                .log(
                    DeployStatus::Deploying,
                    "migrate: the pushed tree has no db/migrations; applying the worker's bundled migrations without a list-hash check\n",
                )
                .await?;
        }
        let response = client
            .migrate_app(&void_migrate::mint_attempt_id(), deployment_id)
            .await;
        log_migrate_warnings(progress, &response).await?;
        if !response.ok {
            anyhow::bail!(
                "migration failed: {}",
                void_migrate::format_migration_failure(&response)
            );
        }
        log_migrate_outcome(progress, &response).await?;
        if caps.auth_endpoint.is_some() {
            client
                .migrate_auth()
                .await
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            progress
                .log(
                    DeployStatus::Deploying,
                    "migrate: auth migrations applied\n",
                )
                .await?;
        }
        return Ok(());
    }
    if !answered_without_v2 {
        anyhow::bail!(
            "could not reach the new worker's migration endpoint: {}",
            unreachable
        );
    }
    // No v2 handler: an older sqlite runtime — or a Postgres/MySQL app,
    // whose handlers serve the legacy endpoint only and need Hyperdrive.
    // The refusal runs before the empty-tree early return, so a prebuilt pg
    // tree (no `db/migrations`) can never deploy green with an empty DB.
    let config = effective_config(deploy_root)
        .await
        .and_then(|text| serde_json::from_str(&text).ok())
        .ok_or_else(|| {
            anyhow::anyhow!("cannot run migrations: the deployed config could not be read back")
        })?;
    if void_migrate::config_has_hyperdrive(&config) && !void_migrate::config_has_d1(&config) {
        anyhow::bail!(
            "this Void app's migrations target Postgres/MySQL (the config has a `hyperdrive` binding and no D1), which Noite does not run; refusing to deploy with an empty database (move the app to D1: `database.dialect: \"sqlite\"` in void.json)"
        );
    }
    if files.is_empty() {
        progress
            .log(DeployStatus::Deploying, "migrate: no migrations to run\n")
            .await?;
        return Ok(());
    }
    let response = client
        .migrate_legacy()
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    if !response.ok {
        anyhow::bail!(
            "migration failed: {}",
            void_migrate::format_migration_failure(&response)
        );
    }
    log_migrate_outcome(progress, &response).await?;
    Ok(())
}

/// Run a Void app's D1 migrations through the staged generation's in-worker
/// endpoints, before the activate serves them: the same protocol as
/// [`migrate_void_app`], delivered by `celld invoke` (operator token and
/// fleet HMAC over `CELLD_*`, like `celld d1 execute`) with the cohosted
/// pins plus the app as `--target`. Runs against this target's own fleet,
/// so a preview migrates its own D1 and never production's. A failure
/// fails the deploy with nothing activated, so the old version keeps
/// serving; applied migrations stay applied (forward-only).
async fn migrate_void_app_staged(
    inputs: MigrateInputs<'_, '_, '_>,
    celld: &void_cohost::CelldDeploy<'_>,
    staged: &void_cohost::StagedFleet,
) -> anyhow::Result<()> {
    let mut inputs = inputs;
    let setup = begin_migrate(&mut inputs, "D1 migrations via the staged worker").await?;
    let env: Vec<(String, String)> = celld
        .env
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect();
    let client = void_migrate::MigrationClient::staged(
        void_migrate::StagedTarget {
            celld_bin: celld.celld_bin.to_string(),
            env,
            bucket: celld.bucket.to_string(),
            endpoint: celld.endpoint.to_string(),
            region: celld.region.to_string(),
            pins: staged.generation.clone(),
            target: staged.primary.clone(),
        },
        setup.proxy_token,
    );
    let fleet = fleet_label(inputs.app, inputs.target);
    let deployment_id = inputs
        .progress
        .id
        .clone()
        .unwrap_or_else(|| inputs.commit_sha.to_string());
    drive_migration_protocol(
        inputs.progress,
        &fleet,
        &setup.files,
        &client,
        inputs.deploy_root,
        &deployment_id,
    )
    .await
}

/// Activate the staged generation after a successful staged migrate: the
/// deploy step resumes first, so an activate failure is reported under
/// `deploy` instead of the finished `migrate` step.
async fn activate_after_staged_migrate(
    pool: &SqlitePool,
    app: &App,
    target: &DeployTarget,
    celld: &void_cohost::CelldDeploy<'_>,
    staged: void_cohost::StagedFleet,
    progress: &mut Progress<'_>,
) -> anyhow::Result<void_cohost::FleetDeployStats> {
    progress
        .step("deploy", DeployStatus::Deploying, "celld activate")
        .await?;
    void_cohost::activate_staged(pool, &app.id, target.environment_id(), celld, staged).await
}

/// Run a Void app's D1 migrations through the new generation's in-worker
/// endpoints (`host/void_migrate.rs`): protocol v2 where the worker
/// advertises it (negotiated against the pushed tree's `db/migrations`), the
/// legacy endpoint for older sqlite runtimes, and a loud refusal for
/// Postgres/MySQL (Hyperdrive, which Noite does not run). Runs against this
/// target's own fleet, so a preview migrates its own D1 and never
/// production's. Every failure fails the deploy; applied migrations stay
/// applied (forward-only). This is the post-activation delivery — a first
/// deploy, or a redeploy no staged invoke could reach; redeploys run the
/// same protocol staged, through [`migrate_void_app_staged`].
async fn migrate_void_app(inputs: MigrateInputs<'_, '_, '_>) -> anyhow::Result<()> {
    let mut inputs = inputs;
    // The health gate above was the readiness probe, so a fleet that answers
    // it answers this too.
    let setup = begin_migrate(&mut inputs, "D1 migrations via the new worker").await?;
    let fleet_port = match inputs.target.environment() {
        Some(env) => env.listen_port,
        None => inputs.app.listen_port,
    };
    let Some(port) = fleet_port else {
        if setup.files.is_empty() {
            inputs
                .progress
                .log(DeployStatus::Deploying, "migrate: no migrations to run\n")
                .await?;
            return Ok(());
        }
        anyhow::bail!(
            "cannot run {} migration(s): the fleet has no listen port to reach the worker on",
            setup.files.len()
        );
    };
    let client = void_migrate::MigrationClient::new(
        void_migrate::migration_http_client(),
        format!("http://{}:{}", inputs.cfg.caddy_upstream_host, port),
        setup.proxy_token,
    );
    let fleet = fleet_label(inputs.app, inputs.target);
    let deployment_id = inputs
        .progress
        .id
        .clone()
        .unwrap_or_else(|| inputs.commit_sha.to_string());
    drive_migration_protocol(
        inputs.progress,
        &fleet,
        &setup.files,
        &client,
        inputs.deploy_root,
        &deployment_id,
    )
    .await
}

/// The fleet the staged migrations need: the previous generation must be
/// serving (or bootable) for a staged invoke to have a node to run on.
/// Spawning here is the same call the start step makes below — just earlier
/// — so a stopped or asleep fleet wakes for the migrate and the activate
/// below adopts the new generation into it. A fleet that cannot boot serves
/// nothing, so the caller falls back to migrating after activation.
async fn ensure_prior_fleet_healthy(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
    environment: Option<&Environment>,
) -> anyhow::Result<()> {
    match environment {
        Some(env) => {
            supervisor::ensure_environment_fleet(pool, cfg, procs, logs, env).await?;
        }
        None => {
            supervisor::ensure_fleet(pool, cfg, procs, logs, app).await?;
        }
    }
    let port = match environment {
        Some(env) => env.listen_port,
        None => app.listen_port,
    };
    let Some(port) = port else {
        anyhow::bail!("the prior fleet has no listen port for the staged migration");
    };
    let budget = std::time::Duration::from_secs(cfg.wake_timeout_s.max(1));
    if !crate::host::sleep::wait_healthy(cfg, port, budget).await {
        anyhow::bail!("prior fleet not healthy within {}s", cfg.wake_timeout_s);
    }
    Ok(())
}

/// The worker's warnings in one log write: the first 20 plus a count. One
/// write, not one per warning — warnings are tenant-controlled, and every
/// write is ~3 sqlite queries on the writer every app's deploys share.
async fn log_migrate_warnings(
    progress: &mut Progress<'_>,
    response: &void_migrate::MigrateResponse,
) -> sqlx::Result<()> {
    if response.warnings.is_empty() && response.warnings_dropped == 0 {
        return Ok(());
    }
    let mut text = String::new();
    for warning in response
        .warnings
        .iter()
        .take(void_migrate::MAX_LOGGED_WARNINGS)
    {
        text.push_str(&format!(
            "migrate: warning: {}\n",
            void_migrate::one_line(warning)
        ));
    }
    let rest = response
        .warnings
        .len()
        .saturating_sub(void_migrate::MAX_LOGGED_WARNINGS)
        + response.warnings_dropped;
    if rest > 0 {
        let noun = if rest == 1 { "warning" } else { "warnings" };
        text.push_str(&format!("migrate: ...and {} more {}\n", rest, noun));
    }
    progress.log(DeployStatus::Deploying, &text).await
}

/// The step's outcome line: applied and skipped counts with the quoted file
/// names (tenant-controlled, so Debug-quoted, never raw).
async fn log_migrate_outcome(
    progress: &mut Progress<'_>,
    response: &void_migrate::MigrateResponse,
) -> sqlx::Result<()> {
    let applied: Vec<&str> = response
        .migrations
        .iter()
        .filter(|migration| migration.is_applied())
        .map(|migration| migration.name.as_str())
        .collect();
    // v2 marks untouched migrations `skipped`; legacy entries carry no
    // status, so an un-applied one without an error counts as skipped
    // there. A failed entry never counts here — but failures never reach
    // this line.
    let skipped: Vec<&str> = response
        .migrations
        .iter()
        .filter(|migration| {
            migration.is_skipped()
                || (!migration.is_applied()
                    && migration.error.is_none()
                    && migration.status.is_none())
        })
        .map(|migration| migration.name.as_str())
        .collect();
    let mut line = format!(
        "migrate: applied {}, skipped {}",
        applied.len(),
        skipped.len()
    );
    let mut lists = Vec::new();
    if !applied.is_empty() {
        lists.push(format!("applied: {}", quoted(&applied)));
    }
    if !skipped.is_empty() {
        lists.push(format!("skipped: {}", quoted(&skipped)));
    }
    if response.migrations_dropped > 0 {
        lists.push(format!(
            "{} response entries past the cap are not listed",
            response.migrations_dropped
        ));
    }
    if !lists.is_empty() {
        line.push_str(&format!(" ({})", lists.join("; ")));
    }
    line.push('\n');
    progress.log(DeployStatus::Deploying, &line).await
}

/// Debug-quote each name (as required-secret names are quoted): no raw
/// tenant text into the log. Lists the first 20 with a count, and flattens
/// after quoting (Debug leaves U+2028/U+2029 raw, which would forge lines in
/// UIs that honor them).
fn quoted(names: &[&str]) -> String {
    let shown = names.len().min(void_migrate::MAX_LOGGED_MIGRATION_NAMES);
    let mut out = names[..shown]
        .iter()
        .map(|name| format!("{:?}", name))
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > shown {
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(&format!("...and {} more", names.len() - shown));
    }
    void_migrate::one_line(&out)
}

/// Make a healthy deploy's target routable (its sha and `running`, the state
/// `edge_table::serves` / `edge::env_live` read) and push the edge table, so
/// the route exists before the deploy row first reads `success`. A deploy
/// that cannot get its route onto the edge does not report success:
/// - a DB error, or a table that could not be built or written, fails it;
/// - an edge that answers and refuses the table fails it (the running edge
///   keeps serving the previous table, without this target);
/// - an unreachable admin API does not: Caddy is booting or restarting, and
///   it loads the table file written above, which already routes the target.
async fn route_live(
    pool: &SqlitePool,
    cfg: &Config,
    app_id: &str,
    environment_id: Option<&str>,
    sha: &str,
) -> anyhow::Result<()> {
    use crate::host::edge_table::{push_routes, Pushed};
    db::mark_deploy_live(pool, app_id, environment_id, sha).await?;
    match push_routes(pool, cfg).await? {
        Pushed::Rejected(detail) => anyhow::bail!("the edge refused the route table: {detail}"),
        Pushed::Accepted | Pushed::Unreachable => Ok(()),
    }
}

/// Drop the build worktree after a successful deploy. Best-effort by contract:
/// a failure only leaks the tree until the next deploy replaces it.
async fn wipe_worktree(work: PathBuf) {
    let _ = tokio::fs::remove_dir_all(&work).await;
}

/// Fetch one bundle's sha into the app's bare mirror at `git_ref` and check
/// that ref out into the worktree. Production checks out `refs/heads/main`;
/// an environment checks out its own branch or hidden preview ref, so two
/// targets of one app share the mirror (and the serialized build) without
/// checking out each other's tree.
async fn materialize_bundle(
    cfg: &Config,
    app: &App,
    work: &Path,
    bundle_path: &Path,
    sha: &str,
    git_ref: &str,
) -> anyhow::Result<PathBuf> {
    let bare = exec::work_root(cfg)
        .join("repos")
        .join(format!("{}.git", app.slug));
    let src_dir = work.join("src");
    tokio::fs::create_dir_all(&bare).await?;
    tokio::fs::create_dir_all(&src_dir).await?;
    if !tokio::fs::try_exists(bare.join("HEAD")).await? {
        let Some(bare_arg) = bare.to_str() else {
            anyhow::bail!("bare mirror path is not valid UTF-8: {}", bare.display());
        };
        exec::run_cmd(
            "git",
            &["init", "--bare", bare_arg],
            Some(work),
            &[],
            Duration::from_secs(30),
        )
        .await?;
    }
    let refspec = format!("+{sha}:{git_ref}");
    let Some(bundle_arg) = bundle_path.to_str() else {
        anyhow::bail!("bundle path is not valid UTF-8: {}", bundle_path.display());
    };
    exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            bundle_arg,
            &refspec,
        ],
        Some(work),
        &[],
        Duration::from_secs(60),
    )
    .await?;
    let _ = tokio::fs::remove_dir_all(&src_dir).await;
    tokio::fs::create_dir_all(&src_dir).await?;
    exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            &format!("--work-tree={}", src_dir.display()),
            "checkout",
            "-f",
            git_ref,
        ],
        Some(work),
        &[],
        Duration::from_secs(30),
    )
    .await?;
    Ok(src_dir)
}

/// One-shot release command from the tenant's wrangler config
/// (`"release": "bun run db:migrate"`), capped at 500 chars.
async fn release_cmd(src_dir: &Path) -> Option<String> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let Ok(text) = tokio::fs::read_to_string(src_dir.join(name)).await else {
            continue;
        };
        let Ok(v) = crate::host::storage::parse_wrangler(&text) else {
            continue;
        };
        if let Some(r) = v.get("release").and_then(|r| r.as_str()).map(str::trim) {
            if !r.is_empty() {
                return Some(r.chars().take(500).collect());
            }
        }
    }
    None
}

/// `root` resolved, proven to lie inside `src` (canonical), with no Wrangler
/// config in it that is a symlink.
fn contained_deploy_root(src: &Path, root: &Path) -> anyhow::Result<PathBuf> {
    let resolved = root.canonicalize()?;
    if !resolved.starts_with(src) {
        anyhow::bail!(
            "deploy root {} resolves outside the worktree",
            root.display()
        );
    }
    for name in ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] {
        let is_link = std::fs::symlink_metadata(resolved.join(name))
            .is_ok_and(|m| m.file_type().is_symlink());
        if is_link {
            anyhow::bail!("{name} in the deploy root is a symlink; refusing to deploy it");
        }
    }
    Ok(resolved)
}

/// Wrangler's custom build (`"build": { "command": "…", "cwd": "…" }`).
#[derive(Debug, PartialEq)]
struct WranglerBuild {
    command: String,
    /// Relative to the project root; empty for the root itself.
    cwd: PathBuf,
}

/// `build.command` from the tenant's wrangler.json(c), capped at 500 chars.
/// A `cwd` must stay inside the project.
async fn wrangler_build(src_dir: &Path) -> anyhow::Result<Option<WranglerBuild>> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let Ok(text) = tokio::fs::read_to_string(src_dir.join(name)).await else {
            continue;
        };
        let Ok(v) = crate::host::storage::parse_wrangler(&text) else {
            continue;
        };
        return parse_wrangler_build(&v).map_err(|e| anyhow::anyhow!("{name}: {e}"));
    }
    Ok(None)
}

fn parse_wrangler_build(config: &serde_json::Value) -> anyhow::Result<Option<WranglerBuild>> {
    let Some(build) = config.get("build") else {
        return Ok(None);
    };
    let Some(command) = build.get("command").and_then(|c| c.as_str()).map(str::trim) else {
        return Ok(None);
    };
    if command.is_empty() {
        return Ok(None);
    }
    let cwd = PathBuf::from(build.get("cwd").and_then(|c| c.as_str()).unwrap_or(""));
    if !cwd.components().all(|c| {
        matches!(
            c,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        anyhow::bail!("build.cwd must be a path inside the project");
    }
    Ok(Some(WranglerBuild {
        command: command.chars().take(500).collect(),
        cwd,
    }))
}

async fn read_package_json(src_dir: &Path) -> anyhow::Result<Option<serde_json::Value>> {
    let Ok(text) = tokio::fs::read_to_string(src_dir.join("package.json")).await else {
        return Ok(None);
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("package.json: {e}"))
}

/// A non-empty `scripts.build`.
fn has_build_script(package: &serde_json::Value) -> bool {
    package
        .get("scripts")
        .and_then(|s| s.get("build"))
        .and_then(|b| b.as_str())
        .is_some_and(|b| !b.trim().is_empty())
}

/// Config keys the runner consumes from the tenant's Wrangler file that
/// celld does not accept: Noite's `release` and Wrangler's `build`.
const RUNNER_WRANGLER_KEYS: &[&str] = &["release", "build"];

/// Remove runner-consumed keys from `dir`'s wrangler.json(c) before `celld
/// deploy`. A file is rewritten only when it carried one; comments in a
/// .jsonc are dropped then, which only affects this build's copy.
async fn strip_runner_keys(dir: &Path) -> anyhow::Result<()> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let path = dir.join(name);
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Some(stripped) = without_runner_keys(&text)? else {
            continue;
        };
        tokio::fs::write(&path, stripped).await?;
    }
    Ok(())
}

/// The runner's arch as a container platform suffix for
/// `CELLD_CONTAINER_PLATFORM`. Unknown arches pass through (Go names most
/// like Rust does).
fn go_arch(arch: &str) -> &str {
    match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// The config without runner-consumed keys, or `None` when it has none.
fn without_runner_keys(text: &str) -> anyhow::Result<Option<String>> {
    let mut value = crate::host::storage::parse_wrangler(text)?;
    let Some(obj) = value.as_object_mut() else {
        return Ok(None);
    };
    let before = obj.len();
    for key in RUNNER_WRANGLER_KEYS {
        obj.remove(*key);
    }
    if obj.len() == before {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&value)?))
}

/// The `cf` CLI config (https://github.com/cloudflare/cf).
const CF_CONFIG: &str = "cloudflare.config.ts";
const CF_CONFIG_CONVERTER: &str = include_str!("cf-config.mjs");

/// A Wrangler config at the root of `dir` or in its build output.
async fn has_wrangler_config(dir: &Path) -> anyhow::Result<bool> {
    for name in [
        "wrangler.jsonc",
        "wrangler.json",
        "wrangler.toml",
        "dist/wrangler.json",
        build_output::DEPLOY_REDIRECT,
    ] {
        if tokio::fs::try_exists(dir.join(name)).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The config `celld deploy` uploads, as JSON, for the storage views: a
/// generated or built config is not in the pushed source they otherwise read.
async fn effective_config(deploy_root: &Path) -> Option<String> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let Ok(text) = tokio::fs::read_to_string(deploy_root.join(name)).await else {
            continue;
        };
        let value = crate::host::storage::parse_wrangler(&text).ok()?;
        return serde_json::to_string(&value).ok();
    }
    None
}

async fn find_deploy_root(dir: &PathBuf) -> anyhow::Result<Option<PathBuf>> {
    for name in ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] {
        if tokio::fs::try_exists(dir.join(name)).await? {
            return Ok(Some(dir.clone()));
        }
    }
    if tokio::fs::try_exists(dir.join("dist/wrangler.json")).await? {
        return Ok(Some(dir.join("dist")));
    }
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(ent) = rd.next_entry().await? {
        if !ent.file_type().await?.is_dir() {
            continue;
        }
        let name = ent.file_name();
        let name = name.to_string_lossy();
        // A dependency's own Wrangler file is never the app's.
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if let Some(found) = Box::pin(find_deploy_root(&ent.path())).await? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

#[allow(clippy::too_many_arguments)] // deploy_app's deps; same rationale
pub async fn deploy_tip(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    target: DeployTarget,
    tip: TipBundle,
) {
    if target
        .last_deploy_sha(&app)
        .as_deref()
        .is_some_and(|s| sha_same(s, &tip.sha))
    {
        return;
    }
    deploy_app(
        pool,
        cfg,
        procs,
        logs,
        deploying,
        app,
        target,
        &tip.key,
        Some(&tip.sha),
        DeployTrigger::Tip,
        None,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::{
        activate_after_staged_migrate, contained_deploy_root, failure_summary, go_arch,
        has_build_script, log_migrate_warnings, migrate_void_app, migrate_void_app_staged,
        parse_wrangler_build, quoted, route_live, wipe_worktree, without_runner_keys, DeployTarget,
        MigrateInputs, Progress,
    };
    use serde_json::json;

    /// A client that waits for the deploy row (the CLI, the UI, the e2e)
    /// sends its first request the moment the row reads `success`. The edge
    /// table must already route a first deploy by then, or that request gets
    /// the "Starting" fallback (503). Before this, the target only became
    /// routable through the success write itself, and the table was pushed
    /// after it.
    #[tokio::test]
    async fn a_first_deploy_is_routed_before_its_row_reads_success() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let dir =
            std::env::temp_dir().join(format!("noite-route-live-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.routes_path = dir.join("routes.json").to_string_lossy().into_owned();
        // Nothing listens here: the live push fails fast; the file is the table.
        cfg.caddy_admin_url = "http://127.0.0.1:9".into();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "blog",
                slug: "blog",
                user_id: "local",
                subdomain: "blog.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");
        let deploy_id =
            crate::db::upsert_deploy(&pool, None, &app.id, None, "deploying", Some("abc123"), "")
                .await
                .expect("deploy row");

        route_live(&pool, &cfg, &app.id, None, "abc123")
            .await
            .expect("route live");

        let raw = std::fs::read_to_string(&cfg.routes_path).expect("route table written");
        let table: crate::host::edge_table::EdgeTable =
            serde_json::from_str(&raw).expect("route table");
        let host = format!("blog.{}", cfg.tenant_bases()[0]).to_lowercase();
        assert!(
            table.exact.contains_key(&host),
            "{host} not routed: {:?}",
            table.exact.keys().collect::<Vec<_>>()
        );
        let status: String = sqlx::query_scalar("SELECT status FROM deploy WHERE id = ?")
            .bind(&deploy_id)
            .fetch_one(&pool)
            .await
            .expect("deploy status");
        assert_eq!(status, "deploying", "routing must not announce the deploy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// One-shot Caddy admin stand-in: reads one full request, answers with
    /// `status` and `body`, and closes.
    async fn admin_stub(status: &'static str, body: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub");
        let addr = listener.local_addr().expect("stub addr");
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Headers, then exactly Content-Length body bytes: answering
            // early would reset the connection and read as "unreachable".
            loop {
                let n = sock.read(&mut chunk).await.expect("read");
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(reply.as_bytes()).await.expect("reply");
        });
        format!("http://{addr}")
    }

    /// A deploy whose route the edge refuses must not go on to report
    /// success: the running edge keeps its previous table, without the
    /// target, so a client that trusted the row would get "Starting". An
    /// edge that accepts the table lets it through.
    #[tokio::test]
    async fn a_deploy_the_edge_refuses_to_route_fails() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        let dir =
            std::env::temp_dir().join(format!("noite-route-refused-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.routes_path = dir.join("routes.json").to_string_lossy().into_owned();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "blog",
                slug: "blog",
                user_id: "local",
                subdomain: "blog.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("seed app");

        cfg.caddy_admin_url = admin_stub("409 Conflict", "stale generation").await;
        let refused = route_live(&pool, &cfg, &app.id, None, "abc123")
            .await
            .expect_err("a refused table must fail the deploy");
        assert!(
            format!("{refused:#}").contains("stale generation"),
            "{refused:#}"
        );

        cfg.caddy_admin_url = admin_stub("200 OK", "{}").await;
        route_live(&pool, &cfg, &app.id, None, "abc123")
            .await
            .expect("an accepted table lets the deploy through");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn deploy_root_must_stay_in_the_worktree() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("noite-deploy-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (src, outside) = (base.join("src"), base.join("outside"));
        std::fs::create_dir_all(src.join("dist")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("wrangler.json"), "{}").unwrap();
        let src = src.canonicalize().unwrap();

        assert_eq!(
            contained_deploy_root(&src, &src.join("dist")).unwrap(),
            src.join("dist")
        );
        symlink(&outside, src.join("evil")).unwrap();
        assert!(contained_deploy_root(&src, &src.join("evil")).is_err());
        symlink(
            outside.join("wrangler.json"),
            src.join("dist/wrangler.json"),
        )
        .unwrap();
        assert!(contained_deploy_root(&src, &src.join("dist")).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn runner_keys_are_stripped_and_other_keys_survive() {
        let jsonc = "{\n  // tenant comment\n  \"name\": \"a\",\n  \"release\": \"bun run migrate\",\n  \"build\": { \"command\": \"make\" },\n  \"main\": \"index.js\"\n}";
        let out = without_runner_keys(jsonc).unwrap().expect("rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("release").is_none());
        assert!(v.get("build").is_none());
        assert_eq!(v["name"], "a");
        assert_eq!(v["main"], "index.js");
        // Nothing to strip: the file is left alone.
        assert!(without_runner_keys("{\"name\": \"a\"}").unwrap().is_none());
    }

    #[test]
    fn build_script_is_read_from_scripts_only() {
        assert!(has_build_script(
            &json!({ "scripts": { "build": "vite build" } })
        ));
        assert!(!has_build_script(&json!({ "scripts": { "build": " " } })));
        // A dependency named "build" used to count as a build script.
        assert!(!has_build_script(
            &json!({ "dependencies": { "build": "1.0.0" } })
        ));
        assert!(!has_build_script(&json!({ "name": "x" })));
    }

    #[test]
    fn wrangler_build_command_and_cwd() {
        let b = parse_wrangler_build(
            &json!({ "build": { "command": " npm run build ", "cwd": "web" } }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(b.command, "npm run build");
        assert_eq!(b.cwd, std::path::PathBuf::from("web"));
        assert!(parse_wrangler_build(&json!({ "build": { "command": "" } }))
            .unwrap()
            .is_none());
        assert!(parse_wrangler_build(&json!({ "name": "x" }))
            .unwrap()
            .is_none());
        assert!(
            parse_wrangler_build(&json!({ "build": { "command": "x", "cwd": "../up" } })).is_err()
        );
        assert!(
            parse_wrangler_build(&json!({ "build": { "command": "x", "cwd": "/etc" } })).is_err()
        );
    }

    #[test]
    fn failure_summary_finds_the_error_line() {
        // Vite: a heading, then the message on the next line.
        let vite = "bun [\"run\", \"build\"] exit Some(1)\nvite v7.3.6 building...\nerror during build:\n[vite]: Rollup failed to resolve import \"x\" from \"src/index.ts\".\nerror: script \"build\" exited with code 1";
        assert_eq!(
            failure_summary("build", vite),
            "build failed: [vite]: Rollup failed to resolve import \"x\" from \"src/index.ts\"."
        );
        // No error line: the error's own first line.
        assert_eq!(
            failure_summary("deploy", "celld deploy timed out\nsomething"),
            "deploy failed: celld deploy timed out"
        );
    }

    #[test]
    fn container_platform_follows_the_nodes_arch() {
        assert_eq!(go_arch("x86_64"), "amd64");
        assert_eq!(go_arch("aarch64"), "arm64");
        assert_eq!(go_arch("riscv64"), "riscv64");
    }

    /// The detached end-of-deploy step: the build worktree is gone afterwards.
    #[tokio::test]
    async fn wipe_worktree_drops_the_build_worktree() {
        let base =
            std::env::temp_dir().join(format!("noite-wipe-worktree-{}", crate::models::new_id()));
        let work = base.join("build");
        std::fs::create_dir_all(work.join("src/node_modules/dep")).unwrap();
        std::fs::write(work.join("src/node_modules/dep/index.d.ts"), "export {};\n").unwrap();

        wipe_worktree(work.clone()).await;

        assert!(!work.exists(), "the worktree is wiped");
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- migrate step -------------------------------------------------------

    /// One `migrate` step against a fake worker with no v2 handler (every
    /// probe 404s, so the step takes the legacy path) and an empty pushed
    /// tree: returns the step's outcome and the deploy log.
    async fn run_migrate_once(tag: &str, wrangler_json: &str) -> (Result<(), String>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            axum::serve(listener, axum::Router::new()).await.unwrap();
        });
        let pool = crate::db::connect("sqlite::memory:").await.unwrap();
        let cfg = crate::config::config_for_tests();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "migtest",
                slug: "migtest",
                user_id: "local",
                subdomain: "migtest.localhost",
                listen: i64::from(port),
                internal: 30101,
            },
        )
        .await
        .unwrap();
        let base =
            std::env::temp_dir().join(format!("noite-migrate-{}-{}", tag, crate::models::new_id()));
        let src = base.join("src");
        let root = base.join("root");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("wrangler.json"), wrangler_json).unwrap();
        let target = DeployTarget::Production;
        let mut progress = Progress {
            pool: &pool,
            app_id: &app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "migrate",
        };
        let outcome = migrate_void_app(MigrateInputs {
            pool: &pool,
            cfg: &cfg,
            app: &app,
            target: &target,
            src_dir: &src,
            deploy_root: &root,
            commit_sha: "abc123",
            progress: &mut progress,
        })
        .await
        .map_err(|e| e.to_string());
        let log: String = sqlx::query_scalar("SELECT log FROM deploy WHERE id = ?")
            .bind(progress.id.clone().unwrap_or_default())
            .fetch_one(&pool)
            .await
            .unwrap_or_default();
        handle.abort();
        let _ = std::fs::remove_dir_all(&base);
        (outcome, log)
    }

    /// A prebuilt pg tree (no `db/migrations`, older runtime with no v2
    /// handler) is refused loudly: the hyperdrive check runs before the
    /// empty-tree early return, so the deploy can never go green with an
    /// empty database.
    #[tokio::test]
    async fn legacy_pg_app_with_no_tree_files_is_still_refused() {
        let (outcome, _) =
            run_migrate_once("pg", r#"{"hyperdrive": [{"binding": "HYPERDRIVE"}]}"#).await;
        let err = outcome.unwrap_err();
        assert!(
            err.contains("refusing to deploy with an empty database"),
            "{}",
            err
        );
    }

    /// The same empty tree without hyperdrive still skips quietly: the
    /// refusal moved, the skip did not go away.
    #[tokio::test]
    async fn legacy_empty_sqlite_tree_skips_migrations() {
        let (outcome, log) =
            run_migrate_once("sqlite", r#"{"d1_databases": [{"binding": "DB"}]}"#).await;
        outcome.expect("an empty sqlite tree skips the step");
        assert!(log.contains("migrate: no migrations to run"), "{}", log);
    }

    // --- staged migrate sequencing ------------------------------------------

    /// One cohosted script render for the staged-migrate seam: the proxy
    /// stages beside the app, so the invoke pins prove the cohosted
    /// scripts ride staged together with the app as `--target`.
    static STAGED_PROXY: crate::host::void_cohost::CohostedScript =
        crate::host::void_cohost::CohostedScript {
            name: "test-proxy",
            main: "worker.js",
            sources: &[],
            order: 0,
        };

    fn staged_proxy() -> crate::host::void_cohost::RenderedCohost {
        crate::host::void_cohost::RenderedCohost {
            script: &STAGED_PROXY,
            secret_vars: &[],
            config: json!({
                "name": "test-proxy",
                "main": "worker.js",
                "compatibility_date": "2026-09-01",
            }),
            extra_sources: Vec::new(),
            extra_hash_input: Vec::new(),
            declares_containers: false,
            read_root: None,
        }
    }

    /// The staged-migrate seam: a memory pool, a test app, a pushed tree
    /// with one migration, a deploy root, and the fake celld answering
    /// `deploy` plus fixture-driven `invoke`. Every guard cleans up on
    /// drop, including on a failing assert.
    struct StagedSeam {
        pool: sqlx::SqlitePool,
        cfg: crate::config::Config,
        app: crate::models::App,
        dir: crate::testutil::TempDir,
        src: crate::testutil::TempDir,
        root: crate::testutil::TempDir,
        bin: String,
        list_hash: String,
    }

    impl StagedSeam {
        async fn spawn(tag: &str) -> Self {
            let pool = crate::db::connect("sqlite::memory:").await.unwrap();
            let dir = crate::testutil::TempDir::new(&format!("noite-staged-{tag}"));
            // A symlink to the committed script, never a fresh file: the
            // cohost seam's rule (ETXTBSY under parallel load).
            let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/fake-celld-cohost.sh");
            std::os::unix::fs::symlink(&fixture, dir.path().join("celld")).unwrap();
            let mut cfg = crate::config::config_for_tests();
            let bin = dir.path().join("celld").to_string_lossy().into_owned();
            cfg.celld_bin = bin.clone();
            let app = crate::db::create_app(
                &pool,
                &cfg,
                crate::db::NewApp {
                    name: "staged-mig",
                    slug: "staged-mig",
                    user_id: "local",
                    subdomain: "staged-mig.localhost",
                    listen: 30200,
                    internal: 30201,
                },
            )
            .await
            .unwrap();
            let src = crate::testutil::TempDir::new(&format!("noite-staged-src-{tag}"));
            std::fs::create_dir_all(src.path().join("db/migrations")).unwrap();
            std::fs::write(
                src.path().join("db/migrations/0001.sql"),
                "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL\n);\n",
            )
            .unwrap();
            let root = crate::testutil::TempDir::new(&format!("noite-staged-root-{tag}"));
            std::fs::write(
                root.path().join("wrangler.json"),
                r#"{"name": "test-app", "main": "worker.js"}"#,
            )
            .unwrap();
            let files = crate::host::void_migrate::collect_migrations(
                &crate::host::void_migrate::resolve_migrations_dir(src.path()).unwrap(),
            )
            .unwrap();
            let bundle = crate::host::void_migrate::build_plan_bundle(&files).unwrap();
            Self {
                pool,
                cfg,
                app,
                dir,
                src,
                root,
                bin,
                list_hash: bundle.migration_list_hash,
            }
        }

        /// The `celld` invocation shape the stage and the staged migrate
        /// share: the fake's log and dir ride the env, like the operator
        /// token and bucket credentials ride `CELLD_*` in production.
        fn celld<'x>(
            &'x self,
            env: &'x [(&'x str, &'x str)],
        ) -> crate::host::void_cohost::CelldDeploy<'x> {
            crate::host::void_cohost::CelldDeploy {
                celld_bin: &self.bin,
                env,
                bucket: "s3://noite/fleets/staged-mig",
                endpoint: "http://rustfs:9000",
                region: "us-east-1",
                timeout: std::time::Duration::from_secs(30),
                sourcemap: None,
            }
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

        fn write_capabilities(&self) {
            let body = serde_json::json!({
                "protocolVersion": 2,
                "dialect": "sqlite",
                "classifierVersion": crate::host::void_migrate::CLASSIFIER_VERSION,
                "migrationListHash": self.list_hash,
                "destructiveValidation": "passed",
                "endpoints": {"auth": "/auth"},
            });
            self.write_invoke("invoke-capabilities", 200, &body.to_string());
        }

        fn invocations(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("invocations.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    /// The `activate` invocations among the fake's log lines.
    fn staged_activates(calls: &[String]) -> Vec<&String> {
        calls
            .iter()
            .filter(|call| call.starts_with("activate "))
            .collect()
    }

    /// The staged-migrate sequencing: a failing migrate runs no activate,
    /// so the old version keeps serving. The fake stages proxy + app, the
    /// capabilities probe negotiates v2, the app endpoint answers `ok:
    /// false` — definitive — and the activate never runs.
    #[tokio::test]
    async fn staged_migrate_failure_runs_no_activate() {
        let seam = StagedSeam::spawn("fail").await;
        seam.write_capabilities();
        seam.write_invoke(
            "invoke-app",
            200,
            r#"{"ok":false,"migrations":[],"error":"boom"}"#,
        );
        let log = seam
            .dir
            .path()
            .join("invocations.log")
            .to_string_lossy()
            .into_owned();
        let dir = seam.dir.path().to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let celld = seam.celld(&env);
        let target = DeployTarget::Production;
        let app_side = crate::host::void_cohost::FleetApp {
            dir: seam.root.path(),
            cwd: None,
            timeout: std::time::Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };
        let staged = crate::host::void_cohost::stage_fleet_in_order(
            &seam.pool,
            &seam.app.id,
            None,
            &celld,
            &[staged_proxy()],
            &app_side,
        )
        .await
        .expect("stage");
        assert_eq!(
            staged.generation,
            vec![
                ("test-proxy".to_string(), "0000000000000001".to_string()),
                ("test-app".to_string(), "0000000000000002".to_string()),
            ]
        );
        let mut progress = Progress {
            pool: &seam.pool,
            app_id: &seam.app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "migrate",
        };
        let err = migrate_void_app_staged(
            MigrateInputs {
                pool: &seam.pool,
                cfg: &seam.cfg,
                app: &seam.app,
                target: &target,
                src_dir: seam.src.path(),
                deploy_root: seam.root.path(),
                commit_sha: "abc123",
                progress: &mut progress,
            },
            &celld,
            &staged,
        )
        .await
        .expect_err("a failed migrate fails the deploy");
        assert!(
            format!("{err:#}").contains("migration failed: boom"),
            "{err:#}"
        );
        let calls = seam.invocations();
        let app_invoke = calls
            .iter()
            .find(|call| call.contains("--path /__void/migrate/app "))
            .expect("the app endpoint runs through invoke");
        // The invoke pinned the staged generation together, app as target.
        for pinned in [
            "test-proxy=0000000000000001",
            "test-app=0000000000000002",
            "--target test-app",
            "--header-env x-void-internal=NOITE_VOID_PROXY_TOKEN",
            "--json",
            "--bucket s3://noite/fleets/staged-mig",
        ] {
            assert!(app_invoke.contains(pinned), "{app_invoke}");
        }
        assert!(
            staged_activates(&calls).is_empty(),
            "no activate after a failed migrate: {calls:?}"
        );
        // Nothing committed: no cohost hash names staged content.
        let stored = crate::db::get_cohost_hash(&seam.pool, &seam.app.id, None, "test-proxy")
            .await
            .unwrap();
        assert_eq!(stored, None);
    }

    /// A successful staged migrate activates the staged generation: the
    /// same pins the invoke saw, with the app as primary — and the auth
    /// migrations run before activation too.
    #[tokio::test]
    async fn staged_migrate_success_activates_the_staged_generation() {
        let seam = StagedSeam::spawn("ok").await;
        seam.write_capabilities();
        seam.write_invoke(
            "invoke-app",
            200,
            r#"{"ok":true,"migrations":[{"name":"0001.sql","applied":true}]}"#,
        );
        seam.write_invoke("invoke-auth", 200, r#"{"ok":true}"#);
        let log = seam
            .dir
            .path()
            .join("invocations.log")
            .to_string_lossy()
            .into_owned();
        let dir = seam.dir.path().to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let celld = seam.celld(&env);
        let target = DeployTarget::Production;
        let app_side = crate::host::void_cohost::FleetApp {
            dir: seam.root.path(),
            cwd: None,
            timeout: std::time::Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };
        let staged = crate::host::void_cohost::stage_fleet_in_order(
            &seam.pool,
            &seam.app.id,
            None,
            &celld,
            &[staged_proxy()],
            &app_side,
        )
        .await
        .expect("stage");
        let mut progress = Progress {
            pool: &seam.pool,
            app_id: &seam.app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "migrate",
        };
        migrate_void_app_staged(
            MigrateInputs {
                pool: &seam.pool,
                cfg: &seam.cfg,
                app: &seam.app,
                target: &target,
                src_dir: seam.src.path(),
                deploy_root: seam.root.path(),
                commit_sha: "abc123",
                progress: &mut progress,
            },
            &celld,
            &staged,
        )
        .await
        .expect("staged migrate");
        let log: String = sqlx::query_scalar("SELECT log FROM deploy WHERE id = ?")
            .bind(progress.id.clone().unwrap_or_default())
            .fetch_one(&seam.pool)
            .await
            .unwrap();
        assert!(log.contains("migrate: applied 1"), "{log}");
        assert!(log.contains("migrate: auth migrations applied"), "{log}");
        let stats = crate::host::void_cohost::activate_staged(
            &seam.pool,
            &seam.app.id,
            None,
            &celld,
            staged,
        )
        .await
        .expect("activate");
        assert_eq!(stats.activate_attempts, 1);
        let calls = seam.invocations();
        let activates = staged_activates(&calls);
        assert_eq!(activates.len(), 1, "{calls:?}");
        for pinned in [
            "test-proxy=0000000000000001",
            "test-app=0000000000000002",
            "--primary test-app",
        ] {
            assert!(activates[0].contains(pinned), "{}", activates[0]);
        }
        let stored = crate::db::get_cohost_hash(&seam.pool, &seam.app.id, None, "test-proxy")
            .await
            .unwrap();
        assert!(stored.is_some());
    }

    /// An activate failure after a successful staged migrate is reported
    /// under `deploy`, not the finished `migrate` step: the activate runs
    /// through the helper that resumes the deploy step first.
    #[tokio::test]
    async fn staged_migrate_success_then_failed_activate_reports_deploy() {
        let seam = StagedSeam::spawn("activate-fail").await;
        seam.write_capabilities();
        seam.write_invoke(
            "invoke-app",
            200,
            r#"{"ok":true,"migrations":[{"name":"0001.sql","applied":true}]}"#,
        );
        seam.write_invoke("invoke-auth", 200, r#"{"ok":true}"#);
        let log = seam
            .dir
            .path()
            .join("invocations.log")
            .to_string_lossy()
            .into_owned();
        let dir = seam.dir.path().to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let celld = seam.celld(&env);
        let target = DeployTarget::Production;
        let app_side = crate::host::void_cohost::FleetApp {
            dir: seam.root.path(),
            cwd: None,
            timeout: std::time::Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };
        let staged = crate::host::void_cohost::stage_fleet_in_order(
            &seam.pool,
            &seam.app.id,
            None,
            &celld,
            &[staged_proxy()],
            &app_side,
        )
        .await
        .expect("stage");
        let mut progress = Progress {
            pool: &seam.pool,
            app_id: &seam.app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "deploy",
        };
        migrate_void_app_staged(
            MigrateInputs {
                pool: &seam.pool,
                cfg: &seam.cfg,
                app: &seam.app,
                target: &target,
                src_dir: seam.src.path(),
                deploy_root: seam.root.path(),
                commit_sha: "abc123",
                progress: &mut progress,
            },
            &celld,
            &staged,
        )
        .await
        .expect("staged migrate");
        assert_eq!(progress.step, "migrate");
        // Fail the activate: the next celld call, plus one more for the
        // infra retry a loud failure earns.
        let n = seam.invocations().len();
        for i in [n, n + 1] {
            std::fs::write(
                seam.dir.path().join(format!("fail-{i}")),
                "activate blew up",
            )
            .unwrap();
        }
        let err = activate_after_staged_migrate(
            &seam.pool,
            &seam.app,
            &target,
            &celld,
            staged,
            &mut progress,
        )
        .await
        .expect_err("a failed activate fails the deploy");
        progress.fail(&err).await.unwrap();
        let log: String = sqlx::query_scalar("SELECT log FROM deploy WHERE id = ?")
            .bind(progress.id.clone().unwrap_or_default())
            .fetch_one(&seam.pool)
            .await
            .unwrap();
        assert!(log.contains("ERROR: deploy failed"), "{log}");
        assert!(!log.contains("migrate failed"), "{log}");
    }

    /// An unknown staged outcome reconciles: no envelope from the app
    /// endpoint reconciles through the attempt endpoint, like the fleet
    /// path, and the deploy proceeds to the activate.
    #[tokio::test]
    async fn staged_migrate_unknown_outcome_reconciles() {
        let seam = StagedSeam::spawn("unknown").await;
        seam.write_capabilities();
        seam.fail_invoke("invoke-app", "invoke blew up");
        seam.write_invoke(
            "invoke-attempt",
            200,
            r#"{"ok":true,"migrations":[{"name":"0001.sql","applied":true}]}"#,
        );
        seam.write_invoke("invoke-auth", 200, r#"{"ok":true}"#);
        let log = seam
            .dir
            .path()
            .join("invocations.log")
            .to_string_lossy()
            .into_owned();
        let dir = seam.dir.path().to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let celld = seam.celld(&env);
        let target = DeployTarget::Production;
        let app_side = crate::host::void_cohost::FleetApp {
            dir: seam.root.path(),
            cwd: None,
            timeout: std::time::Duration::from_secs(30),
            sourcemap: None,
            read_root: None,
        };
        let staged = crate::host::void_cohost::stage_fleet_in_order(
            &seam.pool,
            &seam.app.id,
            None,
            &celld,
            &[],
            &app_side,
        )
        .await
        .expect("stage");
        let mut progress = Progress {
            pool: &seam.pool,
            app_id: &seam.app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "migrate",
        };
        migrate_void_app_staged(
            MigrateInputs {
                pool: &seam.pool,
                cfg: &seam.cfg,
                app: &seam.app,
                target: &target,
                src_dir: seam.src.path(),
                deploy_root: seam.root.path(),
                commit_sha: "abc123",
                progress: &mut progress,
            },
            &celld,
            &staged,
        )
        .await
        .expect("reconciled migrate succeeds");
        let calls = seam.invocations();
        let reconciles: Vec<_> = calls
            .iter()
            .filter(|call| call.contains("--path /__void/migrate/app/attempt/"))
            .collect();
        assert_eq!(reconciles.len(), 1, "{calls:?}");
    }

    /// Worker warnings land as one write: the first twenty lines plus a
    /// count covering the rest and the entries the array cap dropped — never
    /// one sqlite write per warning.
    #[tokio::test]
    async fn migrate_warnings_log_first_twenty_plus_a_count() {
        let pool = crate::db::connect("sqlite::memory:").await.unwrap();
        let cfg = crate::config::config_for_tests();
        let app = crate::db::create_app(
            &pool,
            &cfg,
            crate::db::NewApp {
                name: "migwarn",
                slug: "migwarn",
                user_id: "local",
                subdomain: "migwarn.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .unwrap();
        let mut progress = Progress {
            pool: &pool,
            app_id: &app.id,
            environment_id: None,
            sha: Some("abc123".to_string()),
            id: None,
            step: "migrate",
        };
        let response = crate::host::void_migrate::MigrateResponse {
            ok: true,
            attempt_id: None,
            migrations: Vec::new(),
            confirmed_applied: Vec::new(),
            confirmed_skipped: Vec::new(),
            stability: None,
            warnings: (0..25).map(|i| format!("warning {}", i)).collect(),
            error: None,
            warnings_dropped: 100,
            migrations_dropped: 0,
        };
        log_migrate_warnings(&mut progress, &response)
            .await
            .expect("log warnings");
        let log: String = sqlx::query_scalar("SELECT log FROM deploy WHERE id = ?")
            .bind(progress.id.clone().unwrap_or_default())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(log.contains("migrate: warning: warning 0\n"), "{}", log);
        assert!(log.contains("migrate: warning: warning 19\n"), "{}", log);
        assert!(!log.contains("warning 20"), "{}", log);
        assert!(
            log.contains("migrate: ...and 105 more warnings\n"),
            "{}",
            log
        );
    }

    /// Outcome name lists show the first twenty with a count, and stay one
    /// line: quoting flattens U+2028 instead of passing it through.
    #[test]
    fn quoted_caps_names_and_flattens_separators() {
        let names: Vec<String> = (0..25).map(|i| format!("{:04}.sql", i)).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let out = quoted(&refs);
        assert!(out.contains("\"0019.sql\""), "{}", out);
        assert!(!out.contains("0020.sql"), "{}", out);
        assert!(out.contains("...and 5 more"), "{}", out);
        let sneaky = quoted(&["a\u{2028}b.sql"]);
        assert!(!sneaky.contains('\u{2028}'), "{:?}", sneaky);
        assert_eq!(sneaky.lines().count(), 1);
    }
}
