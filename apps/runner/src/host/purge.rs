// Full app teardown: stop the fleet, wipe local work dirs, and empty the
// S3 prefixes that hold the git mirror + fleet durability (D1 / DO / telemetry).
// Used by DELETE /v1/apps/{id} and by create's leftover wipe.
//
// Locking (ordering: CREATE_LOCK → AppLock → push_guard, see
// [`crate::host::git_manifest::GitSync`]): callers hold the outer locks AND
// the slug's `push_guard` before calling — delete holds AppLock + push_guard,
// create holds CREATE_LOCK + push_guard — so a push writing under the same
// prefixes (git + S3 + manifest) cannot interleave with the wipe. This
// function takes no locks itself: taking another guard for the same slug
// here would self-deadlock against the caller's.
use std::time::Duration;

use anyhow::Context;

use crate::config::Config;
use crate::host::logs::{self, LogState};
use crate::host::source;
use crate::host::supervisor::{self, ProcMap};
use crate::host::{exec, s3};

/// Wipe every on-disk and S3 artifact for `slug`. Does **not** touch the DB row
/// — callers decide when to delete that (after a successful purge).
///
/// Requires the caller to hold the slug's `push_guard` (plus AppLock for
/// delete, CREATE_LOCK for create — see the module docs). Order matters
/// inside, too: stop celld first so it cannot rewrite leases / D1 / telemetry
/// into the prefix we are about to empty.
pub async fn purge_slug(
    cfg: &Config,
    procs: &ProcMap,
    log_state: &LogState,
    slug: &str,
) -> anyhow::Result<()> {
    supervisor::stop_fleet(procs, slug).await;
    // Preview environments are fleets of their own (`slug.label`): they share
    // this app's data, so they go down before it is cleared. Their rows go
    // with the app row (FK cascade); `envs/<slug>/` is cleared below.
    supervisor::stop_environment_fleets(procs, slug).await;
    // Brief settle: aws rm racing a dying node leaves incomplete LTX chains
    // (own.json epoch N, ltX only under e1) → D1 RestoreFailed on next boot.
    tokio::time::sleep(Duration::from_millis(500)).await;
    logs::clear(log_state, slug).await;

    let root = exec::work_root(cfg);
    for path in [
        source::bare_repo(cfg, slug),
        root.join("git-http").join(format!("{slug}.git")),
        root.join("projects").join(slug),
        root.join("fleets").join(slug),
        root.join("builds").join(slug),
        // T5.1: the persistent bun cache is per-app tenant data too.
        root.join("cache").join(slug),
        // Every preview environment's state dir (one tree, `envs/<slug>/`).
        root.join("envs").join(slug),
    ] {
        if path.exists() {
            tokio::fs::remove_dir_all(&path)
                .await
                .with_context(|| format!("remove {}", path.display()))?;
        }
    }

    // git/  — tip bundles + refs (source of truth for redeploy)
    // fleets/ — celld durability: D1 sqlite, DO state, peer-auth, telemetry
    // envs/ — every environment's own celld durability (its own D1/DO/R2)
    clear_s3_prefix(cfg, &format!("s3://{}/git/{slug}/", cfg.s3_bucket)).await?;
    clear_s3_prefix(cfg, &format!("s3://{}/fleets/{slug}/", cfg.s3_bucket)).await?;
    clear_s3_prefix(
        cfg,
        &format!("s3://{}/{}", cfg.s3_bucket, cfg.envs_prefix(slug)),
    )
    .await?;
    tracing::info!(slug, "purged local + S3 app data");
    Ok(())
}

async fn clear_s3_prefix(cfg: &Config, prefix: &str) -> anyhow::Result<()> {
    let bucket = prefix
        .strip_prefix("s3://")
        .and_then(|s| s.split('/').next())
        .unwrap_or(&cfg.s3_bucket)
        .to_string();
    let key = prefix
        .strip_prefix(&format!("s3://{bucket}/"))
        .unwrap_or(prefix);
    s3::s3_rm_prefix(cfg, &bucket, key)
        .await
        .with_context(|| format!("clear S3 prefix {prefix}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::models::EnvironmentKind;

    /// A purge covers `envs/<slug>/` — the local state dirs, the bucket prefix
    /// and every environment fleet of the app — so an app delete leaves no
    /// preview behind (ROADMAP: purge covers `envs/<slug>/` and its rows).
    #[tokio::test]
    async fn purge_covers_environment_data() {
        let base =
            std::env::temp_dir().join(format!("noite-purge-envs-{}", crate::models::new_id()));
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = base.join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "purge",
                slug: "purge",
                user_id: "local",
                subdomain: "purge.localhost",
                listen: 30200,
                internal: 30201,
            },
        )
        .await
        .expect("app");
        db::create_environment(
            &pool,
            &cfg,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "purge",
                label: "feature",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/feature",
                created_by: "user_1",
                listen: 30210,
                internal: 30211,
            },
        )
        .await
        .expect("environment");

        // A local env state dir and a running env fleet.
        let state_dir = crate::host::supervisor::env_state_dir(&cfg, "purge", "feature");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("deploy.json"), "{}").unwrap();
        let procs = crate::host::supervisor::new_procs();
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn");
        let pid = child.id().expect("pid");
        procs.lock().await.insert(
            crate::host::supervisor::env_fleet_key("purge", "feature"),
            child,
        );

        // The production contract: callers hold the slug's push guard across
        // the purge so no push writes under the wiped prefixes mid-teardown.
        let git_sync = crate::host::git_manifest::GitSync::default();
        let _push = git_sync.push_guard("purge").await;
        purge_slug(&cfg, &procs, &crate::host::logs::new_state(), "purge")
            .await
            .expect("purge");

        assert!(!state_dir.exists(), "the environment state dir is wiped");
        assert!(
            !procs
                .lock()
                .await
                .contains_key(&crate::host::supervisor::env_fleet_key("purge", "feature")),
            "the environment fleet is stopped"
        );
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        // The row survives purge (the caller deletes the app row, whose
        // cascade takes the environment rows with it).
        assert_eq!(
            db::list_environments(&pool, &app.id).await.unwrap().len(),
            1
        );
        db::delete_app(&pool, &app.id).await.expect("delete app");
        assert!(db::list_environments(&pool, &app.id)
            .await
            .unwrap()
            .is_empty());
        pool.close().await;
        let _ = std::fs::remove_dir_all(&base);
    }
}
