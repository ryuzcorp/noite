//! Tenant storage: inventory, D1 preview/write, DO, R2 (thin adapters over
//! `service::storage`; upload/download bodies stay here because they need the
//! request/response stream).
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use crate::api_error::ApiError;
use crate::host::exec;
use crate::host::storage;
use crate::service;
use crate::AppState;

#[derive(Deserialize)]
pub struct R2ObjectQuery {
    pub key: String,
}

/// One listing page: the folder to list, its continuation cursor and a bound.
#[derive(Deserialize)]
pub struct R2ListQuery {
    pub prefix: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

pub async fn app_storage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::storage::list(&state, &id).await.map(Json)
}

pub async fn app_d1_tables(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
) -> impl IntoResponse {
    service::storage::d1_tables(&state, &id, &database_id)
        .await
        .map(Json)
}

pub async fn app_d1_schema(
    State(state): State<AppState>,
    Path((id, database_id, table)): Path<(String, String, String)>,
) -> impl IntoResponse {
    service::storage::d1_schema(&state, &id, &database_id, &table)
        .await
        .map(Json)
}

pub async fn app_d1_rows(
    State(state): State<AppState>,
    Path((id, database_id, table)): Path<(String, String, String)>,
    Json(body): Json<storage::d1::D1RowsBody>,
) -> impl IntoResponse {
    let query = storage::d1::D1RowsQuery {
        table,
        page: body.page,
        page_size: body.page_size,
        sort: body.sort,
        filters: body.filters,
        search: body.search,
    };
    service::storage::d1_rows(&state, &id, &database_id, &query)
        .await
        .map(Json)
}

pub async fn app_d1_write(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Json(body): Json<storage::d1::D1WriteBody>,
) -> impl IntoResponse {
    service::storage::d1_write(
        &state,
        &id,
        &database_id,
        body.op.as_str(),
        &body.table,
        &body.values,
        &body.key,
    )
    .await
    .map(|()| Json(json!({ "ok": true })))
}

pub async fn app_d1_delete_rows(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Json(body): Json<storage::d1::D1DeleteRowsBody>,
) -> impl IntoResponse {
    service::storage::d1_delete_rows(&state, &id, &database_id, &body.table, &body.keys)
        .await
        .map(|deleted| Json(json!({ "ok": true, "deleted": deleted })))
}

pub async fn app_do(
    State(state): State<AppState>,
    Path((id, class_name)): Path<(String, String)>,
) -> impl IntoResponse {
    service::storage::do_instances(&state, &id, &class_name)
        .await
        .map(Json)
}

pub async fn app_r2(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ListQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(storage::r2::R2_PAGE_LIMIT);
    service::storage::r2_list(
        &state,
        &id,
        &bucket,
        q.prefix.as_deref().unwrap_or(""),
        q.cursor.as_deref(),
        limit,
    )
    .await
    .map(Json)
}

pub async fn app_r2_object(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> impl IntoResponse {
    service::storage::r2_get(&state, &id, &bucket, &q.key)
        .await
        .map(Json)
}

/// Largest upload the runner spools to disk before `celld r2 put`; the UI
/// enforces the same cap, so the stream only ever refuses a rogue client.
const R2_UPLOAD_CAP: usize = 67_108_864;

/// Why a body could not be spooled.
enum SpoolError {
    TooLarge,
    Failed(String),
}

impl SpoolError {
    fn into_response(self) -> Response {
        match self {
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "upload exceeds the 64 MiB cap",
            )
                .into_response(),
            Self::Failed(message) => ApiError::internal(message).into_response(),
        }
    }
}

/// Spool one request body to `dest`, refusing more than `cap` bytes.
async fn spool_body(body: Body, dest: &std::path::Path, cap: usize) -> Result<usize, SpoolError> {
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| SpoolError::Failed(format!("{e:#}")))?;
    let mut stream = body.into_data_stream();
    let mut written = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| SpoolError::Failed(format!("upload read: {e:#}")))?;
        written += chunk.len();
        if written > cap {
            return Err(SpoolError::TooLarge);
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| SpoolError::Failed(format!("{e:#}")))?;
    }
    file.flush()
        .await
        .map_err(|e| SpoolError::Failed(format!("{e:#}")))?;
    Ok(written)
}

/// Write one object (or a folder marker: a key ending in `/` with an empty
/// body). The body streams to a spool file and then through `celld r2 put`,
/// so neither the browser nor the runner holds a whole upload in memory and
/// the stored record is the one a Worker's `env.BUCKET.put()` writes.
pub async fn app_r2_put(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
    request: axum::extract::Request,
) -> Response {
    let app = match service::apps::app_or_404(&state, &id).await {
        Ok(app) => app,
        Err(e) => return e.into_response(),
    };
    if !storage::r2::r2_key_ok(&q.key) {
        return ApiError::bad("invalid key").into_response();
    }
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    if let Some(value) = content_type.as_deref() {
        if !storage::r2::r2_header_ok(value) {
            return ApiError::bad("invalid content type").into_response();
        }
    }
    let dir = exec::work_root(&state.config).join("r2-upload");
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return ApiError::internal(format!("{e:#}")).into_response();
    }
    let dest = dir.join(format!("{}-{}", app.slug, uuid::Uuid::new_v4()));
    if let Err(error) = spool_body(request.into_body(), &dest, R2_UPLOAD_CAP).await {
        let _ = tokio::fs::remove_file(&dest).await;
        return error.into_response();
    }
    let result = storage::r2_put(
        &state.config,
        &app,
        &bucket,
        &q.key,
        content_type.as_deref(),
        &dest,
    )
    .await;
    let _ = tokio::fs::remove_file(&dest).await;
    match result {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => service::storage::error(e).into_response(),
    }
}

/// A type the browser may render inline only inside a sandboxed document.
fn needs_sandbox(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/svg+xml" | "text/html" | "application/xhtml+xml" | "text/xml" | "application/xml"
    )
}

pub async fn app_r2_raw(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> Response {
    let raw = match service::storage::r2_raw(&state, &id, &bucket, &q.key).await {
        Ok(raw) => raw,
        Err(e) => return e.into_response(),
    };
    let content_type = raw
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let filename = q.key.rsplit('/').next().unwrap_or(&q.key).replace('"', "_");
    let disposition = format!("inline; filename=\"{filename}\"");
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type.clone())
        .header(header::CONTENT_DISPOSITION, disposition)
        .header("x-content-type-options", "nosniff");
    if needs_sandbox(&content_type) {
        builder = builder.header("content-security-policy", "sandbox");
    }
    builder
        .body(Body::from(raw.bytes))
        .unwrap_or_else(|_| ApiError::internal("download failed").into_response())
}

pub async fn app_r2_delete(
    State(state): State<AppState>,
    Path((id, bucket)): Path<(String, String)>,
    Query(q): Query<R2ObjectQuery>,
) -> impl IntoResponse {
    service::storage::r2_delete_many(&state, &id, &bucket, std::slice::from_ref(&q.key))
        .await
        .map(|deleted| Json(json!({ "ok": true, "deleted": deleted })))
}
