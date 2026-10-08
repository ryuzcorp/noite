//! Small git forge: the primitives the runner uses to move refs itself
//! (browser commits, imports, merges) and the read RPCs behind the Source
//! page (branches, history, compare).
//!
//! Everything here works on the push mirror (`RUNNER_WORK_DIR/git-http/
//! {slug}.git`) — the mirror the smart-HTTP adapter writes, so it holds every
//! pushed branch, not only `main`. Before a read (or a server-side ref move)
//! the mirror is brought to exactly what `MANIFEST.json` says: refs the
//! manifest no longer carries are deleted locally, so a tip bundle an
//! interrupted delete left behind cannot resurrect a branch at the next cold
//! hydration.
//!
//! A server-side ref move goes through [`publish_ref`]: compare-and-swap in
//! the mirror, then the same `after_receive` a stock push runs (tip bundles,
//! one manifest write, deploy notification when `main` moved).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};
use serde::Serialize;
use ts_rs::TS;

use crate::config::Config;
use crate::host::exec;
use crate::host::git_http::{after_receive, ensure_bare, http_bare, list_refs};
use crate::host::git_manifest;
use crate::host::source::MAX_PATCH;
use crate::models::App;
use crate::AppState;

/// The only default branch Noite ever creates.
pub const DEFAULT_BRANCH: &str = "main";
/// `git.log` page ceiling, and its default.
const MAX_LOG_LIMIT: i64 = 100;
const DEFAULT_LOG_LIMIT: i64 = 50;
/// A compare lists at most this many commits (newest first, then reversed).
const MAX_COMPARE_COMMITS: usize = 250;
/// Field separator inside one `git log` record (`%x1f` in the format).
const US: char = '\u{1f}';

/// One commit's metadata, as the UI lists it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitCommitSummary {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
    pub committer_name: String,
    pub committed_at: i64,
    pub subject: String,
}

/// One branch tip, with its distance from `main`.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitBranch {
    pub name: String,
    pub sha: String,
    pub committed_at: i64,
    pub author_name: String,
    pub subject: String,
    pub ahead: i64,
    pub behind: i64,
}

/// Every branch plus what the Source page needs to pick a default: the
/// deployed sha when there is one.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitRefs {
    pub default_branch: String,
    pub deployed_sha: Option<String>,
    pub branches: Vec<GitBranch>,
}

/// One page of history. `nextSkip` is null on the last page.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitLog {
    pub commits: Vec<GitCommitSummary>,
    pub next_skip: Option<i64>,
}

/// How one file changed between two trees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum GitFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// One file in a diff. `additions`/`deletions` are null for a binary file.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitFileStat {
    pub path: String,
    pub old_path: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub status: GitFileStatus,
}

/// One commit: metadata, body, files and the patch against its first parent
/// (or the empty tree for a root commit).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitCommitDetail {
    pub commit: GitCommitSummary,
    pub body: String,
    pub files: Vec<GitFileStat>,
    pub patch: String,
    pub truncated: bool,
}

/// `base..head`: the commits only on `head`, the three-dot file list and
/// patch, and whether a squash merge would land cleanly.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitCompare {
    pub base: String,
    pub head: String,
    pub base_sha: String,
    pub head_sha: String,
    pub merge_base: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub commits: Vec<GitCommitSummary>,
    pub files: Vec<GitFileStat>,
    pub patch: String,
    pub truncated: bool,
    pub mergeable: bool,
    pub conflicts: Vec<String>,
}

/// Result of the merge check: the merged tree when clean, otherwise the
/// conflicted paths (never both).
#[derive(Debug, Clone)]
pub struct MergeTree {
    pub tree: Option<String>,
    pub conflicts: Vec<String>,
}

/// `git check-ref-format` rules for a branch the server will write: 1..=200
/// chars, no leading '-', no "..", no "@{", and never "HEAD".
pub fn valid_branch_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 200 || name == "HEAD" || name.starts_with('-') {
        return false;
    }
    if name.ends_with('/') || name.ends_with('.') || name == "@" {
        return false;
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return false;
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
    {
        return false;
    }
    // No empty component, nothing hidden, no ".lock" tail.
    !name
        .split('/')
        .any(|c| c.is_empty() || c.starts_with('.') || c.ends_with(".lock"))
}

/// `true` for 7..=40 hex digits: what the UI passes when it already holds a
/// sha.
fn is_hex_sha(reference: &str) -> bool {
    (7..=40).contains(&reference.len()) && reference.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A ref the forge will hand to git: a branch or tag name, or a full-ish sha.
fn valid_ref(reference: &str) -> bool {
    is_hex_sha(reference) || valid_branch_name(reference)
}

/// Materialize the push mirror and apply `MANIFEST.json` exactly, then return
/// it. Reads and server-side ref moves both start here, so neither ever sees
/// a branch the manifest dropped.
pub async fn read_mirror(state: &AppState, slug: &str) -> anyhow::Result<PathBuf> {
    let path = http_bare(&state.config, slug);
    let existed = path.join("HEAD").exists();
    let bare = ensure_bare(&state.config, slug).await?;
    if !existed {
        // A cold mirror is filled from the raw bundle listing, which can
        // still hold a bundle the delete did not prune. Make the manifest
        // win below rather than trust the cache's seq.
        state.git_sync.set_applied_seq(slug, 0).await;
    }
    apply_manifest(state, slug, &bare).await;
    Ok(bare)
}

/// [`read_mirror`] for callers that only hold a `Config` (deploy-side config
/// discovery): no per-process seq cache, so the manifest is read each time.
/// Unknown refs are still dropped, so a config read never sees a deleted
/// branch either.
pub async fn read_mirror_cfg(cfg: &Config, slug: &str) -> anyhow::Result<PathBuf> {
    let bare = ensure_bare(cfg, slug).await?;
    sync_manifest_cfg(cfg, slug, &bare).await;
    Ok(bare)
}

/// Bring a mirror to the manifest, warn-only. `ensure_bare` can call this
/// right after its cold hydration so the push mirror never keeps a ref the
/// manifest dropped (a tip bundle an interrupted delete left behind is
/// otherwise fetched again from the listing).
pub async fn sync_manifest_cfg(cfg: &Config, slug: &str, bare: &Path) {
    match git_manifest::read_manifest(cfg, slug).await {
        Ok(Some(manifest)) => {
            if let Err(e) = sync_to_manifest(cfg, bare, &manifest).await {
                tracing::warn!(slug, error = %format!("{e:#}"), "forge manifest apply");
            }
        }
        Ok(None) => {}
        Err(e) => tracing::warn!(slug, error = %format!("{e:#}"), "forge manifest read"),
    }
}

/// Rev to browse on the read mirror: an explicit `ref` (branch, tag or sha),
/// else the last deployed sha, else the mirror's HEAD. `None` means the
/// repository has no commit to show, which includes asking for the default
/// branch before its first commit; any other unknown explicit ref is an error.
pub async fn read_rev(
    bare: &Path,
    app: &App,
    reference: Option<&str>,
) -> anyhow::Result<Option<String>> {
    if let Some(reference) = reference {
        return match resolve_ref(bare, reference).await {
            Ok(sha) => Ok(Some(sha)),
            Err(_) if unborn_default(bare, reference).await? => Ok(None),
            Err(e) => Err(e),
        };
    }
    if let Some(sha) = app.last_deploy_sha.as_deref() {
        return Ok(Some(sha.to_string()));
    }
    match git_out(bare, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
        Ok(out) => Ok(Some(out.trim().to_string())),
        // Unborn HEAD: a fresh repository with nothing to browse.
        Err(_) => Ok(None),
    }
}

/// `reference` names the default branch and that branch has no commit yet:
/// a fresh repository, which readers show as empty rather than an unknown
/// ref. Only consulted after a failed resolve, so reads that succeed never
/// list the refs.
async fn unborn_default(bare: &Path, reference: &str) -> anyhow::Result<bool> {
    if reference != DEFAULT_BRANCH {
        return Ok(false);
    }
    let main = format!("refs/heads/{DEFAULT_BRANCH}");
    Ok(!list_refs(bare).await?.contains_key(&main))
}

/// Bring the mirror to the manifest. Warn-only, like `refresh_from_manifest`:
/// a reader serves from what is local when the manifest cannot be read; a
/// writer's `after_receive` still refuses to publish without it.
async fn apply_manifest(state: &AppState, slug: &str, bare: &Path) {
    let manifest = match git_manifest::read_manifest(&state.config, slug).await {
        Ok(Some(manifest)) => manifest,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(slug, error = %format!("{e:#}"), "forge manifest read");
            return;
        }
    };
    if state.git_sync.applied_seq(slug).await == Some(manifest.seq) {
        return;
    }
    if let Err(e) = sync_to_manifest(&state.config, bare, &manifest).await {
        tracing::warn!(slug, error = %format!("{e:#}"), "forge manifest apply");
        return;
    }
    state.git_sync.set_applied_seq(slug, manifest.seq).await;
}

/// Fetch refs that moved and delete local refs the manifest dropped. The
/// delete is what keeps a stale tip bundle from resurrecting a deleted
/// branch.
async fn sync_to_manifest(
    cfg: &Config,
    bare: &Path,
    manifest: &git_manifest::Manifest,
) -> anyhow::Result<()> {
    let local = list_refs(bare).await?;
    for (refname, entry) in &manifest.refs {
        if local.get(refname).map(String::as_str) == Some(entry.sha.as_str()) {
            continue;
        }
        git_manifest::fetch_manifest_ref(cfg, bare, &entry.bundle, &entry.sha, refname).await?;
    }
    for refname in local.keys() {
        if !manifest.refs.contains_key(refname) {
            git_out(bare, &["update-ref", "-d", refname]).await?;
        }
    }
    Ok(())
}

/// CAS-update `refs/heads/<branch>` in the push mirror and publish it exactly
/// like a push: `after_receive` (bundle + manifest + TipNotify when `main`
/// moved). `new = None` deletes the branch; `expected_old = None` asserts the
/// branch does not exist yet. A CAS mismatch is an error whose message
/// contains "tip moved", which callers map to Conflict.
pub async fn publish_ref(
    state: &AppState,
    app: &App,
    branch: &str,
    expected_old: Option<&str>,
    new: Option<&str>,
) -> anyhow::Result<()> {
    if !valid_branch_name(branch) {
        bail!("invalid branch name {branch:?}");
    }
    if new.is_none() && expected_old.is_none() {
        bail!("nothing to publish for {branch}");
    }
    // Serialize with pushes and other server-side ref moves.
    let _push_guard = state.git_sync.push_guard(&app.slug).await;
    let bare = read_mirror(state, &app.slug).await?;
    let refname = format!("refs/heads/{branch}");
    let before = list_refs(&bare).await?;
    cas_update(&bare, &refname, expected_old, new).await?;
    let Some(tip) = after_receive(state, app, &bare, &before).await? else {
        return Ok(());
    };
    if !app.is_stopped() {
        let _ = state.tip_tx.send(crate::host::tips::TipNotify {
            app_id: app.id.clone(),
            tip,
        });
    }
    Ok(())
}

/// Compare-and-swap one head ref. Distinguishes "the ref moved" from a real
/// git failure by re-reading the ref after a failed update.
async fn cas_update(
    bare: &Path,
    refname: &str,
    expected_old: Option<&str>,
    new: Option<&str>,
) -> anyhow::Result<()> {
    let git_dir = format!("--git-dir={}", bare.display());
    let args: Vec<&str> = match (expected_old, new) {
        // An empty old value is git's "the ref must not exist yet".
        (old, Some(new)) => vec![
            git_dir.as_str(),
            "update-ref",
            refname,
            new,
            old.unwrap_or(""),
        ],
        (Some(old), None) => vec![git_dir.as_str(), "update-ref", "-d", refname, old],
        (None, None) => bail!("nothing to publish"),
    };
    if let Err(e) = exec::run_cmd("git", &args, None, &[], Duration::from_secs(15)).await {
        let now = list_refs(bare)
            .await
            .unwrap_or_default()
            .get(refname)
            .cloned();
        if now.as_deref() != expected_old {
            bail!(
                "tip moved under this update: {refname} is {}",
                now.as_deref().unwrap_or("<absent>")
            );
        }
        return Err(e.context("update-ref"));
    }
    Ok(())
}

/// `git merge-tree --write-tree` of `ours` and `theirs` in the push mirror.
/// A clean merge yields the tree; a conflict yields the conflicted paths and
/// no tree.
pub async fn merge_tree(
    cfg: &Config,
    slug: &str,
    ours: &str,
    theirs: &str,
) -> anyhow::Result<MergeTree> {
    for reference in [ours, theirs] {
        if !valid_ref(reference) {
            bail!("invalid ref {reference:?}");
        }
    }
    let bare = ensure_bare(cfg, slug).await?;
    let (clean, out) = git_status(
        &bare,
        &["merge-tree", "--write-tree", "--name-only", ours, theirs],
    )
    .await?;
    let mut lines = out.split('\n');
    let tree = lines
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string);
    if clean {
        return Ok(MergeTree {
            tree,
            conflicts: Vec::new(),
        });
    }
    let conflicts: Vec<String> = lines
        .take_while(|line| !line.trim().is_empty())
        .map(|line| line.trim_end().to_string())
        .collect();
    if conflicts.is_empty() {
        bail!("merge-tree failed: {}", out.trim());
    }
    Ok(MergeTree {
        tree: None,
        conflicts,
    })
}

/// Every branch, `main` first then newest tip first.
pub async fn refs(bare: &Path, deployed_sha: Option<&str>) -> anyhow::Result<GitRefs> {
    let mut branches = branch_rows(bare).await?;
    let has_main = branches.iter().any(|b| b.name == DEFAULT_BRANCH);
    if has_main {
        for branch in &mut branches {
            if branch.name != DEFAULT_BRANCH {
                let (behind, ahead) = ahead_behind(bare, DEFAULT_BRANCH, &branch.name).await?;
                branch.ahead = ahead;
                branch.behind = behind;
            }
        }
    }
    branches.sort_by(|a, b| {
        let main_first = (a.name != DEFAULT_BRANCH).cmp(&(b.name != DEFAULT_BRANCH));
        main_first
            .then(b.committed_at.cmp(&a.committed_at))
            .then(a.name.cmp(&b.name))
    });
    Ok(GitRefs {
        default_branch: DEFAULT_BRANCH.to_string(),
        deployed_sha: deployed_sha.map(str::to_string),
        branches,
    })
}

async fn branch_rows(bare: &Path) -> anyhow::Result<Vec<GitBranch>> {
    // `for-each-ref` has no `%x1f` escape, so the separator is a literal
    // unit separator in the format string.
    let format = format!(
        "%(refname:short){US}%(objectname){US}%(committerdate:unix){US}%(authorname){US}%(subject)"
    );
    let out = git_out(
        bare,
        &["for-each-ref", &format!("--format={format}"), "refs/heads/"],
    )
    .await?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let fields: Vec<&str> = line.split(US).collect();
        if fields.len() < 5 {
            continue;
        }
        branches.push(GitBranch {
            name: fields[0].to_string(),
            sha: fields[1].to_string(),
            committed_at: fields[2].parse().unwrap_or(0),
            author_name: fields[3].to_string(),
            subject: fields[4].to_string(),
            ahead: 0,
            behind: 0,
        });
    }
    Ok(branches)
}

/// `(behind, ahead)` of `head` against `base`.
async fn ahead_behind(bare: &Path, base: &str, head: &str) -> anyhow::Result<(i64, i64)> {
    let out = git_out(
        bare,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...{head}"),
        ],
    )
    .await?;
    let mut counts = out.split_whitespace();
    let behind = counts.next().unwrap_or("0").parse().unwrap_or(0);
    let ahead = counts.next().unwrap_or("0").parse().unwrap_or(0);
    Ok((behind, ahead))
}

/// Resolve a branch, tag or 7..=40 hex sha to a commit sha. The string is
/// validated before git sees it; an unknown ref is an error containing
/// "not found".
pub async fn resolve_ref(bare: &Path, reference: &str) -> anyhow::Result<String> {
    if !valid_ref(reference) {
        bail!("invalid ref {reference:?}");
    }
    let spec = format!("{reference}^{{commit}}");
    let out = git_out(bare, &["rev-parse", "--verify", "--end-of-options", &spec])
        .await
        .with_context(|| format!("ref {reference:?} not found"))?;
    Ok(out.trim().to_string())
}

/// One page of history. `reference = None` means `main`; an empty repository
/// (including an explicit `main` before its first commit) is an empty page,
/// never an error.
pub async fn log(
    bare: &Path,
    reference: Option<&str>,
    path: Option<&str>,
    skip: i64,
    limit: Option<i64>,
) -> anyhow::Result<GitLog> {
    let skip = skip.max(0);
    let limit = limit.unwrap_or(DEFAULT_LOG_LIMIT).clamp(1, MAX_LOG_LIMIT);
    let empty = GitLog {
        commits: Vec::new(),
        next_skip: None,
    };
    let start = match reference {
        Some(reference) => match resolve_ref(bare, reference).await {
            Ok(sha) => sha,
            Err(_) if unborn_default(bare, reference).await? => return Ok(empty),
            Err(e) => return Err(e),
        },
        None => {
            let main = format!("refs/heads/{DEFAULT_BRANCH}");
            match list_refs(bare).await?.get(&main) {
                Some(sha) => sha.clone(),
                None => return Ok(empty),
            }
        }
    };
    // One extra commit tells us whether another page exists.
    let probe = limit + 1;
    let mut args: Vec<String> = vec![
        "log".into(),
        "-z".into(),
        format!("--format={}", log_format()),
        format!("--skip={skip}"),
        format!("--max-count={probe}"),
        start,
    ];
    if let Some(path) = path {
        // The revision comes before `--`: anything after it is a pathspec.
        args.push("--".into());
        args.push(path.to_string());
    }
    let out = git_out(bare, &borrowed(&args)).await?;
    let mut commits: Vec<GitCommitSummary> = Vec::new();
    for record in out.split('\0').filter(|record| !record.is_empty()) {
        if let Some(commit) = parse_commit(record) {
            commits.push(commit);
        }
    }
    let next_skip = (commits.len() as i64 > limit).then(|| skip + limit);
    commits.truncate(limit as usize);
    Ok(GitLog { commits, next_skip })
}

/// One commit with its files and patch, against its first parent (or the
/// empty tree for a root commit).
pub async fn commit_detail(bare: &Path, reference: &str) -> anyhow::Result<GitCommitDetail> {
    let sha = resolve_ref(bare, reference).await?;
    let summary = git_out(
        bare,
        &["show", "-s", &format!("--format={}", log_format()), &sha],
    )
    .await?;
    let commit = parse_commit(summary.trim_end_matches('\n'))
        .with_context(|| format!("unreadable commit {sha}"))?;
    let body = git_out(bare, &["show", "-s", "--format=%B", &sha]).await?;
    let body = commit_body(&body);
    let target = match commit.parents.first() {
        Some(parent) => DiffTarget::Pair(parent.clone(), sha.clone()),
        None => DiffTarget::Root(sha.clone()),
    };
    let files = diff_files(bare, &target).await?;
    let (patch, truncated) = cap_patch(diff_patch(bare, &target).await?);
    Ok(GitCommitDetail {
        commit,
        body,
        files,
        patch,
        truncated,
    })
}

/// `base..head`: commits only on `head` (oldest first), the three-dot diff,
/// and the merge check.
pub async fn compare(
    cfg: &Config,
    slug: &str,
    bare: &Path,
    base: &str,
    head: &str,
) -> anyhow::Result<GitCompare> {
    let base_sha = resolve_ref(bare, base).await?;
    let head_sha = resolve_ref(bare, head).await?;
    let merge_base = merge_base(bare, &base_sha, &head_sha).await?;
    let (behind, ahead) = ahead_behind(bare, &base_sha, &head_sha).await?;
    let range = match &merge_base {
        // `base..head` and `mergeBase..head` select the same commits;
        // naming the merge base keeps the intent explicit.
        Some(merge_base) => format!("{merge_base}..{head_sha}"),
        None => format!("{base_sha}..{head_sha}"),
    };
    let commits = log_range(bare, &range).await?;
    let target = DiffTarget::Range(format!("{base_sha}...{head_sha}"));
    let files = diff_files(bare, &target).await?;
    let (patch, truncated) = cap_patch(diff_patch(bare, &target).await?);
    let merged = merge_tree(cfg, slug, &base_sha, &head_sha).await?;
    Ok(GitCompare {
        base: base.to_string(),
        head: head.to_string(),
        base_sha,
        head_sha,
        merge_base,
        ahead,
        behind,
        commits,
        files,
        patch,
        truncated,
        // A clean merge is one merge-tree produced a tree for; the conflicted
        // paths (when there are any) are what a blocked merge reports.
        mergeable: merged.tree.is_some() && merged.conflicts.is_empty(),
        conflicts: merged.conflicts,
    })
}

/// Newest `MAX_COMPARE_COMMITS` commits of a range, oldest first.
async fn log_range(bare: &Path, range: &str) -> anyhow::Result<Vec<GitCommitSummary>> {
    let out = git_out(
        bare,
        &[
            "log",
            "-z",
            &format!("--format={}", log_format()),
            &format!("--max-count={MAX_COMPARE_COMMITS}"),
            range,
        ],
    )
    .await?;
    let mut commits: Vec<GitCommitSummary> = out
        .split('\0')
        .filter(|record| !record.is_empty())
        .filter_map(parse_commit)
        .collect();
    commits.reverse();
    Ok(commits)
}

async fn merge_base(bare: &Path, base: &str, head: &str) -> anyhow::Result<Option<String>> {
    match git_out(bare, &["merge-base", base, head]).await {
        Ok(out) => {
            let sha = out.trim();
            Ok((!sha.is_empty()).then(|| sha.to_string()))
        }
        // Exit 1 = no common ancestor, which the caller renders as null.
        Err(_) => Ok(None),
    }
}

fn log_format() -> String {
    format!("%H{US}%P{US}%an{US}%ae{US}%at{US}%cn{US}%ct{US}%s")
}

fn parse_commit(record: &str) -> Option<GitCommitSummary> {
    let fields: Vec<&str> = record.splitn(8, US).collect();
    if fields.len() < 8 {
        return None;
    }
    Some(GitCommitSummary {
        sha: fields[0].to_string(),
        parents: fields[1].split_whitespace().map(str::to_string).collect(),
        author_name: fields[2].to_string(),
        author_email: fields[3].to_string(),
        authored_at: fields[4].parse().unwrap_or(0),
        committer_name: fields[5].to_string(),
        committed_at: fields[6].parse().unwrap_or(0),
        subject: fields[7].to_string(),
    })
}

/// `%B` minus the subject line: what the commit page shows under the title.
fn commit_body(message: &str) -> String {
    match message.split_once('\n') {
        Some((_, body)) => body.trim_start_matches('\n').trim_end().to_string(),
        None => String::new(),
    }
}

/// What two trees to diff: a parent/commit pair, one range (three-dot for
/// compare), or a root commit against the empty tree.
enum DiffTarget {
    Pair(String, String),
    Range(String),
    Root(String),
}

impl DiffTarget {
    /// `git diff-tree`/`git diff` invocation for a mode flag. diff-tree keeps
    /// the root case and the explicit first-parent pair working in a bare
    /// mirror; `diff` is only used for ranges.
    fn command(&self, mode: &[&str]) -> Vec<String> {
        let mut args = match self {
            Self::Pair(a, b) => vec![
                "diff-tree".into(),
                "-r".into(),
                "-M".into(),
                a.clone(),
                b.clone(),
            ],
            Self::Root(commit) => vec![
                "diff-tree".into(),
                "-r".into(),
                "-M".into(),
                "--root".into(),
                commit.clone(),
            ],
            Self::Range(range) => vec!["diff".into(), "-M".into(), range.clone()],
        };
        // Options go before the revisions/pathspecs they modify.
        let insert_at = if matches!(self, Self::Range(_)) { 1 } else { 3 };
        for flag in mode.iter().rev() {
            args.insert(insert_at, (*flag).to_string());
        }
        args
    }
}

async fn diff_files(bare: &Path, target: &DiffTarget) -> anyhow::Result<Vec<GitFileStat>> {
    let numstat = git_out(bare, &borrowed(&target.command(&["--numstat", "-z"]))).await?;
    let name_status = git_out(bare, &borrowed(&target.command(&["--name-status", "-z"]))).await?;
    let counts = parse_numstat(&numstat);
    Ok(parse_name_status(&name_status)
        .into_iter()
        .map(|(status, path, old_path)| {
            let (additions, deletions) = counts.get(&path).copied().unwrap_or((None, None));
            GitFileStat {
                path,
                old_path,
                additions,
                deletions,
                status,
            }
        })
        .collect())
}

async fn diff_patch(bare: &Path, target: &DiffTarget) -> anyhow::Result<String> {
    git_out(bare, &borrowed(&target.command(&["-p"]))).await
}

/// `adds<TAB>dels<TAB>path` per entry; a rename carries an empty path then two
/// NUL-separated names, so a path with tabs still parses.
fn parse_numstat(out: &str) -> HashMap<String, (Option<i64>, Option<i64>)> {
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut counts = HashMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        i += 1;
        if token.is_empty() {
            continue;
        }
        let parts: Vec<&str> = token.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let adds = parts[0].parse().ok();
        let dels = parts[1].parse().ok();
        let path = if parts[2].is_empty() {
            // Rename: old name then new name.
            let new_path = tokens.get(i + 1).copied().unwrap_or_default();
            i += 2;
            new_path
        } else {
            parts[2]
        };
        if !path.is_empty() {
            counts.insert(path.to_string(), (adds, dels));
        }
    }
    counts
}

/// `(status, path, oldPath)` per entry, in git's own (path) order.
fn parse_name_status(out: &str) -> Vec<(GitFileStatus, String, Option<String>)> {
    let tokens: Vec<&str> = out.split('\0').collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let code = tokens[i];
        i += 1;
        if code.is_empty() {
            continue;
        }
        let letter = code.as_bytes()[0];
        let renamed = letter == b'R' || letter == b'C';
        let status = match letter {
            b'A' | b'C' => GitFileStatus::Added,
            b'D' => GitFileStatus::Deleted,
            b'R' => GitFileStatus::Renamed,
            _ => GitFileStatus::Modified,
        };
        if renamed {
            let old_path = tokens.get(i).copied().unwrap_or_default().to_string();
            let path = tokens.get(i + 1).copied().unwrap_or_default().to_string();
            i += 2;
            entries.push((status, path, Some(old_path)));
        } else {
            let path = tokens.get(i).copied().unwrap_or_default().to_string();
            i += 1;
            entries.push((status, path, None));
        }
    }
    entries
}

/// Cap a patch at `MAX_PATCH` bytes without splitting a UTF-8 codepoint.
fn cap_patch(patch: String) -> (String, bool) {
    if patch.len() <= MAX_PATCH {
        return (patch, false);
    }
    let mut end = MAX_PATCH;
    while end > 0 && !patch.is_char_boundary(end) {
        end -= 1;
    }
    (patch[..end].to_string(), true)
}

/// Borrow a built argument vector as `&[&str]`.
fn borrowed(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

/// Run git against a bare mirror; a non-zero exit is an error whose message
/// carries stderr and stdout.
pub(crate) async fn git_out(bare: &Path, args: &[&str]) -> anyhow::Result<String> {
    let git_dir = format!("--git-dir={}", bare.display());
    let mut full = Vec::with_capacity(args.len() + 1);
    full.push(git_dir.as_str());
    full.extend_from_slice(args);
    exec::run_cmd("git", &full, None, &[], Duration::from_secs(30))
        .await
        .with_context(|| format!("git in {}", bare.display()))
}

/// Run git and return `(success, stdout)` without failing on a non-zero exit:
/// `merge-tree` reports conflicts through the exit code and still prints the
/// merged tree.
async fn git_status(bare: &Path, args: &[&str]) -> anyhow::Result<(bool, String)> {
    use tokio::process::Command;
    let mut cmd = Command::new("git");
    cmd.arg(format!("--git-dir={}", bare.display()))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let out = cmd.output().await.context("spawn git")?;
    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    //! Integration tests against real bare repositories: every case seeds a
    //! mirror in the work dir and drives the same functions the RPCs call.
    //! S3 is an in-process stub (objects in memory, LIST, batch delete), so
    //! `publish_ref` runs its whole bundle+manifest path.
    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::Bytes;
    use axum::extract::{Path as AxiPath, Query, State as AxiState};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use serde_json::json;
    use tokio::sync::Mutex;
    use tower::ServiceExt;

    use super::*;
    use crate::host::exec;

    /// In-memory S3: `{bucket}/{key}` -> bytes, plus the two LIST/delete
    /// request shapes the forge uses.
    type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    async fn put_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
        body: Bytes,
    ) -> StatusCode {
        store
            .lock()
            .await
            .insert(format!("{bucket}/{key}"), body.to_vec());
        StatusCode::OK
    }

    async fn get_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
    ) -> Response {
        let full = format!("{bucket}/{key}");
        match store.lock().await.get(&full) {
            Some(bytes) => (StatusCode::OK, bytes.clone()).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
            )
                .into_response(),
        }
    }

    async fn delete_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
    ) -> StatusCode {
        store.lock().await.remove(&format!("{bucket}/{key}"));
        StatusCode::NO_CONTENT
    }

    async fn list_objects(
        AxiState(store): AxiState<Store>,
        AxiPath(bucket): AxiPath<String>,
        Query(q): Query<HashMap<String, String>>,
    ) -> Response {
        let prefix = q.get("prefix").cloned().unwrap_or_default();
        let store = store.lock().await;
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
             <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        xml.push_str(&format!(
            "<Name>{bucket}</Name><Prefix>{prefix}</Prefix>\
             <KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
            store.len()
        ));
        for (full, bytes) in store.iter() {
            let Some(key) = full.strip_prefix(&format!("{bucket}/")) else {
                continue;
            };
            if !key.starts_with(&prefix) {
                continue;
            }
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key>\
                 <LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                 <ETag>\"e\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                bytes.len()
            ));
        }
        xml.push_str("</ListBucketResult>");
        (StatusCode::OK, xml).into_response()
    }

    async fn delete_objects(
        AxiState(store): AxiState<Store>,
        AxiPath(bucket): AxiPath<String>,
        body: Bytes,
    ) -> Response {
        let text = String::from_utf8_lossy(&body);
        let mut store = store.lock().await;
        for key in text
            .split("<Key>")
            .skip(1)
            .filter_map(|rest| rest.split("</Key>").next())
        {
            store.remove(&format!("{bucket}/{key}"));
        }
        (
            StatusCode::OK,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult></DeleteResult>",
        )
            .into_response()
    }

    async fn spawn_s3_stub() -> String {
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        // rusty-s3 signs bucket-level requests both with and without a
        // trailing slash, depending on the action.
        let bucket_routes = || get(list_objects).post(delete_objects);
        let app = axum::Router::new()
            .route("/{bucket}", bucket_routes())
            .route("/{bucket}/", bucket_routes())
            .route(
                "/{bucket}/{*key}",
                get(get_object).put(put_object).delete(delete_object),
            )
            .with_state(store);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind s3 stub");
        let addr = listener.local_addr().expect("stub addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    const GIT_ENV: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.com"),
    ];

    async fn git(dir: &Path, args: &[&str]) -> String {
        exec::run_cmd("git", args, Some(dir), GIT_ENV, Duration::from_secs(30))
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {}: {e:#}", dir.display()))
    }

    fn test_app(slug: &str) -> App {
        App {
            id: format!("app_{slug}"),
            slug: slug.to_string(),
            name: slug.to_string(),
            user_id: "user_test".to_string(),
            status: "running".to_string(),
            subdomain: format!("{slug}.localhost"),
            git_prefix: format!("git/{slug}/"),
            fleet_bucket: format!("fleet-{slug}"),
            listen_port: None,
            internal_port: None,
            last_deploy_sha: None,
            last_error: None,
            desired_state: "running".to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
            asleep_since: None,
            woke_at: None,
            deployed_config: None,
            import_source: None,
            imported: false,
        }
    }

    struct Harness {
        state: AppState,
        app: App,
        dir: PathBuf,
        _tip_rx: crate::host::tips::TipReceiver,
    }

    impl Harness {
        async fn new(slug: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("noite-forge-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let s3 = spawn_s3_stub().await;
            let mut cfg = crate::config::config_for_tests();
            cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
            cfg.s3_endpoint = s3.clone();
            cfg.s3_public_endpoint = s3;
            cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
            let config = Arc::new(cfg);
            let pool = crate::db::connect(&config.database_url)
                .await
                .expect("connect db");
            let (tip_tx, tip_rx) = crate::host::tips::channel();
            let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
            let state = AppState {
                pool,
                config,
                procs: crate::host::supervisor::new_procs(),
                logs: crate::host::logs::new_state(),
                deploying: crate::host::deploy::new_deploying(),
                log_notify,
                git_sync: crate::host::git_manifest::GitSync::default(),
                tip_tx,
                ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                isolation: Arc::new(tokio::sync::RwLock::new(
                    crate::host::isolation::IsolationStatus::default(),
                )),
                state_sync: crate::host::state::StateSync::new(),
                bucket_ok: Arc::new(tokio::sync::RwLock::new((
                    true,
                    String::new(),
                    std::time::Instant::now(),
                ))),
                started_at: chrono::Utc::now(),
            };
            let app = test_app(slug);
            Self {
                state,
                app,
                dir,
                _tip_rx: tip_rx,
            }
        }

        /// A bare push mirror at the canonical path, HEAD on `main`.
        async fn mirror(&self) -> PathBuf {
            let bare = http_bare(&self.state.config, &self.app.slug);
            let root = exec::work_root(&self.state.config);
            std::fs::create_dir_all(&root).expect("work root");
            std::fs::create_dir_all(bare.parent().expect("parent")).expect("mirror parent");
            git(
                &root,
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    bare.to_str().expect("mirror path"),
                ],
            )
            .await;
            bare
        }

        async fn finish(self) {
            self.state.pool.close().await;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A scratch worktree that pushes into the mirror, so tests control
    /// parents, branches and conflicts the way a user would.
    struct Work {
        dir: PathBuf,
    }

    impl Work {
        async fn new(dir: &Path) -> Self {
            std::fs::create_dir_all(dir).expect("work dir");
            git(dir, &["init", "-q", "--initial-branch=main", "."]).await;
            Self {
                dir: dir.to_path_buf(),
            }
        }

        fn write(&self, path: &str, content: &str) {
            let full = self.dir.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("file parent");
            }
            std::fs::write(full, content).expect("write");
        }

        async fn commit(&self, message: &str) -> String {
            git(&self.dir, &["add", "-A"]).await;
            git(&self.dir, &["commit", "-qm", message]).await;
            git(&self.dir, &["rev-parse", "HEAD"])
                .await
                .trim()
                .to_string()
        }

        async fn branch(&self, name: &str, start: &str) {
            git(&self.dir, &["checkout", "-q", "-B", name, start]).await;
        }
    }

    /// Copy every branch of `work` into the mirror's object store without
    /// moving a head ref (what an import leaves behind before `publish_ref`),
    /// and return each branch tip.
    async fn seed_objects(bare: &Path, work: &Work) -> HashMap<String, String> {
        let source = work.dir.to_str().expect("work path");
        git(bare, &["fetch", "-q", source, "+refs/heads/*:refs/seed/*"]).await;
        let mut tips = HashMap::new();
        let out = git(bare, &["for-each-ref", "--format=%(refname)", "refs/seed/"]).await;
        for refname in out.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let sha = git(bare, &["rev-parse", refname]).await.trim().to_string();
            if let Some(name) = refname.strip_prefix("refs/seed/") {
                tips.insert(name.to_string(), sha);
            }
        }
        for refname in tips.keys() {
            let seed_ref = format!("refs/seed/{refname}");
            git(bare, &["update-ref", "-d", &seed_ref]).await;
        }
        tips
    }

    #[test]
    fn branch_names_follow_check_ref_format() {
        for bad in [
            "-x", "a..b", "a@{0}", "HEAD", "@", ".hidden", "a.lock", "a//b", "/a", "a/", "a.",
            "a b", "a~1", "a^", "a:b", "a?b", "a*b", "a[b", "a\\b", "", "x/",
        ] {
            assert!(!valid_branch_name(bad), "{bad:?} must be rejected");
        }
        assert!(!valid_branch_name(&"x".repeat(201)));
        for good in [
            "main",
            "feature/x",
            "release-1.0",
            "v1.2.3",
            "a_b-c.d",
            "Ünicode",
        ] {
            assert!(valid_branch_name(good), "{good:?} must be accepted");
        }
        // `ref` params also accept a short or full sha, and nothing else odd.
        assert!(valid_ref(&"a".repeat(40)));
        assert!(valid_ref("abcdef1"));
        assert!(!valid_ref("a..b"));
        assert!(!valid_ref("-x"));
    }

    #[tokio::test]
    async fn resolve_ref_rejects_before_git_runs() {
        let h = Harness::new("resolve").await;
        let bare = h.mirror().await;
        for bad in ["-x", "a..b", "a@{0}", "HEAD"] {
            let err = resolve_ref(&bare, bad).await.expect_err("rejected");
            assert!(
                format!("{err:#}").contains("invalid ref"),
                "{bad:?} -> {err:#}"
            );
        }
        let err = resolve_ref(&bare, "nope").await.expect_err("unknown");
        assert!(format!("{err:#}").contains("not found"));
        h.finish().await;
    }

    #[tokio::test]
    async fn log_pages_through_history() {
        let h = Harness::new("logpaging").await;
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        let mut expected = Vec::new();
        for i in 1..=5 {
            work.write("a.txt", &format!("{i}\n"));
            expected.push(work.commit(&format!("commit {i}")).await);
        }
        work.write("b.txt", "only once\n");
        expected.push(work.commit("add b").await);
        let tips = seed_objects(&bare, &work).await;
        assert_eq!(tips.get("main"), expected.last());
        let tip = expected.last().expect("tip");
        publish_ref(&h.state, &h.app, "main", None, Some(tip))
            .await
            .expect("publish");

        // Newest first, one extra commit probes for the next page.
        let page1 = log(&bare, None, None, 0, Some(2)).await.expect("page 1");
        assert_eq!(page1.commits.len(), 2);
        assert_eq!(page1.commits[0].sha, expected[5]);
        assert_eq!(page1.commits[0].subject, "add b");
        assert_eq!(page1.next_skip, Some(2));

        let page2 = log(&bare, None, None, 2, Some(2)).await.expect("page 2");
        assert_eq!(page2.commits.len(), 2);
        assert_eq!(page2.next_skip, Some(4));

        let page3 = log(&bare, None, None, 4, Some(2)).await.expect("page 3");
        assert_eq!(page3.commits.len(), 2);
        assert_eq!(page3.next_skip, None, "last page");

        // A path filter narrows the same history.
        let filtered = log(&bare, None, Some("b.txt"), 0, None)
            .await
            .expect("path");
        assert_eq!(filtered.commits.len(), 1);
        assert_eq!(filtered.commits[0].subject, "add b");

        // An empty repository is an empty page, not an error.
        let empty = Harness::new("logempty").await;
        let empty_mirror = empty.mirror().await;
        let empty_log = log(&empty_mirror, None, None, 0, None)
            .await
            .expect("empty log");
        assert!(empty_log.commits.is_empty());
        assert_eq!(empty_log.next_skip, None);
        let empty_refs = refs(&empty_mirror, None).await.expect("empty refs");
        assert!(empty_refs.branches.is_empty());
        assert_eq!(empty_refs.deployed_sha, None);
        // Code mode names `main` explicitly: before its first commit that is
        // the same empty repository, while any other unknown ref still fails.
        let main_log = log(&empty_mirror, Some(DEFAULT_BRANCH), None, 0, None)
            .await
            .expect("empty main log");
        assert!(main_log.commits.is_empty());
        let main_rev = read_rev(&empty_mirror, &empty.app, Some(DEFAULT_BRANCH))
            .await
            .expect("empty main rev");
        assert_eq!(main_rev, None);
        let err = read_rev(&empty_mirror, &empty.app, Some("feature"))
            .await
            .expect_err("unknown branch");
        assert!(format!("{err:#}").contains("not found"));
        assert!(log(&empty_mirror, Some("feature"), None, 0, None)
            .await
            .is_err());

        h.finish().await;
        empty.finish().await;
    }

    #[tokio::test]
    async fn compare_reports_distance_and_conflicts() {
        let h = Harness::new("compare").await;
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("f.txt", "base\n");
        let base = work.commit("base").await;

        work.branch("feature", &base).await;
        work.write("f.txt", "feature\n");
        let feature = work.commit("feature change").await;

        work.branch("main", &base).await;
        work.write("f.txt", "main\n");
        let main = work.commit("main change").await;

        work.branch("clean", &main).await;
        work.write("g.txt", "clean\n");
        work.commit("clean change").await;

        let tips = seed_objects(&bare, &work).await;
        assert_eq!(tips.get("main").map(String::as_str), Some(main.as_str()));
        assert_eq!(
            tips.get("feature").map(String::as_str),
            Some(feature.as_str())
        );
        for (branch, sha) in &tips {
            publish_ref(&h.state, &h.app, branch, None, Some(sha.as_str()))
                .await
                .expect("publish");
        }

        let conflicting = compare(&h.state.config, &h.app.slug, &bare, "main", "feature")
            .await
            .expect("compare");
        assert_eq!(conflicting.base_sha, main);
        assert_eq!(conflicting.head_sha, feature);
        assert_eq!(conflicting.merge_base.as_deref(), Some(base.as_str()));
        assert_eq!(conflicting.ahead, 1);
        assert_eq!(conflicting.behind, 1);
        assert_eq!(conflicting.commits.len(), 1);
        assert_eq!(conflicting.commits[0].sha, feature);
        assert!(!conflicting.mergeable);
        assert_eq!(conflicting.conflicts, vec!["f.txt".to_string()]);
        assert!(conflicting.patch.contains("+feature"));

        let clean = compare(&h.state.config, &h.app.slug, &bare, "main", "clean")
            .await
            .expect("clean compare");
        assert_eq!(clean.ahead, 1);
        assert_eq!(clean.behind, 0);
        assert!(clean.mergeable);
        assert!(clean.conflicts.is_empty());
        assert_eq!(clean.files.len(), 1);
        assert_eq!(clean.files[0].path, "g.txt");
        assert_eq!(clean.files[0].status, GitFileStatus::Added);
        assert_eq!(clean.files[0].additions, Some(1));

        // `refs` carries the distance from main.
        let refs_out = refs(&bare, Some(&main)).await.expect("refs");
        assert_eq!(refs_out.default_branch, "main");
        assert_eq!(refs_out.deployed_sha.as_deref(), Some(main.as_str()));
        assert_eq!(refs_out.branches[0].name, "main");
        assert_eq!(refs_out.branches[0].ahead, 0);
        assert_eq!(refs_out.branches[0].behind, 0);
        let feature_row = refs_out
            .branches
            .iter()
            .find(|b| b.name == "feature")
            .expect("feature row");
        assert_eq!(feature_row.ahead, 1);
        assert_eq!(feature_row.behind, 1);
        assert_eq!(feature_row.author_name, "Test");

        // A commit detail ranges over the first parent.
        let detail = commit_detail(&bare, &main).await.expect("detail");
        assert_eq!(detail.commit.sha, main);
        assert_eq!(detail.commit.parents, vec![base.clone()]);
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "f.txt");
        assert_eq!(detail.files[0].status, GitFileStatus::Modified);
        assert_eq!(detail.files[0].additions, Some(1));
        assert_eq!(detail.files[0].deletions, Some(1));
        assert!(detail.patch.contains("+main"));

        h.finish().await;
    }

    #[tokio::test]
    async fn publish_ref_compare_and_swap() {
        let h = Harness::new("cas").await;
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("a.txt", "one\n");
        let first = work.commit("one").await;
        let tips = seed_objects(&bare, &work).await;
        assert_eq!(tips.get("main"), Some(&first));

        publish_ref(&h.state, &h.app, "main", None, Some(&first))
            .await
            .expect("create main");
        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(refs_now.get("refs/heads/main"), Some(&first));
        let manifest = git_manifest::read_manifest(&h.state.config, &h.app.slug)
            .await
            .expect("manifest")
            .expect("manifest written");
        assert!(manifest.refs.contains_key("refs/heads/main"));
        assert_eq!(manifest.refs["refs/heads/main"].sha, first);

        // Creating a ref that exists is a conflict.
        let err = publish_ref(&h.state, &h.app, "main", None, Some(&first))
            .await
            .expect_err("exists");
        assert!(format!("{err:#}").contains("tip moved"), "{err:#}");

        // A stale expectation is a conflict.
        let wrong = "1".repeat(40);
        let err = publish_ref(&h.state, &h.app, "main", Some(&wrong), Some(&first))
            .await
            .expect_err("stale");
        assert!(format!("{err:#}").contains("tip moved"), "{err:#}");

        // The right expectation deletes, and the manifest drops the ref.
        publish_ref(&h.state, &h.app, "main", Some(&first), None)
            .await
            .expect("delete main");
        assert!(!list_refs(&bare)
            .await
            .expect("list")
            .contains_key("refs/heads/main"));
        let manifest = git_manifest::read_manifest(&h.state.config, &h.app.slug)
            .await
            .expect("manifest")
            .expect("manifest");
        assert!(manifest.refs.is_empty(), "{:?}", manifest.refs);

        h.finish().await;
    }

    #[tokio::test]
    async fn a_deleted_branch_is_not_resurrected_by_rehydration() {
        let h = Harness::new("rehydrate").await;
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("f.txt", "base\n");
        let base = work.commit("base").await;
        work.branch("feature", &base).await;
        work.write("g.txt", "feature\n");
        let feature = work.commit("feature").await;
        work.branch("main", &base).await;
        let tips = seed_objects(&bare, &work).await;
        let main = tips.get("main").expect("main tip").clone();
        assert_eq!(tips.get("feature"), Some(&feature));
        publish_ref(&h.state, &h.app, "main", None, Some(&main))
            .await
            .expect("publish main");
        publish_ref(&h.state, &h.app, "feature", None, Some(&feature))
            .await
            .expect("publish feature");

        let manifest = git_manifest::read_manifest(&h.state.config, &h.app.slug)
            .await
            .expect("manifest")
            .expect("manifest");
        let feature_bundle = manifest.refs["refs/heads/feature"].bundle.clone();

        // Stash the tip bundle first: the delete prunes it, and a delete that
        // was interrupted between the manifest flip and the prune is exactly
        // the case this test covers.
        let bucket = h.state.config.s3_bucket.clone();
        // Outside `git/{slug}/refs/…`, so the delete's prefix sweep cannot
        // take the stash with it.
        let stale = format!("git/{}/.stash/{feature}.bundle", h.app.slug);
        crate::host::s3::s3_copy_key(&h.state.config, &bucket, &feature_bundle, &stale)
            .await
            .expect("stash stale bundle");

        publish_ref(&h.state, &h.app, "feature", Some(&feature), None)
            .await
            .expect("delete feature");
        let manifest = git_manifest::read_manifest(&h.state.config, &h.app.slug)
            .await
            .expect("manifest")
            .expect("manifest");
        assert!(!manifest.refs.contains_key("refs/heads/feature"));

        // Put the stale bundle back where a listing would find it.
        crate::host::s3::s3_copy_key(&h.state.config, &bucket, &stale, &feature_bundle)
            .await
            .expect("restore stale bundle");
        crate::host::s3::s3_delete_key(&h.state.config, &stale)
            .await
            .expect("drop stash");

        // A fresh work dir: hydrate from the listing (which still offers the
        // stale feature bundle), then apply the manifest.
        std::fs::remove_dir_all(&bare).expect("wipe mirror");
        let resurrected = list_refs(&bare).await.expect("no mirror");
        assert!(resurrected.is_empty(), "{resurrected:?}");
        let bare = read_mirror(&h.state, &h.app.slug).await.expect("rehydrate");
        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(refs_now.get("refs/heads/main"), Some(&main));
        assert!(
            !refs_now.contains_key("refs/heads/feature"),
            "deleted branch came back: {refs_now:?}"
        );

        h.finish().await;
    }

    #[tokio::test]
    async fn web_commit_makes_a_root_commit_then_a_new_branch() {
        let h = Harness::new("webcommit").await;
        let actor = crate::host::git_identity::noreply(&h.state.config, "user_1", "Ada");
        // No mirror at all: the first browser commit creates one.
        let files = vec![crate::host::web_commit::WebFile {
            path: "README.md".to_string(),
            content: "# hello\n".to_string(),
        }];
        let first = crate::host::web_commit::web_commit(
            &h.state, &h.app, &actor, "first", &files, None, None,
        )
        .await
        .expect("root commit");

        let bare = http_bare(&h.state.config, &h.app.slug);
        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(refs_now.get("refs/heads/main"), Some(&first));
        let detail = commit_detail(&bare, &first).await.expect("detail");
        assert!(
            detail.commit.parents.is_empty(),
            "root commit has no parent"
        );
        assert_eq!(detail.commit.author_name, "Ada");
        assert_eq!(detail.commit.author_email, "user_1@users.noreply.localhost");

        // `require_pr`-style UI flow: commit to a new branch off main.
        let files = vec![crate::host::web_commit::WebFile {
            path: "feature.txt".to_string(),
            content: "wip\n".to_string(),
        }];
        let second = crate::host::web_commit::web_commit(
            &h.state,
            &h.app,
            &actor,
            "on a branch",
            &files,
            Some("feature/x"),
            Some(&first),
        )
        .await
        .expect("branch commit");

        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(
            refs_now.get("refs/heads/main"),
            Some(&first),
            "main untouched"
        );
        assert_eq!(refs_now.get("refs/heads/feature/x"), Some(&second));
        let detail = commit_detail(&bare, &second).await.expect("detail");
        assert_eq!(detail.commit.parents, vec![first.clone()]);
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].status, GitFileStatus::Added);

        // The manifest carries both, so a hydrate sees both.
        let manifest = git_manifest::read_manifest(&h.state.config, &h.app.slug)
            .await
            .expect("manifest")
            .expect("manifest");
        assert!(manifest.refs.contains_key("refs/heads/main"));
        assert!(manifest.refs.contains_key("refs/heads/feature/x"));

        // A commit to an existing branch appends (and a stale `fromSha` does
        // not fight the CAS).
        let files = vec![crate::host::web_commit::WebFile {
            path: "feature.txt".to_string(),
            content: "more\n".to_string(),
        }];
        let third = crate::host::web_commit::web_commit(
            &h.state,
            &h.app,
            &actor,
            "more",
            &files,
            Some("feature/x"),
            None,
        )
        .await
        .expect("append");
        let detail = commit_detail(&bare, &third).await.expect("detail");
        assert_eq!(detail.commit.parents, vec![second.clone()]);

        h.finish().await;
    }

    #[tokio::test]
    async fn web_commit_rejects_bad_input() {
        let h = Harness::new("webbad").await;
        let actor = crate::host::git_identity::noreply(&h.state.config, "user_1", "Ada");
        let files = vec![crate::host::web_commit::WebFile {
            path: "../escape".to_string(),
            content: "x".to_string(),
        }];
        let err = crate::host::web_commit::web_commit(
            &h.state, &h.app, &actor, "bad", &files, None, None,
        )
        .await
        .expect_err("traversal");
        assert!(format!("{err:#}").contains("bad path"), "{err:#}");

        let files = vec![crate::host::web_commit::WebFile {
            path: "ok.txt".to_string(),
            content: "x".to_string(),
        }];
        let err = crate::host::web_commit::web_commit(
            &h.state,
            &h.app,
            &actor,
            "bad branch",
            &files,
            Some("a..b"),
            None,
        )
        .await
        .expect_err("bad branch");
        assert!(format!("{err:#}").contains("invalid branch"), "{err:#}");
        h.finish().await;
    }

    /// One JSON-RPC round trip against the real dispatcher (bearer-gated like
    /// the UI's calls).
    async fn rpc_json(
        router: &axum::Router,
        method: &str,
        params: serde_json::Value,
    ) -> serde_json::Value {
        let body = json!({ "id": 1, "jsonrpc": "2.0", "method": method, "params": params });
        let request = axum::http::Request::builder()
            .method("POST")
            .uri("/rpc")
            .header("authorization", "Bearer test-token")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .expect("build rpc request");
        let response = router.clone().oneshot(request).await.expect("rpc dispatch");
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{method}");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("rpc body");
        serde_json::from_slice(&bytes).expect("rpc json")
    }

    /// A successful call's `result`.
    async fn rpc(
        router: &axum::Router,
        method: &str,
        params: serde_json::Value,
    ) -> serde_json::Value {
        let envelope = rpc_json(router, method, params).await;
        assert!(
            envelope.get("error").is_none(),
            "{method} failed: {envelope}"
        );
        envelope
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    }

    /// A failed call's `(code, message)`.
    async fn rpc_error(
        router: &axum::Router,
        method: &str,
        params: serde_json::Value,
    ) -> (i64, String) {
        let envelope = rpc_json(router, method, params).await;
        let error = envelope
            .get("error")
            .unwrap_or_else(|| panic!("{method} unexpectedly succeeded: {envelope}"));
        (
            error["code"].as_i64().unwrap_or_default(),
            error["message"].as_str().unwrap_or_default().to_string(),
        )
    }

    /// One REST call, mirroring what the UI's REST fallback would do.
    async fn rest(router: &axum::Router, path: &str) -> serde_json::Value {
        let request = axum::http::Request::builder()
            .method("GET")
            .uri(path)
            .header("authorization", "Bearer test-token")
            .body(axum::body::Body::empty())
            .expect("build rest request");
        let response = router.clone().oneshot(request).await.expect("rest call");
        assert_eq!(response.status(), axum::http::StatusCode::OK, "{path}");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("rest body");
        serde_json::from_slice(&bytes).expect("rest json")
    }

    /// Every contract RPC runs through the real dispatcher against a real
    /// bare repo, and the REST mirror answers the same shapes.
    #[tokio::test]
    async fn rpc_and_rest_serve_the_forge() {
        let h = Harness::new("rpcs").await;
        let app = crate::db::create_app(
            &h.state.pool,
            &h.state.config,
            crate::db::NewApp {
                name: "rpcs",
                slug: "rpcs",
                user_id: "user_test",
                subdomain: "rpcs.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app");
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("f.txt", "base\n");
        let base = work.commit("base").await;
        work.branch("feature", &base).await;
        work.write("f.txt", "feature\n");
        let feature = work.commit("feature change").await;
        work.branch("main", &base).await;
        work.write("f.txt", "main\n");
        let main = work.commit("main change").await;
        let tips = seed_objects(&bare, &work).await;
        for (branch, sha) in &tips {
            publish_ref(&h.state, &app, branch, None, Some(sha.as_str()))
                .await
                .expect("publish");
        }

        let router = crate::api::router::router(h.state.clone());
        let id = json!(app.id);

        let refs_out = rpc(&router, "git.refs", json!({ "id": id })).await;
        assert_eq!(refs_out["defaultBranch"], "main");
        assert_eq!(refs_out["branches"][0]["name"], "main");
        let feature_row = refs_out["branches"]
            .as_array()
            .expect("branches")
            .iter()
            .find(|row| row["name"] == "feature")
            .expect("feature row");
        assert_eq!(feature_row["ahead"], 1);
        assert_eq!(feature_row["behind"], 1);

        let log_out = rpc(
            &router,
            "git.log",
            json!({ "id": id, "ref": "feature", "limit": 1 }),
        )
        .await;
        assert_eq!(log_out["commits"][0]["sha"], json!(feature));
        assert_eq!(log_out["nextSkip"], 1, "feature has two commits");
        let log_page2 = rpc(
            &router,
            "git.log",
            json!({ "id": id, "ref": "feature", "limit": 1, "skip": 1 }),
        )
        .await;
        assert_eq!(log_page2["commits"][0]["sha"], json!(base));
        assert_eq!(log_page2["nextSkip"], serde_json::Value::Null);

        let filtered = rpc(
            &router,
            "git.log",
            json!({ "id": id, "path": "f.txt", "skip": 0 }),
        )
        .await;
        assert_eq!(filtered["commits"].as_array().map(Vec::len), Some(2));

        let commit_out = rpc(&router, "git.commit", json!({ "id": id, "sha": feature })).await;
        assert_eq!(commit_out["commit"]["sha"], json!(feature));
        assert_eq!(commit_out["files"][0]["status"], "modified");

        let compared = rpc(
            &router,
            "git.compare",
            json!({ "id": id, "base": "main", "head": "feature" }),
        )
        .await;
        assert_eq!(compared["mergeable"], false);
        assert_eq!(compared["conflicts"], json!(["f.txt"]));
        assert_eq!(compared["ahead"], 1);

        let created = rpc(
            &router,
            "git.branch_create",
            json!({ "id": id, "name": "topic", "from": "main" }),
        )
        .await;
        assert_eq!(created["name"], "topic");
        assert_eq!(created["sha"], json!(main));
        // Creating it again is a conflict (the compare-and-swap refuses it).
        let (code, _) = rpc_error(
            &router,
            "git.branch_create",
            json!({ "id": id, "name": "topic", "from": "main" }),
        )
        .await;
        assert_eq!(code, 409);

        // `ref` on the source reads: the topic branch is tree-identical to main.
        let tree_out = rpc(&router, "source.tree", json!({ "id": id, "ref": "topic" })).await;
        assert_eq!(tree_out["sha"], json!(main));
        assert_eq!(
            tree_out["files"].as_array().map(Vec::len),
            Some(1),
            "topic tree"
        );
        let blob_out = rpc(
            &router,
            "source.blob",
            json!({ "id": id, "path": "f.txt", "ref": "feature" }),
        )
        .await;
        assert_eq!(blob_out["text"], "feature\n");

        // Unknown refs, malformed refs and protected branches map onto the
        // right JSON-RPC statuses.
        let (code, message) =
            rpc_error(&router, "source.tree", json!({ "id": id, "ref": "nope" })).await;
        assert_eq!(code, 404, "{message}");
        assert!(message.contains("not found"), "{message}");
        let (code, message) =
            rpc_error(&router, "git.log", json!({ "id": id, "ref": "a..b" })).await;
        assert_eq!(code, 400, "{message}");
        assert!(message.contains("invalid ref"), "{message}");
        let (code, message) = rpc_error(
            &router,
            "git.branch_delete",
            json!({ "id": id, "name": "main" }),
        )
        .await;
        assert_eq!(code, 400, "{message}");
        assert!(message.contains("default branch"), "{message}");
        let (code, _) = rpc_error(
            &router,
            "git.branch_delete",
            json!({ "id": id, "name": "ghost" }),
        )
        .await;
        assert_eq!(code, 404);

        let deleted = rpc(
            &router,
            "git.branch_delete",
            json!({ "id": id, "name": "topic" }),
        )
        .await;
        assert_eq!(deleted["ok"], true);
        assert!(!list_refs(&bare)
            .await
            .expect("list")
            .contains_key("refs/heads/topic"));

        // REST mirrors answer the same shapes.
        let rest_refs = rest(&router, &format!("/v1/apps/{}/git/refs", app.id)).await;
        assert_eq!(rest_refs["defaultBranch"], "main");
        assert_eq!(rest_refs["branches"][0]["name"], "main");
        let rest_log = rest(
            &router,
            &format!("/v1/apps/{}/git/log?ref=feature&limit=5", app.id),
        )
        .await;
        assert_eq!(rest_log["commits"][0]["sha"], json!(feature));
        let rest_tree = rest(&router, &format!("/v1/apps/{}/tree?ref=main", app.id)).await;
        assert_eq!(rest_tree["sha"], json!(main));

        // `source.commit` through the dispatcher: a branch commit and then a
        // commit to main, both attributed to the session actor.
        let committed = rpc(
            &router,
            "source.commit",
            json!({
                "id": id,
                "actor": { "userId": "user_test", "name": "Test User" },
                "message": "from the api",
                "branch": "from-rpc",
                "fromSha": main,
                "files": [{ "path": "new.txt", "content": "hi\n" }],
            }),
        )
        .await;
        let branch_sha = committed["sha"].as_str().expect("sha").to_string();
        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(refs_now.get("refs/heads/from-rpc"), Some(&branch_sha));
        assert_eq!(
            refs_now.get("refs/heads/main"),
            Some(&main),
            "main untouched"
        );
        let detail = commit_detail(&bare, &branch_sha).await.expect("detail");
        assert_eq!(detail.commit.parents, vec![main.clone()]);
        assert_eq!(
            detail.commit.author_email,
            "user_test@users.noreply.localhost"
        );

        let on_main = rpc(
            &router,
            "source.commit",
            json!({
                "id": id,
                "actor": { "userId": "user_test", "name": "Test User" },
                "message": "onto main",
                "files": [{ "path": "new.txt", "content": "there\n" }],
            }),
        )
        .await;
        let main_sha = on_main["sha"].as_str().expect("sha").to_string();
        let refs_now = list_refs(&bare).await.expect("list");
        assert_eq!(refs_now.get("refs/heads/main"), Some(&main_sha));
        assert_ne!(main_sha, main);

        h.finish().await;
    }

    #[test]
    fn merge_tree_args_are_added_before_revisions() {
        assert_eq!(
            DiffTarget::Pair("a".into(), "b".into()).command(&["--numstat", "-z"]),
            vec!["diff-tree", "-r", "-M", "--numstat", "-z", "a", "b"]
        );
        assert_eq!(
            DiffTarget::Root("c".into()).command(&["-p"]),
            vec!["diff-tree", "-r", "-M", "-p", "--root", "c"]
        );
        assert_eq!(
            DiffTarget::Range("a...b".into()).command(&["--name-status", "-z"]),
            vec!["diff", "--name-status", "-z", "-M", "a...b"]
        );
    }
}
