//! Hourly per-fleet counters: requests, errors, p50/p95 latency, memory and
//! CPU, one `metrics.app_hour` row per (app, environment, hour).
//!
//! Two feeds, one writer. The access-log tail folds each served request in at
//! the moment its line commits; the tick folds one cgroup memory sample and its
//! CPU delta in every pass. Every write is a *whole-row replacement* computed
//! from the stored row inside the same transaction — never an increment — so a
//! retried line cannot double count and a restart needs no state at all: the
//! row in `metrics.sqlite` is the hour's only state.
//!
//! The percentiles come from a fixed log-scale histogram
//! (`metrics.app_hour_lat`), written alongside the row: the hour keeps at most
//! [`LAT_BUCKETS`] counter rows instead of latency samples, and a dashboard
//! read needs only the `app_hour` row.
use chrono::Utc;
use sqlx::{Sqlite, SqliteConnection, SqlitePool, Transaction};

use crate::db;

/// Log-scale latency buckets: bucket 0 is `< 1 ms`, bucket `k` is
/// `[2^(k-1), 2^k)` ms, and the top bucket absorbs everything slower (4.4 min
/// and up). Twenty-fold resolution at the latencies a dashboard tile reads,
/// constant memory per fleet.
pub const LAT_BUCKETS: usize = 19;

/// The bucket a latency in milliseconds lands in.
fn lat_bucket(ms: i64) -> usize {
    if ms < 1 {
        return 0;
    }
    // ms >= 1, so this is floor(log2(ms)) + 1: 1 → 1, 2..3 → 2, 4..7 → 3, …
    let k = 64 - (ms as u64).leading_zeros() as usize;
    k.min(LAT_BUCKETS - 1)
}

/// The value a percentile names: the bucket's exclusive upper bound in
/// milliseconds.
fn lat_ceiling(bucket: usize) -> i64 {
    if bucket == 0 {
        return 1;
    }
    1_i64 << bucket
}

/// The `p` quantile of a histogram, as the ceiling of the bucket its rank lands
/// in. An empty histogram is 0.
fn percentile(hist: &[i64; LAT_BUCKETS], p: f64) -> i64 {
    let total: i64 = hist.iter().sum();
    if total <= 0 {
        return 0;
    }
    // 1-based rank: p50 of 4 samples is its 2nd, p95 of 20 its 20th.
    let rank = (((total as f64) * p).ceil() as i64).clamp(1, total);
    let mut cum = 0;
    for (bucket, n) in hist.iter().enumerate() {
        cum += n;
        if cum >= rank {
            return lat_ceiling(bucket);
        }
    }
    lat_ceiling(LAT_BUCKETS - 1)
}

/// The row key: one fleet's one hour.
#[derive(Debug, Clone, Copy)]
pub struct Key<'a> {
    pub app_id: &'a str,
    pub environment_id: &'a str,
    pub bucket_hour: &'a str,
}

/// One fleet's open hour, as loaded from `app_hour` and its histogram. Memory
/// is kept as an exact (sum, count) pair — the mean is derived where it is read
/// — and the peak as a running maximum.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct HourRow {
    requests: i64,
    errors: i64,
    last_request_us: i64,
    cpu_ms: i64,
    mem_sum: i64,
    mem_samples: i64,
    mem_max: i64,
    hist: [i64; LAT_BUCKETS],
}

impl HourRow {
    /// Restore an hour from its stored row and histogram.
    ///
    /// The memory pair is restored exactly, so a rewrite that folds one more
    /// sample keeps the hour's true mean; nothing is re-weighted.
    fn restored(stored: Option<db::AppHourValues>, hist: Vec<(i64, i64)>) -> Self {
        let mut row = Self::default();
        if let Some(stored) = stored {
            row.requests = stored.requests;
            row.errors = stored.errors;
            row.last_request_us = stored.last_request_us;
            row.cpu_ms = stored.cpu_ms;
            row.mem_max = stored.mem_max_bytes;
            row.mem_sum = stored.mem_sum_bytes;
            row.mem_samples = stored.mem_samples;
        }
        for (bucket, n) in hist {
            if let Some(slot) = usize::try_from(bucket)
                .ok()
                .and_then(|b| row.hist.get_mut(b))
            {
                *slot = n;
            }
        }
        row
    }

    /// Fold one served request in: count it, bucket its latency (when the edge
    /// logged one), and keep the newest request stamp the sleep sweeper reads.
    /// Returns the histogram bucket to persist.
    fn push_request(&mut self, ts_us: i64, duration_ms: Option<i64>, error: bool) -> Option<usize> {
        self.requests += 1;
        if error {
            self.errors += 1;
        }
        self.last_request_us = self.last_request_us.max(ts_us);
        let bucket = lat_bucket(duration_ms?.max(0));
        self.hist[bucket] += 1;
        Some(bucket)
    }

    fn values(&self) -> db::AppHourValues {
        db::AppHourValues {
            requests: self.requests,
            errors: self.errors,
            p50_ms: percentile(&self.hist, 0.50),
            p95_ms: percentile(&self.hist, 0.95),
            mem_max_bytes: self.mem_max,
            mem_sum_bytes: self.mem_sum,
            mem_samples: self.mem_samples,
            last_request_us: self.last_request_us,
            cpu_ms: self.cpu_ms,
        }
    }
}

async fn load(conn: &mut SqliteConnection, key: Key<'_>) -> sqlx::Result<HourRow> {
    let stored = db::get_app_hour(conn, key.app_id, key.environment_id, key.bucket_hour).await?;
    let hist = db::app_hour_lat(conn, key.app_id, key.environment_id, key.bucket_hour).await?;
    Ok(HourRow::restored(stored, hist))
}

async fn store(
    conn: &mut SqliteConnection,
    key: Key<'_>,
    row: &HourRow,
    touched: Option<usize>,
) -> sqlx::Result<()> {
    db::replace_app_hour(
        conn,
        key.app_id,
        key.environment_id,
        key.bucket_hour,
        &row.values(),
    )
    .await?;
    if let Some(bucket) = touched {
        db::replace_app_hour_lat(
            conn,
            key.app_id,
            key.environment_id,
            key.bucket_hour,
            bucket as i64,
            row.hist[bucket],
        )
        .await?;
    }
    Ok(())
}

/// Fold one served request into the fleet's hour, inside the caller's
/// transaction: the tail commits the line's device counters and this row
/// together, so a retried line is all-or-nothing.
pub async fn record_request(
    tx: &mut Transaction<'_, Sqlite>,
    key: Key<'_>,
    ts_us: i64,
    duration_ms: Option<i64>,
    error: bool,
) -> sqlx::Result<()> {
    let mut row = load(tx, key).await?;
    let touched = row.push_request(ts_us, duration_ms, error);
    store(tx, key, &row, touched).await
}

/// Fold one cgroup memory sample into the fleet's hour: the hour keeps the peak
/// and the mean over every sample the fleet was resident for.
pub async fn record_memory(pool: &SqlitePool, key: Key<'_>, bytes: u64) -> sqlx::Result<()> {
    let bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
    write(pool, key, |row| {
        row.mem_sum += bytes;
        row.mem_samples += 1;
        row.mem_max = row.mem_max.max(bytes);
        None
    })
    .await
}

/// Fold one CPU delta (the `/proc` sampler's, in ms) into the fleet's hour.
pub async fn record_cpu(pool: &SqlitePool, key: Key<'_>, cpu_ms: i64) -> sqlx::Result<()> {
    write(pool, key, |row| {
        row.cpu_ms += cpu_ms;
        None
    })
    .await
}

/// A sampler's fold, in its own transaction: load, apply, replace.
async fn write<F>(pool: &SqlitePool, key: Key<'_>, f: F) -> sqlx::Result<()>
where
    F: FnOnce(&mut HourRow) -> Option<usize>,
{
    let mut tx = pool.begin().await?;
    let mut row = load(&mut tx, key).await?;
    let touched = f(&mut row);
    store(&mut tx, key, &row, touched).await?;
    tx.commit().await?;
    Ok(())
}

/// The current hour, in the stamp every hour row uses.
pub fn hour_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:00:00Z").to_string()
}

/// The hour a minute bucket belongs to (`2026-11-13T07:35:00Z` →
/// `2026-11-13T07:00:00Z`). A stamp that is not a minute bucket falls back to
/// the current hour rather than panicking.
pub fn hour_of(minute_bucket: &str) -> String {
    match minute_bucket.get(..13) {
        Some(hour) => format!("{hour}:00:00Z"),
        None => hour_now(),
    }
}

#[cfg(test)]
mod tests;
