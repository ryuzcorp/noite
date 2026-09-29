//! Operator endpoints: the ones `make backup` and `make doctor` use. Bearer
//! gated like the rest of `/v1` (the auth middleware on the router covers
//! them), and deliberately thin — a snapshot is a `VACUUM INTO` beside the
//! live database, which the volume tar in `docker/backup.sh` then picks up.
use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::AppState;

/// Write a consistent copy of the runner SQLite (`VACUUM INTO`) and report it.
/// Overwrites the previous copy. Also uploads to the bucket (SPEC, Runner state) so the
/// trigger doubles as "flush state now" — `make backup` becomes bucket
/// versioning + copy.
pub async fn snapshot(State(state): State<AppState>) -> impl IntoResponse {
    let path = db::snapshot_path(&state.config);
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let _ = tokio::fs::remove_file(&path).await;
    let Some(target) = path.to_str() else {
        return ApiError::internal("snapshot path is not valid UTF-8").into_response();
    };
    // Path is ours (derived from the configured database location), and the
    // escaping keeps a quote in it from ending the literal.
    let sql = format!("VACUUM INTO '{}'", target.replace('\'', "''"));
    if let Err(e) = sqlx::query(&sql).execute(&state.pool).await {
        return ApiError::internal(format!("vacuum failed: {e}")).into_response();
    }
    let bytes = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
    tracing::info!(path = %path.display(), bytes, "runner db snapshot written");
    // Bucket upload (best-effort surfaced in the response, not a failure:
    // the local file is what `backup.sh` tars today).
    let uploaded = state.state_sync.snapshot_now(&state.pool, &state.config).await.ok();
    Json(json!({ "bytes": bytes, "ok": true, "path": target, "bucket_bytes": uploaded })).into_response()
}

/// Process-wide cost counters (spec T0.1): subprocess spawns by program, S3
/// operations by verb with bytes, DuckDB runs by purpose, snapshot uploads,
/// live SSE loops, plus RSS and CPU time. `make usage` diffs this over a
/// window for the before/after harness.
pub async fn stats() -> impl IntoResponse {
    Json(crate::host::stats::snapshot()).into_response()
}
