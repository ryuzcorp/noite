//! Environment edge tests (`host/edge.rs` + `host/env_gate.rs` against a real
//! database): the TLS ask gate's allow/deny for environment hosts, the gate's
//! redirect into the control UI, the token → cookie round trip the control UI
//! drives, and the `environments.grant` transports.

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;

use crate::api::tests::Harness;
use crate::host::env_gate;
use crate::models::{App, Environment, EnvironmentKind};
use crate::AppState;

const ENV_HOST: &str = "feat-x.test.localhost";

/// One deployed, members-only environment (the create defaults), reached at
/// `<label>.test.localhost`.
async fn seed_environment(harness: &Harness, app: &App, label: &str) -> Environment {
    let env = crate::db::create_environment(
        &harness.state.pool,
        &harness.state.config,
        crate::db::NewEnvironment {
            app_id: &app.id,
            slug: &app.slug,
            label,
            kind: EnvironmentKind::Branch,
            git_ref: &format!("refs/heads/{label}"),
            created_by: "user-1",
            listen: 30010,
            internal: 30011,
        },
    )
    .await
    .expect("seed environment");
    crate::db::environments::mark_environment_deployed(&harness.state.pool, &env.id, "abc1234")
        .await
        .expect("mark deployed");
    crate::db::get_environment(&harness.state.pool, &env.id)
        .await
        .expect("read back")
        .expect("environment row")
}

/// The headers Caddy's `forward_auth` sends the gate for a request on an
/// environment host.
fn caddy_headers(host: &str, uri: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let mut put = |name: &'static str, value: String| {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_str(&value).expect("header value"),
        );
    };
    put("x-forwarded-host", host.to_string());
    put("x-forwarded-proto", "http".into());
    put("x-forwarded-uri", uri.into());
    headers
}

fn cookie_header(value: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("{}={value}", env_gate::COOKIE_NAME)).expect("cookie header")
}

async fn tls_ask(state: &AppState, domain: &str) -> StatusCode {
    crate::host::edge::tls_ask(
        State(state.clone()),
        Query(HashMap::from([("domain".to_string(), domain.to_string())])),
    )
    .await
    .into_response()
    .status()
}

async fn gate(state: &AppState, headers: HeaderMap) -> Response {
    env_gate::env_gate(State(state.clone()), headers).await
}

async fn auth(state: &AppState, headers: HeaderMap, params: &[(&str, &str)]) -> Response {
    let params = params
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
    env_gate::env_auth(State(state.clone()), headers, Query(params)).await
}

fn location(resp: &Response) -> String {
    resp.headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

fn set_cookie(resp: &Response) -> String {
    resp.headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

#[tokio::test]
async fn tls_ask_admits_existing_environment_hosts_only() {
    let harness = Harness::new().await;
    let app = harness.seed_app("test").await;
    let env = seed_environment(&harness, &app, "feat-x").await;
    let state = &harness.state;

    // An existing environment host is ours: one certificate per environment,
    // so the ask gate must admit it even before the fleet's first request.
    assert_eq!(tls_ask(state, ENV_HOST).await, StatusCode::OK);
    assert_eq!(
        tls_ask(state, "feat-x.test.localhost:443").await,
        StatusCode::OK
    );
    // A label no environment owns mints nothing (nor does a foreign base, or
    // one of the labels the preview hosts own).
    assert_eq!(
        tls_ask(state, "nope.test.localhost").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        tls_ask(state, "preview.test.localhost").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        tls_ask(state, "app-0.test.localhost").await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        tls_ask(state, "feat-x.test.noite.now").await,
        StatusCode::NOT_FOUND
    );
    // The tenant host stays a tenant host: this app has no deploy yet.
    assert_eq!(
        tls_ask(state, "test.localhost").await,
        StatusCode::NOT_FOUND
    );
    // The pod host is admitted for any existing app.
    assert_eq!(
        tls_ask(state, "app-0.preview.test.localhost").await,
        StatusCode::OK
    );
    // Deleting the environment takes its host away with it.
    crate::db::delete_environment(&state.pool, &env.id)
        .await
        .expect("delete");
    assert_eq!(tls_ask(state, ENV_HOST).await, StatusCode::NOT_FOUND);
    harness.finish().await;
}

#[tokio::test]
async fn the_gate_hands_off_to_the_control_ui() {
    let harness = Harness::new().await;
    let app = harness.seed_app("test").await;
    let env = seed_environment(&harness, &app, "feat-x").await;
    let state = &harness.state;

    // No cookie: the visitor is sent to the control UI with the environment,
    // its app and the exact URL they asked for.
    let resp = gate(state, caddy_headers(ENV_HOST, "/dash?tab=1")).await;
    assert_eq!(resp.status(), StatusCode::FOUND);
    assert_eq!(
        location(&resp),
        format!(
            "//localhost/api/env-auth?env={}&app={}&return=http%3A%2F%2F{ENV_HOST}%2Fdash%3Ftab%3D1",
            env.id, app.id
        )
    );
    // A tampered or foreign cookie is the same as none.
    for value in ["garbage", "other-env.9999999999.deadbeef"] {
        let mut headers = caddy_headers(ENV_HOST, "/");
        headers.insert("cookie", cookie_header(value));
        assert_eq!(gate(state, headers).await.status(), StatusCode::FOUND);
    }
    // A cookie this runner minted admits the request (200 → Caddy proxies on).
    let mut headers = caddy_headers(ENV_HOST, "/dash");
    headers.insert(
        "cookie",
        cookie_header(&env_gate::mint_cookie(&state.config, &env.id)),
    );
    assert_eq!(gate(state, headers).await.status(), StatusCode::OK);
    // A label with no environment, and a cookie for another environment, are
    // not routed at all: the gate fails closed.
    assert_eq!(
        gate(state, caddy_headers("nope.test.localhost", "/"))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let mut headers = caddy_headers(ENV_HOST, "/");
    headers.insert(
        "cookie",
        cookie_header(&env_gate::mint_cookie(&state.config, "other-env")),
    );
    assert_eq!(gate(state, headers).await.status(), StatusCode::FOUND);
    // A public environment renders no gate; a direct call admits too.
    crate::db::set_environment_public(&state.pool, &env.id, true)
        .await
        .expect("public");
    assert_eq!(
        gate(state, caddy_headers(ENV_HOST, "/")).await.status(),
        StatusCode::OK
    );
    harness.finish().await;
}

#[tokio::test]
async fn the_hand_back_sets_a_host_only_cookie() {
    let harness = Harness::new().await;
    let app = harness.seed_app("test").await;
    let env = seed_environment(&harness, &app, "feat-x").await;
    let state = &harness.state;
    let token = env_gate::mint_grant(&state.config, &env.id, "user-1");

    // The control UI's redirect: token + the path it asked for.
    let resp = auth(
        state,
        caddy_headers(ENV_HOST, "/__noite/auth"),
        &[("token", &token), ("return", "/dash?tab=1")],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FOUND);
    assert_eq!(location(&resp), "/dash?tab=1");
    let cookie = set_cookie(&resp);
    assert!(
        cookie.starts_with(&format!("{}={}", env_gate::COOKIE_NAME, env.id)),
        "{cookie}"
    );
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(cookie.contains("SameSite=Lax"), "{cookie}");
    assert!(cookie.contains("Path=/"), "{cookie}");
    assert!(!cookie.contains("Domain="), "host-only: {cookie}");
    // The value the browser now holds admits the very next request.
    let value = cookie
        .split(';')
        .next()
        .and_then(|pair| pair.split_once('='))
        .map(|(_, v)| v.to_string())
        .expect("cookie value");
    let mut headers = caddy_headers(ENV_HOST, "/dash");
    headers.insert("cookie", cookie_header(&value));
    assert_eq!(gate(state, headers).await.status(), StatusCode::OK);

    // Only a rooted same-host path is honoured: anything a control UI could
    // not have meant lands on `/` instead of off the environment.
    for hostile in ["//evil.com", "https://evil.com/x", "/\\evil.com"] {
        let resp = auth(
            state,
            caddy_headers(ENV_HOST, "/__noite/auth"),
            &[("token", &token), ("return", hostile)],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::FOUND);
        assert_eq!(location(&resp), "/", "{hostile}");
    }
    // Expired, tampered or foreign tokens never set a cookie. A second
    // environment on the same app refuses the first environment's token.
    let resp = auth(
        state,
        caddy_headers(ENV_HOST, "/__noite/auth"),
        &[("token", "garbage")],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(set_cookie(&resp).is_empty(), "no cookie on a bad token");
    let mut forged = token.clone().into_bytes();
    forged[0] ^= 0x01;
    let forged = String::from_utf8(forged).expect("utf8");
    let resp = auth(
        state,
        caddy_headers(ENV_HOST, "/__noite/auth"),
        &[("token", &forged)],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let other = seed_environment(&harness, &app, "other").await;
    let token = env_gate::mint_grant(&state.config, &other.id, "user-1");
    let resp = auth(
        state,
        caddy_headers(ENV_HOST, "/__noite/auth"),
        &[("token", &token)],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    harness.finish().await;
}

#[tokio::test]
async fn wake_and_fallback_resolve_environment_hosts() {
    let harness = Harness::new().await;
    let app = harness.seed_app("test").await;
    let env = seed_environment(&harness, &app, "feat-x").await;
    let state = &harness.state;

    // The wake hop routes an environment host to *its* environment. A stopped
    // one refuses the wake (503) instead of the 404 an unknown host gets —
    // which is what proves the host resolved to the environment at all (a
    // tenant lookup would answer 404 for a dotted host). The service layer's
    // own stop path is RunnerEnvironments'; the row is pinned here so the
    // branch is reachable without a fleet.
    sqlx::query("UPDATE environment SET desired_state = 'stopped' WHERE id = ?")
        .bind(&env.id)
        .execute(&state.pool)
        .await
        .expect("stop environment");
    let wake = |host: &str| {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-forwarded-host"),
            HeaderValue::from_str(host).expect("host"),
        );
        crate::host::edge::wake(State(state.clone()), headers)
    };
    assert_eq!(
        wake(ENV_HOST).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        wake("nope.test.localhost").await.status(),
        StatusCode::NOT_FOUND
    );

    // The fallback page answers on the environment's own host: stopped is
    // "Paused", never deployed is "Not deployed yet", and a label no
    // environment owns says so.
    let fallback = |host: &str| {
        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("host"),
            HeaderValue::from_str(host).expect("host"),
        );
        crate::host::edge::edge_fallback(State(state.clone()), headers)
    };
    let body = |resp: Response| async move {
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        (status, String::from_utf8_lossy(&bytes).to_string())
    };
    let (status, page) = body(fallback(ENV_HOST).await.into_response()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(page.contains("Paused") && page.contains("feat-x"), "{page}");
    sqlx::query("UPDATE environment SET desired_state = 'running' WHERE id = ?")
        .bind(&env.id)
        .execute(&state.pool)
        .await
        .expect("resume environment");
    crate::db::environments::set_environment_asleep(&state.pool, &env.id)
        .await
        .expect("asleep");
    let (status, page) = body(fallback(ENV_HOST).await.into_response()).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{page}");
    assert!(page.contains("Starting"), "{page}");
    let (status, page) = body(fallback("wip.test.localhost").await.into_response()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(page.contains("wip"), "{page}");
    harness.finish().await;
}

#[tokio::test]
async fn grant_agrees_on_both_transports_and_stays_on_its_app() {
    let harness = Harness::new().await;
    let app = harness.seed_app("test").await;
    let env = seed_environment(&harness, &app, "feat-x").await;
    let path = format!("/v1/apps/{}/environments/{}/grant", app.id, env.id);

    let token = harness
        .rpc(
            "environments.grant",
            json!({ "id": app.id, "envId": env.id, "userId": "user-1" }),
        )
        .await
        .expect("grant rpc")["token"]
        .as_str()
        .expect("token")
        .to_string();
    assert_eq!(
        env_gate::verify_grant(&harness.state.config, &token),
        Some((env.id.clone(), "user-1".to_string()))
    );
    let (status, body) = harness
        .rest("POST", &path, Some(json!({ "userId": "user-1" })))
        .await;
    assert_eq!(status, StatusCode::OK);
    let rest_token = body["token"].as_str().expect("token").to_string();
    assert_eq!(
        env_gate::verify_grant(&harness.state.config, &rest_token).map(|(id, _)| id),
        Some(env.id.clone())
    );

    // A user id is required, and an environment only grants through its own
    // app: another app's id is not a way in.
    assert_eq!(
        harness
            .rpc(
                "environments.grant",
                json!({ "id": app.id, "envId": env.id, "userId": "" })
            )
            .await
            .expect_err("empty user")
            .0,
        400
    );
    let other = harness.seed_app("other").await;
    let other_path = format!("/v1/apps/{}/environments/{}/grant", other.id, env.id);
    let (status, _) = harness
        .rest("POST", &other_path, Some(json!({ "userId": "user-1" })))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        harness
            .rpc(
                "environments.grant",
                json!({ "id": other.id, "envId": env.id, "userId": "user-1" })
            )
            .await
            .expect_err("foreign app")
            .0,
        404
    );
    harness.finish().await;
}
