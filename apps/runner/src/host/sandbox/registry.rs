//! Who owns what on the sandbox plane: live fleet processes and the Sandbox
//! containers each one started. The engine proxy writes it (it sees every
//! create and inspect a fleet makes), the gateway reads it (a fleet may only
//! dial its own containers), and the supervisor registers fleet pids.
//!
//! Process-local and rebuilt from scratch on every boot: every fleet restarts
//! with the runner, and the boot sweep removes the containers of the previous
//! run (`super::engine::sweep`).

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Mutex, MutexGuard};

#[derive(Default)]
struct Registry {
    /// Fleet key → main pid of its celld process.
    pids: HashMap<String, u32>,
    /// Container name (`celld-…`) → owning fleet key.
    containers: HashMap<String, String>,
    /// Container bridge address → container name.
    addresses: HashMap<Ipv4Addr, String>,
}

static REGISTRY: Mutex<Option<Registry>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Registry) -> T) -> T {
    let mut guard: MutexGuard<'_, Option<Registry>> =
        REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(Registry::default))
}

/// A fleet's celld process started (supervisor, right after spawn).
pub fn register_fleet(key: &str, pid: u32) {
    with(|r| {
        r.pids.insert(key.to_string(), pid);
    });
}

/// A fleet's process is gone. Its containers stay recorded until
/// `forget_fleet_containers` (the caller removes them from the engine first).
pub fn unregister_fleet(key: &str) {
    with(|r| {
        r.pids.remove(key);
    });
}

/// The fleet whose celld process has this pid.
pub fn fleet_of_pid(pid: u32) -> Option<String> {
    with(|r| {
        r.pids
            .iter()
            .find(|(_, p)| **p == pid)
            .map(|(k, _)| k.clone())
    })
}

/// The pid of a fleet's celld process.
pub fn pid_of_fleet(key: &str) -> Option<u32> {
    with(|r| r.pids.get(key).copied())
}

/// Every live fleet with its pid.
pub fn fleet_pids() -> Vec<(String, u32)> {
    with(|r| r.pids.iter().map(|(k, p)| (k.clone(), *p)).collect())
}

/// A fleet created (or inspected) one of its containers; `ip` is its bridge
/// address once the engine reports one. A name moving to another fleet is
/// impossible (names hash the celld node), but the latest writer wins.
pub fn record_container(fleet: &str, name: &str, ip: Option<Ipv4Addr>) {
    with(|r| {
        r.containers.insert(name.to_string(), fleet.to_string());
        if let Some(ip) = ip {
            r.addresses.retain(|_, n| n != name);
            r.addresses.insert(ip, name.to_string());
        }
    });
}

/// A container was removed: drop it and its address.
pub fn forget_container(name: &str) {
    with(|r| {
        r.containers.remove(name);
        r.addresses.retain(|_, n| n != name);
    });
}

/// The fleet owning a container name.
pub fn owner_of_container(name: &str) -> Option<String> {
    with(|r| r.containers.get(name).cloned())
}

/// The fleet owning the container at this bridge address.
pub fn owner_of_ip(ip: Ipv4Addr) -> Option<String> {
    with(|r| {
        r.addresses
            .get(&ip)
            .and_then(|name| r.containers.get(name))
            .cloned()
    })
}

/// Drop every container recorded for a fleet; returns their names.
pub fn forget_fleet_containers(fleet: &str) -> Vec<String> {
    with(|r| {
        let names: Vec<String> = r
            .containers
            .iter()
            .filter(|(_, f)| f.as_str() == fleet)
            .map(|(n, _)| n.clone())
            .collect();
        for name in &names {
            r.containers.remove(name);
        }
        r.addresses.retain(|_, n| !names.contains(n));
        names
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_resolve_to_the_creating_fleet_until_forgotten() {
        let ip = Ipv4Addr::new(172, 31, 250, 7);
        record_container("reg-a", "celld-reg-a-1", None);
        assert_eq!(owner_of_ip(ip), None, "no address yet");
        record_container("reg-a", "celld-reg-a-1", Some(ip));
        assert_eq!(owner_of_ip(ip).as_deref(), Some("reg-a"));
        assert_eq!(owner_of_container("celld-reg-a-1").as_deref(), Some("reg-a"));
        // The engine reuses a freed address for another fleet's container.
        forget_container("celld-reg-a-1");
        assert_eq!(owner_of_ip(ip), None);
        record_container("reg-b", "celld-reg-b-1", Some(ip));
        assert_eq!(owner_of_ip(ip).as_deref(), Some("reg-b"));
        assert_eq!(forget_fleet_containers("reg-b"), vec!["celld-reg-b-1".to_string()]);
        assert_eq!(owner_of_ip(ip), None);
    }

    #[test]
    fn pids_map_both_ways_and_unregister() {
        register_fleet("reg-pid", 4_000_001);
        assert_eq!(fleet_of_pid(4_000_001).as_deref(), Some("reg-pid"));
        assert_eq!(pid_of_fleet("reg-pid"), Some(4_000_001));
        unregister_fleet("reg-pid");
        assert_eq!(fleet_of_pid(4_000_001), None);
    }
}
