use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
use crate::lifecycle::{self, sha_same};
use crate::models::{App, AppStatus, DeployStatus};
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

/// The deploy row one run writes to and the step it is in: every line of the
/// run, its failure included, lands on that one row, and the failure names
/// the step (`fetch`, `install`, `build`, `convert`, `generate`, `release`, `deploy`,
/// `start`).
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
        progress
            .step("release", DeployStatus::Building, &release)
            .await?;
        let scoped = credentials::tenant_process_credentials(pool, cfg, &app.slug)
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

    // The Worker map's shadow bundle runs here, while the tree is still the
    // build uid's: the runner-owned tree below would be unreadable to the
    // sandboxed build uid under the install's umask. Same sandbox as the
    // build itself. The bytes upload only after a successful deploy; a
    // failed deploy drops them with the worktree.
    let worker_map = crate::host::sourcemaps::build_worker_map(&deploy_root, &sb)
        .await
        .map_err(|e| format!("{e:#}"));

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

    let env_owned = s3::aws_env(cfg);
    let mut env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));
    // Work-dir-derived paths are operator-influenced (a non-UTF-8 mount):
    // fail the deploy instead of panicking the deploy task.
    let Some(deploy_arg) = deploy_root.to_str() else {
        anyhow::bail!("deploy root is not valid UTF-8: {}", deploy_root.display());
    };
    exec::run_cmd(
        &cfg.celld_bin,
        &[
            "deploy",
            deploy_arg,
            "--bucket",
            &bucket,
            "--endpoint",
            &cfg.s3_endpoint,
            "--region",
            &cfg.aws_region,
        ],
        Some(&work),
        &env,
        Duration::from_secs(120),
    )
    .await?;

    // The row the deploy targets must still be there before the fleet starts:
    // for a preview, the environment's row (a delete raced this build).
    let environment = match target {
        DeployTarget::Production => {
            if db::get_app(pool, &app.id).await?.is_none() {
                anyhow::bail!(
                    "app {} deleted after celld deploy; skipping fleet start",
                    app.id
                );
            }
            None
        }
        DeployTarget::Environment(env) => match db::get_environment(pool, &env.id).await? {
            Some(fresh) => Some(fresh),
            None => anyhow::bail!(
                "environment {} deleted after celld deploy; skipping fleet start",
                env.id
            ),
        },
    };
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
            supervisor::reload_environment_fleet(env).await;
        }
        None => {
            supervisor::ensure_fleet(pool, cfg, procs, logs, app).await?;
            supervisor::reload_fleet(app).await;
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
                }
                supervisor::FleetFate::Exited(why) => {
                    anyhow::bail!("celld exited before answering its health gate: {why}");
                }
            },
        }
    }

    // Per-deploy source maps for the Errors tab (symbolication at read
    // time): the Worker map via a shadow esbuild run over the deployed entry,
    // plus every client map the build emitted. The shadow runs sandboxed as
    // the build uid, like the build itself. Best-effort — the deploy
    // already succeeded — so a failure is a log line, never a failed deploy.
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
        contained_deploy_root, failure_summary, has_build_script, parse_wrangler_build,
        wipe_worktree, without_runner_keys,
    };
    use serde_json::json;

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
}
