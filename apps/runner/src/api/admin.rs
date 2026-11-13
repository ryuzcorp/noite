//! Operator endpoints: the ones `make backup` and `make doctor` use. Bearer
//! gated like the rest of `/v1` (the auth middleware on the router covers
//! them), and deliberately thin — a snapshot is a `VACUUM INTO` beside the
//! live database, which the volume tar in `docker/backup.sh` then picks up.
use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;

use crate::api_error::ApiError;
use crate::db;
use crate::AppState;

/// Write a consistent copy of the runner SQLite (`VACUUM INTO`) and report it.
/// Overwrites the previous copy. Also uploads to the bucket (SPEC, Runner state) so the
/// trigger doubles as "flush state now" — `make backup` becomes bucket
/// versioning + copy.
pub async fn snapshot(State(state): State<AppState>) -> impl IntoResponse {
    let path = db::snapshot_path(&state.config);
    if let Some(parent) = path.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return ApiError::internal(format!("snapshot setup failed: {e:#}")).into_response();
        }
    }
    // A missing previous copy is the normal first-run case; any other
    // removal failure must surface now, not late as a confusing vacuum
    // error.
    if let Err(e) = tokio::fs::remove_file(&path).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            return ApiError::internal(format!("snapshot setup failed: {e:#}")).into_response();
        }
    }
    // Path is ours (derived from the configured database location), and the
    // escaping keeps a quote in it from ending the literal.
    let Some(target) = path.to_str() else {
        return ApiError::internal("snapshot path is not valid UTF-8").into_response();
    };
    let sql = format!("VACUUM INTO '{}'", target.replace('\'', "''"));
    if let Err(e) = sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(&state.pool)
        .await
    {
        return ApiError::internal(format!("vacuum failed: {e}")).into_response();
    }
    let bytes = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    tracing::info!(path = %path.display(), bytes, "runner db snapshot written");
    // Bucket upload (best-effort surfaced in the response, not a failure:
    // the local file is what `backup.sh` tars today).
    let uploaded = state
        .state_sync
        .snapshot_now(&state.pool, &state.config)
        .await
        .ok();
    Json(json!({ "bytes": bytes, "ok": true, "path": target, "bucket_bytes": uploaded }))
        .into_response()
}

/// Process-wide cost counters (spec T0.1): subprocess spawns by program, S3
/// operations by verb with bytes, snapshot uploads,
/// live SSE loops, plus RSS and CPU time. `make usage` diffs this over a
/// window for the before/after harness. Also carries `control_fleet`: whether
/// this image supervises the control fleet at all (the dev image does not —
/// `vite dev` serves the UI — so the control app has no telemetry and says so
/// instead of showing empty charts, see `host::control::bundle_present`).
pub async fn stats(State(state): State<AppState>) -> impl IntoResponse {
    let mut value = crate::host::stats::snapshot();
    let fleet_memory: serde_json::Map<String, serde_json::Value> = {
        let keys: Vec<String> = state.procs.lock().await.keys().cloned().collect();
        keys.into_iter()
            .filter_map(|key| {
                crate::host::cgroups::fleet_usage_bytes(&key)
                    .map(|bytes| (key, serde_json::Value::from(bytes)))
            })
            .collect()
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "control_fleet".to_string(),
            serde_json::Value::Bool(crate::host::control::bundle_present(&state.config)),
        );
        // Container charge vs its limit (the host when unbounded), plus each
        // resident fleet's cgroup charge where the install has leaves. This is
        // what tells an operator whether the box is near the OOM line and
        // which fleet holds it.
        obj.insert(
            "memory".to_string(),
            crate::host::memory::usage().unwrap_or(serde_json::Value::Null),
        );
        obj.insert(
            "fleet_memory".to_string(),
            serde_json::Value::Object(fleet_memory),
        );
    }
    Json(value).into_response()
}
