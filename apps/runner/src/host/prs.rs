//! PR head synchronization: the one place a branch move reaches the PR data.
//!
//! A push (or a server-side ref move) that changes `refs/heads/<branch>`
//! carries the open pull requests whose head is that branch along with it, and
//! dismisses every review recorded at an older sha. Deletions are deliberately
//! not followed: the PR stays open and reads as `head_missing`, so a recreated
//! branch picks it up again.
//!
//! Callers hold the per-slug push guard when they invoke this, so the hook
//! touches SQLite only — never git, and never the guard itself.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use crate::db::prs;
use crate::host::exec;
use crate::host::forge;
use crate::host::git_identity::Identity;
use crate::AppState;

/// Sync the open PRs whose head branch moved in one receive/publish:
/// `before`/`after` are the mirror's `refname -> sha` maps around the move.
pub async fn on_refs_moved(
    state: &AppState,
    app_id: &str,
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) -> anyhow::Result<()> {
    for (refname, sha) in after {
        if before.get(refname) == Some(sha) {
            continue;
        }
        let Some(branch) = refname.strip_prefix("refs/heads/") else {
            continue;
        };
        on_branch_moved(state, app_id, branch, sha).await?;
    }
    Ok(())
}

/// One branch moved to `sha`: follow it in every open PR and dismiss the
/// reviews that were recorded at a different commit.
pub async fn on_branch_moved(
    state: &AppState,
    app_id: &str,
    branch: &str,
    sha: &str,
) -> anyhow::Result<()> {
    let moved = prs::move_heads(&state.pool, app_id, branch, sha).await?;
    if moved == 0 {
        return Ok(());
    }
    for pr in prs::open_prs_for_head(&state.pool, app_id, branch).await? {
        prs::dismiss_reviews_before(&state.pool, &pr.id, sha).await?;
    }
    Ok(())
}

/// The squash commit for a merge: `commit-tree <tree> -p <parent>`, authored
/// as `author` and committed as `committer` (both noreply identities), in the
/// push mirror. Returns the new commit sha.
pub async fn squash_commit(
    bare: &Path,
    tree: &str,
    parent: &str,
    author: &Identity,
    committer: &Identity,
    message: &str,
) -> anyhow::Result<String> {
    let git_dir = format!("--git-dir={}", bare.display());
    let out = exec::run_cmd(
        "git",
        &[
            git_dir.as_str(),
            "commit-tree",
            tree,
            "-p",
            parent,
            "-m",
            message,
        ],
        None,
        &[
            ("GIT_AUTHOR_NAME", author.name.as_str()),
            ("GIT_AUTHOR_EMAIL", author.email.as_str()),
            ("GIT_COMMITTER_NAME", committer.name.as_str()),
            ("GIT_COMMITTER_EMAIL", committer.email.as_str()),
        ],
        Duration::from_secs(30),
    )
    .await?;
    Ok(out.trim().to_string())
}

/// One file's changed hunk ranges in a `-U0` diff, on each side, 1-based and
/// inclusive. An empty side means pure insertions (or deletions).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HunkRanges {
    pub old: Vec<(i64, i64)>,
    pub new: Vec<(i64, i64)>,
}

impl HunkRanges {
    /// Whether `line` sits inside one of the ranges.
    pub fn covers(ranges: &[(i64, i64)], line: i64) -> bool {
        ranges.iter().any(|(start, end)| line >= *start && line <= *end)
    }
}

/// The zero-context changed ranges of `from..to`, keyed by the file's new path
/// (the old path when the file is deleted). Used to decide whether a line
/// comment's anchor changed.
pub async fn changed_ranges(
    bare: &Path,
    from: &str,
    to: &str,
) -> anyhow::Result<HashMap<String, HunkRanges>> {
    let patch = forge::git_out(
        bare,
        &["diff", "-U0", "--no-color", "-M", "--no-prefix", from, to],
    )
    .await?;
    Ok(parse_hunks(&patch))
}

/// Parse a `-U0` patch into per-file ranges. `--no-prefix` keeps `diff --git`
/// paths literal, and the `+++`/`---` markers name the same path.
fn parse_hunks(patch: &str) -> HashMap<String, HunkRanges> {
    let mut files: HashMap<String, HunkRanges> = HashMap::new();
    let mut current: Option<(String, String)> = None;
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            current = Some((rest.to_string(), rest.to_string()));
            continue;
        }
        if let Some(rest) = line.strip_prefix("--- ") {
            if let Some((old, _)) = &mut current {
                *old = rest.to_string();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            if let Some((_, new)) = &mut current {
                *new = rest.to_string();
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("@@ ") else {
            continue;
        };
        // `@@ -a,b +c,d @@`; a missing `,b` means one line.
        let Some((old, rest)) = rest.split_once(' ') else {
            continue;
        };
        let Some((new, _)) = rest.split_once(' ') else {
            continue;
        };
        if old.is_empty() || new.is_empty() {
            continue;
        }
        let Some((old_path, new_path)) = current.as_ref() else {
            continue;
        };
        // A deleted file's `+++` is `/dev/null`; the comment's path is the old
        // one.
        let key = if new_path.is_empty() || new_path == "/dev/null" {
            old_path.clone()
        } else {
            new_path.clone()
        };
        let entry = files.entry(key).or_default();
        if let Some(range) = parse_range(&old[1..]) {
            entry.old.push(range);
        }
        if let Some(range) = parse_range(&new[1..]) {
            entry.new.push(range);
        }
    }
    files
}

/// `start,len` (a bare `start` is one line; `len = 0` is an empty side).
fn parse_range(spec: &str) -> Option<(i64, i64)> {
    let (start, len) = match spec.split_once(',') {
        Some((start, len)) => (start.parse().ok()?, len.parse().ok()?),
        None => (spec.parse().ok()?, 1),
    };
    (len > 0).then(|| (start, start + len - 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zero_context_hunks() {
        let patch = "diff --git a.txt a.txt\n\
                     --- a.txt\n+++ a.txt\n\
                     @@ -3 +3,2 @@\n-old\n+new\n+more\n\
                     @@ -10,0 +11 @@\n+x\n";
        let files = parse_hunks(patch);
        let ranges = files.get("a.txt").expect("file");
        assert_eq!(ranges.old, vec![(3, 3)]);
        assert_eq!(ranges.new, vec![(3, 4), (11, 11)]);
    }

    #[test]
    fn deleted_file_uses_its_old_path() {
        let patch = "diff --git gone.txt gone.txt\n\
                     --- gone.txt\n+++ /dev/null\n\
                     @@ -1,2 +0,0 @@\n-a\n-b\n";
        let files = parse_hunks(patch);
        let ranges = files.get("gone.txt").expect("old path");
        assert_eq!(ranges.old, vec![(1, 2)]);
        assert!(ranges.new.is_empty());
    }

    #[test]
    fn hunk_ranges_cover_bounds() {
        assert!(HunkRanges::covers(&[(3, 5)], 3));
        assert!(HunkRanges::covers(&[(3, 5)], 5));
        assert!(!HunkRanges::covers(&[(3, 5)], 6));
        assert!(!HunkRanges::covers(&[], 1));
    }
}
