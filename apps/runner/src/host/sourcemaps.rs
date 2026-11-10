//! Per-deploy source maps for error symbolication.
//!
//! Noite runs the build, so each deploy keeps its maps next to the bundle and
//! the Errors tab symbolicates stacks at read time — for Worker and browser
//! errors alike, with no upload step:
//!
//! * Worker: the deploy passes `--sourcemap <path>` to `celld deploy`, which
//!   writes the bundled Worker's external map with project-root-relative
//!   sources (the deployed bytes are identical with or without the flag) —
//!   and, for a `no_bundle` entry, collects the entry's sibling
//!   `<entry>.map` the same way. The runner stores that map, chained
//!   through the build's own map when the entry carries one (a Vite worker
//!   build already maps to the original sources; a collected `no_bundle`
//!   map chains as a pass-through, its sources already original). A missing
//!   map file means celld had nothing to map (asset-only or Python projects
//!   warn and write nothing, as does a `no_bundle` entry without a sibling
//!   map celld accepts), so those deploys store no worker map.
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
use std::time::{Duration, Instant};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::errors::Frame;
use super::s3;
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
/// All maps stored for one deploy, worker map included: the per-file cap
/// alone would let a hostile build land gigabytes per deploy (times the
/// retained sha dirs). Past this, client maps are skipped in walk order with
/// a deploy-log note.
const TOTAL_MAP_BYTES_PER_DEPLOY: u64 = 64 * 1024 * 1024;
/// Parsed maps cached per process: enough for the recent deploys of a busy
/// account, bounded so one giant app cannot grow the runner.
const MAX_CACHED_BYTES: usize = 32 * 1024 * 1024;
/// Distinct maps fetched per `errors.get`: a normal issue needs one or two,
/// and a hostile manifest must not fan out hundreds of S3 reads.
const MAX_MAPS_PER_GET: usize = 8;
/// Frames attempted per `errors.get`: past this the rest stay raw instead of
/// burning executor time on a pathological stack.
const MAX_FRAMES_PER_GET: usize = 256;
/// Deploy sha dirs kept per target besides the just-finished one. Occurrences
/// older than this still render — with their raw, unsymbolicated stacks.
const KEEP_DEPLOY_SHAS: usize = 10;

/// Worker entry extensions celld bundles (and maps with `--sourcemap`).
/// Anything else (a Python `main`, an asset-only app with no `main`) means
/// no worker map: celld warns and writes nothing.
const BUNDLEABLE_EXTENSIONS: &[&str] = &["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"];

/// What `maps/<sha>/manifest.json` records: the Worker bundle's map (when
/// one could be built) and every collected client map, each as a
/// deploy-root-relative bundle path → stored map path pair.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapManifest {
    /// Stored map path for the Worker bundle, relative to `maps/<sha>/`.
    #[serde(default)]
    pub worker: Option<String>,
    /// The assets directory the client maps live under, deploy-root-relative
    /// (`client` when the bundle key is `client/assets/app.js`). A served
    /// frame path (`assets/app.js`) matches the bundle key exactly once
    /// this prefix is re-attached — no suffix guessing across hashed names.
    #[serde(default)]
    pub assets_dir: Option<String>,
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

/// The fleet prefix an error's maps live under: the environment's own
/// `envs/<slug>/<label>` when the occurrence belongs to one, else the app's
/// `fleets/<slug>`. Symbolication resolves each occurrence against its own
/// deploy's maps (`service::errors::get`).
pub fn error_maps_prefix(slug: &str, env_label: Option<&str>) -> String {
    match env_label {
        Some(label) => format!("envs/{slug}/{label}"),
        None => format!("fleets/{slug}"),
    }
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
    // Exact match only: the bundle key is `{assets_dir}/{served path}` (or
    // the full key for root-level maps). Suffix guessing attached the wrong
    // map across hashed sibling names, so it is gone on purpose.
    if let Some(dir) = manifest.assets_dir.as_deref() {
        if let Some(rel) = manifest.files.get(&format!("{dir}/{path}")) {
            return Some(rel);
        }
        return None;
    }
    manifest.files.get(&path).map(String::as_str)
}

/// Abuse bounds for one `errors.get`: distinct maps fetched and frames
/// attempted. A normal issue uses one map and dozens of frames; a hostile
/// manifest (hundreds of rels) or a pathological stack stops here and renders
/// the rest raw, instead of fanning S3 reads and executor time out.
#[derive(Debug, Clone)]
pub struct SymbolicateBudget {
    pub maps: usize,
    pub frames: usize,
    /// `(sha, rel)` pairs already charged in this read, so a map shared by
    /// many occurrences costs the budget once (cache hits included).
    pub seen: HashSet<(String, String)>,
}

impl SymbolicateBudget {
    pub fn for_read() -> Self {
        Self {
            maps: MAX_MAPS_PER_GET,
            frames: MAX_FRAMES_PER_GET,
            seen: HashSet::new(),
        }
    }
}

/// Attach original positions to frames in place, loading maps through `load`.
/// Pure apart from the loader, so unit tests drive it with built maps. Never
/// fails: an unmapped frame keeps its raw (minified) position. Stops loading
/// new maps and attempting frames past the budget, leaving the rest raw.
pub fn symbolicate_with(
    frames: &mut [Frame],
    manifest: &MapManifest,
    load: &impl Fn(&str) -> Option<Arc<sourcemap::SourceMap>>,
    budget: &mut SymbolicateBudget,
) -> usize {
    let mut mapped = 0;
    let mut loaded: HashMap<&str, Option<Arc<sourcemap::SourceMap>>> = HashMap::new();
    for frame in frames.iter_mut() {
        if frame.mapped_location.is_some() {
            continue;
        }
        if budget.frames == 0 {
            break;
        }
        let Some(rel) = map_for_frame(manifest, &frame.location) else {
            continue;
        };
        let hit = loaded.get(rel).cloned();
        let sm = match hit {
            Some(hit) => hit,
            None => {
                if budget.maps == 0 {
                    continue;
                }
                budget.maps -= 1;
                let fetched = load(rel);
                loaded.insert(rel, fetched.clone());
                fetched
            }
        };
        let Some(sm) = sm else {
            continue;
        };
        budget.frames -= 1;
        let Some((_, line, col)) = split_frame_location(&frame.location) else {
            continue;
        };
        let Some(token) = sm.lookup_token(line, col) else {
            continue;
        };
        let Some(source) = token.get_source() else {
            continue;
        };
        // Clip like the raw frames: map contents are tenant-controlled.
        frame.mapped_location = Some(super::errors::clip(
            &format!(
                "{}:{}:{}",
                source,
                token.get_src_line() + 1,
                token.get_src_col() + 1
            ),
            super::errors::MAX_MESSAGE,
        ));
        if let Some(name) = token.get_name() {
            frame.mapped_function = Some(super::errors::clip(name, super::errors::MAX_MESSAGE));
        }
        mapped += 1;
    }
    mapped
}

/// Attach original positions to one occurrence's frames from its deploy's
/// maps. Best-effort by contract: a missing manifest, an S3 hiccup or a bad
/// map leaves the raw positions the ingest stored — the read never fails for
/// symbolication. The budget caps distinct maps fetched and frames attempted
/// for the whole `errors.get`, and is shared across its events.
pub async fn symbolicate_frames(
    cache: &SourceMapCache,
    cfg: &Config,
    bucket: &str,
    prefix: &str,
    sha: &str,
    frames: &mut [Frame],
    budget: &mut SymbolicateBudget,
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
        if !charge_map(budget, sha, rel) {
            continue;
        }
        loaded.insert(
            rel.to_string(),
            cache.map(cfg, bucket, prefix, sha, rel).await,
        );
    }
    // The maps above are already charged; the inner pass spends frame
    // attempts only, so one event's maps never cost the budget twice.
    let mut inner = SymbolicateBudget {
        maps: usize::MAX,
        frames: budget.frames,
        seen: HashSet::new(),
    };
    symbolicate_with(
        frames,
        &manifest,
        &|rel| loaded.get(rel).cloned().flatten(),
        &mut inner,
    );
    budget.frames = inner.frames;
}

/// Whether `symbolicate_frames` may load `rel` for `sha`: an unseen pair
/// costs one map from the budget, a repeat rides on the first charge (cache
/// hits included), and an unseen pair past the budget stays raw.
fn charge_map(budget: &mut SymbolicateBudget, sha: &str, rel: &str) -> bool {
    let key = (sha.to_string(), rel.to_string());
    if budget.seen.contains(&key) {
        return true;
    }
    if budget.maps == 0 {
        return false;
    }
    budget.maps -= 1;
    budget.seen.insert(key);
    true
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

/// One entry in the shared eviction order (maps and manifests evict oldest
/// first out of the same byte budget, negatives included).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum CachedKey {
    Map(CacheKey),
    Manifest(ManifestKey),
}

/// Weight of a cached negative entry: the two keys are the bulk of it.
const NEGATIVE_ENTRY_WEIGHT: usize = 256;
/// How long a missing manifest or map stays cached: the store uploads both
/// after the bundle, so a deploy's first errors can arrive before they exist.
/// Past this the next read refetches instead of rendering raw for the life of
/// the process — a map uploaded a minute after its first error still gets
/// symbolicated.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(60);

/// What a fetch found: a usable value, a permanent absence, or a failure
/// that must not be cached. Only the first two enter the cache — a hiccup
/// (timeout, 5xx, refused HEAD) retries on the next read instead of
/// disabling symbolication until the runner restarts.
enum FetchOutcome<T> {
    Hit(T, usize),
    Missing,
    Transient,
}

/// One cache slot. `value: None` is a cached absence, and `since` records
/// when it was cached (`Some` exactly then) so the entry expires; `weight` is
/// its share of the shared byte bound.
#[derive(Debug)]
struct CacheEntry<T> {
    value: Option<T>,
    weight: usize,
    since: Option<Instant>,
}

impl<T> CacheEntry<T> {
    fn hit(value: T, weight: usize) -> Self {
        Self {
            value: Some(value),
            weight,
            since: None,
        }
    }

    fn missing(weight: usize) -> Self {
        Self {
            value: None,
            weight,
            since: Some(Instant::now()),
        }
    }

    /// A negative entry past [`NEGATIVE_CACHE_TTL`] is a miss again.
    fn expired(&self) -> bool {
        self.value.is_none()
            && self
                .since
                .is_some_and(|at| at.elapsed() > NEGATIVE_CACHE_TTL)
    }

    fn cloned_value(&self) -> Option<T>
    where
        T: Clone,
    {
        self.value.clone()
    }
}

#[derive(Debug, Default)]
struct CacheInner {
    bytes: usize,
    /// Insertion order for oldest-first eviction, across maps and manifests.
    order: VecDeque<CachedKey>,
    maps: HashMap<CacheKey, CacheEntry<Arc<sourcemap::SourceMap>>>,
    manifests: HashMap<ManifestKey, CacheEntry<Arc<MapManifest>>>,
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

    /// The deploy's manifest, cached negative while no deploy stored one.
    /// Manifests share the maps' byte budget (negatives included), so one
    /// entry per sha ever read cannot grow the runner. A negative entry
    /// expires after [`NEGATIVE_CACHE_TTL`] (the manifest uploads last),
    /// and a fetch failure is not cached at all.
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
        // The guard drops at the block end, before the fetch below: a
        // `std` mutex held across `.await` would make this future `!Send`.
        let hit = {
            let mut inner = poisoned(self.inner.lock());
            cached_manifest(&mut inner, &key)
        };
        if let Some(hit) = hit {
            return hit;
        }
        // Weighed before locking: the fetch (and the parse it will do for
        // maps) never runs under the mutex.
        match fetch_manifest(cfg, prefix, sha).await {
            FetchOutcome::Hit(loaded, weight) => {
                let mut inner = poisoned(self.inner.lock());
                insert_manifest(&mut inner, key, Some(loaded.clone()), weight);
                Some(loaded)
            }
            FetchOutcome::Missing => {
                let mut inner = poisoned(self.inner.lock());
                insert_manifest(&mut inner, key, None, NEGATIVE_ENTRY_WEIGHT);
                None
            }
            FetchOutcome::Transient => None,
        }
    }

    /// One stored map, parsed: `None` cached for missing, oversize or broken
    /// maps so a bad deploy does not S3-hit every read. A fetch failure is
    /// not cached: the next read retries instead of staying raw.
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
        // Same guard discipline as `manifest`: the lock is released before
        // the fetch below.
        let hit = {
            let mut inner = poisoned(self.inner.lock());
            cached_map(&mut inner, &key)
        };
        if let Some(hit) = hit {
            return hit;
        }
        match fetch_map(cfg, bucket, prefix, sha, rel).await {
            FetchOutcome::Hit(loaded, weight) => {
                let mut inner = poisoned(self.inner.lock());
                insert_map(&mut inner, key, Some(loaded.clone()), weight);
                Some(loaded)
            }
            FetchOutcome::Missing => {
                let mut inner = poisoned(self.inner.lock());
                insert_map(&mut inner, key, None, NEGATIVE_ENTRY_WEIGHT);
                None
            }
            FetchOutcome::Transient => None,
        }
    }
}

/// The cached map for `key`, if it is still valid: an expired negative entry
/// is dropped (its bytes and eviction slot released) so the caller refetches.
fn cached_map(inner: &mut CacheInner, key: &CacheKey) -> Option<Option<Arc<sourcemap::SourceMap>>> {
    if inner.maps.get(key).is_some_and(CacheEntry::expired) {
        forget(inner, &CachedKey::Map(key.clone()));
        return None;
    }
    inner.maps.get(key).map(CacheEntry::cloned_value)
}

/// The cached manifest for `key`, if it is still valid: an expired negative
/// entry is dropped (its bytes and eviction slot released) so the caller
/// refetches.
fn cached_manifest(inner: &mut CacheInner, key: &ManifestKey) -> Option<Option<Arc<MapManifest>>> {
    if inner.manifests.get(key).is_some_and(CacheEntry::expired) {
        forget(inner, &CachedKey::Manifest(key.clone()));
        return None;
    }
    inner.manifests.get(key).map(CacheEntry::cloned_value)
}

/// Drop `key`'s entry, its bytes and its eviction slot. Every cached key
/// holds exactly one slot in `order`: a key inserted twice (two reads that
/// missed together) or re-inserted after expiring must not leave its old
/// bytes counted or a stale slot that evicts the fresh entry early.
fn forget(inner: &mut CacheInner, key: &CachedKey) {
    let removed = match key {
        CachedKey::Map(key) => inner.maps.remove(key).map(|entry| entry.weight),
        CachedKey::Manifest(key) => inner.manifests.remove(key).map(|entry| entry.weight),
    };
    if let Some(weight) = removed {
        inner.bytes = inner.bytes.saturating_sub(weight);
        inner.order.retain(|queued| queued != key);
    }
}

/// Insert one manifest, evicting oldest-first across maps and manifests so
/// the shared byte bound holds (negatives included).
fn insert_manifest(
    inner: &mut CacheInner,
    key: ManifestKey,
    value: Option<Arc<MapManifest>>,
    weight: usize,
) {
    forget(inner, &CachedKey::Manifest(key.clone()));
    evict_until_fit(inner, weight);
    inner.bytes += weight;
    inner.order.push_back(CachedKey::Manifest(key.clone()));
    let entry = match value {
        Some(value) => CacheEntry::hit(value, weight),
        None => CacheEntry::missing(weight),
    };
    inner.manifests.insert(key, entry);
}

/// Insert one parsed map, same shared bound and negative expiry as
/// manifests.
fn insert_map(
    inner: &mut CacheInner,
    key: CacheKey,
    value: Option<Arc<sourcemap::SourceMap>>,
    weight: usize,
) {
    forget(inner, &CachedKey::Map(key.clone()));
    evict_until_fit(inner, weight);
    inner.bytes += weight;
    inner.order.push_back(CachedKey::Map(key.clone()));
    let entry = match value {
        Some(value) => CacheEntry::hit(value, weight),
        None => CacheEntry::missing(weight),
    };
    inner.maps.insert(key, entry);
}

/// Make room for `extra` bytes, oldest first, across maps and manifests.
fn evict_until_fit(inner: &mut CacheInner, extra: usize) {
    while inner.bytes + extra > MAX_CACHED_BYTES {
        let Some(oldest) = inner.order.pop_front() else {
            break;
        };
        let removed = match oldest {
            CachedKey::Map(key) => inner.maps.remove(&key).map(|entry| entry.weight),
            CachedKey::Manifest(key) => inner.manifests.remove(&key).map(|entry| entry.weight),
        };
        if let Some(weight) = removed {
            inner.bytes = inner.bytes.saturating_sub(weight);
        }
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

/// A deploy's manifest. `Missing` (never stored, oversize, unparseable) is
/// cached negative; `Transient` (the store hiccuped) is never cached.
async fn fetch_manifest(cfg: &Config, prefix: &str, sha: &str) -> FetchOutcome<Arc<MapManifest>> {
    let key = map_object_key(prefix, sha, MANIFEST_FILE);
    let bytes = match s3::s3_get_bytes(cfg, &key).await {
        Ok(bytes) => bytes,
        Err(e) if s3::is_not_found(&e) => return FetchOutcome::Missing,
        Err(_) => return FetchOutcome::Transient,
    };
    if bytes.len() > 1024 * 1024 {
        return FetchOutcome::Missing;
    }
    match serde_json::from_slice::<MapManifest>(&bytes)
        .ok()
        .map(Arc::new)
    {
        Some(manifest) => FetchOutcome::Hit(manifest, bytes.len()),
        None => FetchOutcome::Missing,
    }
}

/// One stored map. Confined to the sha's own dir: a hostile manifest entry
/// (`..`, an absolute path) never reaches S3, and a `rel` that names another
/// sha still lands inside this sha's prefix (flat keys, no traversal).
/// Parsing runs off the async executor. A refused HEAD proves nothing (the
/// store answers `None` for missing and for failures alike), so it falls
/// through to the GET, whose error tells them apart.
async fn fetch_map(
    cfg: &Config,
    bucket: &str,
    prefix: &str,
    sha: &str,
    rel: &str,
) -> FetchOutcome<Arc<sourcemap::SourceMap>> {
    if rel.contains("..") || rel.starts_with('/') {
        return FetchOutcome::Missing;
    }
    let key = map_object_key(prefix, sha, rel);
    match s3::s3_head_object(cfg, bucket, &key).await {
        Some(head) if head.size >= 0 && (head.size as u64) <= MAX_MAP_BYTES => {}
        Some(_) => return FetchOutcome::Missing,
        None => {}
    }
    let bytes = match s3::s3_get_bytes(cfg, &key).await {
        Ok(bytes) => bytes,
        Err(e) if s3::is_not_found(&e) => return FetchOutcome::Missing,
        Err(_) => return FetchOutcome::Transient,
    };
    if bytes.len() as u64 > MAX_MAP_BYTES {
        return FetchOutcome::Missing;
    }
    let weight = bytes.len();
    let parsed = tokio::task::spawn_blocking(move || sourcemap::SourceMap::from_slice(&bytes))
        .await
        .ok()
        .and_then(|parsed| parsed.ok())
        .map(Arc::new);
    match parsed {
        Some(sm) => FetchOutcome::Hit(sm, weight),
        None => FetchOutcome::Missing,
    }
}

/// The Worker's map input: the deploy root's entry (as celld resolves it),
/// whose sibling map the celld map chains through when the build emitted one.
struct WorkerEntry {
    /// Entry relative to the deploy root, as `main` names it.
    rel: PathBuf,
    /// Entry resolved inside the deploy root.
    abs: PathBuf,
}

/// celld's entry resolution, minimally: `main` from the deploy root's Wrangler
/// file (`main` is required — an asset-only app has no worker to map).
fn worker_entry(deploy_root: &Path) -> anyhow::Result<Option<WorkerEntry>> {
    let config = read_worker_config(deploy_root)?;
    let Some(main) = config.main else {
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
    Ok(Some(WorkerEntry { rel: main, abs }))
}

/// The deploy root's Wrangler file, minimally: `main` (required — an
/// asset-only app has no worker to map) and the assets directory the client
/// maps live under (for exact frame→map matching; TOML `[assets]` tables are
/// skipped and then matching falls back to full keys).
struct DeployWorkerConfig {
    main: Option<PathBuf>,
    assets_dir: Option<String>,
}

/// The deploy root's Wrangler file, minimally: parsed like the runner's other
/// config reads for JSON(C); TOML gets a line scan (only `main` there — a
/// TOML `[assets]` table is skipped and matching falls back to full keys).
fn read_worker_config(deploy_root: &Path) -> anyhow::Result<DeployWorkerConfig> {
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
        // Normalized through path segments: configs write `"./public"` or
        // `"./dist/client"`, while manifest keys are deploy-root-relative
        // (`public/...`) — a kept `./` prefix would never exact-match. `.`
        // segments drop out; `..` refuses the value (matching falls back to
        // full keys) rather than letting a frame lookup escape the root.
        let assets_dir = value
            .get("assets")
            .and_then(|a| a.get("directory"))
            .and_then(|d| d.as_str())
            .map(|d| {
                d.replace('\\', "/")
                    .split('/')
                    .filter(|seg| !seg.is_empty() && *seg != ".")
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|segs| !segs.is_empty() && !segs.iter().any(|s| s == ".."))
            .map(|segs| segs.join("/"));
        return Ok(DeployWorkerConfig { main, assets_dir });
    }
    let toml = deploy_root.join("wrangler.toml");
    let Ok(text) = std::fs::read_to_string(&toml) else {
        return Ok(DeployWorkerConfig {
            main: None,
            assets_dir: None,
        });
    };
    let mut main = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("main") {
            if let Some(value) = toml_string(rest) {
                main = Some(PathBuf::from(value));
            }
        }
    }
    Ok(DeployWorkerConfig {
        main,
        assets_dir: None,
    })
}

/// The quoted value of a `key = "value"` TOML line, if that is all it holds.
fn toml_string(rest: &str) -> Option<&str> {
    let value = rest.strip_prefix('=').map(str::trim)?;
    value
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .filter(|s| !s.contains('"'))
}

/// Fold the build's own map (when the entry carries a sibling `.map`) into
/// the celld map: tokens the bundle read from the entry file resolve
/// through the entry's map to the original sources, everything else stays.
/// Both maps are 0-based; the composed map names the build's sources.
/// Token counts are capped ([`MAX_CHAIN_TOKENS`]): past that the outer map
/// passes through unchained instead of burning the deploy task.
///
/// A map source safe to store or log: absolute host paths (a symlink escape,
/// a build-host absolute) become their file name; relative sources —
/// including the `../..` form every Vite build emits — stay intact for
/// display.
fn sanitized_source_name(source: &str) -> &str {
    if source.starts_with('/') {
        source.rsplit('/').next().unwrap_or(source)
    } else {
        source
    }
}

/// Distinct source names for deploy-log diagnostics, capped at `limit`, cut
/// through the same rule as stored sources so the log never leaks a
/// build-host absolute the store itself refuses.
fn distinct_sources(sm: &sourcemap::SourceMap, limit: usize) -> Vec<String> {
    let mut sources: Vec<String> = sm
        .tokens()
        .filter_map(|t| t.get_source())
        .map(|s| sanitized_source_name(s).to_string())
        .collect();
    sources.sort();
    sources.dedup();
    sources.truncate(limit);
    sources
}
pub fn chain_maps(
    outer: &sourcemap::SourceMap,
    inner: &sourcemap::SourceMap,
    entry_source: &str,
) -> sourcemap::SourceMap {
    let mut builder = sourcemap::SourceMapBuilder::new(None);
    let indexed = (outer.tokens().count() <= MAX_CHAIN_TOKENS)
        .then(|| InnerIndex::new(inner))
        .flatten();
    for token in outer.tokens() {
        let chained = token
            .get_source()
            .filter(|s| source_is_entry(s, entry_source))
            .and_then(|_| {
                indexed
                    .as_ref()
                    .and_then(|idx| idx.nearest(token.get_src_line(), token.get_src_col()))
            })
            .map(|t| {
                (
                    t.get_source().unwrap_or_default().to_string(),
                    t.get_src_line(),
                    t.get_src_col(),
                    t.get_name(),
                )
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

/// The celld map's entry source, already project-root-relative; the
/// config may prefix the entry with `./`, so compare without the dot. No
/// basename fallback: an entry named `index.js` must not claim a
/// dependency's same-named file.
fn source_is_entry(source: &str, entry: &str) -> bool {
    trim_dot(source) == trim_dot(entry) && !entry.is_empty()
}

/// Lines around a query that still name the same statement: V8 async frames
/// can land on a generated wrapper line while the executing code sits
/// beside it, and only a small window stays an honest guess.
const INNER_SEARCH_LINES: u32 = 4;
/// Token counts indexed and composed per chain: past this the outer map
/// passes through unchained instead of burning the deploy task on a hostile
/// (or merely enormous) build map.
const MAX_CHAIN_TOKENS: usize = 20_000;

/// The build map's sourced tokens, indexed by generated line (each vec sorted
/// by column, as the iterator yields them), so chaining resolves with binary
/// searches instead of a full scan per outer token.
struct InnerIndex<'a> {
    lines: HashMap<u32, Vec<sourcemap::Token<'a>>>,
}

impl<'a> InnerIndex<'a> {
    /// `None` when the map holds more sourced tokens than chaining will
    /// spend time on (the caller passes the outer map through unchained).
    fn new(inner: &'a sourcemap::SourceMap) -> Option<Self> {
        let mut lines: HashMap<u32, Vec<sourcemap::Token<'a>>> = HashMap::new();
        let mut count = 0;
        for token in inner.tokens() {
            if token.get_source().is_none() {
                continue;
            }
            count += 1;
            if count > MAX_CHAIN_TOKENS {
                return None;
            }
            lines.entry(token.get_dst_line()).or_default().push(token);
        }
        Some(Self { lines })
    }

    /// The token an outer source position resolves through: the nearest
    /// sourced token on the same generated line, else the nearest sourced
    /// token within [`INNER_SEARCH_LINES`] lines. `None` past that window,
    /// so a position far from any mapped code keeps the outer (built)
    /// position instead of inventing an original one.
    fn nearest(&self, line: u32, col: u32) -> Option<sourcemap::Token<'_>> {
        if let Some(tokens) = self.lines.get(&line) {
            if let Some(token) = nearest_col(tokens, col) {
                return Some(token);
            }
        }
        let mut best: Option<(u32, sourcemap::Token<'_>)> = None;
        for dist in 1..=INNER_SEARCH_LINES {
            for candidate in [line.checked_sub(dist), line.checked_add(dist)]
                .into_iter()
                .flatten()
            {
                let Some(tokens) = self.lines.get(&candidate) else {
                    continue;
                };
                let Some(token) = nearest_col(tokens, col) else {
                    continue;
                };
                let distance = dist * 1_000 + token.get_dst_col().abs_diff(col).min(999);
                if best.is_none_or(|(best_distance, _)| distance < best_distance) {
                    best = Some((distance, token));
                }
            }
        }
        best.map(|(_, token)| token)
    }
}

/// The token nearest to `col` in a column-sorted line, if the line maps
/// anything at all.
fn nearest_col<'s, 'a>(tokens: &'s [sourcemap::Token<'a>], col: u32) -> Option<sourcemap::Token<'s>>
where
    'a: 's,
{
    if tokens.is_empty() {
        return None;
    }
    let at = tokens.partition_point(|t| t.get_dst_col() < col);
    let mut best: Option<(u32, sourcemap::Token<'_>)> = None;
    for token in tokens
        .get(at.saturating_sub(1)..)
        .iter()
        .flat_map(|w| w.iter().take(2))
    {
        let distance = token.get_dst_col().abs_diff(col);
        if best.is_none_or(|(best_distance, _)| distance < best_distance) {
            best = Some((distance, *token));
        }
    }
    best.map(|(_, token)| token)
}

/// The config may prefix the entry with `./` while map sources arrive
/// root-relative — compare without the dot.
fn trim_dot(s: &str) -> &str {
    s.strip_prefix("./").unwrap_or(s)
}

/// A map file the store may keep: the per-file cap applies to the build's
/// own maps too, not just collected and fetched ones.
fn fits_map_bytes(len: u64) -> bool {
    len <= MAX_MAP_BYTES
}

/// Open `path` without following a final symlink and read at most
/// [`MAX_MAP_BYTES`]. `Ok(None)` when the file is missing; an error for a
/// symlink, a non-regular file, or an oversize file. Refusal and cap hold
/// against a concurrent writer: the checks run on the opened descriptor, and
/// the read stops one byte past the cap whatever the file grows to.
async fn read_regular_capped(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    use tokio::io::AsyncReadExt;
    let file = match tokio::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .await
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // O_NOFOLLOW on a symlink answers ELOOP.
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err(std::io::Error::other("not a regular file"));
        }
        Err(e) => return Err(e),
    };
    let meta = file.metadata().await?;
    if !meta.file_type().is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    if !fits_map_bytes(meta.len()) {
        return Err(std::io::Error::other("over 8 MiB"));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_MAP_BYTES + 1).read_to_end(&mut bytes).await?;
    if !fits_map_bytes(bytes.len() as u64) {
        return Err(std::io::Error::other("over 8 MiB"));
    }
    Ok(Some(bytes))
}

/// Read a map file from the tenant-built tree, capped at [`MAX_MAP_BYTES`].
/// `None` on any IO error, oversize, or symlink: a `dist/leak.map ->
/// /data/<secret>` link must not become a stored map.
async fn read_capped_map(path: &Path) -> Option<Vec<u8>> {
    read_regular_capped(path).await.ok().flatten()
}

/// The Worker map celld wrote for this deploy, ready to store.
#[derive(Debug)]
pub(crate) struct WorkerMap {
    pub map: Vec<u8>,
    pub note: String,
}

/// Read the Worker map `celld deploy --sourcemap` wrote: chained through the
/// entry's own map when the build emitted one (a Vite worker build already
/// maps to the original sources; a collected `no_bundle` map chains as a
/// pass-through), sanitized like any stored map. `None` when the map file is
/// missing — celld warns and writes nothing for asset-only and Python
/// projects, and for a `no_bundle` entry without a sibling map it accepts —
/// so those deploys store no worker map. Runs after a successful deploy; the
/// bytes upload with the rest of the maps.
pub(crate) async fn read_celld_worker_map(
    deploy_root: &Path,
    map_path: &Path,
) -> anyhow::Result<Option<WorkerMap>> {
    // Never follow symlinks and never read past the cap into memory: the
    // deploy removes this path before celld runs, but a planted link that
    // survived (or a rerun against a dirty work dir) must not become a
    // stored map or a memory spike.
    let Some(map_bytes) = read_regular_capped(map_path)
        .await
        .context("read the celld source map")?
    else {
        return Ok(None);
    };
    let outer =
        sourcemap::SourceMap::from_slice(&map_bytes).context("parse the celld source map")?;
    // celld's sources are already project-root-relative, so the map chains
    // directly; without a bundleable entry there is no sibling to chain
    // through and the map stores as written.
    let Some(entry) = worker_entry(deploy_root)? else {
        let mut out = Vec::new();
        sanitize_sources(&outer).to_writer(&mut out)?;
        return Ok(Some(WorkerMap {
            map: out,
            note: "celld map".to_string(),
        }));
    };
    let sibling_map = entry.abs.with_file_name(format!(
        "{}.map",
        entry.abs.file_name().unwrap_or_default().to_string_lossy()
    ));
    let sibling_bytes = read_capped_map(&sibling_map).await;
    let entry_source = entry.rel.to_string_lossy().replace('\\', "/");
    let (composed, note) = match sibling_bytes {
        Some(bytes) => match sourcemap::SourceMap::from_slice(&bytes) {
            Ok(inner) => {
                let chained = chain_maps(&outer, &inner, &entry_source);
                // Deploy-log diagnostics: the entry the celld map was chained
                // through, plus both maps' source sets (first few), so a
                // mismatch is diagnosable from the deploy log alone.
                let note = format!(
                    "celld map chained through the build map (entry {entry_source}; outer {:?}; inner {:?})",
                    distinct_sources(&outer, 3),
                    distinct_sources(&inner, 3),
                );
                (chained, note)
            }
            Err(_) => (outer, "celld map (build map did not parse)".to_string()),
        },
        None => (outer, "celld map".to_string()),
    };
    let mut out = Vec::new();
    sanitize_sources(&composed).to_writer(&mut out)?;
    Ok(Some(WorkerMap { map: out, note }))
}

/// Drop absolute host paths down to their file names before anything is
/// stored: chaining already ran on the full strings, so entry matching is
/// unaffected, and no host-absolute path reaches the bucket or the UI.
/// Relative sources carry no host information and stay intact, since the UI
/// renders them as the original path.
fn sanitize_sources(sm: &sourcemap::SourceMap) -> sourcemap::SourceMap {
    let mut builder = sourcemap::SourceMapBuilder::new(None);
    for token in sm.tokens() {
        let source = token
            .get_source()
            .map(|s| sanitized_source_name(s).to_string());
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

/// The manifest key for a collected map: the bundle path stack frames name.
/// `collect_client_maps` yields map paths, so the `.map` suffix comes off —
/// a manifest keyed on `…/app.js.map` would never match a frame's `…/app.js`.
fn manifest_bundle_key(map_rel: &str) -> Option<&str> {
    map_rel.strip_suffix(".map")
}

/// Keep client maps while they fit the deploy's remaining byte budget
/// (sorted walk order, so the kept set is deterministic); the rest are
/// skipped and the caller notes the count. The manifest counts the same
/// bytes its `files` entries point at.
fn cap_client_maps(
    maps: Vec<(String, Vec<u8>)>,
    budget: &mut u64,
) -> (Vec<(String, Vec<u8>)>, usize) {
    let mut kept = Vec::new();
    let mut skipped = 0;
    for (rel, bytes) in maps {
        let len = bytes.len() as u64;
        if len <= *budget {
            *budget -= len;
            kept.push((rel, bytes));
        } else {
            skipped += 1;
        }
    }
    (kept, skipped)
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
            // Never follow tenant symlinks out of the worktree: a
            // `dist/leak.map -> /data/<secret>` link (or a directory link
            // into `/data`) must not become a stored map. `file_type` does
            // not follow links, unlike `path.is_dir`.
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
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
#[derive(Debug, Clone, Copy)]
pub struct StoreMaps<'a> {
    pub app_id: &'a str,
    pub environment_id: Option<&'a str>,
    pub bucket_uri: &'a str,
    pub sha: &'a str,
    pub deploy_root: &'a Path,
}

pub async fn store_deploy_maps(
    pool: &SqlitePool,
    cfg: &Config,
    target: &StoreMaps<'_>,
    worker_map: Result<Option<WorkerMap>, String>,
) -> anyhow::Result<String> {
    let StoreMaps {
        app_id,
        environment_id,
        bucket_uri,
        sha,
        deploy_root,
    } = *target;
    // Environment deploys store under their own `envs/<slug>/<label>/` prefix
    // (via `maps_prefix`) and prune against the environment's own deploy
    // history, exactly like production.
    if !is_key_sha(sha) {
        anyhow::bail!("refusing to store maps for non-sha {sha:?}");
    }
    let Some(prefix) = maps_prefix(bucket_uri, &cfg.s3_bucket, sha) else {
        anyhow::bail!("bucket {bucket_uri} is outside this install");
    };
    let maps_prefix = prefix;

    let mut manifest = MapManifest::default();
    let mut notes = Vec::new();

    // The assets dir the client keys are relative to (exact frame→map
    // matching re-attaches it to the served path). Best-effort like the
    // rest: without it, only full-key matches resolve.
    manifest.assets_dir = read_worker_config(deploy_root)
        .ok()
        .and_then(|c| c.assets_dir);

    let entry_sibling = worker_entry(deploy_root).ok().flatten().map(|entry| {
        entry.abs.with_file_name(format!(
            "{}.map",
            entry.abs.file_name().unwrap_or_default().to_string_lossy()
        ))
    });
    let mut worker_bytes = 0u64;
    match worker_map {
        Ok(Some(built)) => {
            worker_bytes = built.map.len() as u64;
            let key = format!("{maps_prefix}/{WORKER_MAP_FILE}");
            put_bytes(cfg, &key, &built.map).await?;
            manifest.worker = Some(WORKER_MAP_FILE.to_string());
            notes.push(format!("{} ({})", WORKER_MAP_FILE, built.note));
        }
        Ok(None) => notes.push(
            "no worker map (celld wrote no map: asset-only, Python, or no_bundle without a sibling map)"
                .to_string(),
        ),
        Err(note) => notes.push(format!("no worker map ({note})")),
    }

    // One deploy's maps stay small in aggregate: a hostile build cannot turn
    // the per-file cap into gigabytes of stored maps.
    let mut budget = TOTAL_MAP_BYTES_PER_DEPLOY.saturating_sub(worker_bytes);
    let collected = collect_client_maps(deploy_root, entry_sibling.as_deref());
    let (kept, skipped) = cap_client_maps(collected, &mut budget);
    if skipped > 0 {
        notes.push(format!("client maps capped at 64 MiB ({skipped} skipped)"));
    }
    let mut client_count = 0;
    for (rel, bytes) in kept {
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

/// Sha dirs worth keeping: the just-finished deploy plus the newest
/// successful deploy shas (newest first from the deploy rows), capped. The
/// current sha is always kept — prune can never delete the deploy that just
/// stored.
fn keep_shas(current: &str, rows: impl Iterator<Item = (Option<String>, bool)>) -> HashSet<String> {
    let mut keep: HashSet<String> = HashSet::from([current.to_string()]);
    for (sha, success) in rows {
        if !success {
            continue;
        }
        let Some(sha) = sha else {
            continue;
        };
        if keep.len() > KEEP_DEPLOY_SHAS {
            break;
        }
        keep.insert(sha);
    }
    keep
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
    // Without the deploy history the keep set is just this sha, and the
    // prune below would delete every older deploy's maps (which can never
    // be rebuilt). Fail closed instead: the deploy already succeeded, and
    // the caller logs the error without failing it.
    // Deploys list newest first: the break inside keeps the newest successes.
    let deploys = db::list_deploys(pool, app_id, environment_id)
        .await
        .context("list deploys for map retention")?;
    let keep = keep_shas(
        sha,
        deploys.iter().map(|d| {
            (
                d.sha.clone(),
                d.status_enum() == Some(crate::models::DeployStatus::Success),
            )
        }),
    );
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

    /// The deploy layout the read sees: the map celld wrote (sources already
    /// project-root-relative) beside a deploy root whose built entry carries
    /// its own sibling map. The stored map chains through the sibling to the
    /// original sources — assert exact composed positions, the composition
    /// the Errors tab reads at `errors.get` time.
    #[tokio::test]
    async fn celld_map_chains_through_the_build_map() {
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("app");
        std::fs::create_dir_all(root.join("dist")).expect("entry dir");
        std::fs::write(
            root.join("wrangler.jsonc"),
            "// config\n{\"main\": \"./dist/worker.js\"}\n",
        )
        .expect("config");
        std::fs::write(root.join("dist").join("worker.js"), "console.log(1);").expect("entry");
        // The build's own map: built entry line 10 → original source line 2.
        let mut inner_bytes = Vec::new();
        built_map(&[((10, 3), ("src/index.ts", 2, 0), Some("realFn"))])
            .to_writer(&mut inner_bytes)
            .expect("inner map");
        std::fs::write(root.join("dist").join("worker.js.map"), &inner_bytes).expect("sibling");
        // celld's map: deployed bundle line 0 → built entry line 10, with
        // the project-root-relative source celld writes.
        let mut outer_bytes = Vec::new();
        built_map(&[((0, 5), ("dist/worker.js", 10, 3), Some("bundleFn"))])
            .to_writer(&mut outer_bytes)
            .expect("outer map");
        let map_path = dir.join("worker.js.map");
        std::fs::write(&map_path, &outer_bytes).expect("celld map");

        let built = read_celld_worker_map(&root, &map_path)
            .await
            .expect("readable")
            .expect("a map");
        assert!(
            built.note.contains("chained through the build map"),
            "unexpected note: {}",
            built.note
        );
        let stored = sourcemap::SourceMap::from_slice(&built.map).expect("stored map parses");
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            assets_dir: None,
            files: HashMap::new(),
        };
        let load = |_: &str| Some(Arc::new(stored.clone()));
        // The deployed throw site, 1-based as V8 prints it.
        let mut frames = vec![frame_at("worker.js:1:6")];
        let mut budget = SymbolicateBudget::for_read();
        assert_eq!(
            symbolicate_with(&mut frames, &manifest, &load, &mut budget),
            1
        );
        assert_eq!(
            frames[0].mapped_location.as_deref(),
            Some("src/index.ts:3:1")
        );
        assert_eq!(frames[0].mapped_function.as_deref(), Some("realFn"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_celld_map_means_no_worker_map() {
        // celld warns and writes nothing for asset-only and Python projects
        // (and for a `no_bundle` entry without a sibling map it accepts):
        // a missing file is `None`, never an error.
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("wrangler.json"), "{\"main\": \"./worker.js\"}").expect("config");
        let found = read_celld_worker_map(&dir, &dir.join("worker.js.map"))
            .await
            .expect("missing is not an error");
        assert!(found.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `no_bundle` entry map stores again: celld collects the entry's
    /// sibling map (sources already project-root-relative), and the read
    /// keeps it — chaining passes through the tokens that never named the
    /// entry, so the stored map still resolves to the original sources.
    #[tokio::test]
    async fn no_bundle_entry_map_stores_through_the_collected_sibling() {
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("app");
        std::fs::create_dir_all(root.join("dist")).expect("entry dir");
        std::fs::write(
            root.join("wrangler.json"),
            "{\"main\": \"./dist/worker.js\", \"no_bundle\": true}",
        )
        .expect("config");
        std::fs::write(root.join("dist").join("worker.js"), "console.log(1);").expect("entry");
        // The build's own map: entry line 0 → original source line 2.
        let mut sibling_bytes = Vec::new();
        built_map(&[((0, 5), ("src/index.ts", 2, 0), Some("realFn"))])
            .to_writer(&mut sibling_bytes)
            .expect("sibling map");
        std::fs::write(root.join("dist").join("worker.js.map"), &sibling_bytes).expect("sibling");
        // celld's collection: the sibling's mappings, sources rebased to
        // project-root-relative — already the originals here.
        let map_path = dir.join("worker.js.map");
        std::fs::write(&map_path, &sibling_bytes).expect("celld map");

        let built = read_celld_worker_map(&root, &map_path)
            .await
            .expect("readable")
            .expect("a map");
        assert!(built.note.contains("celld map"), "{}", built.note);
        let stored = sourcemap::SourceMap::from_slice(&built.map).expect("stored map parses");
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            assets_dir: None,
            files: HashMap::new(),
        };
        let load = |_: &str| Some(Arc::new(stored.clone()));
        // The deployed throw site, 1-based as V8 prints it.
        let mut frames = vec![frame_at("worker.js:1:6")];
        let mut budget = SymbolicateBudget::for_read();
        assert_eq!(
            symbolicate_with(&mut frames, &manifest, &load, &mut budget),
            1
        );
        assert_eq!(
            frames[0].mapped_location.as_deref(),
            Some("src/index.ts:3:1")
        );
        assert_eq!(frames[0].mapped_function.as_deref(), Some("realFn"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unparseable_celld_map_fails_the_worker_map() {
        // A corrupt map must not store: the deploy logs the note and keeps
        // serving raw stacks instead of shifting every mapping.
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let map_path = dir.join("worker.js.map");
        std::fs::write(&map_path, "{ not a map").expect("corrupt map");
        let err = read_celld_worker_map(&dir, &map_path)
            .await
            .expect_err("a corrupt map fails the read");
        assert!(
            format!("{err:#}").contains("parse the celld source map"),
            "unexpected error: {err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn planted_symlink_map_is_refused() {
        // The deploy unlinks the map path before celld runs; a link that
        // survived (or a rerun against a dirty work dir) must not be
        // followed into a stored map.
        use std::os::unix::fs::symlink;
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut outer_bytes = Vec::new();
        built_map(&[((0, 0), ("dist/worker.js", 0, 0), None)])
            .to_writer(&mut outer_bytes)
            .expect("outer map");
        let target = dir.join("planted.js.map");
        std::fs::write(&target, &outer_bytes).expect("planted map");
        let map_path = dir.join("worker.js.map");
        symlink(&target, &map_path).expect("planted link");
        let err = read_celld_worker_map(&dir, &map_path)
            .await
            .expect_err("a symlink map fails the read");
        assert!(
            format!("{err:#}").contains("not a regular file"),
            "unexpected error: {err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn chained_note_carries_no_absolute_host_paths() {
        // The deploy-log diagnostics name both maps' source sets; absolute
        // build-host paths become file names there, as in storage.
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("app");
        std::fs::create_dir_all(root.join("dist")).expect("entry dir");
        std::fs::write(
            root.join("wrangler.json"),
            "{\"main\": \"./dist/worker.js\"}",
        )
        .expect("config");
        std::fs::write(root.join("dist").join("worker.js"), "console.log(1);").expect("entry");
        let mut inner_bytes = Vec::new();
        built_map(&[((10, 3), ("/data/build/src/index.ts", 2, 0), None)])
            .to_writer(&mut inner_bytes)
            .expect("inner map");
        std::fs::write(root.join("dist").join("worker.js.map"), &inner_bytes).expect("sibling");
        let mut outer_bytes = Vec::new();
        built_map(&[((0, 5), ("dist/worker.js", 10, 3), None)])
            .to_writer(&mut outer_bytes)
            .expect("outer map");
        let map_path = dir.join("worker.js.map");
        std::fs::write(&map_path, &outer_bytes).expect("celld map");

        let built = read_celld_worker_map(&root, &map_path)
            .await
            .expect("readable")
            .expect("a map");
        assert!(
            !built.note.contains("/data/build"),
            "note leaks a host path: {}",
            built.note
        );
        assert!(
            built.note.contains("index.ts"),
            "note lost the source name: {}",
            built.note
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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
            assets_dir: None,
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
            assets_dir: None,
            files: HashMap::new(),
        };
        let sm = built_map(&[((20, 26), ("src/worker.ts", 4, 7), Some("charge"))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        let mut frames = vec![frame_at("worker.js:21:27")];
        assert_eq!(
            symbolicate_with(
                &mut frames,
                &manifest,
                &load,
                &mut SymbolicateBudget::for_read()
            ),
            1
        );
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
        assert_eq!(
            symbolicate_with(
                &mut frames,
                &manifest,
                &load,
                &mut SymbolicateBudget::for_read()
            ),
            0
        );
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
            assets_dir: Some("client".to_string()),
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
        assert_eq!(
            symbolicate_with(
                &mut frames,
                &manifest,
                &load,
                &mut SymbolicateBudget::for_read()
            ),
            1
        );
        assert_eq!(
            frames[0].mapped_location.as_deref(),
            Some("src/client.ts:13:5")
        );
        assert_eq!(frames[0].mapped_function.as_deref(), Some("boom"));
    }

    #[test]
    fn mismatched_hashes_do_not_attach_the_wrong_map() {
        // Exact matching only: a hashed sibling name must not resolve
        // through a different hash's map.
        let manifest = MapManifest {
            worker: None,
            assets_dir: Some("client".to_string()),
            files: HashMap::from([(
                "client/assets/app-DEADBEEF.js".to_string(),
                "client/client/assets/app-DEADBEEF.js.map".to_string(),
            )]),
        };
        assert_eq!(
            map_for_frame(&manifest, "https://app.example/assets/app-12345678.js:1:2"),
            None
        );
    }

    #[tokio::test]
    async fn env_deploys_store_like_production() {
        // Environment deploys store under their own `envs/<slug>/<label>/`
        // prefix: the store no longer skips them, so an env target reaches
        // the same bucket validation as production before touching S3.
        let pool = crate::db::connect("sqlite::memory:")
            .await
            .expect("in-memory pool");
        let cfg = crate::config::config_for_tests();
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let target = StoreMaps {
            app_id: "app-id",
            environment_id: Some("env-id"),
            bucket_uri: "s3://other/envs/app/preview",
            sha: "abc123",
            deploy_root: &dir,
        };
        let err = store_deploy_maps(&pool, &cfg, &target, Ok(None))
            .await
            .expect_err("a foreign bucket refuses the env deploy, never skips it");
        assert!(
            err.to_string().contains("outside this install"),
            "unexpected error: {err:#}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn budget_stops_loading_maps_and_attempting_frames() {
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            assets_dir: Some("client".to_string()),
            files: HashMap::from([
                (
                    "client/assets/a.js".to_string(),
                    "client/client/assets/a.js.map".to_string(),
                ),
                (
                    "client/assets/b.js".to_string(),
                    "client/client/assets/b.js.map".to_string(),
                ),
            ]),
        };
        let sm = built_map(&[((0, 0), ("src/a.ts", 0, 0), Some("a"))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        // One map allowed: the second asset's frames stay raw.
        let mut frames = vec![
            frame_at("https://h/assets/a.js:1:1"),
            frame_at("https://h/assets/b.js:1:1"),
        ];
        let mut budget = SymbolicateBudget {
            maps: 1,
            frames: 10,
            seen: HashSet::new(),
        };
        assert_eq!(
            symbolicate_with(&mut frames, &manifest, &load, &mut budget),
            1
        );
        assert!(frames[0].mapped_location.is_some());
        assert!(frames[1].mapped_location.is_none());
        // No frame attempts left: nothing else maps.
        let mut frames = vec![frame_at("https://h/assets/a.js:1:1")];
        let mut budget = SymbolicateBudget {
            maps: 10,
            frames: 0,
            seen: HashSet::new(),
        };
        assert_eq!(
            symbolicate_with(&mut frames, &manifest, &load, &mut budget),
            0
        );
        assert!(frames[0].mapped_location.is_none());
    }

    #[test]
    fn map_budget_charges_once_per_pair_across_events() {
        // One event, one map: repeats of the same `(sha, rel)` ride on the
        // first charge (cache hits included), instead of draining the
        // budget once per occurrence.
        let mut budget = SymbolicateBudget::for_read();
        assert!(charge_map(&mut budget, "abc123", "client/a.js.map"));
        assert_eq!(budget.maps, MAX_MAPS_PER_GET - 1);
        assert!(charge_map(&mut budget, "abc123", "client/a.js.map"));
        assert_eq!(budget.maps, MAX_MAPS_PER_GET - 1);
        // Another sha's same rel is a different fetch: charged again.
        assert!(charge_map(&mut budget, "def456", "client/a.js.map"));
        assert_eq!(budget.maps, MAX_MAPS_PER_GET - 2);
        // Past the budget, unseen pairs stay raw but seen ones still load.
        let mut budget = SymbolicateBudget {
            maps: 1,
            frames: 10,
            seen: HashSet::new(),
        };
        assert!(charge_map(&mut budget, "abc123", "a.map"));
        assert!(!charge_map(&mut budget, "abc123", "b.map"));
        assert!(charge_map(&mut budget, "abc123", "a.map"));
    }

    #[test]
    fn expired_negative_maps_refetch() {
        // A map uploaded a moment after a deploy's first error must still be
        // picked up: a cached absence expires exactly like a manifest's
        // instead of leaving the stack raw for the runner's lifetime.
        let mut inner = CacheInner::default();
        let key = CacheKey {
            prefix: "fleets/a".to_string(),
            sha: "abc123".to_string(),
            rel: "worker.js.map".to_string(),
        };
        insert_map(&mut inner, key.clone(), None, NEGATIVE_ENTRY_WEIGHT);
        assert!(cached_map(&mut inner, &key).is_some_and(|hit| hit.is_none()));
        let stale = Instant::now()
            .checked_sub(NEGATIVE_CACHE_TTL + Duration::from_secs(1))
            .expect("backdate");
        if let Some(entry) = inner.maps.get_mut(&key) {
            entry.since = Some(stale);
        }
        assert!(cached_map(&mut inner, &key).is_none(), "expired is a miss");
        assert!(
            !inner.maps.contains_key(&key),
            "the slot and bytes are freed"
        );
        assert_eq!(inner.bytes, 0);
        assert!(inner.order.is_empty(), "the eviction slot is gone too");
    }

    #[test]
    fn expired_negative_manifests_refetch() {
        // The manifest uploads last, so a deploy's first errors can arrive
        // before it exists: a missing entry must expire instead of rendering
        // raw for the life of the process.
        let mut inner = CacheInner::default();
        let key = ManifestKey {
            prefix: "fleets/a".to_string(),
            sha: "abc123".to_string(),
        };
        insert_manifest(&mut inner, key.clone(), None, NEGATIVE_ENTRY_WEIGHT);
        assert!(cached_manifest(&mut inner, &key).is_some_and(|hit| hit.is_none()));
        // Backdated past the TTL (no sleeping in tests): treated as a miss
        // and dropped, so the next read refetches.
        let stale = Instant::now()
            .checked_sub(NEGATIVE_CACHE_TTL + Duration::from_secs(1))
            .expect("backdate");
        inner.manifests.insert(
            key.clone(),
            CacheEntry {
                value: None,
                weight: NEGATIVE_ENTRY_WEIGHT,
                since: Some(stale),
            },
        );
        assert!(cached_manifest(&mut inner, &key).is_none());
        assert!(!inner.manifests.contains_key(&key));
        assert_eq!(inner.bytes, 0);
        // A stored manifest never expires.
        insert_manifest(
            &mut inner,
            key.clone(),
            Some(Arc::new(MapManifest::default())),
            128,
        );
        assert!(cached_manifest(&mut inner, &key).is_some());
    }

    #[test]
    fn reinserting_a_key_counts_its_bytes_and_slot_once() {
        // Two reads that miss together both insert the same key. Counting it
        // twice drifted the byte total up for good, until every insert
        // emptied the cache; a stale slot also evicted the fresh entry early.
        let mut inner = CacheInner::default();
        let map = CacheKey {
            prefix: "fleets/app".to_string(),
            sha: "abc123".to_string(),
            rel: "worker.js.map".to_string(),
        };
        insert_map(&mut inner, map.clone(), None, 300);
        insert_map(&mut inner, map.clone(), None, 500);
        assert_eq!(inner.bytes, 500);
        assert_eq!(inner.order.len(), 1);

        let manifest = ManifestKey {
            prefix: "fleets/app".to_string(),
            sha: "abc123".to_string(),
        };
        insert_manifest(&mut inner, manifest.clone(), None, NEGATIVE_ENTRY_WEIGHT);
        insert_manifest(
            &mut inner,
            manifest.clone(),
            Some(Arc::new(MapManifest::default())),
            128,
        );
        assert_eq!(inner.bytes, 628);
        assert_eq!(inner.order.len(), 2);

        // An expired negative manifest releases its slot too, so the
        // refetched entry is the only one queued for it.
        let stale = Instant::now()
            .checked_sub(NEGATIVE_CACHE_TTL + Duration::from_secs(1))
            .expect("backdate");
        let missing = ManifestKey {
            prefix: "fleets/app".to_string(),
            sha: "def456".to_string(),
        };
        insert_manifest(&mut inner, missing.clone(), None, NEGATIVE_ENTRY_WEIGHT);
        if let Some(entry) = inner.manifests.get_mut(&missing) {
            entry.since = Some(stale);
        }
        assert!(cached_manifest(&mut inner, &missing).is_none());
        assert_eq!(inner.order.len(), 2);
        assert_eq!(inner.bytes, 628);
    }

    #[test]
    fn cache_evicts_oldest_first_across_kinds() {
        // One shared byte bound for maps and manifests, negatives included:
        // the oldest entry goes first no matter its kind.
        let mut inner = CacheInner::default();
        let map_key = |rel: &str| CacheKey {
            prefix: "fleets/app".to_string(),
            sha: "abc123".to_string(),
            rel: rel.to_string(),
        };
        let manifest_key = ManifestKey {
            prefix: "fleets/app".to_string(),
            sha: "abc123".to_string(),
        };
        insert_manifest(
            &mut inner,
            manifest_key.clone(),
            Some(Arc::new(MapManifest::default())),
            MAX_CACHED_BYTES - 1000,
        );
        insert_map(
            &mut inner,
            map_key("old.js.map"),
            None,
            NEGATIVE_ENTRY_WEIGHT,
        );
        assert_eq!(inner.bytes, MAX_CACHED_BYTES - 1000 + NEGATIVE_ENTRY_WEIGHT);
        // Must evict the manifest (oldest) to fit; the negative survives
        // because it is newer and the bound holds again.
        insert_map(&mut inner, map_key("new.js.map"), None, 2000);
        assert!(!inner.manifests.contains_key(&manifest_key));
        assert!(inner.maps.contains_key(&map_key("old.js.map")));
        assert!(inner.maps.contains_key(&map_key("new.js.map")));
        assert!(inner.bytes <= MAX_CACHED_BYTES);
    }

    #[test]
    fn mapped_strings_clip_like_raw_frames() {
        // Map contents are tenant-controlled: hostile names and sources must
        // not bloat the `errors.get` response past the raw-frame cap.
        let long = "x".repeat(super::super::errors::MAX_MESSAGE + 10);
        let manifest = MapManifest {
            worker: Some("worker.js.map".to_string()),
            assets_dir: None,
            files: HashMap::new(),
        };
        let sm = built_map(&[((20, 26), (long.as_str(), 4, 7), Some(long.as_str()))]);
        let load = |_: &str| Some(Arc::new(sm.clone()));
        let mut frames = vec![frame_at("worker.js:21:27")];
        let mut budget = SymbolicateBudget::for_read();
        assert_eq!(
            symbolicate_with(&mut frames, &manifest, &load, &mut budget),
            1
        );
        let location = frames[0].mapped_location.as_deref().expect("mapped");
        assert!(location.len() <= super::super::errors::MAX_MESSAGE + 3);
        assert!(location.ends_with('…'));
        let function = frames[0].mapped_function.as_deref().expect("named");
        assert!(function.len() <= super::super::errors::MAX_MESSAGE + 3);
        assert!(function.ends_with('…'));
    }

    #[test]
    fn chaining_resolves_through_the_build_map() {
        // celld map: deployed bundle line 0 → built entry line 10.
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
        // Far from any mapped inner code the outer position survives
        // unchained rather than inventing an original one.
        let outer = built_map(&[((0, 5), ("dist/app/index.js", 0, 0), Some("bundleFn"))]);
        let inner = built_map(&[((10, 3), ("src/index.ts", 2, 0), Some("realFn"))]);
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let token = chained.lookup_token(0, 5).expect("outer token");
        assert_eq!(token.get_source(), Some("dist/app/index.js"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (0, 0));
    }

    #[test]
    fn chaining_resolves_through_a_sourceless_wrapper_segment() {
        // V8 async frames can land on a generated wrapper segment (no
        // source) while the executing code sits on the same generated
        // line: the neighbor's original position wins over the built one.
        let outer = built_map(&[((0, 5), ("dist/app/index.js", 9, 2), Some("bundleFn"))]);
        let mut builder = sourcemap::SourceMapBuilder::new(None);
        builder.add(9, 2, 0, 0, None, None, false);
        builder.add(9, 5, 21, 8, Some("src/index.ts"), Some("realFn"), false);
        let inner = builder.into_sourcemap();
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let token = chained.lookup_token(0, 5).expect("chained token");
        assert_eq!(token.get_source(), Some("src/index.ts"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (21, 8));
        assert_eq!(token.get_name(), Some("realFn"));
    }

    #[test]
    fn chaining_skips_maps_past_the_token_cap() {
        // A hostile (or merely enormous) build map must not burn the deploy
        // task: past the token cap the outer map passes through unchained.
        let outer = built_map(&[((0, 5), ("dist/app/index.js", 10, 3), Some("bundleFn"))]);
        let mut builder = sourcemap::SourceMapBuilder::new(None);
        for line in 0..=MAX_CHAIN_TOKENS as u32 {
            builder.add(line, 0, line, 0, Some("src/big.ts"), None, false);
        }
        let inner = builder.into_sourcemap();
        let chained = chain_maps(&outer, &inner, "dist/app/index.js");
        let token = chained.lookup_token(0, 5).expect("outer token");
        assert_eq!(token.get_source(), Some("dist/app/index.js"));
        assert_eq!((token.get_src_line(), token.get_src_col()), (10, 3));
    }

    #[test]
    fn prune_keeps_recent_shas_only() {
        let listed = vec!["aaa".to_string(), "bbb".to_string(), "ccc".to_string()];
        let keep: HashSet<String> = HashSet::from(["bbb".to_string()]);
        assert_eq!(prune_victims(&listed, &keep), vec!["aaa", "ccc"]);
        assert!(prune_victims(&listed, &listed.iter().cloned().collect()).is_empty());
    }

    #[test]
    fn keep_set_pins_the_current_sha_and_newest_successes() {
        // Newest first, as `list_deploys` returns them; failures and
        // sha-less rows never join, and the current deploy is kept even
        // when it has no row yet.
        let rows = vec![
            (Some("new-fail".to_string()), false),
            (Some("new-ok".to_string()), true),
            (None, true),
            (Some("old-ok".to_string()), true),
        ];
        let keep = keep_shas("current", rows.into_iter());
        assert!(keep.contains("current"));
        assert!(keep.contains("new-ok"));
        assert!(keep.contains("old-ok"));
        assert!(!keep.contains("new-fail"));
        // Past the cap only the newest successes survive.
        let rows: Vec<(Option<String>, bool)> = (0..KEEP_DEPLOY_SHAS + 5)
            .map(|i| (Some(format!("sha{i:02}")), true))
            .collect();
        let keep = keep_shas("current", rows.into_iter());
        assert!(keep.contains("current"));
        assert!(keep.contains("sha00"));
        assert!(!keep.contains(format!("sha{:02}", KEEP_DEPLOY_SHAS + 4).as_str()));
        assert!(keep.contains(format!("sha{:02}", KEEP_DEPLOY_SHAS - 1).as_str()));
        assert!(!keep.contains(format!("sha{:02}", KEEP_DEPLOY_SHAS).as_str()));
        assert!(keep.len() <= KEEP_DEPLOY_SHAS + 1);
    }

    #[tokio::test]
    async fn fetch_map_confines_hostile_manifest_entries() {
        // `..` and absolute rels never reach S3 (no IO happens for these).
        let cfg = crate::config::config_for_tests();
        let FetchOutcome::Missing =
            fetch_map(&cfg, "b", "fleets/a", "abc123", "../evil.js.map").await
        else {
            panic!("hostile rel must stay Missing");
        };
        let FetchOutcome::Missing = fetch_map(&cfg, "b", "fleets/a", "abc123", "/etc/passwd").await
        else {
            panic!("absolute rel must stay Missing");
        };
        // A rel naming another sha still lands inside this sha's own dir
        // (flat keys, no traversal): the key shape itself is the confinement.
        assert_eq!(
            map_object_key("fleets/a", "abc123", "maps/xyz/x.js.map"),
            "fleets/a/maps/abc123/maps/xyz/x.js.map"
        );
    }

    #[test]
    fn entry_match_ignores_a_dot_prefix_but_not_basenames() {
        assert!(source_is_entry("index.js", "./index.js"));
        assert!(source_is_entry("dist/app/index.js", "dist/app/index.js"));
        assert!(!source_is_entry("other/index.js", "src/index.js"));
        assert!(!source_is_entry("index.js", ""));
    }

    #[test]
    fn worker_entry_reads_wrangler_main() {
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("entry.ts"), "export default {}").expect("entry");
        std::fs::write(
            dir.join("wrangler.jsonc"),
            "// config\n{\"main\": \"./entry.ts\"}\n",
        )
        .expect("config");
        let found = worker_entry(&dir).expect("entry").expect("some");
        assert_eq!(found.rel, PathBuf::from("./entry.ts"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dot_prefixed_assets_directories_match_manifest_keys() {
        // Wrangler configs write `"./public"`; manifest keys are
        // deploy-root-relative (`public/...`), so the prefix must normalize
        // before exact frame matching.
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join("wrangler.json"),
            "{\"main\": \"./worker.js\", \"assets\": {\"directory\": \"./public\"}}",
        )
        .expect("config");
        let config = read_worker_config(&dir).expect("readable");
        assert_eq!(config.assets_dir.as_deref(), Some("public"));
        // `..` refuses the value (matching falls back to full keys) rather
        // than letting a frame lookup escape the root.
        std::fs::write(
            dir.join("wrangler.json"),
            "{\"main\": \"./worker.js\", \"assets\": {\"directory\": \"../shared\"}}",
        )
        .expect("config");
        let config = read_worker_config(&dir).expect("readable");
        assert_eq!(config.assets_dir, None);
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
    fn error_maps_follow_the_occurrence_fleet() {
        assert_eq!(error_maps_prefix("blog", None), "fleets/blog");
        assert_eq!(
            error_maps_prefix("blog", Some("preview")),
            "envs/blog/preview"
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

    #[test]
    fn oversize_sibling_maps_are_refused() {
        assert!(fits_map_bytes(0));
        assert!(fits_map_bytes(MAX_MAP_BYTES));
        assert!(!fits_map_bytes(MAX_MAP_BYTES + 1));
    }

    #[tokio::test]
    async fn capped_reads_refuse_huge_files() {
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let small = dir.join("small.js.map");
        std::fs::write(&small, "{}").expect("small map");
        assert_eq!(read_capped_map(&small).await, Some(b"{}".to_vec()));
        let huge = dir.join("huge.js.map");
        let file = std::fs::File::create(&huge).expect("huge map");
        file.set_len(MAX_MAP_BYTES + 1).expect("sparse huge map");
        drop(file);
        assert_eq!(read_capped_map(&huge).await, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tenant_symlinks_never_become_stored_maps() {
        // The tree is tenant-built: a `dist/leak.map -> /outside` link (or a
        // directory link out of the worktree) must not become a stored map.
        use std::os::unix::fs::symlink;
        let dir =
            std::env::temp_dir().join(format!("noite-sourcemap-test-{}", uuid::Uuid::new_v4()));
        let root = dir.join("app");
        std::fs::create_dir_all(root.join("dist")).expect("temp dir");
        let secret = dir.join("outside.txt");
        std::fs::write(&secret, "platform secret").expect("secret");
        std::fs::write(root.join("dist").join("real.js.map"), "{}").expect("real map");
        symlink(&secret, root.join("dist").join("leak.js.map")).expect("file link");
        let outside = dir.join("outside-maps");
        std::fs::create_dir_all(&outside).expect("outside dir");
        std::fs::write(outside.join("evil.js.map"), "{}").expect("outside map");
        symlink(&outside, root.join("dist").join("linkdir")).expect("dir link");
        // The walk skips both links: only the real map is collected.
        let maps = collect_client_maps(&root, None);
        assert_eq!(
            maps.iter().map(|(rel, _)| rel.clone()).collect::<Vec<_>>(),
            vec!["dist/real.js.map".to_string()]
        );
        // The capped read refuses the link too, even though its target fits.
        assert_eq!(
            read_capped_map(&root.join("dist").join("leak.js.map")).await,
            None
        );
        assert_eq!(
            read_capped_map(&root.join("dist").join("real.js.map")).await,
            Some(b"{}".to_vec())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_maps_stop_at_the_deploy_budget() {
        let maps = vec![
            ("b.js.map".to_string(), vec![0u8; 30]),
            ("a.js.map".to_string(), vec![0u8; 30]),
            ("c.js.map".to_string(), vec![0u8; 30]),
        ];
        // Input order wins (deterministic): 30 + 30 fit in 70, the third is
        // skipped and counted.
        let mut budget = 70;
        let (kept, skipped) = cap_client_maps(maps, &mut budget);
        assert_eq!(kept.len(), 2);
        assert_eq!(skipped, 1);
        assert_eq!(budget, 10);
        assert_eq!(kept[0].0, "b.js.map");
    }

    #[test]
    fn sanitize_drops_absolute_paths_but_keeps_relative_sources() {
        // Absolute host paths become basenames; relative sources — including
        // the `../..` form every Vite build emits — stay intact for display.
        let mut builder = sourcemap::SourceMapBuilder::new(None);
        builder.add(0, 0, 0, 0, Some("/data/build/x.js"), Some("evil"), false);
        builder.add(1, 0, 5, 2, Some("../../elsewhere/y.js"), None, false);
        builder.add(2, 0, 9, 1, Some("src/ok.ts"), Some("fine"), false);
        let cleaned = sanitize_sources(&builder.into_sourcemap());
        let mut sources: Vec<Option<&str>> = cleaned.tokens().map(|t| t.get_source()).collect();
        sources.sort();
        assert_eq!(
            sources,
            [
                Some("../../elsewhere/y.js"),
                Some("src/ok.ts"),
                Some("x.js")
            ]
        );
    }
}
