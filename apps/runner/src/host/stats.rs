//! Process-wide cost counters (spec T0.1): every later phase quotes its
//! before/after from the same harness, so all recurring work is counted here.
//!
//! What is tracked:
//! - subprocess spawns by program (`aws`, `duckdb`, `git`, `celld`, `bun`),
//! - S3 operations by verb, with bytes up and down,
//! - DuckDB runs by purpose (`ingest`, `spans`, `logs`, `compact`, legacy),
//! - snapshot uploads with bytes,
//! - live SSE loops by kind (gauge, not cumulative),
//! - scale-to-zero transitions (apps slept / woken).
//!
//! Plus process RSS and CPU time from `/proc/self` at read time.
//! Served bearer-gated on `GET /v1/admin/stats`.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

struct Counters {
    spawns: Mutex<HashMap<String, u64>>,
    s3_ops: Mutex<HashMap<String, u64>>,
    s3_up: Mutex<HashMap<String, u64>>,
    s3_down: Mutex<HashMap<String, u64>>,
    duckdb: Mutex<HashMap<String, u64>>,
    snapshots: Mutex<(u64, u64)>, // (uploads, bytes)
    sse: Mutex<HashMap<String, i64>>,
    /// Scale to zero: apps parked by the sweep / woken by a request.
    sleep: Mutex<HashMap<String, u64>>,
}

static COUNTERS: LazyLock<Counters> = LazyLock::new(|| Counters {
    spawns: Mutex::new(HashMap::new()),
    s3_ops: Mutex::new(HashMap::new()),
    s3_up: Mutex::new(HashMap::new()),
    s3_down: Mutex::new(HashMap::new()),
    duckdb: Mutex::new(HashMap::new()),
    snapshots: Mutex::new((0, 0)),
    sse: Mutex::new(HashMap::new()),
    sleep: Mutex::new(HashMap::new()),
});

fn counters() -> &'static Counters {
    &COUNTERS
}
fn bump(map: &Mutex<HashMap<String, u64>>, key: &str, by: u64) {
    if let Ok(mut m) = map.lock() {
        *m.entry(key.to_string()).or_insert(0) += by;
    }
}

/// Basename of the spawned program (`/usr/local/bin/duckdb` -> `duckdb`).
fn short(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

/// One subprocess spawn of `program` (called from `host::cmd`).
pub fn count_spawn(program: &str) {
    bump(&counters().spawns, short(program), 1);
}

/// One S3 operation: `verb` is `list`, `head`, `upload`, `download`,
/// `delete`, `rm_dir` or `ensure`. Byte counts are best-effort (0 when the
/// helper does not know the size without another call).
pub fn count_s3(verb: &str, bytes_up: u64, bytes_down: u64) {
    let c = counters();
    bump(&c.s3_ops, verb, 1);
    if bytes_up > 0 {
        bump(&c.s3_up, verb, bytes_up);
    }
    if bytes_down > 0 {
        bump(&c.s3_down, verb, bytes_down);
    }
}

/// One DuckDB run for `purpose` (`ingest`, `compact`, …).
pub fn count_duckdb(purpose: &str) {
    bump(&counters().duckdb, purpose, 1);
}

/// One state-snapshot upload of `bytes` (post-compression).
pub fn count_snapshot(bytes: u64) {
    if let Ok(mut s) = counters().snapshots.lock() {
        s.0 += 1;
        s.1 += bytes;
    }
}

/// A live SSE loop of `kind` started (`sse_enter`) / finished (`sse_exit`).
/// Gauge: leaks (loops that never exit) stay visible instead of washing out.
pub fn sse_enter(kind: &str) {
    if let Ok(mut m) = counters().sse.lock() {
        *m.entry(kind.to_string()).or_insert(0) += 1;
    }
}

pub fn sse_exit(kind: &str) {
    if let Ok(mut m) = counters().sse.lock() {
        let e = m.entry(kind.to_string()).or_insert(0);
        *e = e.saturating_sub(1);
    }
}

/// One app parked by the sleep sweep (SPEC, Scale to zero).
pub fn record_sleep() {
    bump(&counters().sleep, "slept", 1);
}

/// One app woken by a held request.
pub fn record_wake() {
    bump(&counters().sleep, "woken", 1);
}

fn map_snapshot(map: &Mutex<HashMap<String, u64>>) -> serde_json::Value {
    map.lock()
        .ok()
        .map(|m| {
            let mut v: Vec<(&String, &u64)> = m.iter().collect();
            v.sort_by(|a, b| a.0.cmp(b.0));
            v.into_iter()
                .map(|(k, n)| (k.clone(), serde_json::json!(*n)))
                .collect::<serde_json::Map<String, serde_json::Value>>()
        })
        .map(serde_json::Value::Object)
        .unwrap_or(serde_json::Value::Null)
}

/// Resident set + user/sys CPU seconds for this process, from `/proc/self`.
/// Best-effort: missing files (non-Linux) read as zeros, never an error.
fn proc_self() -> (u64, f64) {
    let rss = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                let rest = l.strip_prefix("VmRSS:")?.trim();
                let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
                Some(kb * 1024)
            })
        })
        .unwrap_or(0);
    let cpu = std::fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|t| {
            // comm may contain spaces/parens: fields 14,15 (utime,stime)
            // follow the last ')'.
            let after = t.rsplit(')').next()?;
            let f: Vec<&str> = after.split_whitespace().collect();
            // After `)`, field indices shift by 2 (pid + comm consumed).
            let ut: u64 = f.get(11)?.parse().ok()?;
            let st: u64 = f.get(12)?.parse().ok()?;
            let ticks = ut + st;
            let per = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
            if per > 0.0 {
                Some(ticks as f64 / per)
            } else {
                None
            }
        })
        .unwrap_or(0.0);
    (rss, cpu)
}

pub fn snapshot() -> serde_json::Value {
    let c = counters();
    let (uploads, bytes) = c.snapshots.lock().ok().map(|s| (s.0, s.1)).unwrap_or((0, 0));
    let (rss, cpu_s) = proc_self();
    serde_json::json!({
        "spawns": map_snapshot(&c.spawns),
        "s3_ops": map_snapshot(&c.s3_ops),
        "s3_bytes_up": map_snapshot(&c.s3_up),
        "s3_bytes_down": map_snapshot(&c.s3_down),
        "duckdb": map_snapshot(&c.duckdb),
        "snapshots": { "uploads": uploads, "bytes": bytes },
        "sleep": map_snapshot(&c.sleep),
        "sse": c.sse.lock().ok().map(|m| {
            let mut v: Vec<(&String, &i64)> = m.iter().collect();
            v.sort_by(|a, b| a.0.cmp(b.0));
            v.into_iter().map(|(k, n)| (k.clone(), serde_json::json!(*n)))
                .collect::<serde_json::Map<String, serde_json::Value>>()
        }).map(serde_json::Value::Object).unwrap_or(serde_json::Value::Null),
        "rss_bytes": rss,
        "cpu_seconds": cpu_s,
    })
}

#[cfg(test)]
mod tests {
    use super::{count_duckdb, count_s3, count_snapshot, snapshot, sse_enter, sse_exit};

    #[test]
    fn admin_stats_shape() {
        count_s3("list", 0, 0);
        count_duckdb("ingest");
        count_snapshot(10);
        sse_enter("logs");
        sse_exit("logs");
        let v = snapshot();
        assert_eq!(v["s3_ops"]["list"], 1);
        assert_eq!(v["duckdb"]["ingest"], 1);
        assert!(v["rss_bytes"].is_number());
        assert!(v["cpu_seconds"].is_number());
    }
}
