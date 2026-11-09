//! The visible queue: an explicit deploy (a rollback, an environment's
//! redeploy) owns its row before the pipeline claims the app, so a watcher
//! sees "queued" instead of an empty history while another deploy runs. These
//! pin that contract and the sweep's leniency toward it.

use crate::api::tests::Harness;
use crate::models::DeployStatus;

/// Seed a deploy row the way callers do (the one writer in production too).
async fn seed(h: &Harness, app_id: &str, status: DeployStatus, sha: &str) -> String {
    crate::db::upsert_deploy(
        &h.state.pool,
        None,
        app_id,
        None,
        status.as_str(),
        Some(sha),
        "▸ seed\n",
    )
    .await
    .expect("seed deploy")
}

/// One row's current status.
async fn status_of(h: &Harness, app_id: &str, deploy_id: &str) -> String {
    crate::db::get_deploy(&h.state.pool, app_id, deploy_id)
        .await
        .expect("read deploy")
        .expect("row")
        .status
}

#[tokio::test]
async fn a_rollback_row_is_queued_before_its_run_starts() {
    let h = Harness::new().await;
    let app = h.seed_app("queued-rollback").await;
    let sha = "abc1234";
    seed(&h, &app.id, DeployStatus::Success, sha).await;

    let prepared = crate::service::deploys::prepare_rollback(&h.state, &app.id, sha)
        .await
        .expect("prepare rollback");

    let row = crate::db::get_deploy(&h.state.pool, &app.id, &prepared.deploy_id)
        .await
        .expect("read deploy")
        .expect("deploy row");
    assert_eq!(row.status, "queued");
    assert_eq!(row.sha.as_deref(), Some(sha));

    h.finish().await;
}

#[tokio::test]
async fn the_sweep_spares_a_queued_row_twice_as_long_as_a_building_one() {
    let h = Harness::new().await;
    let app = h.seed_app("queued-sweep").await;
    let queued = seed(&h, &app.id, DeployStatus::Queued, "aaa1111").await;
    let building = seed(&h, &app.id, DeployStatus::Building, "bbb2222").await;

    // Both rows stopped moving 1.5 s ago; the sweep's bound is 1 s.
    let stale = (chrono::Utc::now() - chrono::Duration::milliseconds(1500))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for id in [&queued, &building] {
        sqlx::query("UPDATE deploy SET updated_at = ? WHERE id = ?")
            .bind(&stale)
            .bind(id)
            .execute(&h.state.pool)
            .await
            .expect("age the row");
    }

    let skipped = std::collections::HashSet::new();
    let swept = crate::db::fail_stuck_deploys(&h.state.pool, 1000, &skipped)
        .await
        .expect("sweep");
    assert_eq!(swept, 1, "only the building row is past its bound");

    assert_eq!(status_of(&h, &app.id, &queued).await, "queued");
    assert_eq!(status_of(&h, &app.id, &building).await, "failed");

    // Past twice the bound the queue is dead too (the runner restarted
    // before its waiter could close it).
    let dead = (chrono::Utc::now() - chrono::Duration::milliseconds(3000))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("UPDATE deploy SET updated_at = ? WHERE id = ?")
        .bind(&dead)
        .bind(&queued)
        .execute(&h.state.pool)
        .await
        .expect("age the queued row");
    let swept = crate::db::fail_stuck_deploys(&h.state.pool, 1000, &skipped)
        .await
        .expect("sweep");
    assert_eq!(swept, 1);

    h.finish().await;
}
