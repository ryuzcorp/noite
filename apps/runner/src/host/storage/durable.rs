//! Durable Object instance list + `?read=1` probes.
use std::time::Duration;

use anyhow::Context;
use serde::Serialize;

use crate::config::Config;
use crate::host::cmd;
use crate::models::App;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoInstance {
    pub id: String,
    pub scope: String,
    /// JSON the object's own handler returned for a `?read=1` probe on the
    /// fleet's /do/ route (the read contract is the app's, not celld's —
    /// there is no generic storage read route for a Durable Object).
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
pub async fn do_instances(
    cfg: &Config,
    app: &App,
    class_name: &str,
) -> anyhow::Result<DoPreview> {
    let bucket = app.fleet_bucket.clone();
    let env_owned = cmd::aws_env(cfg);
    let mut env: Vec<(&str, &str)> =
        env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));
    let out = cmd::run_cmd(
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
        instance.preview = probe_instance(app, &instance.scope).await;
    }
    Ok(DoPreview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        class_name: class_name.to_string(),
        instances,
    })
}

/// `GET /do/{scope}?read=1` on the fleet's internal listener, capped and
/// best-effort. The loopback address matches ensure_fleet's --advertise;
/// rootless podman routes it to the fleet child in the runner's netns.
async fn probe_instance(app: &App, scope: &str) -> Option<String> {
    let Some(port) = app.internal_port else {
        return None;
    };
    let url = format!("http://127.0.0.1:{port}/do/{scope}?read=1");
    let Ok(response) = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    else {
        return None;
    };
    let Ok(body) = response.text().await else {
        return None;
    };
    Some(body.chars().take(2000).collect())
}
