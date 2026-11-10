//! A2/A3 import: a one-time copy of a public GitHub repo — or a shipped
//! template — into the new app's push mirror.
//!
//! The runner's clone is **not** covered by the tenant egress policy, so the
//! URL allowlist below is the security boundary: exactly
//! `https://github.com/<owner>/<repo>(.git)`, rebuilt from validated segments
//! (the caller's string is never handed to git). The clone runs with
//! `GIT_TERMINAL_PROMPT=0` and https as the only permitted protocol, under a
//! wall-clock budget; the on-disk size of the clone is capped before anything
//! is published.
//!
//! Setup (`apps.create`) validates the source and stores it on the app row, so
//! a failure can be retried with the same URL, ref, path and actor (A2).
//!
//! A `path` imports one subdirectory of the repo (a monorepo package): the
//! whole repo is cloned under the same caps, and that directory's tree becomes
//! the app's root as one squashed commit — the same snapshot a tarball
//! extractor such as giget makes, without a second host to allow.

use std::collections::HashMap;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use anyhow::{bail, Context};

use crate::db;
use crate::host::cancel::CancelHandle;
use crate::host::exec;
use crate::host::forge;
use crate::host::git_http;
use crate::host::git_identity::{self, Identity};
use crate::models::{new_id, now_iso, App, AppStatus, GitSource};
use crate::AppState;

/// Wall-clock budget for the one `git clone` (the size cap covers the other
/// axis: a slow clone is killed, a fat one is discarded).
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);
/// Cap on the clone's on-disk size.
const MAX_IMPORT_BYTES: u64 = 500 * 1024 * 1024;
/// The one host the runner clones from.
const ALLOWED_HOST: &str = "github.com";
/// Cap for an owner/repo path segment (GitHub's own limit is 100).
const MAX_SEGMENT: usize = 100;
/// Cap for a caller-supplied `ref` (branch, tag or sha).
const MAX_REF: usize = 200;
/// `app_event` rows the import writes progress to.
const CHANNEL: &str = "import";

/// A validated, canonicalized import source. The clone URL is **built** from
/// the validated owner/repo, so nothing the caller typed reaches git verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportTarget {
    pub owner: String,
    pub repo: String,
    pub clone_url: String,
}

/// Whether a clone may use `file://` — only the tests turn this on, so the API
/// path can never reach a local path (the security boundary is
/// [`github_url`], and this keeps the seam explicit instead of loosening it).
#[derive(Debug, Clone, Copy, Default)]
struct Protocols {
    file: bool,
}

impl Protocols {
    fn args(&self) -> Vec<String> {
        let mut args = vec!["-c".to_string(), "protocol.allow=never".to_string()];
        args.push("-c".to_string());
        args.push("protocol.https.allow=always".to_string());
        if self.file {
            args.push("-c".to_string());
            args.push("protocol.file.allow=always".to_string());
        }
        // NOITE-IMPORT-003: the only host the allowlist accepts is github.com,
        // and a redirect would move the fetch to whatever that host points at —
        // so the clone never follows one.
        args.push("-c".to_string());
        args.push("http.followRedirects=false".to_string());
        args
    }
}

/// One owner/repo segment: letters, digits, `_`, `.`, `-`, no leading `-` and
/// never a bare `.`/`..` (which the charset alone would admit).
fn segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_SEGMENT
        && !s.starts_with('-')
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

/// Validate the one import URL and return the canonical target. Any other
/// scheme, host, credential, port, query, fragment or extra path segment is
/// refused (`Err` is the message the API returns as a 400).
pub fn github_url(url: &str) -> Result<ImportTarget, String> {
    const SHAPE: &str = "url must be https://github.com/<owner>/<repo>";
    let url = url.trim();
    if url.is_empty() || url.len() > 512 {
        return Err(SHAPE.to_string());
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(SHAPE.to_string());
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err("only https://github.com URLs can be imported".to_string());
    };
    if !scheme.eq_ignore_ascii_case("https") {
        return Err("only https://github.com URLs can be imported".to_string());
    }
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path),
        None => return Err(SHAPE.to_string()),
    };
    if authority.contains('@') {
        return Err("credentials in the URL are not allowed".to_string());
    }
    if authority.contains(':') {
        return Err("ports are not allowed".to_string());
    }
    if !authority.eq_ignore_ascii_case(ALLOWED_HOST) {
        return Err("only github.com repositories can be imported".to_string());
    }
    if path.contains('?') || path.contains('#') {
        return Err("query strings and fragments are not allowed".to_string());
    }
    let mut parts = path.split('/');
    let (Some(owner), Some(repo), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(SHAPE.to_string());
    };
    if !segment_ok(owner) || !segment_ok(repo) {
        return Err(SHAPE.to_string());
    }
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !segment_ok(repo) {
        return Err(SHAPE.to_string());
    }
    Ok(ImportTarget {
        owner: owner.to_string(),
        repo: repo.to_string(),
        clone_url: format!("https://{ALLOWED_HOST}/{owner}/{repo}.git"),
    })
}

/// Validate the optional `ref` before it reaches `git clone --branch=<ref>`.
/// Refuses anything option-shaped, whitespace, `..`, `@{`, a trailing `.lock`
/// or a leading/trailing slash — git's own `check-ref-format` rules, applied
/// here so a hostile ref never reaches the process.
pub fn import_ref(reference: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("ref {why}"));
    if reference.is_empty() || reference.len() > MAX_REF {
        return bad("must be 1..=200 chars");
    }
    if reference.starts_with('-') {
        return bad("must not start with '-'");
    }
    if reference
        .chars()
        .any(|c| c.is_control() || c.is_whitespace())
    {
        return bad("must not contain whitespace");
    }
    if reference.contains("..") || reference.contains("@{") || reference.contains('\\') {
        return bad("must not contain \"..\", \"@{\" or \"\\\"");
    }
    if reference.starts_with('/')
        || reference.ends_with('/')
        || reference.ends_with('.')
        || reference.ends_with(".lock")
        || reference == "@"
    {
        return bad("is not a valid ref name");
    }
    Ok(())
}

/// Validate and normalize the optional subdirectory `path` (surrounding
/// slashes dropped). It is only ever used as `<sha>:<path>` in `rev-parse`, so
/// it must stay a plain relative path: no `.`/`..`/`.git` segment, nothing
/// option- or revision-shaped (`-`, `:`, `^`, `~`, `@{`), no backslash,
/// whitespace or control characters.
pub fn import_path(path: &str) -> Result<String, String> {
    let bad = |why: &str| Err(format!("path {why}"));
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() || trimmed.len() > MAX_REF {
        return bad("must be 1..=200 chars");
    }
    if trimmed.starts_with('-') {
        return bad("must not start with '-'");
    }
    if trimmed
        .chars()
        .any(|c| c.is_control() || matches!(c, '\\' | ':' | '^' | '~' | '?' | '*' | '['))
        || trimmed.contains("@{")
    {
        return bad("must be a plain folder path, like packages/web");
    }
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." || segment == ".git" {
            return bad("must be a plain folder path, like packages/web");
        }
        if segment.trim() != segment {
            return bad("must not have spaces around a folder name");
        }
    }
    Ok(trimmed.to_string())
}

/// `app_event` line for the import feed (best effort: a lost event never fails
/// the import itself).
async fn note(state: &AppState, app_id: &str, event: &str, description: &str) {
    let _ = db::insert_app_event(
        &state.pool,
        &new_id(),
        app_id,
        CHANNEL,
        event,
        description,
        "📦",
        "{}",
        "",
        &now_iso(),
    )
    .await;
}

/// One background import attempt in THIS process: the in-memory half of the
/// import machine (RDEP-5). The row's status is the durable half
/// ([`crate::models::AppStatus::Importing`] → `provisioned` / `error`).
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Running: spawn reserves the app and starts the task
///   Running --> [*]: the attempt ended (its row carries the outcome)
///   Running --> [*]: a delete stopped it and awaited the end
/// ```
///
/// An entry exists exactly while an attempt runs: the attempt removes its own
/// entry on every exit path — a panic included — so nothing is remembered
/// afterwards (a row that says `importing` with no entry is an import whose
/// task died with an earlier process, which is what Retry serves).
struct ImportRun {
    /// The stop token a delete trips; the clone races it and dies with its
    /// process group, so the await below is bounded.
    cancel: CancelHandle,
    /// The task a delete awaits before purging the slug.
    task: tokio::task::JoinHandle<()>,
}

/// App id → the attempt running here.
static IMPORTS: LazyLock<Mutex<HashMap<String, ImportRun>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn imports() -> std::sync::MutexGuard<'static, HashMap<String, ImportRun>> {
    IMPORTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The cancel-registry key of one app's import: its own namespace, so an
/// import token can never be mistaken for a deploy's.
fn import_key(app_id: &str) -> String {
    format!("import:{app_id}")
}

/// Start the background import (A2/A3). The caller has already stored the
/// source and flipped the app to `importing`, so `create` returns at once.
/// `false` = this process already runs an import for the app, so nothing was
/// started (the caller reports the conflict).
///
/// The slot check, the spawn and the insert are one locked step: two
/// concurrent retries cannot both start an import (the task's own `finish`
/// waits for this guard).
pub fn spawn(state: &AppState, app: App, source: GitSource) -> bool {
    let mut runs = imports();
    if runs.contains_key(&app.id) {
        return false;
    }
    let key = import_key(&app.id);
    let cancel = crate::host::cancel::CANCELS.register(&key);
    let state = state.clone();
    let slot_id = app.id.clone();
    let task_id = slot_id.clone();
    let token = cancel.clone();
    let task = tokio::spawn(async move {
        // The token is the task-local a child process races, so a delete's
        // trip kills the clone instead of waiting out its timeout.
        let out = crate::host::cancel::with(
            token.clone(),
            run(&state, &app, &source, Protocols::default()),
        )
        .await;
        if let Err(e) = out {
            tracing::error!(slug = %app.slug, error = %format!("{e:#}"), "import failed");
        }
        finish(&task_id, &token);
    });
    runs.insert(slot_id, ImportRun { cancel, task });
    true
}

/// Release this attempt's reservation (and its stop token), unless a newer
/// attempt already replaced it.
fn finish(app_id: &str, cancel: &CancelHandle) {
    let mut runs = imports();
    let ours = runs
        .get(app_id)
        .is_some_and(|run| Arc::ptr_eq(&run.cancel, cancel));
    if ours {
        runs.remove(app_id);
        crate::host::cancel::CANCELS.release_if(&import_key(app_id), cancel);
    }
}

/// Stop a running import and wait for it to end. A delete calls this before
/// it purges the slug: a clone that finished late would otherwise publish
/// `refs/heads/main` under a slug the delete is about to free, and the next
/// app to take that slug would inherit the tree. `false` = nothing was
/// running here.
pub async fn cancel_and_wait(app_id: &str) -> bool {
    let run = imports().remove(app_id);
    let Some(run) = run else {
        return false;
    };
    crate::host::cancel::CANCELS.cancel(&import_key(app_id));
    // The task ends on its own: the clone is killed with its group, the
    // remaining steps are local, and the publish re-checks the row.
    let _ = run.task.await;
    crate::host::cancel::CANCELS.release_if(&import_key(app_id), &run.cancel);
    true
}

/// The whole import, with the app row's status moved by the outcome. Only runs
/// while the app is still `importing`, so a push that raced the import (and
/// already started a deploy) is never clobbered.
async fn run(
    state: &AppState,
    app: &App,
    source: &GitSource,
    protocols: Protocols,
) -> anyhow::Result<()> {
    match import_once(state, app, source, protocols).await {
        Ok(sha) => {
            note(
                state,
                &app.id,
                "Import finished",
                &format!("{} at {}", source.url, &sha[..sha.len().min(7)]),
            )
            .await;
            if !db::finish_app_import(&state.pool, &app.id, AppStatus::Provisioned, None)
                .await?
                .is_applied()
            {
                tracing::info!(
                    app_id = %app.id,
                    "import outcome lost the race to a deploy; the row keeps its story"
                );
            }
            Ok(())
        }
        Err(e) => {
            let message = format!("{e:#}");
            note(state, &app.id, "Import failed", &message).await;
            if !db::finish_app_import(&state.pool, &app.id, AppStatus::Error, Some(&message))
                .await?
                .is_applied()
            {
                tracing::info!(
                    app_id = %app.id,
                    "import failure lost the race to a deploy; the row keeps its story"
                );
            }
            Err(e)
        }
    }
}

/// Clone, fetch into the push mirror, optionally squash, then publish `main`
/// (bundles + manifest + TipNotify through the one publish path a push uses).
/// Returns the published sha.
async fn import_once(
    state: &AppState,
    app: &App,
    source: &GitSource,
    protocols: Protocols,
) -> anyhow::Result<String> {
    let target = github_url(&source.url).map_err(|e| anyhow::anyhow!("{e}"))?;
    if let Some(reference) = &source.reference {
        import_ref(reference).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    if let Some(path) = &source.path {
        import_path(path).map_err(|e| anyhow::anyhow!("{e}"))?;
    }
    let scratch =
        exec::work_root(&state.config)
            .join("import")
            .join(format!("{}-{}", app.slug, new_id()));
    tokio::fs::create_dir_all(&scratch).await?;
    let result = import_into(state, app, source, &target, &scratch, protocols).await;
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    result
}

/// The body of [`import_once`] with the scratch dir already made, so the
/// cleanup above runs on every path.
async fn import_into(
    state: &AppState,
    app: &App,
    source: &GitSource,
    target: &ImportTarget,
    scratch: &Path,
    protocols: Protocols,
) -> anyhow::Result<String> {
    // The clone itself enforces the size cap while it runs and on exit
    // (`run_grouped`), so by here the repository is within it.
    let upstream_sha =
        clone_scratch(target, source.reference.as_deref(), scratch, protocols).await?;
    let mirror = state.wal.ensure_synced(&app.slug).await?;
    // Objects only: moving a ref here would make `after_receive` see no change
    // and publish nothing, so the temp ref is the fetch target and `publish_ref`
    // does the one visible ref move below.
    fetch_into(&mirror, &scratch.join("upstream.git"), "HEAD", IMPORT_REF).await?;
    let staged = rev_parse(&mirror, IMPORT_REF).await?;
    let subdir = source
        .path
        .as_deref()
        .map(import_path)
        .transpose()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let published = if source.squash || subdir.is_some() {
        let short = &upstream_sha[..upstream_sha.len().min(7)];
        let (tree, origin) =
            match squash_tree(&mirror, &staged, target, subdir.as_deref(), short).await {
                Ok(found) => found,
                Err(e) => {
                    drop_ref(&mirror, IMPORT_REF).await?;
                    return Err(e);
                }
            };
        let message = format!("Initial commit from {origin}@{short}");
        let identity =
            git_identity::noreply(&state.config, &source.actor.user_id, &source.actor.name);
        let sha = squash_root(&mirror, &tree, &message, &identity).await?;
        drop_ref(&mirror, IMPORT_REF).await?;
        sha
    } else {
        drop_ref(&mirror, IMPORT_REF).await?;
        staged
    };

    // A stopped import must not publish, whatever the clone left behind: the
    // delete that stopped it is about to free this slug.
    if crate::host::cancel::current().is_some_and(|token| token.is_cancelled()) {
        anyhow::bail!("{}", crate::host::cancel::CANCELLED);
    }
    // Retry after a partial landing: `expected_old` is the ref as it stands now.
    // `None` (a fresh app) means "must not exist", which is exactly right here.
    let current = git_http::list_refs(&mirror)
        .await?
        .get("refs/heads/main")
        .cloned();
    forge::publish_ref(
        state,
        app,
        forge::DEFAULT_BRANCH,
        current.as_deref(),
        Some(&published),
    )
    .await?;
    Ok(published)
}

/// The tree a squashed import commits, and the `owner/repo[/path]` its commit
/// message names: the whole fetched tree, or — for a `path` import — that
/// subdirectory's own tree, so it becomes the app's root. A path that is
/// missing, or names a file, fails with a message the app's import error shows.
async fn squash_tree(
    mirror: &Path,
    staged: &str,
    target: &ImportTarget,
    subdir: Option<&str>,
    short: &str,
) -> anyhow::Result<(String, String)> {
    let repo = format!("{}/{}", target.owner, target.repo);
    let Some(path) = subdir else {
        return Ok((
            rev_parse(mirror, &format!("{staged}^{{tree}}")).await?,
            repo,
        ));
    };
    // `<rev>:<path>` takes everything after the colon as the path, so a peel
    // like `^{tree}` cannot be appended: resolve it, then ask its type.
    let found = match rev_parse(mirror, &format!("{staged}:{path}")).await {
        Ok(id) => object_type(mirror, &id)
            .await
            .ok()
            .filter(|t| t == "tree")
            .map(|_| id),
        Err(_) => None,
    };
    match found {
        Some(tree) => Ok((tree, format!("{repo}/{path}"))),
        None => bail!("folder {path} not found in {repo}@{short}"),
    }
}

/// Temp ref the clone is staged under in the push mirror, deleted before the
/// publish so it never reaches the manifest.
const IMPORT_REF: &str = "refs/noite/import";

/// How often the clone's on-disk size and its deadline are checked while it
/// runs (NOITE-IMPORT-001).
const SIZE_POLL: Duration = Duration::from_millis(500);
/// How long a killed child's group is given to be reaped before the error is
/// returned anyway.
const REAP: Duration = Duration::from_secs(5);

/// Run one child in its own process group, enforcing `cap` bytes under
/// `work_dir` *while it runs*: the group is killed the moment the directory
/// passes the cap, and again on the timeout, so an oversized (or endless) clone
/// never finishes writing (NOITE-IMPORT-001). Its own group is what takes git's
/// helpers down with it (`git-remote-https`, `git-index-pack`, …), which a
/// plain `kill_on_drop` leaves behind (NOITE-IMPORT-002).
///
/// stdout is discarded and stderr goes to `clone.log` inside `work_dir` (so it
/// counts toward the cap and is quoted when the child fails).
async fn run_grouped(
    program: &str,
    args: &[String],
    work_dir: &Path,
    cap: u64,
    poll: Duration,
    timeout: Duration,
) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(work_dir).await?;
    let log_path = work_dir.join("clone.log");
    let log = std::fs::File::create(&log_path)?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .current_dir(work_dir)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::from(log));
    // Its own group: pgid == pid, so one killpg takes the whole tree.
    cmd.process_group(0);
    let mut child = tokio::process::Command::from(cmd)
        .spawn()
        .with_context(|| format!("spawn {program}"))?;
    let group = child.id().map(|id| id as i32);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        // A delete (or any stop) must end the clone here, not after its
        // timeout: kill the whole group and report the stop.
        if crate::host::cancel::current().is_some_and(|token| token.is_cancelled()) {
            kill_group(group);
            let _ = tokio::time::timeout(REAP, child.wait()).await;
            anyhow::bail!("{}", crate::host::cancel::CANCELLED);
        }
        // `Child::wait` is cancel safe, so the poll interval can simply
        // re-enter it while the child keeps running.
        match tokio::time::timeout(poll, child.wait()).await {
            Ok(status) => {
                let status = status.with_context(|| format!("wait for {program}"))?;
                let bytes = dir_bytes(work_dir)?;
                if bytes > cap {
                    bail!(
                        "repository is over the {}-MiB import cap",
                        cap / (1024 * 1024)
                    );
                }
                if !status.success() {
                    bail!("{program} failed ({status}): {}", log_tail(&log_path));
                }
                return Ok(());
            }
            Err(_elapsed) => {
                if dir_bytes(work_dir)? > cap {
                    kill_group(group);
                    let _ = tokio::time::timeout(REAP, child.wait()).await;
                    bail!(
                        "repository passed the {}-MiB import cap while cloning; killed it",
                        cap / (1024 * 1024)
                    );
                }
                if tokio::time::Instant::now() >= deadline {
                    kill_group(group);
                    let _ = tokio::time::timeout(REAP, child.wait()).await;
                    bail!(
                        "clone timed out after {}s and was killed",
                        timeout.as_secs()
                    );
                }
            }
        }
    }
}

/// SIGKILL one process group (the child was spawned with `process_group(0)`, so
/// its pgid is its pid). An already-exited or foreign group just errors, which
/// is fine: the caller reaps or abandons the child either way.
fn kill_group(group: Option<i32>) {
    if let Some(group) = group {
        // SAFETY: `killpg` on a group this process created; a signal to a group
        // that no longer exists fails harmlessly.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
}

/// Tail of the child's stderr (bounded: a clone can be chatty), for the error.
fn log_tail(path: &Path) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(4096);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// Clone `target` bare into `scratch`; returns the cloned sha (`HEAD`).
async fn clone_scratch(
    target: &ImportTarget,
    reference: Option<&str>,
    scratch: &Path,
    protocols: Protocols,
) -> anyhow::Result<String> {
    // The clone path is also the process cwd, so it must exist first.
    tokio::fs::create_dir_all(scratch).await?;
    let mut args = protocols.args();
    args.extend(["clone", "--bare", "--single-branch", "--no-tags", "--quiet"].map(str::to_string));
    if let Some(reference) = reference {
        // `--branch=<ref>` (value attached) so a ref can never read as an option.
        args.push(format!("--branch={reference}"));
    }
    // `--` ends the options: the URL and the directory are data.
    args.push("--".to_string());
    let dest = scratch.join("upstream.git");
    args.push(target.clone_url.clone());
    args.push(dest.to_string_lossy().into_owned());
    // The clone is the one place the runner touches an untrusted host, so it
    // runs in its own process group under a live size cap (NOITE-IMPORT-001/002).
    run_grouped(
        "git",
        &args,
        scratch,
        MAX_IMPORT_BYTES,
        SIZE_POLL,
        CLONE_TIMEOUT,
    )
    .await?;
    rev_parse(&dest, "HEAD")
        .await
        .map_err(|_| anyhow::anyhow!("{} has no commits", target.clone_url))
}

fn git_dir(repo: &Path) -> String {
    format!("--git-dir={}", repo.display())
}

/// `rev-parse --verify --end-of-options <rev>`: fails (rather than echoing the
/// input back) on anything unborn or unknown.
async fn rev_parse(repo: &Path, rev: &str) -> anyhow::Result<String> {
    let dir = git_dir(repo);
    let out = exec::run_cmd(
        "git",
        &[&dir, "rev-parse", "--verify", "--end-of-options", rev],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await?;
    Ok(out.trim().to_string())
}

/// `git cat-file -t`: `tree`, `blob`, `commit` or `tag`.
async fn object_type(repo: &Path, id: &str) -> anyhow::Result<String> {
    let dir = git_dir(repo);
    let out = exec::run_cmd(
        "git",
        &[&dir, "cat-file", "-t", id],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await?;
    Ok(out.trim().to_string())
}

/// Fetch one local ref (or HEAD) into `dest_ref` in the mirror.
async fn fetch_into(
    mirror: &Path,
    from: &Path,
    source_ref: &str,
    dest_ref: &str,
) -> anyhow::Result<()> {
    let dir = git_dir(mirror);
    let refspec = format!("+{source_ref}:{dest_ref}");
    let source = from.to_string_lossy().into_owned();
    exec::run_cmd(
        "git",
        &[&dir, "fetch", "--no-tags", "--quiet", &source, &refspec],
        None,
        &[],
        Duration::from_secs(300),
    )
    .await
    .map(|_| ())
}

async fn drop_ref(repo: &Path, refname: &str) -> anyhow::Result<()> {
    let dir = git_dir(repo);
    exec::run_cmd(
        "git",
        &[&dir, "update-ref", "-d", refname],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await
    .map(|_| ())
}

/// One root commit of `tree` (no parent), authored and committed as `identity`.
/// `git commit-tree` with no `-p` is a root commit — the whole point of the
/// template import (A3).
async fn squash_root(
    mirror: &Path,
    tree: &str,
    message: &str,
    identity: &Identity,
) -> anyhow::Result<String> {
    let dir = git_dir(mirror);
    let out = exec::run_cmd(
        "git",
        &[&dir, "commit-tree", tree, "-m", message],
        None,
        &[
            ("GIT_AUTHOR_NAME", identity.name.as_str()),
            ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
            ("GIT_COMMITTER_NAME", identity.name.as_str()),
            ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
        ],
        Duration::from_secs(60),
    )
    .await?;
    Ok(out.trim().to_string())
}

/// On-disk size of a clone: `run_grouped` measures this on every poll and once
/// more when the child exits, which is what enforces the import cap.
fn dir_bytes(dir: &Path) -> std::io::Result<u64> {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(next)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> crate::testutil::TempDir {
        crate::testutil::TempDir::new("noite-import")
    }

    /// A delete stops the import and waits for it: the task's own end (the
    /// clone killed with its group) is what the delete can rely on before it
    /// purges the slug. Without the await, a late clone published
    /// `refs/heads/main` for a slug the delete had already freed.
    #[tokio::test]
    async fn cancel_and_wait_ends_the_attempt_before_it_returns() {
        let app_id = "sm-cancel-import";
        let key = import_key(app_id);
        let cancel = crate::host::cancel::CANCELS.register(&key);
        let token = cancel.clone();
        // Stands in for the import task: it only finishes when stopped.
        let task = tokio::spawn(async move {
            crate::host::cancel::with(token.clone(), token.cancelled()).await;
        });
        imports().insert(
            app_id.to_string(),
            ImportRun {
                cancel: cancel.clone(),
                task,
            },
        );

        assert!(
            imports().contains_key(app_id),
            "the attempt is running here"
        );
        assert!(cancel_and_wait(app_id).await, "the delete stops it");
        assert!(
            !imports().contains_key(app_id),
            "the attempt ended before the delete went on"
        );
        assert!(cancel.is_cancelled(), "the clone's token was tripped");
        assert!(
            !cancel_and_wait(app_id).await,
            "nothing left to stop the second time"
        );
    }

    /// One attempt per app: the slot check and the insert are one locked step,
    /// so two concurrent retries cannot both clone into the same mirror. The
    /// attempt's own end (the `finish` path) frees the app and leaves nothing
    /// behind.
    #[tokio::test]
    async fn a_second_import_attempt_is_refused_and_a_finished_one_frees_the_app() {
        let h = crate::api::tests::Harness::new().await;
        let app = h.seed_app("import-slot").await;
        // A closed local port: the clone fails at once, so the attempt ends
        // without any network.
        let source = GitSource {
            url: "https://127.0.0.1:1/owner/repo".to_string(),
            reference: None,
            squash: true,
            path: None,
            actor: crate::host::git_identity::Actor {
                user_id: "user_1".to_string(),
                name: "User One".to_string(),
            },
        };
        assert!(
            spawn(&h.state, app.clone(), source.clone()),
            "the first attempt starts"
        );
        assert!(
            !spawn(&h.state, app.clone(), source.clone()),
            "a second concurrent attempt must not start"
        );
        // Deterministic: this awaits the running task to its end.
        assert!(cancel_and_wait(&app.id).await);
        assert!(!imports().contains_key(&app.id));
        assert!(
            spawn(&h.state, app.clone(), source),
            "a finished attempt frees the app for Retry"
        );
        cancel_and_wait(&app.id).await;
        h.finish().await;
    }

    /// The task's own end releases its slot and its stop token: nothing is
    /// remembered per app after the attempt (the old claim left a `Done`
    /// entry forever).
    #[tokio::test]
    async fn an_attempt_that_ends_releases_its_slot_and_token() {
        let app_id = "sm-finish-import";
        let key = import_key(app_id);
        let cancel = crate::host::cancel::CANCELS.register(&key);
        let task = tokio::spawn(async {});
        imports().insert(
            app_id.to_string(),
            ImportRun {
                cancel: cancel.clone(),
                task,
            },
        );
        assert!(imports().contains_key(app_id));
        finish(app_id, &cancel);
        assert!(
            !imports().contains_key(app_id),
            "no entry survives the attempt"
        );
        assert_eq!(
            crate::host::cancel::CANCELS.cancel(&key),
            crate::host::cancel::CancelOutcome::Missing,
            "the stop token is released with it"
        );
    }

    /// The URL allowlist is the security boundary: only the exact GitHub https
    /// shape passes, and everything else is refused by name.
    #[test]
    fn url_allowlist() {
        let ok = [
            "https://github.com/octocat/Hello-World",
            "https://github.com/octocat/Hello-World.git",
            "https://github.com/ryuzcorp/noite-templates",
            "https://github.com/ryuzcorp/noite-template-ilha",
            "https://github.com/a/b_c.d-e",
            "https://GitHub.com/octocat/Hello-World",
            // Surrounding whitespace is a copy-paste artifact, never a bypass:
            // the URL is trimmed and then rebuilt from the parsed segments.
            "  https://github.com/octocat/Hello-World\n",
        ];
        for url in ok {
            assert!(github_url(url).is_ok(), "should accept {url}");
        }
        let target = github_url("https://github.com/octocat/Hello-World.git").expect("target");
        assert_eq!(target.owner, "octocat");
        assert_eq!(target.repo, "Hello-World");
        assert_eq!(
            target.clone_url,
            "https://github.com/octocat/Hello-World.git"
        );

        let rejected = [
            "http://github.com/octocat/Hello-World",
            "git://github.com/octocat/Hello-World",
            "ssh://git@github.com/octocat/Hello-World",
            "git@github.com:octocat/Hello-World.git",
            "file:///etc/passwd",
            "https://gitlab.com/octocat/Hello-World",
            "https://github.example.com/octocat/Hello-World",
            "https://github.com.evil.test/octocat/Hello-World",
            "https://evil.test/github.com/octocat/Hello-World",
            "https://user:pass@github.com/octocat/Hello-World",
            "https://github.com:8443/octocat/Hello-World",
            "https://github.com/octocat/Hello-World?ref=main",
            "https://github.com/octocat/Hello-World#main",
            "https://github.com/../Hello-World",
            "https://github.com/octocat/..",
            "https://github.com/-octocat/Hello-World",
            "https://github.com/octocat/-Hello-World",
            "https://github.com/octocat",
            "https://github.com/octocat/Hello-World/extra",
            "https://github.com//Hello-World",
            "https://github.com/octocat/",
            "https://github.com/octocat/Hello World",
            "github.com/octocat/Hello-World",
            "",
        ];
        for url in rejected {
            assert!(github_url(url).is_err(), "should reject {url}");
        }
    }

    #[test]
    fn ref_validation() {
        for reference in ["main", "v1.2.3", "release/1.x", "0123abc"] {
            assert!(import_ref(reference).is_ok(), "should accept {reference}");
        }
        for reference in [
            "",
            "-x",
            "main..dev",
            "main dev",
            "refs/heads/main/",
            "v1.lock",
            "@",
            "a@{1}",
            "back\\slash",
        ] {
            assert!(import_ref(reference).is_err(), "should reject {reference}");
        }
    }

    #[test]
    fn path_validation() {
        for (path, normalized) in [
            ("apps/web", "apps/web"),
            ("/packages/site/", "packages/site"),
            ("examples/hello-world", "examples/hello-world"),
            (".github", ".github"),
        ] {
            assert_eq!(import_path(path).as_deref(), Ok(normalized), "{path}");
        }
        for path in [
            "",
            "/",
            "-x",
            "a/../b",
            "./a",
            "a//b",
            ".git/hooks",
            "a\\b",
            "HEAD:a",
            "a^{tree}",
            "a~1",
            "a@{1}",
            "a/ b",
        ] {
            assert!(import_path(path).is_err(), "should reject {path:?}");
        }
    }

    /// A monorepo import commits one subdirectory's tree as the app's root;
    /// a folder that does not exist, or names a file, is a readable error.
    #[tokio::test]
    async fn a_path_import_roots_the_app_at_that_folder() {
        let guard = dir();
        let root = guard.path().to_path_buf();
        let upstream = root.join("upstream");
        std::fs::create_dir_all(upstream.join("apps/web/src")).expect("dirs");
        std::fs::write(upstream.join("README.md"), "monorepo").expect("write");
        std::fs::write(upstream.join("apps/web/package.json"), "{}").expect("write");
        std::fs::write(upstream.join("apps/web/src/index.js"), "1").expect("write");
        git_in(&upstream, &["init", "-b", "main"]).await;
        git_in(&upstream, &["add", "-A"]).await;
        git_in(&upstream, &["commit", "-m", "one"]).await;
        let mirror = root.join("mirror.git");
        crate::host::git_http::init_bare(&mirror)
            .await
            .expect("mirror");
        let target = ImportTarget {
            owner: "acme".into(),
            repo: "mono".into(),
            clone_url: format!("file://{}", upstream.display()),
        };
        let scratch = root.join("scratch");
        clone_scratch(&target, None, &scratch, Protocols { file: true })
            .await
            .expect("clone");
        fetch_into(&mirror, &scratch.join("upstream.git"), "HEAD", IMPORT_REF)
            .await
            .expect("fetch");
        let staged = rev_parse(&mirror, IMPORT_REF).await.expect("staged");

        let (tree, origin) = squash_tree(&mirror, &staged, &target, Some("apps/web"), "abc1234")
            .await
            .expect("subdir tree");
        assert_eq!(origin, "acme/mono/apps/web");
        let listing = git_in(
            &root,
            &[
                &format!("--git-dir={}", mirror.display()),
                "ls-tree",
                "-r",
                "--name-only",
                &tree,
            ],
        )
        .await;
        assert_eq!(
            listing.lines().collect::<Vec<_>>(),
            ["package.json", "src/index.js"]
        );

        for missing in ["apps/api", "README.md"] {
            let err = squash_tree(&mirror, &staged, &target, Some(missing), "abc1234")
                .await
                .expect_err("not a folder");
            assert_eq!(
                format!("{err:#}"),
                format!("folder {missing} not found in acme/mono@abc1234")
            );
        }
        drop(guard);
    }

    /// Run git in one directory with a fixed test identity (panics on failure).
    async fn git_in(cwd: &std::path::Path, args: &[&str]) -> String {
        exec::run_cmd(
            "git",
            args,
            Some(cwd),
            &[
                ("GIT_AUTHOR_NAME", "Up"),
                ("GIT_AUTHOR_EMAIL", "up@example.com"),
                ("GIT_COMMITTER_NAME", "Up"),
                ("GIT_COMMITTER_EMAIL", "up@example.com"),
            ],
            Duration::from_secs(60),
        )
        .await
        .unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
    }

    /// NOITE-IMPORT-001: the cap is enforced *while* the child runs — the group
    /// is killed the moment the work dir passes it, and the error comes back
    /// immediately (a kill that had missed the group would wait out `REAP`).
    #[tokio::test]
    async fn the_cap_kills_a_running_clone() {
        let guard = dir();
        let root = guard.path().to_path_buf();
        let started = std::time::Instant::now();
        let err = run_grouped(
            "sh",
            &[
                "-c".to_string(),
                "dd if=/dev/zero of=big bs=1M count=64 2>/dev/null; sleep 60".to_string(),
            ],
            &root,
            1024 * 1024,
            Duration::from_millis(20),
            Duration::from_secs(60),
        )
        .await
        .expect_err("over the cap");
        let message = format!("{err:#}");
        assert!(message.contains("cap"), "{message}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the group must be killed at once, took {:?}",
            started.elapsed()
        );
        drop(guard);
    }

    /// The cap is re-checked when the child exits, so a clone that finished
    /// before the first poll is refused too (the tiny-cap case).
    #[tokio::test]
    async fn the_cap_refuses_a_finished_clone() {
        let guard = dir();
        let root = guard.path().to_path_buf();
        let err = run_grouped(
            "sh",
            &[
                "-c".to_string(),
                "dd if=/dev/zero of=big bs=1M count=4 2>/dev/null".to_string(),
            ],
            &root,
            1024 * 1024,
            // Longer than the command: the first poll only returns when the
            // child exits, which lands in the post-exit check.
            Duration::from_secs(30),
            Duration::from_secs(60),
        )
        .await
        .expect_err("over the cap");
        let message = format!("{err:#}");
        assert!(message.contains("over the 1-MiB import cap"), "{message}");
        drop(guard);
    }

    /// NOITE-IMPORT-002: a timeout kills the whole process group, not just the
    /// direct child, so nothing keeps running after the import is given up on.
    #[tokio::test]
    async fn the_timeout_kills_the_process_group() {
        let guard = dir();
        let root = guard.path().to_path_buf();
        let started = std::time::Instant::now();
        let err = run_grouped(
            "sh",
            &["-c".to_string(), "sleep 60".to_string()],
            &root,
            MAX_IMPORT_BYTES,
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .await
        .expect_err("timed out");
        assert!(format!("{err:#}").contains("timed out"), "{err:#}");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "the group must be killed at once, took {:?}",
            started.elapsed()
        );
        drop(guard);
    }

    /// A3: the squash import lands exactly one root commit of the fetched tree,
    /// authored as the account's noreply identity. The seam is the clone's
    /// protocol set (a `file://` fixture repo), which the API path never
    /// enables.
    #[tokio::test]
    async fn squash_is_one_root_commit_with_the_noreply_identity() {
        let guard = dir();
        let root = guard.path().to_path_buf();
        let upstream = root.join("upstream");
        std::fs::create_dir_all(&upstream).expect("upstream");
        std::fs::write(upstream.join("index.html"), "hello").expect("write");
        git_in(&upstream, &["init", "-b", "main"]).await;
        git_in(&upstream, &["add", "-A"]).await;
        git_in(&upstream, &["commit", "-m", "one"]).await;
        std::fs::write(upstream.join("app.js"), "console.log(1)").expect("write");
        git_in(&upstream, &["add", "-A"]).await;
        git_in(&upstream, &["commit", "-m", "two"]).await;

        let target = ImportTarget {
            owner: "fixture".into(),
            repo: "fixture".into(),
            clone_url: format!("file://{}", upstream.display()),
        };
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = root.join("work").to_string_lossy().into_owned();
        // A0's bare-repo shape: HEAD points at main before anything is pushed.
        let mirror = root.join("mirror.git");
        crate::host::git_http::init_bare(&mirror)
            .await
            .expect("mirror");

        let upstream_sha = git_in(&upstream, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        let scratch = root.join("scratch");
        let cloned = clone_scratch(&target, None, &scratch, Protocols { file: true })
            .await
            .expect("clone");
        assert_eq!(cloned, upstream_sha);
        fetch_into(&mirror, &scratch.join("upstream.git"), "HEAD", IMPORT_REF)
            .await
            .expect("fetch");
        let tree = rev_parse(&mirror, &format!("{IMPORT_REF}^{{tree}}"))
            .await
            .expect("tree");
        let identity = git_identity::noreply(&cfg, "user-1", "Ryuz");
        let message = format!("Initial commit from fixture/fixture@{}", &upstream_sha[..7]);
        let squashed = squash_root(&mirror, &tree, &message, &identity)
            .await
            .expect("squash");
        // One commit, a root: the upstream history is collapsed.
        let parents = git_in(
            &root,
            &[
                &format!("--git-dir={}", mirror.display()),
                "log",
                "-1",
                "--format=%P",
                &squashed,
            ],
        )
        .await;
        assert!(parents.trim().is_empty(), "expected no parents: {parents}");
        let count = git_in(
            &root,
            &[
                &format!("--git-dir={}", mirror.display()),
                "rev-list",
                "--count",
                &squashed,
            ],
        )
        .await;
        assert_eq!(count.trim(), "1");
        // The tree is the upstream tip's tree, byte for byte.
        assert_eq!(
            rev_parse(&mirror, &format!("{squashed}^{{tree}}"))
                .await
                .expect("tree"),
            tree
        );
        // Identity and message: the account's noreply address, not upstream's.
        let log = git_in(
            &root,
            &[
                &format!("--git-dir={}", mirror.display()),
                "log",
                "-1",
                "--format=%an <%ae>|%cn <%ce>|%s",
                &squashed,
            ],
        )
        .await;
        let expected = format!("{} <{}>", identity.name, identity.email);
        assert_eq!(
            log.trim(),
            format!("{expected}|{expected}|{message}"),
            "{}",
            identity.email
        );
        assert_eq!(identity.email, "user-1@users.noreply.localhost");
        drop(guard);
    }
}
