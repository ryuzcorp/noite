//! The operator's stop, over both transports: a live run is signalled (its
//! token trips and the pipeline records its own failure), a row whose run is
//! gone — the runner restarted mid-build — is closed here, and a finished
//! deploy cannot be "stopped" a second time.

use axum::http::StatusCode;
use serde_json::json;

use super::tests::Harness;

/// Pre-create an in-flight deploy row, the way callers do before spawning the
/// pipeline (`upsert_deploy` is the one writer).
async fn seed_deploy(h: &Harness, app_id: &str, status: &str, sha: &str) -> String {
    crate::db::upsert_deploy(
        &h.state.pool,
        None,
        app_id,
        None,
        status,
        Some(sha),
        "▸ build: test\n",
    )
    .await
    .expect("seed deploy")
}

#[tokio::test]
async fn stopping_a_stranded_row_closes_it_with_the_operator_line() {
    let h = Harness::new().await;
    let app = h.seed_app("stopper").await;
    let deploy_id = seed_deploy(&h, &app.id, "building", "abc1234").await;

    let (status, body) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/{deploy_id}/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");

    let row = crate::db::get_deploy(&h.state.pool, &app.id, &deploy_id)
        .await
        .expect("read deploy")
        .expect("deploy row");
    assert_eq!(row.status, "failed");
    assert!(
        row.log.contains("ERROR: cancelled by the operator"),
        "{}",
        row.log
    );

    // Nothing is in flight any more: a second stop is a conflict, not a
    // second failure line.
    let (again, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/{deploy_id}/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(again, StatusCode::CONFLICT);

    h.finish().await;
}

#[tokio::test]
async fn stopping_a_live_run_signals_it_and_leaves_the_row_to_the_pipeline() {
    let h = Harness::new().await;
    let app = h.seed_app("live-stop").await;
    let deploy_id = seed_deploy(&h, &app.id, "deploying", "def5678").await;
    let token = crate::host::cancel::CANCELS.register(&deploy_id);

    let (status, body) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/{deploy_id}/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    assert!(token.is_cancelled(), "the live token must be tripped");

    // The pipeline writes the failure (it knows the step); the row is still
    // in flight until it does.
    let row = crate::db::get_deploy(&h.state.pool, &app.id, &deploy_id)
        .await
        .expect("read deploy")
        .expect("deploy row");
    assert_eq!(row.status, "deploying");

    // The RPC transport answers the same operation identically.
    let rpc = h
        .rpc(
            "deploys.cancel",
            json!({ "id": app.id, "deploy_id": deploy_id }),
        )
        .await;
    assert!(rpc.is_ok(), "{rpc:?}");

    crate::host::cancel::CANCELS.release(&deploy_id);
    h.finish().await;
}

#[tokio::test]
async fn stopping_answers_not_found_and_conflict_honestly() {
    let h = Harness::new().await;
    let app = h.seed_app("stop-errors").await;

    let (missing, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/does-not-exist/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(missing, StatusCode::NOT_FOUND);

    let done = seed_deploy(&h, &app.id, "success", "aaa1111").await;
    let (finished, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/{done}/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(finished, StatusCode::CONFLICT);

    // A deploy id of another app is that app's to stop, never this one's.
    let other = h.seed_app("other-stop").await;
    let theirs = seed_deploy(&h, &other.id, "building", "bbb2222").await;
    let (foreign, _) = h
        .rest(
            "POST",
            &format!("/v1/apps/{}/deploys/{theirs}/cancel", app.id),
            None,
        )
        .await;
    assert_eq!(foreign, StatusCode::NOT_FOUND);

    h.finish().await;
}
