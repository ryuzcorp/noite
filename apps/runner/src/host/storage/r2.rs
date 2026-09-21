//! R2 bucket listing, download, delete, preview.
use serde::Serialize;

use crate::config::Config;
use crate::host::cmd;
use crate::models::App;

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
