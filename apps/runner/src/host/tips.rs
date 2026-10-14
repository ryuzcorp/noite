//! Push-driven tip channel (T2.2): the Git smart-HTTP adapter and web
//! commits already know when a ref moves, so they notify the reconcile loop
//! directly instead of making it poll S3. The `head_*` sweep stays as the
//! fallback for bundles written behind the runner's back.
//!
//! A tip is per ref, not per app: `refs/heads/main` deploys production, and
//! any ref a preview environment tracks (`refs/heads/<branch>`,
//! `refs/previews/<userId>/<branch>`) deploys that environment.
use crate::config::Config;
use crate::host::s3;

/// The tip bundle for one ref: the S3 key the push wrote and the sha it
/// carries.
#[derive(Debug, Clone)]
pub struct TipBundle {
    pub key: String,
    pub sha: String,
}

/// One moved ref's tip bundle.
#[derive(Debug, Clone)]
pub struct RefTip {
    /// Full ref name (`refs/heads/<branch>`, `refs/previews/<user>/<branch>`).
    pub git_ref: String,
    pub bundle: TipBundle,
}

/// One moved tip: which app, which ref, and the bundle key + sha the write
/// produced.
#[derive(Debug, Clone)]
pub struct TipNotify {
    pub app_id: String,
    /// Full ref name; the loop resolves what (if anything) tracks it.
    pub git_ref: String,
    pub tip: TipBundle,
}

pub type TipSender = tokio::sync::mpsc::UnboundedSender<TipNotify>;
pub type TipReceiver = tokio::sync::mpsc::UnboundedReceiver<TipNotify>;

pub fn channel() -> (TipSender, TipReceiver) {
    tokio::sync::mpsc::unbounded_channel()
}

/// Newest tip bundle under one ref's prefix (the fallback sweep's read).
pub async fn head_ref_bundle(
    cfg: &Config,
    slug: &str,
    git_ref: &str,
) -> anyhow::Result<Option<TipBundle>> {
    let prefix = format!("git/{slug}/{git_ref}/");
    let json = s3::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await?;
    if json.trim().is_empty() || json.trim() == "null" {
        return Ok(None);
    }
    let v: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) else {
        return Ok(None);
    };
    let re = regex_lite_bundle();
    let mut best: Option<(String, String, String)> = None; // key, sha, last_modified
    for obj in contents {
        let Some(key) = obj.get("Key").and_then(|k| k.as_str()) else {
            continue;
        };
        let name = key.strip_prefix(&prefix).unwrap_or(key);
        let Some(caps) = re.captures(name) else {
            continue;
        };
        let sha = caps.get(1).unwrap().as_str().to_lowercase();
        let lm = obj
            .get("LastModified")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if best
            .as_ref()
            .map(|b| lm.as_str() >= b.2.as_str())
            .unwrap_or(true)
        {
            best = Some((key.to_string(), sha, lm));
        }
    }
    Ok(best.map(|(key, sha, _)| TipBundle { key, sha }))
}

/// Production's tip: `refs/heads/main` only (`head_ref_bundle` generalized).
pub async fn head_main_bundle(cfg: &Config, slug: &str) -> anyhow::Result<Option<TipBundle>> {
    head_ref_bundle(cfg, slug, "refs/heads/main").await
}

fn regex_lite_bundle() -> regex::Regex {
    regex::Regex::new(r"(?i)^([0-9a-f]{7,40})\.bundle$").expect("bundle re")
}
