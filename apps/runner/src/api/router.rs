//! The runner's REST route table and its two ambient middlewares: bearer auth
//! (`auth::require_bearer`) and the dirty-state marker (`state_sync.mark_dirty`
//! on a successful mutating `/v1/` call). Boot hands the built router to
//! `axum::serve`.

use axum::{
    middleware,
    routing::{delete, get, post},
    Router,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::api;
use crate::auth;
use crate::host;
use crate::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(api::health))
        .route("/ready", get(api::ready))
        .route("/v1/admin/snapshot", post(api::snapshot))
        .route("/v1/edge/fallback", get(host::edge::edge_fallback))
        .route("/v1/edge/tls-ask", get(host::edge::tls_ask))
        .route("/v1/edge/wake", get(host::edge::wake))
        .route("/v1/admin/stats", get(api::stats))
        .route(
            "/v1/admin/telemetry",
            get(api::get_telemetry).put(api::set_telemetry),
        )
        .route("/v1/apps", get(api::list_apps).post(api::create_app))
        .route(
            "/v1/apps/{id}",
            get(api::get_app)
                .patch(api::patch_app)
                .delete(api::delete_app),
        )
        .route("/v1/apps/{id}/rename", post(api::rename_app))
        .route("/v1/apps/{id}/sleep", post(api::sleep_app))
        .route(
            "/v1/apps/{id}/domains",
            get(api::list_domains).post(api::add_domain),
        )
        .route(
            "/v1/apps/{id}/domains/{hostname}",
            delete(api::remove_domain),
        )
        .route("/v1/apps/{id}/deploys", get(api::list_deploys))
        .route(
            "/v1/apps/{id}/deploys/{deploy_id}/log",
            get(api::deploy_log),
        )
        .route("/v1/apps/{id}/rollback", post(api::rollback))
        .route(
            "/v1/apps/{id}/deploys/stream",
            get(api::list_deploys_stream),
        )
        .route("/v1/apps/{id}/git-remote", post(api::git_remote))
        .route("/v1/apps/{id}/tree", get(api::source_tree))
        .route("/v1/apps/{id}/blob/{*path}", get(api::source_blob))
        .route("/v1/apps/{id}/diff", get(api::source_diff))
        .route("/v1/apps/{id}/metrics", get(api::app_metrics))
        .route("/v1/apps/{id}/devices", get(api::app_devices))
        .route("/v1/apps/{id}/paths", get(api::app_paths))
        .route("/v1/apps/{id}/refs", get(api::app_refs))
        .route(
            "/v1/apps/{id}/metrics/version",
            get(api::app_metrics_version),
        )
        .route("/v1/apps/{id}/errors/stream", get(api::list_errors_stream))
        .route("/v1/apps/{id}/spans", get(api::app_spans))
        .route(
            "/v1/apps/{id}/events",
            get(api::list_events).post(api::log_event),
        )
        .route("/v1/apps/{id}/events/stream", get(api::list_events_stream))
        .route("/v1/apps/{id}/events/channels", get(api::list_channels))
        .route("/v1/apps/{id}/identify", post(api::identify_user))
        .route(
            "/v1/apps/{id}/users/{user_id}/props",
            get(api::get_user_props),
        )
        .route(
            "/v1/apps/{id}/insights",
            get(api::list_insights).post(api::set_insight),
        )
        .route("/v1/apps/{id}/logs", get(api::app_logs))
        .route("/v1/apps/{id}/logs/stream", get(api::app_logs_stream))
        .route("/v1/apps/{id}/storage", get(api::app_storage))
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/tables",
            get(api::app_d1_tables),
        )
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/tables/{table}/schema",
            get(api::app_d1_schema),
        )
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/tables/{table}/rows",
            post(api::app_d1_rows),
        )
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/write",
            post(api::app_d1_write),
        )
        .route(
            "/v1/apps/{id}/storage/d1/{database_id}/delete-rows",
            post(api::app_d1_delete_rows),
        )
        .route("/v1/apps/{id}/source/commit", post(api::app_source_commit))
        .route("/v1/apps/{id}/storage/do/{class_name}", get(api::app_do))
        .route("/v1/apps/{id}/storage/r2/{bucket}", get(api::app_r2))
        .route(
            "/v1/apps/{id}/storage/r2/{bucket}/object",
            get(api::app_r2_object)
                .put(api::app_r2_put)
                .delete(api::app_r2_delete),
        )
        .route(
            "/v1/apps/{id}/storage/r2/{bucket}/raw",
            get(api::app_r2_raw),
        )
        .route("/v1/apps/{id}/env", get(api::list_env).post(api::set_env))
        .route("/v1/apps/{id}/env/{name}", delete(api::delete_env))
        .route("/rpc", post(api::handle_rpc))
        .route("/v1/git/{slug}/info/refs", get(host::git_http::info_refs))
        .route(
            "/v1/git/{slug}/git-upload-pack",
            post(host::git_http::upload_pack),
        )
        .route(
            "/v1/git/{slug}/git-receive-pack",
            post(host::git_http::receive_pack),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            |axum::extract::State(s): axum::extract::State<AppState>, req, next| async move {
                auth::require_bearer(s, req, next).await
            },
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            |axum::extract::State(s): axum::extract::State<AppState>,
             req: axum::http::Request<axum::body::Body>,
             next: axum::middleware::Next| async move {
                let dirty = matches!(
                    req.method(),
                    &axum::http::Method::POST
                        | &axum::http::Method::PATCH
                        | &axum::http::Method::PUT
                        | &axum::http::Method::DELETE
                ) && req.uri().path().starts_with("/v1/");
                let resp = next.run(req).await;
                if dirty && resp.status().is_success() {
                    s.state_sync.mark_dirty();
                }
                resp
            },
        ))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
