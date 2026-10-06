//! JSON-RPC surface: POST /rpc serves single calls and batch arrays. Every
//! method decodes params, calls a `crate::service` function and maps its
//! `ApiError` back onto a JSON-RPC error — there is no domain logic here.
//! Bearer-gated like /v1/*. Stays REST: SSE streams, git smart-HTTP,
//! edge/tls-ask, webhook, health/ready, and the binary r2_raw download.
use axum::{extract::State, response::IntoResponse, Json};
use axum_jrpc::error::{JsonRpcError, JsonRpcErrorReason};
use axum_jrpc::{Id, JsonRpcResponse};
use serde::Deserialize;
use serde_json::json;

use crate::api_error::ApiError;
use crate::host::storage;
use crate::service;
use crate::AppState;

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

/// Encode one service result: the JSON-RPC mirror of `ApiError`'s HTTP status
/// (400/404/409, `InternalError` for 500).
fn complete<T: serde::Serialize>(id: Id, result: Result<T, ApiError>) -> JsonRpcResponse {
    match result {
        Ok(value) => JsonRpcResponse::success(id, value),
        Err(ApiError::BadRequest(message)) => bad(&id, &message),
        Err(ApiError::NotFound(message)) => not_found(&id, &message),
        Err(ApiError::Conflict(message)) => conflict(&id, message),
        Err(ApiError::Internal(message)) => internal(&id, message),
    }
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

#[derive(Deserialize)]
struct IdParams {
    id: String,
}

/// Params for the few methods whose RPC shape is not just `{id, ...}`.
#[derive(Deserialize)]
struct CreateParams {
    name: String,
    slug: String,
    #[serde(default)]
    user_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchParams {
    id: String,
    desired_state: Option<String>,
}

#[derive(Deserialize)]
struct RenameParams {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Deserialize)]
struct EnvSetParams {
    id: String,
    name: String,
    value: String,
}

#[derive(Deserialize)]
struct EnvDeleteParams {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct HostnameParams {
    id: String,
    hostname: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitsParams {
    id: String,
    client_rpm: Option<i64>,
    app_rpm: Option<i64>,
}

#[derive(Deserialize)]
struct StatusParams {
    id: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Deserialize)]
struct FingerprintParams {
    id: String,
    fingerprint: String,
}

#[derive(Deserialize)]
struct ErrorStatusParams {
    id: String,
    fingerprint: String,
    status: String,
}

#[derive(Deserialize)]
struct RollbackParams {
    id: String,
    sha: String,
}

#[derive(Deserialize)]
struct DeployLogParams {
    id: String,
    deploy_id: String,
}

#[derive(Deserialize)]
struct SourceBlobParams {
    id: String,
    path: String,
}

#[derive(Deserialize)]
struct CommitParams {
    id: String,
    #[serde(flatten)]
    body: service::source::SourceCommitBody,
}

#[derive(Deserialize)]
struct HoursParams {
    id: String,
    #[serde(default)]
    hours: Option<i64>,
}

#[derive(Deserialize)]
struct UserPropsParams {
    id: String,
    user_id: String,
}

#[derive(Deserialize)]
struct ClassParams {
    id: String,
    class_name: String,
}

#[derive(Deserialize)]
struct R2ListParams {
    id: String,
    bucket: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct R2KeyParams {
    id: String,
    bucket: String,
    key: String,
}

#[derive(Deserialize)]
struct R2DeleteParams {
    id: String,
    bucket: String,
    keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TelemetrySetParams {
    enabled: bool,
}

#[allow(clippy::too_many_lines)]
async fn dispatch_call(
    state: &AppState,
    method: &str,
    params: serde_json::Value,
    id: Id,
) -> JsonRpcResponse {
    match method {
        "apps.list" => complete(id, service::apps::list(state).await),
        "apps.create" => {
            let p: CreateParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::apps::create(state, &p.name, &p.slug, p.user_id.as_deref()).await,
            )
        }
        "apps.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::apps::get(state, &p.id).await)
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
            complete(id, service::apps::get_by_slug(state, &p.slug).await)
        }
        "apps.patch" => {
            // Unknown keys are refused: a misspelled `desired_state` used to
            // deserialize to None and make the patch a silent no-op.
            let p: PatchParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::apps::patch(state, &p.id, p.desired_state.as_deref()).await,
            )
        }
        "apps.delete" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::apps::delete(state, &p.id)
                    .await
                    .map(|()| json!({ "ok": true })),
            )
        }
        "apps.rename" => {
            let p: RenameParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::apps::rename(state, &p.id, p.name.as_deref(), p.slug.as_deref()).await,
            )
        }
        "env.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::env::list(state, &p.id).await)
        }
        "env.set" => {
            let p: EnvSetParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::env::set(state, &p.id, &p.name, &p.value)
                    .await
                    .map(|name| json!({ "ok": true, "name": name })),
            )
        }
        "env.delete" => {
            let p: EnvDeleteParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::env::delete(state, &p.id, &p.name)
                    .await
                    .map(|()| json!({ "ok": true })),
            )
        }
        "domains.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::domains::list(state, &p.id).await)
        }
        "domains.add" => {
            let p: HostnameParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::domains::add(state, &p.id, &p.hostname).await)
        }
        "domains.remove" => {
            let p: HostnameParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::domains::remove(state, &p.id, &p.hostname).await,
            )
        }
        "limits.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::limits::get(state, &p.id).await)
        }
        "limits.set" => {
            let p: LimitsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::limits::set(state, &p.id, p.client_rpm, p.app_rpm).await,
            )
        }
        "errors.list" => {
            let p: StatusParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let status = p.status.unwrap_or_else(|| "open".into());
            complete(id, service::errors::list_for(state, &p.id, &status).await)
        }
        "errors.get" => {
            let p: FingerprintParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::errors::get(state, &p.id, &p.fingerprint).await)
        }
        "errors.set_status" => {
            let p: ErrorStatusParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::errors::set_status(state, &p.id, &p.fingerprint, &p.status)
                    .await
                    .map(|()| json!({ "ok": true })),
            )
        }
        "deploys.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::deploys::list(state, &p.id).await)
        }
        "deploys.log" => {
            let p: DeployLogParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::deploys::log(state, &p.id, &p.deploy_id)
                    .await
                    .map(|log| json!({ "log": log })),
            )
        }
        "deploys.rollback" => {
            let p: RollbackParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::deploys::rollback(state, &p.id, &p.sha)
                    .await
                    .map(|sha| json!({ "ok": true, "sha": sha })),
            )
        }
        "git.remote" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::git::remote(state, &p.id).await)
        }
        "source.tree" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::source::tree(state, &p.id).await)
        }
        "source.blob" => {
            let p: SourceBlobParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::source::blob(state, &p.id, &p.path).await)
        }
        "source.diff" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::source::diff(state, &p.id).await)
        }
        "source.commit" => {
            let p: CommitParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::source::commit(state, &p.id, &p.body)
                    .await
                    .map(|sha| json!({ "sha": sha })),
            )
        }
        "metrics.get" => {
            let p: HoursParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::observe::metrics(state, &p.id, p.hours).await)
        }
        "spans.get" => {
            let p: HoursParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::observe::spans(state, &p.id, p.hours).await)
        }
        "logs.get" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::observe::logs_lines(state, &p.id).await)
        }
        "events.list" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                #[serde(default)]
                channel: Option<String>,
                #[serde(default)]
                limit: Option<i64>,
            }
            let p: P = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::events::list(state, &p.id, p.channel.as_deref(), p.limit).await,
            )
        }
        "events.channels" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::events::channels(state, &p.id).await)
        }
        "events.insights" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::events::insights(state, &p.id).await)
        }
        "events.user_props" => {
            let p: UserPropsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::events::user_props(state, &p.id, &p.user_id).await,
            )
        }
        "storage.list" => {
            let p: IdParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::storage::list(state, &p.id).await)
        }
        "storage.d1.tables" => {
            let p: storage::d1::D1TablesParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::d1_tables(state, &p.id, &p.database_id).await,
            )
        }
        "storage.d1.schema" => {
            let p: storage::d1::D1SchemaParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::d1_schema(state, &p.id, &p.database_id, &p.table).await,
            )
        }
        "storage.d1.rows" => {
            let p: storage::d1::D1RowsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::d1_rows(state, &p.id, &p.database_id, &p.query).await,
            )
        }
        "storage.d1.write" => {
            let p: storage::d1::D1WriteParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::d1_write(
                    state,
                    &p.id,
                    &p.database_id,
                    p.body.op.as_str(),
                    &p.body.table,
                    &p.body.values,
                    &p.body.key,
                )
                .await
                .map(|()| json!({ "ok": true })),
            )
        }
        "storage.d1.delete_rows" => {
            let p: storage::d1::D1DeleteRowsParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::d1_delete_rows(
                    state,
                    &p.id,
                    &p.database_id,
                    &p.table,
                    &p.keys,
                )
                .await
                .map(|deleted| json!({ "ok": true, "deleted": deleted })),
            )
        }
        "storage.do.list" => {
            let p: ClassParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::do_instances(state, &p.id, &p.class_name).await,
            )
        }
        "storage.r2.list" => {
            let p: R2ListParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            let limit = p.limit.unwrap_or(storage::r2::R2_PAGE_LIMIT);
            complete(
                id,
                service::storage::r2_list(
                    state,
                    &p.id,
                    &p.bucket,
                    &p.prefix,
                    p.cursor.as_deref(),
                    limit,
                )
                .await,
            )
        }
        "storage.r2.get" => {
            let p: R2KeyParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::r2_get(state, &p.id, &p.bucket, &p.key).await,
            )
        }
        "storage.r2.delete" => {
            let p: R2DeleteParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(
                id,
                service::storage::r2_delete_many(state, &p.id, &p.bucket, &p.keys)
                    .await
                    .map(|deleted| json!({ "ok": true, "deleted": deleted })),
            )
        }
        "telemetry.get" => complete(id, service::telemetry::get(state).await),
        "telemetry.set" => {
            let p: TelemetrySetParams = match parse(params, &id) {
                Ok(p) => p,
                Err(e) => return e,
            };
            complete(id, service::telemetry::set(state, p.enabled).await)
        }
        m => rpc_err(
            id,
            JsonRpcErrorReason::MethodNotFound,
            format!("unknown method: {m}"),
        ),
    }
}
