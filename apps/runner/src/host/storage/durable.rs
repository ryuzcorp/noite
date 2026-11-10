//! Durable Object instance list + `?read=1` probes.
use std::time::Duration;

use anyhow::Context;
use serde::Serialize;
use ts_rs::TS;

use crate::config::Config;
use crate::host::{exec, s3};
use crate::models::App;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DoInstance {
    pub id: String,
    pub scope: String,
    /// JSON the object's own handler returned for a `?read=1` probe on the
    /// fleet's /do/ route (the read contract is the app's, not celld's —
    /// there is no generic storage read route for a Durable Object).
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DoPreview {
    pub app_id: String,
    pub app_slug: String,
    pub class_name: String,
    pub instances: Vec<DoInstance>,
}

/// Read-only Durable Object instance list for one class: `celld cell list`
/// walks the fleet bucket directly (no live node needed) and prints one
/// JSON row per instance. celld exposes no generic storage read route for
/// a DO instance, so each instance is also probed with `GET /do/{scope}
/// ?read=1` — the object's own handler decides what its preview says.
pub async fn do_instances(cfg: &Config, app: &App, class_name: &str) -> anyhow::Result<DoPreview> {
    let bucket = app.fleet_bucket.clone();
    let scope_key = crate::host::credentials::Scope::app(app).key();
    let env_owned = s3::celld_cli_env(cfg, &scope_key);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let out = exec::run_cmd(
        &cfg.celld_bin,
        &["cell", "list", class_name, "--json", "--bucket", &bucket],
        None,
        &env,
        Duration::from_secs(30),
    )
    .await
    .with_context(|| format!("celld cell list {class_name}"))?;

    let mut instances = Vec::new();
    for line in out.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // celld's own cells (D1, KV, queues...) carry reserved class names;
        // a user class never collides with one, but refuse them anyway.
        if row.get("reserved").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let scope = row.get("scope").and_then(|v| v.as_str()).unwrap_or(id);
        instances.push(DoInstance {
            id: id.to_string(),
            scope: scope.to_string(),
            preview: None,
        });
    }

    // Read each live instance's response to a `?read=1` probe: the app's own
    // fetch runs (the sample Counter reports { n } without advancing it); a
    // missing/unresponsive instance leaves the cell blank.
    for instance in &mut instances {
        instance.preview = probe_instance(app, &instance.scope)
            .await
            .into_preview(&instance.scope);
    }
    Ok(DoPreview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        class_name: class_name.to_string(),
        instances,
    })
}

/// What one `?read=1` probe found. The wire keeps today's single
/// `preview: Option<String>` (blank cell for every non-preview outcome), but
/// the reasons are distinct here so operators and agents can tell a stale
/// token from a dead fleet (ROTH-3/ROTH-15) — the missing port, the missing
/// operator token, a refusal and an unreachable node are not the same failure.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DoProbe {
    /// The object's handler answered; this is its capped body.
    Preview(String),
    /// No internal listener to probe (the fleet never advertised one).
    NoPort,
    /// The node refused the request (a 401 from a bare probe, a 404 for a
    /// gone instance, …). The body is never surfaced: it is the app's.
    Refused(u16),
    /// The request itself failed (timeout, connection refused).
    Unreachable,
}

impl DoProbe {
    /// The wire view: only a real preview is content; every failure is a
    /// blank cell, exactly as before, with the reason kept in the debug log
    /// so a stale operator token is not mistaken for a dead fleet.
    fn into_preview(self, scope: &str) -> Option<String> {
        match self {
            Self::Preview(body) => Some(body),
            Self::NoPort => {
                tracing::debug!(scope, "do probe skipped: no internal port");
                None
            }
            Self::Refused(status) => {
                tracing::debug!(scope, status, "do probe refused");
                None
            }
            Self::Unreachable => {
                tracing::debug!(scope, "do probe unreachable");
                None
            }
        }
    }
}

/// `GET /do/{scope}?read=1` on the fleet's internal listener, capped and
/// best-effort. The loopback address matches ensure_fleet's --advertise;
/// rootless podman routes it to the fleet child in the runner's netns. The
/// fleet's operator token rides as a Bearer token (the node requires it on
/// every internal route); without a cached token the probe goes out bare and
/// a 401 is a `Refused(401)` — the same blank cell on the wire, but no longer
/// indistinguishable from a dead fleet in the probe's own state.
async fn probe_instance(app: &App, scope: &str) -> DoProbe {
    let Some(port) = app.internal_port else {
        return DoProbe::NoPort;
    };
    let url = format!("http://127.0.0.1:{port}/do/{scope}?read=1");
    let scope_key = crate::host::credentials::Scope::app(app).key();
    let mut request = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(5));
    if let Some(token) = crate::host::credentials::cached_operator_token(&scope_key) {
        request = request.bearer_auth(token);
    }
    let Ok(response) = request.send().await else {
        return DoProbe::Unreachable;
    };
    // A refusal (a 401 without the token, a 404 for a gone instance) is
    // missing, not a preview: surfacing the refusal body would misreport
    // tenant-visible data.
    if !response.status().is_success() {
        return DoProbe::Refused(response.status().as_u16());
    }
    let Ok(body) = response.text().await else {
        return DoProbe::Unreachable;
    };
    DoProbe::Preview(body.chars().take(2000).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal celld `/do/` stand-in: one canned status and body.
    async fn serve_status(
        listener: tokio::net::TcpListener,
        status: &'static str,
        body: &'static str,
    ) {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = [0u8; 4096];
        let mut req = Vec::new();
        while !req.ends_with(b"\r\n\r\n") {
            let Ok(n) = stream.read(&mut buf).await else {
                return;
            };
            if n == 0 || req.len() > 8192 {
                return;
            }
            req.extend_from_slice(&buf[..n]);
        }
        let _ = stream
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
    }

    async fn seed_app_on(pool: &sqlx::SqlitePool, port: i64) -> App {
        let cfg = crate::config::config_for_tests();
        let slug = format!("shop-{port}");
        let mut app = crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "shop",
                slug: &slug,
                user_id: "user_test",
                subdomain: "shop.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        app.internal_port = Some(port);
        app
    }

    /// A refusal — a 401 without the token, a 404 for a gone instance —
    /// reads as a missing instance, never as a preview body; a 200 still
    /// previews.
    #[tokio::test]
    async fn probe_refusals_read_as_missing() {
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("memory db");
        for (status, body) in [
            ("401 Unauthorized", "unauthorized"),
            ("404 Not Found", "gone"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind");
            let port = i64::from(listener.local_addr().expect("addr").port());
            tokio::spawn(serve_status(listener, status, body));
            let app = seed_app_on(&pool, port).await;
            assert_eq!(
                probe_instance(&app, "scope").await.into_preview("scope"),
                None,
                "{status} is missing"
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = i64::from(listener.local_addr().expect("addr").port());
        tokio::spawn(serve_status(listener, "200 OK", r#"{"n":1}"#));
        let app = seed_app_on(&pool, port).await;
        assert_eq!(
            probe_instance(&app, "scope").await,
            DoProbe::Preview(r#"{"n":1}"#.to_string()),
            "a 200 previews"
        );
        pool.close().await;
    }
}
