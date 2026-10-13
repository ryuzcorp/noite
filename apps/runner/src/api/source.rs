//! Source preview (tree/blob) + browser-edit commits (thin adapters over
//! `service::source`). `?ref=` selects a branch, tag or sha; absent keeps the
//! deployed-sha resolution.
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio_stream::wrappers::ReceiverStream;

use crate::api_error::ApiError;
use crate::host::source;
use crate::service;
use crate::AppState;

use super::git::RefQuery;

pub async fn source_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::tree(&state, &id, q.reference.as_deref())
        .await
        .map(Json)
}

pub async fn source_blob(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::blob(&state, &id, &path, q.reference.as_deref())
        .await
        .map(Json)
}

/// All text sources at `ref` (the editor's language service); no `ref` keeps
/// the deployed-sha resolution.
pub async fn source_bundle(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RefQuery>,
) -> impl IntoResponse {
    service::source::bundle(&state, &id, q.reference.as_deref())
        .await
        .map(Json)
}

/// Declaration files captured from the app's last successful build.
pub async fn source_types(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::source::types(&state, &id).await.map(Json)
}

/// The repo at `ref` as an uncompressed tar, streamed. The Workspace caps were
/// checked from the tree listing first, so an over-cap repo already answered
/// 413 and a byte of archive is never buffered.
pub async fn source_archive(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<RefQuery>,
) -> Response {
    let (bare, rev) =
        match service::source::archive_target(&state, &id, q.reference.as_deref()).await {
            Ok(target) => target,
            Err(e) => return e.into_response(),
        };
    let mut child = match source::archive_child(&bare, &rev) {
        Ok(child) => child,
        Err(e) => return ApiError::internal(format!("{e:#}")).into_response(),
    };
    let Some(stdout) = child.stdout.take() else {
        return ApiError::internal("git archive has no stdout").into_response();
    };
    let stderr = child.stderr.take();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(pump_archive(child, stdout, stderr, tx, rev));
    match Response::builder()
        .header(header::CONTENT_TYPE, "application/x-tar")
        .body(Body::from_stream(ReceiverStream::new(rx)))
    {
        Ok(response) => response,
        Err(e) => ApiError::internal(format!("{e}")).into_response(),
    }
}

/// Pump `git archive` into the response stream (the client dropping it kills
/// the child) and reap it; a failure is logged, never buffered.
async fn pump_archive(
    mut child: tokio::process::Child,
    mut stdout: tokio::process::ChildStdout,
    mut stderr: Option<tokio::process::ChildStderr>,
    tx: tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>,
    rev: String,
) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if tx
                    .send(Ok(Bytes::copy_from_slice(&buf[..n])))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(e) => {
                let _ = tx.send(Err(e)).await;
                break;
            }
        }
    }
    let mut detail = Vec::new();
    if let Some(mut stderr) = stderr.take() {
        let _ = stderr.read_to_end(&mut detail).await;
    }
    match child.wait().await {
        Ok(status) if !status.success() => {
            tracing::warn!(%rev, "git archive failed: {}", String::from_utf8_lossy(&detail));
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(%rev, error = %e, "git archive wait"),
    }
}

pub async fn app_source_commit(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<service::source::SourceCommitBody>,
) -> impl IntoResponse {
    service::source::commit(&state, &id, &body)
        .await
        .map(|sha| Json(json!({ "sha": sha })))
}
