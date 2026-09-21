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
use crate::host::cmd::{self, TipBundle};
use crate::host::deploy;
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
    ok: bool,
    role: Option<String>,
}

pub fn http_bare(cfg: &Config, slug: &str) -> PathBuf {
    cmd::work_root(cfg)
        .join("git-http")
        .join(format!("{slug}.git"))
}

fn pkt_line(payload: &str) -> Vec<u8> {
    let total = payload.len() + 4;
    let mut out = format!("{total:04x}").into_bytes();
    out.extend_from_slice(payload.as_bytes());
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

async fn authorize(
    state: &AppState,
    slug: &str,
    headers: &HeaderMap,
    need: &str,
) -> Result<(App, String), Response> {
    let Some((user, pass)) = decode_basic(headers) else {
        return Err(unauthorized());
    };
    let Some(key) = extract_api_key(&user, &pass) else {
        return Err(unauthorized());
    };
    let app = match db::get_app_by_slug(&state.pool, slug).await {
        Ok(Some(a)) => a,
        Ok(None) => {
            return Err((StatusCode::NOT_FOUND, "repository not found").into_response());
        }
        Err(e) => {
            return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response());
        }
    };
    let url = format!("{}/internal/git-auth", state.config.ui_url);
    let client = reqwest::Client::new();
    let res = match client
        .post(&url)
        .bearer_auth(&state.config.runner_token)
        .json(&json!({ "key": key, "slug": slug, "need": need }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "git-auth: UI unreachable");
            return Err((
                StatusCode::BAD_GATEWAY,
                "auth service unavailable",
            )
                .into_response());
        }
    };
    if res.status() == StatusCode::UNAUTHORIZED || res.status() == StatusCode::FORBIDDEN {
        return Err(unauthorized());
    }
    if !res.status().is_success() {
        tracing::warn!(status = %res.status(), "git-auth: unexpected status");
        return Err(unauthorized());
    }
    let body: GitAuthOk = match res.json().await {
        Ok(b) => b,
        Err(_) => return Err(unauthorized()),
    };
    if !body.ok {
        return Err(unauthorized());
    }
    Ok((app, body.role.unwrap_or_else(|| "push".to_string())))
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Basic realm=\"noite-git\"")],
        "unauthorized",
    )
        .into_response()
}

pub(crate) async fn ensure_bare(cfg: &Config, slug: &str) -> anyhow::Result<PathBuf> {
    let bare = http_bare(cfg, slug);
    tokio::fs::create_dir_all(bare.parent().unwrap()).await?;
    if !bare.join("HEAD").exists() {
        cmd::run_cmd(
            "git",
            &["init", "--bare", bare.to_str().unwrap()],
            None,
            &[],
            Duration::from_secs(30),
        )
        .await?;
        hydrate_from_s3(cfg, &bare, slug).await?;
    }
    Ok(bare)
}

async fn hydrate_from_s3(cfg: &Config, bare: &Path, slug: &str) -> anyhow::Result<()> {
    let prefix = format!("git/{slug}/refs/");
    let json = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await?;
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
    let tmp = cmd::work_root(cfg).join("git-http").join(format!(".hydrate-{slug}"));
    tokio::fs::create_dir_all(&tmp).await?;
    for (refname, (key, sha, _)) in best {
        let bundle = tmp.join(format!("{sha}.bundle"));
        cmd::s3_cp_download(cfg, &cfg.s3_uri(&key), &bundle).await?;
        let refspec = format!("+{sha}:{refname}");
        cmd::run_cmd(
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
    let out = cmd::run_cmd(
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
    let text = match out {
        Ok(t) => t,
        Err(_) => String::new(), // empty repo → no refs
    };
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
            cmd::run_cmd(
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
            let _ = cmd::run_cmd(
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
    let tmp = cmd::work_root(cfg)
        .join("git-http")
        .join(format!(".bundle-{slug}-{sha}"));
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let result = async {
        cmd::run_cmd(
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
        cmd::s3_cp_upload(cfg, &tmp, &bundle_key).await?;
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
    let Ok(json) = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await else {
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
            let _ = cmd::s3_delete_key(cfg, key).await;
        }
    }
}

/// Best-effort recursive delete of one ref's prefix (ref deletions).
async fn delete_ref_prefix(cfg: &Config, slug: &str, refname: &str) {
    let prefix = format!("s3://{}/git/{slug}/{refname}/", cfg.s3_bucket);
    let env_owned = cmd::aws_env(cfg);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let _ = cmd::run_cmd(
        "aws",
        &["--endpoint-url", &cfg.s3_endpoint, "s3", "rm", "--recursive", &prefix],
        None,
        &env,
        Duration::from_secs(60),
    )
    .await;
}

/// Locate the live bundle for a ref+sha the manifest does not know (legacy
/// slugs on their first manifest write): scan the ref prefix, else cut one.
async fn bundle_key_for(
    cfg: &Config,
    bare: &Path,
    slug: &str,
    refname: &str,
    sha: &str,
) -> anyhow::Result<String> {
    let prefix = format!("git/{slug}/{refname}/");
    if let Ok(json) = cmd::s3_list_prefix(cfg, &cfg.s3_bucket, &prefix).await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(contents) = v.get("Contents").and_then(|c| c.as_array()) {
                let want = format!("{sha}.bundle").to_lowercase();
                for obj in contents {
                    let Some(key) = obj.get("Key").and_then(|k| k.as_str()) else {
                        continue;
                    };
                    if key.to_lowercase().ends_with(&want) {
                        return Ok(key.to_string());
                    }
                }
            }
        }
    }
    write_ref_bundle(cfg, bare, slug, refname, sha).await
}

/// `old` must be an ancestor of `new` for a fast-forward update.
async fn is_fast_forward(bare: &Path, old: &str, new: &str) -> bool {
    cmd::run_cmd(
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
                    let _ =
                        set_ref(bare, refname, before.get(refname).map(|s| s.as_str())).await;
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
            ManifestRef { sha: sha.clone(), bundle: bundle_key.clone() },
        );
    }
    for (refname, sha) in &after {
        if refs.contains_key(refname) {
            continue;
        }
        let bundle = bundle_key_for(&state.config, bare, &app.slug, refname, sha).await?;
        refs.insert(refname.clone(), ManifestRef { sha: sha.clone(), bundle });
    }
    // 3. The linearization point: one manifest write.
    let seq = old_manifest.map(|m| m.seq + 1).unwrap_or(1);
    let manifest = Manifest { version: git_manifest::MANIFEST_VERSION, seq, refs };
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
        .map(|(_, sha, bundle_key)| TipBundle { key: bundle_key.clone(), sha: sha.clone() }))
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
    let (app, _) = match authorize(&state, &slug, &headers, need).await {
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
    let out = match cmd::run_cmd(
        "git",
        &[prog, "--stateless-rpc", "--advertise-refs", bare.to_str().unwrap()],
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
    let (app, _) = match authorize(&state, &slug, &headers, "view").await {
        Ok(t) => t,
        Err(r) => return r,
    };
    let bare = match ensure_bare(&state.config, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    refresh_from_manifest(&state, &app.slug, &bare).await;
    match cmd::run_cmd_stdin(
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
            [(
                header::CONTENT_TYPE,
                "application/x-git-upload-pack-result",
            )],
            out,
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    }
}

pub async fn receive_pack(
    State(state): State<AppState>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let parsed = match git_policy::parse_receive_commands(&body) {
        Ok(cmds) => Some(cmds),
        Err(e) => {
            tracing::warn!(slug = %slug, error = %format!("{e:#}"), "git receive: unparsed head, policy skipped");
            None
        }
    };
    let (app, role) = match authorize(&state, &slug, &headers, "push").await {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Some(cmds) = &parsed {
        match git_policy::check_push_policy(&role, cmds) {
            PolicyDecision::Allow => {}
            PolicyDecision::Deny(msg) => {
                return (StatusCode::FORBIDDEN, msg).into_response();
            }
        }
    }
    // Serialize pushes per slug: policy + fast-forward checks stay valid
    // through git + S3 + manifest with no interleaving push.
    let _push_guard = state.git_sync.push_guard(&app.slug).await;
    let bare = match ensure_bare(&state.config, &app.slug).await {
        Ok(b) => b,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    if role != "admin" {
        if let Some(cmds) = &parsed {
            for (refname, old, new) in git_policy::updates_needing_ff(cmds) {
                if !is_fast_forward(&bare, old, new).await {
                    return (
                        StatusCode::FORBIDDEN,
                        format!("rule push-policy: 'push' may not force-push {refname} (admin only)"),
                    )
                        .into_response();
                }
            }
        }
    }
    let before = match list_refs(&bare).await {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    let out = match cmd::run_cmd_stdin(
        "git",
        &[
            "receive-pack",
            "--stateless-rpc",
            bare.to_str().unwrap(),
        ],
        &body,
        None,
        Duration::from_secs(300),
    )
    .await
    {
        Ok(o) => o,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")).into_response(),
    };
    // Deploy fast-path: the reconcile loop tip-polls S3 independently, so a
    // crash here only delays the deploy, never loses it.
    match after_receive(&state, &app, &bare, &before).await {
        Ok(Some(tip)) => {
            if !app.is_stopped() {
                let pool = state.pool.clone();
                let cfg = state.config.clone();
                let procs = state.procs.clone();
                let logs = state.logs.clone();
                let deploying = state.deploying.clone();
                let app = app.clone();
                tokio::spawn(async move {
                    deploy::deploy_tip(&pool, &cfg, &procs, &logs, &deploying, app, tip).await;
                });
            }
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!(slug = %app.slug, error = %format!("{e:#}"), "git receive sync to s3 failed");
            return (StatusCode::CONFLICT, format!("{e:#}")).into_response();
        }
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
