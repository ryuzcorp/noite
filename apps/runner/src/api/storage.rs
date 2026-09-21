//! Tenant storage: inventory, D1 preview/write, DO, R2.
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::host::storage;
use crate::AppState;

#[derive(Deserialize)]
pub struct D1Query {
    /// Row limit per table (reuses `hours` query key from the UI for now).
    pub hours: Option<i64>,
}

#[derive(Deserialize)]
pub struct R2ObjectQuery {
    pub key: String,
}

pub async fn app_storage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::list_storage(&state.config, &app).await {
        Ok(items) => Json(items).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_d1(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Query(q): Query<D1Query>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let limit = (q.hours.unwrap_or(20) as usize).clamp(1, 100);
    match storage::d1_preview(&state.config, &app, &database_id, limit).await {
        Ok(p) => Json(p).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

/// Curated tenant-DB write body: single INSERT or UPDATE. Values are
/// column → text-or-null (null = SQL NULL); update keys the same shape.
#[derive(Deserialize)]
pub struct D1WriteBody {
    pub table: String,
    pub op: String,
    pub values: std::collections::BTreeMap<String, Option<String>>,
    pub key: Option<std::collections::BTreeMap<String, Option<String>>>,
}

pub async fn app_d1_write(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Json(body): Json<D1WriteBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let key = body.key.unwrap_or_default();
    match storage::d1_write(
        &state.config,
        &app,
        &database_id,
        &body.table,
        &body.op,
        &body.values,
        &key,
    )
    .await
    {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_do(
    State(state): State<AppState>,
    Path((id, class_name)): Path<(String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::do_instances(&state.config, &app, &class_name).await {
        Ok(p) => Json(p).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_r2(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::r2_list(&state.config, &app, &bucket, 100).await {
        Ok(p) => Json(p).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_r2_object(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::r2_get(&state.config, &app, &bucket, &q.key).await {
        Ok(p) => Json(p).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_r2_raw(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> Response {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let bytes = match storage::r2_raw(&state.config, &app, &bucket, &q.key).await {
        Ok(b) => b,
        Err(e) => return ApiError::conflict(format!("{e:#}")).into_response(),
    };
    let filename = q.key.rsplit('/').next().unwrap_or(&q.key).replace('"', "_");
    let disposition = format!("attachment; filename=\"{filename}\"");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, disposition)
        .body(Body::from(bytes))
        .unwrap_or_else(|_| ApiError::internal("download failed").into_response())
}

pub async fn app_r2_delete(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::r2_delete(&state.config, &app, &bucket, &q.key).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}
