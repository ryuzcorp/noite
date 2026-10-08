//! Browser web-commit API: commit edited files without a worktree.
//!
//! The commit is built in the push mirror (blobs via `hash-object`, tree via
//! a scratch index, `commit-tree`), then handed to [`forge::publish_ref`],
//! which does the compare-and-swap and publishes exactly like a `git push`
//! (tip bundle, manifest, deploy notification when `main` moved). A root
//! commit is allowed when the target branch does not exist yet, so a browser
//! commit works on a fresh empty repository.
use std::time::Duration;

use anyhow::bail;

use crate::host::exec;
use crate::host::forge::{self, DEFAULT_BRANCH};
use crate::host::git_http::list_refs;
use crate::host::git_identity::Identity;
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

/// Commit browser edits as a branch commit without a worktree. `branch`
/// defaults to `main`; a branch that does not exist yet is created, from
/// `fromSha` when given, else from `main`, else as a root commit. Returns the
/// new commit sha.
pub async fn web_commit(
    state: &AppState,
    app: &App,
    actor: &Identity,
    message: &str,
    files: &[WebFile],
    branch: Option<&str>,
    from_sha: Option<&str>,
) -> anyhow::Result<String> {
    if files.is_empty() || files.len() > 32 {
        bail!("commit needs 1-32 files");
    }
    let message = message.trim();
    if message.is_empty() || message.len() > 500 {
        bail!("commit needs a message (1-500 chars)");
    }
    if actor.email.is_empty() || actor.email.len() > 254 || !actor.email.contains('@') {
        bail!("commit needs an actor email");
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
    let branch = branch.unwrap_or(DEFAULT_BRANCH);
    if !forge::valid_branch_name(branch) {
        bail!("invalid branch {branch:?}");
    }
    let bare = forge::read_mirror(state, &app.slug).await?;
    let refs = list_refs(&bare).await?;
    let refname = format!("refs/heads/{branch}");
    let existing = refs.get(&refname).cloned();
    // A new branch starts at `fromSha`, else at `main`, else at the root.
    // An existing branch always grows from its own tip (the CAS below still
    // rejects a push that moves it first).
    let parent = match &existing {
        Some(sha) => Some(sha.clone()),
        None => match from_sha {
            Some(from) => Some(forge::resolve_ref(&bare, from).await?),
            None => refs.get(&format!("refs/heads/{DEFAULT_BRANCH}")).cloned(),
        },
    };
    let sha = build_commit(&bare, parent.as_deref(), actor, message, files).await?;
    forge::publish_ref(state, app, branch, existing.as_deref(), Some(&sha)).await?;
    Ok(sha)
}

/// Tree + commit objects for the edited files, in a scratch index so the
/// repository's own index (there is none) is never touched.
async fn build_commit(
    bare: &std::path::Path,
    parent: Option<&str>,
    actor: &Identity,
    message: &str,
    files: &[WebFile],
) -> anyhow::Result<String> {
    let git_dir = format!("--git-dir={}", bare.display());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let index =
        std::env::temp_dir().join(format!("noite-web-{}-{}.idx", std::process::id(), nanos));
    let index_str = index.to_string_lossy().to_string();
    let env_index = [("GIT_INDEX_FILE", index_str.as_str())];
    let result = async {
        // A root commit starts from an empty index (the scratch file does not
        // exist yet); any other commit starts from its parent's tree.
        if let Some(parent) = parent {
            exec::run_cmd(
                "git",
                &[git_dir.as_str(), "read-tree", parent],
                None,
                &env_index,
                Duration::from_secs(30),
            )
            .await?;
        }
        for f in files {
            // Existing mode wins (executable bit survives); new files 644.
            // `:(literal)` keeps glob chars in names from acting as pathspec.
            let mode = match parent {
                Some(parent) => {
                    let listing = exec::run_cmd(
                        "git",
                        &[
                            git_dir.as_str(),
                            "ls-tree",
                            parent,
                            "--",
                            &format!(":(literal){}", f.path),
                        ],
                        None,
                        &[],
                        Duration::from_secs(15),
                    )
                    .await
                    .unwrap_or_default();
                    listing
                        .split_whitespace()
                        .next()
                        .unwrap_or("100644")
                        .to_string()
                }
                None => "100644".to_string(),
            };
            let blob = exec::run_cmd_stdin(
                "git",
                &[git_dir.as_str(), "hash-object", "-w", "--stdin"],
                f.content.as_bytes(),
                None,
                Duration::from_secs(60),
            )
            .await?;
            let sha = String::from_utf8(blob)?.trim().to_string();
            exec::run_cmd(
                "git",
                &[
                    git_dir.as_str(),
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{mode},{sha},{}", f.path),
                ],
                None,
                &env_index,
                Duration::from_secs(30),
            )
            .await?;
        }
        let tree = exec::run_cmd(
            "git",
            &[git_dir.as_str(), "write-tree"],
            None,
            &env_index,
            Duration::from_secs(30),
        )
        .await?;
        let mut args = vec![git_dir.as_str(), "commit-tree", tree.trim()];
        if let Some(parent) = parent {
            args.push("-p");
            args.push(parent);
        }
        args.push("-m");
        args.push(message);
        let commit = exec::run_cmd(
            "git",
            &args,
            None,
            &[
                ("GIT_AUTHOR_NAME", &actor.name),
                ("GIT_AUTHOR_EMAIL", &actor.email),
                ("GIT_COMMITTER_NAME", &actor.name),
                ("GIT_COMMITTER_EMAIL", &actor.email),
            ],
            Duration::from_secs(30),
        )
        .await?;
        Ok::<_, anyhow::Error>(commit.trim().to_string())
    }
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    result
}
