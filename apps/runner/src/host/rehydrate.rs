//! Rehydrate deploy bare mirrors from S3 tip bundles when the work dir is fresh.
//!
//! `git-http/{slug}.git` already hydrates on demand (`git_http::ensure_bare`);
//! this covers the deploy/source mirror `repos/{slug}.git` the same way:
//! any read of a missing mirror pulls the tip bundle then retries once.
//! Boot calls `rehydrate_all` so fleets and source preview work immediately
//! after a work-dir wipe (volume loss, host move) without a re-push.
use std::time::Duration;

use crate::config::Config;
use crate::db;
use crate::host::{exec, s3, source, tips};
use sqlx::SqlitePool;

/// Where a deploy mirror is in its lifecycle. `git init --bare` and the tip
/// fetch are two steps, so a crash between them used to leave a bare repo with
/// `HEAD` but no objects: the old `HEAD exists` check then reported it
/// `present` forever and every read of it failed with "unknown revision"
/// instead of retrying the hydrate.
///
/// ```text
/// stateDiagram-v2
///     Absent --> Incomplete: git init --bare
///     Incomplete --> Ready: fetch tip, write marker
///     Absent --> Ready: deploy wrote the mirror (main ref present)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorState {
    /// Nothing on disk.
    Absent,
    /// A bare repo exists but never received a `main` ref: the debris of an
    /// interrupted hydrate, healed by fetching the tip again.
    Incomplete,
    /// A usable mirror: it holds the tip's `main` ref.
    Ready,
}

/// Marker written after a successful hydrate. Its presence is not required
/// (the deploy path creates mirrors too), but it makes a completed hydrate
/// unambiguous and survives a `packed-refs` rewrite.
const MARKER: &str = "noite-hydrated";

/// Classify one deploy mirror without touching the network.
pub fn mirror_state(cfg: &Config, slug: &str) -> MirrorState {
    let bare = source::bare_repo(cfg, slug);
    if !bare.join("HEAD").exists() {
        return MirrorState::Absent;
    }
    if bare.join(MARKER).exists() {
        return MirrorState::Ready;
    }
    // `git fetch` may write the ref packed instead of loose.
    if bare.join("refs/heads/main").exists()
        || std::fs::read_to_string(bare.join("packed-refs"))
            .is_ok_and(|packed| packed.lines().any(|l| l.ends_with(" refs/heads/main")))
    {
        return MirrorState::Ready;
    }
    MirrorState::Incomplete
}

/// Ensure `repos/{slug}.git` exists with at least the tip commit.
/// Returns true when it fetched something. Missing tip (never pushed) is
/// success with `false` — callers treat that as "not deployed yet".
pub async fn ensure_deploy_mirror(cfg: &Config, slug: &str) -> anyhow::Result<bool> {
    let bare = source::bare_repo(cfg, slug);
    if mirror_state(cfg, slug) == MirrorState::Ready {
        return Ok(false);
    }
    let Some(tip) = tips::head_main_bundle(cfg, slug).await? else {
        return Ok(false);
    };
    let root = exec::work_root(cfg);
    tokio::fs::create_dir_all(&bare).await.ok();
    tokio::fs::create_dir_all(&root).await.ok();
    if mirror_state(cfg, slug) == MirrorState::Absent {
        // Work-dir-derived paths are operator-influenced (a non-UTF-8 mount):
        // fail the rehydrate instead of panicking the task.
        let Some(bare_arg) = bare.to_str() else {
            anyhow::bail!("bare mirror path is not valid UTF-8: {}", bare.display());
        };
        exec::run_cmd(
            "git",
            &["init", "--bare", bare_arg],
            Some(&root),
            &[],
            Duration::from_secs(30),
        )
        .await?;
    }
    // Download the tip bundle to a temp file inside the work dir, then fetch
    // it into the bare mirror (same refspec the deploy pipeline uses).
    let tmp = root.join(format!(".rehydrate-{slug}-{}.bundle", tip.sha));
    let uri = cfg.s3_uri(&tip.key);
    if let Err(e) = s3::s3_cp_download(cfg, &uri, &tmp).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        anyhow::bail!("download tip bundle for {slug} failed: {e:#}");
    }
    let refspec = format!("+{}:refs/heads/main", tip.sha);
    let Some(tmp_arg) = tmp.to_str() else {
        let _ = tokio::fs::remove_file(&tmp).await;
        anyhow::bail!("bundle path is not valid UTF-8: {}", tmp.display());
    };
    let fetched = exec::run_cmd(
        "git",
        &[
            &format!("--git-dir={}", bare.display()),
            "fetch",
            tmp_arg,
            &refspec,
        ],
        Some(&root),
        &[],
        Duration::from_secs(60),
    )
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    fetched?;
    // Only now is the mirror complete: the marker is what stops a half-fetched
    // repo from ever looking present again.
    let _ = tokio::fs::write(bare.join(MARKER), &tip.sha).await;
    tracing::info!(slug, sha = %&tip.sha[..12.min(tip.sha.len())], "rehydrated deploy mirror from S3 tip");
    Ok(true)
}

/// Boot-time best-effort: rehydrate every app's deploy mirror. Failures are
/// warn-only — the pull-then-retry on reads covers stragglers.
pub async fn rehydrate_all(pool: &SqlitePool, cfg: &Config) {
    let apps = match db::list_all_apps(pool).await {
        Ok(apps) => apps,
        Err(e) => {
            tracing::warn!(error = %e, "rehydrate: list apps failed");
            return;
        }
    };
    for app in &apps {
        if let Err(e) = ensure_deploy_mirror(cfg, &app.slug).await {
            tracing::warn!(slug = %app.slug, error = %e, "rehydrate deploy mirror failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare repo with `HEAD` but no `main` ref is the debris of a crash
    /// between `git init --bare` and the fetch: it must read `Incomplete` so
    /// the reader retries instead of failing every revision lookup forever.
    #[test]
    fn a_half_hydrated_mirror_is_not_ready() {
        let dir = std::env::temp_dir().join(format!("noite-mirror-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let mut cfg = crate::config::config_for_tests();
        cfg.work_dir = dir.to_string_lossy().into_owned();
        assert_eq!(mirror_state(&cfg, "shop"), MirrorState::Absent);

        let bare = source::bare_repo(&cfg, "shop");
        std::fs::create_dir_all(&bare).expect("bare dir");
        std::fs::write(bare.join("HEAD"), "ref: refs/heads/main\n").expect("head");
        assert_eq!(
            mirror_state(&cfg, "shop"),
            MirrorState::Incomplete,
            "HEAD alone is an interrupted hydrate"
        );

        std::fs::create_dir_all(bare.join("refs/heads")).expect("refs");
        std::fs::write(bare.join("refs/heads/main"), "0".repeat(40)).expect("ref");
        assert_eq!(mirror_state(&cfg, "shop"), MirrorState::Ready);

        // A packed ref counts too (fetch may pack it).
        std::fs::remove_file(bare.join("refs/heads/main")).expect("unpack");
        std::fs::write(
            bare.join("packed-refs"),
            format!(
                "# pack-refs with: peeled\n{} refs/heads/main\n",
                "0".repeat(40)
            ),
        )
        .expect("packed");
        assert_eq!(mirror_state(&cfg, "shop"), MirrorState::Ready);

        // The marker is enough on its own.
        std::fs::remove_file(bare.join("packed-refs")).expect("unpack");
        std::fs::write(bare.join(MARKER), "abc").expect("marker");
        assert_eq!(mirror_state(&cfg, "shop"), MirrorState::Ready);
        let _ = std::fs::remove_dir_all(dir);
    }
}
