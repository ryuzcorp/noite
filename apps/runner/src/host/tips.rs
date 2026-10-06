//! Push-driven tip channel (T2.2): the Git smart-HTTP adapter and web
//! commits already know when `main` moves, so they notify the reconcile loop
//! directly instead of making it poll S3. `head_main_bundle` stays as the
//! fallback sweep for bundles written behind the runner's back.
use crate::config::Config;
use crate::host::s3;

/// The tip bundle for one app: the S3 key the push wrote and the sha it
/// carries.
#[derive(Debug, Clone)]
pub struct TipBundle {
    pub key: String,
    pub sha: String,
}

/// One moved tip: which app, and the bundle key + sha the push wrote.
#[derive(Debug, Clone)]
pub struct TipNotify {
    pub app_id: String,
    pub tip: TipBundle,
}

pub type TipSender = tokio::sync::mpsc::UnboundedSender<TipNotify>;
pub type TipReceiver = tokio::sync::mpsc::UnboundedReceiver<TipNotify>;

pub fn channel() -> (TipSender, TipReceiver) {
    tokio::sync::mpsc::unbounded_channel()
}

pub async fn head_main_bundle(cfg: &Config, slug: &str) -> anyhow::Result<Option<TipBundle>> {
    let prefix = format!("git/{slug}/refs/heads/main/");
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

fn regex_lite_bundle() -> regex::Regex {
    regex::Regex::new(r"(?i)^([0-9a-f]{7,40})\.bundle$").expect("bundle re")
}
