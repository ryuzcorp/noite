//! Preview environment teardown: one place that stops an environment's fleet
//! and wipes everything it owns, plus the ref-driven path (a deleted branch
//! deletes its environment).
//!
//! Order matches `host::purge`: the fleet goes down first, so nothing rewrites
//! D1 / DO / telemetry into the prefix about to be emptied.
//!
//! The ref-driven wipe is queued, never awaited by the ref move: a fleet's
//! graceful stop plus the settle plus the S3 sweep is seconds of work, and a
//! push or merge request must not carry it (see [`on_refs_deleted`]).

use std::collections::HashMap;
use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::logs::LogState;
use crate::host::s3;
use crate::host::supervisor::{self, ProcMap};
use crate::models::{App, Environment, EnvironmentKind};

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
    // The environment's key is marked `revoking` and its row deleted as one
    // step under the mint fence (SPEC, Scoped credentials): a key must not
    // outlive its prefix, and a concurrent mint must see the row gone and
    // refuse. The store delete is the periodic sweep's (the `revoking` mark is
    // its durable retry). The app's own key is untouched. Only a failed mark
    // or row delete errors here; the boot retirement then keeps the row (and
    // `kind`) for the next boot instead of dropping the only retry.
    if let Err(e) = crate::host::credentials::delete_environment(pool, cfg, env.id).await {
        if strict_credentials {
            return Err(e).with_context(|| {
                format!(
                    "revoke the scoped credential of retired environment {}",
                    env.id
                )
            });
        }
        tracing::warn!(env_id = %env.id, error = %format!("{e:#}"), "environment deleted but credential revoke failed");
        // Parity with the old best-effort path: the wipe is done and the row
        // must not linger because a credential write failed.
        db::delete_environment_row(pool, env.id).await?;
    }
    // Its operator token goes too (row and process cache), so a reused
    // label mints fresh.
    if let Err(e) =
        crate::host::credentials::delete_operator_token(pool, &format!("env:{}", env.id)).await
    {
        tracing::warn!(env_id = %env.id, error = %e, "environment deleted but operator token row remains");
    }
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
///
/// The wipe runs in its own task, never in the ref move: the manifest flip and
/// the mirror update are already durable when this returns, while a teardown
/// stops a fleet (a SIGTERM drain), waits out the settle and sweeps an S3
/// prefix. Awaiting that held `prs.merge`'s `deleteBranch` publish open for
/// seconds — past the control plane's 5 s runner bound, whose abort then
/// dropped the half-done task (the fleet entry was already gone from the map,
/// so nothing finished the stop or removed the row).
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
        queue_teardown(state, app.id.clone(), env.id);
    }
}

/// Run one environment's wipe off the caller's task. Everything is keyed by
/// identifiers a later app generation can reuse (`(slug, label)`, the fleet
/// key, `envs/<slug>/<label>/`), so the task carries only immutable ids and
/// resolves the live row at wipe time (see [`teardown_env_by_id`]).
fn queue_teardown(state: &crate::AppState, app_id: String, env_id: String) {
    let state = state.clone();
    #[cfg(test)]
    let task = teardown_task(&env_id);
    tokio::spawn(async move {
        if let Err(e) = teardown_env_by_id(&state, &app_id, &env_id).await {
            tracing::warn!(env_id = %env_id, error = %format!("{e:#}"), "environment teardown failed");
        }
        #[cfg(test)]
        crate::service::detached::finished(&task).notify_one();
    });
}

/// Wipe one environment by its immutable id (and owning app id), for both the
/// queued ref-driven path and an explicit delete. Returns whether a row was
/// still there to wipe, so a second run — the admin delete racing the ref
/// move, or two queued tasks — is a clean no-op.
///
/// The row is re-read under the owning app's push guard, which this keeps for
/// the whole wipe: that serializes with `publish_refname`/`after_receive`,
/// `rename_slugged` and `purge_slug`, so a rename that landed while the task
/// waited is followed to the row's **current** slug and a purged slug cannot
/// hand its successor to a stale task. A gone row (purge, earlier teardown)
/// means the prefix is not ours. The join in `get_environment` returns `None`
/// once the app row is gone too, so a missing app stops the wipe as well.
///
/// No caller holds the slug guard yet: the request that queued this task is
/// already done, and a caller that does hold it (the ref move) spawns rather
/// than re-enters, so the guard is acquired exactly once.
pub async fn teardown_env_by_id(
    state: &crate::AppState,
    app_id: &str,
    env_id: &str,
) -> anyhow::Result<bool> {
    let Some((_push_guard, row)) = guarded_teardown_row(state, app_id, env_id).await? else {
        return Ok(false);
    };
    teardown(
        &state.config,
        &state.pool,
        &state.procs,
        &state.logs,
        (&row).into(),
        false,
    )
    .await?;
    Ok(true)
}

/// The row a teardown may wipe, read once for its slug and then re-read under
/// that slug's push guard. A rename's `lock_pair` holds the old and new slug
/// guards together while the task holds at most one, so following a rename
/// cannot deadlock with it.
async fn guarded_teardown_row(
    state: &crate::AppState,
    app_id: &str,
    env_id: &str,
) -> anyhow::Result<Option<(tokio::sync::OwnedMutexGuard<()>, Environment)>> {
    let Some(first) = db::get_environment(&state.pool, env_id).await? else {
        return Ok(None);
    };
    if first.app_id != app_id {
        return Ok(None);
    }
    let mut slug = first.app_slug;
    // A rename storm is not a reason to wipe the wrong app: give up (the row
    // stays, an explicit `environments.delete` still works) after a few moves.
    for _ in 0..3 {
        let guard = state.wal.lock(&slug).await;
        let Some(row) = db::get_environment(&state.pool, env_id).await? else {
            return Ok(None);
        };
        if row.app_id != app_id {
            return Ok(None);
        }
        if row.app_slug == slug {
            return Ok(Some((guard, row)));
        }
        // The row moved between the read and the guard: drop this guard and
        // take the new slug's, never both at once.
        slug = row.app_slug;
    }
    anyhow::bail!("the app kept being renamed during the queued teardown")
}

/// The test-only name of one queued teardown's completion signal.
#[cfg(test)]
fn teardown_task(env_id: &str) -> String {
    format!("env-teardown:{env_id}")
}

/// Fired once the queued teardown of `env` has finished, every effect
/// included (`notify_one` keeps a permit, so a test may wait after it ended).
#[cfg(test)]
pub(crate) fn teardown_finished(env: &Environment) -> std::sync::Arc<tokio::sync::Notify> {
    crate::service::detached::finished(&teardown_task(&env.id))
}

/// Boot sweep: tear down every branch environment whose ref is no longer in
/// its app's durable manifest. A runner crash or shutdown between the ref move
/// (the manifest flip is what makes the deletion durable) and the queued wipe
/// leaves the row behind, and the reconcile loop would respawn a fleet for a
/// branch that no longer exists — the mirror rehydrate cannot bring its ref
/// back, so it can never be served. Runs before the reconcile loop starts.
///
/// Non-fatal, like [`retire_workspace_environments`]: a manifest read failure
/// logs and skips that app (the row stays for the next boot), and a per-row
/// failure logs and continues. A repo without a manifest is skipped: there is
/// no durable ref state to contradict the row, so guessing would risk wiping a
/// live environment from a transient store error.
///
/// The manifest read is deliberately outside the slug guard because this runs
/// before the listener binds (and before the reconcile loop starts): nothing
/// can push, rename or create between the read and the wipe. Do not call it
/// from a live listener or the reconcile tick without re-checking the ref
/// under the guard.
pub async fn sweep_orphan_branch_environments(state: &crate::AppState) -> usize {
    let environments = match db::list_all_environments(&state.pool).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "orphan environment sweep: could not list environments");
            return 0;
        }
    };
    // One manifest read per app, issued concurrently: the store call has its
    // own 30 s timeout, and this runs before the listener binds, so a
    // degraded object store must not add that wait once per app.
    let wal = &state.wal;
    let mut slugs: Vec<&str> = environments
        .iter()
        .filter(|env| env.kind == EnvironmentKind::Branch)
        .map(|env| env.app_slug.as_str())
        .collect();
    slugs.sort_unstable();
    slugs.dedup();
    let reads = slugs
        .into_iter()
        .map(|slug| async move { (slug, wal.read_manifest(slug).await) });
    // `None` means "unknown, skip" (no manifest, or the read failed).
    let manifests: HashMap<String, Option<ryuz_git::RefsManifest>> =
        futures::future::join_all(reads)
            .await
            .into_iter()
            .map(|(slug, read)| match read {
                Ok(manifest) => (slug.to_string(), manifest),
                Err(e) => {
                    tracing::warn!(
                        slug,
                        error = %e,
                        "orphan environment sweep: could not read the manifest"
                    );
                    (slug.to_string(), None)
                }
            })
            .collect();
    let mut swept = 0;
    for env in environments
        .iter()
        .filter(|env| env.kind == EnvironmentKind::Branch)
    {
        let Some(manifest) = manifests.get(&env.app_slug).and_then(Option::as_ref) else {
            continue;
        };
        if manifest.refs.contains_key(&env.git_ref) {
            continue;
        }
        tracing::info!(
            slug = %env.app_slug,
            label = %env.label,
            ref = %env.git_ref,
            "environment ref is gone; removing its environment"
        );
        match teardown_env_by_id(state, &env.app_id, &env.id).await {
            Ok(true) => swept += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(
                env_id = %env.id,
                error = %format!("{e:#}"),
                "orphan environment teardown failed; leaving it for the next boot"
            ),
        }
    }
    swept
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
        let done = teardown_finished(&gone);
        on_refs_deleted(&state, &app, &[("refs/heads/gone").to_string()]).await;
        done.notified().await;

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
        let done = teardown_finished(&gone);
        on_refs_deleted(&retry, &app, &[("refs/heads/gone").to_string()]).await;
        done.notified().await;
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

    /// A state whose app is `tear`, with `s3_endpoint` as its object store.
    async fn ref_teardown_state(
        dir: &std::path::Path,
        s3_endpoint: &str,
    ) -> (crate::AppState, App) {
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = db::connect(&url).await.expect("boot");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        cfg.s3_endpoint = s3_endpoint.into();
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
        (state, app)
    }

    async fn ref_teardown_env(
        state: &crate::AppState,
        app: &App,
        label: &str,
        git_ref: &str,
        listen: i64,
    ) -> Environment {
        db::create_environment(
            &state.pool,
            &state.config,
            db::NewEnvironment {
                app_id: &app.id,
                slug: "tear",
                label,
                kind: EnvironmentKind::Branch,
                git_ref,
                created_by: "user_1",
                listen,
                internal: listen + 1,
            },
        )
        .await
        .expect("env")
    }

    /// The wipe must not hold the ref move: `prs.merge`'s `deleteBranch`
    /// publish awaited it, so a preview environment's graceful fleet stop
    /// (up to 15 s) pushed the merge past the control plane's 5 s runner
    /// bound and the abort dropped the half-done wipe.
    #[tokio::test]
    async fn ref_teardown_runs_off_the_ref_move() {
        let dir = std::env::temp_dir().join(format!("noite-env-queue-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (state, app) = ref_teardown_state(&dir, &crate::testutil::spawn_s3_stub().await).await;
        let env = ref_teardown_env(&state, &app, "gone", "refs/heads/gone", 30110).await;

        let done = teardown_finished(&env);
        on_refs_deleted(&state, &app, std::slice::from_ref(&env.git_ref)).await;

        // Still there: the wipe is its own task, behind the settle, so the
        // ref move returned without it. (Awaited, the row is already gone.)
        assert!(
            db::get_environment(&state.pool, &env.id)
                .await
                .unwrap()
                .is_some(),
            "the ref move must not wait for the environment wipe"
        );
        done.notified().await;
        assert!(db::get_environment(&state.pool, &env.id)
            .await
            .unwrap()
            .is_none());
        state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A queued wipe must never follow a reusable `(slug, label)` into a
    /// successor app: the ref move's push guard is released when it returns,
    /// so a purge can free the slug and a successor mint the same label before
    /// the task runs. The task re-takes that guard and re-reads its row by the
    /// immutable id first, so a gone row means the prefix is not its.
    #[tokio::test]
    async fn queued_teardown_never_wipes_a_successor_app() {
        let dir = std::env::temp_dir().join(format!("noite-env-successor-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (state, old_app) =
            ref_teardown_state(&dir, &crate::testutil::spawn_s3_stub().await).await;
        let old_env = ref_teardown_env(&state, &old_app, "gone", "refs/heads/gone", 30110).await;

        // Hold the guard the ref move held, so the queued task cannot start
        // until the purge and the successor are in place.
        let guard = state.wal.lock("tear").await;
        let done = teardown_finished(&old_env);
        on_refs_deleted(&state, &old_app, std::slice::from_ref(&old_env.git_ref)).await;

        // The purge cascades the old row away and frees the slug; a successor
        // takes it and mints the same branch label.
        db::delete_app(&state.pool, &old_app.id)
            .await
            .expect("purge app");
        let successor = db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: "tear again",
                slug: "tear",
                user_id: "local",
                subdomain: "tear.localhost",
                listen: 30100,
                internal: 30101,
            },
        )
        .await
        .expect("successor app");
        let successor_env =
            ref_teardown_env(&state, &successor, "gone", "refs/heads/gone", 30110).await;
        let successor_dir = supervisor::env_state_dir(&state.config, "tear", "gone");
        std::fs::create_dir_all(&successor_dir).expect("successor state dir");
        std::fs::write(successor_dir.join("deploy.json"), "{}").expect("successor state");

        drop(guard);
        done.notified().await;

        // The task found its row gone and left the successor's prefix alone.
        assert!(
            successor_dir.exists(),
            "the successor's state dir must survive the queued wipe"
        );
        assert!(db::get_environment(&state.pool, &successor_env.id)
            .await
            .unwrap()
            .is_some());
        assert!(db::get_environment(&state.pool, &old_env.id)
            .await
            .unwrap()
            .is_none());
        state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A rename that lands while the queued wipe waits must be followed: every
    /// name the wipe derives (state dir, fleet key, S3 prefix) comes from the
    /// row's **current** slug, never the snapshot taken at ref deletion.
    #[tokio::test]
    async fn queued_teardown_follows_a_rename() {
        let dir = std::env::temp_dir().join(format!("noite-env-rename-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (state, app) = ref_teardown_state(&dir, &crate::testutil::spawn_s3_stub().await).await;
        let env = ref_teardown_env(&state, &app, "gone", "refs/heads/gone", 30110).await;
        let old_dir = supervisor::env_state_dir(&state.config, "tear", "gone");
        let new_dir = supervisor::env_state_dir(&state.config, "tear-renamed", "gone");
        std::fs::create_dir_all(&old_dir).expect("old state dir");
        std::fs::create_dir_all(&new_dir).expect("new state dir");

        // Hold the old slug's guard exactly as the ref move did, so the task
        // cannot run until the rename is durable.
        let guard = state.wal.lock("tear").await;
        let done = teardown_finished(&env);
        on_refs_deleted(&state, &app, std::slice::from_ref(&env.git_ref)).await;
        db::rename_app(
            &state.pool,
            &app.id,
            &app.name,
            "tear-renamed",
            "tear-renamed.localhost",
            &app.git_prefix,
            &app.fleet_bucket,
        )
        .await
        .expect("rename app");
        drop(guard);
        done.notified().await;

        assert!(
            !new_dir.exists(),
            "the wipe must follow the row to the new slug"
        );
        assert!(
            old_dir.exists(),
            "the stale slug must never be touched after a rename"
        );
        assert!(db::get_environment(&state.pool, &env.id)
            .await
            .unwrap()
            .is_none());
        state.pool.clone().close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A crash between the ref move's manifest flip and the queued wipe leaves
    /// a row nobody will finish. The boot sweep must remove it (the reconcile
    /// loop would otherwise respawn a fleet for a deleted branch), and a
    /// second run must be a clean no-op.
    #[tokio::test]
    async fn boot_sweep_removes_branch_environments_whose_ref_is_gone() {
        let dir = std::env::temp_dir().join(format!("noite-env-orphan-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let (mut state, app) =
            ref_teardown_state(&dir, &crate::testutil::spawn_s3_stub().await).await;
        // An in-memory object store, so the manifest this test writes can be
        // read back (the shared S3 stub only answers listings and 404s).
        let store: ryuz_git::DynStore = std::sync::Arc::new(ryuz_git::MemoryStore::new());
        state.wal = ryuz_git::Wal::new(
            store,
            std::sync::Arc::new(ryuz_git::WalConfig::new(
                crate::host::exec::work_root(&state.config),
                ryuz_git::Layout::new("git"),
            )),
            std::sync::Arc::new(ryuz_git::RefsCodec),
        );
        let env = ref_teardown_env(&state, &app, "gone", "refs/heads/gone", 30110).await;
        let kept = ref_teardown_env(&state, &app, "kept", "refs/heads/kept", 30112).await;
        let env_dir = supervisor::env_state_dir(&state.config, "tear", "gone");
        std::fs::create_dir_all(&env_dir).expect("state dir");

        // The durable manifest no longer carries `gone` (the branch was
        // deleted) but still carries `kept`.
        let manifest = ryuz_git::RefsManifest {
            version: ryuz_git::MANIFEST_VERSION,
            refs: std::collections::BTreeMap::from([
                (
                    "refs/heads/main".to_string(),
                    ryuz_git::ManifestRef::pack("a".repeat(40)),
                ),
                (
                    "refs/heads/kept".to_string(),
                    ryuz_git::ManifestRef::pack("b".repeat(40)),
                ),
            ]),
            ..Default::default()
        };
        state
            .wal
            .write_manifest("tear", &manifest, ryuz_git::PutMode::Create)
            .await
            .expect("manifest");

        assert_eq!(sweep_orphan_branch_environments(&state).await, 1);
        assert!(!env_dir.exists());
        assert!(db::get_environment(&state.pool, &env.id)
            .await
            .unwrap()
            .is_none());
        assert!(
            db::get_environment(&state.pool, &kept.id)
                .await
                .unwrap()
                .is_some(),
            "an environment whose ref still exists must survive"
        );
        // F4: the same row gone means a repeat is a no-op, not an error.
        assert_eq!(sweep_orphan_branch_environments(&state).await, 0);
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

        // While the row survives (the teardown retries at the next boot), the
        // model reads skip it instead of failing on the retired kind.
        assert!(db::get_environment(&pool, &env_id)
            .await
            .expect("get")
            .is_none());
        assert!(db::list_environments(&pool, &app.id)
            .await
            .expect("list")
            .is_empty());
        assert!(db::list_all_environments(&pool)
            .await
            .expect("list all")
            .is_empty());
        assert!(
            db::get_environment_by_ref(&pool, &app.id, "refs/previews/user/wip")
                .await
                .expect("by ref")
                .is_none()
        );
        assert!(db::environment_route(&pool, "tear", "wip")
            .await
            .expect("route")
            .is_none());
        assert!(db::list_environment_routes(&pool)
            .await
            .expect("routes")
            .is_empty());

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
