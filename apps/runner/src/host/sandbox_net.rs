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
//! 2. On the host, Docker's `DOCKER-ISOLATION` drops forwarding between the
//!    install's bridge and the celld bridges, and celld's own fence (priority
//!    -10, no established rule on forward) REJECTs the replies. Fixed by a
//!    `noite_sandbox` nft table at priority -15: TCP from this install's
//!    subnets toward the celld bridges, plus established/related replies back.
//!    It lives in its own table so celld's fence re-apply (`delete table inet
//!    celld`) never wipes it, and it only ever allows replies or
//!    install-originated TCP — new connections OUT of a sandbox still hit the
//!    fence exactly as before.
//!
//! The host table is applied from a one-shot helper container (this same
//! image, `--network host`, `NET_ADMIN`, entrypoint `nft`) — the same shape
//! as celld's fence install, because the runner's own netns is the
//! container's, not the host's. The helper keeps stdin open (`-i`) so the
//! piped ruleset reaches `nft -f -`, and the table is listed back before
//! success is reported: an exit 0 alone once hid an empty stdin behind a
//! success log. Everything here is best-effort: no engine (dev, CI lanes)
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

/// The host-leg ruleset, or `None` when no valid own-subnet scopes it.
/// Priority -15 runs before celld's fence (-10) and Docker's own chains (0),
/// so both verdicts are final; the reply leg only ever matches
/// established/related, leaving the fence's block on NEW sandbox egress
/// exactly as it is.
pub fn host_ruleset(own: &[String]) -> Option<String> {
    let valid: Vec<&str> = own
        .iter()
        .map(String::as_str)
        .filter(|s| valid_cidr(s))
        .collect();
    if valid.is_empty() {
        return None;
    }
    let ifaces = CELLD_IFACES
        .iter()
        .map(|i| format!("\"{i}\""))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        r#"table inet noite_sandbox
delete table inet noite_sandbox
table inet noite_sandbox {{
  chain forward {{
    type filter hook forward priority -15; policy accept;
    ip saddr {{ {} }} oifname {{ {} }} meta l4proto tcp accept
    iifname {{ {} }} ct state established,related accept
  }}
}}"#,
        valid.join(", "),
        ifaces,
        ifaces,
    ))
}

/// The one-shot host helper command: this same image on the host netns,
/// `NET_ADMIN`, entrypoint `nft`. `-i` is load-bearing: without it Docker
/// closes the container's stdin, `nft -f -` reads EOF, applies nothing, and
/// still exits 0 — a silent no-op the runner once logged as success while
/// Sandbox traffic stayed blocked. No `-t`: a TTY would mangle the piped
/// ruleset.
fn helper_command(image: &str, nft_args: &[&str]) -> Vec<String> {
    let mut cmd = vec![
        "run".to_string(),
        "--rm".to_string(),
        "-i".to_string(),
        "--network".to_string(),
        "host".to_string(),
        "--cap-add".to_string(),
        "NET_ADMIN".to_string(),
        "--entrypoint".to_string(),
        NFT_PATH.to_string(),
        image.to_string(),
    ];
    cmd.extend(nft_args.iter().map(|s| s.to_string()));
    cmd
}

async fn helper(image: &str, nft_args: &[&str], stdin_text: Option<&str>) -> Option<String> {
    let cmd = helper_command(image, nft_args);
    let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
    let out = docker(&refs, stdin_text, Duration::from_secs(30)).await?;
    if !out.status.success() {
        return None;
    }
    stdout_text(&out)
}

/// Install the host-leg table via a one-shot helper (this same image on the
/// host netns), then verify it actually landed before reporting success: an
/// exit 0 alone proved nothing once already. Best-effort: false when there
/// is no engine, no own-subnet, or the helper fails — the caller logs and
/// keeps booting, sandboxes or not.
pub async fn ensure_host_table(nets: &SandboxNets) -> bool {
    let (Some(rules), Some(image)) = (host_ruleset(&nets.own), nets.image.clone()) else {
        tracing::debug!("no sandbox host table to install (no engine or no own subnet)");
        return false;
    };
    if helper(&image, &["-f", "-"], Some(&rules)).await.is_none() {
        tracing::warn!(
            "could not install the sandbox host table; Sandbox containers stay unreachable"
        );
        return false;
    }
    let landed = helper(&image, &["list", "table", "inet", "noite_sandbox"], None)
        .await
        .map(|text| text.contains("table inet noite_sandbox"))
        .unwrap_or(false);
    if landed {
        tracing::info!(
            "sandbox host table installed (install subnets {:?})",
            nets.own
        );
        true
    } else {
        tracing::warn!(
            "sandbox host table apply did not land; Sandbox containers stay unreachable"
        );
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        helper_command, host_ruleset, parse_container_inspect, parse_network_inspect, valid_cidr,
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
    fn host_table_is_scoped_and_runs_before_the_fence() {
        let rules = host_ruleset(&["172.18.0.0/16".to_string()]).expect("rules");
        assert!(rules.starts_with("table inet noite_sandbox\ndelete table inet noite_sandbox\n"));
        assert!(rules.contains("hook forward priority -15;"), "{rules}");
        assert!(
            rules.contains(r#"ip saddr { 172.18.0.0/16 } oifname { "celld0", "celld1" } meta l4proto tcp accept"#),
            "{rules}"
        );
        assert!(
            rules.contains(r#"iifname { "celld0", "celld1" } ct state established,related accept"#),
            "{rules}"
        );
        // No own subnet (or only garbage): no table rather than an open one.
        assert!(host_ruleset(&[]).is_none());
        assert!(host_ruleset(&["bogus".to_string()]).is_none());
    }

    #[test]
    fn helper_keeps_stdin_open_and_never_allocates_a_tty() {
        // Without `-i` Docker closes the helper's stdin, `nft -f -` reads
        // EOF, applies nothing, and still exits 0 — the exact silent no-op
        // that once left prod's host table missing behind a success log.
        let args = helper_command("img:tag", &["-f", "-"]);
        let expected: Vec<String> = [
            "run",
            "--rm",
            "-i",
            "--network",
            "host",
            "--cap-add",
            "NET_ADMIN",
            "--entrypoint",
            "/usr/sbin/nft",
            "img:tag",
            "-f",
            "-",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(args, expected);
        assert!(!args.iter().any(|a| a == "-t" || a == "--tty"));
    }
}
