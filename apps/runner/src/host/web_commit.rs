//! Browser web-commit API: commit edited files as `refs/heads/main` without
//! a worktree. Extracted from `git_http` (smart-HTTP protocol stays there);
//! the only caller is `api::app_source_commit`. Shares the bare-mirror
//! helpers (`ensure_bare`, `list_refs`, `after_receive`) with the receive path.
use std::time::Duration;

use anyhow::{bail, Context};

use crate::host::cmd;
use crate::host::deploy;
use crate::host::git_http::{after_receive, ensure_bare, list_refs};
use crate::models::App;
use crate::AppState;


/// One browser-edited file: validated path + text content.
pub struct WebFile {
    pub path: String,
    pub content: String,
}

/// Reject worktree escapes and git internals before a path touches git.
fn validate_web_path(path: &str) -> anyhow::Result<()> {
    if path.is_empty() || path.len() > 512 || path.starts_with('/') || path.contains('\\') {
        bail!("bad path {}", path);
    }
    for comp in path.split('/') {
        if comp.is_empty() || comp == "." || comp == ".." || comp == ".git" {
            bail!("bad path {}", path);
        }
    }
    Ok(())
}

/// Commit browser edits as `refs/heads/main` without a worktree: blobs via
/// hash-object, tree via a scratch index, commit-tree, then a CAS
/// update-ref so a concurrent push wins instead of interleaving. Reuses
/// after_receive + the deploy fast-path, so a web commit deploys exactly
/// like a `git push`. Returns the new main sha.
pub async fn web_commit(
    state: &AppState,
    app: &App,
    author: &str,
    message: &str,
    files: &[WebFile],
) -> anyhow::Result<String> {
    if files.is_empty() || files.len() > 32 {
        bail!("commit needs 1-32 files");
    }
    let message = message.trim();
    if message.is_empty() || message.len() > 500 {
        bail!("commit needs a message (1-500 chars)");
    }
    let author = author.trim();
    if author.is_empty() || author.len() > 254 || !author.contains('@') {
        bail!("commit needs an author email");
    }
    for f in files {
        validate_web_path(&f.path)?;
        if f.content.len() > 256 * 1024 {
            bail!("{} exceeds 256 KB", f.path);
        }
        if f.content.bytes().any(|b| b == 0) {
            bail!("{} looks binary", f.path);
        }
    }
    // Serialize with pushes: the CAS + manifest logic below assumes no
    // interleaving ref update, same as the receive path.
    let _push_guard = state.git_sync.push_guard(&app.slug).await;
    let bare = ensure_bare(&state.config, &app.slug).await?;
    let before = list_refs(&bare).await?;
    let Some(parent) = before.get("refs/heads/main").cloned() else {
        bail!("refs/heads/main does not exist — push once before web edits");
    };
    let git_dir = format!("--git-dir={}", bare.display());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let index = std::env::temp_dir().join(format!(
        "noite-web-{}-{}.idx",
        std::process::id(),
        nanos
    ));
    let index_str = index.to_string_lossy().to_string();
    let env_index = [("GIT_INDEX_FILE", index_str.as_str())];
    let result = async {
        cmd::run_cmd(
            "git",
            &[git_dir.as_str(), "read-tree", parent.as_str()],
            None,
            &env_index,
            Duration::from_secs(30),
        )
        .await?;
        for f in files {
            // Existing mode wins (executable bit survives); new files 644.
            // `:(literal)` keeps glob chars in names from acting as pathspec.
            let listing = cmd::run_cmd(
                "git",
                &[
                    git_dir.as_str(),
                    "ls-tree",
                    parent.as_str(),
                    "--",
                    &format!(":(literal){}", f.path),
                ],
                None,
                &[],
                Duration::from_secs(15),
            )
            .await
            .unwrap_or_default();
            let mode = listing.split_whitespace().next().unwrap_or("100644");
            let blob = cmd::run_cmd_stdin(
                "git",
                &[git_dir.as_str(), "hash-object", "-w", "--stdin"],
                f.content.as_bytes(),
                None,
                Duration::from_secs(60),
            )
            .await?;
            let sha = String::from_utf8(blob)?.trim().to_string();
            cmd::run_cmd(
                "git",
                &[
                    git_dir.as_str(),
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{},{},{}", mode, sha, f.path),
                ],
                None,
                &env_index,
                Duration::from_secs(30),
            )
            .await?;
        }
        let tree = cmd::run_cmd(
            "git",
            &[git_dir.as_str(), "write-tree"],
            None,
            &env_index,
            Duration::from_secs(30),
        )
        .await?;
        let commit = cmd::run_cmd(
            "git",
            &[git_dir.as_str(), "commit-tree", tree.trim(), "-p", parent.as_str(), "-m", message],
            None,
            &[
                ("GIT_AUTHOR_NAME", "Noite"),
                ("GIT_AUTHOR_EMAIL", author),
                ("GIT_COMMITTER_NAME", "Noite"),
                ("GIT_COMMITTER_EMAIL", author),
            ],
            Duration::from_secs(30),
        )
        .await?;
        let sha = commit.trim().to_string();
        // CAS: a push that landed after our rev-parse fails here instead
        // of interleaving — the UI retries on a fresh tip.
        cmd::run_cmd(
            "git",
            &[git_dir.as_str(), "update-ref", "refs/heads/main", sha.as_str(), parent.as_str()],
            None,
            &[],
            Duration::from_secs(15),
        )
        .await
        .with_context(|| "tip moved under this commit — reload and retry")?;
        // Same linearization + deploy fast-path as a stock push.
        let Some(tip) = after_receive(state, app, &bare, &before).await? else {
            return Ok(sha);
        };
        if !app.is_stopped() {
            let pool = state.pool.clone();
            let cfg = state.config.clone();
            let procs = state.procs.clone();
            let logs = state.logs.clone();
            let deploying = state.deploying.clone();
            let app = app.clone();
            tokio::spawn(async move {
                deploy::deploy_tip(&pool, &cfg, &procs, &logs, &deploying, app, tip).await;
            });
        }
        Ok::<_, anyhow::Error>(sha)
    }
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    result
}
