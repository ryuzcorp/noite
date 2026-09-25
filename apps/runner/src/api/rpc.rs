//! JSON-RPC surface: POST /rpc serves single calls and batch arrays,
//! dispatching CRUD methods that mirror the REST handlers. Bearer-gated
//! like /v1/*. Stays REST: SSE streams, git smart-HTTP, edge/tls-ask,
//! webhook, health/ready, and the binary r2_raw download.
use std::collections::BTreeMap;
use std::time::Duration;

use axum::{extract::State, response::IntoResponse, Json};
use axum_jrpc::error::{JsonRpcError, JsonRpcErrorReason};
use axum_jrpc::{Id, JsonRpcResponse};
use serde::Deserialize;

use crate::api::source as api_source;
use crate::host::{deploy, logs, metrics, purge, rename, source, storage, web_commit};
use crate::lifecycle::slug_ok;
use crate::models::{App, DesiredState};
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
    rpc_err(id.clone(), JsonRpcErrorReason::ApplicationError(409), message)
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
        return rpc_err(id, JsonRpcErrorReason::InvalidRequest, "missing method".into());
    };
    dispatch_call(state, &method, call.params, id).await
}

#[derive(Deserialize)]
struct IdParams {
    id: String,
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
                Ok(Some(existing))
                    if existing.desired_state == "deleted"
                        || existing.status == "deleting"
                        || existing.status == "gone" =>
                {
                    if let Err(e) = db::delete_app(&state.pool, &existing.id).await {
                        return internal(&id, format!("failed to reclaim slug row: {e}"));
                    }
                }
                Ok(Some(_)) => return conflict(&id, "slug already taken".into()),
                Ok(None) => {}
                Err(e) => return internal(&id, e.to_string()),
            }
            if let Err(e) = purge::purge_slug(&state.config, &state.procs, &state.logs, &slug).await
            {
                return internal(&id, format!("failed to clear slug data: {e:#}"));
            }
            let (listen, internal_port) =
                match db::next_ports(&state.pool, state.config.port_base).await {
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
                            format!("app limit reached ({} per account)", state.config.max_apps_per_user),
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
                Ok(app) => {
                    JsonRpcResponse::success(id, app)
                }
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
        "apps.patch" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
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
                Ok(()) => {
                    JsonRpcResponse::success(id, serde_json::json!({ "ok": true }))
                }
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
            let name = p.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
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
                Ok(()) => {
                    JsonRpcResponse::success(id, serde_json::json!({ "ok": true }))
                }
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
                deploy::deploy_app(&pool, &cfg, &procs, &logs, &deploying, a, &key, Some(&sha)).await;
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
                .map(|f| web_commit::WebFile { path: f.path, content: f.content })
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
            if app(state, &p.id, &id).await.is_err() {
                return not_found(&id, "app not found");
            }
            let hours = p.hours.unwrap_or(24).clamp(1, 336);
            let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
                .format("%Y-%m-%dT%H:%M:00Z")
                .to_string();
            match db::list_app_metrics(&state.pool, &p.id, &since).await {
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
            let channel = p.channel.as_deref().map(str::trim).filter(|c| !c.is_empty());
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
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let hours = p.hours.unwrap_or(1).clamp(1, 24);
            let since = metrics::now_us_pub() - hours * 3_600_000_000;
            let spans = metrics::top_spans(&state.config, &a.slug, since).await;
            JsonRpcResponse::success(id, spans)
        }
        "logs.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let mut lines = metrics::recent_logs(&state.config, &a.slug, 500).await;
            lines.extend(logs::tail(&state.logs, &a.slug, 500).await);
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
        "storage.d1.get" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                database_id: String,
                rows: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let limit = (p.rows.unwrap_or(20) as usize).clamp(1, 100);
            match storage::d1_preview(&state.config, &a, &p.database_id, limit).await {
                Ok(pv) => JsonRpcResponse::success(id, pv),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        "storage.d1.write" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                database_id: String,
                table: String,
                op: String,
                values: BTreeMap<String, Option<String>>,
                key: Option<BTreeMap<String, Option<String>>>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            let key = p.key.unwrap_or_default();
            match storage::d1_write(&state.config, &a, &p.database_id, &p.table, &p.op, &p.values, &key)
                .await
            {
                Ok(()) => JsonRpcResponse::success(id, serde_json::json!({"ok": true})),
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
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let a = match app(state, &p.id, &id).await {
                Ok(a) => a,
                Err(e) => return e,
            };
            match storage::r2_list(&state.config, &a, &p.bucket, 100).await {
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
            match storage::r2_delete(&state.config, &a, &p.bucket, &p.key).await {
                Ok(()) => JsonRpcResponse::success(id, serde_json::json!({ "ok": true })),
                Err(e) => conflict(&id, format!("{e:#}")),
            }
        }
        m => rpc_err(id, JsonRpcErrorReason::MethodNotFound, format!("unknown method: {m}")),
    }
}
