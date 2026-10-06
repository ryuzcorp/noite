//! JSON-RPC surface: POST /rpc serves single calls and batch arrays,
//! dispatching CRUD methods that mirror the REST handlers. Bearer-gated
//! like /v1/*. Stays REST: SSE streams, git smart-HTTP, edge/tls-ask,
//! webhook, health/ready, and the binary r2_raw download.
use std::time::Duration;

use axum::{extract::State, response::IntoResponse, Json};
use axum_jrpc::error::{JsonRpcError, JsonRpcErrorReason};
use axum_jrpc::{Id, JsonRpcResponse};
use serde::Deserialize;

use crate::api::source as api_source;
use crate::config::Config;
use crate::host::{deploy, purge, rename, source, storage, web_commit};
use crate::lifecycle::slug_ok;
use crate::models::{App, AppLimit, DesiredState};
use crate::{db, AppState};

#[derive(Deserialize)]
struct RawCall {
    #[serde(default)]
    id: Option<Id>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: serde_json::Value,
}

fn rpc_err(id: Id, reason: JsonRpcErrorReason, message: String) -> JsonRpcResponse {
    JsonRpcResponse::error(
        id,
        JsonRpcError::new(reason, message, serde_json::Value::Null),
    )
}

fn bad(id: &Id, message: &str) -> JsonRpcResponse {
    rpc_err(
        id.clone(),
        JsonRpcErrorReason::ApplicationError(400),
        message.into(),
    )
}

fn not_found(id: &Id, message: &str) -> JsonRpcResponse {
    rpc_err(
        id.clone(),
        JsonRpcErrorReason::ApplicationError(404),
        message.into(),
    )
}

fn conflict(id: &Id, message: String) -> JsonRpcResponse {
    rpc_err(
        id.clone(),
        JsonRpcErrorReason::ApplicationError(409),
        message,
    )
}

fn internal(id: &Id, message: String) -> JsonRpcResponse {
    rpc_err(id.clone(), JsonRpcErrorReason::InternalError, message)
}

fn parse<P>(params: serde_json::Value, id: &Id) -> Result<P, JsonRpcResponse>
where
    P: serde::de::DeserializeOwned,
{
    serde_json::from_value(params).map_err(|_| {
        rpc_err(
            id.clone(),
            JsonRpcErrorReason::InvalidParams,
            "invalid params".into(),
        )
    })
}

async fn app(state: &AppState, app_id: &str, id: &Id) -> Result<App, JsonRpcResponse> {
    match db::get_app(&state.pool, app_id).await {
        Ok(Some(a)) => Ok(a),
        Ok(None) => Err(not_found(id, "app not found")),
        Err(e) => Err(internal(id, e.to_string())),
    }
}

/// Telemetry target for the observability RPCs: a real app id, or the
/// reserved control key, which has no `app` row by design (see
/// `host/control.rs`). Same shapes as a tenant app, different key.
async fn telemetry_target(
    state: &AppState,
    app_id: &str,
    id: &Id,
) -> Result<String, JsonRpcResponse> {
    match crate::api::observe::telemetry_target(&state.pool, app_id).await {
        Ok(Some((app_id, _))) => Ok(app_id),
        Ok(None) => Err(not_found(id, "app not found")),
        Err(e) => Err(internal(id, e.to_string())),
    }
}

pub async fn handle_rpc(State(state): State<AppState>, body: String) -> impl IntoResponse {
    let value: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            return Json(rpc_err(
                Id::None(()),
                JsonRpcErrorReason::ParseError,
                "parse error".into(),
            ))
            .into_response();
        }
    };
    match value {
        serde_json::Value::Array(calls) => {
            let mut out = Vec::with_capacity(calls.len());
            for raw in calls {
                out.push(dispatch(&state, raw).await);
            }
            Json(out).into_response()
        }
        serde_json::Value::Object(_) => Json(dispatch(&state, value).await).into_response(),
        _ => Json(rpc_err(
            Id::None(()),
            JsonRpcErrorReason::InvalidRequest,
            "invalid request".into(),
        ))
        .into_response(),
    }
}

async fn dispatch(state: &AppState, raw: serde_json::Value) -> JsonRpcResponse {
    let call: RawCall = match serde_json::from_value(raw) {
        Ok(c) => c,
        Err(_) => {
            return rpc_err(
                Id::None(()),
                JsonRpcErrorReason::InvalidRequest,
                "invalid request".into(),
            );
        }
    };
    let id = call.id.unwrap_or(Id::None(()));
    let Some(method) = call.method else {
        return rpc_err(
            id,
            JsonRpcErrorReason::InvalidRequest,
            "missing method".into(),
        );
    };
    dispatch_call(state, &method, call.params, id).await
}

/// Ceiling on a per-app edge limit (requests per minute): past this the
/// module's per-client ring buffer stops being small.
const MAX_EDGE_RPM: i64 = 600_000;

/// An app's edge limits as the settings panel shows them: its own values
/// (null = default) beside the platform defaults they fall back to.
/// `perClient` is false behind a proxy the edge does not trust, where
/// per-client limits cannot apply (`Config::edge_sees_clients`).
fn limits_view(cfg: &Config, limit: &AppLimit) -> serde_json::Value {
    serde_json::json!({
        "clientRpm": limit.client_rpm,
        "appRpm": limit.app_rpm,
        "perClient": cfg.edge_sees_clients(),
        "defaults": {
            "clientRpm": cfg.edge.client_rpm,
            "appRpm": cfg.edge.app_rpm,
        },
    })
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

pub(crate) const ERROR_STATUSES: &[&str] = &["open", "resolved", "ignored"];

/// The last 24 UTC hour buckets, oldest first (`app_error_hour` keys).
fn error_hour_keys() -> Vec<String> {
    let now = chrono::Utc::now();
    (0..24)
        .rev()
        .map(|h| {
            (now - chrono::Duration::hours(h))
                .format("%Y-%m-%dT%H:00:00Z")
                .to_string()
        })
        .collect()
}

/// Hour rows → a 24-slot series per fingerprint, aligned to
/// `error_hour_keys`.
fn error_series(
    keys: &[String],
    rows: &[(String, String, i64)],
) -> std::collections::HashMap<String, Vec<i64>> {
    let mut out: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for (fp, hour, n) in rows {
        if let Some(i) = keys.iter().position(|k| k == hour) {
            out.entry(fp.clone()).or_insert_with(|| vec![0; 24])[i] += n;
        }
    }
    out
}

fn with_hourly(issue: &crate::models::ErrorIssue, hourly: Vec<i64>) -> serde_json::Value {
    let mut v = serde_json::to_value(issue).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("hourly".into(), serde_json::json!(hourly));
    }
    v
}

/// One status's issues (newest first, each with its 24 h series) plus the
/// per-status counts: the `errors.list` result and the errors stream frame.
pub(crate) async fn error_list(
    pool: &sqlx::SqlitePool,
    app_id: &str,
    status: &str,
) -> sqlx::Result<serde_json::Value> {
    let keys = error_hour_keys();
    let (issues, counts, hours) = tokio::try_join!(
        db::list_error_issues(pool, app_id, status, 200),
        db::count_error_issues(pool, app_id),
        db::list_error_hours(pool, app_id, &keys[0]),
    )?;
    let mut series = error_series(&keys, &hours);
    let issues: Vec<serde_json::Value> = issues
        .into_iter()
        .map(|issue| {
            let hourly = series
                .remove(&issue.fingerprint)
                .unwrap_or_else(|| vec![0; 24]);
            with_hourly(&issue, hourly)
        })
        .collect();
    let count = |s: &str| counts.iter().find(|(k, _)| k == s).map_or(0, |(_, n)| *n);
    Ok(serde_json::json!({
        "issues": issues,
        "counts": {
            "open": count("open"),
            "resolved": count("resolved"),
            "ignored": count("ignored"),
        },
    }))
}

#[allow(clippy::too_many_lines)]
async fn dispatch_call(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
    id: Id,
) -> JsonRpcResponse {
    match method {
        "apps.list" => match db::list_apps(&state.pool).await {
            Ok(apps) => JsonRpcResponse::success(id, apps),
            Err(e) => internal(&id, e.to_string()),
        },
        "apps.create" => {
            #[derive(Deserialize)]
            struct P {
                name: String,
                slug: String,
                user_id: Option<String>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let name = p.name.trim().to_string();
            let slug = p.slug.trim().to_lowercase();
            if name.is_empty() || !slug_ok(&slug) {
                return bad(&id, "invalid name/slug");
            }
            match db::get_app_by_slug(&state.pool, &slug).await {
                Ok(Some(_)) => return conflict(&id, "slug already taken".into()),
                Ok(None) => {}
                Err(e) => return internal(&id, e.to_string()),
            }
            if let Err(e) = purge::purge_slug(&state.config, &state.procs, &state.logs, &slug).await
            {
                return internal(&id, format!("failed to clear slug data: {e:#}"));
            }
            let (listen, internal_port) = match db::next_ports_in(
                &state.pool,
                state.config.fleet_port_min,
                state.config.fleet_port_max,
            )
            .await
            {
                Ok(p) => p,
                Err(e) => return internal(&id, e.to_string()),
            };
            let subdomain = format!("{slug}.{}", state.config.base_domain);
            let owner = p
                .user_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("local");
            if owner != "local" {
                match db::count_apps_for_user(&state.pool, owner).await {
                    Ok(count) if count >= i64::from(state.config.max_apps_per_user) => {
                        return conflict(
                            &id,
                            format!(
                                "app limit reached ({} per account)",
                                state.config.max_apps_per_user
                            ),
                        );
                    }
                    Ok(_) => {}
                    Err(e) => return internal(&id, e.to_string()),
                }
            }
            match db::create_app(
                &state.pool,
                &state.config,
                db::NewApp {
                    internal: internal_port,
                    listen,
                    name: &name,
                    slug: &slug,
                    subdomain: &subdomain,
                    user_id: owner,
                },
            )
            .await
            {
                Ok(app) => JsonRpcResponse::success(id, app),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "apps.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match app(state, &p.id, &id).await {
                Ok(a) => JsonRpcResponse::success(id, a),
                Err(e) => e,
            }
        }
        "apps.get_by_slug" => {
            #[derive(Deserialize)]
            struct P {
                slug: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match db::get_app_by_slug(&state.pool, &p.slug).await {
                Ok(Some(a)) => JsonRpcResponse::success(id, a),
                Ok(None) => not_found(&id, "app not found"),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "apps.patch" => {
            // Unknown keys are refused: a misspelled `desired_state` used to
            // deserialize to None and make the patch a silent no-op.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct P {
                id: String,
                desired_state: Option<String>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if let Some(desired) = p.desired_state.as_deref() {
                let Some(ds) = DesiredState::parse(desired) else {
                    return bad(&id, "desiredState must be running|stopped");
                };
                if let Err(e) = db::patch_app_desired(&state.pool, &p.id, ds.as_str()).await {
                    return internal(&id, e.to_string());
                }
            }
            match app(state, &p.id, &id).await {
                Ok(a) => JsonRpcResponse::success(id, a),
                Err(e) => e,
            }
        }
        "apps.delete" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            if !deploy::claim_wait(&state.deploying, &a.id, Duration::from_secs(120)).await {
                return conflict(&id, "deploy in flight; retry delete shortly".into());
            }
            let purge_result =
                purge::purge_slug(&state.config, &state.procs, &state.logs, &a.slug).await;
            deploy::release(&state.deploying, &a.id).await;
            if let Err(e) = purge_result {
                return internal(&id, format!("failed to purge app data: {e:#}"));
            }
            match db::delete_app(&state.pool, &p.id).await {
                Ok(()) => JsonRpcResponse::success(id, serde_json::json!({ "ok": true })),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "apps.rename" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                name: Option<String>,
                slug: Option<String>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let name = p
                .name
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let slug = p
                .slug
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty());
            if name.is_none() && slug.is_none() {
                return bad(&id, "name or slug required");
            }
            if let Some(ref s) = slug {
                if !slug_ok(s) {
                    return bad(&id, "invalid slug");
                }
                match db::get_app_by_slug(&state.pool, s).await {
                    Ok(Some(other)) if other.id != p.id => {
                        return conflict(&id, "slug already taken".into());
                    }
                    Ok(_) => {}
                    Err(e) => return internal(&id, e.to_string()),
                }
            }
            match rename::rename_app(
                &state.config,
                &state.pool,
                &state.procs,
                &state.logs,
                &state.deploying,
                &p.id,
                name.as_deref(),
                slug.as_deref(),
            )
            .await
            {
                Ok(app) => JsonRpcResponse::success(id, app),
                Err(e) => {
                    let msg = format!("{e:#}");
                    if msg.contains("deploy in flight") {
                        conflict(&id, msg)
                    } else if msg.contains("invalid slug") || msg.contains("app not found") {
                        bad(&id, &msg)
                    } else {
                        internal(&id, msg)
                    }
                }
            }
        }
        "env.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::list_env(&state.pool, &a.id).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "env.set" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                name: String,
                value: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let name = p.name.trim().to_string();
            if !crate::api::env::name_valid(&name) {
                return bad(&id, "name must match [A-Za-z_][A-Za-z0-9_]* (≤64)");
            }
            if p.value.len() > 32 * 1024 {
                return bad(&id, "value exceeds 32 KiB");
            }
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::set_env(&state.pool, &a.id, &name, &p.value).await {
                Ok(()) => {
                    JsonRpcResponse::success(id, serde_json::json!({ "ok": true, "name": name }))
                }
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "env.delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                name: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if !crate::api::env::name_valid(&p.name) {
                return bad(&id, "invalid name");
            }
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::delete_env(&state.pool, &a.id, &p.name).await {
                Ok(()) => JsonRpcResponse::success(id, serde_json::json!({ "ok": true })),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "domains.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match db::list_domains_for(&state.pool, &p.id).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "domains.add" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                hostname: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let hostname = p.hostname.trim().trim_end_matches('.').to_lowercase();
            if !crate::lifecycle::hostname_ok(&hostname) {
                return bad(&id, "invalid hostname");
            }
            let base = state.config.base_domain.to_lowercase();
            let platform = hostname == base
                || hostname.ends_with(&format!(".{base}"))
                || state
                    .config
                    .control_extra_hosts
                    .iter()
                    .any(|h| hostname == h.trim().trim_matches('.').to_lowercase());
            if platform {
                return bad(&id, "hostname belongs to the platform");
            }
            match app(state, &p.id, &id).await {
                Ok(_) => {}
                Err(e) => return e,
            }
            match db::domain_owner(&state.pool, &hostname).await {
                Ok(Some(owner)) if owner != p.id => {
                    return conflict(&id, "hostname is already in use".to_string());
                }
                Ok(_) => {}
                Err(e) => return internal(&id, e.to_string()),
            }
            match db::add_domain(&state.pool, &p.id, &hostname).await {
                Ok(()) => match db::list_domains_for(&state.pool, &p.id).await {
                    Ok(rows) => JsonRpcResponse::success(id, rows),
                    Err(e) => internal(&id, e.to_string()),
                },
                Err(e) => conflict(&id, format!("hostname is already in use: {e}")),
            }
        }
        "domains.remove" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                hostname: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let hostname = p.hostname.trim().to_lowercase();
            match db::remove_domain(&state.pool, &p.id, &hostname).await {
                Ok(0) => not_found(&id, "hostname is not attached to this app"),
                Ok(_) => match db::list_domains_for(&state.pool, &p.id).await {
                    Ok(rows) => JsonRpcResponse::success(id, rows),
                    Err(e) => internal(&id, e.to_string()),
                },
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "limits.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::get_app_limit(&state.pool, &a.id).await {
                Ok(limit) => JsonRpcResponse::success(id, limits_view(&state.config, &limit)),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "limits.set" => {
            // Requests per minute; null = the platform default, 0 = off.
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                id: String,
                client_rpm: Option<i64>,
                app_rpm: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let in_range = |v: Option<i64>| v.is_none_or(|v| (0..=MAX_EDGE_RPM).contains(&v));
            if !in_range(p.client_rpm) || !in_range(p.app_rpm) {
                return bad(
                    &id,
                    &format!("limits must be between 0 and {MAX_EDGE_RPM} requests per minute"),
                );
            }
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let limit = AppLimit {
                app_id: a.id.clone(),
                client_rpm: p.client_rpm,
                app_rpm: p.app_rpm,
            };
            if let Err(e) = db::set_app_limit(&state.pool, &limit).await {
                return internal(&id, e.to_string());
            }
            JsonRpcResponse::success(id, limits_view(&state.config, &limit))
        }
        "errors.list" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                status: Option<String>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let status = p.status.unwrap_or_else(|| "open".into());
            if !ERROR_STATUSES.contains(&status.as_str()) {
                return bad(&id, "status must be open, resolved or ignored");
            }
            let app_id = match telemetry_target(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match error_list(&state.pool, &app_id, &status).await {
                Ok(list) => JsonRpcResponse::success(id, list),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "errors.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                fingerprint: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let app_id = match telemetry_target(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let issue = match db::get_error_issue(&state.pool, &app_id, &p.fingerprint).await {
                Ok(Some(i)) => i,
                Ok(None) => return not_found(&id, "error not found"),
                Err(e) => return internal(&id, e.to_string()),
            };
            let keys = error_hour_keys();
            let (events, hours) = match tokio::try_join!(
                db::list_error_events(&state.pool, &app_id, &p.fingerprint),
                db::list_error_hours(&state.pool, &app_id, &keys[0]),
            ) {
                Ok(r) => r,
                Err(e) => return internal(&id, e.to_string()),
            };
            let hourly = error_series(&keys, &hours)
                .remove(&issue.fingerprint)
                .unwrap_or_else(|| vec![0; 24]);
            let events: Vec<serde_json::Value> = events
                .into_iter()
                .map(|e| {
                    let frames: serde_json::Value =
                        serde_json::from_str(&e.frames).unwrap_or_else(|_| serde_json::json!([]));
                    let logs: serde_json::Value =
                        serde_json::from_str(&e.logs).unwrap_or_else(|_| serde_json::json!([]));
                    serde_json::json!({
                        "tsUs": e.ts_us,
                        "traceId": e.trace_id,
                        "source": e.source,
                        "handler": e.handler,
                        "cell": e.cell,
                        "kind": e.kind,
                        "message": e.message,
                        "context": e.context,
                        "frames": frames,
                        "logs": logs,
                        "method": e.method,
                        "path": e.path,
                        "httpStatus": e.http_status,
                        "browser": e.browser,
                        "os": e.os,
                        "sha": e.sha,
                    })
                })
                .collect();
            JsonRpcResponse::success(
                id,
                serde_json::json!({ "issue": with_hourly(&issue, hourly), "events": events }),
            )
        }
        "errors.set_status" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                fingerprint: String,
                status: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if !ERROR_STATUSES.contains(&p.status.as_str()) {
                return bad(&id, "status must be open, resolved or ignored");
            }
            let app_id = match telemetry_target(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let now = crate::host::metrics::now_us();
            match db::set_error_status(&state.pool, &app_id, &p.fingerprint, &p.status, now).await {
                Ok(0) => not_found(&id, "error not found"),
                Ok(_) => JsonRpcResponse::success(id, serde_json::json!({ "ok": true })),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "deploys.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match db::list_deploys(&state.pool, &p.id).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "deploys.log" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                deploy_id: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::get_deploy_log(&state.pool, &a.id, p.deploy_id.trim()).await {
                Ok(Some(log)) => JsonRpcResponse::success(id, serde_json::json!({ "log": log })),
                Ok(None) => not_found(&id, "deploy not found"),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "deploys.rollback" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                sha: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let sha = p.sha.trim().to_lowercase();
            if !crate::api::deploys::sha_valid(&sha) {
                return bad(&id, "sha must be 7-40 hex chars");
            }
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match db::get_success_deploy(&state.pool, &a.id, &sha).await {
                Ok(Some(_)) => {}
                Ok(None) => return not_found(&id, "no successful deploy at that sha"),
                Err(e) => return internal(&id, e.to_string()),
            }
            let pool = state.pool.clone();
            let cfg = state.config.clone();
            let procs = state.procs.clone();
            let logs = state.logs.clone();
            let deploying = state.deploying.clone();
            let key = format!("git/{}/refs/heads/main/{sha}.bundle", a.slug);
            let sha_resp = sha.clone();
            tokio::spawn(async move {
                deploy::deploy_app(&pool, &cfg, &procs, &logs, &deploying, a, &key, Some(&sha))
                    .await;
            });
            JsonRpcResponse::success(id, serde_json::json!({ "ok": true, "sha": sha_resp }))
        }
        "git.remote" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            JsonRpcResponse::success(
                id,
                crate::api::git::GitRemote {
                    remote: state.config.git_http_remote(&a.slug),
                    url: state.config.git_http_url(&a.slug),
                    username: "git".into(),
                    s3_remote: state.config.s3_git_remote(&a.slug),
                    endpoint: state.config.s3_public_endpoint.clone(),
                    bucket: state.config.s3_bucket.clone(),
                    prefix: a.git_prefix,
                },
            )
        }
        "source.tree" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match api_source::app_with_rev(state, &p.id).await {
                Ok(Some((a, rev))) => match source::list_tree(&state.config, &a, &rev).await {
                    Ok(t) => JsonRpcResponse::success(id, t),
                    Err(e) => conflict(&id, format!("{e:#}")),
                },
                Ok(None) => not_found(&id, "app not found"),
                Err(e) => conflict(&id, e),
            }
        }
        "source.blob" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                path: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match api_source::app_with_rev(state, &p.id).await {
                Ok(Some((a, rev))) => {
                    match source::read_blob(&state.config, &a, &rev, &p.path).await {
                        Ok(b) => JsonRpcResponse::success(id, b),
                        Err(e) => not_found(&id, &e.to_string()),
                    }
                }
                Ok(None) => not_found(&id, "app not found"),
                Err(e) => conflict(&id, e),
            }
        }
        "source.diff" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            match api_source::app_with_rev(state, &p.id).await {
                Ok(Some((a, rev))) => match source::make_patch(&state.config, &a, &rev).await {
                    Ok(d) => JsonRpcResponse::success(id, d),
                    Err(e) => conflict(&id, format!("{e:#}")),
                },
                Ok(None) => not_found(&id, "app not found"),
                Err(e) => conflict(&id, e),
            }
        }
        "source.commit" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                files: Vec<api_source::SourceCommitFile>,
                message: String,
                author: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let files: Vec<web_commit::WebFile> = p
                .files
                .into_iter()
                .map(|f| web_commit::WebFile {
                    path: f.path,
                    content: f.content,
                })
                .collect();
            match web_commit::web_commit(state, &a, &p.author, &p.message, &files).await {
                Ok(sha) => JsonRpcResponse::success(id, serde_json::json!({"sha": sha})),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "metrics.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                hours: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let app_id = match telemetry_target(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let hours = p.hours.unwrap_or(24).clamp(1, 720);
            let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
                .format("%Y-%m-%dT%H:%M:00Z")
                .to_string();
            match db::list_app_metrics(&state.pool, &app_id, &since).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "events.list" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                channel: Option<String>,
                limit: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if app(state, &p.id, &id).await.is_err() {
                return not_found(&id, "app not found");
            }
            let limit = p.limit.unwrap_or(50).clamp(1, 200);
            let channel = p
                .channel
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty());
            match db::list_app_events(&state.pool, &p.id, channel, limit).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "events.channels" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if app(state, &p.id, &id).await.is_err() {
                return not_found(&id, "app not found");
            }
            match db::list_app_channels(&state.pool, &p.id).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "events.insights" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if app(state, &p.id, &id).await.is_err() {
                return not_found(&id, "app not found");
            }
            match db::list_app_insights(&state.pool, &p.id).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "events.user_props" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                user_id: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            if app(state, &p.id, &id).await.is_err() {
                return not_found(&id, "app not found");
            }
            match db::get_app_user_props(&state.pool, &p.id, p.user_id.trim()).await {
                Ok(row) => JsonRpcResponse::success(id, row),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "spans.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                hours: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let app_id = match telemetry_target(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let hours = p.hours.unwrap_or(24).clamp(1, 720);
            let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
                .format("%Y-%m-%dT%H:00:00Z")
                .to_string();
            match db::list_span_stats(&state.pool, &app_id, &since).await {
                Ok(spans) => JsonRpcResponse::success(id, spans),
                Err(e) => internal(&id, e.to_string()),
            }
        }
        "logs.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let (app_id, slug) = match crate::api::observe::telemetry_target(&state.pool, &p.id)
                .await
            {
                Ok(Some(target)) => target,
                Ok(None) => return not_found(&id, "app not found"),
                Err(e) => return internal(&id, e.to_string()),
            };
            let lines = super::observe::merged_lines(state, &app_id, &slug).await;
            JsonRpcResponse::success(id, lines)
        }
        "storage.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::list_storage(&state.config, &a).await {
                Ok(items) => JsonRpcResponse::success(id, items),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.tables" => {
            let p: storage::d1::D1TablesParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::d1_tables(&state.config, &a, &p.database_id).await {
                Ok(t) => JsonRpcResponse::success(id, t),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.schema" => {
            let p: storage::d1::D1SchemaParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::d1_schema(&state.config, &a, &p.database_id, &p.table).await {
                Ok(s) => JsonRpcResponse::success(id, s),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.rows" => {
            let p: storage::d1::D1RowsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::d1_rows(&state.config, &a, &p.database_id, &p.query).await {
                Ok(rows) => JsonRpcResponse::success(id, rows),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.write" => {
            let p: storage::d1::D1WriteParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::d1_write(
                &state.config,
                &a,
                &p.database_id,
                &p.body.op,
                &p.body.table,
                &p.body.values,
                &p.body.key,
            )
            .await
            {
                Ok(()) => JsonRpcResponse::success(id, serde_json::json!({"ok": true})),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.delete_rows" => {
            let p: storage::d1::D1DeleteRowsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::d1_delete_rows(&state.config, &a, &p.database_id, &p.table, &p.keys)
                .await
            {
                Ok(deleted) => JsonRpcResponse::success(
                    id,
                    serde_json::json!({"ok": true, "deleted": deleted}),
                ),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.do.list" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                class_name: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::do_instances(&state.config, &a, &p.class_name).await {
                Ok(v) => JsonRpcResponse::success(id, v),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.r2.list" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                bucket: String,
                #[serde(default)]
                prefix: String,
                #[serde(default)]
                cursor: Option<String>,
                #[serde(default)]
                limit: Option<usize>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let limit = p.limit.unwrap_or(storage::r2::R2_PAGE_LIMIT);
            match storage::r2_list(
                &state.config,
                &a,
                &p.bucket,
                &p.prefix,
                p.cursor.as_deref(),
                limit,
            )
            .await
            {
                Ok(v) => JsonRpcResponse::success(id, v),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.r2.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                bucket: String,
                key: String,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::r2_get(&state.config, &a, &p.bucket, &p.key).await {
                Ok(v) => JsonRpcResponse::success(id, v),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.r2.delete" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                bucket: String,
                keys: Vec<String>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::r2_delete_many(&state.config, &a, &p.bucket, &p.keys).await {
                Ok(deleted) => JsonRpcResponse::success(
                    id,
                    serde_json::json!({ "ok": true, "deleted": deleted }),
                ),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        m => rpc_err(
            id,
            JsonRpcErrorReason::MethodNotFound,
            format!("unknown method: {m}"),
        ),
    }
}
