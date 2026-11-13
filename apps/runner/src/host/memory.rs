//! The memory and core count the runner sizes its helpers against.
//!
//! The runner is PID 1 in the install's one container. A helper that forks its
//! own pool (the Parquet reader and the deploy helpers size their work from
//! the machine) must be sized from what the container may actually use:
//! the cgroup limit when the operator set one, otherwise the host. Sizing from
//! `/proc/meminfo` while a container limit applies asks for more than the box
//! has, and sizing from the host on an unbounded container is the same number
//! anyway.
//!
//! Mirrors celld's own detection (`crates/celld/memory.rs`,
//! `crates/celld/machine.rs`): cgroup v2 `memory.max`, then v1's
//! `memory.limit_in_bytes`, then `/proc/meminfo`.

/// The cgroup memory limit that applies to this process, if one is set:
/// v2 `memory.max`, then v1's `memory.limit_in_bytes`. v1 reports "no
/// limit" as a huge page-rounded value, v2 writes the literal `max`.
#[cfg(target_os = "linux")]
pub fn container_limit_bytes() -> Option<u64> {
    for path in [
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ] {
        if let Ok(raw) = std::fs::read_to_string(path) {
            if let Ok(limit) = raw.trim().parse::<u64>() {
                if limit < (1 << 50) {
                    return Some(limit);
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
pub fn container_limit_bytes() -> Option<u64> {
    None
}

/// One `/proc/meminfo` value in bytes (`MemTotal`, `MemAvailable`, ...).
#[cfg(target_os = "linux")]
fn meminfo_bytes(text: &str, key: &str) -> Option<u64> {
    let kb = text
        .lines()
        .find_map(|line| line.strip_prefix(key))?
        .split_whitespace()
        .next()?
        .parse::<u64>()
        .ok()?;
    Some(kb.saturating_mul(1024))
}

/// Host memory in use, from `/proc/meminfo`: `MemTotal - MemAvailable`. On an
/// unbounded container this is what the kernel OOM killer sees — the bundled
/// RustFS, dockerd and the host itself are outside this container, so its
/// own `memory.current` says nothing about them.
#[cfg(target_os = "linux")]
pub fn host_used_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let total = meminfo_bytes(&text, "MemTotal:")?;
    let available = meminfo_bytes(&text, "MemAvailable:")?;
    Some(total.saturating_sub(available))
}

#[cfg(not(target_os = "linux"))]
pub fn host_used_bytes() -> Option<u64> {
    None
}

/// Detected memory limit in bytes: the cgroup limit that applies to this
/// process, else the host total. `None` when neither is readable.
#[cfg(target_os = "linux")]
pub fn total_bytes() -> Option<u64> {
    container_limit_bytes().or_else(|| {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        meminfo_bytes(&text, "MemTotal:")
    })
}

#[cfg(not(target_os = "linux"))]
pub fn total_bytes() -> Option<u64> {
    None
}

/// Host swap in bytes (`SwapTotal`), `None` when unreadable. Build leaves
/// size their swap allowance from it: on a box too small to hold a
/// Vite/Rolldown build in RAM, the overflow is what keeps the build alive.
#[cfg(target_os = "linux")]
pub fn swap_total_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    meminfo_bytes(&text, "SwapTotal:")
}

#[cfg(not(target_os = "linux"))]
pub fn swap_total_bytes() -> Option<u64> {
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
/// is exactly what the kernel OOM limit sees — of *this* container only.
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

/// `(used, limit)` for the pressure guard: the container's charge against its
/// cgroup limit when the container is bounded, otherwise the host's used
/// memory against `MemTotal`. The split matters: the bundled RustFS runs in
/// its own container, so an unbounded install whose `memory.current` looks
/// idle can still be minutes away from the host OOM killer.
pub fn pressure_sample() -> Option<(u64, u64)> {
    sample_from(
        container_limit_bytes(),
        current_bytes(),
        host_used_bytes(),
        total_bytes(),
    )
}

/// The decision behind [`pressure_sample`], split out so the unbounded case
/// is testable without the real cgroup: a bounded container reports its own
/// charge and limit; an unbounded one reports the host's used memory and
/// total (its own charge is not the box).
fn sample_from(
    container_limit: Option<u64>,
    container_current: Option<u64>,
    host_used: Option<u64>,
    host_total: Option<u64>,
) -> Option<(u64, u64)> {
    match container_limit {
        Some(limit) => container_current.map(|used| (used, limit)),
        None => Some((host_used?, host_total?)),
    }
}

/// A memory sample for `/v1/admin/stats` and `/ready`: what the box holds
/// now, the limit that applies, and the percentage between them. `scope`
/// names which pair it is: `container` for a bounded container, `host` for
/// an unbounded one (see [`pressure_sample`]).
pub fn usage() -> Option<serde_json::Value> {
    let container = container_limit_bytes();
    let (current, limit, scope) = match container {
        Some(limit) => (current_bytes()?, limit, "container"),
        None => (host_used_bytes()?, total_bytes()?, "host"),
    };
    let percent = current
        .saturating_mul(100)
        .checked_div(limit)
        .unwrap_or(0)
        .min(100);
    Some(serde_json::json!({
        "scope": scope,
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

    #[cfg(target_os = "linux")]
    #[test]
    fn host_usage_is_total_minus_available() {
        let meminfo =
            "MemTotal:       2000000 kB\nMemFree:         100000 kB\nMemAvailable:    400000 kB\n";
        assert_eq!(meminfo_bytes(meminfo, "MemTotal:"), Some(2_000_000 * 1024));
        let total = meminfo_bytes(meminfo, "MemTotal:").expect("total");
        let available = meminfo_bytes(meminfo, "MemAvailable:").expect("available");
        assert_eq!(total.saturating_sub(available), 1_600_000 * 1024);
    }

    #[test]
    fn pressure_sampling_follows_the_effective_scope() {
        // A bounded container is measured against its own cgroup, even when
        // the host is hotter: the kernel limit for it is the cgroup.
        assert_eq!(
            sample_from(Some(512), Some(100), Some(1500), Some(1900)),
            Some((100, 512))
        );
        // Unbounded: the host is the box (RustFS etc. live outside this
        // container), so both the used and the limit come from meminfo.
        assert_eq!(
            sample_from(None, Some(20), Some(1500), Some(1900)),
            Some((1500, 1900))
        );
        // No host total, no sample: never divide by a missing limit.
        assert_eq!(sample_from(None, Some(20), Some(1500), None), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_or_impossible_meminfo_values_are_not_a_sample() {
        let no_available = "MemTotal:       2000000 kB\nMemFree: 100 kB\n";
        assert_eq!(meminfo_bytes(no_available, "MemAvailable:"), None);
        let available_over_total = "MemTotal: 1000 kB\nMemAvailable: 2000 kB\n";
        let total = meminfo_bytes(available_over_total, "MemTotal:").expect("total");
        let available = meminfo_bytes(available_over_total, "MemAvailable:").expect("available");
        assert_eq!(total.saturating_sub(available), 0);
    }
}
