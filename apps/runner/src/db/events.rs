//! Tenant events, user identify properties, and insight widgets.

use sqlx::SqlitePool;

use crate::models::{now_iso, AppEvent, AppInsight, AppUserProps};

/// Insert one tenant event. Caller validates shapes; tags arrive serialized.
// Ten args mirror the INSERT column list 1:1 (single caller) — grouping
// would add indirection without removing a parameter.
#[allow(clippy::too_many_arguments)]
pub async fn insert_app_event(
    pool: &SqlitePool,
    id: &str,
    app_id: &str,
    channel: &str,
    event: &str,
    description: &str,
    icon: &str,
    tags: &str,
    user_id: &str,
    ts: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_event (id, app_id, channel, event, description, icon, tags, user_id, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(id)
    .bind(app_id)
    .bind(channel)
    .bind(event)
    .bind(description)
    .bind(icon)
    .bind(tags)
    .bind(user_id)
    .bind(ts)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_app_events(
    pool: &SqlitePool,
    app_id: &str,
    channel: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<AppEvent>> {
    match channel {
        Some(c) => {
            sqlx::query_as::<_, AppEvent>(
                r#"SELECT id, app_id, channel, event, description, icon, tags, user_id, ts
                   FROM app_event WHERE app_id = ? AND channel = ?
                   ORDER BY ts DESC, rowid DESC LIMIT ?"#,
            )
            .bind(app_id)
            .bind(c)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
        None => {
            sqlx::query_as::<_, AppEvent>(
                r#"SELECT id, app_id, channel, event, description, icon, tags, user_id, ts
                   FROM app_event WHERE app_id = ?
                   ORDER BY ts DESC, rowid DESC LIMIT ?"#,
            )
            .bind(app_id)
            .bind(limit)
            .fetch_all(pool)
            .await
        }
    }
}

pub async fn list_app_channels(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT channel FROM app_event WHERE app_id = ? ORDER BY channel ASC",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}

/// Shallow-merge identify properties (last write wins per key).
pub async fn upsert_app_user_props(
    pool: &SqlitePool,
    app_id: &str,
    user_id: &str,
    properties: &str,
) -> sqlx::Result<()> {
    let now = now_iso();
    let existing: Option<String> =
        sqlx::query_scalar("SELECT properties FROM app_user_prop WHERE app_id = ? AND user_id = ?")
            .bind(app_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let merged = match existing {
        Some(prev) => {
            let mut map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(&prev).unwrap_or_default();
            let next: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(properties).unwrap_or_default();
            map.extend(next);
            serde_json::Value::Object(map).to_string()
        }
        None => properties.to_string(),
    };
    sqlx::query(
        r#"INSERT INTO app_user_prop (app_id, user_id, properties, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (app_id, user_id) DO UPDATE SET
             properties = excluded.properties, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(user_id)
    .bind(merged)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_app_user_props(
    pool: &SqlitePool,
    app_id: &str,
    user_id: &str,
) -> sqlx::Result<Option<AppUserProps>> {
    sqlx::query_as::<_, AppUserProps>(
        "SELECT app_id, user_id, properties, updated_at FROM app_user_prop WHERE app_id = ? AND user_id = ?",
    )
    .bind(app_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Set an insight widget value (string or number).
pub async fn set_app_insight(
    pool: &SqlitePool,
    app_id: &str,
    title: &str,
    value: &str,
    num: Option<f64>,
    icon: &str,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO app_insight (app_id, title, value, num, icon, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, title) DO UPDATE SET
             value = excluded.value, num = excluded.num,
             icon = excluded.icon, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(title)
    .bind(value)
    .bind(num)
    .bind(icon)
    .bind(now_iso())
    .execute(pool)
    .await?;
    Ok(())
}

/// Atomic increment of an insight (creates at delta when missing).
pub async fn inc_app_insight(
    pool: &SqlitePool,
    app_id: &str,
    title: &str,
    delta: f64,
    icon: Option<&str>,
) -> sqlx::Result<AppInsight> {
    let now = now_iso();
    let current: Option<(Option<f64>, String)> =
        sqlx::query_as("SELECT num, icon FROM app_insight WHERE app_id = ? AND title = ?")
            .bind(app_id)
            .bind(title)
            .fetch_optional(pool)
            .await?;
    let (next, icon_out) = match current {
        Some((n, old_icon)) => (
            n.unwrap_or(0.0) + delta,
            icon.unwrap_or(&old_icon).to_string(),
        ),
        None => (delta, icon.unwrap_or("").to_string()),
    };
    let text = if next.fract() == 0.0 {
        format!("{}", next as i64)
    } else {
        format!("{next}")
    };
    sqlx::query(
        r#"INSERT INTO app_insight (app_id, title, value, num, icon, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (app_id, title) DO UPDATE SET
             value = excluded.value, num = excluded.num,
             icon = excluded.icon, updated_at = excluded.updated_at"#,
    )
    .bind(app_id)
    .bind(title)
    .bind(&text)
    .bind(next)
    .bind(&icon_out)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(AppInsight {
        app_id: app_id.to_string(),
        title: title.to_string(),
        value: text,
        num: Some(next),
        icon: icon_out,
        updated_at: now,
    })
}

pub async fn list_app_insights(pool: &SqlitePool, app_id: &str) -> sqlx::Result<Vec<AppInsight>> {
    sqlx::query_as::<_, AppInsight>(
        "SELECT app_id, title, value, num, icon, updated_at FROM app_insight WHERE app_id = ? ORDER BY title ASC",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await
}
