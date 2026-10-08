//! Storage inventory over the deployed wrangler config, plus the shared
//! wrangler parsing. Backends live in `d1` / `durable` / `r2`.
use anyhow::Context;
use serde::Serialize;
use ts_rs::TS;
use serde_json::Value;

use crate::config::Config;
use crate::host::{forge, source};
use crate::models::App;

pub mod d1;
pub mod durable;
pub mod r2;

pub use d1::{d1_delete_rows, d1_rows, d1_schema, d1_tables, d1_write};
pub use durable::do_instances;
pub use r2::{r2_delete_many, r2_get, r2_list, r2_put, r2_raw};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
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
    // Comments go first, so a comma followed by a comment and then `}` is
    // still seen as trailing.
    let uncommented = strip_jsonc_comments(text);
    serde_json::from_str(&strip_trailing_commas(&uncommented)).context("parse wrangler config")
}

/// `//` and `/* */` comments removed outside strings (line breaks kept).
fn strip_jsonc_comments(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_string = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                clean.push(c);
            }
        } else if in_block_comment {
            if c == '*' && chars.peek() == Some(&'/') {
                in_block_comment = false;
                chars.next();
            }
        } else if in_string {
            clean.push(c);
            if c == '\\' {
                if let Some(esc) = chars.next() {
                    clean.push(esc);
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == '/' && chars.peek() == Some(&'/') {
            in_line_comment = true;
            chars.next();
        } else if c == '/' && chars.peek() == Some(&'*') {
            in_block_comment = true;
            chars.next();
        } else {
            in_string = c == '"';
            clean.push(c);
        }
    }
    clean
}

/// Commas directly before `}` or `]` (whitespace between) removed outside
/// strings. Expects comment-free input.
fn strip_trailing_commas(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut clean = String::with_capacity(text.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            clean.push(c);
            if c == '\\' {
                if let Some(&esc) = chars.get(i + 1) {
                    clean.push(esc);
                    i += 1;
                }
            } else if c == '"' {
                in_string = false;
            }
        } else if c == ',' {
            let following = chars[i + 1..].iter().find(|x| !x.is_whitespace());
            if !matches!(following, Some('}' | ']')) {
                clean.push(c);
            }
        } else {
            in_string = c == '"';
            clean.push(c);
        }
        i += 1;
    }
    clean
}

/// The deployed wrangler config, or `None` when there is none to read yet
/// (nothing pushed, or no wrangler.json(c)): such an app has no storage.
pub async fn deployed_wrangler(
    cfg: &Config,
    app: &App,
) -> anyhow::Result<Option<serde_json::Value>> {
    // What the last deploy uploaded; covers configs the source does not hold
    // (cloudflare.config.ts, a built dist/wrangler.json).
    if let Some(json) = app.deployed_config.as_deref() {
        return Ok(Some(serde_json::from_str(json)?));
    }
    let bare = forge::read_mirror_cfg(cfg, &app.slug).await?;
    let Some(rev) = forge::read_rev(&bare, app, None).await? else {
        return Ok(None);
    };
    for candidate in ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] {
        if let Ok(blob) = source::read_blob(&bare, &rev, candidate).await {
            if blob.text.trim().is_empty() || blob.binary {
                continue;
            }
            if candidate.ends_with(".toml") {
                // TOML is out of scope for now (jsonc/json only).
                continue;
            }
            return parse_wrangler(&blob.text).map(Some);
        }
    }
    Ok(None)
}

pub async fn list_storage(cfg: &Config, app: &App) -> anyhow::Result<Vec<StorageItem>> {
    let Some(cfg_v) = deployed_wrangler(cfg, app).await? else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    if let Some(Value::Array(dbs)) = cfg_v.get("d1_databases") {
        for db in dbs {
            let name = db
                .get("database_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
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

#[cfg(test)]
mod tests {
    use super::parse_wrangler;

    #[test]
    fn jsonc_comments_and_trailing_commas_are_accepted() {
        // A trailing comma followed by a comment used to survive comment
        // stripping and fail the deploy ("trailing comma at line N").
        let text = r#"{
  "name": "a", // the worker
  "assets": { "directory": "./dist/" /* built */, },
  "vars": { "URL": "https://x.dev/a//b", "Q": "say \"hi\", }" },
  "flags": ["nodejs_compat", /* more later */ ],
  // trailing
}"#;
        let value = parse_wrangler(text).expect("valid JSONC");
        assert_eq!(value["name"], "a");
        assert_eq!(value["assets"]["directory"], "./dist/");
        assert_eq!(value["vars"]["URL"], "https://x.dev/a//b");
        assert_eq!(value["vars"]["Q"], "say \"hi\", }");
        assert_eq!(value["flags"], serde_json::json!(["nodejs_compat"]));
    }

    #[test]
    fn a_comma_between_members_is_kept() {
        assert!(parse_wrangler(r#"{"a": 1 /* x */, "b": 2}"#).is_ok());
        assert!(parse_wrangler(r#"{"a": 1 "b": 2}"#).is_err());
    }
}
