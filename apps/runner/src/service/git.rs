//! Git remote info + forge operations (branch/history/compare reads and the
//! branch mutations) for the control UI. Reads run on the push mirror, which
//! holds every pushed branch; branch create/delete go through
//! [`forge::publish_ref`], so they publish (bundles + manifest) exactly like
//! a push and a deleted branch leaves the manifest.

use std::path::PathBuf;

use serde::Serialize;
use ts_rs::TS;

use crate::api_error::ApiError;
use crate::host::forge::{self, GitBranch, GitCommitDetail, GitCompare, GitLog, GitRefs};
use crate::host::git_http::list_refs;
use crate::models::App;
use crate::AppState;

use super::apps::app_or_404;

/// Clone/browse coordinates. `url` is the stock remote; `s3Remote` is the
/// internal layout (debug).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitRemote {
    pub url: String,
    pub username: String,
    pub s3_remote: String,
    pub endpoint: String,
    pub bucket: String,
    pub prefix: String,
}

pub async fn remote(state: &AppState, id: &str) -> Result<GitRemote, ApiError> {
    let app = app_or_404(state, id).await?;
    Ok(GitRemote {
        url: state.config.git_http_url(&app.slug),
        username: "git".into(),
        s3_remote: state.config.s3_git_remote(&app.slug),
        endpoint: state.config.s3_public_endpoint.clone(),
        bucket: state.config.s3_bucket.clone(),
        prefix: app.git_prefix,
    })
}

/// The forge's error vocabulary: an unknown ref is a 404, a malformed one a
/// 400, a lost compare-and-swap a 409.
fn forge_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("invalid ref") || msg.contains("invalid branch name") {
        ApiError::bad(msg)
    } else if msg.contains("tip moved") {
        ApiError::conflict(msg)
    } else {
        ApiError::internal(msg)
    }
}

/// The app plus its manifest-synced push mirror.
async fn app_repo(state: &AppState, id: &str) -> Result<(App, PathBuf), ApiError> {
    let app = app_or_404(state, id).await?;
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(ApiError::from_anyhow)?;
    Ok((app, bare))
}

/// Every branch, with distance from `main` and the deployed sha.
pub async fn refs(state: &AppState, id: &str) -> Result<GitRefs, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    forge::refs(&bare, app.last_deploy_sha.as_deref())
        .await
        .map_err(forge_error)
}

/// One page of history, optionally for a single file.
pub async fn log(
    state: &AppState,
    id: &str,
    reference: Option<&str>,
    path: Option<&str>,
    skip: Option<i64>,
    limit: Option<i64>,
) -> Result<GitLog, ApiError> {
    let (_app, bare) = app_repo(state, id).await?;
    let path = match path {
        Some(path) if !crate::host::source::valid_path(path) => {
            return Err(ApiError::bad("invalid path"));
        }
        other => other,
    };
    forge::log(&bare, reference, path, skip.unwrap_or(0), limit)
        .await
        .map_err(forge_error)
}

/// One commit's metadata, body, files and patch.
pub async fn commit(state: &AppState, id: &str, sha: &str) -> Result<GitCommitDetail, ApiError> {
    let (_app, bare) = app_repo(state, id).await?;
    forge::commit_detail(&bare, sha).await.map_err(forge_error)
}

/// `base..head` plus whether a squash merge of `head` into `base` is clean.
pub async fn compare(
    state: &AppState,
    id: &str,
    base: &str,
    head: &str,
) -> Result<GitCompare, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    forge::compare(&state.config, &app.slug, &bare, base, head)
        .await
        .map_err(forge_error)
}

/// Create a branch at `from`. An existing branch is a 409.
pub async fn branch_create(
    state: &AppState,
    id: &str,
    name: &str,
    from: &str,
) -> Result<GitBranch, ApiError> {
    // A caller-supplied name, never a full ref: `refs/…` would be stored as
    // `refs/heads/refs/…`, shadowing the runner's reserved namespaces.
    if !forge::valid_user_branch_name(name) {
        return Err(ApiError::bad(format!("invalid branch name {name:?}")));
    }
    // `from` may be a branch, a tag or a sha; `resolve_user_ref` refuses the
    // runner's own namespaces, so a hidden workspace preview ref cannot start
    // an advertised branch (and publish another collaborator's snapshot).
    let (app, bare) = app_repo(state, id).await?;
    let sha = forge::resolve_user_ref(&bare, from)
        .await
        .map_err(forge_error)?;
    forge::publish_ref(state, &app, name, None, Some(&sha))
        .await
        .map_err(forge_error)?;
    if let Err(e) = crate::host::prs::on_branch_moved(state, &app.id, name, &sha).await {
        tracing::warn!(error = %format!("{e:#}"), "pr head sync");
    }
    forge::refs(&bare, app.last_deploy_sha.as_deref())
        .await
        .map_err(forge_error)?
        .branches
        .into_iter()
        .find(|branch| branch.name == name)
        .ok_or_else(|| ApiError::internal("branch missing after create"))
}

/// Delete a branch. Refuses `main` (400); an unknown branch is a 404 — unless
/// its name is itself `refs/…`-shaped, which is a 400. A branch already stored
/// under such a name (written before the validator) still deletes, so a repo
/// can be cleaned up; reads of it keep working through the same exact ref.
pub async fn branch_delete(state: &AppState, id: &str, name: &str) -> Result<(), ApiError> {
    if name == forge::DEFAULT_BRANCH {
        return Err(ApiError::bad("cannot delete the default branch"));
    }
    let (app, bare) = app_repo(state, id).await?;
    let refname = format!("refs/heads/{name}");
    let refs = list_refs(&bare).await.map_err(ApiError::from_anyhow)?;
    let Some(old) = refs.get(&refname).cloned() else {
        if !forge::valid_user_branch_name(name) {
            return Err(ApiError::bad(format!("invalid branch name {name:?}")));
        }
        return Err(ApiError::not_found(format!("branch {name:?} not found")));
    };
    forge::publish_ref(state, &app, name, Some(&old), None)
        .await
        .map_err(forge_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    async fn git(dir: &Path, args: &[&str]) -> String {
        crate::host::exec::run_cmd(
            "git",
            args,
            Some(dir),
            &[
                ("GIT_AUTHOR_NAME", "Test"),
                ("GIT_AUTHOR_EMAIL", "test@example.com"),
                ("GIT_COMMITTER_NAME", "Test"),
                ("GIT_COMMITTER_EMAIL", "test@example.com"),
            ],
            std::time::Duration::from_secs(30),
        )
        .await
        .unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
    }

    struct Harness {
        state: AppState,
        app: App,
        dir: PathBuf,
        _tip_rx: crate::host::tips::TipReceiver,
    }

    impl Harness {
        async fn new(slug: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("noite-git-branches-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let (s3, _objects) = crate::testutil::spawn_stateful_s3_stub().await;
            let mut cfg = crate::config::config_for_tests();
            cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
            cfg.s3_endpoint = s3.clone();
            cfg.s3_public_endpoint = s3;
            cfg.base_domain = "noite.test".to_string();
            cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
            let config = Arc::new(cfg);
            let pool = crate::db::connect(&config.database_url)
                .await
                .expect("connect db");
            let (tip_tx, tip_rx) = crate::host::tips::channel();
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
                dns: Arc::new(crate::dns::FakeResolver::default()),
                bucket_ok: Arc::new(tokio::sync::RwLock::new((
                    true,
                    String::new(),
                    std::time::Instant::now(),
                ))),
                started_at: chrono::Utc::now(),
                source_maps: Default::default(),
                control_boot: Default::default(),
            };
            let app = crate::db::create_app(
                &state.pool,
                &config,
                crate::db::NewApp {
                    name: slug,
                    slug,
                    user_id: "user_owner",
                    subdomain: &format!("{slug}.localhost"),
                    listen: 0,
                    internal: 0,
                },
            )
            .await
            .expect("app row");
            Self {
                state,
                app,
                dir,
                _tip_rx: tip_rx,
            }
        }

        /// A bare mirror holding one commit on `main`, published like a push.
        async fn seed_main(&self) -> String {
            let bare = crate::host::git_http::http_bare(&self.state.config, &self.app.slug);
            let root = crate::host::exec::work_root(&self.state.config);
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
            let work = self.dir.join("scratch");
            std::fs::create_dir_all(&work).expect("work dir");
            git(&work, &["init", "-q", "--initial-branch=main", "."]).await;
            std::fs::write(work.join("a.txt"), "a\n").expect("write");
            git(&work, &["add", "-A"]).await;
            git(&work, &["commit", "-qm", "init"]).await;
            let sha = git(&work, &["rev-parse", "HEAD"]).await.trim().to_string();
            git(
                &work,
                &[
                    "push",
                    "-q",
                    bare.to_str().expect("mirror path"),
                    "+refs/heads/main:refs/heads/main",
                ],
            )
            .await;
            sha
        }

        async fn finish(self) {
            self.state.pool.close().await;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn commit_body(branch: &str) -> super::super::source::SourceCommitBody {
        super::super::source::SourceCommitBody {
            actor: crate::host::git_identity::Actor {
                user_id: "user_1".into(),
                name: "Ada".into(),
            },
            files: vec![super::super::source::SourceCommitFile {
                path: "web.txt".into(),
                content: "hello\n".into(),
                encoding: None,
            }],
            moves: vec![],
            deletes: vec![],
            message: "web edit".into(),
            branch: Some(branch.into()),
            from_sha: None,
            expected_tip: None,
            role: Some("admin".into()),
        }
    }

    /// A caller-supplied `refs/…` name must not become a branch: it would be
    /// stored as `refs/heads/refs/…`, shadowing the reserved namespaces.
    #[tokio::test]
    async fn branch_create_refuses_a_refs_shaped_name() {
        let h = Harness::new("refs-create").await;
        h.seed_main().await;
        for name in ["refs/previews/x", "refs/notes/x", "refs/heads/main"] {
            let err = branch_create(&h.state, &h.app.id, name, "main")
                .await
                .expect_err("refs-shaped branch create must fail");
            assert!(
                format!("{err:?}").contains("invalid branch name"),
                "unexpected error for {name:?}: {err:?}"
            );
        }
        let refs = list_refs(&crate::host::git_http::http_bare(
            &h.state.config,
            &h.app.slug,
        ))
        .await
        .expect("refs");
        assert!(
            refs.keys().all(|key| !key.starts_with("refs/heads/refs/")),
            "nothing refs-shaped was published: {refs:?}"
        );
        h.finish().await;
    }

    /// The web commit's `branch` is caller input too (MCP `commit_files`
    /// reaches it through REST): a full ref there must be refused.
    #[tokio::test]
    async fn web_commit_refuses_a_refs_shaped_branch() {
        let h = Harness::new("refs-webcommit").await;
        h.seed_main().await;
        for branch in ["refs/heads/main", "refs/previews/x"] {
            let err = super::super::source::commit(&h.state, &h.app.id, &commit_body(branch))
                .await
                .expect_err("refs-shaped web commit must fail");
            assert!(
                format!("{err:?}").contains("invalid branch"),
                "unexpected error for {branch:?}: {err:?}"
            );
        }
        h.finish().await;
    }

    /// The ordinary case keeps working: a plain `feature/x` branch is created
    /// at the requested tip.
    #[tokio::test]
    async fn branch_create_accepts_a_plain_name() {
        let h = Harness::new("refs-plain").await;
        let sha = h.seed_main().await;
        let created = branch_create(&h.state, &h.app.id, "feature/x", "main")
            .await
            .expect("plain branch create");
        assert_eq!(created.name, "feature/x");
        assert_eq!(created.sha, sha);
        h.finish().await;
    }

    /// A branch already stored as `refs/heads/refs/…` (written before the
    /// validator) can still be deleted, so a repo can be cleaned up; an
    /// unknown one is refused as an invalid name rather than lingering.
    #[tokio::test]
    async fn branch_delete_cleans_up_a_legacy_refs_shaped_branch() {
        let h = Harness::new("refs-delete").await;
        let sha = h.seed_main().await;
        forge::publish_ref(&h.state, &h.app, "refs/previews/x", None, Some(&sha))
            .await
            .expect("seed legacy refs-shaped branch");
        branch_delete(&h.state, &h.app.id, "refs/previews/x")
            .await
            .expect("legacy refs-shaped branch deletes");
        let refs = list_refs(&crate::host::git_http::http_bare(
            &h.state.config,
            &h.app.slug,
        ))
        .await
        .expect("refs");
        assert!(!refs.contains_key("refs/heads/refs/previews/x"));
        let err = branch_delete(&h.state, &h.app.id, "refs/previews/y")
            .await
            .expect_err("unknown refs-shaped branch must fail");
        assert!(
            format!("{err:?}").contains("invalid branch name"),
            "unexpected error: {err:?}"
        );
        h.finish().await;
    }

    /// An environment tracks a real branch: a `refs/…` name is refused before
    /// the existence check runs.
    #[tokio::test]
    async fn environment_create_refuses_a_refs_shaped_branch() {
        let h = Harness::new("refs-env").await;
        h.seed_main().await;
        let err = super::super::environments::create(
            &h.state,
            &h.app.id,
            "refs/previews/x",
            None,
            Some("push"),
        )
        .await
        .expect_err("refs-shaped environment branch must fail");
        assert!(
            format!("{err:?}").contains("invalid branch name"),
            "unexpected error: {err:?}"
        );
        h.finish().await;
    }

    /// A one-off branch deploy names a branch, never a full ref in disguise.
    #[tokio::test]
    async fn branch_deploy_refuses_a_refs_shaped_reference() {
        let h = Harness::new("refs-deploy").await;
        h.seed_main().await;
        let err = super::super::deploys::prepare_branch_deploy(
            &h.state,
            &h.app.id,
            "refs/heads/refs/previews/x",
            Some("push"),
        )
        .await
        .err()
        .expect("refs-shaped deploy reference must fail");
        assert!(
            format!("{err:?}").contains("must be a branch"),
            "unexpected error: {err:?}"
        );
        h.finish().await;
    }
}
