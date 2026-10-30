//! Sandbox container networking (Sandbox-backed DO classes, e.g. the agent template).
//!
//! Tenant fleets run celld, which starts Sandbox containers on the HOST engine
//! (the mounted socket) attached to celld's `celld` / `celld-internal` bridges
//! and dials them at their bridge IPs. Inside Noite that path dies twice:
//!
//! 1. In this container's netns the [`super::netisolation`] policy REJECTs
//!    fleet-uid dials to 172.16.0.0/12, which covers the celld bridge subnets
//!    (engine-assigned, e.g. 172.19.0.0/16). Fixed by a fleet-only ACCEPT for
//!    the discovered celld subnets, ahead of the private-range rejects.
//! 2. On the host, Docker's bridge isolation drops forwarding between the
//!    install's bridge and the celld bridges. Fixed in Docker's own
//!    `DOCKER-USER` chain: TCP from this install's subnets toward the celld
//!    bridges, plus established/related replies back. That placement is
//!    load-bearing, not cosmetic: a packet visits every hook function in
//!    priority order and only a drop stops traversal, so an ACCEPT in our own
//!    nft table (any priority) can never preempt Docker's later DROP — the
//!    old `noite_sandbox` table learned that the hard way and is deleted on
//!    sight. Inside `DOCKER-USER` (first jump of the filter `FORWARD` chain)
//!    the ACCEPT is terminal and Docker's drops never run.
//!
//! A second host killer lives earlier still: `raw` PREROUTING rules that pin
//! a container IP to its own bridge (`daddr X iifname != <bridge> drop`)
//! kill cross-bridge traffic before conntrack or forwarding ever run — SYNs
//! to a pinned sandbox die there, and a pinned install address eats the
//! replies. Their writer is foreign (not celld: no such code; not Docker)
//! and re-adds sandbox pins as containers churn, so the sweep below deletes
//! any pin whose address falls in the discovered install or sandbox subnets
//! and runs on boot plus every refresh. Loopback pins are never touched.
//!
//! Both host legs are applied from one-shot helper containers (this same
//! image, `--network host`, `NET_ADMIN`) — the same shape as celld's fence
//! install, because the runner's own netns is the container's, not the
//! host's. Helpers keep stdin open (`-i`); an exit 0 alone once hid an empty
//! stdin behind a success log, so installs are verified before success is
//! reported. Everything here is best-effort: no engine (dev, CI lanes)
//! means no Sandbox containers exist, so discovery returns empty and the
//! policy installs exactly as before.
//!
//! Known limitation, stated plainly: every tenant fleet shares the fleet uid,
//! so the ACCEPTs open the whole sandbox plane to every fleet — a hostile
//! tenant that learns another app's sandbox IP can speak its unauthenticated
//! tool port. The agent template keeps credentials in Worker env (the
//! container never sees them), which bounds the blast radius to the cloned
//! repo and tool exec, but per-app sandbox isolation wants per-app fleet uids
//! (a bigger change: `db::alloc`, the supervisor, cgroups).

use std::collections::HashSet;
use std::time::Duration;

/// celld's container networks (fixed names; subnets are engine-assigned).
const CELLD_NETWORKS: &[&str] = &["celld", "celld-internal"];
/// Host interfaces of those bridges (celld pins them, so they are stable).
const CELLD_IFACES: &[&str] = &["celld0", "celld1"];
/// nft in this image (Debian path; the host helper overrides its entrypoint).
const NFT_PATH: &str = "/usr/sbin/nft";
/// iptables in this image (same Debian layout; added for the host helper).
const IPTABLES_PATH: &str = "/usr/sbin/iptables";
/// Docker's user chain: first jump of the filter `FORWARD` chain, evaluated
/// before Docker's own drops, and the only host spot whose ACCEPT preempts
/// them. Docker never deletes rules here across restarts.
const DOCKER_USER: &str = "DOCKER-USER";
/// The stale host table alpha.12/13 installed (an ACCEPT there cannot preempt
/// a later DROP, so it never worked); deleted on sight, best-effort.
const STALE_TABLE: &str = "noite_sandbox";
/// How often the host legs are re-ensured (rules re-checked, pins re-swept):
/// the pin writer re-adds sandbox pins as containers churn.
const HOST_REFRESH_SECS: u64 = 30;

/// The discovered sandbox plane: celld bridge subnets (the container-leg
/// ACCEPTs), this container's own subnets (the host-leg scope), and the image
/// ref to run the host-leg helper from. Validated v4 CIDRs only; empty when
/// the engine is unreachable or a network does not exist (yet).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SandboxNets {
    pub celld: Vec<String>,
    pub own: Vec<String>,
    pub image: Option<String>,
}

/// Strict v4 CIDR check for engine output before it is interpolated into an
/// nftables ruleset: four octets, a /1–/32 prefix, host bits zero. Anything
/// else (v6, garbage, 0.0.0.0/0, `10.0.0.1/8`) is dropped, never rendered.
pub fn valid_cidr(s: &str) -> bool {
    let Some((ip, prefix)) = s.split_once('/') else {
        return false;
    };
    let Ok(addr) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let Ok(bits) = prefix.parse::<u32>() else {
        return false;
    };
    if !(1..=32).contains(&bits) {
        return false;
    }
    let mask = !0u32 << (32 - bits);
    u32::from(addr) & !mask == 0
}

/// This container's short id: Docker sets the hostname to it (same read as
/// `host::control::control_advertise`).
fn own_container_id() -> Option<String> {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
}

/// Run the docker CLI. `None` on spawn failure or timeout; the exit status
/// is the caller's to interpret (`network inspect` prints the networks it
/// found and exits 1 for the missing ones, while the nft helper must exit 0).
async fn docker(
    args: &[&str],
    stdin_text: Option<&str>,
    timeout: Duration,
) -> Option<std::process::Output> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(args)
        .stdin(if stdin_text.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = cmd.spawn().ok()?;
    if let Some(text) = stdin_text {
        use tokio::io::AsyncWriteExt;
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(text.as_bytes()).await.ok()?;
        }
    }
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .ok()?
        .ok()
}

fn stdout_text(out: &std::process::Output) -> Option<String> {
    String::from_utf8(out.stdout.clone()).ok()
}

#[derive(serde::Deserialize, Default)]
struct NetworkInspect {
    #[serde(default)]
    #[serde(rename = "Name")]
    name: String,
    #[serde(default)]
    #[serde(rename = "IPAM")]
    ipam: Ipam,
}

#[derive(serde::Deserialize, Default)]
struct Ipam {
    #[serde(default)]
    #[serde(rename = "Config")]
    config: Vec<IpamConfig>,
}

#[derive(serde::Deserialize, Default)]
struct IpamConfig {
    #[serde(default)]
    #[serde(rename = "Subnet")]
    subnet: String,
}

/// `(network name, validated subnets)` from `docker network inspect` output.
/// Unparseable output (engine down) and invalid subnets yield nothing.
pub fn parse_network_inspect(json: &str) -> Vec<(String, Vec<String>)> {
    let Ok(networks) = serde_json::from_str::<Vec<NetworkInspect>>(json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for network in networks {
        if network.name.is_empty() {
            continue;
        }
        let mut subnets: Vec<String> = network
            .ipam
            .config
            .iter()
            .map(|c| c.subnet.clone())
            .filter(|s| valid_cidr(s))
            .collect();
        subnets.sort();
        subnets.dedup();
        if !subnets.is_empty() {
            out.push((network.name, subnets));
        }
    }
    out
}

/// This container's networks + image ref from `docker inspect` output.
fn parse_container_inspect(json: &str) -> Option<(Vec<String>, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let networks = value
        .pointer("/0/NetworkSettings/Networks")?
        .as_object()?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let image = value.pointer("/0/Config/Image")?.as_str()?.to_string();
    if networks.is_empty() || image.is_empty() {
        return None;
    }
    Some((networks, image))
}

/// Discover the sandbox plane: this container's networks and image, then the
/// subnets of those plus celld's bridges. Empty (never an error) when the
/// engine is unreachable or a network does not exist yet.
pub async fn discover() -> SandboxNets {
    let id = own_container_id().unwrap_or_default();
    let own = if id.is_empty() {
        None
    } else {
        docker(&["inspect", &id], None, Duration::from_secs(10))
            .await
            .and_then(|out| stdout_text(&out))
            .and_then(|text| parse_container_inspect(&text))
    };
    let (own_names, image) = own.unzip();
    let mut names: Vec<&str> = own_names
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect();
    names.extend(CELLD_NETWORKS.iter().copied());
    let mut seen = HashSet::new();
    names.retain(|n| seen.insert(n.to_string()));
    let mut args = vec!["network", "inspect"];
    args.extend(names);
    let parsed = docker(&args, None, Duration::from_secs(10))
        .await
        .and_then(|out| stdout_text(&out))
        .map(|text| parse_network_inspect(&text))
        .unwrap_or_default();
    let mut nets = SandboxNets {
        image,
        ..SandboxNets::default()
    };
    let own_set: HashSet<&str> = own_names
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(String::as_str)
        .collect();
    for (name, subnets) in parsed {
        if CELLD_NETWORKS.contains(&name.as_str()) {
            nets.celld.extend(subnets);
        } else if own_set.contains(name.as_str()) {
            nets.own.extend(subnets);
        }
    }
    nets.celld.sort();
    nets.celld.dedup();
    nets.own.sort();
    nets.own.dedup();
    nets
}

/// The host-leg rules as `DOCKER-USER` match specs (the caller prepends `-C`
/// to check or `-I` to insert): per valid install subnet, TCP toward each
/// celld bridge, plus established/related replies back off each bridge. The
/// reply legs are unconditional (they only ever match answers to allowed
/// traffic, and Docker's own `DOCKER-CT` covers the same ground anyway).
pub fn docker_user_rules(own: &[String]) -> Vec<Vec<String>> {
    let mut rules = Vec::new();
    for subnet in own.iter().map(String::as_str).filter(|s| valid_cidr(s)) {
        for iface in CELLD_IFACES {
            rules.push(
                ["-s", subnet, "-o", iface, "-p", "tcp", "-j", "ACCEPT"]
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
            );
        }
    }
    for iface in CELLD_IFACES {
        rules.push(
            [
                "-i",
                iface,
                "-m",
                "conntrack",
                "--ctstate",
                "ESTABLISHED,RELATED",
                "-j",
                "ACCEPT",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        );
    }
    rules
}

/// Strict `ip ∈ cidr` for validated v4 CIDRs. Anything unparseable (or a
/// non-unicast address: loopback, zero, multicast and up) is never a member:
/// the pin sweep must not touch loopback pins however the discovery reads.
fn ip_in_cidr(ip: &str, cidr: &str) -> bool {
    let Ok(addr) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    if addr.is_loopback() || addr.is_multicast() || addr.is_unspecified() {
        return false;
    }
    let Some((net, prefix)) = cidr.split_once('/') else {
        return false;
    };
    let (Ok(net), Ok(bits)) = (net.parse::<std::net::Ipv4Addr>(), prefix.parse::<u32>()) else {
        return false;
    };
    if !(1..=32).contains(&bits) {
        return false;
    }
    let mask = !0u32 << (32 - bits);
    u32::from(addr) & mask == u32::from(net) & mask
}

/// Handles of `raw` PREROUTING pin rules to delete, parsed from
/// `nft -a list table ip raw` output: a line only qualifies when it pins a
/// unicast address inside one of `subnets` to a bridge with a drop verdict
/// (`ip daddr X iifname != "Y" ... drop ... # handle N`). Anything else —
/// loopback pins, other tables' shapes, malformed lines, missing handles —
/// is left alone. Subnet-scoped (not container-IP-scoped) on purpose: engine
/// IPs recycle across sandbox generations, so a stale pin for a reused
/// address must still match.
pub fn pin_handles(listing: &str, subnets: &[String]) -> Vec<u64> {
    let mut handles = Vec::new();
    for line in listing.lines() {
        if !line.contains("drop") || !line.contains("iifname") || !line.contains("!=") {
            continue;
        }
        let Some(addr) = line.split("ip daddr ").nth(1).and_then(|r| {
            r.split([' ', '\t'])
                .next()
                .filter(|ip| !ip.is_empty() && !ip.contains('/'))
        }) else {
            continue;
        };
        if !subnets.iter().any(|cidr| ip_in_cidr(addr, cidr)) {
            continue;
        }
        let Some(handle) = line
            .split("handle ")
            .nth(1)
            .and_then(|r| r.split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok())
        else {
            continue;
        };
        handles.push(handle);
    }
    handles.sort_unstable();
    handles.dedup();
    handles
}

/// A one-shot host helper command: this same image on the host netns,
/// `NET_ADMIN`, entrypoint overridden to the firewall tool. `-i` is
/// load-bearing: without it Docker closes the container's stdin and a piped
/// ruleset becomes a silent no-op that still exits 0 — the runner once
/// logged that as success while Sandbox traffic stayed blocked. No `-t`: a
/// TTY would mangle piped input.
fn helper_command(image: &str, entrypoint: &str, tool_args: &[&str]) -> Vec<String> {
    let mut cmd = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-i".to_string(),
        "--network".to_string(),
        "host".to_string(),
        "--cap-add".to_string(),
        "NET_ADMIN".to_string(),
        "--entrypoint".to_string(),
        entrypoint.to_string(),
        image.to_string(),
    ];
    cmd.extend(tool_args.iter().map(|s| s.to_string()));
    cmd
}

async fn helper(
    image: &str,
    entrypoint: &str,
    tool_args: &[&str],
    stdin_text: Option<&str>,
) -> Option<String> {
    let cmd = helper_command(image, entrypoint, tool_args);
    let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
    let out = docker(&refs, stdin_text, Duration::from_secs(30)).await?;
    if !out.status.success() {
        return None;
    }
    stdout_text(&out)
}

async fn nft(image: &str, args: &[&str]) -> Option<String> {
    helper(image, NFT_PATH, args, None).await
}

/// True when the iptables invocation exits 0. Used for `-C` checks (present
/// or not) and `-I` inserts alike; stdout is never needed.
async fn iptables_ok(image: &str, args: &[&str]) -> bool {
    helper(image, IPTABLES_PATH, args, None).await.is_some()
}

/// Ensure one `DOCKER-USER` spec: check first so steady state is a no-op,
/// insert on miss. Returns false only when the rule is neither present nor
/// insertable (no chain on non-Docker engines, helper failure).
async fn ensure_docker_user_rule(image: &str, spec: &[String]) -> bool {
    let mut check = vec!["-C", DOCKER_USER];
    check.extend(spec.iter().map(String::as_str));
    if iptables_ok(image, &check).await {
        return true;
    }
    let mut insert = vec!["-I", DOCKER_USER];
    insert.extend(spec.iter().map(String::as_str));
    if iptables_ok(image, &insert).await {
        tracing::info!(rule = ?spec, "installed DOCKER-USER sandbox rule");
        true
    } else {
        tracing::warn!(rule = ?spec, "could not install DOCKER-USER sandbox rule");
        false
    }
}

/// Delete `raw` PREROUTING pins covering our subnets (see [`pin_handles`]).
/// Logs each deletion; a missing `raw` table (nothing ever pinned) is the
/// quiet success path, not an error.
async fn sweep_pins(image: &str, subnets: &[String]) {
    let listing = match nft(image, &["-a", "list", "table", "ip", "raw"]).await {
        Some(text) => text,
        None => return,
    };
    for handle in pin_handles(&listing, subnets) {
        let arg = handle.to_string();
        if nft(
            image,
            &["delete", "rule", "ip", "raw", "PREROUTING", "handle", &arg],
        )
        .await
        .is_some()
        {
            tracing::info!(handle, "deleted raw PREROUTING sandbox pin");
        }
    }
}

/// Ensure the host legs: `DOCKER-USER` allowlist, `raw` pin sweep, and
/// removal of the stale `noite_sandbox` table alpha.12/13 installed (an
/// ACCEPT there cannot preempt Docker's later DROP, so it only ever
/// confused the next debug). Best-effort: false when there is no engine —
/// the caller logs and keeps booting, sandboxes or not.
pub async fn ensure_host_rules(nets: &SandboxNets) -> bool {
    let Some(image) = nets.image.clone() else {
        tracing::debug!("no sandbox host rules to install (no engine)");
        return false;
    };
    let mut ok = true;
    for spec in docker_user_rules(&nets.own) {
        ok &= ensure_docker_user_rule(&image, &spec).await;
    }
    let mut scope = nets.own.clone();
    scope.extend(nets.celld.iter().cloned());
    scope.sort();
    scope.dedup();
    if !scope.is_empty() {
        sweep_pins(&image, &scope).await;
    }
    if nft(&image, &["delete", "table", "inet", STALE_TABLE])
        .await
        .is_some()
    {
        tracing::info!("deleted stale sandbox host table");
    }
    if ok {
        tracing::debug!(
            "sandbox host rules ensured (install subnets {:?})",
            nets.own
        );
    } else {
        tracing::warn!(
            "some sandbox host rules are missing; Sandbox containers may stay unreachable"
        );
    }
    ok
}

/// Re-ensure the host legs every refresh: the pin writer re-adds sandbox
/// pins as containers churn, and a reboot wipes `DOCKER-USER` while the
/// runner keeps running. Each pass is cheap when stable (check-only), and
/// loud only when it changes something.
pub fn spawn_host_refresh() {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(HOST_REFRESH_SECS)).await;
            let nets = discover().await;
            ensure_host_rules(&nets).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        docker_user_rules, helper_command, ip_in_cidr, parse_container_inspect,
        parse_network_inspect, pin_handles, valid_cidr, IPTABLES_PATH, NFT_PATH,
    };

    #[test]
    fn cidr_validation_is_strict() {
        for ok in [
            "172.19.0.0/16",
            "10.89.0.0/24",
            "192.168.1.0/24",
            "172.19.0.2/32",
        ] {
            assert!(valid_cidr(ok), "{ok}");
        }
        for bad in [
            "",
            "nonsense",
            "172.19.0.0",
            "172.19.0.0/",
            "172.19.0.0/33",
            "172.19.0.0/0",
            "0.0.0.0/0",
            "10.0.0.1/8",
            "01.2.3.0/24",
            "1.2.3.4.5/24",
            "172.19.0.0/16\nip saddr { 0.0.0.0/0 } accept",
            "fd00::/64",
            "::1/128",
            " 172.19.0.0/16",
            "172.19.0.0/16 ",
        ] {
            assert!(!valid_cidr(bad), "{bad:?}");
        }
    }

    #[test]
    fn network_inspect_parses_subnets_and_drops_garbage() {
        let json = r#"[
          {"Name": "celld", "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}, {"Subnet": "bogus"}]}},
          {"Name": "noite_noite", "IPAM": {"Config": [{"Subnet": "172.18.0.0/16"}]}},
          {"Name": "", "IPAM": {"Config": [{"Subnet": "10.0.0.0/8"}]}},
          {"Name": "v6only", "IPAM": {"Config": [{"Subnet": "fd00::/64"}]}}
        ]"#;
        let parsed = parse_network_inspect(json);
        assert_eq!(
            parsed,
            vec![
                ("celld".to_string(), vec!["172.19.0.0/16".to_string()]),
                ("noite_noite".to_string(), vec!["172.18.0.0/16".to_string()]),
            ]
        );
        assert!(parse_network_inspect("").is_empty());
        assert!(parse_network_inspect("Cannot connect to the Docker daemon").is_empty());
        assert!(parse_network_inspect("{}").is_empty());
    }

    #[test]
    fn container_inspect_reads_networks_and_image() {
        let json = r#"[{
          "Config": {"Image": "ghcr.io/ryuzcorp/noite:alpha"},
          "NetworkSettings": {"Networks": {"noite_noite": {}, "extra": {}}}
        }]"#;
        let (mut networks, image) = parse_container_inspect(json).expect("parsed");
        networks.sort();
        assert_eq!(
            networks,
            vec!["extra".to_string(), "noite_noite".to_string()]
        );
        assert_eq!(image, "ghcr.io/ryuzcorp/noite:alpha");
        assert!(parse_container_inspect("[]").is_none());
        assert!(parse_container_inspect("").is_none());
    }

    #[test]
    fn docker_user_specs_cover_every_subnet_and_bridge() {
        let own = vec!["172.18.0.0/16".to_string(), "bogus".to_string()];
        let rules = docker_user_rules(&own);
        // One outbound TCP spec per valid subnet per celld bridge, then the
        // two established-reply legs. Garbage subnets render nothing.
        let rendered: Vec<String> = rules.iter().map(|spec| spec.join(" ")).collect();
        assert_eq!(
            rendered,
            vec![
                "-s 172.18.0.0/16 -o celld0 -p tcp -j ACCEPT".to_string(),
                "-s 172.18.0.0/16 -o celld1 -p tcp -j ACCEPT".to_string(),
                "-i celld0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT".to_string(),
                "-i celld1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT".to_string(),
            ]
        );
        // No valid subnet: outbound legs vanish, reply legs stay (they only
        // match answers to allowed traffic).
        let bare = docker_user_rules(&[]);
        assert_eq!(bare.len(), 2);
        assert!(bare.iter().all(|spec| spec.contains(&"-i".to_string())));
    }

    #[test]
    fn ip_membership_is_strict_and_never_covers_special_addresses() {
        assert!(ip_in_cidr("172.19.0.2", "172.19.0.0/16"));
        assert!(ip_in_cidr("172.19.255.254", "172.19.0.0/16"));
        assert!(ip_in_cidr("172.18.0.3", "172.18.0.0/16"));
        assert!(!ip_in_cidr("172.20.0.1", "172.19.0.0/16"));
        assert!(!ip_in_cidr("172.19.0.2", "bogus"));
        assert!(!ip_in_cidr("bogus", "172.19.0.0/16"));
        assert!(!ip_in_cidr("172.19.0.2", "172.19.0.0/33"));
        // However the discovery reads, special addresses never match: the
        // sweep must not touch loopback pins.
        assert!(!ip_in_cidr("127.0.0.1", "127.0.0.0/8"));
        assert!(!ip_in_cidr("127.0.0.1", "0.0.0.0/1"));
        assert!(!ip_in_cidr("224.0.0.1", "224.0.0.0/4"));
        assert!(!ip_in_cidr("0.0.0.0", "0.0.0.0/0"));
    }

    #[test]
    fn pin_sweep_deletes_only_pins_inside_our_subnets() {
        // Verbatim shape of the prod `nft -a list table ip raw` output.
        let listing = r#"table ip raw {
        chain PREROUTING {
                type filter hook prerouting priority raw; policy accept;
                ip daddr 172.18.0.2 iifname != "br-178fe3631fdd" counter packets 0 bytes 0 drop # handle 3
                ip daddr 127.0.0.1 iifname != "lo" tcp dport 9000 counter packets 0 bytes 0 drop # handle 4
                ip daddr 172.19.0.3 iifname != "celld0" counter packets 188 bytes 11280 drop # handle 9
                ip daddr 172.20.9.9 iifname != "celld1" counter packets 0 bytes 0 accept # handle 11
                ip daddr 10.9.0.2 iifname != "br-deadbeef" counter packets 0 bytes 0 drop # handle 12
                ip daddr 172.19.0.4/32 iifname != "celld0" counter packets 0 bytes 0 drop # handle 13
                ip daddr 172.19.0.5 iifname != "celld0" counter packets 0 bytes 0 drop
                not a rule at all
        }
}"#;
        let subnets = vec!["172.18.0.0/16".to_string(), "172.19.0.0/16".to_string()];
        // Sandbox + install pins match; the loopback pin never does (even
        // though it drops); accepts, foreign subnets, CIDR-shaped addrs,
        // handle-less and garbage lines are all left alone.
        assert_eq!(pin_handles(listing, &subnets), vec![3, 9]);
        assert!(pin_handles("", &subnets).is_empty());
        assert!(pin_handles(listing, &[]).is_empty());
    }

    #[test]
    fn helper_keeps_stdin_open_and_never_allocates_a_tty() {
        // Without `-i` Docker closes the helper's stdin, `nft -f -` reads
        // EOF, applies nothing, and still exits 0 — the exact silent no-op
        // that once left prod's host rules missing behind a success log.
        for (entrypoint, tool_args, tail) in [
            (NFT_PATH, &["-a", "list"][..], vec!["-a", "list"]),
            (
                IPTABLES_PATH,
                &["-C", "DOCKER-USER"][..],
                vec!["-C", "DOCKER-USER"],
            ),
        ] {
            let args = helper_command("img:tag", entrypoint, tool_args);
            let expected: Vec<String> = [
                "run",
                "--rm",
                "-i",
                "--network",
                "host",
                "--cap-add",
                "NET_ADMIN",
                "--entrypoint",
                entrypoint,
                "img:tag",
            ]
            .into_iter()
            .map(str::to_string)
            .chain(tail.into_iter().map(str::to_string))
            .collect();
            assert_eq!(args, expected);
            assert!(!args.iter().any(|a| a == "-t" || a == "--tty"));
        }
    }
}
