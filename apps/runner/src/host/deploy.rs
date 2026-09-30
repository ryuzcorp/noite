use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::config::{Config, Tenancy};
use crate::db;
use crate::host::build_output;
use crate::host::generated_config;
use crate::host::package_manager;
use crate::host::cmd::{self, Sandbox, TipBundle};
use crate::host::credentials;
use crate::host::logs::LogState;
use crate::host::supervisor::{self, ProcMap};
use crate::lifecycle::{self, sha_same};
use crate::models::{App, AppStatus, DeployStatus};
use sqlx::SqlitePool;

/// Per-app exclusive lock shared by deploy and purge/delete so S3 fleets/git
/// never see overlapping writers (ghost LTX / RestoreFailed after partial wipe).
pub type AppLock = Arc<Mutex<HashSet<String>>>;

pub type Deploying = AppLock;

pub fn new_deploying() -> Deploying {
    Arc::new(Mutex::new(HashSet::new()))
}

pub async fn claim(deploying: &Deploying, app_id: &str) -> bool {
    let mut g = deploying.lock().await;
    if g.contains(app_id) {
        return false;
    }
    g.insert(app_id.to_string());
    true
}

/// Wait up to `timeout` to acquire the lock (delete waits out an in-flight deploy).
pub async fn claim_wait(deploying: &Deploying, app_id: &str, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if claim(deploying, app_id).await {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

pub async fn release(deploying: &Deploying, app_id: &str) {
    deploying.lock().await.remove(app_id);
}

pub async fn snapshot_claimed(deploying: &Deploying) -> HashSet<String> {
    deploying.lock().await.clone()
}

#[allow(clippy::too_many_arguments)] // shared deps threaded by reference; a context struct would only obfuscate this one call site
pub async fn deploy_app(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    object_key: &str,
    tip_sha: Option<&str>,
) {
    if !claim(deploying, &app.id).await {
        tracing::info!(slug = %app.slug, "deploy skip (in flight)");
        return;
    }
    // A deploy is activity (SPEC, Scale to zero): wake an asleep app so the
    // reconcile loop spawns the fleet this release lands in.
    crate::host::sleep::wake_for_deploy(pool, &app).await;
    let mut progress = Progress {
        pool,
        app_id: &app.id,
        sha: tip_sha.map(str::to_string),
        id: None,
        step: "fetch",
    };
    let result = deploy_inner(pool, cfg, procs, logs, &app, object_key, &mut progress).await;
    if let Err(e) = &result {
        tracing::error!(slug = %app.slug, step = progress.step, error = %e, "deploy failed");
        if let Err(db_e) = progress.fail(e).await {
            tracing::error!(slug = %app.slug, error = %db_e, "failed to record deploy failure");
        }
    }
    // T5.1: the build just populated the persistent cache; prune it back to
    // the cap now, on success and on failure alike.
    cmd::prune_build_cache(&cmd::build_cache_dir(cfg, &app.slug), cfg.build_cache_mb);
    release(deploying, &app.id).await;
}

/// The deploy row one run writes to and the step it is in: every line of the
/// run, its failure included, lands on that one row, and the failure names
/// the step (`fetch`, `install`, `build`, `convert`, `generate`, `release`, `deploy`,
/// `start`).
struct Progress<'a> {
    pool: &'a SqlitePool,
    app_id: &'a str,
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
            status.as_str(),
            self.sha.as_deref(),
            text,
        )
        .await?;
        self.id = Some(id);
        Ok(())
    }

    /// Enter `step`, logged as `▸ step: detail`.
    async fn step(&mut self, step: &'static str, status: DeployStatus, detail: &str) -> sqlx::Result<()> {
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

    /// Record `err` on the row and a one-line summary on the app.
    async fn fail(&mut self, err: &anyhow::Error) -> sqlx::Result<()> {
        let detail = lifecycle::strip_ansi(&format!("{err:#}")).into_owned();
        let detail = lifecycle::tail_utf8(detail.trim_end(), FAILURE_TAIL);
        self.log(DeployStatus::Failed, &format!("ERROR: {} failed\n{detail}\n", self.step))
            .await?;
        db::update_app_status(
            self.pool,
            self.app_id,
            AppStatus::Failed.as_str(),
            Some(&failure_summary(self.step, detail)),
            None,
        )
        .await
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
    let lines: Vec<&str> = detail.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut pick = lines.first().copied().unwrap_or("");
    for (i, line) in lines.iter().enumerate().skip(1) {
        if !line.to_ascii_lowercase().contains("error") {
            continue;
        }
        pick = if line.ends_with(':') { lines.get(i + 1).copied().unwrap_or(line) } else { line };
        break;
    }
    let line: String = pick.chars().take(300).collect();
    format!("{step} failed: {line}")
}

async fn deploy_inner(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
    object_key: &str,
    progress: &mut Progress<'_>,
) -> anyhow::Result<()> {
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
    let Some(fresh) = db::get_app(pool, &app.id).await? else {
        anyhow::bail!("app {} gone before deploy (deleted?)", app.id);
    };
    if fresh
        .last_deploy_sha
        .as_deref()
        .is_some_and(|s| sha_same(s, &commit_sha))
    {
        tracing::info!(
            slug = %app.slug,
            sha = %&commit_sha[..12.min(commit_sha.len())],
            "deploy skip (already at sha)"
        );
        return Ok(());
    }

    let root = cmd::work_root(cfg);
    let work = root.join("builds").join(&app.slug).join(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string(),
    );
    tokio::fs::create_dir_all(&work).await?;
    // builds/<slug>/ is created private (umask 077); the build user must be
    // able to reach its worktree through it, and bun lists parent
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
    let bare = cmd::work_root(cfg)
        .join("repos")
        .join(format!("{}.git", app.slug));
    let mirror_warm = bare.join("HEAD").exists()
        && cmd::run_cmd(
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
        cmd::s3_cp_download(cfg, &uri, &bundle_path).await?;
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

    let src_dir = materialize_bundle(cfg, app, &work, &fetch_from, &commit_sha).await?;
    // Tenant env (`.dev.vars` model): build + release see the same vars the
    // fleet gets at spawn. Reserved platform names filtered in db (now
    // including RUNNER_*/NOITE_*/BETTER_AUTH_*/CADDY_*/LD_*/NODE_OPTIONS/BUN_*).
    let tenant = db::tenant_env(pool, &app.id).await;
    let tenant_refs: Vec<(&str, &str)> =
        tenant.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    // Tenancy gate (SPEC, Tenancy mode): multi-tenant builds require the uid drop.
    // Without CAP_SETUID/CAP_SETGID the runner refuses builds rather than
    // running tenant scripts as itself with platform secrets in reach.
    let multi = cfg.tenancy == Tenancy::Multi;
    let sandbox_ok = match (cfg.build_uid, cfg.build_gid) {
        (Some(u), Some(g)) => cmd::can_drop_uid(u, g),
        (Some(u), None) => cmd::can_drop_uid(u, u),
        _ => false,
    };
    if multi && !sandbox_ok {
        anyhow::bail!("build sandbox unavailable (no CAP_SETUID/SETGID for build uid); refusing build in multi-tenant mode");
    }
    if multi && cfg.build_uid.is_none() {
        anyhow::bail!("build sandbox unavailable (RUNNER_BUILD_UID unset); refusing build in multi-tenant mode");
    }

    // The package manager (package_manager.rs). An unpinned project's spec
    // goes beside the tree, not in it, and is written before the handover
    // below so the build uid can read it.
    let package = read_package_json(&src_dir).await?;
    let manager = package.as_ref().map(|p| package_manager::detect(&src_dir, p));
    let spec_path = work.join("package-manager.json");
    let spec_env = match manager.as_ref().and_then(package_manager::PackageManager::spec_file) {
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

    // Hand the worktree to the build uid before tenant scripts run.
    if let (Some(uid), Some(gid)) = (cfg.build_uid, cfg.build_gid) {
        if sandbox_ok && !cmd::lchown_tree(&work, uid, gid) {
            tracing::warn!(slug = %app.slug, "chown worktree to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    // T5.1: persistent per-app build cache (bun, jup's package managers, and
    // HOME for npm/pnpm/Yarn; cmd::base_env). Created root-owned (umask 077,
    // so the fleet uid can never read it) and handed to the build uid exactly
    // like the worktree. It outlives the per-deploy worktree wiped below.
    let cache = cmd::build_cache_dir(cfg, &app.slug);
    tokio::fs::create_dir_all(&cache).await?;
    #[cfg(unix)]
    if let Some(parent) = cache.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755));
    }
    if let (Some(uid), Some(gid)) = (cfg.build_uid, cfg.build_gid) {
        if sandbox_ok && !cmd::lchown_tree(&cache, uid, gid) {
            tracing::warn!(slug = %app.slug, "chown build cache to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    let sb = Sandbox { uid: if sandbox_ok { cfg.build_uid } else { None }, gid: if sandbox_ok { cfg.build_gid } else { None }, env: &step_env, cache: Some(&cache) };

    cmd::check_work_quota(&work, cfg.build_max_mb)?;
    let step_timeout = Duration::from_secs(cfg.build_timeout_s);
    let wrangler_build = wrangler_build(&src_dir).await?;
    if let Some(pm) = &manager {
        let (program, args) = pm.install();
        progress
            .step("install", DeployStatus::Building, &format!("{} install ({})", pm.name, pm.reason))
            .await?;
        let out = cmd::run_sandboxed(program, &args, &src_dir, &sb, step_timeout).await?;
        progress.output(&out).await?;
        cmd::check_work_quota(&work, cfg.build_max_mb)?;
    }
    // Wrangler's own custom build (`build.command`, run from `build.cwd`)
    // wins over the package `build` script, as it does for `wrangler deploy`.
    let mut built = false;
    if let Some(build) = &wrangler_build {
        progress.step("build", DeployStatus::Building, &build.command).await?;
        let cwd = src_dir.join(&build.cwd);
        let out = cmd::run_sandboxed("sh", &["-c", &build.command], &cwd, &sb, step_timeout).await?;
        progress.output(&out).await?;
        built = true;
    } else if let Some(pm) = manager.as_ref().filter(|_| package.as_ref().is_some_and(has_build_script)) {
        let (program, args) = pm.run("build");
        progress
            .step("build", DeployStatus::Building, &format!("{} run build", pm.name))
            .await?;
        let out = cmd::run_sandboxed(program, &args, &src_dir, &sb, step_timeout).await?;
        progress.output(&out).await?;
        built = true;
    }
    if built {
        cmd::check_work_quota(&work, cfg.build_max_mb)?;
    }

    // `cf` CLI apps declare the Worker in cloudflare.config.ts; generate the
    // wrangler.json celld deploys, unless the tree or the build has one.
    if tokio::fs::try_exists(src_dir.join(CF_CONFIG)).await? && !has_wrangler_config(&src_dir).await? {
        progress
            .step("convert", DeployStatus::Building, &format!("{CF_CONFIG} → wrangler.json"))
            .await?;
        cmd::run_sandboxed(
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
            progress.log(DeployStatus::Building, &format!("config: {}\n", built.note)).await?;
            built.dir
        }
        None => match find_deploy_root(&src_dir).await? {
            Some(root) => root,
            None => {
                progress
                    .step("generate", DeployStatus::Building, "no Wrangler config: generating one")
                    .await?;
                let plan = generated_config::plan(&src_dir, package.as_ref())?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "nothing to deploy: no Wrangler config, no index.html in dist/, build/ or \
                         out/, and no package.json main exporting a fetch handler"
                    )
                })?;
                progress.log(DeployStatus::Building, &format!("config: {}\n", plan.note())).await?;
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
        progress.step("release", DeployStatus::Building, &release).await?;
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
            owned.push(("NOITE_APP_PREFIX".into(), format!("fleets/{}", app.slug)));
            let mut cmd_env: Vec<(&str, &str)> = owned.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            cmd_env.extend(step_env.iter().copied());
            let sb_release = Sandbox { uid: sb.uid, gid: sb.gid, env: &cmd_env, cache: sb.cache };
            let out = cmd::run_sandboxed("sh", &["-c", &release], &src_dir, &sb_release, Duration::from_secs(600)).await?;
            progress.output(&out).await?;
        }
    }

    // Tenant steps are over: take the tree back from the build user, so
    // nothing it left behind can change the bundle `celld deploy` uploads.
    #[cfg(unix)]
    if sb.uid.is_some() {
        // SAFETY: geteuid/getegid cannot fail.
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        if !cmd::lchown_tree(&work, uid, gid) {
            anyhow::bail!("could not take the worktree back from the build user; refusing to deploy it");
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
        .step("deploy", DeployStatus::Deploying, &format!("celld deploy → {}", app.fleet_bucket))
        .await?;

    let env_owned = cmd::aws_env(cfg);
    let mut env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));
    cmd::run_cmd(
        &cfg.celld_bin,
        &[
            "deploy",
            deploy_root.to_str().unwrap(),
            "--bucket",
            &app.fleet_bucket,
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

    if db::get_app(pool, &app.id).await?.is_none() {
        anyhow::bail!("app {} deleted after celld deploy; skipping fleet start", app.id);
    }
    db::set_deployed_config(pool, &app.id, effective_config(&deploy_root).await.as_deref()).await?;

    progress.step = "start";
    supervisor::ensure_fleet(pool, cfg, procs, logs, app).await?;
    supervisor::reload_fleet(app).await;

    progress.log(DeployStatus::Success, "deploy complete\n").await?;
    tracing::info!(slug = %app.slug, sha = %&commit_sha[..12.min(commit_sha.len())], "deploy ok");
    let _ = tokio::fs::remove_dir_all(&work).await;
    Ok(())
}

async fn materialize_bundle(
    cfg: &Config,
    app: &App,
    work: &Path,
    bundle_path: &Path,
    sha: &str,
) -> anyhow::Result<PathBuf> {
    let bare = cmd::work_root(cfg)
        .join("repos")
        .join(format!("{}.git", app.slug));
    let src_dir = work.join("src");
    tokio::fs::create_dir_all(&bare).await?;
    tokio::fs::create_dir_all(&src_dir).await?;
    if !tokio::fs::try_exists(bare.join("HEAD")).await? {
        cmd::run_cmd(
            "git",
            &["init", "--bare", bare.to_str().unwrap()],
            Some(work),
            &[],
            Duration::from_secs(30),
        )
        .await?;
    }
    let refspec = format!("+{sha}:refs/heads/main");
    cmd::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            bundle_path.to_str().unwrap(),
            &refspec,
        ],
        Some(work),
        &[],
        Duration::from_secs(60),
    )
    .await?;
    let _ = tokio::fs::remove_dir_all(&src_dir).await;
    tokio::fs::create_dir_all(&src_dir).await?;
    cmd::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            &format!("--work-tree={}", src_dir.display()),
            "checkout",
            "-f",
            "main",
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
        anyhow::bail!("deploy root {} resolves outside the worktree", root.display());
    }
    for name in ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] {
        let is_link = std::fs::symlink_metadata(resolved.join(name)).is_ok_and(|m| m.file_type().is_symlink());
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
    if !cwd
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_) | std::path::Component::CurDir))
    {
        anyhow::bail!("build.cwd must be a path inside the project");
    }
    Ok(Some(WranglerBuild { command: command.chars().take(500).collect(), cwd }))
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

pub async fn deploy_tip(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    deploying: &Deploying,
    app: App,
    tip: TipBundle,
) {
    if app
        .last_deploy_sha
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
        &tip.key,
        Some(&tip.sha),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::{
        contained_deploy_root, failure_summary, has_build_script, parse_wrangler_build, without_runner_keys,
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

        assert_eq!(contained_deploy_root(&src, &src.join("dist")).unwrap(), src.join("dist"));
        symlink(&outside, src.join("evil")).unwrap();
        assert!(contained_deploy_root(&src, &src.join("evil")).is_err());
        symlink(outside.join("wrangler.json"), src.join("dist/wrangler.json")).unwrap();
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
        assert!(has_build_script(&json!({ "scripts": { "build": "vite build" } })));
        assert!(!has_build_script(&json!({ "scripts": { "build": " " } })));
        // A dependency named "build" used to count as a build script.
        assert!(!has_build_script(&json!({ "dependencies": { "build": "1.0.0" } })));
        assert!(!has_build_script(&json!({ "name": "x" })));
    }

    #[test]
    fn wrangler_build_command_and_cwd() {
        let b = parse_wrangler_build(&json!({ "build": { "command": " npm run build ", "cwd": "web" } }))
            .unwrap()
            .unwrap();
        assert_eq!(b.command, "npm run build");
        assert_eq!(b.cwd, std::path::PathBuf::from("web"));
        assert!(parse_wrangler_build(&json!({ "build": { "command": "" } })).unwrap().is_none());
        assert!(parse_wrangler_build(&json!({ "name": "x" })).unwrap().is_none());
        assert!(parse_wrangler_build(&json!({ "build": { "command": "x", "cwd": "../up" } })).is_err());
        assert!(parse_wrangler_build(&json!({ "build": { "command": "x", "cwd": "/etc" } })).is_err());
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
}
