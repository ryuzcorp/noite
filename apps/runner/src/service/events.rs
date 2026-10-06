//! Tenant app events (LogSnag-style): channel-grouped event log, user
//! property profiles, and latest-value insight widgets.
//!
//! Ingest callers authenticate at the control UI (API key + app role); the
//! runner trusts its bearer gate and only validates shapes here. Reads are
//! plain JSON lists for the control UI to re-serve.

use serde::Deserialize;

use crate::api_error::ApiError;
use crate::db;
use crate::models::{new_id, now_iso, AppEvent, AppInsight, AppUserProps};
use crate::AppState;

use super::apps::app_or_404;

fn is_key(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && {
        let mut parts = s.split('-');
        parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase()))
    }
}

fn tag_value(v: &serde_json::Value) -> bool {
    v.is_string() || v.is_number() || v.is_boolean()
}

#[derive(Deserialize)]
// Alpha cut: `notify` (no push delivery) and `parser` (no markdown
// rendering) are accepted and ignored — the fields must stay for API shape.
#[allow(dead_code)]
pub struct LogBody {
    pub channel: String,
    pub event: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub notify: Option<bool>,
    pub tags: Option<std::collections::HashMap<String, serde_json::Value>>,
    pub parser: Option<String>,
    pub user_id: Option<String>,
    pub timestamp: Option<i64>,
}

/// Returns the new event id.
pub async fn log_event(state: &AppState, id: &str, body: &LogBody) -> Result<String, ApiError> {
    let app = app_or_404(state, id).await?;
    let channel = body.channel.trim().to_string();
    let event = body.event.trim().to_string();
    if channel.is_empty() || channel.len() > 64 {
        return Err(ApiError::bad("channel required (max 64 chars)"));
    }
    if event.is_empty() || event.len() > 128 {
        return Err(ApiError::bad("event required (max 128 chars)"));
    }
    let description = body.description.clone().unwrap_or_default();
    if description.len() > 4096 {
        return Err(ApiError::bad("description max 4096 chars"));
    }
    let icon = body.icon.clone().unwrap_or_default();
    if icon.chars().count() > 16 {
        return Err(ApiError::bad("icon max 16 chars"));
    }
    // Alpha cuts: no push delivery (notify accepted and ignored), no
    // markdown rendering (descriptions are plain text).
    let tags = body.tags.clone().unwrap_or_default();
    if tags.len() > 16 {
        return Err(ApiError::bad("tags max 16 entries"));
    }
    for (k, v) in &tags {
        if !is_key(k) || !tag_value(v) {
            return Err(ApiError::bad(
                "tag keys must be lowercase dash-separated, values string|number|boolean",
            ));
        }
    }
    let user_id = body.user_id.clone().unwrap_or_default();
    if user_id.len() > 128 {
        return Err(ApiError::bad("user_id max 128 chars"));
    }
    let ts = match body.timestamp {
        Some(secs) => chrono::DateTime::from_timestamp(secs, 0)
            .map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
            .unwrap_or_else(now_iso),
        None => now_iso(),
    };
    let tags_json = serde_json::Value::Object(tags.into_iter().collect()).to_string();
    let event_id = new_id();
    db::insert_app_event(
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
    .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(event_id)
}

pub async fn list(
    state: &AppState,
    id: &str,
    channel: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<AppEvent>, ApiError> {
    let app = app_or_404(state, id).await?;
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let channel = channel.map(str::trim).filter(|c| !c.is_empty());
    db::list_app_events(&state.pool, &app.id, channel, limit)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn channels(state: &AppState, id: &str) -> Result<Vec<String>, ApiError> {
    let app = app_or_404(state, id).await?;
    db::list_app_channels(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn insights(state: &AppState, id: &str) -> Result<Vec<AppInsight>, ApiError> {
    let app = app_or_404(state, id).await?;
    db::list_app_insights(&state.pool, &app.id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn identify(
    state: &AppState,
    id: &str,
    user_id: &str,
    properties: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    let user_id = user_id.trim().to_string();
    if user_id.is_empty() || user_id.len() > 128 {
        return Err(ApiError::bad("user_id required (max 128 chars)"));
    }
    if properties.is_empty() || properties.len() > 32 {
        return Err(ApiError::bad("properties required (max 32 entries)"));
    }
    for (k, v) in properties {
        if !is_key(k) || !tag_value(v) {
            return Err(ApiError::bad(
                "property keys must be lowercase dash-separated, values string|number|boolean",
            ));
        }
    }
    let props = serde_json::Value::Object(properties.clone().into_iter().collect()).to_string();
    db::upsert_app_user_props(&state.pool, &app.id, &user_id, &props)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn user_props(
    state: &AppState,
    id: &str,
    user_id: &str,
) -> Result<Option<AppUserProps>, ApiError> {
    let app = app_or_404(state, id).await?;
    db::get_app_user_props(&state.pool, &app.id, user_id.trim())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

/// Set or `$inc` one insight; returns the exact JSON body the route serves
/// (`$inc` answers the updated row, a set answers `{ok,title,value}`).
pub async fn set_insight(
    state: &AppState,
    id: &str,
    title: &str,
    value: &serde_json::Value,
    icon: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let app = app_or_404(state, id).await?;
    let title = title.trim().to_string();
    if title.is_empty() || title.len() > 128 {
        return Err(ApiError::bad("title required (max 128 chars)"));
    }
    let icon = icon.unwrap_or_default().to_string();
    if icon.chars().count() > 16 {
        return Err(ApiError::bad("icon max 16 chars"));
    }
    // Alpha fold: LogSnag's PATCH $inc lives here too — an object value
    // with exactly {"$inc": n} increments instead of setting.
    if let Some(obj) = value.as_object() {
        if obj.len() == 1 {
            if let Some(delta) = obj.get("$inc").and_then(|v| v.as_f64()) {
                let row = db::inc_app_insight(
                    &state.pool,
                    &app.id,
                    &title,
                    delta,
                    (!icon.is_empty()).then_some(icon.as_str()),
                )
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?;
                return serde_json::to_value(row)
                    .map_err(|e| ApiError::internal(e.to_string()));
            }
        }
        return Err(ApiError::bad(
            "object values only support {\"$inc\": number}",
        ));
    }
    let (text, num) = match value {
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
                return Err(ApiError::bad("string values max 256 chars"));
            }
            (s.clone(), None)
        }
        serde_json::Value::Bool(b) => (b.to_string(), None),
        _ => {
            return Err(ApiError::bad(
                "value must be string, number, boolean, or {\"$inc\": n}",
            ))
        }
    };
    db::set_app_insight(&state.pool, &app.id, &title, &text, num, &icon)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(serde_json::json!({ "ok": true, "title": title, "value": text }))
}
