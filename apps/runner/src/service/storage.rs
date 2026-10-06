//! Tenant storage: inventory, D1 preview/write, DO, R2.
//!
//! Every host call here talks to celld or S3, which report both "the object /
//! table / source is missing" and "the backend broke" as `anyhow` strings.
//! `error` classifies the missing cases as 404 and everything else as 500 —
//! the transport-agnostic fix for the old blanket `conflict` (409).

use std::collections::BTreeMap;

use crate::api_error::ApiError;
use crate::host::storage::{
    self,
    d1::{D1Rows, D1RowsQuery, D1TableSchemaRaw, D1Tables},
    durable::DoPreview,
    r2::{R2File, R2Raw, R2Preview},
    StorageItem,
};
use crate::AppState;

use super::apps::app_or_404;

/// Map a celld/S3 failure onto HTTP semantics. "Missing" is the only client
/// distinction the messages carry: a missing object, a missing D1 table and a
/// not-yet-deployed source all read as not-found; anything else is internal.
pub fn error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found")
        || msg.contains("no deployed source")
        || msg.contains("unknown table")
    {
        ApiError::not_found(msg)
    } else {
        ApiError::internal(msg)
    }
}

pub async fn list(state: &AppState, id: &str) -> Result<Vec<StorageItem>, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::list_storage(&state.config, &app)
        .await
        .map_err(error)
}

pub async fn d1_tables(
    state: &AppState,
    id: &str,
    database_id: &str,
) -> Result<D1Tables, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::d1_tables(&state.config, &app, database_id)
        .await
        .map_err(error)
}

pub async fn d1_schema(
    state: &AppState,
    id: &str,
    database_id: &str,
    table: &str,
) -> Result<D1TableSchemaRaw, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::d1_schema(&state.config, &app, database_id, table)
        .await
        .map_err(error)
}

pub async fn d1_rows(
    state: &AppState,
    id: &str,
    database_id: &str,
    query: &D1RowsQuery,
) -> Result<D1Rows, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::d1_rows(&state.config, &app, database_id, query)
        .await
        .map_err(error)
}

#[allow(clippy::too_many_arguments)]
pub async fn d1_write(
    state: &AppState,
    id: &str,
    database_id: &str,
    op: &str,
    table: &str,
    values: &BTreeMap<String, Option<String>>,
    key: &BTreeMap<String, Option<String>>,
) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    storage::d1_write(&state.config, &app, database_id, op, table, values, key)
        .await
        .map_err(error)
}

pub async fn d1_delete_rows(
    state: &AppState,
    id: &str,
    database_id: &str,
    table: &str,
    keys: &[BTreeMap<String, Option<String>>],
) -> Result<u64, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::d1_delete_rows(&state.config, &app, database_id, table, keys)
        .await
        .map_err(error)
}

pub async fn do_instances(
    state: &AppState,
    id: &str,
    class_name: &str,
) -> Result<DoPreview, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::do_instances(&state.config, &app, class_name)
        .await
        .map_err(error)
}

pub async fn r2_list(
    state: &AppState,
    id: &str,
    bucket: &str,
    prefix: &str,
    cursor: Option<&str>,
    limit: usize,
) -> Result<R2Preview, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::r2_list(&state.config, &app, bucket, prefix, cursor, limit)
        .await
        .map_err(error)
}

pub async fn r2_get(
    state: &AppState,
    id: &str,
    bucket: &str,
    key: &str,
) -> Result<R2File, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::r2_get(&state.config, &app, bucket, key)
        .await
        .map_err(error)
}

pub async fn r2_delete_many(
    state: &AppState,
    id: &str,
    bucket: &str,
    keys: &[String],
) -> Result<usize, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::r2_delete_many(&state.config, &app, bucket, keys)
        .await
        .map_err(error)
}

/// Raw object bytes for the sandboxed download route (REST only).
pub async fn r2_raw(
    state: &AppState,
    id: &str,
    bucket: &str,
    key: &str,
) -> Result<R2Raw, ApiError> {
    let app = app_or_404(state, id).await?;
    storage::r2_raw(&state.config, &app, bucket, key)
        .await
        .map_err(error)
}
