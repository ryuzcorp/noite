//! App CRUD + health/readiness (thin adapters over `service::apps`).
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::api::sse::poll_stream;
use crate::config::Tenancy;
use crate::db;
use crate::models::{AppStateFrame, CreateApp, PatchApp, RenameApp};
use crate::service;
use crate::AppState;
use crate::{Readiness, ReadyFailure};

/// Live cgroup contribution to `/ready`: a failed fleet limit trips
/// install-wide containment after boot, so `multi` refuses exactly like a
/// boot-time failure while `single` keeps warning.
fn cgroup_readiness(tenancy: &Tenancy, active: bool, detail: &str) -> Option<ReadyFailure> {
    (!active && *tenancy == Tenancy::Multi).then(|| ReadyFailure::Cgroups(detail.to_string()))
}

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    // Busy when a deploy holds the runner: the control DO extends its idle
    // window on this flag so long builds never sleep mid-flight.
    let busy = !crate::host::deploy::snapshot_claimed(&state.deploying)
        .await
        .is_empty();
    Json(json!({ "busy": busy, "ok": true, "service": "noite-runner" }))
}

/// Readiness for the edge (SPEC, Readiness): 200 only when all hold —
/// first reconcile pass, bucket reachable (head-bucket cached 5 s),
/// multi-tenancy isolation checks passed, the control fleet healthy, Caddy's
/// last config load accepted. Body names the failing ones so one healthcheck
/// fits Compose, Railway, Coolify and Fly.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let reconciled = state.ready.load(std::sync::atomic::Ordering::Relaxed);
    let mut failures: Vec<ReadyFailure> = Vec::new();
    // Bucket reachable (HEAD on runner/state/, 2 s timeout, cached 5 s).
    {
        let now = std::time::Instant::now();
        let (ok, detail, at) = state.bucket_ok.read().await.clone();
        if now.duration_since(at).as_secs() >= 5 || !ok {
            // One head-bucket per 5 s: it errors only on transport/auth, which
            // is exactly "unreachable".
            let reachable = bucket_reachable(&state.config).await;
            *state.bucket_ok.write().await = (reachable.0, reachable.1.clone(), now);
            if !reachable.0 {
                failures.push(ReadyFailure::Bucket(reachable.1));
            }
        } else if !ok {
            failures.push(ReadyFailure::Bucket(detail));
        }
    }
    // Isolation first, in the pre-machine order of the `failing` array; the
    // state itself is terminal when it trips.
    {
        let iso = state.isolation.read().await;
        // The live probe, not the boot snapshot: a capability that failed
        // after boot blocks here exactly like a boot-time failure. Only a
        // `multi` install blocks (single runs the checks and warns).
        let iso_failures = iso.failures();
        if iso.tenancy == "multi" && !iso_failures.is_empty() {
            failures.push(ReadyFailure::Isolation(iso_failures.join("; ")));
        }
    }
    // Per-fleet cgroups (SPEC, Tenant isolation): the live status, not the
    // boot snapshot — a fleet limit refused after boot trips install-wide
    // containment, and `multi` refuses exactly like a boot-time failure
    // while `single` keeps warning. Reported on both answers so
    // `make doctor` and the e2e lane can assert containment is live, not
    // just "not failing".
    let (cgroups_active, cgroups_detail) = crate::host::cgroups::status();
    if let Some(failure) = cgroup_readiness(&state.config.tenancy, cgroups_active, &cgroups_detail)
    {
        failures.push(failure);
    }
    // Control fleet #0 (absent in the dev image, where vite dev serves it).
    if std::path::Path::new(&state.config.control_bundle_dir).exists() {
        // One client for every probe: Docker calls this every 10 s, and a
        // fresh pool per call was pure allocation.
        static CONTROL_HEALTH: std::sync::LazyLock<reqwest::Client> =
            std::sync::LazyLock::new(|| {
                reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap_or_default()
            });
        let healthy = CONTROL_HEALTH
            .get("http://127.0.0.1:8090/.well-known/celld/health")
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        if !healthy {
            let cause = state
                .control_boot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let detail = match cause {
                Some(reason) => format!("fleet not healthy yet ({reason})"),
                None => "fleet not healthy yet".into(),
            };
            failures.push(ReadyFailure::Control(detail));
        }
    }
    {
        let (ok, detail) = crate::host::caddy::admin_status();
        if !ok {
            failures.push(ReadyFailure::Caddy(detail));
        }
    }
    let readiness = Readiness::resolve(reconciled, failures);
    let failing = readiness.failing();
    let credentials = state.isolation.read().await.credentials.clone();
    let snapshot = state.state_sync.snapshot_status();
    let credential_sweep = crate::host::credentials::orphan_sweep_status();
    // Sandbox plane: informational only, never fails the gate.
    let sandbox = crate::host::sandbox::plane::sandbox_status(state.config.sandbox_disabled);
    let body = json!({ "ok": failing.is_empty(), "service": "noite-runner",
        "cgroups": { "active": cgroups_active, "detail": cgroups_detail },
        "credentials": credentials,
        "credential_sweep": credential_sweep,
        "snapshot": snapshot,
        "sandbox": sandbox,
        // Informational: never fails the gate, but an operator reading
        // `make doctor` sees the charge and how close it is to the limit.
        "memory": crate::host::memory::usage().unwrap_or(serde_json::Value::Null),
        // The capped build leaf: a null here means cgroups were unavailable
        // and builds are uncapped, which `cgroups.detail` already explains.
        "build": crate::host::cgroups::build_status(),
        "failing": failing });
    if readiness.ok() {
        Json(body).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response()
    }
}

async fn bucket_reachable(cfg: &crate::config::Config) -> (bool, String) {
    // One head-bucket per 5 s (cached by the caller): false only on
    // transport/auth failure, which is exactly "unreachable".
    if crate::host::s3::s3_head_bucket(cfg).await {
        (true, String::new())
    } else {
        (false, format!("head-bucket {} unreachable", cfg.s3_bucket))
    }
}

pub async fn list_apps(State(state): State<AppState>) -> impl IntoResponse {
    service::apps::list(&state).await.map(Json)
}

pub async fn create_app(
    State(state): State<AppState>,
    Json(body): Json<CreateApp>,
) -> impl IntoResponse {
    service::apps::create(
        &state,
        &body.name,
        &body.slug,
        body.user_id.as_deref(),
        body.source.as_ref(),
    )
    .await
    .map(|app| (StatusCode::CREATED, Json(app)))
}

/// Retry a failed import (A2) with the source the app was created from.
pub async fn retry_import(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::apps::retry_import(&state, &id).await.map(Json)
}

pub async fn get_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    service::apps::get(&state, &id).await.map(Json)
}

pub async fn patch_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchApp>,
) -> impl IntoResponse {
    service::apps::patch(&state, &id, body.desired_state.as_deref())
        .await
        .map(Json)
}

pub async fn rename_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameApp>,
) -> impl IntoResponse {
    service::apps::rename(&state, &id, body.name.as_deref(), body.slug.as_deref())
        .await
        .map(Json)
}

pub async fn delete_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // 204 once the purge finished; 202 while it still runs in the
    // background (the app is already gone from every listing).
    service::apps::delete(&state, &id)
        .await
        .map(|deletion| match deletion {
            service::apps::Deletion::Done => StatusCode::NO_CONTENT.into_response(),
            service::apps::Deletion::InProgress => {
                (StatusCode::ACCEPTED, Json(json!({ "deleting": true }))).into_response()
            }
        })
}

/// Park an app now (SPEC, Scale to zero), skipping the idle check — the
/// operator's lever, and how tests exercise wake-on-request without waiting
/// out the idle threshold. 409 when the app cannot sleep (stopped,
/// undeployed, already asleep, or not running yet).
pub async fn sleep_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match service::apps::sleep(&state, &id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true, "asleep": true }))).into_response(),
        Ok(false) => crate::api_error::ApiError::conflict(
            "app cannot sleep (stopped, undeployed, already asleep or not running)",
        )
        .into_response(),
        Err(e) => e.into_response(),
    }
}

/// The app's row and its environments as server-sent events, one
/// `AppStateFrame` per message, sent only when either changed (plus
/// keep-alive comments). Every status badge on the control UI's app pages
/// follows it, so a deploy, a stop or a sleep shows everywhere at once.
pub async fn app_state_stream(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let app = match service::apps::app_or_404(&state, &id).await {
        Ok(app) => app,
        Err(e) => return e.into_response(),
    };
    let pool = state.pool.clone();
    let procs = state.procs.clone();
    let app_id = app.id;
    poll_stream("state", Duration::from_secs(2), move || {
        let pool = pool.clone();
        let procs = procs.clone();
        let app_id = app_id.clone();
        async move { state_frame(&pool, &procs, &app_id).await }
    })
}

/// One `AppStateFrame`, serialized, with every derived field filled: the
/// fleet hold and the automatic-deploy budget (the same annotations REST and
/// RPC serve, so a frame never reports `eligible` while a deploy is paused).
/// `None` when the app row is gone or the snapshot failed; the page that
/// holds the stream navigates away or keeps the previous frame.
async fn state_frame(
    pool: &sqlx::SqlitePool,
    procs: &crate::host::supervisor::ProcMap,
    app_id: &str,
) -> Option<String> {
    let mut app = match db::get_app(pool, app_id).await {
        Ok(Some(app)) => app,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!(error = %e, "state stream: skipping failed snapshot");
            return None;
        }
    };
    // The frame carries the hold too, so a badge that flips to
    // "crashed, retrying" no longer waits for a refetch.
    crate::host::supervisor::annotate_holds(procs, std::slice::from_mut(&mut app)).await;
    let mut environments = match db::list_environments(pool, app_id).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "state stream: skipping failed snapshot");
            return None;
        }
    };
    crate::host::auto_deploy::annotate_frame(pool, &mut app, &mut environments).await;
    match serde_json::to_string(&AppStateFrame { app, environments }) {
        Ok(json) => Some(json),
        Err(e) => {
            tracing::warn!(error = %e, "state stream: dropping unserializable snapshot");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The state stream feeds every live badge and the Deployments pause line:
    /// a frame built without the automatic-deploy annotation reported
    /// `eligible` while the deploy history said the sha was paused.
    #[tokio::test]
    async fn a_state_frame_carries_the_auto_deploy_pause() {
        let h = crate::api::tests::Harness::new().await;
        let app = h.seed_app("paused-frame").await;
        for _ in 0..2 {
            crate::db::upsert_deploy(
                &h.state.pool,
                None,
                &app.id,
                None,
                crate::models::DeployStatus::Failed,
                Some("sha1"),
                "boom",
            )
            .await
            .expect("failed deploy");
        }

        let json = state_frame(&h.state.pool, &h.state.procs, &app.id)
            .await
            .expect("frame");
        let frame: serde_json::Value = serde_json::from_str(&json).expect("frame json");
        assert_eq!(
            frame["app"]["autoDeploy"],
            serde_json::json!({ "state": "exhausted", "sha": "sha1", "failures": 2 })
        );
        h.finish().await;
    }

    #[test]
    fn tripped_containment_blocks_multi_but_warns_single() {
        // A fleet limit refused after boot trips install-wide containment.
        crate::host::cgroups::note_limit_failed("fleet-a", "memory.max refused".into());
        let (active, detail) = crate::host::cgroups::status();
        assert!(!active, "tripped status is not active");
        assert!(
            cgroup_readiness(&Tenancy::Multi, active, &detail).is_some(),
            "multi refuses on a live trip"
        );
        assert!(
            cgroup_readiness(&Tenancy::Single, active, &detail).is_none(),
            "single keeps warning on a live trip"
        );
        assert!(
            cgroup_readiness(&Tenancy::Multi, true, "per-fleet cgroups under /x").is_none(),
            "multi stays ok while containment holds"
        );
    }

    #[test]
    fn readiness_keeps_the_failing_order_and_degrades_on_one_probe() {
        assert_eq!(
            crate::Readiness::resolve(true, Vec::new()).failing(),
            Vec::<String>::new()
        );
        assert!(crate::Readiness::resolve(true, Vec::new()).ok());
        // A boot still names the first reconcile pass.
        let starting = crate::Readiness::resolve(false, Vec::new());
        assert_eq!(starting.failing(), vec!["reconcile".to_string()]);
        // Probe failures keep the pre-machine order: reconcile, bucket,
        // isolation, then the rest.
        let readiness = crate::Readiness::resolve(
            false,
            vec![
                crate::ReadyFailure::Bucket("head-bucket b unreachable".into()),
                crate::ReadyFailure::Isolation("cgroups unavailable".into()),
                crate::ReadyFailure::Caddy("load refused".into()),
            ],
        );
        assert!(!readiness.ok());
        assert_eq!(
            readiness.failing(),
            vec![
                "reconcile".to_string(),
                "bucket: head-bucket b unreachable".to_string(),
                "isolation: cgroups unavailable".to_string(),
                "caddy: load refused".to_string(),
            ]
        );
        assert!(matches!(readiness, crate::Readiness::Blocked { .. }));
        assert!(matches!(
            crate::Readiness::resolve(true, vec![crate::ReadyFailure::Reconcile]),
            crate::Readiness::Degraded { .. }
        ));
    }
}
