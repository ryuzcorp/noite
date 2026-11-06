//! The memory and core count the runner sizes its helpers against.
//!
//! The runner is PID 1 in the install's one container. A helper that forks its
//! own pool (the telemetry DuckDB CLI reads `max_threads` and `memory_limit`
//! from the machine) must be sized from what the container may actually use:
//! the cgroup limit when the operator set one, otherwise the host. Sizing from
//! `/proc/meminfo` while a container limit applies asks for more than the box
//! has, and sizing from the host on an unbounded container is the same number
//! anyway.
//!
//! Mirrors celld's own detection (`crates/celld/memory.rs`,
//! `crates/celld/machine.rs`): cgroup v2 `memory.max`, then v1's
//! `memory.limit_in_bytes`, then `/proc/meminfo`.

/// Detected memory limit in bytes: the cgroup limit that applies to this
/// process, else the host total. `None` when neither is readable.
#[cfg(target_os = "linux")]
pub fn total_bytes() -> Option<u64> {
    for path in [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(limit) = raw.trim().parse::<u64>() {
                // cgroup v1 reports "no limit" as a huge page-rounded value;
                // v2 writes the literal `max`, which fails the parse above.
                if limit < (1 << 50) {
                    return Some(limit);
                }
            }
        }
    }
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb = meminfo
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kb.saturating_mul(1024))
}

#[cfg(not(target_os = "linux"))]
pub fn total_bytes() -> Option<u64> {
    None
}

/// Reads one cgroup memory file, v2 then v1. `parse` filters v1's
/// page-rounded "no limit" value.
#[cfg(target_os = "linux")]
fn read_cgroup(paths: &[&str], max: Option<u64>) -> Option<u64> {
    for path in paths {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(value) = raw.trim().parse::<u64>() {
                if max.is_none_or(|max| value < max) {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// The container's current memory charge (`memory.current`, v1
/// `memory.usage_in_bytes`). Includes page cache and kernel charges, which
/// is exactly what the kernel OOM limit sees.
#[cfg(target_os = "linux")]
pub fn current_bytes() -> Option<u64> {
    read_cgroup(
        &[
            "/sys/fs/cgroup/memory.current",
            "/sys/fs/cgroup/memory/memory.usage_in_bytes",
        ],
        None,
    )
}

#[cfg(not(target_os = "linux"))]
pub fn current_bytes() -> Option<u64> {
    None
}

/// A memory sample for `/v1/admin/stats` and `/ready`: what this container
/// holds now, the limit that applies (the host when unbounded), and the
/// percentage between them.
pub fn usage() -> Option<serde_json::Value> {
    let current = current_bytes()?;
    let limit = total_bytes()?;
    let percent = current
        .saturating_mul(100)
        .checked_div(limit)
        .unwrap_or(0)
        .min(100);
    Some(serde_json::json!({
        "current_bytes": current,
        "limit_bytes": limit,
        "used_percent": percent,
    }))
}

/// Cores this process may use. `available_parallelism` honours cgroup CPU
/// quotas and affinity, so a 2 vCPU container reports 2 even on a big host.
pub fn cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_never_returns_zero() {
        if let Some(bytes) = total_bytes() {
            assert!(bytes > 0, "a zero limit is not a limit");
        }
        assert!(cores() >= 1);
    }
}
