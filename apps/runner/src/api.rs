use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use tokio_stream::wrappers::ReceiverStream;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;

use crate::db;
use crate::error::ApiError;
use crate::host::deploy;
use crate::host::logs;
use crate::host::metrics;
use crate::host::purge;
use crate::host::source;
use crate::host::storage;
use crate::lifecycle::slug_ok;
use crate::models::{CreateApp, DesiredState, PatchApp, RenameApp};
use crate::AppState;

pub async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "noite-runner" }))
}

/// Readiness for the edge: 200 only after the first successful reconcile
/// pass (fleets spawned, Caddyfile written). Liveness stays on /health.
/// Compose healthchecks and Coolify route on this, so tenants are never
/// sent to a runner whose fleets are still cold-booting.
pub async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    if state.ready.load(std::sync::atomic::Ordering::Relaxed) {
        Json(json!({ "ok": true, "service": "noite-runner" })).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "ok": false })))
            .into_response()
    }
}

pub async fn list_apps(State(state): State<AppState>) -> impl IntoResponse {
    match db::list_apps(&state.pool).await {
        Ok(apps) => Json(apps).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn create_app(
    State(state): State<AppState>,
    Json(body): Json<CreateApp>,
) -> impl IntoResponse {
    let name = body.name.trim().to_string();
    let slug = body.slug.trim().to_lowercase();
    if name.is_empty() || !slug_ok(&slug) {
        return ApiError::bad("invalid name/slug").into_response();
    }
    match db::get_app_by_slug(&state.pool, &slug).await {
        Ok(Some(existing))
            if existing.desired_state == "deleted"
                || existing.status == "deleting"
                || existing.status == "gone" =>
        {
            // Legacy soft-delete row: reclaim requires a hard DB delete first.
            if let Err(e) = db::delete_app(&state.pool, &existing.id).await {
                return ApiError::internal(format!("failed to reclaim slug row: {e}"))
                    .into_response();
            }
        }
        Ok(Some(_)) => {
            return ApiError::conflict("slug already taken").into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return ApiError::internal(e.to_string()).into_response();
        }
    }
    // Always wipe leftover S3/local data for this slug before the new row lands.
    if let Err(e) = purge::purge_slug(&state.config, &state.procs, &state.logs, &slug).await {
        return ApiError::internal(format!("failed to clear slug data: {e:#}")).into_response();
    }
    let (listen, internal) = match db::next_ports(&state.pool, state.config.port_base).await {
        Ok(p) => p,
        Err(e) => {
            return ApiError::internal(e.to_string()).into_response();
        }
    };
    let subdomain = format!("{slug}.{}", state.config.base_domain);
    match db::create_app(
        &state.pool,
        &state.config,
        &name,
        &slug,
        &subdomain,
        listen,
        internal,
    )
    .await {
        Ok(app) => (StatusCode::CREATED, Json(app)).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn get_app(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => Json(app).into_response(),
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn patch_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PatchApp>,
) -> impl IntoResponse {
    if let Some(desired) = body.desired_state.as_deref() {
        let Some(ds) = DesiredState::parse(desired) else {
            return ApiError::bad("desiredState must be running|stopped").into_response();
        };
        if let Err(e) = db::patch_app_desired(&state.pool, &id, ds.as_str()).await {
            return ApiError::internal(e.to_string()).into_response();
        }
    }
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => Json(app).into_response(),
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn rename_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<RenameApp>,
) -> impl IntoResponse {
    let name = body.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let slug = body
        .slug
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if name.is_none() && slug.is_none() {
        return ApiError::bad("name or slug required").into_response();
    }
    if let Some(ref s) = slug {
        if !slug_ok(s) {
            return ApiError::bad("invalid slug").into_response();
        }
        match db::get_app_by_slug(&state.pool, s).await {
            Ok(Some(other)) if other.id != id => {
                return ApiError::conflict("slug already taken").into_response()
            }
            Ok(_) => {}
            Err(e) => return ApiError::internal(e.to_string()).into_response(),
        }
    }
    match crate::host::rename::rename_app(
        &state.config,
        &state.pool,
        &state.procs,
        &state.logs,
        &state.deploying,
        &id,
        name.as_deref(),
        slug.as_deref(),
    )
    .await
    {
        Ok(app) => Json(app).into_response(),
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("deploy in flight") {
                ApiError::conflict(msg).into_response()
            } else if msg.contains("invalid slug") || msg.contains("app not found") {
                ApiError::bad(msg).into_response()
            } else {
                ApiError::internal(msg).into_response()
            }
        }
    }
}

pub async fn delete_app(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };

    // Same lock as deploy: wait out an in-flight build, then purge exclusively.
    if !deploy::claim_wait(&state.deploying, &app.id, Duration::from_secs(120)).await {
        return ApiError::conflict("deploy in flight; retry delete shortly").into_response();
    }
    let purge_result =
        purge::purge_slug(&state.config, &state.procs, &state.logs, &app.slug).await;
    deploy::release(&state.deploying, &app.id).await;
    if let Err(e) = purge_result {
        return ApiError::internal(format!("failed to purge app data: {e:#}")).into_response();
    }

    match db::delete_app(&state.pool, &id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn list_deploys(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match db::list_deploys(&state.pool, &id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// Deploy history as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Ends when the
/// client disconnects.
pub async fn list_deploys_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let pool = state.pool.clone();
    let app_id = app.id.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    tokio::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            match db::list_deploys(&pool, &app_id).await {
                Ok(rows) => {
                    let data = serde_json::to_string(&rows).unwrap_or_default();
                    if last.as_ref() != Some(&data) {
                        if tx.send(Ok(Event::default().data(data.clone()))).await.is_err() {
                            break;
                        }
                        last = Some(data);
                    }
                }
                Err(_) => {
                    // Transient DB error — retry on next tick.
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRemote {
    remote: String,
    url: String,
    username: String,
    /// Internal S3 layout (debug); clients use `remote` / `url`.
    s3_remote: String,
    endpoint: String,
    bucket: String,
    prefix: String,
}

/// Fetch an app plus the rev to browse in its source mirror (last deploy,
/// else bare-mirror HEAD). Err → app exists but has no source yet.
async fn app_with_rev(
    state: &AppState,
    id: &str,
) -> Result<Option<(crate::models::App, String)>, String> {
    let Some(app) = db::get_app(&state.pool, id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let Some(rev) = source::resolve_rev(&state.config, &app)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Err("no source materialized yet — push to main first".into());
    };
    Ok(Some((app, rev)))
}

pub async fn source_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::list_tree(&state.config, &app, &rev).await {
            Ok(t) => Json(t).into_response(),
            Err(e) => ApiError::from_anyhow(e).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

pub async fn source_blob(
    State(state): State<AppState>,
    Path((id, path)): Path<(String, String)>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::read_blob(&state.config, &app, &rev, &path).await {
            Ok(b) => Json(b).into_response(),
            Err(e) => ApiError::not_found(e.to_string()).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

pub async fn source_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match app_with_rev(&state, &id).await {
        Ok(Some((app, rev))) => match source::make_patch(&state.config, &app, &rev).await {
            Ok(d) => Json(d).into_response(),
            Err(e) => ApiError::from_anyhow(e).into_response(),
        },
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::conflict(e).into_response(),
    }
}

#[derive(Deserialize)]
pub struct MetricsQuery {
    pub hours: Option<i64>,
}

#[derive(Deserialize)]
pub struct D1Query {
    /// Row limit per table (reuses `hours` query key from the UI for now).
    pub hours: Option<i64>,
}

#[derive(Deserialize)]
pub struct R2ObjectQuery {
    pub key: String,
}

pub async fn app_metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    }
    let hours = q.hours.unwrap_or(24).clamp(1, 336);
    let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format("%Y-%m-%dT%H:%M:00Z")
        .to_string();
    match db::list_app_metrics(&state.pool, &id, &since).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_spans(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> impl IntoResponse {
    match db::get_app(&state.pool, &id).await {
        Ok(Some(app)) => {
            let hours = q.hours.unwrap_or(1).clamp(1, 24);
            let since = metrics::now_us_pub() - hours * 3_600_000_000;
            let spans = metrics::top_spans(&state.config, &app.slug, since).await;
            Json(spans).into_response()
        }
        Ok(None) => ApiError::not_found("app not found").into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn app_logs(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let mut lines = metrics::recent_logs(&state.config, &app.slug, 500).await;
    lines.extend(logs::tail(&state.logs, &app.slug, 500).await);
    Json(lines).into_response()
}

/// Live log tail as server-sent events: one JSON array per message, sent
/// only when the snapshot changed (plus keep-alive comments). Ends when the
/// client disconnects.
pub async fn app_logs_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    let cfg = state.config.clone();
    let log_state = state.logs.clone();
    let slug = app.slug.clone();
    tokio::spawn(async move {
        let mut last: Option<Vec<String>> = None;
        loop {
            let mut lines = metrics::recent_logs(&cfg, &slug, 500).await;
            lines.extend(logs::tail(&log_state, &slug, 500).await);
            if last.as_ref() != Some(&lines) {
                let data = serde_json::to_string(&lines).unwrap_or_default();
                if tx.send(Ok(Event::default().data(data))).await.is_err() {
                    break;
                }
                last = Some(lines);
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
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

pub async fn git_remote(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    Json(GitRemote {
        remote: state.config.git_http_remote(&app.slug),
        url: state.config.git_http_url(&app.slug),
        username: "git".into(),
        s3_remote: state.config.s3_git_remote(&app.slug),
        endpoint: state.config.s3_public_endpoint.clone(),
        bucket: state.config.s3_bucket.clone(),
        prefix: app.git_prefix,
    })
    .into_response()
}

pub async fn webhook(
    State(state): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut keys = Vec::new();
    if let Some(records) = body.get("Records").and_then(|r| r.as_array()) {
        for rec in records {
            if let Some(key) = rec
                .pointer("/s3/object/key")
                .and_then(|k| k.as_str())
            {
                keys.push(key.replace('+', " "));
            }
        }
    }
    for key in &keys {
        // Keys are `git/{slug}/refs/heads/main/{sha}.bundle` (single-bucket layout).
        // Accept legacy `{slug}/refs/...` from the old dedicated `git` bucket.
        let path = key.strip_prefix("git/").unwrap_or(key.as_str());
        let slug = path.split('/').next().unwrap_or("");
        if slug.is_empty() || !key.ends_with(".bundle") || !path.contains("/refs/heads/main/") {
            continue;
        }
        let Ok(Some(app)) = db::get_app_by_slug(&state.pool, slug).await else {
            continue;
        };
        if app.is_stopped() {
            continue;
        }
        let pool = state.pool.clone();
        let cfg = state.config.clone();
        let procs = state.procs.clone();
        let logs = state.logs.clone();
        let deploying = state.deploying.clone();
        let key = key.clone();
        tokio::spawn(async move {
            deploy::deploy_app(&pool, &cfg, &procs, &logs, &deploying, app, &key, None).await;
        });
    }
    Json(json!({ "ok": true, "keys": keys }))
}
