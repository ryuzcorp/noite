//! Rehydrate deploy bare mirrors from S3 tip bundles on ephemeral disks.
//!
//! `git-http/{slug}.git` already hydrates on demand (`git_http::ensure_bare`);
//! this covers the deploy/source mirror `repos/{slug}.git` the same way:
//! any read of a missing mirror pulls the tip bundle then retries once.
//! Boot calls `rehydrate_all` so fleets and source preview work immediately.
use std::time::Duration;

use crate::config::Config;
use crate::db;
use crate::host::{cmd, source};
use sqlx::SqlitePool;

/// Ensure `repos/{slug}.git` exists with at least the tip commit.
/// Returns true when it fetched something. Missing tip (never pushed) is
/// success with `false` — callers treat that as "not deployed yet".
pub async fn ensure_deploy_mirror(cfg: &Config, slug: &str) -> anyhow::Result<bool> {
    let bare = source::bare_repo(cfg, slug);
    if bare.join("HEAD").exists() {
        return Ok(false);
    }
    let Some(tip) = cmd::head_main_bundle(cfg, slug).await? else {
        return Ok(false);
    };
    let root = cmd::work_root(cfg);
    tokio::fs::create_dir_all(&bare).await.ok();
    tokio::fs::create_dir_all(&root).await.ok();
    if !bare.join("HEAD").exists() {
        cmd::run_cmd(
            "git",
            &["init", "--bare", bare.to_str().unwrap()],
            Some(&root),
            &[],
            Duration::from_secs(30),
        )
        .await?;
    }
    // Download the tip bundle to a temp file inside the work dir, then fetch
    // it into the bare mirror (same refspec the deploy pipeline uses).
    let tmp = root.join(format!(".rehydrate-{slug}-{}.bundle", tip.sha));
    let uri = cfg.s3_uri(&tip.key);
    if let Err(e) = cmd::s3_cp_download(cfg, &uri, &tmp).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        anyhow::bail!("download tip bundle for {slug} failed: {e:#}");
    }
    let refspec = format!("+{}:refs/heads/main", tip.sha);
    let fetched = cmd::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            tmp.to_str().unwrap(),
            &refspec,
        ],
        Some(&root),
        &[],
        Duration::from_secs(60),
    )
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    fetched?;
    tracing::info!(slug, sha = %&tip.sha[..12.min(tip.sha.len())], "rehydrated deploy mirror from S3 tip");
    return Ok(true);
}

/// Boot-time best-effort: rehydrate every app's deploy mirror. Failures are
/// warn-only — the pull-then-retry on reads covers stragglers.
pub async fn rehydrate_all(pool: &SqlitePool, cfg: &Config) {
    let apps = match db::list_all_apps(pool).await {
        Ok(apps) => apps,
        Err(e) => {
            tracing::warn!(error = %e, "rehydrate: list apps failed");
            return;
        }
    };
    for app in &apps {
        if let Err(e) = ensure_deploy_mirror(cfg, &app.slug).await {
            tracing::warn!(slug = %app.slug, error = %e, "rehydrate deploy mirror failed");
        }
    }
}
