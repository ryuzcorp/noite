//! CPU sampling from `/proc` (UTIME + STIME, subtree-wise) and the celld
//! telemetry environment every node runs with.

use std::collections::HashMap;

use crate::config::Config;
use crate::host::supervisor::ProcMap;

fn read_proc_stat(pid: u32) -> Option<(u64, u64)> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let close = s.rfind(')')?;
    let rest = s[close + 2..].trim();
    // After "pid (comm) ": 0=state 1=ppid 2=pgrp 3=session 4=tty 5=tpgid
    // 6=flags 7=minflt 8=cminflt 9=majflt 10=cmajflt 11=utime 12=stime
    let mut it = rest.split_whitespace();
    for _ in 0..11 {
        it.next()?;
    }
    let utime: u64 = it.next()?.parse().ok()?;
    let stime: u64 = it.next()?.parse().ok()?;
    Some((utime, stime))
}

fn proc_children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .map(|s| {
            s.split_whitespace()
                .filter_map(|p| p.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// celld may run isolates in descendants — sum the process subtree.
fn proc_cpu_recursive(pid: u32, depth: u32) -> (u64, u64) {
    let mut total = read_proc_stat(pid).unwrap_or((0, 0));
    if depth == 0 {
        return total;
    }
    for child in proc_children(pid) {
        let (u, s) = proc_cpu_recursive(child, depth - 1);
        total.0 += u;
        total.1 += s;
    }
    total
}

/// CPU samples for the tenant fleets plus the control node. The control
/// celld is not in the `procs` map (it is a `children::Supervised`, not an
/// app), so its pid is handed in by the caller.
pub(super) fn sample_cpu(procs: &ProcMap, control_pid: u32) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    if control_pid != 0 {
        out.insert(
            crate::host::control::SLUG.to_string(),
            proc_cpu_recursive(control_pid, 3),
        );
    }
    let Ok(map) = procs.try_lock() else {
        return out;
    };
    for (slug, child) in map.iter() {
        if let Some(pid) = child.id() {
            out.insert(slug.clone(), proc_cpu_recursive(pid, 3));
        }
    }
    out
}

/// Telemetry flush interval celld runs with (`CELLD_OTEL_FLUSH_MS`, from
/// `RUNNER_OTEL_FLUSH_MS`, spec T3.4). 30 s by default: short enough for
/// minute-bucket pricing, 6x fewer PUTs/files than the old 5 s, and only safe
/// because the runner also runs the documented compaction job. Dashboards lag
/// live traffic by up to ~40 s instead of ~15 s (accepted trade-off).
pub(super) fn otel_flush_ms(cfg: &Config) -> u64 {
    cfg.otel_flush_ms.max(1000)
}

/// The celld telemetry environment every node runs with — tenant fleets
/// (`host::supervisor::ensure_fleet`) and the control fleet
/// (`host::control::supervise`) alike, so the bucket sink, the flush the ingest
/// cadence assumes and the retention the prune uses can never drift between
/// them. celld writes under `telemetry/` relative to its `--bucket`, so a
/// fleet's files land at `<bucket>/telemetry/...` (see
/// [`telemetry_prefix`] for what that prefix is per source).
pub fn otel_env(cfg: &Config) -> [(&'static str, String); 3] {
    [
        ("CELLD_OTEL", "1".to_string()),
        ("CELLD_OTEL_FLUSH_MS", cfg.otel_flush_ms.to_string()),
        (
            "CELLD_OTEL_RETENTION",
            format!("{}d", cfg.telemetry_retention_days),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_sampling_includes_the_control_node_when_it_runs() {
        // The control celld is not in the procs map; its pid slot is sampled
        // too, so its CPU lands in the same `app_metric.cpu_ms` accumulator.
        let procs = crate::host::supervisor::new_procs();
        assert!(
            !sample_cpu(&procs, 0).contains_key(crate::host::control::SLUG),
            "no control process means no sample"
        );
        assert!(
            sample_cpu(&procs, std::process::id()).contains_key(crate::host::control::SLUG),
            "a running control node is sampled"
        );
    }
}
