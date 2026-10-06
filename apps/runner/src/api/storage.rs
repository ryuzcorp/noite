//! Tenant storage: inventory, D1 preview/write, DO, R2.
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

use crate::db;
use crate::error::ApiError;
use crate::host::cmd;
use crate::host::storage;
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

pub async fn app_d1_tables(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::d1_tables(&state.config, &app, &database_id).await {
        Ok(t) => Json(t).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_d1_schema(
    State(state): State<AppState>,
    Path((id, database_id, table)): Path<(String, String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::d1_schema(&state.config, &app, &database_id, &table).await {
        Ok(s) => Json(s).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_d1_rows(
    State(state): State<AppState>,
    Path((id, database_id, table)): Path<(String, String, String)>,
    Json(body): Json<storage::d1::D1RowsBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let query = storage::d1::D1RowsQuery {
        table,
        page: body.page,
        page_size: body.page_size,
        sort: body.sort,
        filters: body.filters,
        search: body.search,
    };
    match storage::d1_rows(&state.config, &app, &database_id, &query).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_d1_write(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Json(body): Json<storage::d1::D1WriteBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::d1_write(
        &state.config,
        &app,
        &database_id,
        &body.op,
        &body.table,
        &body.values,
        &body.key,
    )
    .await
    {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}

pub async fn app_d1_delete_rows(
    State(state): State<AppState>,
    Path((id, database_id)): Path<(String, String)>,
    Json(body): Json<storage::d1::D1DeleteRowsBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::d1_delete_rows(&state.config, &app, &database_id, &body.table, &body.keys).await
    {
        Ok(deleted) => Json(json!({"ok": true, "deleted": deleted})).into_response(),
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
    Query(q): Query<R2ListQuery>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let limit = q.limit.unwrap_or(storage::r2::R2_PAGE_LIMIT);
    match storage::r2_list(
        &state.config,
        &app,
        &bucket,
        q.prefix.as_deref().unwrap_or(""),
        q.cursor.as_deref(),
        limit,
    )
    .await
    {
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
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
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
    let dir = cmd::work_root(&state.config).join("r2-upload");
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
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
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
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let raw = match storage::r2_raw(&state.config, &app, &bucket, &q.key).await {
        Ok(b) => b,
        Err(e) => return ApiError::conflict(format!("{e:#}")).into_response(),
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
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match storage::r2_delete_many(&state.config, &app, &bucket, std::slice::from_ref(&q.key)).await {
        Ok(deleted) => Json(json!({ "ok": true, "deleted": deleted })).into_response(),
        Err(e) => ApiError::conflict(format!("{e:#}")).into_response(),
    }
}
