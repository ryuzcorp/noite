//! Storage inventory over the deployed wrangler config, plus the shared
//! wrangler parsing. Backends live in `d1` / `durable` / `r2`.
use anyhow::{bail, Context};
use serde::Serialize;
use serde_json::Value;

use crate::config::Config;
use crate::host::source;
use crate::models::App;

pub mod d1;
pub mod durable;
pub mod r2;

pub use d1::{d1_preview, d1_write};
pub use durable::do_instances;
pub use r2::{r2_delete, r2_get, r2_list, r2_raw};

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

pub(crate) fn parse_wrangler(text: &str) -> anyhow::Result<serde_json::Value> {
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
