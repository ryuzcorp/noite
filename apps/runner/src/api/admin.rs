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
/// Overwrites the previous copy: the file lives in the data volume, so a stale
/// one would be tarred silently.
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
    Json(json!({ "bytes": bytes, "ok": true, "path": target })).into_response()
}
