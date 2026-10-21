//! Per-deploy source maps for error symbolication.
//!
//! Noite runs the build, so each deploy keeps its maps next to the bundle and
//! the Errors tab symbolicates stacks at read time — for Worker and browser
//! errors alike, with no upload step:
//!
//! * Worker: `celld deploy` bundles with esbuild but emits no map, so after a
//!   successful deploy the runner re-runs celld's exact esbuild flags over the
//!   same entry with `--sourcemap` added. That shadow bundle is discarded —
//!   only its `.map` is kept, so the deployed bytes stay byte-identical — and
//!   the result is chained through the build's own map when the entry carries
//!   one (a Vite worker build already maps to the original sources).
//! * Browser: only maps the app's build emitted are collected (e.g. Vite
//!   `build.sourcemap: "hidden"`). Maps are never generated for client code,
//!   and what the build serves publicly is unchanged.
//!
//! Layout: `<fleet-bucket>/maps/<deploy-sha>/` holds `worker.js.map`, the
//! client maps under `client/`, and a `manifest.json` naming them. The maps
//! live under the app's own prefix (`fleets/<slug>/`) or the environment's
//! (`envs/<slug>/<label>/`), so app purge, env teardown and renames carry
//! them with no extra path. Retention follows the deploy rows: after a
//! successful deploy, sha dirs outside the recent history are pruned.
//!
//! Grouping is untouched on purpose: fingerprints still hash the raw frames
//! (stable for phase-1 Worker errors, and the envelope POST stays S3-free),
//! so an issue may span deploys whose minified names shifted — each
//! occurrence symbolicates against its own deploy's maps at read time
//! (`service::errors::get`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::errors::Frame;
use super::{exec, s3};
use crate::config::Config;
use crate::db;

/// Maps live beside the fleet state, one sha dir per deploy.
const MAPS_DIR: &str = "maps";
/// `maps/<sha>/manifest.json`: which map belongs to which bundle file.
const MANIFEST_FILE: &str = "manifest.json";
/// `maps/<sha>/worker.js.map`: the Worker bundle's map.
const WORKER_MAP_FILE: &str = "worker.js.map";
/// Client maps live below this so a build file can never collide with the
/// manifest or the worker map.
const CLIENT_MAP_DIR: &str = "client";
/// One map file is telemetry-scale, not bundle-scale: refuse anything bigger
/// (a corrupt or hostile map must not blow the read path's memory).
const MAX_MAP_BYTES: u64 = 8 * 1024 * 1024;
/// Cap on files walked per deploy: maps are small and hashed, so hundreds of
/// them means a misconfigured build, not a real app.
const MAX_MAP_FILES: usize = 200;
/// Parsed maps cached per process: enough for the recent deploys of a busy
/// account, bounded so one giant app cannot grow the runner.
const MAX_CACHED_BYTES: usize = 32 * 1024 * 1024;
/// Deploy sha dirs kept per target besides the just-finished one. Occurrences
/// older than this still render — with their raw, unsymbolicated stacks.
const KEEP_DEPLOY_SHAS: usize = 10;
/// celld 0.6.1 `run_esbuild` externals (`crates/celld/js.rs
/// BARE_NODE_BUILTINS`): node builtins stay external, the runtime provides
/// them. Pinned here so the shadow bundle matches celld's; revisit on a
/// celld bump (docker/check-versions.ts pins CELLD_VERSION).
const ESBUILD_BARE_BUILTINS: &[&str] = &[
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "sqlite",
    "stream",
    "string_decoder",
    "timers",
    "tls",
    "tty",
    "url",
    "util",
    "util/types",
    "v8",
    "vm",
    "worker_threads",
    "zlib",
];

/// Worker entry extensions the shadow esbuild run bundles. Anything else (a
/// Python `main`, an asset-only app with no `main`) means no worker map.
const BUNDLEABLE_EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"];

/// What `maps/<sha>/manifest.json` records: the Worker bundle's map (when
/// one could be built) and every collected client map, each as a
/// deploy-root-relative bundle path → stored map path pair.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapManifest {
    /// Stored map path for the Worker bundle, relative to `maps/<sha>/`.
    #[serde(default)]
    pub worker: Option<String>,
    /// Bundle-relative asset path → stored map path, relative to
    /// `maps/<sha>/`.
    #[serde(default)]
    pub files: HashMap<String, String>,
}

/// `maps/<sha>/` for a fleet-bucket S3 URI (`fleets/<slug>` or
/// `envs/<slug>/<label>` + `/maps/<sha>`). `None` for foreign buckets and
/// non-sha dirs, so a crafted sha can never escape the maps dir.
fn maps_prefix(bucket_uri: &str, bucket: &str, sha: &str) -> Option<String> {
    if !is_key_sha(sha) {
        return None;
    }
    let key = bucket_uri
        .strip_prefix("s3://")?
        .strip_prefix(bucket)?
        .strip_prefix('/')?;
    if key.is_empty() {
        return None;
    }
    Some(format!("{key}/{MAPS_DIR}/{sha}"))
}

/// Deploy shas are git shas; a sha that is not hex would escape the maps dir.
fn is_key_sha(sha: &str) -> bool {
    !sha.is_empty() && sha.len() <= 64 && sha.chars().all(|c| c.is_ascii_hexdigit())
}

/// One frame location split into file + 0-based line/col:
/// `worker.js:21:27` → `("worker.js", 20, 26)`, and a Sentry asset URL keeps
/// its scheme in the file part for the asset matcher below. V8 and Sentry
/// both print 1-based positions; the map lookup is greatest-lower-bound, so a
/// 0-based column convention on either side still lands on its token.
pub fn split_frame_location(location: &str) -> Option<(&str, u32, u32)> {
    let (head, col) = location.rsplit_once(':')?;
    let col: u32 = col.parse().ok()?;
    let (file, line) = head.rsplit_once(':')?;
    let line: u32 = line.parse().ok()?;
    if line == 0 || file.is_empty() {
        return None;
    }
    Some((file, line - 1, col.saturating_sub(1)))
}

/// A frame file with no path and no scheme is the Worker bundle itself
/// (`worker.js`, celld's `index.js` module name) — never a client asset.
fn is_worker_bundle_file(file: &str) -> bool {
    !file.contains('/') && !file.contains("://")
}

/// The asset path a browser frame names: scheme, host and query stripped, no
/// leading slash (`https://h:1/assets/a-b.js:1:2` → `assets/a-b.js`).
pub fn frame_asset_path(location: &str) -> Option<String> {
    let (file, _, _) = split_frame_location(location)?;
    if is_worker_bundle_file(file) {
        return None;
    }
    let without_scheme = file.rsplit("://").next().unwrap_or(file);
    let path = without_scheme
        .split_once('/')
        .map(|(_, rest)| rest)
        .unwrap_or(without_scheme);
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return None;
    }
    Some(path.to_string())
}

/// The stored map path for one frame: the worker map for bundle frames, the
/// manifest's asset entry (exact, then suffix either way for hashed names)
/// for client frames.
fn map_for_frame<'a>(manifest: &'a MapManifest, location: &str) -> Option<&'a str> {
    let (file, _, _) = split_frame_location(location)?;
    // Runtime frames never map to app code. Every other frame maps
    // regardless of the stored `in_app` flag: browser SDK frames arrive
    // without it, and the flag only dims display.
    if super::errors::is_internal(file) {
        return None;
    }
    if is_worker_bundle_file(file) {
        return manifest.worker.as_deref();
    }
    let path = frame_asset_path(location)?;
    if let Some(rel) = manifest.files.get(&path) {
        return Some(rel);
    }
    let mut candidates: Vec<&String> = manifest
        .files
        .iter()
        .filter(|(bundle, _)| bundle.ends_with(path.as_str()) || path.ends_with(bundle.as_str()))
        .map(|(_, map)| map)
        .collect();
    candidates.sort();
    candidates.into_iter().next().map(String::as_str)
}

/// Attach original positions to frames in place, loading maps through `load`.
/// Pure apart from the loader, so unit tests drive it with built maps. Never
/// fails: an unmapped frame keeps its raw (minified) position.
pub fn symbolicate_with(
    frames: &mut [Frame],
    manifest: &MapManifest,
    load: &impl Fn(&str) -> Option<Arc<sourcemap::SourceMap>>,
) -> usize {
    let mut mapped = 0;
    let mut loaded: HashMap<&str, Option<Arc<sourcemap::SourceMap>>> = HashMap::new();
    for frame in frames.iter_mut() {
        if frame.mapped_location.is_some() {
            continue;
        }
        let Some(rel) = map_for_frame(manifest, &frame.location) else {
            continue;
        };
        let sm = loaded.entry(rel).or_insert_with(|| load(rel));
        let Some(sm) = sm.clone() else {
            continue;
        };
        let Some((_, line, col)) = split_frame_location(&frame.location) else {
            continue;
        };
        let Some(token) = sm.lookup_token(line, col) else {
            continue;
        };
        let Some(source) = token.get_source() else {
            continue;
        };
        frame.mapped_location = Some(format!(
            "{}:{}:{}",
            source,
            token.get_src_line() + 1,
            token.get_src_col() + 1
        ));
        if let Some(name) = token.get_name() {
            frame.mapped_function = Some(name.to_string());
        }
        mapped += 1;
    }
    mapped
}

/// Attach original positions to one occurrence's frames from its deploy's
/// maps. Best-effort by contract: a missing manifest, an S3 hiccup or a bad
/// map leaves the raw positions the ingest stored — the read never fails for
/// symbolication.
pub async fn symbolicate_frames(
    cache: &SourceMapCache,
    cfg: &Config,
    bucket: &str,
    prefix: &str,
    sha: &str,
    frames: &mut [Frame],
) {
    if sha.is_empty() || !is_key_sha(sha) {
        return;
    }
    let Some(manifest) = cache.manifest(cfg, prefix, sha).await else {
        return;
    };
    let mut rels: Vec<&str> = frames
        .iter()
        .filter_map(|f| map_for_frame(&manifest, &f.location))
        .collect();
    rels.sort();
    rels.dedup();
    let mut loaded: HashMap<String, Option<Arc<sourcemap::SourceMap>>> = HashMap::new();
    for rel in rels {
        loaded.insert(
            rel.to_string(),
            cache.map(cfg, bucket, prefix, sha, rel).await,
        );
    }
    symbolicate_with(frames, &manifest, &|rel| loaded.get(rel).cloned().flatten());
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    prefix: String,
    sha: String,
    rel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ManifestKey {
    prefix: String,
    sha: String,
}

#[derive(Debug, Default)]
struct CacheInner {
    bytes: usize,
    /// Insertion order for oldest-first eviction.
    order: VecDeque<CacheKey>,
    maps: HashMap<CacheKey, Option<Arc<sourcemap::SourceMap>>>,
    manifests: HashMap<ManifestKey, Option<Arc<MapManifest>>>,
}

/// Parsed maps and manifests, bounded by [`MAX_CACHED_BYTES`]. Entries are
/// immutable per deploy sha, so concurrent duplicate fetches are harmless
/// (last write wins) and nothing is ever awaited under the lock.
#[derive(Debug, Clone, Default)]
pub struct SourceMapCache {
    inner: Arc<Mutex<CacheInner>>,
}

impl SourceMapCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The deploy's manifest, cached negative when no deploy stored one.
    pub async fn manifest(
        &self,
        cfg: &Config,
        prefix: &str,
        sha: &str,
    ) -> Option<Arc<MapManifest>> {
        let key = ManifestKey {
            prefix: prefix.to_string(),
            sha: sha.to_string(),
        };
        if let Some(hit) = poisoned(self.inner.lock()).manifests.get(&key) {
            return hit.clone();
        }
        let loaded = fetch_manifest(cfg, prefix, sha).await;
        poisoned(self.inner.lock())
            .manifests
            .insert(key, loaded.clone());
        loaded
    }

    /// One stored map, parsed: `None` cached for missing, oversize or broken
    /// maps so a bad deploy does not S3-hit every read.
    pub async fn map(
        &self,
        cfg: &Config,
        bucket: &str,
        prefix: &str,
        sha: &str,
        rel: &str,
    ) -> Option<Arc<sourcemap::SourceMap>> {
        let key = CacheKey {
            prefix: prefix.to_string(),
            sha: sha.to_string(),
            rel: rel.to_string(),
        };
        if let Some(hit) = poisoned(self.inner.lock()).maps.get(&key) {
            return hit.clone();
        }
        let loaded = fetch_map(cfg, bucket, prefix, sha, rel).await;
        let mut inner = poisoned(self.inner.lock());
        if let Some(sm) = loaded.as_ref() {
            let bytes = sm_json_len(sm);
            while inner.bytes + bytes > MAX_CACHED_BYTES {
                let Some(oldest) = inner.order.pop_front() else {
                    break;
                };
                if let Some(removed) = inner.maps.remove(&oldest) {
                    inner.bytes = inner
                        .bytes
                        .saturating_sub(removed.as_deref().map(sm_json_len).unwrap_or(0));
                }
            }
            inner.bytes += bytes;
            inner.order.push_back(key.clone());
        }
        inner.maps.insert(key, loaded.clone());
        loaded
    }
}

/// A mutex guard past a poisoned lock: a panicking thread already failed the
/// operation, so the cache keeps serving rather than failing every read.
fn poisoned<T>(guard: Result<T, std::sync::PoisonError<T>>) -> T {
    guard.unwrap_or_else(|e| e.into_inner())
}

/// The full object key for a stored map file, already under the shared
/// bucket: `s3_get_bytes` prepends `s3://{bucket}/` itself, so the bucket
/// must NOT appear here (a doubled prefix reads nothing, forever).
fn map_object_key(prefix: &str, sha: &str, rel: &str) -> String {
    format!("{prefix}/{MAPS_DIR}/{sha}/{rel}")
}

async fn fetch_manifest(cfg: &Config, prefix: &str, sha: &str) -> Option<Arc<MapManifest>> {
    let key = map_object_key(prefix, sha, MANIFEST_FILE);
    let bytes = s3::s3_get_bytes(cfg, &key).await.ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice::<MapManifest>(&bytes)
        .ok()
        .map(Arc::new)
}

async fn fetch_map(
    cfg: &Config,
    bucket: &str,
    prefix: &str,
    sha: &str,
    rel: &str,
) -> Option<Arc<sourcemap::SourceMap>> {
    if rel.contains("..") {
        return None;
    }
    let key = map_object_key(prefix, sha, rel);
    if !matches!(
        s3::s3_head_object(cfg, bucket, &key).await,
        Some(head) if head.size >= 0 && (head.size as u64) <= MAX_MAP_BYTES
    ) {
        return None;
    }
    let bytes = s3::s3_get_bytes(cfg, &key).await.ok()?;
    if bytes.len() as u64 > MAX_MAP_BYTES {
        return None;
    }
    sourcemap::SourceMap::from_slice(&bytes).ok().map(Arc::new)
}

/// Rough weight of a parsed map for the cache bound (re-serialized JSON
/// length: proportional to tokens, names and sources together).
fn sm_json_len(sm: &sourcemap::SourceMap) -> usize {
    let mut bytes = Vec::new();
    if sm.to_writer(&mut bytes).is_err() {
        return 0;
    }
    bytes.len()
}

/// The Worker's map inputs: the deploy root's entry (as celld resolves it)
/// plus whether celld deploys it as-is (`no_bundle`) instead of bundling.
struct WorkerEntry {
    /// Entry relative to the deploy root, as `main` names it.
    rel: PathBuf,
    /// Entry resolved inside the deploy root.
    abs: PathBuf,
    no_bundle: bool,
}

/// celld's entry resolution, minimally: `main` from the deploy root's Wrangler
/// file (`main` is required — an asset-only app has no worker to map).
fn worker_entry(deploy_root: &Path) -> anyhow::Result<Option<WorkerEntry>> {
    let (main, no_bundle) = read_worker_config(deploy_root)?;
    let Some(main) = main else {
        return Ok(None);
    };
    let abs = deploy_root.join(&main);
    let abs = abs
        .canonicalize()
        .with_context(|| format!("worker entry {} does not resolve", abs.display()))?;
    let root = deploy_root.canonicalize()?;
    if !abs.starts_with(&root) {
        anyhow::bail!("worker entry {} escapes the deploy root", abs.display());
    }
    let Some(name) = abs.extension().and_then(|e| e.to_str()) else {
        return Ok(None);
    };
    if !BUNDLEABLE_EXTENSIONS.contains(&name) {
        return Ok(None);
    }
    Ok(Some(WorkerEntry {
        rel: main,
        abs,
        no_bundle,
    }))
}

/// `(main, no_bundle)` from the deploy root's Wrangler file. JSON(C) parses
/// like the runner's other config reads; TOML gets a line scan (only `main`
/// and `no_bundle` are needed, never the full config).
fn read_worker_config(deploy_root: &Path) -> anyhow::Result<(Option<PathBuf>, bool)> {
    for name in ["wrangler.jsonc", "wrangler.json"] {
        let Ok(text) = std::fs::read_to_string(deploy_root.join(name)) else {
            continue;
        };
        let Ok(value) = crate::host::storage::parse_wrangler(&text) else {
            continue;
        };
        let main = value
            .get("main")
            .and_then(|m| m.as_str())
            .map(PathBuf::from);
        let no_bundle = value
            .get("no_bundle")
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        return Ok((main, no_bundle));
    }
    let toml = deploy_root.join("wrangler.toml");
    let Ok(text) = std::fs::read_to_string(&toml) else {
        return Ok((None, false));
    };
    let mut main = None;
    let mut no_bundle = false;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("main") {
            if let Some(value) = toml_string(rest) {
                main = Some(PathBuf::from(value));
            }
        } else if let Some(rest) = line.strip_prefix("no_bundle") {
            no_bundle = rest.split('=').nth(1).is_some_and(|v| v.trim() == "true");
        }
    }
    Ok((main, no_bundle))
}

/// The quoted value of a `key = "value"` TOML line, if that is all it holds.
fn toml_string(rest: &str) -> Option<&str> {
    let value = rest.strip_prefix('=').map(str::trim)?;
    value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .filter(|s| !s.contains('"'))
}

/// The esbuild the image builds workers with: celld's `CELLD_ESBUILD` sidecar
/// when set, else `esbuild` on PATH — the same resolution celld's
/// `run_esbuild` uses.
fn esbuild_bin() -> String {
    std::env::var("CELLD_ESBUILD").unwrap_or_else(|_| "esbuild".to_string())
}

/// celld 0.6.1's exact bundle flags plus `--sourcemap`: the shadow bundle must
/// map the same bytes celld deployed, so every flag that shapes the output is
/// mirrored (no `--minify`: celld does not minify either).
fn esbuild_args(entry: &str, outdir: &str) -> Vec<String> {
    let mut args = vec![
        entry.to_string(),
        "--bundle".to_string(),
        "--format=esm".to_string(),
        "--platform=browser".to_string(),
        "--target=es2024".to_string(),
        "--conditions=workerd,worker,browser".to_string(),
        "--external:node:*".to_string(),
        "--external:cloudflare:*".to_string(),
        "--loader:.wasm=copy".to_string(),
        format!("--outdir={outdir}"),
        "--entry-names=index".to_string(),
        "--sourcemap".to_string(),
    ];
    args.extend(
        ESBUILD_BARE_BUILTINS
            .iter()
            .map(|specifier| format!("--external:{specifier}")),
    );
    args
}

/// Sources in a shadow map point at the temp outdir's neighborhood; rewrite
/// them root-relative so the stored map names repo paths, not build dirs.
fn normalize_sources(
    root: &Path,
    outdir: &Path,
    sm: &sourcemap::SourceMap,
) -> sourcemap::SourceMap {
    let mut builder = sourcemap::SourceMapBuilder::new(None);
    for token in sm.tokens() {
        let source = token
            .get_source()
            .map(|s| relativize_source(root, outdir, s));
        builder.add(
            token.get_dst_line(),
            token.get_dst_col(),
            token.get_src_line(),
            token.get_src_col(),
            source.as_deref(),
            token.get_name(),
            false,
        );
    }
    builder.into_sourcemap()
}

/// A map source as a deploy-root-relative path when it resolves inside the
/// root, else unchanged (absolute build paths never leak into storage when
/// the file is where the bundle read it from). Relative sources resolve
/// against the project root first — esbuild usually records them relative to
/// its working directory — then against the map's own directory.
fn relativize_source(root: &Path, outdir: &Path, source: &str) -> String {
    let candidate = Path::new(source);
    if candidate.is_absolute() {
        return strip_to_root(root, candidate).unwrap_or_else(|| source.to_string());
    }
    [root, outdir]
        .into_iter()
        .filter_map(|base| base.join(candidate).canonicalize().ok())
        .find_map(|abs| strip_to_root(root, &abs))
        .unwrap_or_else(|| source.to_string())
}

/// `abs` as a root-relative slash path, when it lives inside the root.
fn strip_to_root(root: &Path, abs: &Path) -> Option<String> {
    abs.strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

/// Fold the build's own map (when the entry carries a sibling `.map`) into
/// the shadow map: tokens the shadow bundle read from the entry file resolve
/// through the entry's map to the original sources, everything else stays.
/// Both maps are 0-based; the composed map names the build's sources.
pub fn chain_maps(
    outer: &sourcemap::SourceMap,
    inner: &sourcemap::SourceMap,
    entry_source: &str,
) -> sourcemap::SourceMap {
    let mut builder = sourcemap::SourceMapBuilder::new(None);
    for token in outer.tokens() {
        let chained = token
            .get_source()
            .filter(|s| source_is_entry(s, entry_source))
            .and_then(|_| {
                inner
                    .lookup_token(token.get_src_line(), token.get_src_col())
                    .and_then(|t| {
                        t.get_source().map(|source| {
                            (
                                source.to_string(),
                                t.get_src_line(),
                                t.get_src_col(),
                                t.get_name(),
                            )
                        })
                    })
            });
        match chained {
            Some((source, line, col, name)) => {
                builder.add(
                    token.get_dst_line(),
                    token.get_dst_col(),
                    line,
                    col,
                    Some(&source),
                    name.or(token.get_name()),
                    false,
                );
            }
            None => {
                builder.add(
                    token.get_dst_line(),
                    token.get_dst_col(),
                    token.get_src_line(),
                    token.get_src_col(),
                    token.get_source(),
                    token.get_name(),
                    false,
                );
            }
        }
    }
    builder.into_sourcemap()
}

/// The shadow map's entry source, root-relative after normalization; the
/// config may prefix the entry with `./`, so compare without the dot. No
/// basename fallback: an entry named `index.js` must not claim a
/// dependency's same-named file.
fn source_is_entry(source: &str, entry: &str) -> bool {
    trim_dot(source) == trim_dot(entry) && !entry.is_empty()
}

/// The config may prefix the entry with `./` while map sources arrive
/// root-relative — compare without the dot.
fn trim_dot(s: &str) -> &str {
    s.strip_prefix("./").unwrap_or(s)
}

/// Build the Worker map: the shadow esbuild map (chained through the entry's
/// own map when the build emitted one), or the entry's sibling map directly
/// when celld deploys the entry as-is (`no_bundle`). `None` when there is no
/// bundleable entry — asset-only apps and non-JS workers map nothing.
async fn build_worker_map(deploy_root: &Path) -> anyhow::Result<Option<(Vec<u8>, String)>> {
    let Some(entry) = worker_entry(deploy_root)? else {
        return Ok(None);
    };
    let sibling_map = entry.abs.with_file_name(format!(
        "{}.map",
        entry.abs.file_name().unwrap_or_default().to_string_lossy()
    ));
    let sibling_bytes = tokio::fs::read(&sibling_map).await.ok();
    if entry.no_bundle {
        // celld uploads the entry as written: its sibling map already maps
        // the deployed bytes, no shadow bundle needed.
        return Ok(sibling_bytes.map(|bytes| (bytes, "entry map (no_bundle)".to_string())));
    }
    let outdir = std::env::temp_dir().join(format!(
        "noite-esbuild-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&outdir).await?;
    let result = run_shadow_esbuild(deploy_root, &entry, &outdir, sibling_bytes).await;
    let _ = tokio::fs::remove_dir_all(&outdir).await;
    result
}

async fn run_shadow_esbuild(
    deploy_root: &Path,
    entry: &WorkerEntry,
    outdir: &Path,
    sibling_bytes: Option<Vec<u8>>,
) -> anyhow::Result<Option<(Vec<u8>, String)>> {
    let Some(entry_arg) = entry.rel.to_str() else {
        anyhow::bail!("worker entry is not valid UTF-8");
    };
    let Some(outdir_arg) = outdir.to_str() else {
        anyhow::bail!("esbuild outdir is not valid UTF-8");
    };
    let args = esbuild_args(entry_arg, outdir_arg);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec::run_cmd(
        &esbuild_bin(),
        &refs,
        Some(deploy_root),
        &[],
        Duration::from_secs(120),
    )
    .await
    .context("shadow esbuild for the worker map")?;
    let raw = tokio::fs::read(outdir.join("index.js.map"))
        .await
        .context("shadow esbuild wrote no map")?;
    let outer = sourcemap::SourceMap::from_slice(&raw).context("parse shadow map")?;
    let root = deploy_root
        .canonicalize()
        .unwrap_or_else(|_| deploy_root.to_path_buf());
    let normalized = normalize_sources(&root, outdir, &outer);
    let entry_source = entry.rel.to_string_lossy().replace('\\', "/");
    let (composed, note) = match sibling_bytes {
        Some(bytes) => match sourcemap::SourceMap::from_slice(&bytes) {
            Ok(inner) => (
                chain_maps(&normalized, &inner, &entry_source),
                "shadow map chained through the build map".to_string(),
            ),
            Err(_) => (
                normalized,
                "shadow map (build map did not parse)".to_string(),
            ),
        },
        None => (normalized, "shadow map".to_string()),
    };
    let mut out = Vec::new();
    composed.to_writer(&mut out)?;
    Ok(Some((out, note)))
}

/// The manifest key for a collected map: the bundle path stack frames name.
/// `collect_client_maps` yields map paths, so the `.map` suffix comes off —
/// a manifest keyed on `…/app.js.map` would never match a frame's `…/app.js`.
fn manifest_bundle_key(map_rel: &str) -> Option<&str> {
    map_rel.strip_suffix(".map")
}

/// Every `*.map` the build emitted, as deploy-root-relative path + bytes —
/// except the worker entry's own sibling (an intermediate the worker map
/// already chains through, never served as its own map).
fn collect_client_maps(deploy_root: &Path, entry_sibling: Option<&Path>) -> Vec<(String, Vec<u8>)> {
    let mut maps = Vec::new();
    let mut stack = vec![deploy_root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path
                    .file_name()
                    .is_some_and(|n| n == "node_modules" || n.to_string_lossy().starts_with('.'))
                {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("map") {
                continue;
            }
            if maps.len() >= MAX_MAP_FILES {
                return maps;
            }
            if entry_sibling.is_some_and(|s| s == path.as_path()) {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.len() as u64 > MAX_MAP_BYTES {
                continue;
            }
            let Ok(rel) = path.strip_prefix(deploy_root) else {
                continue;
            };
            maps.push((rel.to_string_lossy().replace('\\', "/"), bytes));
        }
    }
    maps.sort_by(|a, b| a.0.cmp(&b.0));
    maps
}

/// Sha dirs under `maps/` that no recent deploy owns anymore. Listed from the
/// bucket so a deploy that never stored maps (or a crashed prune) still
/// converges; sorted for stable logs.
fn prune_victims(listed: &[String], keep: &HashSet<String>) -> Vec<String> {
    let mut victims: Vec<String> = listed
        .iter()
        .filter(|sha| !keep.contains(*sha))
        .cloned()
        .collect();
    victims.sort();
    victims
}

/// Store this deploy's maps and prune sha dirs outside the recent deploy
/// history. Best-effort by contract: the deploy already succeeded, so a
/// failure here is a log line, never a failed deploy.
pub async fn store_deploy_maps(
    pool: &SqlitePool,
    cfg: &Config,
    app_id: &str,
    environment_id: Option<&str>,
    bucket_uri: &str,
    sha: &str,
    deploy_root: &Path,
) -> anyhow::Result<String> {
    if !is_key_sha(sha) {
        anyhow::bail!("refusing to store maps for non-sha {sha:?}");
    }
    let Some(prefix) = maps_prefix(bucket_uri, &cfg.s3_bucket, sha) else {
        anyhow::bail!("bucket {bucket_uri} is outside this install");
    };
    let maps_prefix = prefix;

    let mut manifest = MapManifest::default();
    let mut notes = Vec::new();

    let entry_sibling = worker_entry(deploy_root).ok().flatten().map(|entry| {
        entry.abs.with_file_name(format!(
            "{}.map",
            entry.abs.file_name().unwrap_or_default().to_string_lossy()
        ))
    });
    match build_worker_map(deploy_root).await {
        Ok(Some((bytes, note))) => {
            let key = format!("{maps_prefix}/{WORKER_MAP_FILE}");
            put_bytes(cfg, &key, &bytes).await?;
            manifest.worker = Some(WORKER_MAP_FILE.to_string());
            notes.push(format!("{WORKER_MAP_FILE} ({note})"));
        }
        Ok(None) => notes.push("no worker map (no bundleable entry)".to_string()),
        Err(e) => notes.push(format!("no worker map ({e:#})")),
    }

    let mut client_count = 0;
    for (rel, bytes) in collect_client_maps(deploy_root, entry_sibling.as_deref()) {
        let stored = format!("{CLIENT_MAP_DIR}/{rel}");
        let key = format!("{maps_prefix}/{stored}");
        let Some(bundle) = manifest_bundle_key(&rel) else {
            continue;
        };
        match put_bytes(cfg, &key, &bytes).await {
            Ok(()) => {
                manifest.files.insert(bundle.to_string(), stored);
                client_count += 1;
            }
            Err(e) => notes.push(format!("skipped {rel} ({e:#})")),
        }
    }
    notes.push(format!("{client_count} client maps"));

    let manifest_bytes = serde_json::to_vec_pretty(&manifest).context("serialize map manifest")?;
    put_bytes(
        cfg,
        &format!("{maps_prefix}/{MANIFEST_FILE}"),
        &manifest_bytes,
    )
    .await?;

    let pruned = prune_old_maps(pool, cfg, app_id, environment_id, &maps_prefix, sha).await?;
    if pruned > 0 {
        notes.push(format!("pruned {pruned} old deploys"));
    }
    Ok(notes.join(", "))
}

/// Delete `maps/<sha>/` dirs no recent deploy owns. Reads the keep set from
/// the deploy rows (the maps follow the deploys' own retention) and lists the
/// bucket so crashed prunes converge.
async fn prune_old_maps(
    pool: &SqlitePool,
    cfg: &Config,
    app_id: &str,
    environment_id: Option<&str>,
    maps_prefix: &str,
    sha: &str,
) -> anyhow::Result<usize> {
    let mut keep: HashSet<String> = HashSet::new();
    keep.insert(sha.to_string());
    if let Ok(deploys) = db::list_deploys(pool, app_id, environment_id).await {
        for deploy in deploys {
            if deploy.status_enum() == Some(crate::models::DeployStatus::Success) {
                if let Some(deploy_sha) = deploy.sha {
                    keep.insert(deploy_sha);
                    if keep.len() > KEEP_DEPLOY_SHAS + 1 {
                        break;
                    }
                }
            }
        }
    }
    // Deploys list newest first: the break above keeps the newest successes.
    // `maps/` holds one dir per sha; strip that level to sha names.
    let Some(dir) = maps_prefix.strip_suffix(&format!("/{sha}")) else {
        return Ok(0);
    };
    let mut listed = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let page = s3::s3_list_page(
            cfg,
            &cfg.s3_bucket,
            &format!("{dir}/"),
            Some("/"),
            1000,
            continuation.as_deref(),
        )
        .await?;
        listed.extend(page.prefixes.iter().filter_map(|p| {
            p.strip_prefix(&format!("{dir}/"))
                .and_then(|s| s.strip_suffix('/'))
                .filter(|s| is_key_sha(s))
                .map(str::to_string)
        }));
        continuation = page.next;
        if continuation.is_none() {
            break;
        }
    }
    let mut pruned = 0;
    for victim in prune_victims(&listed, &keep) {
        if s3::s3_rm_prefix(cfg, &cfg.s3_bucket, &format!("{dir}/{victim}/"))
            .await
            .is_ok()
        {
            pruned += 1;
        }
    }
    Ok(pruned)
}

async fn put_bytes(cfg: &Config, key: &str, bytes: &[u8]) -> anyhow::Result<()> {
    let dest = std::env::temp_dir().join(format!("noite-map-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&dest, bytes).await?;
    let result = s3::s3_cp_upload(cfg, &dest, key)
        .await
        .with_context(|| format!("upload {key}"));
    let _ = tokio::fs::remove_file(&dest).await;
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One zero-based token map: `generated -> (source:line:col, name)`.
    type MapEntries<'a> = [((u32, u32), (&'a str, u32, u32), Option<&'a str>)];
    fn built_map(entries: &MapEntries<'_>) -> sourcemap::SourceMap {
        let mut builder = sourcemap::SourceMapBuilder::new(None);
        for ((dst_line, dst_col), (source, src_line, src_col), name) in entries {
            builder.add(
                *dst_line,
                *dst_col,
                *src_line,
                *src_col,
                Some(source),
                *name,
                false,
            );
        }
        builder.into_sourcemap()
    }

    fn frame_at(location: &str) -> Frame {
        Frame {
            function: "min".to_string(),
            location: location.to_string(),
            in_app: true,
            mapped_function: None,
            mapped_location: None,
        }
    }

    #[test]
    fn splits_bundle_and_url_locations() {
        assert_eq!(
            split_frame_location("worker.js:21:27"),
            Some(("worker.js", 20, 26))
        );
        assert_eq!(
            split_frame_location("https://h:8080/assets/a-b.js:1:523"),
            Some(("https://h:8080/assets/a-b.js", 0, 522))
        );
        assert_eq!(split_frame_location("native"), None);
        assert_eq!(split_frame_location("worker.js:0:1"), None);
        assert_eq!(split_frame_location("no-colons-here"), None);
    }

    #[test]
    fn extracts_asset_paths() {
        assert_eq!(
            frame_asset_path("https://h:8080/assets/a-b.js:1:523"),
            Some("assets/a-b.js".to_string())
        );
        assert_eq!(
            frame_asset_path("/assets/a-b.js:1:523"),
            Some("assets/a-b.js".to_string())
        );
        assert_eq!(frame_asset_path("worker.js:21:27"), None);
        assert_eq!(frame_asset_path("native"), None);
    }

    #[test]
    fn worker_frames_use_the_worker_map() {
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            files: HashMap::from([(
                "assets/a.js".to_string(),
                "client/assets/a.js.map".to_string(),
            )]),
        };
        assert_eq!(
            map_for_frame(&manifest, "worker.js:21:27"),
            Some("worker.js.map")
        );
        assert_eq!(
            map_for_frame(&manifest, "index.js:2:3"),
            Some("worker.js.map")
        );
        assert_eq!(
            map_for_frame(&manifest, "https://h/assets/a.js:1:2"),
            Some("client/assets/a.js.map")
        );
        assert_eq!(map_for_frame(&manifest, "https://h/assets/b.js:1:2"), None);
    }

    #[test]
    fn symbolication_attaches_original_positions() {
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            files: HashMap::new(),
        };
        let sm = built_map(&[((20, 26), ("src/worker.ts", 4, 7), Some("charge"))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        let mut frames = vec![frame_at("worker.js:21:27")];
        assert_eq!(symbolicate_with(&mut frames, &manifest, &load), 1);
        assert_eq!(
            frames[0].mapped_location.as_deref(),
            Some("src/worker.ts:5:8")
        );
        assert_eq!(frames[0].mapped_function.as_deref(), Some("charge"));
        // Raw position stays for the minified fallback.
        assert_eq!(frames[0].location, "worker.js:21:27");
        assert_eq!(frames[0].function, "min");
    }

    #[test]
    fn symbolication_skips_what_it_cannot_map() {
        let manifest = MapManifest::default();
        let sm = built_map(&[((20, 26), ("src/worker.ts", 4, 7), Some("charge"))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        let mut frames = vec![
            frame_at("worker.js:99:99"),
            Frame {
                location: "node:fs:1:1".to_string(),
                ..frame_at("worker.js:21:27")
            },
        ];
        assert_eq!(symbolicate_with(&mut frames, &manifest, &load), 0);
        // No worker map in the manifest: nothing attaches.
        assert!(frames[0].mapped_location.is_none());
        // Runtime frames never map, whatever their stored flag.
        assert!(frames[1].mapped_location.is_none());
    }

    #[test]
    fn symbolication_maps_browser_frames_without_the_in_app_flag() {
        // Stock browser SDKs send no `in_app` flag; the frames still resolve
        // through the asset maps by location alone.
        let manifest = MapManifest {
            worker: None,
            files: HashMap::from([(
                "client/assets/app.js".to_string(),
                "client/client/assets/app.js.map".to_string(),
            )]),
        };
        let sm = built_map(&[((0, 522), ("src/client.ts", 12, 4), Some("boom"))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        let mut frames = vec![Frame {
            in_app: false,
            ..frame_at("https://app.example/assets/app.js:1:523")
        }];
        assert_eq!(symbolicate_with(&mut frames, &manifest, &load), 1);
        assert_eq!(
            frames[0].mapped_location.as_deref(),
            Some("src/client.ts:13:5")
        );
        assert_eq!(frames[0].mapped_function.as_deref(), Some("boom"));
    }

    #[test]
    fn chaining_resolves_through_the_build_map() {
        // Shadow map: deployed bundle line 0 → built entry line 10.
        let outer = built_map(&[((0, 5), ("dist/app/index.js", 10, 3), Some("bundleFn"))]);
        // Build map: built entry line 10 → original source line 2.
        let inner = built_map(&[((10, 3), ("src/index.ts", 2, 0), Some("realFn"))]);
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let token = chained.lookup_token(0, 5).expect("chained token");
        assert_eq!(token.get_source(), Some("src/index.ts"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (2, 0));
        assert_eq!(token.get_name(), Some("realFn"));
    }

    #[test]
    fn chaining_keeps_tokens_outside_the_entry() {
        let outer = built_map(&[
            ((0, 5), ("dist/app/index.js", 10, 3), Some("bundleFn")),
            ((1, 0), ("dist/app/dep.js", 0, 0), None),
        ]);
        let inner = built_map(&[((10, 3), ("src/index.ts", 2, 0), Some("realFn"))]);
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let dep = chained.lookup_token(1, 0).expect("dep token");
        assert_eq!(dep.get_source(), Some("dist/app/dep.js"));
        assert_eq!(dep.get_name(), None);
    }

    #[test]
    fn chaining_falls_back_when_the_build_map_misses() {
        // Below the inner map's first token the greatest-lower-bound lookup
        // finds nothing: the outer position survives unchained.
        let outer = built_map(&[((0, 5), ("dist/app/index.js", 0, 0), Some("bundleFn"))]);
        let inner = built_map(&[((10, 3), ("src/index.ts", 2, 0), Some("realFn"))]);
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let token = chained.lookup_token(0, 5).expect("outer token");
        assert_eq!(token.get_source(), Some("dist/app/index.js"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (0, 0));
    }

    #[test]
    fn prune_keeps_recent_shas_only() {
        let listed = vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()];
        let keep: HashSet<String> = HashSet::from(["bbb".to_string()]);
        assert_eq!(prune_victims(&listed, &keep), vec!["aaa", "ccc"]);
        assert!(prune_victims(&listed, &listed.iter().cloned().collect()).is_empty());
    }

    #[test]
    fn entry_match_ignores_a_dot_prefix_but_not_basenames() {
        assert!(source_is_entry("index.js", "./index.js"));
        assert!(source_is_entry("dist/app/index.js", "dist/app/index.js"));
        assert!(!source_is_entry("other/index.js", "src/index.js"));
        assert!(!source_is_entry("index.js", ""));
    }

    #[test]
    fn sources_resolve_against_the_project_root_first() {
        let root =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).expect("temp dir");
        std::fs::write(root.join("src/app.ts"), "export {}").expect("source");
        let outdir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outdir).expect("outdir");
        // esbuild records inputs relative to its working directory (the
        // root), not to the temp outdir the map lands in.
        assert_eq!(
            relativize_source(&root, &outdir, "src/app.ts"),
            "src/app.ts"
        );
        assert_eq!(
            relativize_source(&root, &outdir, "src/missing.ts"),
            "src/missing.ts"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outdir);
    }

    #[test]
    fn worker_entry_reads_wrangler_main() {
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("entry.ts"), "export default {}").expect("entry");
        std::fs::write(
            dir.join("wrangler.jsonc"),
            "// config\n{\"main\": \"./entry.ts\", \"no_bundle\": false}\n",
        )
        .expect("config");
        let found = worker_entry(&dir).expect("entry").expect("some");
        assert_eq!(found.rel, PathBuf::from("./entry.ts"));
        assert!(!found.no_bundle);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn maps_prefix_rejects_foreign_buckets() {
        assert_eq!(
            maps_prefix("s3://bucket/fleets/app", "bucket", "abc123"),
            Some("fleets/app/maps/abc123".to_string())
        );
        assert_eq!(
            maps_prefix("s3://bucket/envs/app/preview", "bucket", "abc123"),
            Some("envs/app/preview/maps/abc123".to_string())
        );
        assert_eq!(
            maps_prefix("s3://other/fleets/app", "bucket", "abc123"),
            None
        );
        assert_eq!(
            maps_prefix("s3://bucket/fleets/app", "bucket", "../evil"),
            None
        );
    }

    #[test]
    fn key_sha_validation() {
        assert!(is_key_sha("abc123"));
        assert!(is_key_sha("ABCDEF0123456789"));
        assert!(!is_key_sha(""));
        assert!(!is_key_sha("../evil"));
        assert!(!is_key_sha("not a sha"));
    }

    #[test]
    fn manifest_keys_name_bundles_not_maps() {
        // Regression: keys once kept the `.map` suffix, so no frame path
        // ever matched and browser stacks stayed minified.
        assert_eq!(
            manifest_bundle_key("client/assets/app.js.map"),
            Some("client/assets/app.js")
        );
        assert_eq!(manifest_bundle_key("app.js"), None);
    }

    #[test]
    fn map_keys_carry_no_bucket_prefix() {
        // Regression: the read path once prefixed the bucket a second time,
        // so every manifest/map fetch missed and nothing ever symbolicated.
        assert_eq!(
            map_object_key("fleets/app", "abc123", "worker.js.map"),
            "fleets/app/maps/abc123/worker.js.map"
        );
    }
}
