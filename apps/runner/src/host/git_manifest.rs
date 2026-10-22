//! Per-slug git manifest: the linearization point for pushes (walgit-inspired).
//!
//! Layout: `git/{slug}/MANIFEST.json` — `{version, seq, refs: {refname: {sha,
//! bundle}}}`. A push writes all ref tip bundles first, then the manifest
//! once; readers resolve refs from the manifest, so a half-written push is
//! never visible. Every push writes a complete manifest, so it is the only
//! source of refs; a slug without one has never been pushed. The manifest moves with `git/{slug}/` on rename and clears with
//! the prefix on purge; both also drop the slug's `applied_seq` marker
//! ([`GitSync::forget`]), so the next generation's seq (which restarts at 1)
//! is applied instead of skipped as stale.
//!
//! Concurrency: the runner is the single writer; pushes to one slug are
//! serialized by [`GitSync::push_guard`]. The manifest gives atomic
//! *visibility*; the mutex gives sound check-then-act (policy, fast-forward).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::config::Config;
use crate::host::{exec, s3};

/// Manifest format version. Readers accept only what they know.
pub const MANIFEST_VERSION: u8 = 1;

pub fn manifest_key(slug: &str) -> String {
    format!("git/{slug}/MANIFEST.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestRef {
    pub sha: String,
    pub bundle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u8,
    pub seq: u64,
    pub refs: HashMap<String, ManifestRef>,
}

/// Single-writer coordination for git pushes: per-slug push mutex plus the
/// last manifest seq applied to each local bare mirror.
///
/// Lock ordering (deadlock rule — every path below follows it, outer first):
/// `CREATE_LOCK` (service/apps.rs, the create/rename critical section) →
/// `AppLock` (host/deploy.rs, the per-app-id deploy/delete/rename claim) →
/// `push_guard` (here, the per-slug git+S3+manifest mutex). A path that needs
/// fewer locks skips one, never reorders: create holds `CREATE_LOCK` then its
/// slug's `push_guard`; delete holds `AppLock` then its slug's `push_guard`;
/// a slug-changing rename holds all three (`CREATE_LOCK`, then `AppLock`,
/// then both slugs' `push_guard`s). Tenant D1 reads and writes hold only
/// their slug's `push_guard` (their project materialization runs
/// `git checkout -f` on the shared bare repo, and two concurrent checkouts
/// race on its index.lock). Pushes hold only their slug's `push_guard` and
/// never claim `AppLock` while holding it, so waiting on an outer-held lock
/// while holding an inner one cannot happen. Two slug guards are always taken
/// in lexical slug order (see `push_guards`), so opposite renames cannot
/// deadlock against each other.
///
/// `applied_seq` only moves forward: a reader that syncs a manifest older
/// than one a concurrent write already applied must not drag the marker back
/// (that hid a fresh ref until the next guarded read re-synced). The two
/// exceptions are explicit: a cold mirror resets to 0 so the next manifest
/// wins unconditionally, and a purge or slug-changing rename forgets the
/// slug's generation outright so the next generation's seq (which restarts
/// at 1) is applied rather than skipped as stale.
#[derive(Clone, Default)]
pub struct GitSync {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    applied: Arc<Mutex<HashMap<String, u64>>>,
    #[cfg(test)]
    apply_gate: Arc<std::sync::Mutex<Option<test_hooks::Gate>>>,
}

impl GitSync {
    /// Hold across a whole push (policy check → git → S3 → manifest).
    /// Callers that also hold `CREATE_LOCK` and/or the `AppLock` take this
    /// guard last (see the ordering rule on [`GitSync`]).
    pub async fn push_guard(&self, slug: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(slug.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    /// Both slug guards for a rename, taken in lexical order so two renames
    /// over the same pair in opposite directions serialize instead of
    /// deadlocking. Returns the first guard and, when the slugs differ, the
    /// second; a same-slug call returns one guard and `None`.
    pub async fn push_guards(
        &self,
        old_slug: &str,
        new_slug: &str,
    ) -> (
        tokio::sync::OwnedMutexGuard<()>,
        Option<tokio::sync::OwnedMutexGuard<()>>,
    ) {
        let (first, second) = if new_slug < old_slug {
            (new_slug, old_slug)
        } else {
            (old_slug, new_slug)
        };
        let first_guard = self.push_guard(first).await;
        if first == second {
            return (first_guard, None);
        }
        let second_guard = self.push_guard(second).await;
        (first_guard, Some(second_guard))
    }

    pub async fn applied_seq(&self, slug: &str) -> Option<u64> {
        self.applied.lock().await.get(slug).copied()
    }

    /// Record an applied manifest seq. Only moves forward: a concurrent
    /// reader syncing a pre-flip manifest must not clobber the seq a write
    /// already recorded. Cold resets and generation changes use
    /// [`GitSync::reset_applied_seq`] and [`GitSync::forget`] instead.
    pub async fn set_applied_seq(&self, slug: &str, seq: u64) {
        let mut applied = self.applied.lock().await;
        if applied.get(slug).is_none_or(|current| seq > *current) {
            applied.insert(slug.to_string(), seq);
        }
    }

    /// Unconditional seq record for a cold mirror: the local refs were just
    /// hydrated from the raw bundle listing, so no seq can be trusted and the
    /// next manifest read must win.
    pub async fn reset_applied_seq(&self, slug: &str, seq: u64) {
        self.applied.lock().await.insert(slug.to_string(), seq);
    }

    /// Drop a slug's generation marker. Purge and slug-changing rename call
    /// this under the slug's `push_guard`: the mirror, the S3 prefix and the
    /// marker move together, so a recreated slug's seq-1 manifest is applied
    /// instead of skipped as stale.
    pub async fn forget(&self, slug: &str) {
        self.applied.lock().await.remove(slug);
    }

    /// Pause point for the deterministic M1 race test: the test parks a
    /// reader here (after its unlocked manifest read, before it takes
    /// `push_guard`), completes a create, then releases it. Without a gate
    /// installed this is a no-op; production builds compile it away.
    pub(crate) async fn pause_before_sync(&self) {
        #[cfg(test)]
        {
            let gate = self
                .apply_gate
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if let Some(gate) = gate {
                gate.entered.notify_one();
                gate.release.notified().await;
            }
        }
    }
}

/// Deterministic-race scaffolding: gates a test installs so it can freeze one
/// manifest operation mid-flight, interleave another, then release it. No
/// sleeps, no wall-clock waits — the test awaits real signals.
#[cfg(test)]
pub mod test_hooks {
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex};

    use tokio::sync::Notify;

    /// A parked operation signals `entered`, then waits for `release`.
    #[derive(Clone, Default)]
    pub struct Gate {
        pub entered: Arc<Notify>,
        pub release: Arc<Notify>,
    }

    static WRITE_GATES: LazyLock<Mutex<HashMap<String, Gate>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    /// Install the apply gate on one `GitSync`: the next
    /// [`super::GitSync::pause_before_sync`] parks there. `None` removes it.
    pub fn set_apply_gate(sync: &super::GitSync, gate: Option<Gate>) {
        *sync.apply_gate.lock().unwrap_or_else(|e| e.into_inner()) = gate;
    }

    /// Park the next [`super::write_manifest`] for `slug` after it stages its
    /// tmp file and before it uploads. `None` removes the gate.
    pub fn set_write_gate(slug: &str, gate: Option<Gate>) {
        let mut gates = WRITE_GATES.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(gate) = gate {
            gates.insert(slug.to_string(), gate);
        } else {
            gates.remove(slug);
        }
    }

    pub(crate) async fn pause_write_staged(slug: &str) {
        let gate = WRITE_GATES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(slug)
            .cloned();
        if let Some(gate) = gate {
            gate.entered.notify_one();
            gate.release.notified().await;
        }
    }
}

/// Read the manifest, if the slug has one yet.
pub async fn read_manifest(cfg: &Config, slug: &str) -> anyhow::Result<Option<Manifest>> {
    let tmp = manifest_tmp(cfg, slug);
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let uri = cfg.s3_uri(&manifest_key(slug));
    match s3::s3_cp_download(cfg, &uri, &tmp).await {
        Ok(()) => {}
        // Never pushed. Any other failure is an error: treating an
        // unreachable store as "no manifest" would restart `seq` and write a
        // manifest holding only this push's refs, dropping the others.
        Err(e) if s3::is_not_found(&e) => return Ok(None),
        Err(e) => return Err(e.context("read git manifest")),
    }
    let result = tokio::fs::read(&tmp).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    let bytes = result?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.version != MANIFEST_VERSION {
        anyhow::bail!("manifest version {} unsupported", manifest.version);
    }
    Ok(Some(manifest))
}

/// Write the manifest once per push, after all tip bundles land.
pub async fn write_manifest(cfg: &Config, slug: &str, manifest: &Manifest) -> anyhow::Result<()> {
    let tmp = manifest_tmp(cfg, slug);
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec(manifest)?;
    tokio::fs::write(&tmp, &bytes).await?;
    #[cfg(test)]
    test_hooks::pause_write_staged(slug).await;
    let result = s3::s3_cp_upload(cfg, &tmp, &manifest_key(slug)).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}
/// A tmp path unique to this call. A concurrent reader's download must never
/// land on the path a writer staged (a lost manifest flip), and a reader
/// must never parse bytes a writer is still staging (torn reads).
fn manifest_tmp(cfg: &Config, slug: &str) -> PathBuf {
    static MANIFEST_TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let n = MANIFEST_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    exec::work_root(cfg)
        .join("git-http")
        .join(format!(".manifest-{slug}.{}.{n}.json", std::process::id()))
}

/// The store's manifest when the mirror still needs it: `None` when no
/// manifest exists yet or `applied_seq` already covers it. Unlocked; a
/// caller that decides to sync MUST re-call this under the slug's
/// `push_guard` before syncing — a concurrent push can flip the manifest
/// between the check and the sync, and syncing the older read would delete a
/// ref the flip just added.
pub async fn pending_manifest(
    cfg: &Config,
    git_sync: &GitSync,
    slug: &str,
) -> anyhow::Result<Option<Manifest>> {
    let manifest = match read_manifest(cfg, slug).await? {
        Some(manifest) => manifest,
        None => return Ok(None),
    };
    if git_sync
        .applied_seq(slug)
        .await
        .is_some_and(|applied| applied >= manifest.seq)
    {
        return Ok(None);
    }
    Ok(Some(manifest))
}

fn bundle_tmp(cfg: &Config, slug: &str, sha: &str) -> PathBuf {
    exec::work_root(cfg)
        .join("git-http")
        .join(format!(".refresh-{slug}-{sha}.bundle"))
}

/// Apply one manifest ref to the local bare mirror.
pub async fn fetch_manifest_ref(
    cfg: &Config,
    bare: &std::path::Path,
    bundle_key: &str,
    sha: &str,
    refname: &str,
) -> anyhow::Result<()> {
    let bundle = bundle_tmp(cfg, &bundle_key_bundle_slug(bundle_key), sha);
    if let Some(parent) = bundle.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    s3::s3_cp_download(cfg, &cfg.s3_uri(bundle_key), &bundle).await?;
    let result = exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            bundle.to_str().unwrap_or_default(),
            &format!("+{sha}:{refname}"),
        ],
        None,
        &[],
        Duration::from_secs(60),
    )
    .await;
    let _ = tokio::fs::remove_file(&bundle).await;
    result?;
    Ok(())
}

/// Bundle keys embed the slug (`git/{slug}/…`); recover it for tmp paths.
fn bundle_key_bundle_slug(bundle_key: &str) -> String {
    bundle_key
        .strip_prefix("git/")
        .and_then(|rest| rest.split_once('/'))
        .map(|(slug, _)| slug.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Bring a bare mirror up to the manifest: fetch refs whose sha differs from
/// local, then record the seq. Best-effort per ref — callers warn and serve
/// from what is local on failure.
pub async fn refresh_bare(
    cfg: &Config,
    bare: &std::path::Path,
    manifest: &Manifest,
    local: &HashMap<String, String>,
) -> anyhow::Result<()> {
    for (refname, entry) in &manifest.refs {
        if local.get(refname).map(|s| s.as_str()) == Some(entry.sha.as_str()) {
            continue;
        }
        fetch_manifest_ref(cfg, bare, &entry.bundle, &entry.sha, refname).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip() {
        let manifest = Manifest {
            version: MANIFEST_VERSION,
            seq: 7,
            refs: HashMap::from([(
                "refs/heads/main".to_string(),
                ManifestRef {
                    sha: "a".repeat(40),
                    bundle: "git/demo/refs/heads/main/aaa.bundle".to_string(),
                },
            )]),
        };
        let Ok(bytes) = serde_json::to_vec(&manifest) else {
            panic!("manifest must serialize");
        };
        let Ok(back): Result<Manifest, _> = serde_json::from_slice(&bytes) else {
            panic!("manifest must deserialize");
        };
        assert_eq!(back.seq, 7);
        assert_eq!(back.refs["refs/heads/main"].sha, "a".repeat(40));
    }

    #[test]
    fn manifest_key_shape() {
        assert_eq!(manifest_key("demo"), "git/demo/MANIFEST.json");
    }

    /// Same-slug guards exclude each other, and opposite-order pairs still
    /// serialize (lexical acquisition): with real mutexes an inversion here
    /// would hang this test under `tokio::time::timeout`.
    #[tokio::test]
    async fn push_guards_serialize_and_never_invert() {
        let sync = GitSync::default();
        let first = sync.push_guard("demo").await;
        let probe = tokio::time::timeout(
            std::time::Duration::from_millis(50),
            sync.push_guard("demo"),
        )
        .await;
        assert!(probe.is_err(), "a second guard for one slug must wait");
        drop(first);
        let held = tokio::time::timeout(std::time::Duration::from_secs(5), sync.push_guard("demo"))
            .await
            .expect("the guard releases");
        drop(held);
        // Opposite directions over one pair: both finish, so no inversion.
        let a = sync.clone();
        let b = sync.clone();
        let pair = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let left = tokio::spawn(async move { a.push_guards("alpha", "beta").await });
            let right = tokio::spawn(async move { b.push_guards("beta", "alpha").await });
            let _ = left.await.expect("left rename guards");
            let _ = right.await.expect("right rename guards");
        })
        .await;
        assert!(pair.is_ok(), "opposite rename pairs must not deadlock");
        // Same slug collapses to one guard.
        let (_, second) = sync.push_guards("demo", "demo").await;
        assert!(second.is_none(), "same-slug rename holds one guard");
    }
}
