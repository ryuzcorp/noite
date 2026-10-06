//! Range-bounded resource allocation from persisted rows: per-app build uids
//! (SPEC, Tenant isolation) and fleet ports (SPEC, Ports).

use sqlx::SqlitePool;

use super::apps::list_all_apps;

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
pub async fn next_ports_in(pool: &SqlitePool, min: u16, max: u16) -> sqlx::Result<(i64, i64)> {
    let apps = list_all_apps(pool).await?;
    let mut used = std::collections::HashSet::new();
    for a in apps {
        if let Some(p) = a.listen_port {
            used.insert(p as u16);
        }
        if let Some(p) = a.internal_port {
            used.insert(p as u16);
        }
    }
    let mut listen = min;
    loop {
        if listen.saturating_add(1) > max {
            return Err(sqlx::Error::RowNotFound);
        }
        if !used.contains(&listen) && !used.contains(&(listen + 1)) {
            return Ok((listen as i64, (listen + 1) as i64));
        }
        listen = listen.saturating_add(2);
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
}
