// Source preview: serve a commit's tree / blobs from the push mirror
// (RUNNER_WORK_DIR/git-http/{slug}.git), the same mirror the smart-HTTP
// adapter writes and the one that holds every pushed branch. The mirror is
// materialized and manifest-synced by the service layer before these run
// (`forge::read_mirror`); a server-side ref move materializes it the same way.
use std::path::PathBuf;
use std::time::Duration;

use anyhow::bail;
use serde::Serialize;
use ts_rs::TS;

use crate::config::Config;
use crate::host::{exec, forge, rehydrate};

pub const MAX_BLOB: usize = 256 * 1024;
pub const MAX_PATCH: usize = 1024 * 1024;

/// The tree listing's file cap: one page of a repository's blobs (the editor's
/// tree), not a checkout size. `truncated` marks a capped listing.
pub const MAX_TREE_FILES: usize = 5_000;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
    /// Git blob id (40 hex): the Workspace hashes its checkout against it.
    pub sha: String,
    /// Blob mode: `100644`, `100755` or `120000` (symlink).
    #[ts(type = "\"100644\" | \"100755\" | \"120000\"")]
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeResponse {
    pub sha: String,
    pub files: Vec<TreeEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobResponse {
    pub sha: String,
    pub path: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub text: String,
}

/// The deploy mirror: `repos/{slug}.git`, where the deploy pipeline fetches
/// the tip it builds. Reads do not use it (see `forge::read_mirror`).
pub fn bare_repo(cfg: &Config, slug: &str) -> PathBuf {
    exec::work_root(cfg)
        .join("repos")
        .join(format!("{slug}.git"))
}

/// Materialize `rev` from the bare mirror into `dest`, force-overwriting what
/// is there, without touching the mirror's index or `HEAD`.
///
/// One mirror is shared by everything that needs a worktree for an app — the
/// deploy's build tree, each environment's, the d1 project dir — so the
/// mirror's single `index` (and its `index.lock`) must never be the
/// checkout's state: a deploy that is stopped mid-checkout leaves the lock
/// behind and every later checkout of that app fails, two concurrent
/// checkouts fight over one lock, and `git checkout -f` also moves the
/// mirror's `HEAD` (so a read could change what a deploy builds).
///
/// Each call therefore gets its own index file (`GIT_INDEX_FILE`, a sibling
/// of `dest`, never inside the repository) and `read-tree -u --reset` writes
/// the tree: it overwrites tracked and untracked files alike, recreates
/// symlinks and exec bits from the tree's modes, and leaves submodules as an
/// empty directory — the same result as a force checkout of a bare mirror,
/// which never initializes them either.
pub async fn checkout_into(
    bare: &std::path::Path,
    rev: &str,
    dest: &std::path::Path,
) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dest).await?;
    let index_dir = dest.parent().unwrap_or(dest);
    let index = index_dir.join(format!(".git-index-{}", crate::models::new_id()));
    let Some(index_arg) = index.to_str() else {
        anyhow::bail!(
            "checkout index path is not valid UTF-8: {}",
            index.display()
        );
    };
    let result = exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            &format!("--work-tree={}", dest.display()),
            "read-tree",
            "-u",
            "--reset",
            rev,
        ],
        Some(dest),
        &[("GIT_INDEX_FILE", index_arg)],
        Duration::from_secs(30),
    )
    .await;
    let _ = tokio::fs::remove_file(&index).await;
    result.map(|_| ())
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
    // Ephemeral disk: pull the tip bundle then retry once. The test is the
    // mirror's state, not `HEAD` alone: a hydrate that crashed between
    // `git init --bare` and its fetch leaves `HEAD` and no objects, and the
    // old check then sent every read at a mirror that could never serve
    // ("unknown revision") instead of finishing the hydrate. A `Ready` mirror
    // is never touched here, so a live deploy's `main` ref cannot be moved by
    // a read.
    if rehydrate::mirror_state(cfg, slug) != rehydrate::MirrorState::Ready {
        rehydrate::ensure_deploy_mirror(cfg, slug).await?;
    }
    if rehydrate::mirror_state(cfg, slug) == rehydrate::MirrorState::Absent {
        anyhow::bail!("no bare mirror for {slug} yet");
    }
    let checkout = checkout_into(&bare, rev, dest).await;
    match checkout {
        Ok(_) => Ok(()),
        // An `Incomplete` mirror is not rejected up front: it may still hold
        // the revision being asked for (an environment ref survives a partial
        // main-tip hydrate). The failure is reported with the mirror's state
        // so an operator can tell "never hydrated" from "bad revision" — a
        // debug assertion here used to panic instead, and release builds said
        // only "unknown revision".
        Err(error) => anyhow::bail!(
            "checkout of {rev} from {slug}'s mirror failed ({:?}): {error:#}",
            rehydrate::mirror_state(cfg, slug)
        ),
    }
}

/// Full recursive listing (git's own tree order — server-sorted, so the UI
/// can use preparePresortedFileTreeInput).
pub async fn list_tree(bare: &std::path::Path, rev: &str) -> anyhow::Result<TreeResponse> {
    let out = forge::git_out(bare, &["ls-tree", "-r", "-z", "-l", rev]).await?;
    let mut files = Vec::new();
    let mut truncated = false;
    for rec in out.trim_end_matches('\0').split('\0') {
        if rec.is_empty() {
            continue;
        }
        if files.len() >= MAX_TREE_FILES {
            truncated = true;
            break;
        }
        let Some((ty, sha, size, path, mode)) = parse_tree_record(rec) else {
            continue;
        };
        if ty != "blob" {
            continue;
        }
        files.push(TreeEntry {
            path,
            size,
            sha,
            mode,
        });
    }
    Ok(TreeResponse {
        sha: rev.to_string(),
        files,
        truncated,
    })
}

fn parse_tree_record(rec: &str) -> Option<(String, String, u64, String, String)> {
    // Layout varies: with -z the size is space-padded into the head
    // ("<mode> <type> <sha>   <size>\t<path>"); without -z it is its own
    // column ("<mode> <type> <sha>\t<size>\t<path>"). The one invariant is
    // the LAST tab separates the path. Split on whitespace tokens.
    let (head, path) = rec.rsplit_once('\t')?;
    let tokens: Vec<&str> = head.split_whitespace().collect();
    if tokens.len() < 3 {
        return None;
    }
    let mode = tokens[0].to_string();
    let ty = tokens[1].to_string();
    let sha = tokens[2].to_string();
    let size: u64 = match tokens.get(3) {
        Some(s) => s.parse().unwrap_or(0),
        None => 0,
    };
    Some((ty, sha, size, path.to_string(), mode))
}

/// Validate a browser-supplied path before it touches git.
pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\0')
        && !path.split('/').any(|seg| seg == "..")
}

pub async fn read_blob(
    bare: &std::path::Path,
    rev: &str,
    path: &str,
) -> anyhow::Result<BlobResponse> {
    if !valid_path(path) {
        bail!("invalid path");
    }
    let out = forge::git_out(bare, &["ls-tree", "-z", "-l", rev, "--", path]).await?;
    let Some((_, sha, size, _, _)) = parse_tree_record(out.trim_end_matches('\0')) else {
        bail!("file not found in {rev}");
    };
    let truncated = size > MAX_BLOB as u64;
    let text = if truncated {
        String::new()
    } else {
        // cat-file by the object id we resolved — never from user input.
        forge::git_out(bare, &["cat-file", "blob", &sha]).await?
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

#[cfg(test)]
mod tests {

    //! Checkout and tree reads against a real bare mirror.

    use super::*;

    /// A mirror that cannot serve the requested revision is a runtime error
    /// naming the mirror's state, never a panic: a debug assertion used to fire
    /// on an `Incomplete` mirror, and release builds said only "unknown
    /// revision". An `Incomplete` mirror is still checked out (it may hold an
    /// environment ref), so the failure has to come from the checkout itself.
    #[tokio::test]
    async fn a_checkout_of_a_missing_revision_names_the_mirror_state() {
        let dir = std::env::temp_dir().join(format!("noite-src2-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.to_string_lossy().into_owned();
        let bare = bare_repo(&cfg, "readybrew");
        std::fs::create_dir_all(bare.join("refs/heads")).expect("bare dir");
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("head");
        std::fs::write(bare.join("refs/heads/main"), "0".repeat(40)).expect("main ref");
        assert_eq!(
            crate::host::rehydrate::mirror_state(&cfg, "readybrew"),
            crate::host::rehydrate::MirrorState::Ready,
            "a Ready mirror is never hydrated from a read"
        );
        let dest = dir.join("dest");

        let err = checkout_worktree(&cfg, "readybrew", "no-such-rev", &dest)
            .await
            .expect_err("the revision does not exist");

        let text = format!("{err:#}");
        assert!(
            text.contains("no-such-rev") && text.contains("Ready"),
            "the error names the revision and the mirror state: {text}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A checkout against a half-hydrated mirror must try to finish the
    /// hydrate. It used to look at `HEAD` alone, so a hydrate that crashed
    /// between `git init --bare` and its fetch made every read fail with
    /// "unknown revision" — the mirror looked present forever.
    #[tokio::test]
    async fn a_checkout_retries_a_half_hydrated_mirror() {
        let dir = std::env::temp_dir().join(format!("noite-src-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.to_string_lossy().into_owned();
        // The debris: a bare repo with `HEAD` and no `main` ref.
        let bare = bare_repo(&cfg, "halfbrew");
        std::fs::create_dir_all(bare.join("refs/heads")).expect("bare dir");
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("head");
        assert_eq!(
            crate::host::rehydrate::mirror_state(&cfg, "halfbrew"),
            crate::host::rehydrate::MirrorState::Incomplete
        );
        let dest = dir.join("dest");

        let err = checkout_worktree(&cfg, "halfbrew", "main", &dest)
            .await
            .expect_err("the hydrate cannot reach the store in a test");

        // The error is the hydrate's, not a checkout of a mirror that has no
        // objects: the retry happened.
        let text = format!("{err:#}");
        assert!(
            text.contains("s3") || text.contains("transport") || text.contains("tip bundle"),
            "the checkout tried to finish the hydrate: {text}"
        );
        for checkout_error in ["unknown revision", "not a valid object name"] {
            assert!(
                !text.contains(checkout_error),
                "it failed in the hydrate, not in a checkout of an empty mirror: {text}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    const GIT_ENV: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.com"),
    ];

    async fn git(dir: &std::path::Path, args: &[&str]) -> String {
        exec::run_cmd("git", args, Some(dir), GIT_ENV, Duration::from_secs(30))
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {}: {e:#}", dir.display()))
    }

    /// A source repo with `main` (an exec script, a symlink and a data file)
    /// and a `preview` branch that changes the data file, cloned bare into
    /// `repos/<slug>.git` — the mirror layout the runner uses.
    async fn bare_mirror(dir: &std::path::Path, slug: &str) -> PathBuf {
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.to_string_lossy().into_owned();
        let bare = bare_repo(&cfg, slug);
        tokio::fs::create_dir_all(bare.parent().expect("repos dir"))
            .await
            .expect("repos dir");
        let source = dir.join("source");
        std::fs::create_dir_all(&source).expect("source dir");
        git(&source, &["init", "-q", "--initial-branch=main", "."]).await;
        std::fs::write(source.join("app.js"), "main\n").expect("app.js");
        std::fs::write(source.join("run.sh"), "#!/bin/sh\necho hi\n").expect("run.sh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                source.join("run.sh"),
                std::fs::Permissions::from_mode(0o755),
            )
            .expect("exec bit");
            std::os::unix::fs::symlink("app.js", source.join("link.js")).expect("symlink");
        }
        git(&source, &["add", "-A"]).await;
        git(&source, &["commit", "-qm", "main"]).await;
        git(&source, &["checkout", "-q", "-b", "preview"]).await;
        std::fs::write(source.join("app.js"), "preview\n").expect("app.js");
        git(&source, &["commit", "-qam", "preview"]).await;
        git(&source, &["checkout", "-q", "main"]).await;
        git(
            dir,
            &[
                "clone",
                "-q",
                "--bare",
                source.to_str().expect("source path"),
                bare.to_str().expect("bare path"),
            ],
        )
        .await;
        bare
    }

    /// A deploy that is stopped or killed mid-checkout used to leave the
    /// mirror's own `index.lock` behind, and every later checkout of that app
    /// failed with "Unable to create '…/index.lock': File exists". The
    /// checkout owns its index, so the mirror's debris is irrelevant — and
    /// the tree comes out with the modes and links git recorded.
    #[tokio::test]
    async fn a_stale_index_lock_in_the_mirror_does_not_fail_a_checkout() {
        let dir = std::env::temp_dir().join(format!("noite-src-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.to_string_lossy().into_owned();
        let bare = bare_mirror(&dir, "lockbrew").await;
        std::fs::write(bare.join("index.lock"), "").expect("stale lock");

        let dest = dir.join("dest");
        checkout_worktree(&cfg, "lockbrew", "refs/heads/main", &dest)
            .await
            .expect("a stale lock in the mirror is not the checkout's state");

        assert_eq!(
            std::fs::read_to_string(dest.join("app.js")).expect("app.js"),
            "main\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dest.join("run.sh"))
                .expect("run.sh")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "the exec bit survives: {mode:o}");
            assert_eq!(
                std::fs::read_link(dest.join("link.js")).expect("symlink"),
                std::path::Path::new("app.js")
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Two checkouts of one mirror at different revs, into different
    /// directories, at the same time: a deploy plus a d1/project read, or a
    /// production deploy plus a preview. With one shared index they fought
    /// over `index.lock`; each own index makes them independent.
    #[tokio::test]
    async fn concurrent_checkouts_of_different_revs_do_not_share_state() {
        let dir = std::env::temp_dir().join(format!("noite-src-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let bare = bare_mirror(&dir, "racebrew").await;
        let main_dest = dir.join("main");
        let preview_dest = dir.join("preview");

        let (main, preview) = tokio::join!(
            checkout_into(&bare, "refs/heads/main", &main_dest),
            checkout_into(&bare, "refs/heads/preview", &preview_dest),
        );
        main.expect("main checkout");
        preview.expect("preview checkout");

        assert_eq!(
            std::fs::read_to_string(main_dest.join("app.js")).expect("main app.js"),
            "main\n"
        );
        assert_eq!(
            std::fs::read_to_string(preview_dest.join("app.js")).expect("preview app.js"),
            "preview\n"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// `git checkout -f <ref>` detached the mirror at that rev as a side
    /// effect, so a read (d1's project dir, a source preview) rewrote what a
    /// concurrent deploy looked at. A checkout leaves `HEAD` alone.
    #[tokio::test]
    async fn a_checkout_does_not_move_the_mirror_head() {
        let dir = std::env::temp_dir().join(format!("noite-src-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let bare = bare_mirror(&dir, "headbrew").await;
        let head_before = std::fs::read_to_string(bare.join("HEAD")).expect("HEAD");

        checkout_into(&bare, "refs/heads/preview", &dir.join("dest"))
            .await
            .expect("checkout");

        assert_eq!(
            std::fs::read_to_string(bare.join("HEAD")).expect("HEAD"),
            head_before,
            "the mirror's HEAD still names its own branch"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
