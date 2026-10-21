//! Custom hostnames: list, add, verify, remove (thin adapters over
//! `service::domains`).
//!
//! Only verified claims reach the edge — `host/caddy.rs` writes routes for
//! them and `host/edge.rs` mints certificates through them. A pending claim
//! is invisible to routing, TLS and the fallback page. Hostname grammar,
//! platform-host refusal, the collision mapping and the role gates live in
//! the service layer so the RPC surface cannot drift.
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json,
};

use super::environments::RoleQuery;
use crate::service;
use crate::AppState;

#[derive(Debug, serde::Deserialize)]
pub struct AddDomain {
    pub hostname: String,
}

pub async fn list_domains(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::domains::list(&state, &app_id, q.role.as_deref())
        .await
        .map(Json)
}

pub async fn add_domain(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    Query(q): Query<RoleQuery>,
    Json(body): Json<AddDomain>,
) -> impl IntoResponse {
    service::domains::add(&state, &app_id, &body.hostname, q.role.as_deref())
        .await
        .map(Json)
}

pub async fn verify_domain(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    Query(q): Query<RoleQuery>,
    Json(body): Json<AddDomain>,
) -> impl IntoResponse {
    service::domains::verify(&state, &app_id, &body.hostname, q.role.as_deref())
        .await
        .map(Json)
}

pub async fn remove_domain(
    State(state): State<AppState>,
    Path((app_id, hostname)): Path<(String, String)>,
    Query(q): Query<RoleQuery>,
) -> impl IntoResponse {
    service::domains::remove(&state, &app_id, &hostname, q.role.as_deref())
        .await
        .map(Json)
}
