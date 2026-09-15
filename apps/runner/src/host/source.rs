// Source preview: serve the latest pushed commit's tree / blobs / diff from
// the persistent bare mirror (RUNNER_WORK_DIR/repos/{slug}.git) — the same
// mirror the deploy pipeline fetches into. No extra storage needed.
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{bail, Context};
use serde::Serialize;

use crate::config::Config;
use crate::host::cmd;
use crate::models::App;

pub const MAX_BLOB: usize = 256 * 1024;
pub const MAX_PATCH: usize = 1024 * 1024;
const MAX_FILES: usize = 2_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeResponse {
    pub sha: String,
    pub files: Vec<TreeEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobResponse {
    pub sha: String,
    pub path: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResponse {
    pub sha: String,
    pub parent: Option<String>,
    pub patch: String,
    pub truncated: bool,
}

pub fn bare_repo(cfg: &Config, slug: &str) -> PathBuf {
    cmd::work_root(cfg)
        .join("repos")
        .join(format!("{slug}.git"))
}

/// Force-checkout `rev` from the bare mirror into `dest` (shared by storage
/// preview and any other worktree materialization).
pub async fn checkout_worktree(
    cfg: &Config,
    slug: &str,
    rev: &str,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    let bare = bare_repo(cfg, slug);
    if !bare.join("HEAD").exists() {
        anyhow::bail!("no bare mirror for {slug} yet");
    }
    tokio::fs::create_dir_all(dest).await?;
    cmd::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            &format!("--work-tree={}", dest.display()),
            "checkout",
            "-f",
            rev,
        ],
        Some(dest),
        &[],
        Duration::from_secs(30),
    )
    .await?;
    Ok(())
}

/// Rev to browse: last deployed sha, else bare-mirror HEAD (mirror receives
/// every fetch even when a deploy later fails).
pub async fn resolve_rev(cfg: &Config, app: &App) -> anyhow::Result<Option<String>> {
    if let Some(sha) = app.last_deploy_sha.as_deref() {
        return Ok(Some(sha.to_string()));
    }
    let repo = bare_repo(cfg, &app.slug);
    if !repo.join("HEAD").exists() {
        return Ok(None);
    }
    match git(&cfg, &app.slug, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
        Ok(out) => Ok(Some(out.trim().to_string())),
        Err(_) => Ok(None),
    }
}

/// Full recursive listing (git's own tree order — server-sorted, so the UI
/// can use preparePresortedFileTreeInput).
pub async fn list_tree(
    cfg: &Config,
    app: &App,
    rev: &str,
) -> anyhow::Result<TreeResponse> {
    let out = git(
        cfg,
        &app.slug,
        &["ls-tree", "-r", "-z", "-l", rev],
    )
    .await?;
    let mut files = Vec::new();
    let mut truncated = false;
    for rec in out.trim_end_matches('\0').split('\0') {
        if rec.is_empty() {
            continue;
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        let Some((ty, _, size, path)) = parse_tree_record(rec) else {
            continue;
        };
        if ty != "blob" {
            continue;
        }
        files.push(TreeEntry { path, size });
    }
    Ok(TreeResponse {
        sha: rev.to_string(),
        files,
        truncated,
    })
}

fn parse_tree_record(rec: &str) -> Option<(String, String, u64, String)> {
    // Layout varies: with -z the size is space-padded into the head
    // ("<mode> <type> <sha>   <size>\t<path>"); without -z it is its own
    // column ("<mode> <type> <sha>\t<size>\t<path>"). The one invariant is
    // the LAST tab separates the path. Split on whitespace tokens.
    let (head, path) = rec.rsplit_once('\t')?;
    let tokens: Vec<&str> = head.split_whitespace().collect();
    if tokens.len() < 3 {
        return None;
    }
    let ty = tokens[1].to_string();
    let sha = tokens[2].to_string();
    let size: u64 = match tokens.get(3) {
        Some(s) => s.parse().unwrap_or(0),
        None => 0,
    };
    Some((ty, sha, size, path.to_string()))
}

/// Validate a browser-supplied path before it touches git.
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\0')
        && !path.split('/').any(|seg| seg == "..")
}

pub async fn read_blob(
    cfg: &Config,
    app: &App,
    rev: &str,
    path: &str,
) -> anyhow::Result<BlobResponse> {
    if !valid_path(path) {
        bail!("invalid path");
    }
    let out = git(
        cfg,
        &app.slug,
        &["ls-tree", "-z", "-l", rev, "--", path],
    )
    .await?;
    let Some((_, sha, size, _)) = parse_tree_record(out.trim_end_matches('\0')) else {
        bail!("file not found in {rev}");
    };
    let truncated = size > MAX_BLOB as u64;
    let text = if truncated {
        String::new()
    } else {
        // cat-file by the object id we resolved — never from user input.
        git(cfg, &app.slug, &["cat-file", "blob", &sha]).await?
    };
    let binary = size > 0 && !truncated && text.contains('\u{0}');
    let text = if binary { String::new() } else { text };
    Ok(BlobResponse {
        sha: rev.to_string(),
        path: path.to_string(),
        size,
        truncated,
        binary,
        text,
    })
}

pub async fn make_patch(
    cfg: &Config,
    app: &App,
    rev: &str,
) -> anyhow::Result<DiffResponse> {
    // First push has no parent: diff-tree --root diffs against the empty
    // tree (`diff --root` refuses bare repos — it wants a work tree).
    let parent = git(
        cfg,
        &app.slug,
        &["rev-parse", "--verify", "--quiet", &format!("{rev}^")],
    )
    .await
    .ok()
    .map(|s| s.trim().to_string());
    let patch = match &parent {
        Some(p) => {
            git(cfg, &app.slug, &["diff", p, rev]).await?
        }
        None => {
            git(cfg, &app.slug, &["diff-tree", "-p", "--root", rev]).await?
        }
    };
    let (patch, truncated) = if patch.len() > MAX_PATCH {
        (patch[..MAX_PATCH].to_string(), true)
    } else {
        (patch, false)
    };
    Ok(DiffResponse {
        sha: rev.to_string(),
        parent,
        patch,
        truncated,
    })
}

async fn git(cfg: &Config, slug: &str, args: &[&str]) -> anyhow::Result<String> {
    let repo = bare_repo(cfg, slug);
    let git_dir = format!("--git-dir={}", repo.display());
    let mut full = Vec::with_capacity(args.len() + 1);
    full.push(git_dir.as_str());
    full.extend_from_slice(args);
    cmd::run_cmd("git", &full, None, &[], Duration::from_secs(30))
        .await
        .with_context(|| format!("git in {}", repo.display()))
}