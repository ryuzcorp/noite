// Storage preview (curated read-only).
//
// Enumerates an app's D1 databases and Durable Object classes from the
// *deployed* wrangler.jsonc (the bare mirror the deploy pipeline fetched),
// and D1 table/row previews via `celld d1 execute` against the live fleet's
// authenticated /runtime/ route.
//
// NOTE (gating): readback is intentionally ungated for now (single-operator
// localhost premise). Exposing it multi-user still needs to gate the shared
// S3 root keys and app-data reading (operator-host + collaborator-scoped)
// before this ships anywhere shared.
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::Serialize;

use crate::config::Config;
use crate::host::cmd;
use crate::host::source;
use crate::models::App;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    pub app_id: String,
    pub app_slug: String,
    pub app_name: String,
    pub kind: String, // "d1" | "do" | "r2"
    pub id: String,   // unique across kinds: "{kind}:{name}"
    pub name: String, // d1 database_name, do class_name, or r2 bucket_name
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct D1Preview {
    pub app_id: String,
    pub app_slug: String,
    pub database_id: String,
    pub tables: Vec<String>,
    pub rows: Vec<String>,
}

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

fn parse_wrangler(text: &str) -> anyhow::Result<serde_json::Value> {
    // wrangler.jsonc is JSONC (comments/trailing commas); serde_json is strict.
    // Strip // and /* */ comments and trailing commas conservatively.
    let mut clean = String::with_capacity(text.len());
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_string = false;
    let chars = text.chars().collect::<Vec<_>>();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                clean.push(c);
            }
        } else if in_block_comment {
            if c == '*' && next == Some('/') {
                in_block_comment = false;
                i += 1;
            }
        } else if in_string {
            clean.push(c);
            if c == '\\' {
                if let Some(esc) = next {
                    clean.push(esc);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
        } else {
            match c {
                '"' => {
                    in_string = true;
                    clean.push(c);
                }
                '/' if next == Some('/') => {
                    in_line_comment = true;
                    i += 1;
                }
                '/' if next == Some('*') => {
                    in_block_comment = true;
                    i += 1;
                }
                ',' => {
                    // Drop a trailing comma before } or ].
                    let following = chars
                        .iter()
                        .skip(i + 1)
                        .find(|x| !x.is_whitespace())
                        .copied();
                    if following == Some('}') || following == Some(']') {
                        // skip (do not emit comma)
                    } else {
                        clean.push(c);
                    }
                }
                _ => clean.push(c),
            }
        }
        i += 1;
    }
    serde_json::from_str(&clean).context("parse wrangler config")
}

/// Read the deployed wrangler config at the given rev (bare mirror).
pub async fn deployed_wrangler(
    cfg: &Config,
    app: &App,
) -> anyhow::Result<serde_json::Value> {
    let Some(rev) = source::resolve_rev(cfg, app).await? else {
        bail!("no deployed source — push to main first");
    };
    for candidate in ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] {
        if let Ok(blob) = source::read_blob(cfg, app, &rev, candidate).await {
            if blob.text.trim().is_empty() || blob.binary {
                continue;
            }
            if candidate.ends_with(".toml") {
                // TOML is out of scope for now (jsonc/json only).
                continue;
            }
            return parse_wrangler(&blob.text);
        }
    }
    bail!("no wrangler.json(c) in deployed source")
}

/// Enumerate D1 databases and DO classes declared by the deployed app.
pub async fn list_storage(cfg: &Config, app: &App) -> anyhow::Result<Vec<StorageItem>> {
    let cfg_v = deployed_wrangler(cfg, app).await?;
    let mut items = Vec::new();
    if let Some(Value::Array(dbs)) = cfg_v.get("d1_databases") {
        for db in dbs {
            let name = db.get("database_name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            items.push(StorageItem {
                app_id: app.id.clone(),
                app_slug: app.slug.clone(),
                app_name: app.name.clone(),
                kind: "d1".into(),
                id: format!("d1:{name}"),
                name: name.to_string(),
            });
        }
    }
    if let Some(Value::Array(buckets)) = cfg_v.get("r2_buckets") {
        for b in buckets {
            let name = b.get("bucket_name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            items.push(StorageItem {
                app_id: app.id.clone(),
                app_slug: app.slug.clone(),
                app_name: app.name.clone(),
                kind: "r2".into(),
                id: format!("r2:{name}"),
                name: name.to_string(),
            });
        }
    }
    if let Some(Value::Object(dos)) = cfg_v.get("durable_objects") {
        if let Some(Value::Array(bindings)) = dos.get("bindings") {
            for b in bindings {
                let cls = b.get("class_name").and_then(|v| v.as_str()).unwrap_or("");
                let binding = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                if cls.is_empty() {
                    continue;
                }
                items.push(StorageItem {
                    app_id: app.id.clone(),
                    app_slug: app.slug.clone(),
                    app_name: app.name.clone(),
                    kind: "do".into(),
                    id: format!("do:{binding}:{cls}"),
                    name: cls.to_string(),
                });
            }
        }
    }
    Ok(items)
}

/// Materialize the deployed source into a persistent project dir so celld's
/// `d1` can find wrangler.jsonc (resolve_config reads it from the cwd).
async fn ensure_project(cfg: &Config, app: &App) -> anyhow::Result<PathBuf> {
    let Some(rev) = source::resolve_rev(cfg, app).await? else {
        bail!("no deployed source — push to main first");
    };
    let proj = cmd::work_root(cfg).join("projects").join(&app.slug);
    source::checkout_worktree(cfg, &app.slug, &rev, &proj).await?;
    Ok(proj)
}

/// Curated read-only D1 preview: table list + first rows of each.
pub async fn d1_preview(
    cfg: &Config,
    app: &App,
    database_id: &str,
    limit: usize,
) -> anyhow::Result<D1Preview> {
    // celld d1 must resolve the declared database from this app's own
    // wrangler.jsonc (cwd), and needs its S3 bucket to find the fleet node.
    // Use the stored fleet bucket exactly as ensure_fleet passes it to celld.
    let proj = ensure_project(cfg, app).await?;
    let bucket = app.fleet_bucket.clone();
    let env_owned = cmd::aws_env(cfg);
    let mut env: Vec<(&str, &str)> =
        env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    env.push(("S3_ENDPOINT", cfg.s3_endpoint.as_str()));

    // celld d1 knows no sqlite3 dot-commands, so `.tables` fails the SQL
    // parse inside the cell. Enumerate instead with the read-only
    // `PRAGMA table_list` the cell's SQL authorizer explicitly allows, and
    // take --json rows so the parsing reads fields, not whitespace soup.
    let sql = "PRAGMA table_list";
    let tables_out = cmd::run_cmd(
        &cfg.celld_bin,
        &[
            "d1", "execute", database_id,
            "--command", &sql,
            "--json",
            "--bucket", &bucket,
        ],
        Some(&proj),
        &env,
        Duration::from_secs(30),
    )
    .await
    .with_context(|| format!("celld d1 {database_id}"))?;

    // Keep real tables only, and exclude SQLite/celld internals (sqlite_*,
    // _cf_* / ltx control, _litestream_*) plus the wrangler migration
    // bookkeeping table.
    let mut tables: Vec<String> = Vec::new();
    for line in tables_out.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if row.get("type").and_then(|v| v.as_str()) != Some("table") {
            continue;
        }
        let Some(name) = row.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if name.starts_with('_') || name.starts_with("sqlite_") || name == "d1_migrations" {
            continue;
        }
        tables.push(name.to_string());
    }

    let mut rows = Vec::new();
    for table in &tables {
        let sql = format!("SELECT * FROM \"{}\" LIMIT {}", table, limit);
        if let Ok(out) = cmd::run_cmd(
            &cfg.celld_bin,
            &["d1", "execute", database_id, "--command", &sql, "--bucket", &bucket],
            Some(&proj),
            &env,
            Duration::from_secs(30),
        )
        .await
        {
            rows.push(out);
        }
    }

    Ok(D1Preview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        database_id: database_id.to_string(),
        tables,
        rows,
    })
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Object {
    pub key: String,
    pub size: i64,
    pub last_modified: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2Preview {
    pub app_id: String,
    pub app_slug: String,
    pub bucket: String,
    pub objects: Vec<R2Object>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct R2File {
    pub key: String,
    pub size: i64,
    pub truncated: bool,
    /// UTF-8 body (up to the preview cap); None for binary objects.
    pub text: Option<String>,
}

/// celld serves `r2_buckets` out of the fleet bucket under the reserved
/// `r2/<bucketName>/` prefix — walk it directly like `cell list` does.
fn r2_prefix(app: &App, bucket: &str) -> String {
    format!("fleets/{}/r2/{bucket}/", app.slug)
}

/// Read-only R2 key listing for one bucket (newest first, capped).
pub async fn r2_list(
    cfg: &Config,
    app: &App,
    bucket: &str,
    limit: usize,
) -> anyhow::Result<R2Preview> {
    let prefix = r2_prefix(app, bucket);
    let json = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await?;
    let mut objects = Vec::new();
    if !json.trim().is_empty() && json.trim() != "null" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) {
                for obj in contents {
                    let Some(full) = obj.get("Key").and_then(|k| k.as_str()) else {
                        continue;
                    };
                    let key = full.strip_prefix(&prefix).unwrap_or(full);
                    if key.is_empty() {
                        continue;
                    }
                    objects.push(R2Object {
                        key: key.to_string(),
                        size: obj.get("Size").and_then(|s| s.as_i64()).unwrap_or(0),
                        last_modified: obj
                            .get("LastModified")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string(),
                    });
                }
            }
        }
    }
    objects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    objects.truncate(limit);
    Ok(R2Preview {
        app_id: app.id.clone(),
        app_slug: app.slug.clone(),
        bucket: bucket.to_string(),
        objects,
    })
}

/// Resolve a user-supplied key to its full S3 key, rejecting escapes.
fn r2_full_key(app: &App, bucket: &str, key: &str) -> anyhow::Result<String> {
    if key.is_empty() || key.starts_with('/') || key.split('/').any(|s| s == "..") {
        anyhow::bail!("invalid key");
    }
    Ok(format!("{}{key}", r2_prefix(app, bucket)))
}

/// Byte size of one object, looked up by exact full key.
async fn r2_size(cfg: &Config, full: &str) -> anyhow::Result<Option<i64>> {
    let json = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, full).await?;
    let mut size: Option<i64> = None;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
        if let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) {
            for obj in contents {
                if obj.get("Key").and_then(|k| k.as_str()) == Some(full) {
                    size = obj.get("Size").and_then(|s| s.as_i64());
                }
            }
        }
    }
    Ok(size)
}

/// Full R2 object bytes for download, capped at 64 MiB.
pub async fn r2_raw(
    cfg: &Config,
    app: &App,
    bucket: &str,
    key: &str,
) -> anyhow::Result<Vec<u8>> {
    const CAP: i64 = 67_108_864;
    let full = r2_full_key(app, bucket, key)?;
    let Some(size) = r2_size(cfg, &full).await? else {
        anyhow::bail!("object not found");
    };
    if size > CAP {
        anyhow::bail!("object too large to download");
    }
    let dir = cmd::work_root(cfg).join("r2-preview");
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!(
        "{}-{}-{}",
        app.slug,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    cmd::s3_cp_download(cfg, &cfg.s3_uri(&full), &dest).await?;
    let bytes = tokio::fs::read(&dest).await?;
    let _ = tokio::fs::remove_file(&dest).await;
    Ok(bytes)
}

/// Delete one R2 object by key.
pub async fn r2_delete(
    cfg: &Config,
    app: &App,
    bucket: &str,
    key: &str,
) -> anyhow::Result<()> {
    let full = r2_full_key(app, bucket, key)?;
    if r2_size(cfg, &full).await?.is_none() {
        anyhow::bail!("object not found");
    }
    cmd::s3_delete_key(cfg, &full).await?;
    Ok(())
}

/// Read-only R2 object fetch, bounded: rejects keys escaping the bucket
/// prefix and previews at most 256 KiB of UTF-8 text (None when binary).
pub async fn r2_get(
    cfg: &Config,
    app: &App,
    bucket: &str,
    key: &str,
) -> anyhow::Result<R2File> {
    const CAP: usize = 262_144;
    if key.is_empty() || key.starts_with('/') || key.split('/').any(|s| s == "..") {
        anyhow::bail!("invalid key");
    }
    let full = format!("{}{key}", r2_prefix(app, bucket));
    // Size-gate before downloading so a stray multi-GB object can't OOM us.
    let json = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, &full).await?;
    let mut size: Option<i64> = None;
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
        if let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) {
            for obj in contents {
                if obj.get("Key").and_then(|k| k.as_str()) == Some(&full) {
                    size = obj.get("Size").and_then(|s| s.as_i64());
                }
            }
        }
    }
    let Some(size) = size else {
        anyhow::bail!("object not found");
    };
    let dir = cmd::work_root(cfg).join("r2-preview");
    tokio::fs::create_dir_all(&dir).await?;
    let dest = dir.join(format!(
        "{}-{}-{}",
        app.slug,
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    cmd::s3_cp_download(cfg, &cfg.s3_uri(&full), &dest).await?;
    let bytes = tokio::fs::read(&dest).await?;
    let _ = tokio::fs::remove_file(&dest).await;
    let truncated = bytes.len() > CAP;
    let head = &bytes[..bytes.len().min(CAP)];
    Ok(R2File {
        key: key.to_string(),
        size,
        truncated,
        text: String::from_utf8(head.to_vec()).ok(),
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

#[allow(unused_imports)]
use serde_json::Value;
