//! Observability: metrics, spans, devices, paths, refs, logs (the unary reads
//! plus the merged log view the log SSE stream tails).
//!
//! Every read takes an optional environment: absent or empty means
//! production only — never "everything", now that environments carry their
//! own rows keyed by environment id.

use crate::api_error::ApiError;
use crate::db;
use crate::host::{logs, metrics, supervisor};
use crate::AppState;

/// One observability target: the app id the metric tables key on and the slug
/// the in-memory log tail keys on. For a tenant app both come from its `app`
/// row; for the control fleet there is no row by design, so the reserved key
/// stands for both (see `host::control::SLUG`). Returning `None` is a 404 —
/// the routes stay identical for both kinds of source.
pub async fn telemetry_target(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> sqlx::Result<Option<(String, String)>> {
    if id == crate::host::control::SLUG {
        return Ok(Some((
            crate::host::control::SLUG.to_string(),
            crate::host::control::SLUG.to_string(),
        )));
    }
    Ok(db::get_app(pool, id).await?.map(|app| (app.id, app.slug)))
}

/// Resolve one telemetry target or the error to answer with (404 unknown app,
/// 500 database). Every observability route shares it, so a tenant app and the
/// control fleet take the same path.
pub async fn telemetry_target_or_404(
    pool: &sqlx::SqlitePool,
    id: &str,
) -> Result<(String, String), ApiError> {
    match telemetry_target(pool, id).await {
        Ok(Some(target)) => Ok(target),
        Ok(None) => Err(ApiError::not_found("app not found")),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// One resolved observability scope: the app id and environment id the
/// metric tables key on (`''` for production), the environment's label when
/// scoped to one, and the fleet key the in-memory log tail keys on.
pub struct TelemetryScope {
    pub app_id: String,
    /// The app's slug (or the reserved control key): names the maps prefix
    /// and the fleet key together with the environment label.
    pub slug: String,
    pub environment_id: String,
    pub env_label: Option<String>,
    pub fleet_key: String,
}

/// Resolve one scope: absent or empty `environment_id` is production only;
/// a given one must be this app's, else 404 (environment rings are keyed
/// `slug.label` and must never answer for another app — or for the control
/// fleet, which has no environments).
pub async fn telemetry_scope(
    pool: &sqlx::SqlitePool,
    id: &str,
    environment_id: Option<&str>,
) -> Result<TelemetryScope, ApiError> {
    let Some(env_id) = environment_id.filter(|raw| !raw.is_empty()) else {
        let (app_id, slug) = telemetry_target_or_404(pool, id).await?;
        return Ok(TelemetryScope {
            app_id,
            slug: slug.clone(),
            environment_id: String::new(),
            env_label: None,
            fleet_key: slug,
        });
    };
    let app = db::get_app(pool, id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .ok_or_else(|| ApiError::not_found("app not found"))?;
    let env = db::get_environment(pool, env_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    match env {
        Some(env) if env.app_id == app.id => Ok(TelemetryScope {
            slug: app.slug.clone(),
            fleet_key: supervisor::env_fleet_key(&app.slug, &env.label),
            app_id: app.id,
            environment_id: env.id,
            env_label: Some(env.label),
        }),
        _ => Err(ApiError::not_found("environment not found")),
    }
}

/// Merged log view: the ingested OTel ring for this scope (up to ~40 s
/// behind live traffic) plus the fleet's in-memory stdout tail (live).
/// Chronological, oldest first. Environments merge their own ingested ring
/// with their own fleet ring — never production's.
pub async fn merged_lines(state: &AppState, scope: &TelemetryScope) -> Vec<String> {
    let since = metrics::now_us() - 24 * 3_600_000_000;
    let mut lines: Vec<String> = db::list_app_logs(
        &state.pool,
        &scope.app_id,
        &scope.environment_id,
        since,
        500,
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(_, body)| body)
    .collect();
    lines.extend(logs::tail(&state.logs, &scope.fleet_key, 500).await);
    lines
}

fn hours_since(hours: Option<i64>, fmt: &str) -> String {
    let hours = hours.unwrap_or(24).clamp(1, 720);
    (chrono::Utc::now() - chrono::Duration::hours(hours))
        .format(fmt)
        .to_string()
}

pub async fn metrics(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:%M:00Z");
    json_rows(db::list_app_metrics(&state.pool, &scope.app_id, &scope.environment_id, &since).await)
}

pub async fn devices(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_devices(&state.pool, &scope.app_id, &scope.environment_id, &since).await)
}

pub async fn paths(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_paths(&state.pool, &scope.app_id, &scope.environment_id, &since).await)
}

pub async fn refs(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_app_refs(&state.pool, &scope.app_id, &scope.environment_id, &since).await)
}

/// Ingested hourly span stats (spec T3.2): the 24 h default is one indexed
/// SQLite scan, like every other series (up to 720 h).
pub async fn spans(
    state: &AppState,
    id: &str,
    hours: Option<i64>,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    let since = hours_since(hours, "%Y-%m-%dT%H:00:00Z");
    json_rows(db::list_span_stats(&state.pool, &scope.app_id, &scope.environment_id, &since).await)
}

/// Per-app-and-environment metrics version (spec T3.6): dashboard polls fetch
/// this first and skip their window queries when it hasn't moved. Each tab
/// (production, each environment) has its own version.
pub async fn metrics_version(
    state: &AppState,
    id: &str,
    environment: Option<&str>,
) -> Result<serde_json::Value, ApiError> {
    let scope = telemetry_scope(&state.pool, id, environment).await?;
    match db::get_metric_version(&state.pool, &scope.app_id, &scope.environment_id).await {
        Ok(v) => Ok(serde_json::json!({ "version": v })),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

/// One resolved live-log source: the scope's own ingested ring plus its own
/// fleet ring, merged. Production and each environment read only their own.
pub struct LogSource {
    pub scope: TelemetryScope,
}

impl LogSource {
    pub async fn lines(&self, state: &AppState) -> Vec<String> {
        merged_lines(state, &self.scope).await
    }
}

/// Resolve the live-log source for one app (or the control fleet) and, when
/// given, one of its environments. An environment that is not this app's is a
/// 404: environment rings are keyed `slug.label` and must never answer for
/// another app.
pub async fn log_source(
    state: &AppState,
    id: &str,
    environment_id: Option<&str>,
) -> Result<LogSource, ApiError> {
    Ok(LogSource {
        scope: telemetry_scope(&state.pool, id, environment_id).await?,
    })
}

pub async fn logs_lines(
    state: &AppState,
    id: &str,
    environment_id: Option<&str>,
) -> Result<Vec<String>, ApiError> {
    let source = log_source(state, id, environment_id).await?;
    Ok(source.lines(state).await)
}

fn json_rows<T: serde::Serialize>(
    rows: sqlx::Result<Vec<T>>,
) -> Result<serde_json::Value, ApiError> {
    let rows = rows.map_err(|e| ApiError::internal(e.to_string()))?;
    serde_json::to_value(rows).map_err(|e| ApiError::internal(e.to_string()))
}
