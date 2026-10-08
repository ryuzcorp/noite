// Source preview: serve a commit's tree / blobs from the push mirror
// (RUNNER_WORK_DIR/git-http/{slug}.git), the same mirror the smart-HTTP
// adapter writes and the one that holds every pushed branch. The mirror is
// materialized and manifest-synced by the service layer before these run
// (`forge::read_mirror`); a server-side ref move materializes it the same way.
use std::path::PathBuf;
use std::time::Duration;

use anyhow::bail;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::config::Config;
use crate::host::{exec, forge, rehydrate};

pub const MAX_BLOB: usize = 256 * 1024;
pub const MAX_PATCH: usize = 1024 * 1024;
const MAX_FILES: usize = 2_000;

/// `source.bundle` caps: file count, per-file size and the whole payload.
pub const MAX_BUNDLE_FILES: usize = 3_000;
pub const MAX_BUNDLE_FILE: u64 = 256 * 1024;
pub const MAX_BUNDLE_TOTAL: u64 = 8 * 1024 * 1024;

/// Extensions the code editor loads. `.d.ts`/`.d.mts`/`.d.cts` all end in one
/// of these, so the declaration files ride along.
const BUNDLE_EXTENSIONS: &[&str] = &["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json"];

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
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

/// One text source crossing the wire: the same shape `source.bundle` and
/// `source.types` both use, so the editor loads either into one map.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceBundle {
    pub sha: String,
    pub files: Vec<SourceFile>,
    pub truncated: bool,
}

/// The deploy mirror: `repos/{slug}.git`, where the deploy pipeline fetches
/// the tip it builds. Reads do not use it (see `forge::read_mirror`).
pub fn bare_repo(cfg: &Config, slug: &str) -> PathBuf {
    exec::work_root(cfg)
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
        // Ephemeral disk: pull tip bundle then retry once.
        let _ = rehydrate::ensure_deploy_mirror(cfg, slug).await;
    }
    if !bare.join("HEAD").exists() {
        anyhow::bail!("no bare mirror for {slug} yet");
    }
    tokio::fs::create_dir_all(dest).await?;
    exec::run_cmd(
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
    let Some((_, sha, size, _)) = parse_tree_record(out.trim_end_matches('\0')) else {
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

/// A path the browser editor loads: a known text extension, never a committed
/// `node_modules/` segment.
fn bundle_path(path: &str) -> bool {
    if path.split('/').any(|seg| seg == "node_modules") {
        return false;
    }
    let Some((_, ext)) = path.rsplit('/').next().and_then(|n| n.rsplit_once('.')) else {
        return false;
    };
    BUNDLE_EXTENSIONS.contains(&ext)
}

/// Every text source at `rev`, in one `cat-file --batch`, for the editor's
/// language service. Committed `node_modules/`, non-source extensions and
/// oversized blobs are dropped; paths are sorted so the payload is
/// deterministic, and the count/size caps set `truncated`.
pub async fn bundle(bare: &std::path::Path, rev: &str) -> anyhow::Result<SourceBundle> {
    let out = forge::git_out(bare, &["ls-tree", "-r", "-z", "-l", rev]).await?;
    let mut candidates: Vec<(String, String)> = Vec::new();
    for rec in out.trim_end_matches('\0').split('\0') {
        if rec.is_empty() {
            continue;
        }
        let Some((ty, oid, size, path)) = parse_tree_record(rec) else {
            continue;
        };
        if ty == "blob" && bundle_path(&path) && size <= MAX_BUNDLE_FILE {
            candidates.push((path, oid));
        }
    }
    // git's tree order is already sorted, but the payload order is part of the
    // contract, so sort (and cap) explicitly on paths.
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    let mut truncated = candidates.len() > MAX_BUNDLE_FILES;
    candidates.truncate(MAX_BUNDLE_FILES);
    let stdin: String = candidates
        .iter()
        .map(|(_, oid)| format!("{oid}\n"))
        .collect();
    let raw = exec::run_cmd_stdin(
        "git",
        &[&format!("--git-dir={}", bare.display()), "cat-file", "--batch"],
        stdin.as_bytes(),
        None,
        Duration::from_secs(120),
    )
    .await?;
    let (files, budget_hit) = read_batch(&raw, &candidates, MAX_BUNDLE_TOTAL);
    truncated |= budget_hit;
    Ok(SourceBundle {
        sha: rev.to_string(),
        files,
        truncated,
    })
}

/// Walk a `cat-file --batch` reply alongside the objects we asked for, in
/// request order, and decode the text blobs that fit `budget`. Batch output is
/// `<oid> <type> <size>\n<contents>\n` per object, or `<oid> missing\n`. The
/// second value reports that the byte budget stopped the read short.
fn read_batch(raw: &[u8], wanted: &[(String, String)], budget: u64) -> (Vec<SourceFile>, bool) {
    let mut files = Vec::new();
    let mut total: u64 = 0;
    let mut idx = 0usize;
    for (path, _) in wanted {
        let Some(nl) = raw[idx..].iter().position(|b| *b == b'\n') else {
            break;
        };
        let mut header = raw[idx..idx + nl].split(|b| *b == b' ').filter(|p| !p.is_empty());
        let kind = header.nth(1).unwrap_or_default();
        idx += nl + 1;
        if kind == b"missing" {
            continue;
        }
        let Some(size) = std::str::from_utf8(header.next().unwrap_or_default())
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
        else {
            break;
        };
        if idx + size > raw.len() {
            break;
        }
        let content = &raw[idx..idx + size];
        idx += size;
        if idx < raw.len() {
            idx += 1; // the batch reply's record separator
        }
        if total + size as u64 > budget {
            return (files, true);
        }
        // Binary or non-UTF-8 blobs are not sources; the editor cannot use
        // them, so they are dropped rather than mangled.
        if content.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(content) else {
            continue;
        };
        total += size as u64;
        files.push(SourceFile {
            path: path.clone(),
            text: text.to_string(),
        });
    }
    (files, false)
}

#[cfg(test)]
mod tests {
    //! `source.bundle` against a real bare mirror: the extension/vendor
    //! filters, the caps, deterministic order and git ref resolution, driven
    //! through the same function the RPC calls.
    use std::path::Path;

    use super::*;

    const GIT_ENV: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.com"),
    ];

    async fn git(dir: &Path, args: &[&str]) -> String {
        exec::run_cmd("git", args, Some(dir), GIT_ENV, Duration::from_secs(60))
            .await
            .unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
    }

    /// A bare mirror with one commit on `main` holding `files` (plus a `v1`
    /// tag on it); returns the scratch dir, the mirror and the commit sha.
    async fn seed(files: &[(&str, &str)]) -> (PathBuf, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("noite-bundle-{}", crate::models::new_id()));
        let work = dir.join("work");
        let bare = dir.join("mirror.git");
        std::fs::create_dir_all(&work).expect("work dir");
        git(&work, &["init", "-q", "--initial-branch=main", "."]).await;
        for (path, text) in files {
            let full = work.join(path);
            std::fs::create_dir_all(full.parent().expect("parent")).expect("parent dir");
            std::fs::write(full, text).expect("write");
        }
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "init"]).await;
        let sha = git(&work, &["rev-parse", "HEAD"]).await.trim().to_string();
        git(
            &dir,
            &[
                "init",
                "-q",
                "--bare",
                "--initial-branch=main",
                bare.to_str().expect("mirror path"),
            ],
        )
        .await;
        git(
            &work,
            &[
                "push",
                "-q",
                bare.to_str().expect("mirror path"),
                "main:main",
                "main:refs/tags/v1",
            ],
        )
        .await;
        (dir, bare, sha)
    }

    fn paths(bundle: &SourceBundle) -> Vec<&str> {
        bundle.files.iter().map(|f| f.path.as_str()).collect()
    }

    #[tokio::test]
    async fn bundle_filters_vendored_paths_and_foreign_extensions() {
        let (dir, bare, sha) = seed(&[
            ("src/index.ts", "export const a = 1;\n"),
            ("src/app.tsx", "export const b = 2;\n"),
            ("src/data.json", "{}\n"),
            ("src/types.d.ts", "declare const c: number;\n"),
            ("src/readme.md", "# no\n"),
            ("src/style.css", "a {}\n"),
            ("server/worker.mjs", "export default {};\n"),
            ("node_modules/dep/index.ts", "export {};\n"),
        ])
        .await;

        let out = bundle(&bare, &sha).await.expect("bundle");
        assert_eq!(out.sha, sha);
        assert!(!out.truncated);
        assert_eq!(
            paths(&out),
            [
                "server/worker.mjs",
                "src/app.tsx",
                "src/data.json",
                "src/index.ts",
                "src/types.d.ts",
            ]
        );
        assert_eq!(out.files[3].text, "export const a = 1;\n");

        // Refs resolve through git: a branch, a tag and a short sha.
        for rev in ["main", "v1", &sha[..8]] {
            let out = bundle(&bare, rev).await.expect("ref");
            assert_eq!(out.files.len(), 5, "{rev}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn bundle_drops_oversized_and_binary_blobs() {
        let big = "x".repeat(MAX_BUNDLE_FILE as usize + 1);
        let exact = "y".repeat(MAX_BUNDLE_FILE as usize);
        let (dir, bare, sha) = seed(&[
            ("src/index.ts", "export {};\n"),
            ("src/big.ts", &big),
            ("src/exact.ts", &exact),
            ("src/binary.ts", "a\u{0}b\n"),
        ])
        .await;

        let out = bundle(&bare, &sha).await.expect("bundle");
        assert_eq!(paths(&out), ["src/exact.ts", "src/index.ts"]);
        assert!(!out.truncated, "a skipped blob is not a truncation");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn bundle_with_nothing_to_read_is_empty() {
        let (dir, bare, sha) = seed(&[("README.md", "# hi\n")]).await;
        let out = bundle(&bare, &sha).await.expect("bundle");
        assert!(out.files.is_empty());
        assert!(!out.truncated);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn bundle_caps_the_file_count() {
        let names: Vec<String> = (0..MAX_BUNDLE_FILES + 5)
            .map(|i| format!("src/f{i:05}.ts"))
            .collect();
        let files: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), "export {};\n")).collect();
        let (dir, bare, sha) = seed(&files).await;

        let out = bundle(&bare, &sha).await.expect("bundle");
        assert!(out.truncated);
        assert_eq!(out.files.len(), MAX_BUNDLE_FILES);
        assert!(out.files.windows(2).all(|w| w[0].path < w[1].path));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn bundle_caps_the_total_bytes() {
        // Every file fits the per-file cap; together they exceed the payload
        // cap, so the read stops exactly at the budget.
        let chunk = "z".repeat(MAX_BUNDLE_FILE as usize);
        let names: Vec<String> = (0..40).map(|i| format!("bulk/b{i:03}.ts")).collect();
        let files: Vec<(&str, &str)> = names.iter().map(|n| (n.as_str(), chunk.as_str())).collect();
        let (dir, bare, sha) = seed(&files).await;

        let out = bundle(&bare, &sha).await.expect("bundle");
        assert!(out.truncated);
        let expected = (MAX_BUNDLE_TOTAL / MAX_BUNDLE_FILE) as usize;
        assert_eq!(out.files.len(), expected);
        let total: usize = out.files.iter().map(|f| f.text.len()).sum();
        assert_eq!(total as u64, MAX_BUNDLE_TOTAL);
        std::fs::remove_dir_all(&dir).ok();
    }
}
