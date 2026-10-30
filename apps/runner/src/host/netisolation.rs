//! Per-uid egress policy (SPEC, Egress policy).
//!
//! Fleets run as `fleet` (uid 10020) and each app's builds/release commands as
//! its own uid from the reserved per-app range (`db::ensure_app_build_uid`,
//! `config::BUILD_UID_BASE`) via `Command::uid`. The runner installs, at boot,
//! an nftables table that applies to *new* connections from those uids only:
//! no loopback (fleet→fleet, fleet→operator APIs, the runner, Caddy's admin),
//! no RFC1918/link-local/CG NAT (RustFS, peers, cloud metadata), IPv6
//! loopback/ULA/link-local closed, DNS (53) allowed, everything else
//! (internet) accepted. The build range is one `skuid lo-hi` match per rule,
//! so an app allocated any uid in the range is policed. Replies on connections
//! others opened (Caddy → a fleet, the host's published ports) always pass.
//!
//! Two dynamic allowances punch scoped holes ahead of the rejects: the object
//! store's addresses (both identities — release commands hold the scope key)
//! and celld's Sandbox bridge subnets (fleet only — builds never dial
//! sandboxes; see `host::sandbox_net`, which also owns the host-leg table).
//!
//! Requires `CAP_NET_ADMIN`. The runner probes at boot (`nft list tables`)
//! and exposes the result in `/ready` detail and `make doctor`. Where no
//! capabilities exist, installs run `single` tenancy (Step C bwrap fallback
//! is documented but not implemented until Railway lacks NET_ADMIN).

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

static NFT_OK: AtomicBool = AtomicBool::new(false);
/// Storage allowance the applied table carries (to notice when it moves).
static APPLIED_STORAGE: Mutex<Storage> = Mutex::new(Storage {
    addrs: Vec::new(),
    port: 0,
});
/// Sandbox subnets the applied table allows (to notice when they appear).
static APPLIED_SANDBOX: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The object store a tenant fleet's own celld process must reach: its
/// resolved addresses and port. Worker code in that process can reach it
/// too, but only the store's unauthenticated surface: the keys stay inside
/// celld.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Storage {
    pub addrs: Vec<IpAddr>,
    pub port: u16,
}

/// Resolve `S3_ENDPOINT` (e.g. `http://rustfs:9000`) to the addresses the
/// fleet user may dial. Empty when it does not resolve.
pub async fn storage_target(endpoint: &str) -> Storage {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return Storage::default();
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Storage::default();
    };
    let mut addrs: Vec<IpAddr> = tokio::net::lookup_host((host, port))
        .await
        .map(|it| it.map(|sa| sa.ip()).collect())
        .unwrap_or_default();
    addrs.sort();
    addrs.dedup();
    Storage { addrs, port }
}
static NFT_REASON: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn reason(msg: String) {
    let _ = NFT_REASON.set(msg);
}

/// Record why the policy is not installed (single tenancy).
pub fn skip(why: &str) {
    reason(why.to_string());
    NFT_OK.store(false, Ordering::Relaxed);
}

fn applied_storage() -> Storage {
    APPLIED_STORAGE
        .lock()
        .map(|applied| applied.clone())
        .unwrap_or_default()
}

fn applied_sandbox() -> Vec<String> {
    APPLIED_SANDBOX
        .lock()
        .map(|applied| applied.clone())
        .unwrap_or_default()
}

/// Keep the dynamic allowances current: the bundled store's container address
/// can change when it restarts, and celld creates its Sandbox bridges lazily
/// on first Sandbox use — a stale table would cut every fleet off from its
/// bucket or leave Sandbox containers unreachable. Re-resolves every 30 s and
/// re-applies on change. An empty discovery keeps the applied values: a
/// failed lookup must not cut live traffic.
pub fn spawn_policy_refresh(build: Option<(u32, u32)>, fleet_uid: u32, endpoint: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let storage = storage_target(&endpoint).await;
            let sandbox = super::sandbox_net::discover().await;
            let storage_changed = !storage.addrs.is_empty() && applied_storage() != storage;
            let sandbox_changed = !sandbox.celld.is_empty() && applied_sandbox() != sandbox.celld;
            if !storage_changed && !sandbox_changed {
                continue;
            }
            let effective_storage = if storage.addrs.is_empty() {
                applied_storage()
            } else {
                storage
            };
            let effective_sandbox = if sandbox.celld.is_empty() {
                applied_sandbox()
            } else {
                sandbox.celld
            };
            tracing::info!(
                storage = ?effective_storage.addrs,
                sandbox = ?effective_sandbox,
                "dynamic allowances moved; re-applying egress policy"
            );
            ensure(build, fleet_uid, &effective_storage, &effective_sandbox).await;
        }
    });
}

/// Current nft status for `/ready` and doctor.
pub fn status() -> (bool, String) {
    let ok = NFT_OK.load(Ordering::Relaxed);
    let detail = NFT_REASON
        .get()
        .cloned()
        .unwrap_or_else(|| "not probed".to_string());
    (ok, detail)
}

/// The nftables `skuid` match for the per-app build range: nft takes a
/// `lo-hi` range, so a whole range is one rule instead of one rule per app.
/// `None` (uid drops disabled) emits nothing.
fn build_skuid(build: Option<(u32, u32)>) -> Option<String> {
    let (base, range) = build?;
    Some(if range <= 1 {
        base.to_string()
    } else {
        format!("{base}-{}", base.saturating_add(range - 1))
    })
}

/// Every sandboxed identity the policy keys on: the fleet uid, then the
/// per-app build range as one `lo-hi` match.
fn sandbox_identities(build: Option<(u32, u32)>, fleet_uid: u32) -> Vec<String> {
    let mut ids = vec![fleet_uid.to_string()];
    ids.extend(build_skuid(build));
    ids
}

/// The nftables ruleset for the build range and fleet uid. `sandbox` is the
/// discovered celld bridge subnets (`host::sandbox_net`): the fleet dials
/// Sandbox containers there, so they are ACCEPTed for the fleet uid only,
/// ahead of the private-range rejects. Anything failing validation is
/// dropped here too, so a bad discovery can never render into the table.
fn ruleset(
    build: Option<(u32, u32)>,
    fleet_uid: u32,
    storage: &Storage,
    sandbox: &[String],
) -> String {
    // Order matters: the first matching rule wins. Replies go first (see
    // below), then DNS, which must be accepted
    // before the private/loopback rejects, because the container resolver
    // lives exactly there (Docker's embedded DNS is 127.0.0.11, Podman's is
    // the network gateway, e.g. 10.89.0.1). Rejecting it first would break
    // every name lookup, and with it `bun install` and all Worker egress.
    //
    // The leading `table …` + `delete table …` pair makes the reload one
    // atomic transaction: `nft -f` applies the whole file or nothing, and a
    // table that did not exist yet is created empty first so the delete
    // cannot fail.
    let mut rules = Vec::new();
    // Replies first: these rules only restrict connections a fleet or a
    // build *opens*. Without this, a fleet's answers to Caddy (over
    // loopback) and to the host's published ports (from the network
    // gateway, a private address) match the rejects below, and no tenant
    // app is reachable at all.
    rules.push("    ct state established,related accept".to_string());
    // DNS is matched on the port the socket dialed (conntrack's original
    // tuple), not the packet's: Docker's embedded resolver answers on
    // 127.0.0.11:53 through a DNAT to a random high port, and that NAT
    // (output hook, priority -100) runs before this chain, so a plain
    // `dport 53` never matched and the loopback reject below refused every
    // lookup (`bun install` failed with ConnectionRefused on Docker only).
    //
    // The build range is one rule: every app's uid shares the policy.
    let identities = sandbox_identities(build, fleet_uid);
    for id in &identities {
        rules.push(format!(
            "    meta skuid {id} meta l4proto {{ tcp, udp }} ct original proto-dst 53 accept"
        ));
    }
    // The fleet's own celld needs the object store, which in Compose sits on a
    // private address (rustfs:9000): allow exactly those addresses and port,
    // ahead of the private-range rejects. Release commands run as the app's
    // build uid and hold the scope's own key (SPEC, Scoped credentials), so
    // the build range needs the same allowance; builds hold no keys of their
    // own, so the store's unauthenticated surface is all they can reach.
    let (v4, v6): (Vec<IpAddr>, Vec<IpAddr>) =
        storage.addrs.iter().copied().partition(IpAddr::is_ipv4);
    let join = |ips: &[IpAddr]| {
        ips.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    for id in &identities {
        if !v4.is_empty() {
            rules.push(format!(
                "    meta skuid {id} ip daddr {{ {} }} tcp dport {} accept",
                join(&v4),
                storage.port
            ));
        }
        if !v6.is_empty() {
            rules.push(format!(
                "    meta skuid {id} ip6 daddr {{ {} }} tcp dport {} accept",
                join(&v6),
                storage.port
            ));
        }
    }
    // The fleet's celld dials Sandbox containers at their bridge IPs on
    // celld's bridges: allow fleet TCP there, ahead of the private-range
    // rejects that would otherwise refuse every dial (and hang Sandbox SDK
    // polls until the edge times out). Fleet only: builds never dial
    // sandboxes. Ports stay open — container ports vary by class.
    let sandbox: Vec<&str> = sandbox
        .iter()
        .map(String::as_str)
        .filter(|s| super::sandbox_net::valid_cidr(s))
        .collect();
    if !sandbox.is_empty() {
        rules.push(format!(
            "    meta skuid {fleet_uid} ip daddr {{ {} }} meta l4proto tcp accept",
            sandbox.join(", ")
        ));
    }
    // No new connection to loopback, any protocol: that is where the operator
    // APIs, the runner, Caddy's admin and every other fleet listen.
    for id in &identities {
        rules.push(format!("    meta skuid {id} ip daddr 127.0.0.0/8 reject"));
        rules.push(format!("    meta skuid {id} ip6 daddr ::1 reject"));
        rules.push(format!(
            "    meta skuid {id} ip daddr {{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 }} reject"
        ));
        rules.push(format!(
            "    meta skuid {id} ip6 daddr {{ fc00::/7, fe80::/10 }} reject"
        ));
    }
    format!(
        r#"table inet noite
delete table inet noite
table inet noite {{
  chain output {{
    type filter hook output priority 0; policy accept;
{}
  }}
}}"#,
        rules.join("\n")
    )
}

/// Install the table (idempotent: the ruleset replaces it atomically). Best-effort: records the
/// reason and returns false when `nft` is missing or CAP_NET_ADMIN is absent.
pub async fn ensure(
    build: Option<(u32, u32)>,
    fleet_uid: u32,
    storage: &Storage,
    sandbox: &[String],
) -> bool {
    let rules = ruleset(build, fleet_uid, storage, sandbox);
    // Probe first: missing binary or capability surfaces here.
    match nft_run(&["list", "tables"], None).await {
        Ok(()) => {}
        Err(e) => {
            reason(format!("nft unavailable ({e}); single tenancy only"));
            NFT_OK.store(false, Ordering::Relaxed);
            return false;
        }
    }
    // `nft -f -` reads the ruleset from stdin.
    match nft_run(&["-f", "-"], Some(rules.as_str())).await {
        Ok(()) => {
            reason("nft noite table installed".to_string());
            NFT_OK.store(true, Ordering::Relaxed);
            if let Ok(mut applied) = APPLIED_STORAGE.lock() {
                applied.clone_from(storage);
            }
            if let Ok(mut applied) = APPLIED_SANDBOX.lock() {
                applied.clone_from_slice(sandbox);
            }
            tracing::info!(build_range = ?build, fleet_uid, "nft egress policy installed");
            true
        }
        Err(e) => {
            reason(format!("nft apply failed ({e}); single tenancy only"));
            NFT_OK.store(false, Ordering::Relaxed);
            tracing::warn!(error = %e, "nft egress policy not installed");
            false
        }
    }
}

async fn nft_run(args: &[&str], stdin_text: Option<&str>) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new("nft");
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .stdin(if stdin_text.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("spawn nft: {e}"))?;
    if let Some(text) = stdin_text {
        use tokio::io::AsyncWriteExt;
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(text.as_bytes())
                .await
                .map_err(|_| "nft stdin write failed".to_string())?;
        }
    }
    match tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(String::from_utf8_lossy(&out.stderr).into_owned()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("nft timed out".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{ruleset, Storage};

    const BUILD: Option<(u32, u32)> = Some((10030, 1024));

    #[test]
    fn dns_is_accepted_before_any_private_or_loopback_reject() {
        let storage = Storage {
            addrs: vec!["10.89.0.7".parse().unwrap()],
            port: 9000,
        };
        let rules = ruleset(BUILD, 10020, &storage, &[]);
        let first_reject = rules.find(" reject").expect("has rejects");
        for uid in ["10020", "10030-11053"] {
            // Pre-NAT port: Docker DNATs its resolver off port 53.
            let accept = rules
                .find(&format!(
                    "meta skuid {uid} meta l4proto {{ tcp, udp }} ct original proto-dst 53 accept"
                ))
                .expect("dns accept present");
            assert!(accept < first_reject, "dns for {uid} must come first");
        }
        // The fleet's celld reaches its object store before private ranges close.
        for uid in ["10020", "10030-11053"] {
            let store = rules
                .find(&format!(
                    "meta skuid {uid} ip daddr {{ 10.89.0.7 }} tcp dport 9000 accept"
                ))
                .expect("storage allowance");
            assert!(
                store < first_reject,
                "storage must be allowed before the rejects for {uid}"
            );
        }
        // Replies to inbound connections pass before anything is rejected.
        let replies = rules
            .find("ct state established,related accept")
            .expect("reply rule");
        assert!(
            replies < first_reject,
            "established/related must come first"
        );
        // Atomic replace: the file recreates the table in one transaction.
        assert!(rules.starts_with("table inet noite\ndelete table inet noite\n"));
    }

    /// The whole per-app build range is covered by one `skuid lo-hi` rule for
    /// every reject class: a build for any app is closed off, not just the
    /// first uid (or the old single shared build uid).
    #[test]
    fn build_uid_range_is_closed_off_in_every_rule() {
        let storage = Storage::default();
        let rules = ruleset(BUILD, 10020, &storage, &[]);
        let range = "10030-11053";
        for prefix in [
            format!("meta skuid {range} ip daddr 127.0.0.0/8 reject"),
            format!("meta skuid {range} ip6 daddr ::1 reject"),
            format!(
                "meta skuid {range} ip daddr {{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10 }} reject"
            ),
            format!("meta skuid {range} ip6 daddr {{ fc00::/7, fe80::/10 }} reject"),
        ] {
            assert!(rules.contains(&prefix), "missing: {prefix}");
        }
        // The old single uid must not appear anywhere: it is no longer used.
        assert!(
            !rules.contains("10010"),
            "stale shared build uid in ruleset"
        );
        assert!(
            !rules.contains("skuid 10030 ip daddr"),
            "range not used for rejects"
        );
    }

    /// A one-uid range degrades to a single match (and no `lo-hi`).
    #[test]
    fn single_uid_range_emits_a_plain_match() {
        let rules = ruleset(Some((10030, 1)), 10020, &Storage::default(), &[]);
        assert!(rules.contains("meta skuid 10030 ip daddr 127.0.0.0/8 reject"));
        assert!(
            !rules.contains("10030-"),
            "a one-uid range must not be a lo-hi"
        );
    }

    /// No build uids (dev/single): only the fleet is keyed on, and the table
    /// still installs.
    #[test]
    fn without_build_uids_only_the_fleet_is_policed() {
        let rules = ruleset(None, 10020, &Storage::default(), &[]);
        assert!(rules.contains("meta skuid 10020 ip daddr 127.0.0.0/8 reject"));
        assert!(
            !rules.contains("meta skuid 10030"),
            "no build uid configured"
        );
    }

    /// The fleet reaches Sandbox containers on celld's bridges: a fleet-only
    /// TCP ACCEPT for the discovered subnets, ahead of the private rejects.
    /// Builds never dial sandboxes, so the range stays closed.
    #[test]
    fn fleet_reaches_sandbox_subnets_before_the_private_rejects() {
        let sandbox = vec!["172.19.0.0/16".to_string(), "172.20.0.0/16".to_string()];
        let rules = ruleset(BUILD, 10020, &Storage::default(), &sandbox);
        let first_reject = rules.find(" reject").expect("has rejects");
        let accept = rules
            .find("meta skuid 10020 ip daddr { 172.19.0.0/16, 172.20.0.0/16 } meta l4proto tcp accept")
            .expect("sandbox accept present");
        assert!(
            accept < first_reject,
            "sandbox must be allowed before the rejects"
        );
        assert!(
            !rules.contains("meta skuid 10030-11053 ip daddr { 172.19.0.0/16"),
            "builds must not reach sandboxes"
        );
        // Nothing discovered: byte-identical to the policy without sandboxes.
        let bare = ruleset(BUILD, 10020, &Storage::default(), &[]);
        assert!(!bare.contains("172.19.0.0/16"));
        assert!(!bare.contains("meta l4proto tcp accept"));
    }
}
