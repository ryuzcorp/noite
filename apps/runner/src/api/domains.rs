//! Custom hostnames: list, add, remove (thin adapters over `service::domains`).
//!
//! One hostname belongs to exactly one app (`app_domain.hostname` is the
//! primary key), and the edge only serves it while its app is deployed and
//! running. Hostname grammar, platform-host refusal and the conflict mapping
//! live in the service layer so the RPC surface cannot drift.
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};

use crate::service;
use crate::AppState;

#[derive(Debug, serde::Deserialize)]
pub struct AddDomain {
    pub hostname: String,
}

pub async fn list_domains(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
) -> impl IntoResponse {
    service::domains::list(&state, &app_id).await.map(Json)
}

pub async fn add_domain(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    Json(body): Json<AddDomain>,
) -> impl IntoResponse {
    service::domains::add(&state, &app_id, &body.hostname)
        .await
        .map(Json)
}

pub async fn remove_domain(
    State(state): State<AppState>,
    Path((app_id, hostname)): Path<(String, String)>,
) -> impl IntoResponse {
    service::domains::remove(&state, &app_id, &hostname)
        .await
        .map(Json)
}
