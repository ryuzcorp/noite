//! Git smart-HTTP adapter: stock `git push`/`fetch` → local bare → S3 tip bundles.
//!
//! Clients talk HTTP Basic (`git` / profile API key). The runner asks the UI to
//! verify the key and collaborator role (`view` for fetch, `push` for receive).
//! Object layout stays `git/{slug}/refs/heads/<branch>/<sha>.bundle` plus one
//! `git/{slug}/MANIFEST.json` linearization point, so tip-poll and deploy keep
//! working without git-remote-s3 on the client.
//!
//! Push hardening (walgit-inspired): the request head is parsed before git runs
//! so per-role policy (`push` = create + fast-forward only, `admin` = anything)
//! rejects before mutation; pushes to one slug are serialized by an in-process
//! mutex; all ref bundles land first and the manifest flips once, so readers
//! never see a half-written push.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use axum::{
    body::{Body, Bytes},
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::Engine;
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::json;

use crate::config::Config;
use crate::db;
use crate::host::exec;
use crate::host::git_policy::{self, PolicyDecision};
use crate::host::s3;
use crate::host::tips::{RefTip, TipBundle};
use crate::models::App;
use crate::AppState;

const GIT_USER: &str = "git";

#[derive(Debug, Deserialize)]
pub struct InfoRefsQuery {
    pub service: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitAuthOk {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// What `authorize` resolved for one request.
struct Authed {
    app: App,
    role: String,
}

/// What a refusal from the UI looks like to the git client. The create path
/// (A5) surfaces the UI's own message — 403 over the account's app limit, 404
/// for an invalid or reserved slug; every other need keeps the uniform 401.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Uniform,
    Detailed,
}

// The Err variant carries a full Response (over the lint's size budget),
// but every construction site and all three callers already speak Response
// and the error path runs at most once per request — boxing would churn
// nine sites for no measurable gain.
#[allow(clippy::result_large_err)]
async fn authorize(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
    need: &str,
) -> Result<Authed, Response> {
    let Some((user, pass)) = decode_basic(headers) else {
        return Err(unauthorized());
    };
    let Some(key) = extract_api_key(&user, &pass) else {
        return Err(unauthorized());
    };
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(app)) => {
            let role = ui_git_auth(state, slug, &key, need, Refusal::Uniform).await?;
            return Ok(Authed { app, role });
        }
        Ok(None) => {}
        Err(e) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response());
        }
    }
    // A5: a receive-pack for an unknown slug asks the UI to create the app —
    // it re-checks the key, the slug rules and the account limit — and only
    // then is the push served. Fetch keeps its plain 404.
    if need != "push" {
        return Err(repo_not_found("repository not found"));
    }
    let role = ui_git_auth(state, slug, &key, "create", Refusal::Detailed).await?;
    match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(app)) => Ok(Authed { app, role }),
        // The UI answered "created" but the row is not visible: never serve
        // half a push.
        Ok(None) => Err(repo_not_found("repository not found")),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()),
    }
}

/// Ask the UI to verify the key — and, on `need = create`, to create the app.
/// Returns the collaborator role; the body message of a `Detailed` refusal is
/// handed to the git client so an over-limit or reserved-slug push reads.
///
/// The Err variant carries a full Response (see `authorize` above).
#[allow(clippy::result_large_err)]
async fn ui_git_auth(
    state: &AppState,
    slug: &str,
    key: &str,
    need: &str,
    refusal: Refusal,
) -> Result<String, Response> {
    let url = format!("{}/internal/git-auth", crate::config::CONTROL_UPSTREAM_URL);
    let res = match reqwest::Client::new()
        .post(&url)
        .bearer_auth(&state.config.runner_token)
        .json(&json!({ "key": key, "slug": slug, "need": need }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "git-auth: UI unreachable");
            return Err((StatusCode::BAD_GATEWAY, "auth service unavailable").into_response());
        }
    };
    let status = res.status();
    let reply: GitAuthOk = res.json().await.unwrap_or(GitAuthOk {
        ok: false,
        role: None,
        error: None,
    });
    if status == StatusCode::UNAUTHORIZED {
        return Err(unauthorized());
    }
    if status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND {
        if refusal == Refusal::Detailed {
            let message = reply.error.unwrap_or_else(|| "unauthorized".to_string());
            return Err((status, message).into_response());
        }
        return Err(if status == StatusCode::NOT_FOUND {
            repo_not_found("repository not found")
        } else {
            unauthorized()
        });
    }
    if !status.is_success() {
        tracing::warn!(status = %status, "git-auth: unexpected status");
        return Err(unauthorized());
    }
    if !reply.ok {
        return Err(unauthorized());
    }
    // NOITE-GIT-002: this reply is an authorization decision, so an absent or
    // unknown role denies instead of defaulting to a write-capable one.
    let Some(role) = reply.role.as_deref().filter(|role| is_role(role)) else {
        tracing::warn!(slug, role = ?reply.role, "git-auth: the UI answered without a known role");
        return Err(unauthorized());
    };
    Ok(role.to_string())
}

/// The roles a git-auth reply may name: everything else (absent, empty, or a
/// role this runner does not know) is treated as a refusal.
fn is_role(role: &str) -> bool {
    matches!(role, "view" | "push" | "admin")
}

fn repo_not_found(message: &str) -> Response {
    (StatusCode::NOT_FOUND, message.to_string()).into_response()
}

/// Test-only mirror locator: the canonical push-mirror path the WAL manages
/// (`Wal::mirror_path`). Production goes through the WAL; tests seed bare
/// mirrors at this path directly.
#[cfg(test)]
pub fn http_bare(cfg: &Config, slug: &str) -> PathBuf {
    exec::work_root(cfg)
        .join("git-http")
        .join(format!("{slug}.git"))
}

fn pkt_line(payload: &str) -> Vec<u8> {
    pkt_line_bytes(payload.as_bytes())
}

fn pkt_line_bytes(payload: &[u8]) -> Vec<u8> {
    let total = payload.len() + 4;
    let mut out = format!("{total:04x}").into_bytes();
    out.extend_from_slice(payload);
    out
}

fn flush_pkt() -> &'static [u8] {
    b"0000"
}

fn wrap_advertise(service: &str, refs: &[u8]) -> Vec<u8> {
    let mut out = pkt_line(&format!("# service={service}\n"));
    out.extend_from_slice(flush_pkt());
    out.extend_from_slice(refs);
    out
}

fn decode_basic(headers: &HeaderMap) -> Option<(String, String)> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let b64 = raw.strip_prefix("Basic ")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let decoded = String::from_utf8(bytes).ok()?;
    let (user, pass) = decoded.split_once(':')?;
    Some((user.to_string(), pass.to_string()))
}

fn extract_api_key(user: &str, pass: &str) -> Option<String> {
    if !pass.is_empty() {
        return Some(pass.to_string());
    }
    if !user.is_empty() && user != GIT_USER {
        return Some(user.to_string());
    }
    None
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Basic realm=\"noite-git\"")],
        "unauthorized",
    )
        .into_response()
}

/// Create a bare repo whose HEAD points at the default branch (A0), so a fresh
/// repo advertises "empty repository" (+ push instructions) instead of an
/// unborn `master`, and a browser commit can create `main`.
pub(crate) async fn init_bare(repo: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(repo).await?;
    let path = repo.to_string_lossy().into_owned();
    let branch = format!("--initial-branch={}", crate::host::forge::DEFAULT_BRANCH);
    exec::run_cmd(
        "git",
        &["init", "--bare", &branch, &path],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await?;
    Ok(())
}

/// A0: initialize both bare mirrors a new app owns — the push mirror the Git
/// adapter writes and the source mirror previews/deploys read — with HEAD at
/// the default branch. `apps.create` calls this before the row lands, so a
/// fresh app never has an unborn default branch. The caller holds the slug's
/// lock, so the locked sync variant runs here: re-taking it would
/// self-deadlock.
pub(crate) async fn init_repos(state: &AppState, slug: &str) -> anyhow::Result<()> {
    state.wal.ensure_synced_locked(slug).await?;
    let source = crate::host::source::bare_repo(&state.config, slug);
    if !source.join("HEAD").exists() {
        init_bare(&source).await?;
    }
    Ok(())
}

/// The reserved hidden preview namespace. Nothing writes it any more, the
/// boot sweep deletes what an upgrade left, every caller-ref surface refuses
/// it, and the Git advertisement and fetch paths hide it.
pub const PREVIEW_REF_PREFIX: &str = "refs/previews/";

/// Every ref the runner tracks in a mirror: branches and tags.
pub(crate) async fn list_refs(bare: &Path) -> anyhow::Result<HashMap<String, String>> {
    let out = exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "show-ref",
            "--heads",
            "--tags",
        ],
        None,
        &[],
        Duration::from_secs(15),
    )
    .await;
    let text = out.unwrap_or_default();
    let mut map = HashMap::new();
    for line in text.lines() {
        let Some((sha, name)) = line.split_once(' ') else {
            continue;
        };
        map.insert(name.trim().to_string(), sha.trim().to_lowercase());
    }
    Ok(map)
}

/// Drop superseded tip bundles for a ref (keep the live one). Runs only
/// after the manifest flip, so concurrent readers already moved on.
pub(crate) async fn prune_old_bundles(cfg: &Config, slug: &str, refname: &str, keep_key: &str) {
    let prefix = format!("git/{slug}/{refname}/");
    let Ok(json) = s3::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await else {
        return;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else {
        return;
    };
    let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) else {
        return;
    };
    for obj in contents {
        let Some(key) = obj.get("Key").and_then(|k| k.as_str()) else {
            continue;
        };
        if key != keep_key && key.ends_with(".bundle") {
            let _ = s3::s3_delete_key(cfg, key).await;
        }
    }
}

/// Best-effort recursive delete of one ref's prefix (ref deletions).
pub(crate) async fn delete_ref_prefix(cfg: &Config, slug: &str, refname: &str) {
    let bucket = cfg.s3_bucket.clone();
    let prefix = format!("git/{slug}/{refname}/");
    let _ = s3::s3_rm_prefix(cfg, &bucket, &prefix).await;
}

/// `old` must be an ancestor of `new` for a fast-forward update.
async fn is_fast_forward(bare: &Path, old: &str, new: &str) -> bool {
    exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "merge-base",
            "--is-ancestor",
            old,
            new,
        ],
        None,
        &[],
        Duration::from_secs(15),
    )
    .await
    .is_ok()
}

/// What one `after_receive` landed: the moved refs' tip bundles, and the refs
/// that disappeared in this write (a deleted branch takes its preview
/// environment with it).
pub(crate) struct MovedRefs {
    pub tips: Vec<crate::host::tips::RefTip>,
    pub deleted: Vec<String>,
}

/// Persist a push git already accepted: the WAL cuts one tip bundle per
/// changed ref and flips the manifest once, then the superseded bundles and
/// deleted-ref prefixes are pruned. Returns a tip per moved ref
/// (production's `refs/heads/main` and every branch a preview environment
/// may track), so a push to `refs/heads/<branch>` reaches the deploy
/// pipeline.
///
/// The caller holds the slug's lock (`receive_pack`, `forge::publish_refname`
/// take it across the whole mutation), so the locked record runs inside it:
/// re-taking the guard here would self-deadlock.
pub(crate) async fn after_receive(
    state: &AppState,
    app: &App,
    bare: &Path,
    before: &HashMap<String, String>,
) -> anyhow::Result<MovedRefs> {
    let mut refs: std::collections::BTreeMap<String, String> = before
        .iter()
        .map(|(name, sha)| (name.clone(), sha.clone()))
        .collect();
    // The WAL tracks the retired preview namespace (so the boot sweep can
    // delete what an upgrade left), and its snapshot must cover the same refs
    // or a surviving preview ref reads as a create while the manifest already
    // has it — that conflict would fail the whole push. Carry whatever the
    // mirror still holds through unchanged.
    let git_dir = format!("--git-dir={}", bare.display());
    let retired = exec::run_cmd(
        "git",
        &[
            &git_dir,
            "for-each-ref",
            "--format=%(objectname) %(refname)",
            PREVIEW_REF_PREFIX,
        ],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await?;
    for line in retired.lines() {
        let Some((sha, refname)) = line.trim().split_once(' ') else {
            continue;
        };
        if refname.starts_with(PREVIEW_REF_PREFIX) {
            refs.insert(refname.to_string(), sha.to_string());
        }
    }
    let snapshot = ryuz_git::git::RefSnapshot {
        refs,
        head: None,
        peeled: Default::default(),
    };
    let outcome = state
        .wal
        .record_push_locked(&app.slug, &snapshot, None)
        .await?;
    // Prune superseded bundles + deleted-ref prefixes (readers moved on to
    // the flipped manifest), exactly as the old bundle-then-flip path did.
    for moved_ref in &outcome.moved {
        if let Some(bundle) = &moved_ref.bundle {
            prune_old_bundles(&state.config, &app.slug, &moved_ref.refname, bundle).await;
        } else {
            tracing::warn!(
                refname = %moved_ref.refname,
                "push recorded without a tip bundle; deploy falls back to the tip sweep"
            );
        }
    }
    for refname in &outcome.deleted {
        delete_ref_prefix(&state.config, &app.slug, refname).await;
    }
    // Every moved ref, not only `main`: the loop decides what tracks a ref
    // (production, or a preview environment).
    Ok(MovedRefs {
        tips: outcome
            .moved
            .iter()
            .filter_map(|moved_ref| {
                moved_ref.bundle.as_ref().map(|bundle| RefTip {
                    git_ref: moved_ref.refname.clone(),
                    bundle: TipBundle {
                        key: bundle.clone(),
                        sha: moved_ref.sha.clone(),
                    },
                })
            })
            .collect(),
        deleted: outcome.deleted.clone(),
    })
}

/// The push mirror, rebuilt from the manifest when missing or stale. A cold
/// mirror is a hard error (nothing usable to serve); a hot mirror serves
/// from what is local when the rebuild fails, same as before manifests
/// existed.
async fn synced_bare(state: &AppState, slug: &str) -> Result<PathBuf, String> {
    match crate::host::forge::hydrate(&state.wal, slug).await {
        crate::host::forge::MirrorPhase::Synced { bare }
        | crate::host::forge::MirrorPhase::Degraded { bare, .. } => Ok(bare),
        crate::host::forge::MirrorPhase::Refused(e) => Err(format!("{e:#}")),
    }
}

pub async fn info_refs(
    State(state): State<AppState>,
    AxumPath(slug): AxumPath<String>,
    Query(q): Query<InfoRefsQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(service) = q.service.as_deref() else {
        return (StatusCode::FORBIDDEN, "service required").into_response();
    };
    if service != "git-upload-pack" && service != "git-receive-pack" {
        return (StatusCode::FORBIDDEN, "unsupported service").into_response();
    }
    let need = if service == "git-receive-pack" {
        "push"
    } else {
        "view"
    };
    let Authed { app, .. } = match authorize(&state, &slug, &headers, need).await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let bare = match synced_bare(&state, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let prog = if service == "git-upload-pack" {
        "upload-pack"
    } else {
        "receive-pack"
    };
    let Some(bare_arg) = bare.to_str() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("bare mirror path is not valid UTF-8: {}", bare.display()),
        )
            .into_response();
    };
    let out = match exec::run_cmd(
        "git",
        &[
            "-c",
            &format!("uploadpack.hideRefs={PREVIEW_REF_PREFIX}"),
            prog,
            "--stateless-rpc",
            "--advertise-refs",
            bare_arg,
        ],
        None,
        &[],
        Duration::from_secs(30),
    )
    .await
    {
        Ok(s) => s.into_bytes(),
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response();
        }
    };
    let body = wrap_advertise(service, &out);
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                format!("application/x-{service}-advertisement"),
            ),
            (header::CACHE_CONTROL, "no-cache".into()),
        ],
        body,
    )
        .into_response()
}

pub async fn upload_pack(
    State(state): State<AppState>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Authed { app, .. } = match authorize(&state, &slug, &headers, "view").await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let bare = match synced_bare(&state, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let Some(bare_arg) = bare.to_str() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("bare mirror path is not valid UTF-8: {}", bare.display()),
        )
            .into_response();
    };
    match exec::run_cmd_stdin(
        "git",
        &[
            "-c",
            &format!("uploadpack.hideRefs={PREVIEW_REF_PREFIX}"),
            "upload-pack",
            "--stateless-rpc",
            bare_arg,
        ],
        &body,
        None,
        &[],
        Duration::from_secs(300),
    )
    .await
    {
        Ok(out) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/x-git-upload-pack-result")],
            out,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

/// git's RPC probe (`remote-curl.c: probe_rpc`): when a push body exceeds
/// `http.postBuffer` (1 MiB default), git first POSTs a flush-only body to the
/// same receive-pack URL, and only streams the real pack (chunked, no
/// Content-Length) on a 200. The probe is exactly `0000` — anything else
/// without commands stays refused by `policy_head` below.
fn is_probe_request(body: &[u8]) -> bool {
    body == b"0000"
}

/// The empty receive-pack result the RPC probe gets: `unpack ok` and the
/// flush, shaped like git-http-backend's answer to an empty push. The client
/// discards it and streams the real pack; no ref is read or written.
fn probe_response() -> Response {
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "application/x-git-receive-pack-result",
        )],
        [pkt_line("unpack ok\n"), b"0000".to_vec()].concat(),
    )
        .into_response()
}

/// Bytes of push head the policy layer reads before key auth (A5 order
/// below): enough for any realistic command section (~5000 ref updates). The
/// full body is never buffered pre-auth — in RAM (frames stream through) or
/// on disk (the pump stops here until auth succeeds).
const PUSH_HEAD_MAX: u64 = 1024 * 1024;

/// A push body spooled to disk under the work dir: the full request in a
/// temp file, the head (through the first flush, bounded by PUSH_HEAD_MAX)
/// in memory for the policy layer. The file is removed on drop, so pre-auth
/// refusals, 413s and crashes all clean it.
struct SpooledPush {
    path: PathBuf,
    head: Vec<u8>,
}

impl Drop for SpooledPush {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
/// The pump behind [`SpooledPush`]: frames stream into the temp file with a
/// running byte count, so the pack is never held in RAM. The temp file
/// exists from creation, so dropping the pump on any pre-finish exit (413,
/// 403, 401, crash) removes it — the guard below only covers the finished
/// push, which `receive_pack` drops after git runs.
struct SpoolPump {
    file: tokio::fs::File,
    path: Option<PathBuf>,
    len: u64,
    head: Vec<u8>,
    /// Offset of the next length prefix the boundary walk has not parsed:
    /// the walk resumes there, so each head byte is scanned once.
    head_pos: usize,
    head_done: bool,
    cap: u64,
}

impl SpoolPump {
    async fn create(dir: &Path, cap: u64) -> anyhow::Result<Self> {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let name = format!(
            "push-{}-{}-{:016x}.pack",
            std::process::id(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            rand::random::<u64>()
        );
        let path = dir.join(name);
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
            .with_context(|| format!("create push spool {}", path.display()))?;
        Ok(Self {
            file,
            path: Some(path),
            len: 0,
            head: Vec::new(),
            head_pos: 0,
            head_done: false,
            cap,
        })
    }

    /// Write one frame, 413 past the cap, and extend the boundary-walked
    /// head. The walk parses packet boundaries like the policy parser, so a
    /// `0000` inside a payload cannot end the head early.
    async fn write_frame(&mut self, data: &[u8]) -> Result<(), (StatusCode, String)> {
        use tokio::io::AsyncWriteExt as _;
        if self.len.saturating_add(data.len() as u64) > self.cap {
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "noite: push exceeds the {}-byte worktree quota (RUNNER_BUILD_MAX_MB)",
                    self.cap
                ),
            ));
        }
        self.file.write_all(data).await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("noite: could not spool the push: {e:#}"),
            )
        })?;
        self.len += data.len() as u64;
        if !self.head_done {
            self.head.extend_from_slice(data);
            self.scan_head();
        }
        Ok(())
    }

    /// Walk packet boundaries from the last parsed prefix: a flush ends the
    /// head, the bound or a malformed prefix stops the scan (the policy
    /// parser refuses those — and a malformed prefix already decides it, so
    /// the pump stops pulling). Truncated prefixes simply wait for more data.
    fn scan_head(&mut self) {
        let mut pos = self.head_pos;
        while pos + 4 <= self.head.len() {
            let Ok(len) = usize::from_str_radix(
                std::str::from_utf8(&self.head[pos..pos + 4]).unwrap_or(""),
                16,
            ) else {
                // Present but unparseable: more bytes cannot fix these four.
                self.head_done = true;
                break;
            };
            if len == 0 {
                self.head.truncate(pos + 4);
                self.head_done = true;
                return;
            }
            if len < 4 {
                // The parser bails on these the same way.
                self.head_done = true;
                break;
            }
            pos += len;
            if pos as u64 > PUSH_HEAD_MAX {
                break;
            }
        }
        self.head_pos = pos;
        if self.head.len() as u64 > PUSH_HEAD_MAX {
            self.head.truncate(PUSH_HEAD_MAX as usize);
            self.head_done = true;
        }
    }

    /// Poll `body` until the head is complete, the head bound lands, or the
    /// stream ends. True on a clean EOF (probes and small pushes end here —
    /// the caller keeps `body` for the rest after auth).
    async fn pump_head(&mut self, body: &mut Body) -> Result<bool, (StatusCode, String)> {
        while !self.head_done && self.len < PUSH_HEAD_MAX {
            match body.frame().await {
                Some(Ok(frame)) => {
                    if let Some(data) = frame.data_ref() {
                        self.write_frame(data).await?;
                    }
                }
                Some(Err(_)) => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "noite: could not read the push body".to_string(),
                    ));
                }
                None => return Ok(true),
            }
        }
        Ok(false)
    }

    /// Poll the rest after auth, enforcing the cap.
    async fn pump_rest(&mut self, mut body: Body) -> Result<(), (StatusCode, String)> {
        while let Some(frame) = body.frame().await {
            match frame {
                Ok(frame) => {
                    if let Some(data) = frame.data_ref() {
                        self.write_frame(data).await?;
                    }
                }
                Err(_) => {
                    return Err((
                        StatusCode::BAD_REQUEST,
                        "noite: could not read the push body".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn finish(mut self) -> SpooledPush {
        let path = self.path.take().expect("spool path");
        SpooledPush {
            path,
            head: std::mem::take(&mut self.head),
        }
    }
}

impl Drop for SpoolPump {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The head the push policy works on, or the response receive-pack answers when
/// it cannot be read. NOITE-GIT-001: an unreadable head (malformed pkt-lines, a
/// ref name this layer cannot decode, or no commands at all) is refused — the
/// request is never handed to git with every check skipped.
#[allow(clippy::result_large_err)]
fn policy_head(body: &[u8]) -> Result<Vec<git_policy::PushCommand>, (StatusCode, String)> {
    let refused = (
        StatusCode::FORBIDDEN,
        "noite: refused: the push request could not be parsed".to_string(),
    );
    match git_policy::parse_receive_commands(body) {
        Ok(cmds) if !cmds.is_empty() => Ok(cmds),
        _ => Err(refused),
    }
}

/// The `git receive-pack` argv for one push. `deny` mirrors the push policy in
/// git itself (non-fast-forward updates and ref deletions need admin), so a
/// parsing divergence cannot become a force-push or a delete (NOITE-GIT-001).
/// `-c` must precede the subcommand.
fn receive_argv(bare: &Path, deny: bool) -> anyhow::Result<Vec<String>> {
    let mut argv: Vec<String> = Vec::new();
    if deny {
        argv.extend(
            [
                "-c",
                "receive.denyNonFastForwards=true",
                "-c",
                "receive.denyDeletes=true",
            ]
            .map(str::to_string),
        );
    }
    let Some(bare_arg) = bare.to_str() else {
        anyhow::bail!("bare mirror path is not valid UTF-8: {}", bare.display());
    };
    argv.extend(["receive-pack", "--stateless-rpc", bare_arg].map(str::to_string));
    Ok(argv)
}

pub async fn receive_pack(
    State(state): State<AppState>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    // The push cap is the worktree quota: a bundle that does not fit
    // `RUNNER_BUILD_MAX_MB` can never deploy past the worktree check, so it
    // is refused at the door (413) instead of spooled past it. The floor
    // keeps probes and small pushes working when the quota is zeroed.
    let cap = state
        .config
        .build_max_mb
        .saturating_mul(1024 * 1024)
        .max(1024 * 1024);
    // Phase one runs before any auth decision and stays bounded either way:
    // frames stream into the spool file (never RAM) and the pump stops at
    // the head, the head bound, or EOF. An unauthenticated client therefore
    // pins at most a head window of disk and memory — never the pack.
    let mut pump = match SpoolPump::create(&exec::work_root(&state.config), cap).await {
        Ok(pump) => pump,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    let mut body = body;
    let head_eof = match pump.pump_head(&mut body).await {
        Ok(eof) => eof,
        Err((status, message)) => return (status, message).into_response(),
    };
    // The RPC probe is not a push: constant empty answer, no auth, no DB, no
    // mutation. It must be the whole body — a `0000` head with pack bytes
    // behind it is an empty command list, refused below like any other.
    if head_eof && pump.len == 4 && is_probe_request(&pump.head) {
        return probe_response();
    }
    // NOITE-GIT-001: the parsed head IS the policy input, so a head the policy
    // layer cannot read is refused outright — it is never handed to git with
    // every check skipped. This runs before `authorize`, so a malformed push
    // cannot even create an app on the push-to-create path (A5); only the
    // bounded head above was consumed to decide that.
    let parsed = match policy_head(&pump.head) {
        Ok(cmds) => cmds,
        Err((status, message)) => {
            tracing::warn!(slug = %slug, "git receive: refused an unparseable request head");
            return (status, message).into_response();
        }
    };
    let Authed { app, role } = match authorize(&state, &slug, &headers, "push").await {
        Ok(t) => t,
        Err(r) => return r,
    };
    // Phase two runs only after auth, still under the cap; the finished
    // spool drops its file after git runs below.
    if let Err((status, message)) = pump.pump_rest(body).await {
        return (status, message).into_response();
    }
    let spooled = pump.finish();
    match git_policy::check_push_policy(&role, &parsed) {
        PolicyDecision::Allow => {}
        PolicyDecision::Deny(msg) => {
            return (StatusCode::FORBIDDEN, msg).into_response();
        }
    }
    // Branch protection (`require_pr`): with the rule on, only admin may
    // move `main`; the push role must open a pull request instead.
    let rules = match crate::db::prs::branch_rules(&state.pool, &app.id).await {
        Ok(rules) => rules,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response();
        }
    };
    if let PolicyDecision::Deny(msg) =
        git_policy::check_branch_protection(&role, &parsed, rules.require_pr != 0)
    {
        return (StatusCode::FORBIDDEN, msg).into_response();
    }
    // Serialize pushes per slug: policy + fast-forward checks stay valid
    // through git + S3 + manifest with no interleaving push. This is the
    // innermost lock (AppLock → the slug lock, see [`ryuz_git::GitSync`]):
    // rename/purge/create hold this same guard across their own moves and
    // wipes, so a push lands fully before or fully after those operations.
    let _push_guard = state.wal.lock(&app.slug).await;
    // The authorization above ran before the guard. A delete holds this guard
    // while it removes the row, and a create (or rename) can take it and put a
    // *different* app on the same slug while this push waited: hydrating and
    // writing now would land on the successor's repository. Require the row
    // the push was authorized for to still be the row behind this slug.
    match crate::db::get_app(&state.pool, &app.id).await {
        Ok(Some(current)) if current.slug == app.slug => {}
        Ok(_) => {
            return (
                StatusCode::CONFLICT,
                "rule push-policy: the app was deleted or renamed; fetch and push again"
                    .to_string(),
            )
                .into_response();
        }
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
    let bare = match state.wal.ensure_synced_locked(&app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    if role != "admin" {
        for (refname, old, new) in git_policy::updates_needing_ff(&parsed) {
            if !is_fast_forward(&bare, old, new).await {
                return (
                    StatusCode::FORBIDDEN,
                    format!("rule push-policy: 'push' may not force-push {refname} (admin only)"),
                )
                    .into_response();
            }
        }
    }
    let before = match list_refs(&bare).await {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    // A `main` that does not exist yet is the first push this repo ever sees.
    let first_main_push = !before.contains_key("refs/heads/main");
    // Defense in depth for the policy above: git itself refuses non-fast-forward
    // updates and ref deletions for anything below admin, so a parsing
    // divergence can never become a force-push or a delete (NOITE-GIT-001).
    let argv = match receive_argv(&bare, role != "admin") {
        Ok(argv) => argv,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out = match exec::run_cmd_file_stdin(
        "git",
        &argv,
        &spooled.path,
        None,
        &[],
        Duration::from_secs(300),
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    // Push-driven deploy (T2.2): notify the reconcile loop, which drains the
    // channel every tick and deploys. A crash here only delays the deploy to
    // the next fallback sweep — the bundle and manifest are already stored.
    match after_receive(&state, &app, &bare, &before).await {
        Ok(moved) => {
            // A deleted ref's environment is torn down on its own task, so the
            // push does not wait for a fleet drain; `moved.tips` below holds
            // the refs that still exist, so nothing deploys into a gone
            // environment in the meantime.
            crate::host::env_teardown::on_refs_deleted(&state, &app, &moved.deleted).await;
            if !app.is_stopped() {
                for tip in &moved.tips {
                    let _ = state.tip_tx.send(crate::host::tips::TipNotify {
                        app_id: app.id.clone(),
                        git_ref: tip.git_ref.clone(),
                        tip: tip.bundle.clone(),
                    });
                }
            }
        }
        Err(e) => {
            tracing::error!(slug = %app.slug, error = %format!("{e:#}"), "git receive sync to s3 failed");
            // The pusher gets a stable message; the cause stays in the log.
            return (
                StatusCode::CONFLICT,
                "noite: the push could not be recorded; retry, and contact the operator if it persists",
            )
                .into_response();
        }
    }
    // Pull requests follow their head branch: the push moved `refs/heads/*`,
    // so refresh head_sha and dismiss reviews recorded at an older sha.
    // Best-effort — the push already landed and a PR-table hiccup must not
    // turn it into a failed push.
    if let Ok(post_refs) = list_refs(&bare).await {
        if let Err(e) = crate::host::prs::on_refs_moved(&state, &app.id, &before, &post_refs).await
        {
            tracing::warn!(slug = %app.slug, error = %format!("{e:#}"), "pr head sync");
        }
    }
    // A5: the push that created `main` was the first one (a push-to-create, or
    // the first push to an app created blank) — print the app URL as a
    // `remote:` line, where the client already looks for push feedback.
    let mut out = out;
    if first_main_push && wants_sideband(&spooled.head) {
        let url = state.config.public_app_url(&app.subdomain);
        out = with_notes(out, &[format!("noite: {url}")]);
    }
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            "application/x-git-receive-pack-result",
        )],
        out,
    )
        .into_response()
}

/// The sideband channel git's demuxer prints to stderr (prefixed `remote: `).
const SIDE_BAND_PROGRESS: u8 = 2;

/// Whether the push asked for sideband progress. Without it our channel byte
/// would be read as a protocol line, so the note is skipped instead.
fn wants_sideband(body: &[u8]) -> bool {
    // The capability list rides the first command packet, far inside the head.
    let head = &body[..body.len().min(512)];
    head.windows(b"side-band-64k".len())
        .any(|w| w == b"side-band-64k")
}

/// Append sideband (`remote:`) lines to a receive-pack result. They go *before*
/// the final flush packet: the client stops reading at the flush, so a packet
/// appended after it would never be printed. A body without the flush is passed
/// through untouched (advisory output must never break a push).
fn with_notes(out: Vec<u8>, notes: &[String]) -> Vec<u8> {
    let Some(body) = out.strip_suffix(b"0000") else {
        return out;
    };
    let mut merged = body.to_vec();
    for note in notes {
        let mut payload = vec![SIDE_BAND_PROGRESS];
        payload.extend_from_slice(note.as_bytes());
        payload.push(b'\n');
        merged.extend(pkt_line_bytes(&payload));
    }
    merged.extend_from_slice(b"0000");
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_push_note_links_the_public_edge_url() {
        // The note must name the edge tenants serve on — never the runner
        // API's raw port, even when the git remote points straight at it.
        let mut cfg = crate::config::config_for_tests();
        cfg.base_domain = "noite.localhost".into();
        cfg.git_public_base = "http://localhost:8080/v1/git".into();
        assert_eq!(
            cfg.public_app_url("blog.noite.localhost"),
            "http://blog.noite.localhost:9080"
        );
        cfg.base_domain = "noite.now".into();
        cfg.auto_https = true;
        cfg.https_port = 443;
        assert_eq!(
            cfg.public_app_url("blog.noite.now"),
            "https://blog.noite.now"
        );
        cfg.auto_https = false;
        cfg.http_port = 80;
        assert_eq!(
            cfg.public_app_url("blog.noite.now"),
            "http://blog.noite.now"
        );
    }

    fn temp_dir(tag: &str) -> crate::testutil::TempDir {
        crate::testutil::TempDir::new(&format!("noite-git-http-{tag}"))
    }

    /// A0: a bare repo the runner creates points HEAD at `main`, so a fresh app
    /// advertises an empty `main` (push instructions) instead of `master`.
    #[tokio::test]
    async fn init_bare_points_head_at_main() {
        let guard_head = temp_dir("head");
        let dir = guard_head.path().to_path_buf();
        let repo = dir.join("app.git");
        init_bare(&repo).await.expect("init");
        let head = std::fs::read_to_string(repo.join("HEAD")).expect("HEAD");
        assert_eq!(head.trim(), "ref: refs/heads/main");
        // Idempotent: a second init on an existing repo is never reached by the
        // callers, but the helper itself must not need an empty directory.
        init_bare(&repo).await.expect("re-init");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The first-push note is a sideband packet before the flush (after it the
    /// client would never read it) and is skipped entirely when the push did
    /// not ask for sideband.
    #[test]
    fn notes_land_before_the_flush() {
        let out = b"000dunpack ok\n0000".to_vec();
        let noted = with_notes(out.clone(), &["noite: http://a.localhost".to_string()]);
        assert!(noted.ends_with(b"0000"));
        let text = String::from_utf8_lossy(&noted);
        assert!(text.contains("noite: http://a.localhost"));
        let note_at = text.find("noite:").expect("note");
        let flush_at = text.rfind("0000").expect("flush");
        assert!(note_at < flush_at, "note must precede the flush: {text}");
        // A body without a flush is passed through untouched.
        let bare = b"000dunpack ok\n".to_vec();
        assert_eq!(with_notes(bare.clone(), &["x".to_string()]), bare);
    }

    #[test]
    fn sideband_capability_is_detected() {
        let line = format!(
            "{} {} refs/heads/main\0report-status side-band-64k\n",
            "0".repeat(40),
            "a".repeat(40)
        );
        let mut body = pkt_line_bytes(line.as_bytes());
        body.extend_from_slice(b"0000");
        assert!(wants_sideband(&body));
        assert!(!wants_sideband(b"0000"));
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

    /// NOITE-GIT-001: the head is the policy input, so a head the policy layer
    /// cannot read is refused instead of skipping every check.
    #[test]
    fn an_unreadable_head_is_refused() {
        let valid = format!(
            "{} {} refs/heads/feat\0report-status\n",
            "a".repeat(40),
            "b".repeat(40)
        );
        let mut body = pkt_line_bytes(valid.as_bytes());
        body.extend_from_slice(b"0000");
        assert_eq!(policy_head(&body).expect("a readable head").len(), 1);

        // Not pkt-lines at all.
        let (status, message) = policy_head(b"not a pkt line").err().expect("refused");
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(message.contains("refused"), "{message}");
        // An empty command list is not a push either.
        assert!(policy_head(b"0000").is_err());
        // A non-UTF-8 refname is legal for git but unreadable here: exactly the
        // divergence the fail-open path turned into a bypass.
        let mut weird = pkt_line_bytes(&[0xff, 0xfe, 0xfd, 0x00, b'a']);
        weird.extend_from_slice(b"0000");
        assert!(policy_head(&weird).is_err());
    }

    /// A non-UTF-8 mirror path (an operator mount) is an error, never a panic:
    /// every argv/path conversion in this module reports instead of unwrapping.
    #[cfg(unix)]
    #[test]
    fn non_utf8_mirror_paths_are_errors_not_panics() {
        use std::os::unix::ffi::OsStrExt;
        let bad = std::path::Path::new(std::ffi::OsStr::from_bytes(b"/tmp/\xff.git"));
        let err = receive_argv(bad, true).expect_err("refused");
        assert!(format!("{err:#}").contains("not valid UTF-8"), "{err:#}");
    }

    /// NOITE-GIT-002: the UI's reply must name a known role — an absent one is
    /// a refusal, never "push".
    #[test]
    fn git_auth_requires_a_known_role() {
        for role in ["view", "push", "admin"] {
            assert!(is_role(role), "{role}");
        }
        for role in ["", "owner", "PUSH", "Admin", "create"] {
            assert!(!is_role(role), "{role}");
        }
    }

    /// NOITE-GIT-001: git itself refuses a delete for a role below admin, with
    /// the policy layer bypassed entirely (this drives `receive-pack` with the
    /// exact argv `receive_pack` builds for `push`), and the ref survives. The
    /// same request is served with the admin argv.
    #[tokio::test]
    async fn git_refuses_a_delete_for_the_push_role() {
        let guard_deny = temp_dir("deny");
        let dir = guard_deny.path().to_path_buf();
        let bare = dir.join("t.git");
        init_bare(&bare).await.expect("init");
        let work = dir.join("w");
        std::fs::create_dir_all(&work).expect("work");
        git_in(&work, &["init", "-b", "main"]).await;
        std::fs::write(work.join("f.txt"), "hi").expect("write");
        git_in(&work, &["add", "-A"]).await;
        git_in(&work, &["commit", "-m", "one"]).await;
        let sha = git_in(&work, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        // `main` is HEAD; `gone`/`kept` are ordinary branches, so a refused
        // delete of those can only be `receive.denyDeletes`.
        for branch in ["main", "gone", "kept"] {
            git_in(
                &dir,
                &[
                    &format!("--git-dir={}", bare.display()),
                    "fetch",
                    work.to_str().unwrap(),
                    &format!("+refs/heads/main:refs/heads/{branch}"),
                ],
            )
            .await;
        }
        let delete_request = |refname: &str| {
            let payload = format!("{sha} {} {refname}\0report-status", "0".repeat(40));
            let mut body = pkt_line_bytes(payload.as_bytes());
            body.extend_from_slice(b"0000");
            body
        };
        let run = |deny: bool, body: Vec<u8>| {
            let argv = receive_argv(&bare, deny).expect("argv");
            async move {
                let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
                exec::run_cmd_stdin("git", &refs, &body, None, &[], Duration::from_secs(60))
                    .await
                    .expect("receive-pack")
            }
        };

        let refused = run(true, delete_request("refs/heads/main")).await;
        let text = String::from_utf8_lossy(&refused).into_owned();
        assert!(text.contains("ng refs/heads/main"), "{text}");
        assert!(text.contains("prohibited"), "{text}");
        let text = String::from_utf8_lossy(&run(true, delete_request("refs/heads/gone")).await)
            .into_owned();
        assert!(text.contains("ng refs/heads/gone"), "{text}");
        assert!(text.contains("deletion prohibited"), "{text}");
        let refs = list_refs(&bare).await.expect("refs");
        assert_eq!(
            refs.get("refs/heads/gone").map(String::as_str),
            Some(sha.as_str())
        );

        // Admin (`deny = false`): the same request goes through, which is what
        // makes the flag pair — not git's default — the enforcement.
        let allowed = run(false, delete_request("refs/heads/kept")).await;
        let text = String::from_utf8_lossy(&allowed).into_owned();
        assert!(text.contains("ok refs/heads/kept"), "{text}");
        assert!(!list_refs(&bare)
            .await
            .expect("refs")
            .contains_key("refs/heads/kept"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// git's RPC probe is exactly one flush packet: a large push POSTs `0000`
    /// first and streams the real pack only on a 200. Anything else without
    /// commands — empty, doubled, or garbage — stays refused.
    #[test]
    fn rpc_probe_is_detected_exactly() {
        assert!(is_probe_request(b"0000"));
        assert!(!is_probe_request(b""));
        assert!(!is_probe_request(b"00000000"));
        assert!(!is_probe_request(b"not a pkt line"));
        // A real head is not a probe, even a command-less one with trailing bytes.
        let mut head = pkt_line_bytes(
            format!(
                "{} {} refs/heads/main\0report-status\n",
                "a".repeat(40),
                "b".repeat(40)
            )
            .as_bytes(),
        );
        head.extend_from_slice(b"0000");
        assert!(!is_probe_request(&head));
    }

    /// The probe answers 200 with an empty receive-pack result (`unpack ok`
    /// and the flush), like git-http-backend's answer to an empty push — the
    /// client discards it and streams the real pack.
    #[tokio::test]
    async fn probe_answers_200_with_an_empty_result() {
        let res = probe_response();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1024)
            .await
            .expect("probe body");
        assert_eq!(&body[..], b"000eunpack ok\n0000");
    }

    /// Frames stream into the spool file with a running count; the head stops
    /// at the first flush while the pack keeps spooling. The finished spool
    /// reads back whole, and dropping it removes the file.
    #[tokio::test]
    async fn spooled_push_holds_frames_on_disk_not_in_memory() {
        let guard = temp_dir("spool-disk");
        let dir = guard.path().join("work");
        std::fs::create_dir_all(&dir).expect("work dir");
        let mut head = pkt_line_bytes(
            format!(
                "{} {} refs/heads/main\0report-status side-band-64k\n",
                "a".repeat(40),
                "b".repeat(40)
            )
            .as_bytes(),
        );
        head.extend_from_slice(b"0000");
        let pack: Vec<u8> = (0..3)
            .map(|i| vec![i; 512 * 1024])
            .collect::<Vec<_>>()
            .concat();
        let mut pump = SpoolPump::create(&dir, 100 * 1024 * 1024)
            .await
            .expect("spool");
        let frames = futures::stream::iter(
            std::iter::once(head.clone())
                .chain((0..3).map(|i| vec![i; 512 * 1024]))
                .map(|chunk| Ok::<Bytes, axum::Error>(Bytes::from(chunk))),
        );
        // The head completes on its frame; the pack streams after, frame by frame.
        let mut body = Body::from_stream(frames);
        pump.pump_head(&mut body).await.expect("head");
        pump.pump_rest(body).await.expect("rest");
        let spooled = pump.finish();
        assert_eq!(spooled.head, head, "head stops at the flush");
        let on_disk = std::fs::read(&spooled.path).expect("spool file");
        assert_eq!(on_disk.len(), head.len() + pack.len());
        assert_eq!(on_disk, [head.clone(), pack].concat());
        let path = spooled.path.clone();
        drop(spooled);
        assert!(!path.exists(), "the spool file is removed on drop");
        let _ = std::fs::remove_dir_all(guard.path());
    }

    /// Over the cap answers 413 and deletes the partial spool: a refused
    /// push leaves no file behind.
    #[tokio::test]
    async fn spool_refuses_past_the_cap_and_deletes_the_file() {
        let guard = temp_dir("spool-cap");
        let dir = guard.path().join("work");
        std::fs::create_dir_all(&dir).expect("work dir");
        let mut pump = SpoolPump::create(&dir, 1024).await.expect("spool");
        let path = pump.path.clone().expect("spool path");
        let mut body = Body::from(vec![0u8; 2048]);
        let refused = pump.pump_head(&mut body).await.expect_err("over cap");
        assert_eq!(refused.0, StatusCode::PAYLOAD_TOO_LARGE);
        drop(pump);
        assert!(!path.exists(), "the partial spool is removed");
        let _ = std::fs::remove_dir_all(guard.path());
    }

    /// A spooled file with no finished push behind it is removed when its
    /// pump drops: every pre-finish exit (401, 403, 413, crash) cleans up.
    #[tokio::test]
    async fn unfinished_spools_are_removed_on_drop() {
        let guard = temp_dir("spool-drop");
        let dir = guard.path().join("work");
        std::fs::create_dir_all(&dir).expect("work dir");
        let path = {
            let mut pump = SpoolPump::create(&dir, 1024 * 1024).await.expect("spool");
            let path = pump.path.clone().expect("spool path");
            pump.write_frame(b"0000").await.expect("frame");
            assert!(path.exists(), "the spool file exists while pumping");
            path
        };
        assert!(!path.exists(), "dropping the pump removes the file");
        let _ = std::fs::remove_dir_all(guard.path());
    }

    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    /// A body that counts the bytes the handler actually polls: proves what a
    /// refused push consumed, frame by frame.
    fn counting_body(chunks: Vec<Vec<u8>>, count: Arc<AtomicU64>) -> Body {
        Body::from_stream(futures::stream::iter(chunks.into_iter().map(
            move |chunk| {
                let count = count.clone();
                Ok::<Bytes, axum::Error>(Bytes::from({
                    count.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    chunk
                }))
            },
        )))
    }

    /// A handler state with a migrated file DB, a seeded app, and the spool
    /// dir inside the test's temp dir: refusals must leave it file-free.
    async fn handler_state(dir: &std::path::Path) -> (AppState, Arc<Config>, sqlx::SqlitePool) {
        let mut cfg = crate::config::config_for_tests();
        cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
        std::fs::create_dir_all(&cfg.work_dir).expect("work dir");
        let config = Arc::new(cfg);
        let pool = crate::db::connect(&config.database_url)
            .await
            .expect("connect db");
        let (tip_tx, _tip_rx) = crate::host::tips::channel();
        let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
        let state = AppState {
            pool: pool.clone(),
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
        (state, config, pool)
    }

    async fn seed_app(pool: &sqlx::SqlitePool, cfg: &Config, slug: &str) {
        crate::db::create_app(
            pool,
            cfg,
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
        .expect("seed app");
    }

    fn spool_files(dir: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .expect("work dir")
            .filter_map(|entry| {
                let name = entry.ok()?.file_name().to_string_lossy().into_owned();
                name.starts_with("push-").then_some(name)
            })
            .collect()
    }

    fn valid_head() -> Vec<u8> {
        let mut head = pkt_line_bytes(
            format!(
                "{} {} refs/heads/main\0report-status\n",
                "c".repeat(40),
                "d".repeat(40)
            )
            .as_bytes(),
        );
        head.extend_from_slice(b"0000");
        head
    }

    /// Key auth runs before the bulk: a valid head with no credentials gets
    /// 401 after only the bounded head window, and the spool is gone.
    #[tokio::test]
    async fn unauthenticated_large_push_is_refused_inside_the_head_bound() {
        let guard = temp_dir("refuse-noauth");
        let (state, config, pool) = handler_state(guard.path()).await;
        seed_app(&pool, &config, "blog").await;
        let count = Arc::new(AtomicU64::new(0));
        let mut chunks = vec![valid_head()];
        chunks.extend((0..96).map(|_| vec![7u8; 65536]));
        let body = counting_body(chunks, count.clone());
        let res = receive_pack(
            State(state),
            AxumPath("blog".to_string()),
            HeaderMap::new(),
            body,
        )
        .await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let consumed = count.load(Ordering::Relaxed);
        assert!(
            consumed <= PUSH_HEAD_MAX + 65536,
            "unauthenticated push consumed {consumed} bytes"
        );
        assert!(spool_files(std::path::Path::new(&config.work_dir)).is_empty());
        let _ = std::fs::remove_dir_all(guard.path());
    }

    /// Garbage to an unknown slug never reaches auth: the bounded head
    /// decides the 403, and the spool is gone.
    #[tokio::test]
    async fn garbage_to_an_unknown_slug_is_refused_inside_the_head_bound() {
        let guard = temp_dir("refuse-garbage");
        let (state, config, _pool) = handler_state(guard.path()).await;
        let count = Arc::new(AtomicU64::new(0));
        let chunks = (0..96).map(|_| vec![9u8; 65536]).collect();
        let body = counting_body(chunks, count.clone());
        let res = receive_pack(
            State(state),
            AxumPath("ghost".to_string()),
            HeaderMap::new(),
            body,
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let consumed = count.load(Ordering::Relaxed);
        assert!(
            consumed <= PUSH_HEAD_MAX + 65536,
            "garbage push consumed {consumed} bytes"
        );
        assert!(spool_files(std::path::Path::new(&config.work_dir)).is_empty());
        let _ = std::fs::remove_dir_all(guard.path());
    }
}
