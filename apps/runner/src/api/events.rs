//! Tenant app events (LogSnag-style): channel-grouped event log, user
//! property profiles, and latest-value insight widgets (thin adapters over
//! `service::events`) plus the combined feed SSE stream.
//!
//! Ingest callers authenticate at the control UI (API key + app role); the
//! runner trusts its bearer gate and only validates shapes here. Reads are
//! plain JSON lists for the control UI to re-serve.
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::api::sse::poll_stream;
use crate::db;
use crate::service;
use crate::AppState;

#[derive(Deserialize)]
pub struct FeedQuery {
    channel: Option<String>,
    limit: Option<i64>,
}

pub async fn log_event(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<service::events::LogBody>,
) -> impl IntoResponse {
    service::events::log_event(&state, &id, &body)
        .await
        .map(|event_id| Json(json!({ "ok": true, "id": event_id })))
}

pub async fn list_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<FeedQuery>,
) -> impl IntoResponse {
    service::events::list(&state, &id, q.channel.as_deref(), q.limit)
        .await
        .map(Json)
}

pub async fn list_channels(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::events::channels(&state, &id).await.map(Json)
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
    service::events::identify(&state, &id, &body.user_id, &body.properties)
        .await
        .map(|()| Json(json!({ "ok": true })))
}

pub async fn get_user_props(
    State(state): State<AppState>,
    Path((id, user_id)): Path<(String, String)>,
) -> impl IntoResponse {
    service::events::user_props(&state, &id, &user_id)
        .await
        .map(Json)
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
    service::events::set_insight(&state, &id, &body.title, &body.value, body.icon.as_deref())
        .await
        .map(Json)
}

pub async fn list_insights(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    service::events::insights(&state, &id).await.map(Json)
}

/// Event feed as server-sent events: one combined JSON snapshot
/// `{ feed, channels, insights }` per message, sent only when it changed
/// (plus keep-alive comments). Scoped by `?channel=` like the list
/// endpoint. Ends when the client disconnects.
pub async fn list_events_stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<FeedQuery>,
) -> Response {
    let app = match service::apps::app_or_404(&state, &id).await {
        Ok(app) => app,
        Err(e) => return e.into_response(),
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
    poll_stream("events", Duration::from_secs(2), move || {
        let pool = pool.clone();
        let app_id = app_id.clone();
        let channel = channel.clone();
        async move {
            let feed = db::list_app_events(&pool, &app_id, channel.as_deref(), limit).await;
            let channels = db::list_app_channels(&pool, &app_id).await;
            let insights = db::list_app_insights(&pool, &app_id).await;
            // Transient DB error — retry on next tick.
            match (feed, channels, insights) {
                (Ok(feed), Ok(channels), Ok(insights)) => Some(
                    json!({ "feed": feed, "channels": channels, "insights": insights }).to_string(),
                ),
                _ => None,
            }
        }
    })
}
