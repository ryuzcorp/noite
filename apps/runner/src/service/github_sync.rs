//! Force sync with the GitHub origin ("Sync from GitHub").
//!
//! An app created by a GitHub import keeps its import source on the row. This
//! lane re-fetches that source's ref through the same hardened clone path and
//! validators the import uses, and makes the production branch's tree equal
//! to the origin's tree at its current tip by writing **one** new commit on
//! top of the current tip (message names the repo and the origin sha). Local
//! edits made in Noite are overwritten in the tree but stay in history, so
//! nothing is lost.
//!
//! Flow (all synchronous; a small repo syncs in seconds):
//! 1. Load the stored source; refuse an app that was not imported (400).
//! 2. Refuse while an import runs here (409) and while the branch is
//!    protected for the caller's role (409, same rule as a web commit).
//! 3. Clone the origin (size-capped, https-only, no redirects — the import's
//!    [`crate::host::import`] path) and resolve the tree to publish (the
//!    whole tree, or the imported subdirectory's tree).
//! 4. If the trees are already equal, it is a no-op answering `upToDate`
//!    (the last-synced sha is still recorded).
//! 5. If the branch holds commits since the last sync and the caller did not
//!    confirm, refuse with the count (409) — the UI turns that into its
//!    "will be overwritten in the tree; they stay in history" confirmation.
//! 6. Commit the origin tree on top of the current tip and move `main` with
//!    [`crate::host::forge::publish_ref`]'s compare-and-swap: a push that
//!    raced the sync keeps its tip and the sync is refused with "tip moved"
//!    instead of clobbering it. The move publishes exactly like a push, so
//!    the normal deploy pipeline, branch rules and environments apply.
//!
//! `file://` clones exist only behind [`crate::host::import::Protocols`]'s
//! test seam, which the REST path never enables.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::host::{exec, forge, git_identity, import};
use crate::models::{new_id, now_iso, App, AppSource, GitSource};
use crate::AppState;

use super::apps::app_or_404;

/// Temp ref the fetched origin is staged under in the push mirror. Separate
/// from the import's staging ref, so a sync can never collide with one; it is
/// deleted before the publish so it never reaches the manifest.
const SYNC_REF: &str = "refs/noite/sync";

/// Channel for the sync's `app_event` lines (best effort, like the import's).
const CHANNEL: &str = "sync";

/// What the Sync button needs before it asks: the stored origin, the last
/// synced sha, the current tip and how many Noite commits a sync would
/// overwrite in the tree. Computed locally — no clone, so no `upToDate`: the
/// sync answer itself says whether the origin moved.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GithubSyncStatus {
    pub imported: bool,
    pub owner: Option<String>,
    pub repo: Option<String>,
    #[serde(default, rename = "ref")]
    #[ts(optional)]
    pub reference: Option<String>,
    pub path: Option<String>,
    pub last_sync_sha: Option<String>,
    pub current_tip: Option<String>,
    pub noite_commits: u64,
}

/// The sync request body. `confirm` acknowledges overwriting the counted
/// Noite commits; `expectedTip` is the compare-and-set the status showed, so
/// a push that raced the confirmation is refused instead of being silently
/// built upon. `role` is the caller's app role for the protected-branch rule.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GithubSyncBody {
    #[serde(default)]
    #[ts(optional)]
    pub expected_tip: Option<String>,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    #[ts(optional)]
    pub role: Option<String>,
}

/// One new commit with the origin's tree, on top of the previous tip.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SyncedDetail {
    pub sha: String,
    pub origin_sha: String,
    pub noite_overwritten: u64,
}

/// The origin's tree already matches the branch: no commit, no deploy.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpToDateDetail {
    pub sha: String,
    pub origin_sha: String,
}

/// What a sync did, as the UI's button states read it: `synced` (new commit
/// + deploy), `upToDate` (no-op), or a 409 (`confirmRequired` count, `tip
/// moved`, import running, protected branch).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum GithubSyncOutcome {
    Synced(SyncedDetail),
    UpToDate(UpToDateDetail),
}

/// The stored import source, or a refusal for an app that was not imported.
/// Template apps carry the same Git source shape, so they sync too.
fn stored_source(app: &App) -> Result<GitSource, ApiError> {
    let Some(stored) = app.import_source.clone() else {
        return Err(ApiError::bad(
            "this app was not created from a GitHub import",
        ));
    };
    let source: AppSource = serde_json::from_str(&stored)
        .map_err(|e| ApiError::internal(format!("stored import source is unreadable: {e}")))?;
    match source {
        AppSource::Git(git) => Ok(git),
        AppSource::Blank => Err(ApiError::bad(
            "this app was not created from a GitHub import",
        )),
    }
}

/// Resolve the clone target: the hardened GitHub allowlist, or — only behind
/// the test seam — a `file://` fixture the tests clone instead of the network.
fn resolve_target(url: &str, protocols: import::Protocols) -> Result<import::ImportTarget, String> {
    if protocols.file && url.starts_with("file://") {
        if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err("file URL must not contain whitespace".to_string());
        }
        return Ok(import::ImportTarget {
            owner: "fixture".to_string(),
            repo: "fixture".to_string(),
            clone_url: url.to_string(),
        });
    }
    import::github_url(url)
}

/// `app_event` line for the sync feed (best effort: a lost event never fails
/// the sync itself).
async fn note(state: &AppState, app: &App, event: &str, description: &str) {
    let _ = crate::db::insert_app_event(
        &state.pool,
        &new_id(),
        &app.id,
        CHANNEL,
        event,
        description,
        "🔄",
        "{}",
        "",
        &now_iso(),
    )
    .await;
}

fn git_dir_arg(mirror: &Path) -> String {
    format!("--git-dir={}", mirror.display())
}

async fn current_tip(mirror: &Path) -> anyhow::Result<Option<String>> {
    Ok(crate::host::git_http::list_refs(mirror)
        .await?
        .get("refs/heads/main")
        .cloned())
}

async fn tree_of(mirror: &Path, rev: &str) -> anyhow::Result<String> {
    import::rev_parse(mirror, &format!("{rev}^{{tree}}")).await
}

/// How many commits on the branch the new tree would overwrite: the commits
/// since the last sync, or the whole history when nothing was recorded (or
/// the recorded sha is not an ancestor — a hand-moved branch). Never fails:
/// an unresolvable history counts everything rather than blocking the sync.
async fn local_commits(mirror: &Path, last_sync: Option<&str>, tip: &str) -> u64 {
    let dir = git_dir_arg(mirror);
    if let Some(last) = last_sync {
        let range = format!("{last}..{tip}");
        if let Ok(out) = exec::run_cmd(
            "git",
            &[&dir, "rev-list", "--count", &range],
            None,
            &[],
            GIT_TIMEOUT,
        )
        .await
        {
            if let Ok(n) = out.trim().parse::<u64>() {
                return n;
            }
        }
    }
    exec::run_cmd(
        "git",
        &[&dir, "rev-list", "--count", tip],
        None,
        &[],
        GIT_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|out| out.trim().parse::<u64>().ok())
    .unwrap_or(0)
}

const GIT_TIMEOUT: Duration = Duration::from_secs(60);

/// The sync status: the stored origin plus the local counts the confirmation
/// dialog shows. Reads the mirror; never clones.
pub async fn status(state: &AppState, id: &str) -> Result<GithubSyncStatus, ApiError> {
    let app = app_or_404(state, id).await?;
    let empty = || GithubSyncStatus {
        imported: false,
        owner: None,
        repo: None,
        reference: None,
        path: None,
        last_sync_sha: None,
        current_tip: None,
        noite_commits: 0,
    };
    let source = match stored_source(&app) {
        Ok(source) => source,
        Err(_) => return Ok(empty()),
    };
    // A stored source was validated at creation; a parse failure here only
    // hides the owner/repo, never the imported gate.
    let (owner, repo) = match import::github_url(&source.url) {
        Ok(target) => (Some(target.owner), Some(target.repo)),
        Err(_) => (None, None),
    };
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    let tip = current_tip(&bare).await.map_err(ApiError::from_anyhow)?;
    let noche = match &tip {
        Some(sha) => local_commits(&bare, app.last_sync_sha.as_deref(), sha).await,
        None => 0,
    };
    Ok(GithubSyncStatus {
        imported: true,
        owner,
        repo,
        reference: source.reference,
        path: source.path,
        last_sync_sha: app.last_sync_sha,
        current_tip: tip,
        noite_commits: noche,
    })
}

/// A sync that would overwrite Noite commits without `confirm`. Carried as a
/// typed error (like [`crate::host::forge::RefConflict]`), so the 409 survives
/// [`sync_error`]'s string mapping instead of collapsing into a 500.
#[derive(Debug)]
struct ConfirmRequired {
    count: u64,
}

impl std::fmt::Display for ConfirmRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let noun = if self.count == 1 { "commit" } else { "commits" };
        write!(
            f,
            "{} Noite {noun} will be overwritten in the tree; they stay in history. Retry the sync with confirm.",
            self.count
        )
    }
}

impl std::error::Error for ConfirmRequired {}

/// Map a sync failure onto the runner's error vocabulary: an unknown ref is a
/// 400, a lost compare-and-swap or an unconfirmed overwrite a 409, anything
/// else a 500.
fn sync_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if e.downcast_ref::<ConfirmRequired>().is_some() || msg.contains("tip moved") {
        ApiError::conflict(msg)
    } else if msg.contains("not found")
        || msg.contains("unknown revision")
        || msg.contains("unknown field")
        || msg.contains("Could not find")
    {
        ApiError::bad(msg)
    } else {
        ApiError::internal(msg)
    }
}

pub async fn sync(
    state: &AppState,
    id: &str,
    body: &GithubSyncBody,
) -> Result<GithubSyncOutcome, ApiError> {
    sync_with(state, id, body, import::Protocols::default()).await
}

/// [`sync`] with the clone's protocol set: the tests pass `file: true` so a
/// fixture repo stands in for github.com. The REST path never does.
pub(crate) async fn sync_with(
    state: &AppState,
    id: &str,
    body: &GithubSyncBody,
    protocols: import::Protocols,
) -> Result<GithubSyncOutcome, ApiError> {
    if super::apps::deleting(id) {
        return Err(ApiError::conflict("the app is being deleted"));
    }
    let app = app_or_404(state, id).await?;
    let source = stored_source(&app)?;
    if import::is_running(&app.id) {
        return Err(ApiError::conflict("an import is already running"));
    }
    let target = resolve_target(&source.url, protocols).map_err(ApiError::bad)?;
    if let Some(reference) = &source.reference {
        import::import_ref(reference).map_err(ApiError::bad)?;
    }
    if let Some(path) = &source.path {
        import::import_path(path).map_err(ApiError::bad)?;
    }
    // `require_pr` keeps the push role off `main`, exactly like a browser
    // commit: a sync writes a commit there, so it needs the same admin gate.
    if body.role.as_deref() != Some("admin") {
        let rules = crate::db::prs::branch_rules(&state.pool, &app.id)
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
        if rules.require_pr != 0 {
            return Err(ApiError::conflict(
                "refs/heads/main is protected; a sync needs an admin while pull requests are required",
            ));
        }
    }
    // Short locked phase: make sure the mirrors exist, read the tip the
    // commit and the CAS below build on, and fail a stale confirmation fast
    // — before the clone. The lock is dropped before the network step, so a
    // slow origin never stalls pushes; the publish's compare-and-swap is the
    // race guard.
    let tip = {
        let _push = state.wal.lock(&app.slug).await;
        crate::host::git_http::init_repos(state, &app.slug)
            .await
            .map_err(ApiError::from_anyhow)?;
        let bare = state
            .wal
            .ensure_synced_locked(&app.slug)
            .await
            .map_err(|e| ApiError::internal(format!("{e:#}")))?;
        current_tip(&bare).await.map_err(ApiError::from_anyhow)?
    };
    if let (Some(wanted), Some(have)) = (body.expected_tip.as_deref(), tip.as_deref()) {
        if wanted != have {
            return Err(ApiError::conflict(
                "the branch moved during the sync; retry",
            ));
        }
    }
    // The clone is the long step: the row may have been deleted (or renamed)
    // while it ran, and the slug may already belong to another app.
    let scratch = exec::work_root(&state.config)
        .join("github-sync")
        .join(format!("{}-{}", app.slug, new_id()));
    tokio::fs::create_dir_all(&scratch)
        .await
        .map_err(|e| ApiError::internal(format!("could not make the sync scratch dir: {e}")))?;
    let outcome = sync_into(
        state,
        &app,
        &source,
        &target,
        tip.as_deref(),
        body.confirm,
        &scratch,
        protocols,
    )
    .await;
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    outcome.map_err(sync_error)
}

/// The body of [`sync_with`] with the scratch dir already made, so the
/// cleanup above runs on every path.
#[allow(clippy::too_many_arguments)]
async fn sync_into(
    state: &AppState,
    app: &App,
    source: &GitSource,
    target: &import::ImportTarget,
    tip: Option<&str>,
    confirm: bool,
    scratch: &Path,
    protocols: import::Protocols,
) -> anyhow::Result<GithubSyncOutcome> {
    let origin_sha =
        import::clone_scratch(target, source.reference.as_deref(), scratch, protocols).await?;
    import::ensure_app_target(state, app).await?;
    let mirror = state.wal.ensure_synced(&app.slug).await?;
    // Objects only: the temp ref is the fetch target and `publish_ref` does
    // the one visible ref move below, exactly like the import.
    import::fetch_into(&mirror, &scratch.join("upstream.git"), "HEAD", SYNC_REF).await?;
    let staged = import::rev_parse(&mirror, SYNC_REF).await?;
    let subdir = source
        .path
        .as_deref()
        .map(import::import_path)
        .transpose()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let origin_tree = if source.squash || subdir.is_some() {
        let short = &origin_sha[..origin_sha.len().min(7)];
        match import::squash_tree(&mirror, &staged, target, subdir.as_deref(), short).await {
            Ok((tree, _)) => tree,
            Err(e) => {
                import::drop_ref(&mirror, SYNC_REF).await?;
                return Err(e);
            }
        }
    } else {
        tree_of(&mirror, &staged).await?
    };
    let current_tree = match tip {
        Some(sha) => Some(tree_of(&mirror, sha).await?),
        None => None,
    };
    if current_tree.as_deref() == Some(origin_tree.as_str()) {
        import::drop_ref(&mirror, SYNC_REF).await?;
        // Still the latest observation: record it, best effort.
        if let Err(e) = crate::db::set_last_sync_sha(&state.pool, &app.id, &origin_sha).await {
            tracing::warn!(app_id = %app.id, error = %format!("{e:#}"), "sync last-sync record");
        }
        note(
            state,
            app,
            "GitHub sync",
            &format!("already up to date at {origin_sha:.7}"),
        )
        .await;
        let sha = tip.unwrap_or_default().to_string();
        return Ok(GithubSyncOutcome::UpToDate(UpToDateDetail {
            sha,
            origin_sha,
        }));
    }
    let noche = match tip {
        Some(sha) => local_commits(&mirror, app.last_sync_sha.as_deref(), sha).await,
        None => 0,
    };
    if noche > 0 && !confirm {
        import::drop_ref(&mirror, SYNC_REF).await?;
        return Err(ConfirmRequired { count: noche }.into());
    }
    let short = &origin_sha[..origin_sha.len().min(7)];
    let origin_name = match &subdir {
        Some(path) => format!("{}/{}/{path}", target.owner, target.repo),
        None => format!("{}/{}", target.owner, target.repo),
    };
    let message = format!("Sync from {origin_name}@{short}");
    let identity = git_identity::noreply(&state.config, &source.actor.user_id, &source.actor.name);
    let dir = git_dir_arg(&mirror);
    let parent = tip.map(|sha| format!("-p{sha}"));
    let mut args: Vec<&str> = vec![&dir, "commit-tree", &origin_tree];
    if let Some(parent) = parent.as_deref() {
        args.push(parent);
    }
    args.extend(["-m", &message]);
    let new_sha = exec::run_cmd(
        "git",
        &args,
        None,
        &[
            ("GIT_AUTHOR_NAME", identity.name.as_str()),
            ("GIT_AUTHOR_EMAIL", identity.email.as_str()),
            ("GIT_COMMITTER_NAME", identity.name.as_str()),
            ("GIT_COMMITTER_EMAIL", identity.email.as_str()),
        ],
        GIT_TIMEOUT,
    )
    .await
    .map(|out| out.trim().to_string())?;
    import::drop_ref(&mirror, SYNC_REF).await?;
    // Compare-and-swap on the branch tip: a push that raced the sync wins and
    // this move is refused with "tip moved" instead of losing the push.
    forge::publish_ref(state, app, forge::DEFAULT_BRANCH, tip, Some(&new_sha)).await?;
    if let Err(e) = crate::db::set_last_sync_sha(&state.pool, &app.id, &origin_sha).await {
        tracing::warn!(app_id = %app.id, error = %format!("{e:#}"), "sync last-sync record");
    }
    // A sync is a head move like any other: keep open PRs pointing at the
    // new sha (best-effort — the commit itself already landed).
    if let Err(e) =
        crate::host::prs::on_branch_moved(state, &app.id, forge::DEFAULT_BRANCH, &new_sha).await
    {
        tracing::warn!(error = %format!("{e:#}"), "pr head sync");
    }
    note(
        state,
        app,
        "GitHub sync",
        &format!("synced to {origin_name}@{short} ({noche} overwritten)"),
    )
    .await;
    Ok(GithubSyncOutcome::Synced(SyncedDetail {
        sha: new_sha,
        origin_sha,
        noite_overwritten: noche,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::Arc;
    use tower::ServiceExt;

    /// The API harness with a stateful S3 stub: a sync publishes tip bundles
    /// and the manifest through the same PUT/HEAD path production uses, which
    /// the shared harness's LIST-only stub refuses.
    ///
    /// Everything else mirrors [`crate::api::tests::Harness`].
    struct SyncHarness {
        router: axum::Router,
        state: AppState,
        dir: PathBuf,
    }

    impl SyncHarness {
        async fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("noite-sync-{}", new_id()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let (s3, _objects) = crate::testutil::spawn_stateful_s3_stub().await;
            let mut cfg = crate::config::config_for_tests();
            cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
            cfg.s3_endpoint = s3.clone();
            cfg.s3_public_endpoint = s3;
            cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
            cfg.caddyfile_path = dir.join("Caddyfile").to_string_lossy().into_owned();
            cfg.caddy_access_log = dir.join("access.log").to_string_lossy().into_owned();
            let config = Arc::new(cfg);
            let pool = crate::db::connect(&config.database_url)
                .await
                .expect("connect db");
            let (tip_tx, _tip_rx) = crate::host::tips::channel();
            let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
            let state = AppState {
                pool,
                config: config.clone(),
                procs: crate::host::supervisor::new_procs(),
                logs: crate::host::logs::new_state(),
                deploying: crate::host::deploy::new_deploying(),
                log_notify,
                wal: crate::host::git_store::build_wal(&config),
                tip_tx,
                ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                isolation: Arc::new(tokio::sync::RwLock::new(
                    crate::host::isolation::IsolationStatus::default(),
                )),
                state_sync: crate::host::state::StateSync::new(),
                dns: std::sync::Arc::new(crate::dns::FakeResolver::default()),
                bucket_ok: Arc::new(tokio::sync::RwLock::new((
                    true,
                    String::new(),
                    std::time::Instant::now(),
                ))),
                started_at: chrono::Utc::now(),
                source_maps: Default::default(),
                control_boot: Default::default(),
            };
            let router = crate::api::router::router(state.clone());
            Self { router, state, dir }
        }

        async fn seed_app(&self, slug: &str) -> App {
            crate::db::create_app(
                &self.state.pool,
                &self.state.config,
                crate::db::NewApp {
                    name: slug,
                    slug,
                    user_id: "local",
                    subdomain: &format!("{slug}.localhost"),
                    listen: 30000,
                    internal: 30001,
                },
            )
            .await
            .expect("seed app")
        }

        async fn rest(&self, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
            let mut builder = Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", "Bearer test-token");
            let body = match body {
                Some(value) => {
                    builder = builder.header("content-type", "application/json");
                    Body::from(value.to_string())
                }
                None => Body::empty(),
            };
            let request = builder.body(body).expect("build request");
            let response = self
                .router
                .clone()
                .oneshot(request)
                .await
                .expect("router call");
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("read body");
            let value = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes)
                    .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            };
            (status, value)
        }

        async fn finish(&self) {
            self.state.pool.clone().close().await;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Drop for SyncHarness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn git(cwd: &Path, args: &[&str]) -> String {
        crate::host::exec::run_cmd(
            "git",
            args,
            Some(cwd),
            &[
                ("GIT_AUTHOR_NAME", "Test"),
                ("GIT_AUTHOR_EMAIL", "test@example.com"),
                ("GIT_COMMITTER_NAME", "Test"),
                ("GIT_COMMITTER_EMAIL", "test@example.com"),
            ],
            Duration::from_secs(60),
        )
        .await
        .unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
    }

    fn file_protocols() -> import::Protocols {
        import::Protocols { file: true }
    }

    /// A fixture "GitHub origin": a plain repo with one commit. Callers add
    /// commits to move the origin, exactly like pushing upstream.
    async fn fixture(dir: &Path, name: &str, body: &str) -> PathBuf {
        let upstream = dir.join(name);
        std::fs::create_dir_all(&upstream).expect("dirs");
        std::fs::write(upstream.join("index.html"), body).expect("write");
        git(&upstream, &["init", "-b", "main"]).await;
        git(&upstream, &["add", "-A"]).await;
        git(&upstream, &["commit", "-m", "one"]).await;
        upstream
    }

    async fn commit_all(upstream: &Path, body: &str, message: &str) {
        std::fs::write(upstream.join("index.html"), body).expect("write");
        git(upstream, &["add", "-A"]).await;
        git(upstream, &["commit", "-m", message]).await;
    }

    fn test_actor() -> git_identity::Actor {
        git_identity::Actor {
            user_id: "user_1".to_string(),
            name: "User One".to_string(),
        }
    }

    async fn seed_imported(h: &SyncHarness, slug: &str, upstream: &Path) -> App {
        let app = h.seed_app(slug).await;
        let source = AppSource::Git(GitSource {
            url: format!("file://{}", upstream.display()),
            reference: None,
            squash: false,
            path: None,
            actor: test_actor(),
        });
        let stored = serde_json::to_string(&source).expect("source json");
        crate::db::set_app_import_source(&h.state.pool, &app.id, Some(&stored))
            .await
            .expect("store source");
        app_or_404(&h.state, &app.id).await.expect("reload")
    }

    fn confirm(role: Option<&str>) -> GithubSyncBody {
        GithubSyncBody {
            expected_tip: None,
            confirm: true,
            role: role.map(str::to_string),
        }
    }

    async fn mirror_of(state: &AppState, app: &App) -> PathBuf {
        let bare = forge::read_mirror(state, &app.slug).await.expect("mirror");
        bare
    }

    async fn rev_list_count(mirror: &Path, rev: &str) -> u64 {
        let dir = git_dir_arg(mirror);
        exec::run_cmd(
            "git",
            &[&dir, "rev-list", "--count", rev],
            None,
            &[],
            GIT_TIMEOUT,
        )
        .await
        .expect("count")
        .trim()
        .parse()
        .expect("number")
    }

    async fn tree_rev(mirror: &Path, rev: &str) -> String {
        tree_of(mirror, rev).await.expect("tree")
    }

    /// A sync to a changed origin writes exactly one commit with the origin's
    /// tree, on top of the previous tip, and moves `main` to it — the move
    /// that publishes (bundles + manifest + TipNotify) and starts the deploy.
    #[tokio::test]
    async fn sync_to_a_changed_origin_writes_one_commit_with_the_origin_tree() {
        let h = SyncHarness::new().await;
        let upstream = fixture(&h.dir, "upstream", "v1").await;
        let app = seed_imported(&h, "sync-changed", &upstream).await;

        let first = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("first sync");
        let GithubSyncOutcome::Synced(first) = first else {
            panic!("a fresh app always syncs, got {first:?}");
        };
        let mirror = mirror_of(&h.state, &app).await;
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 1);
        assert_eq!(
            tree_rev(&mirror, "refs/heads/main").await,
            tree_rev(&mirror, &first.sha).await
        );

        commit_all(&upstream, "v2", "two").await;
        let origin_v2 = git(&upstream, &["rev-parse", "HEAD"]).await;
        let second = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("second sync");
        let GithubSyncOutcome::Synced(second) = second else {
            panic!("a moved origin syncs, got {second:?}");
        };
        assert_eq!(second.origin_sha, origin_v2.trim());
        // Exactly one new commit, on top of the previous tip, with the
        // origin's tree — and the message names the repo and the origin sha.
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 2);
        let dir = git_dir_arg(&mirror);
        let parent = exec::run_cmd(
            "git",
            &[&dir, "rev-parse", &format!("{}^", second.sha)],
            None,
            &[],
            GIT_TIMEOUT,
        )
        .await
        .expect("parent");
        assert_eq!(parent.trim(), first.sha);
        assert_eq!(
            tree_rev(&mirror, &second.sha).await,
            tree_rev(&mirror, origin_v2.trim()).await
        );
        let subject = exec::run_cmd(
            "git",
            &[&dir, "log", "-1", "--format=%s", &second.sha],
            None,
            &[],
            GIT_TIMEOUT,
        )
        .await
        .expect("subject");
        assert!(
            subject.trim().starts_with("Sync from fixture/fixture@"),
            "message names the repo and sha: {subject}"
        );
        // The publish moved `main` to the new commit: the same move a push
        // makes, which is what starts the deploy.
        let tip = current_tip(&mirror).await.expect("tip").expect("main");
        assert_eq!(tip, second.sha);
        // The origin sha is recorded for the next confirmation count.
        let row = app_or_404(&h.state, &app.id).await.expect("reload");
        assert_eq!(row.last_sync_sha.as_deref(), Some(origin_v2.trim()));
        h.finish().await;
    }

    /// An unchanged origin is a no-op: no commit, no deploy, same tip.
    #[tokio::test]
    async fn sync_to_an_unchanged_origin_is_a_no_op() {
        let h = SyncHarness::new().await;
        let upstream = fixture(&h.dir, "upstream", "v1").await;
        let app = seed_imported(&h, "sync-clean", &upstream).await;

        let first = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("first sync");
        let GithubSyncOutcome::Synced(first) = first else {
            panic!("a fresh app always syncs, got {first:?}");
        };
        let mirror = mirror_of(&h.state, &app).await;
        let again = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("second sync");
        let GithubSyncOutcome::UpToDate(again) = again else {
            panic!("an unchanged origin is up to date, got {again:?}");
        };
        assert_eq!(again.sha, first.sha);
        assert_eq!(again.origin_sha, first.origin_sha);
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 1);
        h.finish().await;
    }

    /// An app that was not created from an import is refused, without cloning.
    #[tokio::test]
    async fn sync_refuses_an_app_that_was_not_imported() {
        let h = SyncHarness::new().await;
        let app = h.seed_app("sync-blank").await;
        let err = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect_err("a blank app has no origin");
        assert!(matches!(err, ApiError::BadRequest(_)), "{err:?}");
        assert!(
            format!("{err:?}").contains("not created from a GitHub import"),
            "{err:?}"
        );
        // The REST surface answers the same refusal.
        let (status, _) = h
            .rest(
                "POST",
                &format!("/v1/apps/{}/sync-from-github", app.id),
                Some(json!({})),
            )
            .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        h.finish().await;
    }

    /// A sync that raced a push is refused rather than clobbering it: the
    /// confirmation read tip T1, the push moved to T2, and the sync's
    /// compare-and-set keeps T2's tree and writes nothing.
    #[tokio::test]
    async fn sync_racing_a_push_is_refused_and_writes_nothing() {
        let h = SyncHarness::new().await;
        let upstream = fixture(&h.dir, "upstream", "v1").await;
        let app = seed_imported(&h, "sync-race", &upstream).await;
        let first = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("first sync");
        let GithubSyncOutcome::Synced(first) = first else {
            panic!("a fresh app always syncs, got {first:?}");
        };

        // The push wins: a web commit on top of the synced tip.
        let pushed = crate::host::web_commit::web_commit(
            &h.state,
            &app,
            &git_identity::noreply(&h.state.config, "user_1", "User One"),
            "push wins",
            crate::host::web_commit::WebChanges {
                files: &[crate::host::web_commit::WebFile {
                    path: "pushed.txt".to_string(),
                    content: crate::host::web_commit::WebContent::Text("push".to_string()),
                }],
                moves: &[],
                deletes: &[],
            },
            Some("main"),
            None,
            None,
        )
        .await
        .expect("push");
        assert_ne!(pushed, first.sha);

        // The stale confirmation (read at `first.sha`) must not build on it.
        commit_all(&upstream, "v2", "two").await;
        let body = GithubSyncBody {
            expected_tip: Some(first.sha.clone()),
            confirm: true,
            role: None,
        };
        let err = sync_with(&h.state, &app.id, &body, file_protocols())
            .await
            .expect_err("a moved branch refuses the stale sync");
        assert!(matches!(err, ApiError::Conflict(_)), "{err:?}");
        assert!(format!("{err:?}").contains("moved"), "{err:?}");

        // Nothing was written: the tip is still the push, with its tree.
        let mirror = mirror_of(&h.state, &app).await;
        let tip = current_tip(&mirror).await.expect("tip").expect("main");
        assert_eq!(tip, pushed);
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 2);
        h.finish().await;
    }

    /// Without confirmation, a sync that would overwrite Noite commits names
    /// the count and writes nothing; with it, the sync lands.
    #[tokio::test]
    async fn sync_without_confirmation_names_the_overwritten_commits() {
        let h = SyncHarness::new().await;
        let upstream = fixture(&h.dir, "upstream", "v1").await;
        let app = seed_imported(&h, "sync-confirm", &upstream).await;
        let first = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("first sync");
        assert!(matches!(first, GithubSyncOutcome::Synced(_)));

        commit_all(&upstream, "v2", "two").await;
        let body = GithubSyncBody {
            expected_tip: None,
            confirm: false,
            role: None,
        };
        let err = sync_with(&h.state, &app.id, &body, file_protocols())
            .await
            .expect_err("unconfirmed overwrite is refused");
        assert!(matches!(err, ApiError::Conflict(_)), "{err:?}");
        let text = format!("{err:?}");
        assert!(
            text.contains("will be overwritten in the tree; they stay in history"),
            "{text}"
        );

        let mirror = mirror_of(&h.state, &app).await;
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 1);

        let landed = sync_with(&h.state, &app.id, &confirm(None), file_protocols())
            .await
            .expect("confirmed sync");
        let GithubSyncOutcome::Synced(landed) = landed else {
            panic!("a confirmed sync lands, got {landed:?}");
        };
        assert_eq!(landed.noite_overwritten, 1);
        assert_eq!(rev_list_count(&mirror, "refs/heads/main").await, 2);
        h.finish().await;
    }

    /// A protected branch keeps the push role out of the sync, like a commit.
    #[tokio::test]
    async fn sync_to_a_protected_branch_needs_an_admin() {
        let h = SyncHarness::new().await;
        let upstream = fixture(&h.dir, "upstream", "v1").await;
        let app = seed_imported(&h, "sync-protected", &upstream).await;
        crate::db::prs::set_branch_rules(&h.state.pool, &app.id, true, 1)
            .await
            .expect("protect main");

        let err = sync_with(&h.state, &app.id, &confirm(Some("push")), file_protocols())
            .await
            .expect_err("push cannot sync a protected branch");
        assert!(matches!(err, ApiError::Conflict(_)), "{err:?}");

        let ok = sync_with(&h.state, &app.id, &confirm(Some("admin")), file_protocols())
            .await
            .expect("an admin syncs");
        assert!(matches!(ok, GithubSyncOutcome::Synced(_)));
        h.finish().await;
    }
}
