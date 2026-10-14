//! Browser web-commit API: commit edited files without a worktree.
//!
//! The commit is built in the push mirror (blobs via `hash-object`, tree via
//! a scratch index, `commit-tree`), then handed to [`forge::publish_ref`],
//! which does the compare-and-swap and publishes exactly like a `git push`
//! (tip bundle, manifest, deploy notification when `main` moved). A root
//! commit is allowed when the target branch does not exist yet, so a browser
//! commit works on a fresh empty repository.
use std::collections::HashSet;
use std::time::Duration;

use anyhow::bail;
use base64::Engine;

use crate::host::exec;
use crate::host::forge::{self, DEFAULT_BRANCH};
use crate::host::git_http::list_refs;
use crate::host::git_identity::Identity;
use crate::models::App;
use crate::AppState;

/// Most files one browser commit may write, so a folder of uploads fits.
const MAX_COMMIT_WRITES: usize = 100;
/// Largest utf8 (text) file, as today.
const MAX_TEXT_BYTES: usize = 256 * 1024;
/// Largest base64 (uploaded) file, decoded.
const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
/// Largest decoded total across one commit's writes.
const MAX_COMMIT_BYTES: usize = 25 * 1024 * 1024;
/// Request-body cap for the commit routes. Base64 inflates the 25 MiB decoded
/// total by 4/3 (~33.3 MiB), plus room for paths, moves and JSON keys. The
/// runner's axum `DefaultBodyLimit` and the control worker's oxide `bodyLimit`
/// both use it, so a max-size commit is never refused by a hop below it.
pub const MAX_COMMIT_BODY_BYTES: usize = 40 * 1024 * 1024;

/// How a commit file's `content` is carried: `utf8` (or absent) is text,
/// `base64` is raw uploaded bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum WebEncoding {
    Utf8,
    Base64,
}

impl WebEncoding {
    /// Decode `content` as this encoding; `path` names the file in the error.
    pub fn decode(self, path: &str, content: &str) -> anyhow::Result<WebContent> {
        match self {
            Self::Utf8 => Ok(WebContent::Text(content.to_string())),
            Self::Base64 => base64::engine::general_purpose::STANDARD
                .decode(content)
                .map(WebContent::Bytes)
                .map_err(|_| anyhow::anyhow!("{path} is not valid base64")),
        }
    }
}

/// One browser-edited file's decoded content.
pub enum WebContent {
    /// A `utf8` text file.
    Text(String),
    /// A `base64` upload: raw bytes, any content including NUL.
    Bytes(Vec<u8>),
}

/// One browser-edited file: validated path + decoded content.
pub struct WebFile {
    pub path: String,
    pub content: WebContent,
}

/// One browser file move: the blob at `from` is re-pointed at `to`, so a move
/// never reads the content (untouched, binary and oversized files all move).
pub struct WebMove {
    pub from: String,
    pub to: String,
}

/// A browser commit's changes: `files` are written (added or modified),
/// `moves` are re-pointed within the tree, and `deletes` are removed.
pub struct WebChanges<'a> {
    pub files: &'a [WebFile],
    pub moves: &'a [WebMove],
    pub deletes: &'a [String],
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

/// Where a browser commit lands.
enum WebTarget<'a> {
    /// A branch (`None` = the default branch).
    Branch(Option<&'a str>),
    /// A workspace preview's hidden ref, committed on top of `branch`'s head.
    Preview { git_ref: &'a str, branch: &'a str },
}

/// Commit browser edits as a branch commit without a worktree: the changes'
/// files are written (added or modified) and its deletes removed. `branch`
/// defaults to `main`; a branch that does not exist yet is created, from
/// `fromSha` when given, else from `main`, else as a root commit. Returns the
/// new commit sha.
pub async fn web_commit(
    state: &AppState,
    app: &App,
    actor: &Identity,
    message: &str,
    changes: WebChanges<'_>,
    branch: Option<&str>,
    from_sha: Option<&str>,
) -> anyhow::Result<String> {
    commit_into(
        state,
        app,
        actor,
        message,
        changes,
        WebTarget::Branch(branch),
        from_sha,
    )
    .await
}

/// Commit uncommitted Code mode changes to a workspace preview's hidden ref
/// (`refs/previews/<userId>/<branch>`), on top of `branch`'s head. The branch
/// itself is never moved and no PR sees the commit: hidden refs are not
/// advertised, not listed as branches and not used as PR heads.
pub async fn web_commit_preview(
    state: &AppState,
    app: &App,
    actor: &Identity,
    message: &str,
    changes: WebChanges<'_>,
    git_ref: &str,
    branch: &str,
) -> anyhow::Result<String> {
    commit_into(
        state,
        app,
        actor,
        message,
        changes,
        WebTarget::Preview { git_ref, branch },
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // the public surface shares one implementation
async fn commit_into(
    state: &AppState,
    app: &App,
    actor: &Identity,
    message: &str,
    changes: WebChanges<'_>,
    target: WebTarget<'_>,
    from_sha: Option<&str>,
) -> anyhow::Result<String> {
    let WebChanges {
        files,
        moves,
        deletes,
    } = changes;
    if files.is_empty() && moves.is_empty() && deletes.is_empty() {
        bail!("commit needs at least one write, move or delete");
    }
    if files.len() > MAX_COMMIT_WRITES {
        bail!("commit exceeds {MAX_COMMIT_WRITES} writes");
    }
    if moves.len() > 1000 {
        bail!("commit exceeds 1000 moves");
    }
    if deletes.len() > 1000 {
        bail!("commit exceeds 1000 deletes");
    }
    let message = message.trim();
    if message.is_empty() || message.len() > 500 {
        bail!("commit needs a message (1-500 chars)");
    }
    if actor.email.is_empty() || actor.email.len() > 254 || !actor.email.contains('@') {
        bail!("commit needs an actor email");
    }
    let mut decoded = 0usize;
    for f in files {
        validate_web_path(&f.path)?;
        match &f.content {
            WebContent::Text(text) => {
                if text.len() > MAX_TEXT_BYTES {
                    bail!("{} exceeds 256 KB", f.path);
                }
                if text.as_bytes().contains(&0) {
                    bail!("{} looks binary", f.path);
                }
                decoded += text.len();
            }
            WebContent::Bytes(bytes) => {
                if bytes.len() > MAX_UPLOAD_BYTES {
                    bail!("{} exceeds 10 MB", f.path);
                }
                decoded += bytes.len();
            }
        }
    }
    if decoded > MAX_COMMIT_BYTES {
        bail!("commit exceeds 25 MB of files");
    }
    for path in deletes {
        validate_web_path(path)?;
        if files.iter().any(|f| f.path == *path) {
            bail!("{} is both written and deleted", path);
        }
    }
    validate_moves(moves, files, deletes)?;
    let bare = forge::read_mirror(state, &app.slug).await?;
    let refs = list_refs(&bare).await?;
    // The ref this commit moves, and the parent it grows from: a branch grows
    // from its own tip (fromSha/main/root on creation); a workspace preview
    // grows from its branch's head, so each snapshot is "the branch plus my
    // uncommitted changes" rather than a chain of snapshots.
    let (refname, parent) = match target {
        WebTarget::Branch(branch) => {
            let branch = branch.unwrap_or(DEFAULT_BRANCH);
            if !forge::valid_branch_name(branch) {
                bail!("invalid branch {branch:?}");
            }
            let refname = format!("refs/heads/{branch}");
            let existing = refs.get(&refname).cloned();
            let parent = match &existing {
                Some(sha) => Some(sha.clone()),
                None => match from_sha {
                    Some(from) => Some(forge::resolve_ref(&bare, from).await?),
                    None => refs.get(&format!("refs/heads/{DEFAULT_BRANCH}")).cloned(),
                },
            };
            (refname, parent)
        }
        WebTarget::Preview { git_ref, branch } => {
            if !forge::publishable_ref(git_ref) {
                bail!("invalid ref {git_ref:?}");
            }
            if !forge::valid_branch_name(branch) {
                bail!("invalid branch {branch:?}");
            }
            let branch_ref = format!("refs/heads/{branch}");
            let parent = refs
                .get(&branch_ref)
                .cloned()
                .or_else(|| refs.get(git_ref).cloned());
            (git_ref.to_string(), parent)
        }
    };
    let sha = build_commit(
        &bare,
        parent.as_deref(),
        actor,
        message,
        files,
        moves,
        deletes,
    )
    .await?;
    forge::publish_refname(
        state,
        app,
        &refname,
        refs.get(&refname).map(String::as_str),
        Some(&sha),
    )
    .await?;
    Ok(sha)
}

/// Reject bad file moves before anything touches git: same path, duplicate
/// ends, and a `from` that is also written or deleted. The parent-tree checks
/// (a `from` must be a blob, a `to` must be free) happen in [`build_commit`].
fn validate_moves(moves: &[WebMove], files: &[WebFile], deletes: &[String]) -> anyhow::Result<()> {
    let mut froms = HashSet::new();
    let mut tos = HashSet::new();
    for m in moves {
        validate_web_path(&m.from)?;
        validate_web_path(&m.to)?;
        if m.from == m.to {
            bail!("invalid move: {} targets itself", m.from);
        }
        if !froms.insert(m.from.as_str()) {
            bail!("invalid move: {} is moved twice", m.from);
        }
        if !tos.insert(m.to.as_str()) {
            bail!("invalid move: {} is a target twice", m.to);
        }
        if deletes.contains(&m.from) {
            bail!("invalid move: {} is also deleted", m.from);
        }
        if files.iter().any(|f| f.path == m.from) {
            bail!("invalid move: {} is also written", m.from);
        }
    }
    Ok(())
}

/// `<mode> <kind> <sha>` of the entry at `path` in `tree`.
struct TreeEntry {
    mode: String,
    kind: String,
    sha: String,
}

/// The entry at `path` in `tree`, or `None` when the tree has none.
async fn tree_entry(git_dir: &str, tree: &str, path: &str) -> anyhow::Result<Option<TreeEntry>> {
    let listing = exec::run_cmd(
        "git",
        &[
            git_dir,
            "ls-tree",
            tree,
            "--",
            &format!(":(literal){}", path),
        ],
        None,
        &[],
        Duration::from_secs(15),
    )
    .await?;
    let mut fields = listing.split_whitespace();
    let Some(mode) = fields.next() else {
        return Ok(None);
    };
    Ok(Some(TreeEntry {
        mode: mode.to_string(),
        kind: fields.next().unwrap_or_default().to_string(),
        sha: fields.next().unwrap_or_default().to_string(),
    }))
}

/// [`tree_entry`] when `path` is a blob there, else an error naming the path.
async fn require_blob(git_dir: &str, tree: &str, path: &str) -> anyhow::Result<TreeEntry> {
    match tree_entry(git_dir, tree, path).await? {
        Some(entry) if entry.kind == "blob" => Ok(entry),
        _ => bail!("{path} not found"),
    }
}

/// Tree + commit objects for the edited changes, in a scratch index so the
/// repository's own index (there is none) is never touched. Order: moves
/// (re-point blobs read from the parent tree), then writes, then deletes.
async fn build_commit(
    bare: &std::path::Path,
    parent: Option<&str>,
    actor: &Identity,
    message: &str,
    files: &[WebFile],
    moves: &[WebMove],
    deletes: &[String],
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
        // Moves first: read every `from` blob from the parent tree (immutable),
        // then remove all `from`s and add all `to`s in one index update, so a
        // swap or a chain of moves lands on the right blobs.
        let mut removals = String::new();
        let mut additions = String::new();
        for m in moves {
            let Some(parent) = parent else {
                bail!("{} not found", m.from);
            };
            let entry = require_blob(git_dir.as_str(), parent, &m.from).await?;
            // A `to` may only overwrite a path this commit already vacates:
            // another move's `from`, or a delete.
            let vacated = deletes.contains(&m.to) || moves.iter().any(|o| o.from == m.to);
            if !vacated && tree_entry(git_dir.as_str(), parent, &m.to).await?.is_some() {
                bail!("{} already exists", m.to);
            }
            removals.push_str(&format!("0 {}\t{}\0", "0".repeat(40), m.from));
            additions.push_str(&format!("{} {}\t{}\0", entry.mode, entry.sha, m.to));
        }
        if !moves.is_empty() {
            let info = format!("{removals}{additions}");
            exec::run_cmd_stdin(
                "git",
                &[git_dir.as_str(), "update-index", "-z", "--index-info"],
                info.as_bytes(),
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
            // Raw bytes, no filters: an upload's content is committed verbatim.
            let bytes: &[u8] = match &f.content {
                WebContent::Text(text) => text.as_bytes(),
                WebContent::Bytes(bytes) => bytes,
            };
            let blob = exec::run_cmd_stdin(
                "git",
                &[
                    git_dir.as_str(),
                    "hash-object",
                    "-w",
                    "--stdin",
                    "--no-filters",
                ],
                bytes,
                None,
                &[],
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
        // Deletes last, so a moved-then-edited file is not removed after it
        // was written.
        for path in deletes {
            // Only a file in the parent's tree can be deleted; a folder is
            // deleted by naming every file under it, and a root commit has no
            // files to delete.
            let Some(parent) = parent else {
                bail!("{path} not found");
            };
            require_blob(git_dir.as_str(), parent, path).await?;
            // `--index-info` (mode 0) removes by name without stat'ing a work
            // tree: the mirror is bare, so `update-index <path>` is refused.
            let removal = format!("0 {}\t{path}\0", "0".repeat(40));
            exec::run_cmd_stdin(
                "git",
                &[git_dir.as_str(), "update-index", "-z", "--index-info"],
                removal.as_bytes(),
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
