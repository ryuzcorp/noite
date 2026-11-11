//! The automatic-deploy budget: how the runner decides whether it may still
//! deploy a target's git tip on its own.
//!
//! Owner rule (2026-11-10): after **two consecutive failed deploys of the same
//! target (app or environment) at the same sha**, automatic deploys of that
//! sha stop. A new sha (push) or an explicit deploy (Deploy/Redeploy/Rollback
//! from the UI, the CLI or MCP — also how a build-affecting settings change
//! lands) resets it. The state is [`crate::models::AutoDeploy`], whose doc
//! carries the full transition diagram; this module owns the one transition
//! function
//! ([`step`]), the fold over the persisted rows ([`evaluate`]) and the query
//! that feeds it ([`for_target`]).
//!
//! The rows are the source of truth (`db::auto_deploy_rows`), so the state
//! survives a restart and no new column exists. `failed` and `stalled` rows
//! count as failures; a `cancelled` row is an operator stop — it never counts
//! as a failure, but it blocks automatic retries of that sha until a new sha
//! or an explicit action.
//!
//! Transition table (one row per input, from any state unless noted):
//!
//! | row | next |
//! | --- | --- |
//! | `success` | `Eligible` |
//! | any in-flight (`queued`/`building`/`deploying`) | `Eligible` |
//! | `cancelled` with a sha | `Stopped { sha }` |
//! | explicit (`rollback`/`redeploy`) `failed`/`stalled` | `Eligible` |
//! | automatic `failed`/`stalled`, other sha | `Failing { sha, 1 }` |
//! | automatic `failed`/`stalled`, same sha as `Failing`/`Exhausted` | one more failure (cap → `Exhausted`) |
use sqlx::SqlitePool;

use crate::db;
use crate::models::{App, AutoDeploy, DeployIntent, DeployStatus, Environment};

/// One persisted deploy row's contribution to the machine: the three columns
/// the rule reads, never the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub sha: Option<String>,
    pub status: DeployStatus,
    pub intent: DeployIntent,
}

impl Outcome {
    fn new((sha, status, intent): (Option<String>, DeployStatus, DeployIntent)) -> Self {
        Self {
            sha,
            status,
            intent,
        }
    }
}

/// The one transition: apply one deploy row (oldest first) to the machine.
pub fn step(state: AutoDeploy, row: &Outcome) -> AutoDeploy {
    match row.status {
        DeployStatus::Queued | DeployStatus::Building | DeployStatus::Deploying => {
            AutoDeploy::Eligible
        }
        DeployStatus::Success => AutoDeploy::Eligible,
        // A stop is the operator's word: never a failure, and never a prompt
        // for the sweep to try the same sha again.
        DeployStatus::Cancelled => match &row.sha {
            Some(sha) => AutoDeploy::Stopped { sha: sha.clone() },
            None => state,
        },
        DeployStatus::Failed | DeployStatus::Stalled => {
            // A manual run resets the budget: the operator asked for it, and
            // its own failure is not the runner retrying on its own.
            if row.intent.is_explicit() {
                return AutoDeploy::Eligible;
            }
            let Some(sha) = &row.sha else {
                return AutoDeploy::Eligible;
            };
            let failures = match &state {
                AutoDeploy::Failing {
                    sha: blocked,
                    failures,
                }
                | AutoDeploy::Exhausted {
                    sha: blocked,
                    failures,
                } if crate::lifecycle::sha_same(blocked, sha) => failures.saturating_add(1),
                _ => 1,
            };
            if failures >= AutoDeploy::FAILURE_CAP {
                AutoDeploy::Exhausted {
                    sha: sha.clone(),
                    failures,
                }
            } else {
                AutoDeploy::Failing {
                    sha: sha.clone(),
                    failures,
                }
            }
        }
    }
}

/// Fold the target's deploy rows, oldest first, into its automatic-deploy
/// state.
pub fn evaluate(rows: impl IntoIterator<Item = Outcome>) -> AutoDeploy {
    rows.into_iter()
        .fold(AutoDeploy::Eligible, |state, row| step(state, &row))
}

/// The target's current state: `environment_id = None` is production.
pub async fn for_target(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> sqlx::Result<AutoDeploy> {
    // The query answers newest first; the machine folds oldest first.
    let rows = db::auto_deploy_rows(pool, app_id, environment_id)
        .await?
        .into_iter()
        .map(Outcome::new)
        .rev();
    Ok(evaluate(rows))
}

/// Fill each app's production state, one bounded query per app, all in flight
/// at once: `apps.list` annotates every row on a page load, and a serial loop
/// made that one round-trip per app.
pub async fn annotate_apps(pool: &SqlitePool, apps: &mut [App]) {
    let states =
        futures::future::join_all(apps.iter().map(|app| for_target(pool, &app.id, None))).await;
    for (app, state) in apps.iter_mut().zip(states) {
        fill(&mut app.auto_deploy, state, &app.id);
    }
}

/// Fill each environment's own state; a preview's budget is its own.
pub async fn annotate_environments(pool: &SqlitePool, envs: &mut [Environment]) {
    let states = futures::future::join_all(
        envs.iter()
            .map(|env| for_target(pool, &env.app_id, Some(&env.id))),
    )
    .await;
    for (env, state) in envs.iter_mut().zip(states) {
        fill(&mut env.auto_deploy, state, &env.id);
    }
}

/// Fill one `AppStateFrame`'s app and environments (the SSE path): the frame
/// is rebuilt every two seconds, so the targets are read concurrently.
pub async fn annotate_frame(pool: &SqlitePool, app: &mut App, envs: &mut [Environment]) {
    let states = futures::future::join_all(
        std::iter::once(for_target(pool, &app.id, None)).chain(
            envs.iter()
                .map(|env| for_target(pool, &env.app_id, Some(&env.id))),
        ),
    )
    .await;
    let mut states = states.into_iter();
    if let Some(state) = states.next() {
        fill(&mut app.auto_deploy, state, &app.id);
    }
    for (env, state) in envs.iter_mut().zip(states) {
        fill(&mut env.auto_deploy, state, &env.id);
    }
}

/// A read failure must not hide the rest of the row (the automatic gate
/// re-reads the same rows before it deploys anything).
fn fill(state: &mut AutoDeploy, read: sqlx::Result<AutoDeploy>, target: &str) {
    match read {
        Ok(auto) => *state = auto,
        Err(e) => tracing::warn!(target = %target, error = %e, "auto deploy state"),
    }
}

/// Note the targets the stall sweep just closed: a stalled row counts as a
/// failure, so two stalls can spend the budget without `Progress::fail` ever
/// running (the host was interrupted).
pub async fn note_stalled(pool: &SqlitePool, targets: &[db::StalledDeploy]) {
    for target in targets {
        note_exhausted(pool, &target.app_id, target.environment_id.as_deref()).await;
    }
}

/// Record the tenant-visible `deploy` event at the moment the budget runs out:
/// the target reads `Exhausted`. Best effort — a lost event never changes the
/// deploy's own outcome, and the notice is emitted once per sha (the sweep can
/// close several dead rows of one target in a single pass, and a later failure
/// keeps the same exhausted state).
pub async fn note_exhausted(pool: &SqlitePool, app_id: &str, environment_id: Option<&str>) {
    let Ok(AutoDeploy::Exhausted { sha, failures }) =
        for_target(pool, app_id, environment_id).await
    else {
        return;
    };
    if failures < AutoDeploy::FAILURE_CAP {
        return;
    }
    let short = &sha[..12.min(sha.len())];
    let marker = format!("of {short};");
    if let Ok(events) = db::list_app_events(pool, app_id, Some("deploy"), 50).await {
        if events
            .iter()
            .any(|event| event.event == "auto deploy paused" && event.description.contains(&marker))
        {
            return;
        }
    }
    let detail = format!(
        "automatic deploys are paused after {failures} failed attempts of {short}; \
         push a fix or deploy manually"
    );
    let _ = db::insert_app_event(
        pool,
        &crate::models::new_id(),
        app_id,
        "deploy",
        "auto deploy paused",
        &detail,
        "⏸️",
        "{}",
        "",
        &crate::models::now_iso(),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(sha: &str, status: DeployStatus, intent: DeployIntent) -> Outcome {
        Outcome {
            sha: Some(sha.to_string()),
            status,
            intent,
        }
    }

    fn automatic(sha: &str, status: DeployStatus) -> Outcome {
        row(sha, status, DeployIntent::Deploy)
    }

    /// The cap: the second consecutive automatic failure of one sha pauses
    /// automatic deploys of that sha.
    #[test]
    fn two_consecutive_failures_exhaust_the_sha() {
        let state = evaluate([
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Stalled),
        ]);
        assert_eq!(
            state,
            AutoDeploy::Exhausted {
                sha: "sha1".into(),
                failures: 2,
            }
        );
        assert!(state.blocks("sha1"));
        assert!(!state.blocks("sha2"), "a new sha is a new budget");
    }

    /// One failure is still retryable: the sweep gets its second attempt.
    #[test]
    fn one_failure_stays_eligible() {
        let state = evaluate([automatic("sha1", DeployStatus::Failed)]);
        assert_eq!(
            state,
            AutoDeploy::Failing {
                sha: "sha1".into(),
                failures: 1,
            }
        );
        assert!(!state.blocks("sha1"));
    }

    /// A success resets the budget.
    #[test]
    fn a_success_resets_the_budget() {
        let state = evaluate([
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Success),
        ]);
        assert_eq!(state, AutoDeploy::Eligible);
        assert!(!state.blocks("sha1"));
    }

    /// A new sha starts its own count; the old sha's streak does not carry.
    #[test]
    fn a_new_sha_starts_over() {
        let state = evaluate([
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Failed),
            automatic("sha2", DeployStatus::Failed),
        ]);
        assert_eq!(
            state,
            AutoDeploy::Failing {
                sha: "sha2".into(),
                failures: 1,
            }
        );
        assert!(!state.blocks("sha2"));
        assert!(!state.blocks("sha1"), "the old sha's block is gone");
    }

    /// A cancel is a user stop: it never adds a failure and it blocks the
    /// automatic retry of that sha.
    #[test]
    fn a_cancel_blocks_without_counting() {
        let state = evaluate([
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Cancelled),
        ]);
        assert_eq!(state, AutoDeploy::Stopped { sha: "sha1".into() });
        assert!(state.blocks("sha1"));
    }

    /// An explicit rollback/redeploy row resets the streak: the operator's
    /// own run is not the runner retrying, so the next automatic attempt is
    /// allowed again.
    #[test]
    fn an_explicit_row_resets_the_budget() {
        let state = evaluate([
            automatic("sha1", DeployStatus::Failed),
            automatic("sha1", DeployStatus::Failed),
            row("sha1", DeployStatus::Failed, DeployIntent::Rollback),
        ]);
        assert_eq!(state, AutoDeploy::Eligible);
        assert!(!state.blocks("sha1"));
    }

    /// The state lives in the deploy rows, not in memory: it survives a
    /// runner restart (a fresh pool over the same database).
    #[tokio::test]
    async fn the_pause_survives_a_restart() {
        let dir =
            std::env::temp_dir().join(format!("noite-auto-deploy-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let cfg = crate::config::config_for_tests();
        let app = {
            let pool = db::connect(&url).await.expect("first boot");
            let app = db::create_app(
                &pool,
                &cfg,
                db::NewApp {
                    name: "restart",
                    slug: "restart",
                    user_id: "local",
                    subdomain: "restart.localhost",
                    listen: 30370,
                    internal: 30371,
                },
            )
            .await
            .expect("app");
            for _ in 0..2 {
                db::upsert_deploy(
                    &pool,
                    None,
                    &app.id,
                    None,
                    DeployStatus::Failed,
                    Some("sha1"),
                    "boom",
                )
                .await
                .expect("failed deploy");
            }
            pool.close().await;
            app
        };
        let pool = db::connect(&url).await.expect("reboot");
        let state = for_target(&pool, &app.id, None)
            .await
            .expect("auto deploy after restart");
        assert_eq!(
            state,
            AutoDeploy::Exhausted {
                sha: "sha1".into(),
                failures: 2,
            }
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The pause is tenant-visible once: the event lands at the transition
    /// into the cap, and a later explicit-then-failed attempt (a third
    /// failure) does not repeat it.
    #[tokio::test]
    async fn the_cap_records_one_pause_event() {
        let cfg = crate::config::config_for_tests();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "event",
                slug: "event",
                user_id: "local",
                subdomain: "event.localhost",
                listen: 30380,
                internal: 30381,
            },
        )
        .await
        .expect("app");
        for _ in 0..2 {
            db::upsert_deploy(
                &pool,
                None,
                &app.id,
                None,
                DeployStatus::Failed,
                Some("sha1"),
                "boom",
            )
            .await
            .expect("failed deploy");
        }
        note_exhausted(&pool, &app.id, None).await;
        db::upsert_deploy(
            &pool,
            None,
            &app.id,
            None,
            DeployStatus::Failed,
            Some("sha1"),
            "boom",
        )
        .await
        .expect("third failure");
        note_exhausted(&pool, &app.id, None).await;

        let events = db::list_app_events(&pool, &app.id, Some("deploy"), 10)
            .await
            .expect("events");
        assert_eq!(events.len(), 1, "only the transition records an event");
        assert_eq!(events[0].event, "auto deploy paused");
        assert!(
            events[0].description.contains("sha1"),
            "{}",
            events[0].description
        );
        pool.close().await;
    }

    /// A stall spends the budget too: two stalled rows at one sha are
    /// `Exhausted`, and the host layer that runs the sweep records the same
    /// pause event a failed run does (the sweep itself only closes rows).
    #[tokio::test]
    async fn stalled_rows_spend_the_budget_and_record_the_pause() {
        let cfg = crate::config::config_for_tests();
        let pool = db::connect("sqlite::memory:").await.expect("memory db");
        let app = db::create_app(
            &pool,
            &cfg,
            db::NewApp {
                name: "stalled",
                slug: "stalled",
                user_id: "local",
                subdomain: "stalled.localhost",
                listen: 30390,
                internal: 30391,
            },
        )
        .await
        .expect("app");
        for _ in 0..2 {
            db::upsert_deploy(
                &pool,
                None,
                &app.id,
                None,
                DeployStatus::Building,
                Some("sha1"),
                "building",
            )
            .await
            .expect("running deploy");
        }
        // Past any bound the sweep uses: the runs are dead (a restart).
        sqlx::query("UPDATE deploy SET updated_at = '2026-01-01T00:00:00.000Z' WHERE app_id = ?")
            .bind(&app.id)
            .execute(&pool)
            .await
            .expect("age the rows");

        let stalled = db::fail_stuck_deploys(&pool, 1_000, &std::collections::HashSet::new())
            .await
            .expect("sweep");
        assert_eq!(stalled.len(), 2, "both dead rows are closed");
        note_stalled(&pool, &stalled).await;

        assert_eq!(
            for_target(&pool, &app.id, None).await.expect("state"),
            AutoDeploy::Exhausted {
                sha: "sha1".into(),
                failures: 2,
            }
        );
        let events = db::list_app_events(&pool, &app.id, Some("deploy"), 10)
            .await
            .expect("events");
        assert_eq!(events.len(), 1, "the stall path records the pause");
        assert_eq!(events[0].event, "auto deploy paused");
        pool.close().await;
    }

    /// A row with no sha cannot be attributed to a tip; it must never keep a
    /// stale block alive.
    #[test]
    fn a_failure_without_a_sha_does_not_block() {
        let state = step(
            AutoDeploy::Exhausted {
                sha: "sha1".into(),
                failures: 2,
            },
            &Outcome {
                sha: None,
                status: DeployStatus::Failed,
                intent: DeployIntent::Deploy,
            },
        );
        assert_eq!(state, AutoDeploy::Eligible);
    }
}
