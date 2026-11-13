use super::*;

/// A file-backed database: the metrics tables live in the ATTACHed sibling
/// file, which an in-memory pool would give a private copy of to each
/// connection.
struct TestDb {
    pool: SqlitePool,
    dir: std::path::PathBuf,
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl TestDb {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("noite-hourly-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pool = crate::db::connect(&format!(
            "sqlite:{}?mode=rwc",
            dir.join("noite.sqlite").display()
        ))
        .await
        .expect("file db");
        Self { pool, dir }
    }

    fn key<'a>(&self, hour: &'a str) -> Key<'a> {
        Key {
            app_id: "a",
            environment_id: "",
            bucket_hour: hour,
        }
    }

    fn key_for<'a>(&self, app: &'a str, env: &'a str, hour: &'a str) -> Key<'a> {
        Key {
            app_id: app,
            environment_id: env,
            bucket_hour: hour,
        }
    }

    async fn stored(&self, key: Key<'_>) -> Option<db::AppHourValues> {
        let mut conn = self.pool.acquire().await.expect("connection");
        db::get_app_hour(&mut conn, key.app_id, key.environment_id, key.bucket_hour)
            .await
            .expect("stored hour")
    }

    async fn histogram(&self, key: Key<'_>) -> Vec<(i64, i64)> {
        let mut conn = self.pool.acquire().await.expect("connection");
        db::app_hour_lat(&mut conn, key.app_id, key.environment_id, key.bucket_hour)
            .await
            .expect("histogram")
    }

    /// One access-log line's worth: the row and its histogram bucket commit
    /// together, exactly like the tail does it.
    async fn request(&self, key: Key<'_>, ts_us: i64, ms: Option<i64>) {
        let mut tx = self.pool.begin().await.expect("tx");
        record_request(&mut tx, key, ts_us, ms, false)
            .await
            .expect("record");
        tx.commit().await.expect("commit");
    }
}

/// Percentiles are derived from the histogram, and every boundary is the value
/// the tile shows: `1, 2, 3, 100` ms → p50 in `[2,4)`, p95 in `[64,128)`.
#[tokio::test]
async fn percentiles_come_from_the_log_scale_histogram() {
    let db = TestDb::new().await;
    let k = db.key("2026-11-13T07:00:00Z");
    for (i, ms) in [1, 2, 3, 100].iter().enumerate() {
        db.request(k, 1_000 * i as i64, Some(*ms)).await;
    }
    let row = db.stored(k).await.expect("row");
    assert_eq!(row.requests, 4);
    assert_eq!(row.p50_ms, 4, "p50 rank 2 lands in [2,4)");
    assert_eq!(row.p95_ms, 128, "p95 rank 4 lands in [64,128)");
    // One row per bucket actually hit, not one per sample.
    assert_eq!(db.histogram(k).await, vec![(1, 1), (2, 2), (7, 1)]);

    // A line without a duration counts, but carries no latency sample, so the
    // percentiles must not move.
    db.request(k, 5_000, None).await;
    let row = db.stored(k).await.expect("row");
    assert_eq!((row.requests, row.p50_ms, row.p95_ms), (5, 4, 128));
}

/// Bucket boundaries at the sides of each power of two, a latency past the top
/// bucket clamping into it, and minute stamps mapping to their hour.
#[test]
fn latency_buckets_and_hour_stamps_cover_the_whole_range() {
    assert_eq!(lat_bucket(0), 0);
    assert_eq!(lat_bucket(1), 1);
    assert_eq!(lat_bucket(2), 2);
    assert_eq!(lat_bucket(3), 2);
    assert_eq!(lat_bucket(4), 3);
    assert_eq!(lat_bucket(10_000_000), LAT_BUCKETS - 1);
    assert_eq!((lat_ceiling(0), lat_ceiling(18)), (1, 262_144));
    assert_eq!(percentile(&[0; LAT_BUCKETS], 0.50), 0);
    assert_eq!(hour_of("2026-11-13T07:35:00Z"), "2026-11-13T07:00:00Z");
    assert_eq!(hour_of("nonsense"), hour_now());
}

/// The hour comes from the line's own timestamp, so two hours are two rows and
/// a late line still lands in the hour it belongs to.
#[tokio::test]
async fn every_hour_keys_its_own_row() {
    let db = TestDb::new().await;
    let first = db.key("2026-11-13T07:00:00Z");
    let second = db.key("2026-11-13T08:00:00Z");
    db.request(first, 90, Some(5)).await;
    db.request(first, 80, Some(5)).await;
    db.request(second, 20, Some(5)).await;
    db.request(first, 100, Some(5)).await;
    assert_eq!(db.stored(first).await.expect("first").requests, 3);
    assert_eq!(db.stored(second).await.expect("second").requests, 1);
    // The stamp is the newest request, not the last line written.
    assert_eq!(db.stored(first).await.expect("first").last_request_us, 100);
}

/// Production, each environment and the control fleet keep separate rows for
/// the same app — the control fleet with no `app` row of its own.
#[tokio::test]
async fn every_fleet_key_keeps_its_own_row() {
    let db = TestDb::new().await;
    let hour = "2026-11-13T07:00:00Z";
    let prod = db.key_for("app1", "", hour);
    let env = db.key_for("app1", "env-1", hour);
    let control = db.key_for(crate::host::control::SLUG, "", hour);
    db.request(prod, 10, Some(5)).await;
    db.request(env, 11, Some(5)).await;
    db.request(env, 12, Some(5)).await;
    db.request(control, 13, Some(5)).await;
    assert_eq!(db.stored(prod).await.expect("prod").requests, 1);
    assert_eq!(db.stored(env).await.expect("env").requests, 2);
    assert_eq!(db.stored(control).await.expect("control").requests, 1);
}

/// Memory and CPU keep the peak and the mean over every sample, without moving
/// the request counts.
#[tokio::test]
async fn memory_and_cpu_fold_into_the_same_row() {
    let db = TestDb::new().await;
    let k = db.key("2026-11-13T07:00:00Z");
    db.request(k, 10, Some(5)).await;
    for bytes in [100, 300, 200] {
        record_memory(&db.pool, k, bytes).await.expect("sample");
    }
    record_cpu(&db.pool, k, 40).await.expect("cpu");
    record_cpu(&db.pool, k, 2).await.expect("cpu");
    let row = db.stored(k).await.expect("row");
    assert_eq!(row.mem_max_bytes, 300);
    assert_eq!(row.mem_avg_bytes, 200);
    assert_eq!((row.requests, row.cpu_ms), (1, 42));
}

/// Errors are the edge's 5xx lines and p50/p95 see every write, so a second
/// write (a later process — the row is the only state) continues from the first
/// instead of restarting at zero.
#[tokio::test]
async fn writes_continue_from_the_stored_row() {
    let db = TestDb::new().await;
    let k = db.key("2026-11-13T07:00:00Z");
    db.request(k, 10, Some(5)).await;
    db.request(k, 11, Some(20)).await;
    let mut tx = db.pool.begin().await.expect("tx");
    record_request(&mut tx, k, 12, Some(20), true)
        .await
        .expect("error line");
    tx.commit().await.expect("commit");
    let row = db.stored(k).await.expect("row");
    assert_eq!((row.requests, row.errors), (3, 1));
    let hist = db.histogram(k).await;
    assert_eq!(hist.iter().map(|(_, n)| n).sum::<i64>(), 3);
}

/// The line is retried when its write fails (the tail only advances past a
/// committed line). Counting the retry on top of the failed attempt would show
/// a request twice, so the failed attempt must leave the stored row alone.
#[tokio::test]
async fn a_failed_write_never_double_counts_the_retried_line() {
    let db = TestDb::new().await;
    let k = db.key("2026-11-13T07:00:00Z");
    sqlx::query(
        "CREATE TRIGGER metrics.boom BEFORE INSERT ON app_hour_lat \
         BEGIN SELECT RAISE(ABORT, 'injected'); END",
    )
    .execute(&db.pool)
    .await
    .expect("trigger");
    let mut tx = db.pool.begin().await.expect("tx");
    assert!(
        record_request(&mut tx, k, 10, Some(5), false)
            .await
            .is_err(),
        "the histogram write fails"
    );
    drop(tx);
    assert!(db.stored(k).await.is_none());

    sqlx::query("DROP TRIGGER metrics.boom")
        .execute(&db.pool)
        .await
        .expect("drop trigger");
    db.request(k, 10, Some(5)).await;
    let row = db.stored(k).await.expect("row");
    assert_eq!(row.requests, 1, "the retried line counts once");
    assert_eq!(db.histogram(k).await.iter().map(|(_, n)| n).sum::<i64>(), 1);
}

/// Pruning drops the hour rows and the histogram rows that fed them, and
/// nothing inside the window.
#[tokio::test]
async fn prune_drops_whole_hours() {
    let db = TestDb::new().await;
    let old = db.key("2026-11-01T07:00:00Z");
    let fresh = db.key("2026-11-13T07:00:00Z");
    db.request(old, 10, Some(5)).await;
    db.request(fresh, 11, Some(5)).await;
    let pruned = db::prune_app_hours(&db.pool, "2026-11-06T00:00:00Z")
        .await
        .expect("prune");
    assert_eq!(pruned, 2, "one hour row and one histogram row");
    assert!(db.stored(old).await.is_none());
    assert!(db.histogram(old).await.is_empty());
    assert!(db.stored(fresh).await.is_some());
}
