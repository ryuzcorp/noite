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

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;

use crate::config::Config;
use crate::db;
use crate::host::exec;
use crate::host::s3;
use crate::host::tips::TipBundle;
use crate::host::git_manifest::{self, Manifest, ManifestRef};
use crate::host::git_policy::{self, PolicyDecision};
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
    .await
    .map(|_| ())
}

pub(crate) async fn ensure_bare(cfg: &Config, slug: &str) -> anyhow::Result<PathBuf> {
    let bare = http_bare(cfg, slug);
    tokio::fs::create_dir_all(bare.parent().unwrap()).await?;
    if !bare.join("HEAD").exists() {
        init_bare(&bare).await?;
        hydrate_from_s3(cfg, &bare, slug).await?;
    }
    // Hydration reads the raw bundle listing, which is not the linearization
    // point: a delete interrupted between the manifest flip and its prune left
    // a tip bundle behind. Make the manifest win before anyone reads or writes
    // through this mirror (warn-only — see `forge::sync_manifest_cfg`).
    crate::host::forge::sync_manifest_cfg(cfg, slug, &bare).await;
    Ok(bare)
}

/// A0: initialize both bare mirrors a new app owns — the push mirror the Git
/// adapter writes and the source mirror previews/deploys read — with HEAD at
/// the default branch. `apps.create` calls this before the row lands, so a
/// fresh app never has an unborn default branch.
pub(crate) async fn init_repos(cfg: &Config, slug: &str) -> anyhow::Result<()> {
    ensure_bare(cfg, slug).await?;
    let source = crate::host::source::bare_repo(cfg, slug);
    if !source.join("HEAD").exists() {
        init_bare(&source).await?;
    }
    Ok(())
}

async fn hydrate_from_s3(cfg: &Config, bare: &Path, slug: &str) -> anyhow::Result<()> {
    let prefix = format!("git/{slug}/refs/");
    let json = s3::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await?;
    if json.trim().is_empty() || json.trim() == "null" {
        return Ok(());
    }
    let v: serde_json::Value = serde_json::from_str(&json).unwrap_or(serde_json::Value::Null);
    let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) else {
        return Ok(());
    };
    let re = regex::Regex::new(r"(?i)/([0-9a-f]{7,40})\.bundle$").expect("bundle re");
    // ref → (key, sha, last_modified)
    let mut best: HashMap<String, (String, String, String)> = HashMap::new();
    for obj in contents {
        let Some(key) = obj.get("Key").and_then(|k| k.as_str()) else {
            continue;
        };
        let Some(caps) = re.captures(key) else {
            continue;
        };
        let sha = caps.get(1).unwrap().as_str().to_lowercase();
        // git/{slug}/refs/heads/main/{sha}.bundle → refs/heads/main
        let Some(after) = key.strip_prefix(&format!("git/{slug}/")) else {
            continue;
        };
        let Some((ref_path, _)) = after.rsplit_once('/') else {
            continue;
        };
        if !ref_path.starts_with("refs/") {
            continue;
        }
        let lm = obj
            .get("LastModified")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let replace = best
            .get(ref_path)
            .map(|b| lm.as_str() >= b.2.as_str())
            .unwrap_or(true);
        if replace {
            best.insert(ref_path.to_string(), (key.to_string(), sha, lm));
        }
    }
    let tmp = exec::work_root(cfg)
        .join("git-http")
        .join(format!(".hydrate-{slug}"));
    tokio::fs::create_dir_all(&tmp).await?;
    for (refname, (key, sha, _)) in best {
        let bundle = tmp.join(format!("{sha}.bundle"));
        s3::s3_cp_download(cfg, &cfg.s3_uri(&key), &bundle).await?;
        let refspec = format!("+{sha}:{refname}");
        exec::run_cmd(
            "git",
            &[
                &format!("--git-dir={}", bare.display()),
                "fetch",
                bundle.to_str().unwrap(),
                &refspec,
            ],
            None,
            &[],
            Duration::from_secs(60),
        )
        .await?;
        let _ = tokio::fs::remove_file(&bundle).await;
    }
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    Ok(())
}

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

async fn set_ref(bare: &Path, refname: &str, sha: Option<&str>) -> anyhow::Result<()> {
    match sha {
        Some(sha) => {
            exec::run_cmd(
                "git",
                &[
                    &format!("--git-dir={}", bare.display()),
                    "update-ref",
                    refname,
                    sha,
                ],
                None,
                &[],
                Duration::from_secs(15),
            )
            .await?;
        }
        None => {
            let _ = exec::run_cmd(
                "git",
                &[
                    &format!("--git-dir={}", bare.display()),
                    "update-ref",
                    "-d",
                    refname,
                ],
                None,
                &[],
                Duration::from_secs(15),
            )
            .await;
        }
    }
    Ok(())
}

/// Write one tip bundle for a ref. No manifest flip here, so a half-written
/// push stays invisible to manifest readers.
async fn write_ref_bundle(
    cfg: &Config,
    bare: &Path,
    slug: &str,
    refname: &str,
    sha: &str,
) -> anyhow::Result<String> {
    let bundle_key = format!("git/{slug}/{refname}/{sha}.bundle");
    let tmp = exec::work_root(cfg)
        .join("git-http")
        .join(format!(".bundle-{slug}-{sha}"));
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let result = async {
        exec::run_cmd(
            "git",
            &[
                &format!("--git-dir={}", bare.display()),
                "bundle",
                "create",
                tmp.to_str().unwrap_or_default(),
                refname,
            ],
            None,
            &[],
            Duration::from_secs(120),
        )
        .await?;
        s3::s3_cp_upload(cfg, &tmp, &bundle_key).await?;
        Ok::<_, anyhow::Error>(bundle_key.clone())
    }
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

/// Drop superseded tip bundles for a ref (keep the live one). Runs only
/// after the manifest flip, so concurrent readers already moved on.
async fn prune_old_bundles(cfg: &Config, slug: &str, refname: &str, keep_key: &str) {
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
async fn delete_ref_prefix(cfg: &Config, slug: &str, refname: &str) {
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

/// Persist a push git already accepted: bundles first, manifest flip once,
/// prune after. Returns the main tip when `refs/heads/main` moved. On any
/// failure the local mirror rolls back and the manifest keeps pointing at
/// the previous state, so the push stays invisible until retried.
pub(crate) async fn after_receive(
    state: &AppState,
    app: &App,
    bare: &Path,
    before: &HashMap<String, String>,
) -> anyhow::Result<Option<TipBundle>> {
    let after = list_refs(bare).await?;
    // 1. One tip bundle per changed ref (not yet visible).
    let mut changed: Vec<(String, String, String)> = Vec::new();
    for (refname, sha) in &after {
        if before.get(refname).map(|s| s.as_str()) == Some(sha.as_str()) {
            continue;
        }
        match write_ref_bundle(&state.config, bare, &app.slug, refname, sha).await {
            Ok(bundle_key) => changed.push((refname.clone(), sha.clone(), bundle_key)),
            Err(e) => {
                for (refname, _, _) in &changed {
                    let _ = set_ref(bare, refname, before.get(refname).map(|s| s.as_str())).await;
                }
                return Err(e);
            }
        }
    }
    // 2. Full post-push ref map: unchanged refs keep their bundle pointers.
    let old_manifest = git_manifest::read_manifest(&state.config, &app.slug).await?;
    let mut refs: HashMap<String, ManifestRef> = HashMap::new();
    if let Some(old) = &old_manifest {
        for (name, entry) in &old.refs {
            if after.get(name).map(|s| s.as_str()) == Some(entry.sha.as_str()) {
                refs.insert(name.clone(), entry.clone());
            }
        }
    }
    for (refname, sha, bundle_key) in &changed {
        refs.insert(
            refname.clone(),
            ManifestRef {
                sha: sha.clone(),
                bundle: bundle_key.clone(),
            },
        );
    }
    for (refname, sha) in &after {
        if refs.contains_key(refname) {
            continue;
        }
        // A ref the previous manifest does not carry (every push writes a
        // complete one, so this is a ref git itself created): cut its bundle.
        let bundle = write_ref_bundle(&state.config, bare, &app.slug, refname, sha).await?;
        refs.insert(
            refname.clone(),
            ManifestRef {
                sha: sha.clone(),
                bundle,
            },
        );
    }
    // 3. The linearization point: one manifest write.
    let seq = old_manifest.map(|m| m.seq + 1).unwrap_or(1);
    let manifest = Manifest {
        version: git_manifest::MANIFEST_VERSION,
        seq,
        refs,
    };
    if let Err(e) = git_manifest::write_manifest(&state.config, &app.slug, &manifest).await {
        for (refname, _, _) in &changed {
            let _ = set_ref(bare, refname, before.get(refname).map(|s| s.as_str())).await;
        }
        for refname in before.keys() {
            if !after.contains_key(refname) {
                let _ = set_ref(bare, refname, Some(&before[refname])).await;
            }
        }
        return Err(e);
    }
    state.git_sync.set_applied_seq(&app.slug, seq).await;
    // 4. Prune superseded bundles + deleted-ref prefixes (readers moved on).
    for (refname, _, bundle_key) in &changed {
        prune_old_bundles(&state.config, &app.slug, refname, bundle_key).await;
    }
    for refname in before.keys() {
        if !after.contains_key(refname) {
            delete_ref_prefix(&state.config, &app.slug, refname).await;
        }
    }
    Ok(changed
        .iter()
        .find(|(refname, _, _)| refname == "refs/heads/main")
        .map(|(_, sha, bundle_key)| TipBundle {
            key: bundle_key.clone(),
            sha: sha.clone(),
        }))
}

/// Re-apply the manifest to a bare mirror when it moved under us (another
/// push landed since this mirror was hydrated). Warn-only: readers serve
/// from what is local on failure, same as before manifests existed.
async fn refresh_from_manifest(state: &AppState, slug: &str, bare: &Path) {
    let manifest = match git_manifest::read_manifest(&state.config, slug).await {
        Ok(Some(m)) => m,
        Ok(None) => return,
        Err(e) => {
            tracing::warn!(slug = %slug, error = %format!("{e:#}"), "git manifest read");
            return;
        }
    };
    if state.git_sync.applied_seq(slug).await == Some(manifest.seq) {
        return;
    }
    let local = list_refs(bare).await.unwrap_or_default();
    if let Err(e) = git_manifest::refresh_bare(&state.config, bare, &manifest, &local).await {
        tracing::warn!(slug = %slug, error = %format!("{e:#}"), "git manifest refresh");
        return;
    }
    state.git_sync.set_applied_seq(slug, manifest.seq).await;
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
    let bare = match ensure_bare(&state.config, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    refresh_from_manifest(&state, &app.slug, &bare).await;
    let prog = if service == "git-upload-pack" {
        "upload-pack"
    } else {
        "receive-pack"
    };
    let out = match exec::run_cmd(
        "git",
        &[
            prog,
            "--stateless-rpc",
            "--advertise-refs",
            bare.to_str().unwrap(),
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
    let bare = match ensure_bare(&state.config, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    refresh_from_manifest(&state, &app.slug, &bare).await;
    match exec::run_cmd_stdin(
        "git",
        &[
            "upload-pack",
            "--stateless-rpc",
            bare.to_str().unwrap_or_default(),
        ],
        &body,
        None,
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
fn receive_argv(bare: &Path, deny: bool) -> Vec<String> {
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
    argv.extend(["receive-pack", "--stateless-rpc", bare.to_str().unwrap()].map(str::to_string));
    argv
}

pub async fn receive_pack(
    State(state): State<AppState>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // NOITE-GIT-001: the parsed head IS the policy input, so a head the policy
    // layer cannot read is refused outright — it is never handed to git with
    // every check skipped. This runs before `authorize`, so a malformed push
    // cannot even create an app on the push-to-create path (A5).
    let parsed = match policy_head(&body) {
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
    // through git + S3 + manifest with no interleaving push.
    let _push_guard = state.git_sync.push_guard(&app.slug).await;
    let bare = match ensure_bare(&state.config, &app.slug).await {
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
    let argv = receive_argv(&bare, role != "admin");
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out = match exec::run_cmd_stdin("git", &argv, &body, None, Duration::from_secs(300)).await
    {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    // Push-driven deploy (T2.2): notify the reconcile loop, which drains the
    // channel every tick and deploys. A crash here only delays the deploy to
    // the next fallback sweep — the bundle and manifest are already stored.
    match after_receive(&state, &app, &bare, &before).await {
        Ok(Some(tip)) => {
            if !app.is_stopped() {
                let _ = state.tip_tx.send(crate::host::tips::TipNotify {
                    app_id: app.id.clone(),
                    tip,
                });
            }
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!(slug = %app.slug, error = %format!("{e:#}"), "git receive sync to s3 failed");
            return (StatusCode::CONFLICT, format!("{e:#}")).into_response();
        }
    }
    // Pull requests follow their head branch: the push moved `refs/heads/*`,
    // so refresh head_sha and dismiss reviews recorded at an older sha.
    // Best-effort — the push already landed and a PR-table hiccup must not
    // turn it into a failed push.
    if let Ok(post_refs) = list_refs(&bare).await {
        if let Err(e) = crate::host::prs::on_refs_moved(&state, &app.id, &before, &post_refs).await {
            tracing::warn!(slug = %app.slug, error = %format!("{e:#}"), "pr head sync");
        }
    }
    // A5: the push that created `main` was the first one (a push-to-create, or
    // the first push to an app created blank) — print the app URL as a
    // `remote:` line, where the client already looks for push feedback.
    let mut out = out;
    if first_main_push && wants_sideband(&body) {
        let url = app_url(&state.config, &app.subdomain);
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

/// Browser URL of an app from its stored subdomain: the public git base carries
/// the scheme and (dev) the port, the subdomain the host — dev
/// `http://git.localhost:9080` → `http://my-app.localhost:9080`.
fn app_url(cfg: &Config, subdomain: &str) -> String {
    let base = cfg.git_public_base.trim_end_matches('/');
    let Some((scheme, rest)) = base.split_once("://") else {
        return format!("https://{subdomain}");
    };
    let authority = rest.split('/').next().unwrap_or_default();
    match authority.split_once(':') {
        Some((_, port)) if !port.is_empty() => format!("{scheme}://{subdomain}:{port}"),
        _ => format!("{scheme}://{subdomain}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("noite-git-http-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// A0: a bare repo the runner creates points HEAD at `main`, so a fresh app
    /// advertises an empty `main` (push instructions) instead of `master`.
    #[tokio::test]
    async fn init_bare_points_head_at_main() {
        let dir = temp_dir("head");
        let repo = dir.join("app.git");
        init_bare(&repo).await.expect("init");
        let head = std::fs::read_to_string(repo.join("HEAD")).expect("HEAD");
        assert_eq!(head.trim(), "ref: refs/heads/main");
        // Idempotent: a second init on an existing repo is never reached by the
        // callers, but the helper itself must not need an empty directory.
        init_bare(&repo).await.expect("re-init");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_url_keeps_the_public_scheme_and_port() {
        let mut cfg = crate::config::config_for_tests();
        cfg.git_public_base = "http://git.localhost:9080".into();
        assert_eq!(app_url(&cfg, "blog.localhost"), "http://blog.localhost:9080");
        cfg.git_public_base = "https://git.noite.now".into();
        assert_eq!(app_url(&cfg, "blog.noite.now"), "https://blog.noite.now");
        cfg.git_public_base = "https://git.noite.now/".into();
        assert_eq!(app_url(&cfg, "blog.noite.now"), "https://blog.noite.now");
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
        let dir = temp_dir("deny");
        let bare = dir.join("t.git");
        init_bare(&bare).await.expect("init");
        let work = dir.join("w");
        std::fs::create_dir_all(&work).expect("work");
        git_in(&work, &["init", "-b", "main"]).await;
        std::fs::write(work.join("f.txt"), "hi").expect("write");
        git_in(&work, &["add", "-A"]).await;
        git_in(&work, &["commit", "-m", "one"]).await;
        let sha = git_in(&work, &["rev-parse", "HEAD"]).await.trim().to_string();
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
            let argv = receive_argv(&bare, deny);
            async move {
                let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
                exec::run_cmd_stdin("git", &refs, &body, None, Duration::from_secs(60))
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
        assert!(
            !list_refs(&bare)
                .await
                .expect("refs")
                .contains_key("refs/heads/kept")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
