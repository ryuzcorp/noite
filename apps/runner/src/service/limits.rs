//! Per-app limits (`limits.*` RPC; the settings panel's source): edge rate
//! limits and the fleet memory cap override.

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::config::Config;
use crate::db;
use crate::models::AppLimit;
use crate::AppState;

use super::apps::app_or_404;
use super::environments::role_ok;

/// Enforce the one admin gate. A missing role is a refusal, never a default:
/// the caller (the control UI) always knows its role, and an unknown caller
/// must not inherit rights. Same semantics as `service::domains::require`.
fn require(role: Option<&str>, need: &str) -> Result<(), ApiError> {
    match role {
        Some(role) if role_ok(role, need) => Ok(()),
        Some(role) => Err(ApiError::forbidden(format!(
            "role {role:?} may not {need} this app's limits"
        ))),
        None => Err(ApiError::forbidden(format!(
            "the {need} role is required for this operation"
        ))),
    }
}

/// Ceiling on a per-app edge limit (requests per minute): past this the
/// module's per-client ring buffer stops being small.
const MAX_EDGE_RPM: i64 = 600_000;

/// Bounds on a per-app fleet memory cap in MiB: below the floor celld cannot
/// boot, so a typo'd `1` refuses loudly instead of OOM-looping the fleet.
const MIN_FLEET_MEMORY_MB: i64 = 64;
const MAX_FLEET_MEMORY_MB: i64 = 1_048_576;

/// The platform defaults an app's limits fall back to, plus the per-app
/// memory ceiling the Settings input enforces.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LimitDefaults {
    pub client_rpm: u32,
    pub app_rpm: u32,
    pub memory_mb: u32,
    /// `Some` ceiling in `multi` (a tenant can only lower its cap);
    /// `None` in `single`, where the operator is the only admin.
    pub memory_max_mb: Option<u32>,
}

/// An app's limits as the settings panel shows them: its own values
/// (null = default) beside the platform defaults they fall back to.
/// `perClient` is false behind a proxy the edge does not trust, where
/// per-client limits cannot apply (`Config::edge_sees_clients`).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LimitsView {
    pub client_rpm: Option<i64>,
    pub app_rpm: Option<i64>,
    pub memory_mb: Option<i64>,
    pub per_client: bool,
    pub defaults: LimitDefaults,
}

fn limits_view(cfg: &Config, limit: &AppLimit) -> LimitsView {
    LimitsView {
        client_rpm: limit.client_rpm,
        app_rpm: limit.app_rpm,
        memory_mb: limit.memory_mb,
        per_client: cfg.edge_sees_clients(),
        defaults: LimitDefaults {
            client_rpm: cfg.edge.client_rpm,
            app_rpm: cfg.edge.app_rpm,
            memory_mb: cfg.fleet_memory_mb,
            memory_max_mb: matches!(cfg.tenancy, crate::config::Tenancy::Multi)
                .then_some(cfg.fleet_memory_max_mb),
        },
    }
}

/// Whether a per-app memory override is storable: the shared 64 MiB floor
/// everywhere, and in `multi` the operator's ceiling (a tenant can only
/// lower its cap, never raise it past this). `None` clears back to the
/// platform default in both modes.
fn check_memory_override(
    tenancy: &crate::config::Tenancy,
    memory_mb: Option<i64>,
    ceiling_mb: u32,
) -> Result<(), ApiError> {
    let Some(v) = memory_mb else {
        return Ok(());
    };
    if !(MIN_FLEET_MEMORY_MB..=MAX_FLEET_MEMORY_MB).contains(&v) {
        return Err(ApiError::bad(format!(
            "memory must be between {MIN_FLEET_MEMORY_MB} and {MAX_FLEET_MEMORY_MB} MiB"
        )));
    }
    if *tenancy == crate::config::Tenancy::Multi && (v as u64) > u64::from(ceiling_mb) {
        return Err(ApiError::bad(format!(
            "memory must be at most {ceiling_mb} MiB in multi-tenant mode (operator ceiling RUNNER_FLEET_MEMORY_MAX_MB)"
        )));
    }
    Ok(())
}

pub async fn get(state: &AppState, id: &str) -> Result<LimitsView, ApiError> {
    let app = app_or_404(state, id).await?;
    match db::get_app_limit(&state.pool, &app.id).await {
        Ok(limit) => Ok(limits_view(&state.config, &limit)),
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn set(
    state: &AppState,
    id: &str,
    client_rpm: Option<i64>,
    app_rpm: Option<i64>,
    memory_mb: Option<i64>,
    role: Option<&str>,
) -> Result<LimitsView, ApiError> {
    require(role, "admin")?;
    // Requests per minute; null = the platform default, 0 = off.
    let in_range = |v: Option<i64>| v.is_none_or(|v| (0..=MAX_EDGE_RPM).contains(&v));
    if !in_range(client_rpm) || !in_range(app_rpm) {
        return Err(ApiError::bad(format!(
            "limits must be between 0 and {MAX_EDGE_RPM} requests per minute"
        )));
    }
    check_memory_override(
        &state.config.tenancy,
        memory_mb,
        state.config.fleet_memory_max_mb,
    )?;
    let app = app_or_404(state, id).await?;
    let limit = AppLimit {
        app_id: app.id.clone(),
        client_rpm,
        app_rpm,
        memory_mb,
    };
    db::set_app_limit(&state.pool, &limit)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if let Err(e) = crate::host::edge_table::push_routes(&state.pool, &state.config).await {
        tracing::warn!(app_id = %app.id, error = %format!("{e:#}"), "edge push after limits change");
    }
    Ok(limits_view(&state.config, &limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Tenancy;
    use crate::models::new_id;
    use std::sync::Arc;

    /// The tests act as the control UI: every `set` carries the role the UI
    /// resolved and passes.
    const ADMIN: Option<&str> = Some("admin");

    async fn test_state(tenancy: Tenancy) -> AppState {
        let dir = std::env::temp_dir().join(format!("noite-limits-{tenancy:?}-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.tenancy = tenancy;
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        AppState {
            pool,
            config,
            procs: crate::host::supervisor::new_procs(),
            logs: crate::host::logs::new_state(),
            deploying: crate::host::deploy::new_deploying(),
            log_notify,
            git_sync: crate::host::git_manifest::GitSync::default(),
            tip_tx,
            ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            isolation: Arc::new(tokio::sync::RwLock::new(
                crate::host::isolation::IsolationStatus::default(),
            )),
            state_sync: crate::host::state::StateSync::new(),
            dns: Arc::new(crate::dns::FakeResolver::default()),
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
            source_maps: Default::default(),
        }
    }

    async fn seed_app(state: &AppState, slug: &str) -> crate::models::App {
        db::create_app(
            &state.pool,
            &state.config,
            db::NewApp {
                name: slug,
                slug,
                user_id: "local",
                subdomain: &format!("{slug}.localhost"),
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    #[tokio::test]
    async fn role_gates_hold_without_a_control_ui() {
        let state = test_state(Tenancy::Multi).await;
        let app = seed_app(&state, "gated").await;
        // No role is a refusal, never a default.
        assert!(matches!(
            set(&state, &app.id, None, None, None, None).await,
            Err(ApiError::Forbidden(_))
        ));
        // A viewer or pusher writes nothing here.
        for role in [Some("view"), Some("push")] {
            assert!(matches!(
                set(&state, &app.id, None, None, None, role).await,
                Err(ApiError::Forbidden(_))
            ));
        }
        // An admin passes, and the stored values round-trip through get.
        let view = set(&state, &app.id, Some(100), Some(200), None, ADMIN)
            .await
            .expect("admin sets");
        assert_eq!(view.client_rpm, Some(100));
        assert_eq!(view.app_rpm, Some(200));
        let reread = get(&state, &app.id).await.expect("get stays role-free");
        assert_eq!(reread.client_rpm, Some(100));
    }

    #[test]
    fn multi_refuses_overrides_above_the_ceiling() {
        // 600 MiB over a 512 MiB ceiling: refused in multi, stored in single.
        let err = check_memory_override(&Tenancy::Multi, Some(600), 512)
            .expect_err("multi must refuse above-ceiling overrides");
        let msg = format!("{err}");
        assert!(msg.contains("512"), "names the ceiling: {msg}");
        assert!(
            msg.contains("RUNNER_FLEET_MEMORY_MAX_MB"),
            "names the knob: {msg}"
        );
        check_memory_override(&Tenancy::Single, Some(600), 512).expect("single has no ceiling");
    }

    #[test]
    fn memory_floor_and_clearing_hold_in_both_modes() {
        for tenancy in [Tenancy::Multi, Tenancy::Single] {
            assert!(
                check_memory_override(&tenancy, Some(16), 512).is_err(),
                "below-floor refused in {tenancy:?}"
            );
            check_memory_override(&tenancy, None, 512).expect("clearing always allowed");
            check_memory_override(&tenancy, Some(64), 512).expect("floor accepted");
            check_memory_override(&tenancy, Some(512), 512).expect("ceiling itself accepted");
        }
    }
}
