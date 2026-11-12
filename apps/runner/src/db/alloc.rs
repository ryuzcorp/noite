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
/// invariant: an app create holds its slug's push guard across purge → insert
/// (so two creates for one slug never claim ports at once) and the port claim
/// inside it; environment creates hold only this lock.
static PORT_ALLOC_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Why picking a fleet-port pair failed. Two states, and they mean different
/// things to the caller: an exhausted range is the operator's to widen, a
/// read error is the database's to fix. They used to be the same
/// `sqlx::Error::RowNotFound`, so an agent reading a 409 could not tell which.
#[derive(Debug)]
pub enum AllocError {
    /// No free pair in `[min, max]`: every port is held by a live app or
    /// environment (`RUNNER_FLEET_PORT_MIN/MAX`).
    Exhausted { min: u16, max: u16 },
    /// Reading the rows that hold the ports failed.
    Db(sqlx::Error),
}

impl std::fmt::Display for AllocError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllocError::Exhausted { min, max } => {
                write!(f, "fleet port range {min}-{max} exhausted")
            }
            AllocError::Db(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AllocError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AllocError::Exhausted { .. } => None,
            AllocError::Db(e) => Some(e),
        }
    }
}

impl From<sqlx::Error> for AllocError {
    fn from(error: sqlx::Error) -> Self {
        AllocError::Db(error)
    }
}

/// A picked fleet-port pair plus the allocation lock, held until the
/// app/environment row carrying the pair is inserted: dropping the claim
/// before the insert reopens the race this exists to close. Its two states are
/// `Leased` (this value is alive, no row holds the pair yet) and `Committed`
/// (the claim was dropped after the insert) — the only legal order.
pub struct PortClaim {
    pub listen: i64,
    pub internal: i64,
    _guard: MutexGuard<'static, ()>,
}

/// Lowest free pair, claimed: concurrent claims serialize on
/// `PORT_ALLOC_LOCK` and never return the same pair. Hold the returned
/// claim across the row insert, then drop it.
pub async fn claim_ports_in(
    pool: &SqlitePool,
    min: u16,
    max: u16,
) -> Result<PortClaim, AllocError> {
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
/// read each other's worktree or cache. A deleted app's uid stays reserved by
/// its `app_purge` tombstone until the wipe that removes the trees it owns
/// lands, so no new build inherits them. `None` when uid drops are disabled
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
    //
    // A deleted app's uid is not free yet: `db::delete_app` frees it with the
    // row, but its `builds/<slug>` and `cache/<slug>` trees stay owned by it
    // until the background wipe removes them, and the `app_purge` tombstone
    // keeps the uid until then. Reserving it is what stops a new app's first
    // build from running as the uid that still owns the departed tenant's
    // files (SPEC, Tenant isolation; the hostile suite's cross-build probe).
    for _ in 0..16 {
        // The scan and the claim are one IMMEDIATE transaction: the app
        // delete moves a uid to `app_purge` in its own transaction, and the
        // unique index only covers `app`, so a scan taken before that move
        // would let a second app claim a uid a tombstone now owns. With the
        // write lock held, a delete either lands before the scan (and the
        // tombstone is seen) or waits for the claim to commit.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let used: Vec<i64> = sqlx::query_scalar(
            "SELECT build_uid FROM app WHERE build_uid IS NOT NULL \
             UNION SELECT build_uid FROM app_purge WHERE build_uid IS NOT NULL",
        )
        .fetch_all(&mut *tx)
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
                .execute(&mut *tx)
                .await;
        match updated {
            Ok(_) => {}
            // Dropping `tx` rolls the failed claim back.
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => continue,
            Err(e) => return Err(e),
        }
        // Another deploy may have claimed the row first (0 rows updated);
        // either way the row's value is now the truth.
        let claimed: Option<i64> = sqlx::query_scalar("SELECT build_uid FROM app WHERE id = ?")
            .bind(app_id)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
        tx.commit().await?;
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
pub async fn next_ports_in(
    pool: &SqlitePool,
    min: u16,
    max: u16,
) -> Result<(i64, i64), AllocError> {
    let apps = list_all_apps(pool).await?;
    // Raw, kind-independent: a retired row's pair may still be bound by an
    // orphaned fleet even though model reads skip the row.
    let env_ports = super::environments::list_environment_ports(pool).await?;
    let mut used = std::collections::HashSet::new();
    for p in apps
        .iter()
        .flat_map(|a| [a.listen_port, a.internal_port])
        .chain(
            env_ports
                .iter()
                .flat_map(|(listen, internal)| [*listen, *internal]),
        )
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
            return Err(AllocError::Exhausted { min, max });
        };
        if !used.contains(&listen) && !used.contains(&next) {
            return Ok((listen as i64, next as i64));
        }
        let Some(after) = next.checked_add(1) else {
            return Err(AllocError::Exhausted { min, max });
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
        // A delete that owes no wipe (`delete_app` always writes the
        // tombstone, which would keep the uid reserved) frees it here.
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

    /// A delete frees the app row but not its build uid: the uid still owns
    /// the departed tenant's `builds/<slug>` and `cache/<slug>` trees until
    /// the wipe recorded in `app_purge` removes them, so the allocator keeps
    /// it out of the pool. Handing it out earlier ran a new app's first build
    /// as the uid that still owned another tenant's package caches
    /// (merge-group e2e, 2026-11-12: the hostile build read a sibling's
    /// `cache/mcp-e2e/{jup,bun,home}`).
    #[tokio::test]
    async fn a_deleted_apps_uid_stays_reserved_until_its_wipe_lands() {
        let dir = std::env::temp_dir().join(format!("noite-uid-wipe-{}", new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = connect(&url).await.expect("boot");
        insert_app(&pool, "gone", "gone").await;
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "gone")
                .await
                .unwrap(),
            Some(10030)
        );
        crate::db::apps::delete_app(&pool, "gone")
            .await
            .expect("delete");
        insert_app(&pool, "next", "next").await;
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "next")
                .await
                .unwrap(),
            Some(10031),
            "the uid of a wipe still owed is never handed to a new app"
        );
        // The wipe landed (the caller cleared the tombstone): the uid returns.
        crate::db::apps::clear_app_purges(&pool, "gone")
            .await
            .expect("clear the tombstone");
        insert_app(&pool, "later", "later").await;
        assert_eq!(
            ensure_app_build_uid(&pool, Some(10030), 4, "later")
                .await
                .unwrap(),
            Some(10030)
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
            Err(AllocError::Exhausted { .. })
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
            Err(AllocError::Exhausted { .. })
        ));
        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A retired `kind='workspace'` row is skipped by model reads, but its
    /// pair may still be bound by an orphaned fleet: the allocator keeps
    /// reserving it.
    #[tokio::test]
    async fn retired_environment_rows_still_reserve_their_ports() {
        let pool = connect("sqlite::memory:").await.expect("boot");
        insert_app(&pool, "a", "a").await;
        sqlx::query(
            "INSERT INTO environment (id, app_id, label, kind, git_ref, created_by, \
             fleet_bucket, listen_port, internal_port, desired_state, created_at, updated_at) \
             VALUES ('legacy', 'a', 'wip', 'workspace', 'refs/previews/u/wip', '', \
             's3://noite/envs/a/wip', 20000, 20001, 'running', \
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .expect("legacy row");
        assert_eq!(
            next_ports_in(&pool, 20000, 20003)
                .await
                .expect("next free pair"),
            (20002, 20003),
            "a retired row's ports are still bound"
        );
        pool.close().await;
    }
}
