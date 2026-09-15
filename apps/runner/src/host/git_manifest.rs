//! Per-slug git manifest: the linearization point for pushes (walgit-inspired).
//!
//! Layout: `git/{slug}/MANIFEST.json` — `{version, seq, refs: {refname: {sha,
//! bundle}}}`. A push writes all ref tip bundles first, then the manifest
//! once; readers resolve refs from the manifest, so a half-written push is
//! never visible. Legacy slugs without a manifest fall back to scanning tip
//! bundles. The manifest moves with `git/{slug}/` on rename and clears with
//! the prefix on purge, so no extra handling is needed there.
//!
//! Concurrency: the runner is the single writer; pushes to one slug are
//! serialized by [`GitSync::push_guard`]. The manifest gives atomic
//! *visibility*; the mutex gives sound check-then-act (policy, fast-forward).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::host::cmd;

/// Manifest format version. Readers accept only what they know.
pub const MANIFEST_VERSION: u8 = 1;

pub fn manifest_key(slug: &str) -> String {
    format!("git/{slug}/MANIFEST.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestRef {
    pub sha: String,
    pub bundle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u8,
    pub seq: u64,
    pub refs: HashMap<String, ManifestRef>,
}

/// Single-writer coordination for git pushes: per-slug push mutex plus the
/// last manifest seq applied to each local bare mirror.
#[derive(Clone, Default)]
pub struct GitSync {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    applied: Arc<Mutex<HashMap<String, u64>>>,
}

impl GitSync {
    /// Hold across a whole push (policy check → git → S3 → manifest).
    pub async fn push_guard(&self, slug: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(slug.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    pub async fn applied_seq(&self, slug: &str) -> Option<u64> {
        self.applied.lock().await.get(slug).copied()
    }

    pub async fn set_applied_seq(&self, slug: &str, seq: u64) {
        self.applied.lock().await.insert(slug.to_string(), seq);
    }
}

/// Read the manifest, if the slug has one yet.
pub async fn read_manifest(cfg: &Config, slug: &str) -> anyhow::Result<Option<Manifest>> {
    let tmp = cmd::work_root(cfg)
        .join("git-http")
        .join(format!(".manifest-{slug}.json"));
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let uri = cfg.s3_uri(&manifest_key(slug));
    match cmd::s3_cp_download(cfg, &uri, &tmp).await {
        Ok(()) => {}
        Err(_) => return Ok(None), // no manifest yet → legacy bundle scan
    }
    let bytes = tokio::fs::read(&tmp).await?;
    let _ = tokio::fs::remove_file(&tmp).await;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.version != MANIFEST_VERSION {
        anyhow::bail!("manifest version {} unsupported", manifest.version);
    }
    Ok(Some(manifest))
}

/// Write the manifest once per push, after all tip bundles land.
pub async fn write_manifest(cfg: &Config, slug: &str, manifest: &Manifest) -> anyhow::Result<()> {
    let tmp = cmd::work_root(cfg)
        .join("git-http")
        .join(format!(".manifest-{slug}.json"));
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec(manifest)?;
    tokio::fs::write(&tmp, &bytes).await?;
    let result = cmd::s3_cp_upload(cfg, &tmp, &manifest_key(slug)).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

fn bundle_tmp(cfg: &Config, slug: &str, sha: &str) -> PathBuf {
    cmd::work_root(cfg)
        .join("git-http")
        .join(format!(".refresh-{slug}-{sha}.bundle"))
}

/// Apply one manifest ref to the local bare mirror.
pub async fn fetch_manifest_ref(
    cfg: &Config,
    bare: &std::path::Path,
    bundle_key: &str,
    sha: &str,
    refname: &str,
) -> anyhow::Result<()> {
    let bundle = bundle_tmp(cfg, &bundle_key_bundle_slug(bundle_key), sha);
    if let Some(parent) = bundle.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    cmd::s3_cp_download(cfg, &cfg.s3_uri(bundle_key), &bundle).await?;
    let result = cmd::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            bundle.to_str().unwrap_or_default(),
            &format!("+{sha}:{refname}"),
        ],
        None,
        &[],
        Duration::from_secs(60),
    )
    .await;
    let _ = tokio::fs::remove_file(&bundle).await;
    result?;
    Ok(())
}

/// Bundle keys embed the slug (`git/{slug}/…`); recover it for tmp paths.
fn bundle_key_bundle_slug(bundle_key: &str) -> String {
    bundle_key
        .strip_prefix("git/")
        .and_then(|rest| rest.split_once('/'))
        .map(|(slug, _)| slug.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Bring a bare mirror up to the manifest: fetch refs whose sha differs from
/// local, then record the seq. Best-effort per ref — callers warn and serve
/// from what is local on failure.
pub async fn refresh_bare(
    cfg: &Config,
    bare: &std::path::Path,
    manifest: &Manifest,
    local: &HashMap<String, String>,
) -> anyhow::Result<()> {
    for (refname, entry) in &manifest.refs {
        if local.get(refname).map(|s| s.as_str()) == Some(entry.sha.as_str()) {
            continue;
        }
        fetch_manifest_ref(cfg, bare, &entry.bundle, &entry.sha, refname).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip() {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            seq: 7,
            refs: HashMap::from([(
                "refs/heads/main".to_string(),
                ManifestRef {
                    sha: "a".repeat(40),
                    bundle: "git/demo/refs/heads/main/aaa.bundle".to_string(),
                },
            )]),
        };
        let Ok(bytes) = serde_json::to_vec(&manifest) else {
            panic!("manifest must serialize");
        };
        let Ok(back): Result<Manifest, _> = serde_json::from_slice(&bytes) else {
            panic!("manifest must deserialize");
        };
        assert_eq!(back.seq, 7);
        assert_eq!(back.refs["refs/heads/main"].sha, "a".repeat(40));
    }

    #[test]
    fn manifest_key_shape() {
        assert_eq!(manifest_key("demo"), "git/demo/MANIFEST.json");
    }
}
