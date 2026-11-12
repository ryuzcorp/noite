//! Preview environment teardown: one place that stops an environment's fleet
//! and wipes everything it owns, plus the ref-driven path (a deleted branch
//! deletes its environment).
//!
//! Order matches `host::purge`: the fleet goes down first, so nothing rewrites
//! D1 / DO / telemetry into the prefix about to be emptied.

use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::logs::LogState;
use crate::host::s3;
use crate::host::supervisor::{self, ProcMap};
use crate::models::{App, Environment};

/// What teardown needs to know about one environment: its row id, owning app,
/// fleet key and bucket label. The model-free shape lets the boot step tear
/// down retired `kind='workspace'` rows, which `EnvironmentKind` no longer
/// decodes.
#[derive(Debug, Clone, Copy)]
pub struct EnvTarget<'a> {
    pub id: &'a str,
    pub app_id: &'a str,
    pub app_slug: &'a str,
    pub label: &'a str,
}

impl<'a> From<&'a Environment> for EnvTarget<'a> {
    fn from(env: &'a Environment) -> Self {
        Self {
            id: &env.id,
            app_id: &env.app_id,
            app_slug: &env.app_slug,
            label: &env.label,
        }
    }
}

/// Remove one environment: fleet, local state dir, S3 prefix, telemetry
/// rows, then its row.
/// The row goes last so a failure leaves something to retry (the same
/// reasoning as `purge_slug` + `delete_app`). Telemetry goes before the row
/// for the same reason — and because the fleet key (`{slug}.{label}`) dies
/// with the label: a reused label must not inherit rows, watermarks or
/// compaction marks.
pub async fn teardown(
    cfg: &Config,
    pool: &SqlitePool,
    procs: &ProcMap,
    log_state: &LogState,
    env: EnvTarget<'_>,
    strict_credentials: bool,
) -> anyhow::Result<()> {
    supervisor::stop_environment_fleet(procs, env.app_slug, env.label).await;
    // Brief settle, same as purge: don't clear a dying node's prefix.
    tokio::time::sleep(Duration::from_millis(500)).await;
    crate::host::logs::clear(
        log_state,
        &supervisor::env_fleet_key(env.app_slug, env.label),
    )
    .await;
    let state_dir = supervisor::env_state_dir(cfg, env.app_slug, env.label);
    if state_dir.exists() {
        tokio::fs::remove_dir_all(&state_dir)
            .await
            .with_context(|| format!("remove {}", state_dir.display()))?;
    }
    clear_env_prefix(cfg, env.app_slug, env.label).await?;
    // The maps live under the cleared prefix, so they are gone already; the
    // SQLite rows, the ingest watermark and the compaction marks are keyed
    // by (app, environment) and fleet key and must be dropped explicitly.
    let fleet_key = supervisor::env_fleet_key(env.app_slug, env.label);
    if let Err(e) = db::delete_environment_telemetry(pool, env.app_id, env.id).await {
        tracing::warn!(env_id = %env.id, error = %e, "environment telemetry purge failed");
    }
    if let Err(e) = db::delete_metric_watermarks_for(pool, &fleet_key).await {
        tracing::warn!(env_id = %env.id, error = %e, "environment watermark purge failed");
    }
    if let Err(e) = db::delete_compactions_for(pool, &fleet_key).await {
        tracing::warn!(env_id = %env.id, error = %e, "environment compaction-mark purge failed");
    }
    // The tick's in-memory copies of those marks go too, or a label reused
    // before the next restart would inherit the dead fleet's watermark and
    // skip its first compactions.
    crate::host::metrics::forget_fleet(&fleet_key);
    // The environment's key must not outlive its prefix (SPEC, Scoped
    // credentials); the app's own key is untouched. The boot retirement has no
    // later sweep for a row it deletes, so there a failed revoke keeps the row
    // (and `kind`) for the next boot instead of dropping the only retry.
    if let Err(e) = crate::host::credentials::revoke_environment(pool, cfg, env.id).await {
        if strict_credentials {
            return Err(e).with_context(|| {
                format!(
                    "revoke the scoped credential of retired environment {}",
                    env.id
                )
            });
        }
        tracing::warn!(env_id = %env.id, error = %format!("{e:#}"), "environment deleted but credential revoke failed");
    }
    // Its operator token goes too (row and process cache), so a reused
    // label mints fresh.
    if let Err(e) =
        crate::host::credentials::delete_operator_token(pool, &format!("env:{}", env.id)).await
    {
        tracing::warn!(env_id = %env.id, error = %e, "environment deleted but operator token row remains");
    }
    db::delete_environment_row(pool, env.id).await?;
    tracing::info!(
        slug = %env.app_slug,
        label = %env.label,
        "tore down preview environment"
    );
    Ok(())
}

/// Empty one environment's bucket prefix (`envs/<slug>/<label>/`). Idempotent:
/// an empty listing is a no-op, so a retry after a partial delete is safe.
pub async fn clear_env_prefix(cfg: &Config, slug: &str, label: &str) -> anyhow::Result<()> {
    let prefix = cfg.envs_prefix(slug);
    s3::s3_rm_prefix(cfg, &cfg.s3_bucket, &format!("{prefix}{label}/"))
        .await
        .with_context(|| format!("clear S3 prefix {prefix}{label}/"))
}

/// A push or server-side ref move deleted refs: every environment whose ref
/// disappeared is torn down (ROADMAP — deleting the branch deletes its
/// environment). Moves are not handled here: the deploy side is driven by
/// `tips::TipNotify`.
pub async fn on_refs_deleted(state: &crate::AppState, app: &App, deleted: &[String]) {
    for refname in deleted {
        let Ok(Some(env)) = db::get_environment_by_ref(&state.pool, &app.id, refname).await else {
            continue;
        };
        tracing::info!(
            slug = %app.slug,
            label = %env.label,
            ref = %refname,
            "ref deleted; removing its environment"
        );
        if let Err(e) = teardown(
            &state.config,
            &state.pool,
            &state.procs,
            &state.logs,
            (&env).into(),
            false,
        )
        .await
        {
            tracing::warn!(slug = %app.slug, error = %format!("{e:#}"), "environment teardown failed");
        }
    }
}

/// One environment row from before the workspace previews were removed. It
/// is read field by field: `EnvironmentKind` no longer decodes `workspace`,
/// so the regular model cannot load it.
#[derive(Debug, sqlx::FromRow)]
struct RetiredWorkspace {
    id: String,
    app_id: String,
    app_slug: String,
    label: String,
}

/// `instance_setting` key: the one-shot retired `refs/previews/` sweep ran.
/// Only a pre-upgrade runner ever wrote that namespace, so after the sweep
/// there is nothing left to look for; a failure leaves the key unset so the
/// next boot retries.
const RETIRED_PREVIEWS_SWEPT: &str = "retired_previews_swept";

/// Boot step: tear down every `kind='workspace'` environment an upgraded
/// install still holds (`source.preview` and its in-browser predecessor,
/// removed), and delete the retired `refs/previews/*` refs an upgrade left in
/// any app's mirror and durable manifest. `EnvironmentKind` no longer decodes
/// `workspace`, so the rows must go before anything lists environments; a
/// failure is logged and left for the next boot (a boot loop would take the
/// whole install down; the affected rows stay and the read of them reports
/// the error until it is fixed). Idempotent: teardown is (an empty prefix is
/// a no-op), so a later boot retries whatever this one could not finish.
pub async fn retire_workspace_environments(state: &crate::AppState) -> anyhow::Result<usize> {
    let rows: Vec<RetiredWorkspace> = sqlx::query_as(
        r#"SELECT e.id, e.app_id, a.slug AS app_slug, e.label
           FROM environment e JOIN app a ON a.id = e.app_id
           WHERE e.kind = 'workspace'
           ORDER BY e.created_at ASC"#,
    )
    .fetch_all(&state.pool)
    .await
    .context("list retired workspace environments")?;
    let total = rows.len();
    // The refs are retired for **every** app, not just the ones that still
    // hold a workspace row: the old teardown (the delete route and the TTL
    // sweep) removed the row but never the hidden ref, so an app whose
    // preview was already deleted still carries one. A push's snapshot holds
    // branches and tags only, so a surviving preview ref in the manifest
    // would make every later push fail as a create of a ref the manifest
    // already has. The sweep is one-shot: nothing writes the namespace any
    // more, and a failure is logged (never aborting the boot) and leaves the
    // marker unset, so the next start retries.
    if db::get_setting(&state.pool, RETIRED_PREVIEWS_SWEPT)
        .await?
        .is_none()
    {
        let apps = db::list_apps(&state.pool)
            .await
            .context("list apps for the retired preview ref sweep")?;
        let mut all_swept = true;
        for app in &apps {
            match crate::host::forge::delete_retired_refs(state, &app.slug).await {
                Ok(0) => {}
                Ok(refs) => {
                    tracing::info!(slug = %app.slug, refs, "removed retired preview refs");
                }
                Err(e) => {
                    // Never abort the boot for the sweep: one app with a
                    // missing or corrupt manifest (or a second runner racing
                    // the same install) must not brick the install. The
                    // marker stays unset, so the next boot retries.
                    tracing::warn!(
                        slug = %app.slug,
                        error = %format!("{e:#}"),
                        "retired preview ref sweep failed; retrying on the next boot"
                    );
                    all_swept = false;
                }
            }
        }
        if all_swept {
            db::set_setting(&state.pool, RETIRED_PREVIEWS_SWEPT, "1").await?;
            tracing::info!(apps = apps.len(), "retired preview refs swept");
        } else {
            tracing::warn!("retired preview refs remain; the next boot retries the sweep");
        }
    }
    let mut failed: Vec<String> = Vec::new();
    for row in rows {
        tracing::info!(
            slug = %row.app_slug,
            label = %row.label,
            "retired workspace preview; removing"
        );
        let target = EnvTarget {
            id: &row.id,
            app_id: &row.app_id,
            app_slug: &row.app_slug,
            label: &row.label,
        };
        if let Err(e) = teardown(
            &state.config,
            &state.pool,
            &state.procs,
            &state.logs,
            target,
            true,
        )
        .await
        {
            tracing::warn!(
                slug = %row.app_slug,
                label = %row.label,
                error = %format!("{e:#}"),
                "retired workspace teardown failed"
            );
            failed.push(format!("{}.{}", row.app_slug, row.label));
        }
    }
    if !failed.is_empty() {
        // Log-and-retry, not abort: a permanently failing teardown (an
        // unreachable bucket, a bad row) would otherwise loop the boot
        // forever. The rows stay `kind='workspace'`, so the next boot picks
        // them up; the environment reads that cannot decode them report the
        // error meanwhile.
        tracing::warn!(
            failed = %failed.join(", "),
            "retired workspace previews remain; the next boot retries"
        );
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{new_id, EnvironmentKind};

    /// The ref-driven rule: only the environment whose ref vanished is
    /// removed, a moved ref is left alone.
    #[tokio::test]
    async fn deleted_ref_removes_only_its_environment() {
        let dir = std::env::temp_dir().join(format!("noite-env-teardown-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = db::connect(&url).await.expect("boot");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        // Unreachable on purpose: the first pass proves the wipe failure
        // leaves the row for a retry instead of dropping it silently.
        cfg.s3_endpoint = "http://127.0.0.1:1".into();
        let state = crate::AppState {
            pool: pool.clone(),
            config: std::sync::Arc::new(cfg.clone()),
            procs: supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify: tokio::sync::watch::channel(0u64).0,
            wal: crate::host::git_store::build_wal(&cfg),
            tip_tx: crate::host::tips::channel().0,
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: std::sync::Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
            source_maps: Default::default(),
            control_boot: Default::default(),
        };
        let app = db::create_app(
            &pool,
            &state.config,
            db::NewApp {
                name: "tear",
                slug: "tear",
                user_id: "local",
                subdomain: "tear.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("app");
        let gone = db::create_environment(
            &pool,
            &state.config,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "tear",
                label: "gone",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/gone",
                created_by: "user_1",
                listen: 30110,
                internal: 30111,
            },
        )
        .await
        .expect("env gone");
        let moved = db::create_environment(
            &pool,
            &state.config,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "tear",
                label: "kept",
                kind: EnvironmentKind::Branch,
                git_ref: "refs/heads/kept",
                created_by: "user_1",
                listen: 30120,
                internal: 30121,
            },
        )
        .await
        .expect("env kept");
        let state_dir = supervisor::env_state_dir(&state.config, "tear", "gone");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("deploy.json"), "{}").unwrap();

        // Only `refs/heads/gone` vanished; `kept` merely moved.
        on_refs_deleted(&state, &app, &[("refs/heads/gone").to_string()]).await;

        let survivors: Vec<String> = db::list_environments(&pool, &app.id)
            .await
            .unwrap()
            .into_iter()
            .map(|e| e.label)
            .collect();
        assert_eq!(survivors.len(), 2);
        assert!(survivors.contains(&"gone".to_string()));
        assert!(survivors.contains(&"kept".to_string()));
        assert!(!state_dir.exists());

        // Retry against a reachable (empty) listing: the row goes.
        let mut cfg2 = (*state.config).clone();
        cfg2.s3_endpoint = crate::testutil::spawn_s3_stub().await;
        let retry = crate::AppState {
            config: std::sync::Arc::new(cfg2),
            ..state.clone()
        };
        on_refs_deleted(&retry, &app, &[("refs/heads/gone").to_string()]).await;
        assert!(db::get_environment(&pool, &gone.id)
            .await
            .unwrap()
            .is_none());
        assert!(db::get_environment(&pool, &moved.id)
            .await
            .unwrap()
            .is_some());
        state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sweep that cannot read one app's manifest (corrupt durable state, a
    /// racing runner) logs and moves on: it must never abort the boot, and
    /// the marker stays unset so the next boot retries everything.
    #[tokio::test]
    async fn a_corrupt_manifest_never_aborts_the_boot_sweep() {
        let base = crate::testutil::TempDir::new("noite-env-corrupt");
        let dir = base.path().to_path_buf();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        cfg.routes_path = dir.join("routes.json").to_string_lossy().into_owned();
        let corrupt_key = crate::host::git_store::build_wal(&cfg).manifest_key("orphan");
        let (endpoint, seen) = crate::testutil::spawn_s3_stub_recording_corrupt(corrupt_key).await;
        cfg.s3_endpoint = endpoint;
        let state = crate::AppState {
            pool: pool.clone(),
            config: std::sync::Arc::new(cfg.clone()),
            procs: supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify: tokio::sync::watch::channel(0u64).0,
            wal: crate::host::git_store::build_wal(&cfg),
            tip_tx: crate::host::tips::channel().0,
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: std::sync::Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
            source_maps: Default::default(),
            control_boot: Default::default(),
        };
        for (slug, listen) in [("orphan", 30300i64), ("healthy", 30310i64)] {
            db::create_app(
                &pool,
                &state.config,
                db::NewApp {
                    name: slug,
                    slug,
                    user_id: "local",
                    subdomain: "localhost",
                    listen,
                    internal: listen + 1,
                },
            )
            .await
            .expect("app");
        }

        assert_eq!(
            retire_workspace_environments(&state)
                .await
                .expect("a corrupt manifest never aborts the boot"),
            0
        );
        assert_eq!(
            db::get_setting(&pool, RETIRED_PREVIEWS_SWEPT)
                .await
                .expect("setting"),
            None,
            "the marker stays unset so the next boot retries"
        );
        let lines = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(
            lines.iter().any(|line| line.contains("healthy")),
            "the healthy app is still swept: {lines:?}"
        );
        pool.close().await;
    }

    /// The boot step for an install that upgraded past the workspace
    /// previews: the row, its fleet, its local state and its bucket prefix
    /// all go, and the route table stops carrying its host, so the closed
    /// `EnvironmentKind` can read the table again.
    #[tokio::test]
    async fn retire_workspace_environments_tears_down_what_the_row_owns() {
        let base = crate::testutil::TempDir::new("noite-env-retire");
        let dir = base.path().to_path_buf();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let (endpoint, seen) = crate::testutil::spawn_s3_stub_recording().await;
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = endpoint;
        cfg.routes_path = dir.join("routes.json").to_string_lossy().into_owned();
        let state = crate::AppState {
            pool: pool.clone(),
            config: std::sync::Arc::new(cfg.clone()),
            procs: supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify: tokio::sync::watch::channel(0u64).0,
            wal: crate::host::git_store::build_wal(&cfg),
            tip_tx: crate::host::tips::channel().0,
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: std::sync::Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: std::sync::Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
            source_maps: Default::default(),
            control_boot: Default::default(),
        };
        let app = db::create_app(
            &pool,
            &state.config,
            db::NewApp {
                name: "tear",
                slug: "tear",
                user_id: "local",
                subdomain: "tear.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("app");
        // A second app with **no** workspace row: the old teardown removed
        // the row but left the hidden ref, so the sweep must visit it too.
        db::create_app(
            &pool,
            &state.config,
            db::NewApp {
                name: "orphan",
                slug: "orphan",
                user_id: "local",
                subdomain: "orphan.localhost",
                listen: 30200,
                internal: 30201,
            },
        )
        .await
        .expect("orphan app");
        let env_id = new_id();
        let ts = crate::models::now_iso();
        sqlx::query(
            r#"INSERT INTO environment (
                 id, app_id, label, kind, git_ref, created_by, fleet_bucket,
                 listen_port, internal_port, desired_state, created_at, updated_at
               ) VALUES (?, ?, 'wip', 'workspace', 'refs/previews/user/wip', 'user_1',
                         ?, 30110, 30111, 'running', ?, ?)"#,
        )
        .bind(&env_id)
        .bind(&app.id)
        .bind(cfg.envs_uri("tear", "wip"))
        .bind(&ts)
        .bind(&ts)
        .execute(&pool)
        .await
        .expect("workspace row");
        let state_dir = supervisor::env_state_dir(&state.config, "tear", "wip");
        std::fs::create_dir_all(&state_dir).expect("state dir");
        std::fs::write(state_dir.join("deploy.json"), "{}").expect("state file");
        // A fleet under the environment's key, as a live runner would hold it.
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .expect("fake fleet");
        state.procs.lock().await.insert(
            supervisor::env_fleet_key("tear", "wip"),
            supervisor::FleetEntry::test_entry(child),
        );

        assert_eq!(
            retire_workspace_environments(&state).await.expect("retire"),
            1
        );

        // The row is gone: a model read of the table works again.
        assert!(db::list_environments(&pool, &app.id)
            .await
            .expect("list")
            .is_empty());
        // Fleet stopped and forgotten, local state and bucket prefix wiped.
        assert!(
            state.procs.lock().await.is_empty(),
            "the fleet entry is gone"
        );
        assert!(!state_dir.exists());
        // The ref sweep ran once for the whole install, including an app with
        // no workspace row, and marked itself done.
        assert_eq!(
            db::get_setting(&pool, RETIRED_PREVIEWS_SWEPT)
                .await
                .expect("setting"),
            Some("1".to_string())
        );
        let lines = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
        assert!(
            lines.iter().any(|line| line.contains("orphan")),
            "the sweep visits an app with no workspace row: {lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|line| line.contains("prefix=envs%2Ftear%2Fwip%2F")),
            "the purge listed envs/tear/wip/: {lines:?}"
        );

        // The boot step pushes the table after the teardown; the host is gone.
        crate::host::edge_table::push_routes(&state.pool, &state.config)
            .await
            .expect("push routes");
        let routes = std::fs::read_to_string(&state.config.routes_path).expect("routes file");
        assert!(!routes.contains("wip.tear.localhost"), "{routes}");

        // Idempotent: a later boot finds nothing to do.
        assert_eq!(
            retire_workspace_environments(&state).await.expect("retire"),
            0
        );
        pool.close().await;
    }
}
