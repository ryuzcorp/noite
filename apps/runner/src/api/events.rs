//! Tenant app events (LogSnag-style): channel-grouped event log, user
//! property profiles, and latest-value insight widgets.
//!
//! Ingest callers authenticate at the control UI (API key + app role); the
//! runner trusts its bearer gate and only validates shapes here. Reads are
//! plain JSON lists for the control UI to re-serve.
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use serde::Deserialize;
use tokio_stream::wrappers::ReceiverStream;

use crate::db;
use crate::error::ApiError;
use crate::models::{new_id, now_iso};
use crate::AppState;

fn is_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && {
            let mut parts = s.split('-');
            parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase()))
        }
}

fn tag_value(v: &serde_json::Value) -> bool {
    v.is_string() || v.is_number() || v.is_boolean()
}

#[derive(Deserialize)]
pub struct LogBody {
    channel: String,
    event: String,
    description: Option<String>,
    icon: Option<String>,
    notify: Option<bool>,
    tags: Option<std::collections::HashMap<String, serde_json::Value>>,
    parser: Option<String>,
    user_id: Option<String>,
    timestamp: Option<i64>,
}

pub async fn log_event(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<LogBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let channel = body.channel.trim().to_string();
    let event = body.event.trim().to_string();
    if channel.is_empty() || channel.len() > 64 {
        return ApiError::bad("channel required (max 64 chars)").into_response();
    }
    if event.is_empty() || event.len() > 128 {
        return ApiError::bad("event required (max 128 chars)").into_response();
    }
    let description = body.description.unwrap_or_default();
    if description.len() > 4096 {
        return ApiError::bad("description max 4096 chars").into_response();
    }
    let icon = body.icon.unwrap_or_default();
    if icon.chars().count() > 16 {
        return ApiError::bad("icon max 16 chars").into_response();
    }
    // Alpha cuts: no push delivery (notify accepted and ignored), no
    // markdown rendering (descriptions are plain text).
    let tags = body.tags.unwrap_or_default();
    if tags.len() > 16 {
        return ApiError::bad("tags max 16 entries").into_response();
    }
    for (k, v) in &tags {
        if !is_key(k) || !tag_value(v) {
            return ApiError::bad(
                "tag keys must be lowercase dash-separated, values string|number|boolean",
            )
            .into_response();
        }
    }
    let user_id = body.user_id.unwrap_or_default();
    if user_id.len() > 128 {
        return ApiError::bad("user_id max 128 chars").into_response();
    }
    let ts = match body.timestamp {
        Some(secs) => chrono::DateTime::from_timestamp(secs, 0)
            .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
            .unwrap_or_else(now_iso),
        None => now_iso(),
    };
    let tags_json = serde_json::Value::Object(tags.into_iter().collect()).to_string();
    let event_id = new_id();
    if let Err(e) = db::insert_app_event(
        &state.pool,
        &event_id,
        &app.id,
        &channel,
        &event,
        &description,
        &icon,
        &tags_json,
        &user_id,
        &ts,
    )
    .await
    {
        return ApiError::internal(e.to_string()).into_response();
    }
    Json(serde_json::json!({ "ok": true, "id": event_id })).into_response()
}

#[derive(Deserialize)]
pub struct FeedQuery {
    channel: Option<String>,
    limit: Option<i64>,
}

pub async fn list_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<FeedQuery>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let channel = q.channel.as_deref().map(str::trim).filter(|c| !c.is_empty());
    match db::list_app_events(&state.pool, &app.id, channel, limit).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

pub async fn list_channels(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::list_app_channels(&state.pool, &app.id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct IdentifyBody {
    user_id: String,
    properties: std::collections::HashMap<String, serde_json::Value>,
}

pub async fn identify_user(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<IdentifyBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let user_id = body.user_id.trim().to_string();
    if user_id.is_empty() || user_id.len() > 128 {
        return ApiError::bad("user_id required (max 128 chars)").into_response();
    }
    if body.properties.is_empty() || body.properties.len() > 32 {
        return ApiError::bad("properties required (max 32 entries)").into_response();
    }
    for (k, v) in &body.properties {
        if !is_key(k) || !tag_value(v) {
            return ApiError::bad(
                "property keys must be lowercase dash-separated, values string|number|boolean",
            )
            .into_response();
        }
    }
    let props = serde_json::Value::Object(body.properties.into_iter().collect()).to_string();
    if let Err(e) = db::upsert_app_user_props(&state.pool, &app.id, &user_id, &props).await {
        return ApiError::internal(e.to_string()).into_response();
    }
    Json(serde_json::json!({ "ok": true })).into_response()
}

pub async fn get_user_props(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::get_app_user_props(&state.pool, &app.id, user_id.trim()).await {
        Ok(row) => Json(row).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct InsightBody {
    title: String,
    value: serde_json::Value,
    icon: Option<String>,
}

pub async fn set_insight(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<InsightBody>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let title = body.title.trim().to_string();
    if title.is_empty() || title.len() > 128 {
        return ApiError::bad("title required (max 128 chars)").into_response();
    }
    let icon = body.icon.unwrap_or_default();
    if icon.chars().count() > 16 {
        return ApiError::bad("icon max 16 chars").into_response();
    }
    // Alpha fold: LogSnag's PATCH $inc lives here too — an object value
    // with exactly {"$inc": n} increments instead of setting.
    if let Some(obj) = body.value.as_object() {
        if obj.len() == 1 {
            if let Some(delta) = obj.get("$inc").and_then(|v| v.as_f64()) {
                match db::inc_app_insight(&state.pool, &app.id, &title, delta, (!icon.is_empty()).then_some(icon.as_str())).await {
                    Ok(row) => return Json(row).into_response(),
                    Err(e) => return ApiError::internal(e.to_string()).into_response(),
                }
            }
        }
        return ApiError::bad("object values only support {\"$inc\": number}").into_response();
    }
    let (text, num) = match &body.value {
        serde_json::Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            let text = if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", f as i64)
            } else {
                format!("{f}")
            };
            (text, Some(f))
        }
        serde_json::Value::String(s) => {
            if s.len() > 256 {
                return ApiError::bad("string values max 256 chars").into_response();
            }
            (s.clone(), None)
        }
        serde_json::Value::Bool(b) => (b.to_string(), None),
        _ => return ApiError::bad("value must be string, number, boolean, or {\"$inc\": n}").into_response(),
    };
    if let Err(e) = db::set_app_insight(&state.pool, &app.id, &title, &text, num, &icon).await {
        return ApiError::internal(e.to_string()).into_response();
    }
    Json(serde_json::json!({ "ok": true, "title": title, "value": text })).into_response()
}

pub async fn list_insights(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    match db::list_app_insights(&state.pool, &app.id).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => ApiError::internal(e.to_string()).into_response(),
    }
}

/// Event feed as server-sent events: one combined JSON snapshot
/// `{ feed, channels, insights }` per message, sent only when it changed
/// (plus keep-alive comments). Scoped by `?channel=` like the list
/// endpoint. Ends when the client disconnects.
pub async fn list_events_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<FeedQuery>,
) -> impl IntoResponse {
    let app = match db::get_app(&state.pool, &id).await {
        Ok(Some(a)) => a,
        Ok(None) => return ApiError::not_found("app not found").into_response(),
        Err(e) => return ApiError::internal(e.to_string()).into_response(),
    };
    let limit = q.limit.unwrap_or(200).clamp(1, 200);
    let channel = q
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let pool = state.pool.clone();
    let app_id = app.id.clone();
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, anyhow::Error>>(16);
    tokio::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            let feed = db::list_app_events(&pool, &app_id, channel.as_deref(), limit).await;
            let channels = db::list_app_channels(&pool, &app_id).await;
            let insights = db::list_app_insights(&pool, &app_id).await;
            match (feed, channels, insights) {
                (Ok(feed), Ok(channels), Ok(insights)) => {
                    let data = serde_json::json!({
                        "feed": feed,
                        "channels": channels,
                        "insights": insights,
                    })
                    .to_string();
                    if last.as_ref() != Some(&data) {
                        if tx.send(Ok(Event::default().data(data.clone()))).await.is_err() {
                            break;
                        }
                        last = Some(data);
                    }
                }
                // Transient DB error — retry on next tick.
                _ => {}
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response()
}
