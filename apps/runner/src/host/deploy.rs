use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::config::{Config, Tenancy};
use crate::db;
use crate::host::cmd::{self, Sandbox, TipBundle};
use crate::host::credentials;
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
    // A deploy is activity (SPEC, Scale to zero): wake an asleep app so the
    // reconcile loop spawns the fleet this release lands in.
    crate::host::sleep::wake_for_deploy(pool, &app).await;
    let result = deploy_inner(pool, cfg, procs, logs, &app, object_key, tip_sha).await;
    if let Err(e) = &result {
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
    // T5.1: the build just populated the persistent cache; prune it back to
    // the cap now, on success and on failure alike.
    cmd::prune_build_cache(&cmd::build_cache_dir(cfg, &app.slug), cfg.build_cache_mb);
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
    // builds/<slug>/ is created private (umask 077); the build user must be
    // able to reach its worktree through it, and bun lists parent
    // directories to resolve a project (see isolation::harden_data_dir).
    #[cfg(unix)]
    if let Some(slug_dir) = work.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(slug_dir, std::fs::Permissions::from_mode(0o755));
    }

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
        deploy_id = db::upsert_deploy(
            pool,
            Some(&deploy_id),
            &app.id,
            DeployStatus::Building.as_str(),
            Some(&commit_sha),
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
    // Hand the worktree to the build uid before tenant scripts run.
    if let (Some(uid), Some(gid)) = (cfg.build_uid, cfg.build_gid) {
        if sandbox_ok && !cmd::lchown_tree(&work, uid, gid) {
            tracing::warn!(slug = %app.slug, "chown worktree to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    // T5.1: persistent per-app bun cache. Created root-owned (umask 077, so
    // the fleet uid can never read it) and handed to the build uid exactly
    // like the worktree. It outlives the per-deploy worktree wiped below.
    let bun_cache = cmd::build_cache_dir(cfg, &app.slug);
    tokio::fs::create_dir_all(&bun_cache).await?;
    #[cfg(unix)]
    if let Some(parent) = bun_cache.parent() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755));
    }
    if let (Some(uid), Some(gid)) = (cfg.build_uid, cfg.build_gid) {
        if sandbox_ok && !cmd::lchown_tree(&bun_cache, uid, gid) {
            tracing::warn!(slug = %app.slug, "chown bun cache to build uid failed; continuing (needs CAP_CHOWN)");
        }
    }
    let sb = Sandbox { uid: if sandbox_ok { cfg.build_uid } else { None }, gid: if sandbox_ok { cfg.build_gid } else { None }, env: &tenant_refs, bun_cache: Some(&bun_cache) };

    cmd::check_work_quota(&work, cfg.build_max_mb)?;
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
        cmd::run_sandboxed("bun", &["install"], &src_dir, &sb, Duration::from_secs(300)).await?;
        cmd::check_work_quota(&work, cfg.build_max_mb)?;
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
            cmd::run_sandboxed("bun", &["run", "build"], &src_dir, &sb, Duration::from_secs(300)).await?;
            cmd::check_work_quota(&work, cfg.build_max_mb)?;
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
    // Release must not see root keys (SPEC, Build and release sandbox): in multi it gets the scoped
    // credential or is disabled with a clear log line; single keeps root.
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
        let scoped = credentials::tenant_process_credentials(pool, cfg, &app.slug)
            .await
            .ok()
            .flatten();
        if scoped.is_none() {
            deploy_id = db::upsert_deploy(
                pool,
                Some(&deploy_id),
                &app.id,
                DeployStatus::Building.as_str(),
                Some(&commit_sha),
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
            cmd_env.extend(tenant_refs.iter().copied());
            let sb_release = Sandbox { uid: sb.uid, gid: sb.gid, env: &cmd_env, bun_cache: sb.bun_cache };
            let out = cmd::run_sandboxed("sh", &["-c", &release], &src_dir, &sb_release, Duration::from_secs(600)).await?;
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
    // `release` is Noite's key, not Wrangler's: celld deploy refuses any
    // config key it does not know, so drop it once the release step ran.
    strip_noite_keys(&deploy_root).await?;
    if deploy_root != src_dir {
        strip_noite_keys(&src_dir).await?;
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

/// Config keys Noite reads from the tenant's Wrangler file that celld does
/// not accept.
const NOITE_WRANGLER_KEYS: &[&str] = &["release"];

/// Remove Noite-only keys from `dir`'s wrangler.json(c) before `celld
/// deploy`. A file is rewritten only when it carried one; comments in a
/// .jsonc are dropped then, which only affects this build's copy.
async fn strip_noite_keys(dir: &Path) -> anyhow::Result<()> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let path = dir.join(name);
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Some(stripped) = without_noite_keys(&text)? else {
            continue;
        };
        tokio::fs::write(&path, stripped).await?;
    }
    Ok(())
}

/// The config without Noite-only keys, or `None` when it has none.
fn without_noite_keys(text: &str) -> anyhow::Result<Option<String>> {
    let mut value = crate::host::storage::parse_wrangler(text)?;
    let Some(obj) = value.as_object_mut() else {
        return Ok(None);
    };
    let before = obj.len();
    for key in NOITE_WRANGLER_KEYS {
        obj.remove(*key);
    }
    if obj.len() == before {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string_pretty(&value)?))
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

#[cfg(test)]
mod tests {
    use super::without_noite_keys;

    #[test]
    fn release_is_stripped_and_other_keys_survive() {
        let jsonc = "{\n  // tenant comment\n  \"name\": \"a\",\n  \"release\": \"bun run migrate\",\n  \"main\": \"index.js\"\n}";
        let out = without_noite_keys(jsonc).unwrap().expect("rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("release").is_none());
        assert_eq!(v["name"], "a");
        assert_eq!(v["main"], "index.js");
        // Nothing to strip: the file is left alone.
        assert!(without_noite_keys("{\"name\": \"a\"}").unwrap().is_none());
    }
}
