//! Range-bounded resource allocation from persisted rows: per-app build uids
//! (SPEC, Tenant isolation) and fleet ports (SPEC, Ports).

use std::sync::LazyLock;

use sqlx::SqlitePool;
use tokio::sync::MutexGuard;

use super::apps::list_all_apps;

/// Serializes fleet-port pick-then-insert (SPEC, Ports). `next_ports_in`
/// reads the lowest free pair from the app + environment rows, so two
/// concurrent creates — two environments, or an app and an environment —
/// can read the same free pair and start two fleets on one port; the loser
/// then dies at bind with "celld exited before answering its health gate".
/// A claim holds this lock from the pick until the row insert commits, so a
/// concurrent claim always sees the earlier claim's ports. Single-process
/// invariant, like `service::apps::CREATE_LOCK` (which stays outermost: app
/// create holds `CREATE_LOCK` across purge → insert and the port claim
/// inside it; environment creates hold only this lock).
static PORT_ALLOC_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// A picked fleet-port pair plus the allocation lock, held until the
/// app/environment row carrying the pair is inserted: dropping the claim
/// before the insert reopens the race this exists to close.
pub struct PortClaim {
    pub listen: i64,
    pub internal: i64,
    _guard: MutexGuard<'static, ()>,
}

/// Lowest free pair, claimed: concurrent claims serialize on
/// `PORT_ALLOC_LOCK` and never return the same pair. Hold the returned
/// claim across the row insert, then drop it.
pub async fn claim_ports_in(pool: &SqlitePool, min: u16, max: u16) -> sqlx::Result<PortClaim> {
    let guard = PORT_ALLOC_LOCK.lock().await;
    let (listen, internal) = next_ports_in(pool, min, max).await?;
    Ok(PortClaim {
        listen,
        internal,
        _guard: guard,
    })
}

/// Lowest free uid in `[base, base + range)`, given every uid SQLite already
/// holds (NULL rows are absent). `None` when the range is exhausted: callers
/// fail the build rather than reusing a live app's uid.
pub fn pick_build_uid(base: u32, range: u32, used: &[i64]) -> Option<u32> {
    let used: std::collections::HashSet<i64> = used.iter().copied().collect();
    (base..base.saturating_add(range)).find(|uid| !used.contains(&i64::from(*uid)))
}

/// A stable per-app build uid (SPEC, Tenant isolation): allocated on the
/// app's first build and remembered on its row, so two concurrent builds —
/// of one app or of two different apps — run as different uids and cannot
/// read each other's worktree or cache. `None` when uid drops are disabled
/// (`RUNNER_BUILD_UID_BASE=none`, dev/single) or the app row is gone.
pub async fn ensure_app_build_uid(
    pool: &SqlitePool,
    base: Option<u32>,
    range: u32,
    app_id: &str,
) -> sqlx::Result<Option<u32>> {
    let Some(base) = base else {
        return Ok(None);
    };
    let existing: Option<Option<i64>> =
        sqlx::query_scalar("SELECT build_uid FROM app WHERE id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await?;
    let Some(existing) = existing else {
        return Ok(None);
    };
    if let Some(uid) = existing.and_then(|v| u32::try_from(v).ok()) {
        return Ok(Some(uid));
    }
    // Two apps allocating at once can pick the same lowest free uid; the
    // unique index arbitrates and the loser re-picks.
    for _ in 0..16 {
        let used: Vec<i64> =
            sqlx::query_scalar("SELECT build_uid FROM app WHERE build_uid IS NOT NULL")
                .fetch_all(pool)
                .await?;
        let Some(uid) = pick_build_uid(base, range, &used) else {
            return Err(sqlx::Error::Protocol(format!(
                "per-app build uid range {base}..{} exhausted; raise RUNNER_BUILD_UID_RANGE",
                base.saturating_add(range)
            )));
        };
        let updated =
            sqlx::query("UPDATE app SET build_uid = ? WHERE id = ? AND build_uid IS NULL")
                .bind(i64::from(uid))
                .bind(app_id)
                .execute(pool)
                .await;
        match updated {
            Ok(_) => {}
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(e),
        }
        // Another deploy may have claimed the row first (0 rows updated);
        // either way the row's value is now the truth.
        let claimed: Option<i64> = sqlx::query_scalar("SELECT build_uid FROM app WHERE id = ?")
            .bind(app_id)
            .fetch_optional(pool)
            .await?
            .flatten();
        return Ok(claimed.and_then(|v| u32::try_from(v).ok()));
    }
    Err(sqlx::Error::Protocol(
        "per-app build uid allocation lost too many races; retry the deploy".into(),
    ))
}

/// Range-bounded allocator (SPEC, Ports): new fleets come from the
/// configured range. Exhaustion errors instead of wandering past max into
/// ephemeral ports.
///
/// Both fleets are read: an app's pair **and** every preview environment's,
/// because an environment is its own celld process with its own pair on the
/// same range and two fleets on one port crash-loop.
pub async fn next_ports_in(pool: &SqlitePool, min: u16, max: u16) -> sqlx::Result<(i64, i64)> {
    let apps = list_all_apps(pool).await?;
    let envs = super::environments::list_all_environments(pool).await?;
    let mut used = std::collections::HashSet::new();
    for p in apps
        .iter()
        .flat_map(|a| [a.listen_port, a.internal_port])
        .chain(envs.iter().flat_map(|e| [e.listen_port, e.internal_port]))
        .flatten()
    {
        // Only the allocator writes ports, so stored values are in range;
        // a hand-edited row must neither reserve a live port by aliasing
        // nor panic the scan.
        if let Ok(port) = u16::try_from(p) {
            used.insert(port);
        }
    }
    // `checked_add`, never `saturating_add`: at `u16::MAX` a saturated
    // successor equals `listen` and would hand out the degenerate pair
    // (65535, 65535). No representable successor in range is exhaustion.
    let mut listen = min;
    loop {
        let Some(next) = listen.checked_add(1).filter(|port| *port <= max) else {
            return Err(sqlx::Error::RowNotFound);
        };
        if !used.contains(&listen) && !used.contains(&next) {
            return Ok((listen as i64, next as i64));
        }
        let Some(after) = next.checked_add(1) else {
            return Err(sqlx::Error::RowNotFound);
        };
        listen = after;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::db::connect;
    use crate::models::new_id;

    #[test]
    fn pick_build_uid_takes_the_lowest_free_slot_in_range() {
        assert_eq!(pick_build_uid(10030, 4, &[]), Some(10030));
        assert_eq!(pick_build_uid(10030, 4, &[10030, 10032]), Some(10031));
        assert_eq!(
            pick_build_uid(10030, 4, &[10030, 10031, 10032, 10033]),
            None
        );
        // Values outside the range (e.g. the fleet uid) never influence it.
        assert_eq!(pick_build_uid(10030, 2, &[10020, 99999, -1]), Some(10030));
    }

    async fn insert_app(pool: &SqlitePool, id: &str, slug: &str) {
        sqlx::query(
            "INSERT INTO app (id, slug, name, subdomain, git_prefix, fleet_bucket, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(slug)
        .bind(slug)
        .bind(format!("{slug}.localhost"))
        .bind(format!("git/{slug}/"))
        .bind(format!("s3://noite/fleets/{slug}"))
        .execute(pool)
        .await
        .expect("insert app");
    }

    /// The per-app build uid contract (SPEC, Tenant isolation): stable per
    /// app, unique across live apps, inside the range, and reused only after
    /// the app that held it is deleted.
    #[tokio::test]
    async fn per_app_build_uids_are_stable_unique_and_never_shared() {
        let dir = std::env::temp_dir().join(format!("noite-uid-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = connect(&url).await.expect("boot");
        insert_app(&pool, "a", "a").await;
        insert_app(&pool, "b", "b").await;
        // Stable across calls ...
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "a")
                .await
                .unwrap(),
            Some(10030)
        );
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "a")
                .await
                .unwrap(),
            Some(10030)
        );
        // ... and across a restart: the uid lives on the row, not in memory.
        pool.close().await;
        let pool = connect(&url).await.expect("reconnect");
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "a")
                .await
                .unwrap(),
            Some(10030)
        );
        // Unique across live apps.
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "b")
                .await
                .unwrap(),
            Some(10031)
        );
        let stored: Option<i64> = sqlx::query_scalar("SELECT build_uid FROM app WHERE id = 'b'")
            .fetch_one(&pool)
            .await
            .expect("stored uid");
        assert_eq!(stored, Some(10031));
        // Deleting an app is the only way its uid comes back.
        sqlx::query("DELETE FROM app WHERE id = 'a'")
            .execute(&pool)
            .await
            .expect("delete a");
        insert_app(&pool, "c", "c").await;
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "c")
                .await
                .unwrap(),
            Some(10030)
        );
        // Range exhaustion is an error, never a collision.
        insert_app(&pool, "d", "d").await;
        insert_app(&pool, "e", "e").await;
        insert_app(&pool, "f", "f").await;
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "d")
                .await
                .unwrap(),
            Some(10032)
        );
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "e")
                .await
                .unwrap(),
            Some(10033)
        );
        assert!(ensure_app_build_uid(&pool, Some(10030), 4, "f")
            .await
            .is_err());
        // Disabled drops allocate nothing.
        assert_eq!(
            ensure_app_build_uid(&pool, None, 4, "b").await.unwrap(),
            None
        );
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Concurrent creates must never take the same pair (SPEC, Ports): the
    /// multi-lane flakes #94 and #96 started two fleets on one port and the
    /// loser died at bind. Each task claims, yields so that without the claim
    /// lock every pick would land before any insert, inserts its row, then
    /// releases.
    #[tokio::test]
    async fn concurrent_port_claims_never_share_a_pair() {
        let dir = std::env::temp_dir().join(format!("noite-ports-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = connect(&url).await.expect("boot");
        let tasks: Vec<_> = (0..8)
            .map(|n| {
                let pool = pool.clone();
                tokio::spawn(async move {
                    let ports = claim_ports_in(&pool, 20000, 20015).await.expect("claim");
                    // Scheduler signal, not a wait: without the claim lock this
                    // yield lets every other task's pick land first, which is
                    // the interleaving that shared one pair in the lane.
                    tokio::task::yield_now().await;
                    sqlx::query(
                        "INSERT INTO app (id, slug, name, subdomain, git_prefix, fleet_bucket, listen_port, internal_port, created_at, updated_at) \
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                    )
                    .bind(format!("app-{}", n))
                    .bind(format!("app-{}", n))
                    .bind(format!("app-{}", n))
                    .bind(format!("app-{}.localhost", n))
                    .bind(format!("git/app-{}/", n))
                    .bind(format!("s3://noite/fleets/app-{}", n))
                    .bind(ports.listen)
                    .bind(ports.internal)
                    .execute(&pool)
                    .await
                    .expect("insert app");
                    let pair = (ports.listen, ports.internal);
                    drop(ports);
                    pair
                })
            })
            .collect();
        let mut pairs = Vec::with_capacity(tasks.len());
        for task in tasks {
            pairs.push(task.await.expect("join"));
        }
        pairs.sort_unstable();
        pairs.dedup();
        assert_eq!(pairs.len(), 8, "concurrent claims shared a pair: {pairs:?}");
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The scan skips stored ports that cannot be a `u16` instead of
    /// aliasing them onto a live port, and a full range errors instead of
    /// wandering past `max` (or panicking at `u16::MAX`).
    #[tokio::test]
    async fn port_scan_ignores_unrepresentable_ports_and_reports_exhaustion() {
        let dir = std::env::temp_dir().join(format!("noite-ports-edge-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = connect(&url).await.expect("boot");
        sqlx::query(
            "INSERT INTO app (id, slug, name, subdomain, git_prefix, fleet_bucket, listen_port, internal_port, created_at, updated_at) \
             VALUES ('hand', 'hand', 'hand', 'hand.localhost', 'git/hand/', 's3://noite/fleets/hand', 99999, -7, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("insert hand-edited row");
        // Neither out-of-range value reserves anything: the lowest pair wins.
        assert_eq!(
            next_ports_in(&pool, 20000, 20001)
                .await
                .expect("lowest pair"),
            (20000, 20001)
        );
        insert_app(&pool, "full", "full").await;
        sqlx::query("UPDATE app SET listen_port = 20000, internal_port = 20001 WHERE id = 'full'")
            .execute(&pool)
            .await
            .expect("fill the range");
        // The range holds one pair and it is taken: exhaustion, not a wander.
        assert!(matches!(
            next_ports_in(&pool, 20000, 20001).await,
            Err(sqlx::Error::RowNotFound)
        ));
        // An odd-sized range ending at u16::MAX: with the first pair taken
        // the scan reaches 65535, whose successor does not exist. It must
        // report exhaustion, never hand out the degenerate (65535, 65535).
        sqlx::query("UPDATE app SET listen_port = 65533, internal_port = 65534 WHERE id = 'full'")
            .execute(&pool)
            .await
            .expect("take the first top pair");
        assert!(matches!(
            next_ports_in(&pool, 65533, 65535).await,
            Err(sqlx::Error::RowNotFound)
        ));
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
