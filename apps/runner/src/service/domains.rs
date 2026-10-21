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
use super::environments::role_ok;

/// Enforce one gate. A missing role is a refusal, never a default: the caller
/// (the control UI) always knows its role, and an unknown caller must not
/// inherit rights.
fn require(role: Option<&str>, need: &str) -> Result<(), ApiError> {
    match role {
        Some(role) if role_ok(role, need) => Ok(()),
        Some(role) => Err(ApiError::forbidden(format!(
            "role {role:?} may not {need} this app's domains"
        ))),
        None => Err(ApiError::forbidden(format!(
            "the {need} role is required for this operation"
        ))),
    }
}
/// Hostnames this platform answers for itself: the base domain and its
/// platform subdomains, plus every extra control hostname and its
/// subdomains (tenant sites serve under extra bases too — `tenant_bases` —
/// so a custom claim there would collide with the tenant site for one
/// address). An app may never claim one — `Host` dispatch would otherwise
/// fight the control plane.
fn platform_host(cfg: &Config, hostname: &str) -> bool {
    let base = cfg.base_domain.to_lowercase();
    if hostname == base || hostname.ends_with(&format!(".{base}")) {
        return true;
    }
    cfg.control_extra_hosts.iter().any(|raw| {
        let extra = raw.trim().trim_matches('.').to_lowercase();
        !extra.is_empty() && (hostname == extra || hostname.ends_with(&format!(".{extra}")))
    })
}

pub async fn list(
    state: &AppState,
    app_id: &str,
    role: Option<&str>,
) -> Result<Vec<AppDomain>, ApiError> {
    require(role, "view")?;
    db::list_domains_for(&state.pool, app_id)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))
}

pub async fn add(
    state: &AppState,
    app_id: &str,
    hostname: &str,
    role: Option<&str>,
) -> Result<Vec<AppDomain>, ApiError> {
    require(role, "admin")?;
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
        Ok(Some(_)) => return list(state, app_id, role).await,
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
    // check above and now fails here on the partial unique index, and a
    // concurrent same-app claim loses the primary-key race. Only a unique
    // violation maps to 409 (re-reading for idempotency); anything else —
    // pool timeouts, I/O — is a 500. The message stays static: the storage
    // detail in the sqlx error is not for callers.
    if let Err(e) =
        db::add_domain(&state.pool, app_id, &hostname, status, &token, verified_at).await
    {
        let unique = e
            .as_database_error()
            .is_some_and(|e| e.is_unique_violation());
        if !unique {
            return Err(ApiError::internal(e.to_string()));
        }
        return match db::domain_claim(&state.pool, app_id, &hostname).await {
            Ok(Some(_)) => list(state, app_id, role).await,
            Ok(None) => Err(ApiError::conflict("hostname is already in use")),
            Err(read_err) => Err(ApiError::internal(read_err.to_string())),
        };
    }
    list(state, app_id, role).await
}

/// Verify our pending claim: the TXT record at the challenge name must
/// contain our token. On success the claim flips to verified and rival
/// pending claims for the hostname are dropped (first to verify wins).
pub async fn verify(
    state: &AppState,
    app_id: &str,
    hostname: &str,
    role: Option<&str>,
) -> Result<Vec<AppDomain>, ApiError> {
    require(role, "admin")?;
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
        return list(state, app_id, role).await;
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
    let records = state
        .dns
        .txt_records(&owner)
        .await
        .map_err(|e| ApiError::bad(e.to_string()))?;
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
        Ok(true) => list(state, app_id, role).await,
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
    role: Option<&str>,
) -> Result<Vec<AppDomain>, ApiError> {
    require(role, "admin")?;
    let hostname = hostname.trim().trim_end_matches('.').to_lowercase();
    match db::remove_domain(&state.pool, app_id, &hostname).await {
        Ok(0) => Err(ApiError::not_found("hostname is not attached to this app")),
        Ok(_) => list(state, app_id, role).await,
        Err(e) => Err(ApiError::internal(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::new_id;
    use std::sync::Arc;

    /// The tests act as an app admin: every service call carries the role
    /// the control UI would resolve and pass.
    const ADMIN: Option<&str> = Some("admin");

    async fn test_state(
        tenancy: Tenancy,
        extra_hosts: &[&str],
    ) -> (AppState, Arc<crate::dns::FakeResolver>) {
        let dir = std::env::temp_dir().join(format!("noite-domains-{tenancy:?}-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.tenancy = tenancy;
        cfg.control_extra_hosts = extra_hosts.iter().map(|host| host.to_string()).collect();
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
        let (state, _fake) = test_state(Tenancy::Single, &[]).await;
        let app = seed_app(&state, "solo").await;

        let rows = add(&state, &app.id, "app.example.com", ADMIN)
            .await
            .expect("add");
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
        let (state, fake) = test_state(Tenancy::Multi, &[]).await;
        let app = seed_app(&state, "pending").await;

        let rows = add(&state, &app.id, "shop.example.com", ADMIN)
            .await
            .expect("add");
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
        let err = verify(&state, &app.id, "shop.example.com", ADMIN)
            .await
            .expect_err("wrong value must fail");
        assert!(
            err.to_string().contains("does not contain"),
            "readable reason: {err}"
        );

        // No record at all fails readably too.
        fake.set(&dns::challenge_name("shop.example.com"), Vec::new());
        let err = verify(&state, &app.id, "shop.example.com", ADMIN)
            .await
            .expect_err("missing record must fail");
        assert!(
            err.to_string().contains("no TXT record"),
            "readable reason: {err}"
        );

        // The right token flips the claim, which then resolves.
        let token = rows[0].token.clone();
        fake.set(&dns::challenge_name("shop.example.com"), vec![token]);
        let rows = verify(&state, &app.id, "shop.example.com", ADMIN)
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
        let (state, fake) = test_state(Tenancy::Multi, &[]).await;
        let a = seed_app(&state, "rival-a").await;
        let b = seed_app(&state, "rival-b").await;
        let host = "contested.example.com";

        // Parallel pending claims coexist: no squatting by mere claim.
        add(&state, &a.id, host, ADMIN).await.expect("a claims");
        add(&state, &b.id, host, ADMIN).await.expect("b claims");
        let b_token = db::domain_claim(&state.pool, &b.id, host)
            .await
            .expect("read")
            .expect("b claim")
            .token;

        fake.set(&dns::challenge_name(host), vec![b_token]);
        verify(&state, &b.id, host, ADMIN)
            .await
            .expect("b verifies");

        // B's claim resolves; A's pending row is gone, and A can never win now.
        assert!(db::get_app_by_domain(&state.pool, host)
            .await
            .expect("resolve")
            .is_some_and(|app| app.id == b.id));
        assert!(db::domain_claim(&state.pool, &a.id, host)
            .await
            .expect("read")
            .is_none());
        let err = verify(&state, &a.id, host, ADMIN)
            .await
            .expect_err("loser must fail");
        assert!(
            err.to_string().contains("not attached"),
            "dropped row reads as detached: {err}"
        );

        // A fresh claim by the loser is refused while B holds the name.
        let err = add(&state, &a.id, host, ADMIN)
            .await
            .expect_err("add must fail");
        assert!(
            err.to_string().contains("already verified"),
            "clear refusal: {err}"
        );
    }

    #[tokio::test]
    async fn verify_without_a_resolver_fails_readably() {
        let (mut state, _fake) = test_state(Tenancy::Multi, &[]).await;
        state.dns = Arc::new(crate::dns::UnavailableResolver::new(
            "no nameservers".to_owned(),
        ));
        let app = seed_app(&state, "noresolv").await;
        add(&state, &app.id, "dark.example.com", ADMIN)
            .await
            .expect("claim");
        let err = verify(&state, &app.id, "dark.example.com", ADMIN)
            .await
            .expect_err("no resolver must fail");
        assert_eq!(err.to_string(), "DNS resolver unavailable: no nameservers");
    }

    #[tokio::test]
    async fn extra_control_hosts_and_their_subdomains_are_platform() {
        let (state, _fake) = test_state(Tenancy::Multi, &["noite.local"]).await;
        let app = seed_app(&state, "extra").await;
        for host in ["noite.local", "myapp.noite.local", "deep.myapp.noite.local"] {
            let err = add(&state, &app.id, host, ADMIN)
                .await
                .expect_err("platform host must be refused");
            assert_eq!(err.to_string(), "hostname belongs to the platform");
        }
        // A sibling suffix that merely shares the tail is claimable.
        add(&state, &app.id, "notnoite.local", ADMIN)
            .await
            .expect("non-platform suffix claims");
    }

    #[tokio::test]
    async fn conflict_messages_carry_no_storage_detail() {
        let (state, fake) = test_state(Tenancy::Multi, &[]).await;
        let a = seed_app(&state, "static-a").await;
        let b = seed_app(&state, "static-b").await;
        add(&state, &a.id, "held.example.com", ADMIN)
            .await
            .expect("a claims");
        let token = db::domain_claim(&state.pool, &a.id, "held.example.com")
            .await
            .expect("read")
            .expect("a claim")
            .token;
        fake.set(&dns::challenge_name("held.example.com"), vec![token]);
        verify(&state, &a.id, "held.example.com", ADMIN)
            .await
            .expect("a verifies");
        let err = add(&state, &b.id, "held.example.com", ADMIN)
            .await
            .expect_err("rival claim must conflict");
        assert_eq!(
            err.to_string(),
            "hostname is already verified by another app"
        );
    }

    #[tokio::test]
    async fn role_gates_hold_without_a_control_ui() {
        let (state, _fake) = test_state(Tenancy::Multi, &[]).await;
        let app = seed_app(&state, "gated").await;
        // No role is a refusal on every call, never a default.
        assert!(matches!(
            list(&state, &app.id, None).await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            add(&state, &app.id, "gated.example.com", None).await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            verify(&state, &app.id, "gated.example.com", None).await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            remove(&state, &app.id, "gated.example.com", None).await,
            Err(ApiError::Forbidden(_))
        ));
        // A viewer reads but mutates nothing.
        list(&state, &app.id, Some("view"))
            .await
            .expect("view lists");
        assert!(matches!(
            add(&state, &app.id, "gated.example.com", Some("view")).await,
            Err(ApiError::Forbidden(_))
        ));
        // An admin passes everywhere.
        add(&state, &app.id, "gated.example.com", ADMIN)
            .await
            .expect("admin adds");
        remove(&state, &app.id, "gated.example.com", ADMIN)
            .await
            .expect("admin removes");
    }

    #[tokio::test]
    async fn concurrent_same_app_claims_stay_idempotent() {
        let (state, _fake) = test_state(Tenancy::Multi, &[]).await;
        let app = seed_app(&state, "racer").await;
        // Start together so the losers check before the winner commits and
        // lose the primary-key race instead of early-returning: a unique
        // violation with our own claim present must list, never 409.
        let barrier = Arc::new(tokio::sync::Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let state = state.clone();
            let app_id = app.id.clone();
            let barrier = barrier.clone();
            handles.push(tokio::spawn(async move {
                barrier.wait().await;
                add(&state, &app_id, "race.example.com", ADMIN).await
            }));
        }
        for handle in handles {
            let rows = handle
                .await
                .expect("task")
                .expect("concurrent claim stays idempotent");
            assert_eq!(rows.len(), 1);
        }
        let rows = list(&state, &app.id, ADMIN).await.expect("list");
        assert_eq!(rows.len(), 1, "one claim row, not eight");
    }
}
