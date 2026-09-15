// Full app teardown: stop the fleet, wipe local work dirs, and empty the
// S3 prefixes that hold the git mirror + fleet durability (D1 / DO / telemetry).
// Used by DELETE /v1/apps/{id} and boot reclaim of legacy soft-deleted rows.
//
// Must hold the same AppLock as deploy (callers claim before calling) so a
// finishing deploy cannot rewrite fleets/git after we clear them.
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::host::cmd;
use crate::host::logs::{self, LogState};
use crate::host::source;
use crate::host::supervisor::{self, ProcMap};

/// Wipe every on-disk and S3 artifact for `slug`. Does **not** touch the DB row
/// — callers decide when to delete that (after a successful purge).
///
/// Order matters: stop celld first so it cannot rewrite leases / D1 / telemetry
/// into the prefix we are about to empty.
pub async fn purge_slug(
    cfg: &Config,
    procs: &ProcMap,
    log_state: &LogState,
    slug: &str,
) -> anyhow::Result<()> {
    supervisor::stop_fleet(procs, slug).await;
    // Brief settle: aws rm racing a dying node leaves incomplete LTX chains
    // (own.json epoch N, ltx only under e1) → D1 RestoreFailed on next boot.
    tokio::time::sleep(Duration::from_millis(500)).await;
    logs::clear(log_state, slug).await;

    let root = cmd::work_root(cfg);
    for path in [
        source::bare_repo(cfg, slug),
        root.join("git-http").join(format!("{slug}.git")),
        root.join("projects").join(slug),
        root.join("fleets").join(slug),
        root.join("builds").join(slug),
    ] {
        if path.exists() {
            tokio::fs::remove_dir_all(&path)
                .await
                .with_context(|| format!("remove {}", path.display()))?;
        }
    }

    // git/  — tip bundles + refs (source of truth for redeploy)
    // fleets/ — celld durability: D1 sqlite, DO state, peer-auth, telemetry
    clear_s3_prefix(cfg, &format!("s3://{}/git/{slug}/", cfg.s3_bucket)).await?;
    clear_s3_prefix(cfg, &format!("s3://{}/fleets/{slug}/", cfg.s3_bucket)).await?;
    tracing::info!(slug, "purged local + S3 app data");
    Ok(())
}

async fn clear_s3_prefix(cfg: &Config, prefix: &str) -> anyhow::Result<()> {
    let env_owned = cmd::aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned
        .iter()
        .map(|(k, v)| (*k, v.as_str()))
        .collect();
    cmd::run_cmd(
        "aws",
        &[
            "--endpoint-url",
            &cfg.s3_endpoint,
            "s3",
            "rm",
            "--recursive",
            prefix,
        ],
        None,
        &env,
        Duration::from_secs(120),
    )
    .await
    .with_context(|| format!("clear S3 prefix {prefix}"))?;
    Ok(())
}
