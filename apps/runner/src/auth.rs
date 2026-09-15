use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use constant_time_eq::constant_time_eq;

use crate::AppState;

pub async fn require_bearer(state: AppState, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    // Health is public. Git smart-HTTP uses its own Basic auth per slug.
    // /webhook stays bearer-gated (deploy nudge / optional S3 notify).
    // The edge fallback page does its own lookup and carries no secrets.
    // The TLS ask gate is likewise public: Caddy calls it without
    // credentials and it only answers whether a hostname may have a cert.
    if path == "/health"
        || path.starts_with("/v1/git/")
        || path == "/v1/edge/fallback"
        || path == "/v1/edge/tls-ask"
    {
        return next.run(req).await;
    }

    let expected = state.config.runner_token.as_bytes();
    let ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| constant_time_eq(t.as_bytes(), expected))
        .unwrap_or(false)
        || req
            .headers()
            .get("x-runner-token")
            .or_else(|| req.headers().get("x-host-token"))
            .or_else(|| req.headers().get("x-agent-token"))
            .and_then(|v| v.to_str().ok())
            .map(|t| constant_time_eq(t.as_bytes(), expected))
            .unwrap_or(false);

    if !ok {
        return (StatusCode::UNAUTHORIZED, "bearer token required").into_response();
    }
    next.run(req).await
}
