//! Custom hostnames: list, add, verify, remove. A claim starts `pending`
//! with a random per-claim token and becomes `verified` once the TXT record
//! at `_noite-challenge.<hostname>` proves ownership — or immediately in
//! `single` tenancy, where one trusted operator owns the DNS (SPEC, Custom
//! domains).
//!
//! Several apps may hold a pending claim for one hostname; the first to
//! verify wins and the losers' rows are dropped. Only verified rows reach
//! the edge: `host/caddy.rs` writes routes for them and `host/edge.rs`
//! answers the on-demand TLS gate through `db::get_app_by_domain`, which
//! only resolves verified claims.
//!
//! Hostname grammar, platform-host refusal and the collision mapping live
//! here so the RPC surface cannot drift. There is no background polling
//! loop: verification is one DNS lookup per explicit Verify call.

use crate::api_error::ApiError;
use crate::config::{Config, Tenancy};
use crate::db;
use crate::dns;
use crate::lifecycle::hostname_ok;
use crate::models::{AppDomain, DOMAIN_STATUS_PENDING, DOMAIN_STATUS_VERIFIED};
use crate::AppState;

use super::apps::app_or_404;

/// Hostnames this platform answers for itself: the base domain and its
/// platform subdomains, plus every extra control hostname. An app may never
/// claim one — `Host` dispatch would otherwise fight the control plane.
fn platform_host(cfg: &Config, hostname: &str) -> bool {
    let base = cfg.base_domain.to_lowercase();
    if hostname == base || hostname.ends_with(&format!(".{base}")) {
        return true;
    }
    cfg.control_extra_hosts
        .iter()
        .any(|extra| hostname == extra.trim().trim_matches('.').to_lowercase())
}

pub async fn list(state: &AppState, app_id: &str) -> Result<Vec<AppDomain>, ApiError> {
    db::list_domains_for(&state.pool, app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn add(
    state: &AppState,
    app_id: &str,
    hostname: &str,
) -> Result<Vec<AppDomain>, ApiError> {
    let hostname = hostname.trim().trim_end_matches('.').to_lowercase();
    if !hostname_ok(&hostname) {
        return Err(ApiError::bad("invalid hostname"));
    }
    if platform_host(&state.config, &hostname) {
        return Err(ApiError::bad("hostname belongs to the platform"));
    }
    app_or_404(state, app_id).await?;
    // A verified claim elsewhere blocks this one outright. Pending claims
    // never block each other: the first to verify wins.
    match db::verified_domain_owner(&state.pool, &hostname).await {
        Ok(Some(owner)) if owner != app_id => {
            return Err(ApiError::conflict(
                "hostname is already verified by another app",
            ));
        }
        Ok(_) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    // Re-claiming our own hostname is idempotent: the token the panel shows
    // stays the one the operator may already have published.
    match db::domain_claim(&state.pool, app_id, &hostname).await {
        Ok(Some(_)) => return list(state, app_id).await,
        Ok(None) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    let now = crate::models::now_iso();
    let token = dns::new_token();
    let (status, verified_at) = match state.config.tenancy {
        Tenancy::Single => (DOMAIN_STATUS_VERIFIED, Some(now.as_str())),
        Tenancy::Multi => (DOMAIN_STATUS_PENDING, None),
    };
    // Re-check under the insert: a rival verified row committed between the
    // check above and now fails here on the partial unique index.
    if let Err(e) =
        db::add_domain(&state.pool, app_id, &hostname, status, &token, verified_at).await
    {
        return Err(ApiError::conflict(format!(
            "hostname is already in use: {e}"
        )));
    }
    list(state, app_id).await
}

/// Verify our pending claim: the TXT record at the challenge name must
/// contain our token. On success the claim flips to verified and rival
/// pending claims for the hostname are dropped (first to verify wins).
pub async fn verify(
    state: &AppState,
    app_id: &str,
    hostname: &str,
) -> Result<Vec<AppDomain>, ApiError> {
    let hostname = hostname.trim().trim_end_matches('.').to_lowercase();
    if !hostname_ok(&hostname) {
        return Err(ApiError::bad("invalid hostname"));
    }
    app_or_404(state, app_id).await?;
    let claim = db::domain_claim(&state.pool, app_id, &hostname)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let Some(claim) = claim else {
        return Err(ApiError::not_found("hostname is not attached to this app"));
    };
    if claim.is_verified() {
        return list(state, app_id).await;
    }
    // A rival verified while we waited: the proof can never succeed now.
    match db::verified_domain_owner(&state.pool, &hostname).await {
        Ok(Some(owner)) if owner != app_id => {
            return Err(ApiError::conflict(
                "hostname was just verified by another app",
            ));
        }
        Ok(_) => {}
        Err(e) => return Err(ApiError::internal(e.to_string())),
    }
    let owner = dns::challenge_name(&hostname);
    let records = state.dns.txt_records(&owner).await.map_err(ApiError::bad)?;
    if records.is_empty() {
        return Err(ApiError::bad(format!(
            "no TXT record at {owner} yet — create it, then verify again"
        )));
    }
    if !records.iter().any(|record| record.trim() == claim.token) {
        return Err(ApiError::bad(format!(
            "TXT record at {owner} does not contain this claim's token — check the value, then verify again"
        )));
    }
    match db::verify_domain(&state.pool, app_id, &hostname).await {
        Ok(true) => list(state, app_id).await,
        Ok(false) => {
            // Lost a race inside the transaction, or the claim vanished:
            // re-read to answer precisely.
            match db::verified_domain_owner(&state.pool, &hostname).await {
                Ok(Some(owner)) if owner != app_id => Err(ApiError::conflict(
                    "hostname was just verified by another app",
                )),
                Ok(_) => Err(ApiError::not_found("hostname is not attached to this app")),
                Err(e) => Err(ApiError::internal(e.to_string())),
            }
        }
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

pub async fn remove(
    state: &AppState,
    app_id: &str,
    hostname: &str,
) -> Result<Vec<AppDomain>, ApiError> {
    let hostname = hostname.trim().trim_end_matches('.').to_lowercase();
    match db::remove_domain(&state.pool, app_id, &hostname).await {
        Ok(0) => Err(ApiError::not_found("hostname is not attached to this app")),
        Ok(_) => list(state, app_id).await,
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::new_id;
    use std::sync::Arc;

    async fn test_state(tenancy: Tenancy) -> (AppState, Arc<crate::dns::FakeResolver>) {
        let dir = std::env::temp_dir().join(format!("noite-domains-{tenancy:?}-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.tenancy = tenancy;
        let fake = Arc::new(crate::dns::FakeResolver::default());
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        let state = AppState {
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
            dns: fake.clone(),
            bucket_ok: Arc::new(tokio::sync::RwLock::new((
                true,
                String::new(),
                std::time::Instant::now(),
            ))),
            started_at: chrono::Utc::now(),
        };
        (state, fake)
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
    async fn single_tenancy_verifies_on_claim() {
        let (state, _fake) = test_state(Tenancy::Single).await;
        let app = seed_app(&state, "solo").await;

        let rows = add(&state, &app.id, "app.example.com").await.expect("add");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].is_verified(), "single auto-verifies");
        assert!(rows[0].verified_at.is_some());

        // A verified hostname keeps resolving for the edge.
        let resolved = db::get_app_by_domain(&state.pool, "app.example.com")
            .await
            .expect("resolve");
        assert_eq!(resolved.map(|a| a.id), Some(app.id.clone()));
    }

    #[tokio::test]
    async fn pending_claim_resolves_nothing_until_verified() {
        let (state, fake) = test_state(Tenancy::Multi).await;
        let app = seed_app(&state, "pending").await;

        let rows = add(&state, &app.id, "shop.example.com").await.expect("add");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].is_verified());
        assert!(!rows[0].token.is_empty());

        // Pending: no route, no cert, no fallback resolution.
        let resolved = db::get_app_by_domain(&state.pool, "shop.example.com")
            .await
            .expect("resolve");
        assert!(resolved.is_none(), "a pending domain gets no TLS");

        // Wrong TXT value fails readably.
        fake.set(
            &dns::challenge_name("shop.example.com"),
            vec!["not-our-token".to_owned()],
        );
        let err = verify(&state, &app.id, "shop.example.com")
            .await
            .expect_err("wrong value must fail");
        assert!(
            err.to_string().contains("does not contain"),
            "readable reason: {err}"
        );

        // No record at all fails readably too.
        fake.set(&dns::challenge_name("shop.example.com"), Vec::new());
        let err = verify(&state, &app.id, "shop.example.com")
            .await
            .expect_err("missing record must fail");
        assert!(
            err.to_string().contains("no TXT record"),
            "readable reason: {err}"
        );

        // The right token flips the claim, which then resolves.
        let token = rows[0].token.clone();
        fake.set(&dns::challenge_name("shop.example.com"), vec![token]);
        let rows = verify(&state, &app.id, "shop.example.com")
            .await
            .expect("verify");
        assert!(rows[0].is_verified());
        let resolved = db::get_app_by_domain(&state.pool, "shop.example.com")
            .await
            .expect("resolve");
        assert_eq!(resolved.map(|a| a.id), Some(app.id.clone()));
    }

    #[tokio::test]
    async fn first_to_verify_wins_and_rivals_are_dropped() {
        let (state, fake) = test_state(Tenancy::Multi).await;
        let a = seed_app(&state, "rival-a").await;
        let b = seed_app(&state, "rival-b").await;
        let host = "contested.example.com";

        // Parallel pending claims coexist: no squatting by mere claim.
        add(&state, &a.id, host).await.expect("a claims");
        add(&state, &b.id, host).await.expect("b claims");
        let b_token = db::domain_claim(&state.pool, &b.id, host)
            .await
            .expect("read")
            .expect("b claim")
            .token;

        fake.set(&dns::challenge_name(host), vec![b_token]);
        verify(&state, &b.id, host).await.expect("b verifies");

        // B's claim resolves; A's pending row is gone, and A can never win now.
        assert!(db::get_app_by_domain(&state.pool, host)
            .await
            .expect("resolve")
            .is_some_and(|app| app.id == b.id));
        assert!(db::domain_claim(&state.pool, &a.id, host)
            .await
            .expect("read")
            .is_none());
        let err = verify(&state, &a.id, host)
            .await
            .expect_err("loser must fail");
        assert!(
            err.to_string().contains("not attached"),
            "dropped row reads as detached: {err}"
        );

        // A fresh claim by the loser is refused while B holds the name.
        let err = add(&state, &a.id, host).await.expect_err("add must fail");
        assert!(
            err.to_string().contains("already verified"),
            "clear refusal: {err}"
        );
    }
}
