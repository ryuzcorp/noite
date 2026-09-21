use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::config::Config;
use crate::db;
use crate::host::cmd::{self, TipBundle};
use crate::host::logs::LogState;
use crate::host::supervisor::{self, ProcMap};
use crate::lifecycle::sha_same;
use crate::models::{App, DeployStatus};
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
    let result = deploy_inner(pool, cfg, procs, logs, &app, object_key, tip_sha).await;
    if let Err(e) = result {
        tracing::error!(slug = %app.slug, error = %e, "deploy failed");
        if let Err(db_e) = db::upsert_deploy(
            pool,
            None,
            &app.id,
            DeployStatus::Failed.as_str(),
            tip_sha,
            &format!("ERROR: {e:#}\n"),
        )
        .await
        {
            tracing::error!(slug = %app.slug, error = %db_e, "failed to record deploy failure");
        }
    }
    release(deploying, &app.id).await;
}

async fn deploy_inner(
    pool: &SqlitePool,
    cfg: &Config,
    procs: &ProcMap,
    logs: &LogState,
    app: &App,
    object_key: &str,
    tip_sha: Option<&str>,
) -> anyhow::Result<()> {
    let commit_sha = tip_sha
        .map(|s| s.to_string())
        .or_else(|| {
            let re = regex::Regex::new(r"(?i)/([0-9a-f]{7,40})\.bundle$").ok()?;
            re.captures(object_key)
                .and_then(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
        })
        .ok_or_else(|| anyhow::anyhow!("could not parse commit sha from {object_key}"))?;

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

    let mut deploy_id = db::upsert_deploy(
        pool,
        None,
        &app.id,
        DeployStatus::Building.as_str(),
        Some(&commit_sha),
        &format!(
            "fetching {} via {} (work={})\n",
            cfg.s3_uri(object_key),
            cfg.s3_endpoint,
            work.display()
        ),
    )
    .await?;

    let bundle_path = work.join(format!("{commit_sha}.bundle"));
    let uri = cfg.s3_uri(object_key);
    cmd::s3_cp_download(cfg, &uri, &bundle_path).await?;
    let bytes = tokio::fs::metadata(&bundle_path).await?.len();
    deploy_id = db::upsert_deploy(
        pool,
        Some(&deploy_id),
        &app.id,
        DeployStatus::Building.as_str(),
        Some(&commit_sha),
        &format!(
            "downloaded {bytes} bytes · {}\n",
            &commit_sha[..12.min(commit_sha.len())]
        ),
    )
    .await?;

    let src_dir = materialize_bundle(cfg, app, &work, &bundle_path, &commit_sha).await?;

    // Tenant env (`.dev.vars` model): build + release see the same vars the
    // fleet gets at spawn. Reserved platform names filtered in db.
    let tenant = db::tenant_env(pool, &app.id).await;
    let tenant_refs: Vec<(&str, &str)> =
        tenant.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

    if tokio::fs::try_exists(src_dir.join("package.json")).await? {
        deploy_id = db::upsert_deploy(
            pool,
            Some(&deploy_id),
            &app.id,
            DeployStatus::Building.as_str(),
            Some(&commit_sha),
            "bun install\n",
        )
        .await?;
        cmd::run_cmd(
            "bun",
            &["install"],
            Some(&src_dir),
            &tenant_refs,
            Duration::from_secs(300),
        )
        .await?;
        let pkg_text = tokio::fs::read_to_string(src_dir.join("package.json")).await?;
        if pkg_text.contains("\"build\"") {
            deploy_id = db::upsert_deploy(
                pool,
                Some(&deploy_id),
                &app.id,
                DeployStatus::Building.as_str(),
                Some(&commit_sha),
                "bun run build\n",
            )
            .await?;
            cmd::run_cmd(
                "bun",
                &["run", "build"],
                Some(&src_dir),
                &tenant_refs,
                Duration::from_secs(300),
            )
            .await?;
        }
    }

    let deploy_root = find_deploy_root(&src_dir)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no wrangler.json(c) / dist output to deploy"))?;

    if db::get_app(pool, &app.id).await?.is_none() {
        anyhow::bail!("app {} deleted during build; aborting celld deploy", app.id);
    }

    // One-shot release command (`"release": "bun run db:migrate"` in the
    // tenant wrangler config), run once after build, before `celld deploy`.
    // Failure aborts: the old release keeps serving. 10 min hard timeout.
    if let Some(release) = release_cmd(&src_dir).await {
        deploy_id = db::upsert_deploy(
            pool,
            Some(&deploy_id),
            &app.id,
            DeployStatus::Building.as_str(),
            Some(&commit_sha),
            &format!("release: {release}\n"),
        )
        .await?;
        let env_owned = cmd::aws_env(cfg);
        let mut cmd_env: Vec<(&str, &str)> =
            env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
        cmd_env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));
        cmd_env.extend(tenant_refs.iter().copied());
        let out = cmd::run_cmd(
            "sh",
            &["-c", &release],
            Some(&src_dir),
            &cmd_env,
            Duration::from_secs(600),
        )
        .await?;
        let tail = if out.len() > 4096 { &out[out.len() - 4096..] } else { &out };
        deploy_id = db::upsert_deploy(
            pool,
            Some(&deploy_id),
            &app.id,
            DeployStatus::Building.as_str(),
            Some(&commit_sha),
            &format!("{tail}\n"),
        )
        .await?;
    }

    deploy_id = db::upsert_deploy(
        pool,
        Some(&deploy_id),
        &app.id,
        DeployStatus::Deploying.as_str(),
        Some(&commit_sha),
        &format!("celld deploy → {}\n", app.fleet_bucket),
    )
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

    supervisor::ensure_fleet(pool, cfg, procs, logs, app).await?;
    supervisor::reload_fleet(app).await;

    db::upsert_deploy(
        pool,
        Some(&deploy_id),
        &app.id,
        DeployStatus::Success.as_str(),
        Some(&commit_sha),
        "deploy complete\n",
    )
    .await?;
    tracing::info!(slug = %app.slug, sha = %&commit_sha[..12.min(commit_sha.len())], "deploy ok");
    let _ = tokio::fs::remove_dir_all(&work).await;
    Ok(())
}

async fn materialize_bundle(
    cfg: &Config,
    app: &App,
    work: &PathBuf,
    bundle_path: &PathBuf,
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
async fn release_cmd(src_dir: &PathBuf) -> Option<String> {
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
        if name.starts_with('.') {
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
