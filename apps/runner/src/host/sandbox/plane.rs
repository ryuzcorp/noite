//! The sandbox plane on the host engine: celld's bridges, this
//! container's own identity, the one-time cleanup of the alpha.12–14 host
//! legs, and the `/ready` sandbox status.
//!
//! Everything here goes through the `docker` CLI (argv only, bounded
//! timeouts), never the Engine API: the runner holds the real socket and
//! fleets must never see it. `ensure_networks` pre-creates celld's bridges
//! exactly as celld 0.6.3 would (`container.rs`, `networks()`), so their
//! subnets are known before any fleet dials — celld finds bridges with
//! matching options and keeps them, subnets included.

use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use std::time::Duration;

/// celld's container networks (fixed names; subnets are engine-assigned).
const CELLD_NETWORKS: &[(&str, bool, &str)] = &[
    ("celld", false, "celld0"),
    ("celld-internal", true, "celld1"),
];
/// celld's bridge options (`container.rs`: `ICC_OPTION`, `BRIDGE_NAME_OPTION`).
const ICC_OPTION: &str = "com.docker.network.bridge.enable_icc";
const BRIDGE_NAME_OPTION: &str = "com.docker.network.bridge.name";
/// nft in this image (Debian path; the cleanup helper overrides its entrypoint).
const NFT_PATH: &str = "/usr/sbin/nft";
/// What alpha.12/13 left behind: an ACCEPT in its own table can never preempt
/// Docker's later DROP, so it never worked; alpha.14 deleted `inet` on sight
/// but a host that never ran the new code still carries it.
const STALE_TABLE: &str = "noite_sandbox";
/// Noite's own uid/gid max for the relay dir check (nobody:nogroup).
const RELAY_UID: u32 = 65534;

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
    };
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
/// found and exits 1 for the missing ones, `inspect` fails for gone
/// containers, the cleanup helper must exit 0).
async fn docker(args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd.spawn().ok()?;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .ok()?
        .ok()
}

fn stdout_text(out: &std::process::Output) -> Option<String> {
    String::from_utf8(out.stdout.clone()).ok()
}

fn stderr_text(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[derive(serde::Deserialize, Default)]
struct NetworkInspect {
    #[serde(default)]
    #[serde(rename = "Name")]
    name: String,
    #[serde(default)]
    #[serde(rename = "Internal")]
    internal: bool,
    #[serde(default)]
    #[serde(rename = "Options")]
    options: std::collections::HashMap<String, String>,
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

/// Whether an inspected bridge already matches what celld 0.6.3 creates
/// (same check celld runs before keeping a bridge: `Internal` flag plus the
/// `enable_icc=false` and bridge-name options). A mismatch only warns: we
/// never delete, and celld replaces a stale bridge itself once it is idle.
fn bridge_matches(json: &str, name: &str, internal: bool, bridge: &str) -> bool {
    let Ok(networks) = serde_json::from_str::<Vec<NetworkInspect>>(json) else {
        return false;
    };
    let Some(network) = networks.iter().find(|n| n.name == name) else {
        return false;
    };
    network.internal == internal
        && network.options.get(ICC_OPTION).map(String::as_str) == Some("false")
        && network.options.get(BRIDGE_NAME_OPTION).map(String::as_str) == Some(bridge)
}

/// How `/data` reaches this container: a named volume (share just the relay
/// directory via `volume-subpath`) or a bind (share just the relay
/// subdirectory). Anything else (tmpfs, unmounted) cannot carry the socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataMount {
    Volume(String),
    Bind(String),
}

/// This container, as the relay lifecycle needs it: full id (the hostname),
/// short id (the relay name suffix), own image id (what the relay runs
/// from), and how `/data` is mounted (what the relay mounts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnContainer {
    pub id: String,
    pub short_id: String,
    pub image: String,
    pub data: DataMount,
}

/// Parse `docker inspect <own id>` output: `.Image` plus the `/data` mount.
/// `None` when the shape is wrong or `/data` is not a volume or bind mount.
pub fn parse_own_container(hostname: &str, json: &str) -> Option<OwnContainer> {
    if hostname.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let image = value.pointer("/0/Image")?.as_str()?;
    if image.is_empty() {
        return None;
    }
    let mounts = value.pointer("/0/Mounts")?.as_array()?;
    let data = mounts.iter().find_map(|m| {
        if m.get("Destination")?.as_str()? != "/data" {
            return None;
        }
        match m.get("Type")?.as_str()? {
            "volume" => Some(DataMount::Volume(m.get("Name")?.as_str()?.to_string())),
            "bind" => Some(DataMount::Bind(m.get("Source")?.as_str()?.to_string())),
            _ => None,
        }
    })?;
    let short_id: String = hostname.chars().take(12).collect();
    Some(OwnContainer {
        id: hostname.to_string(),
        short_id,
        image: image.to_string(),
        data,
    })
}

/// This container's id, image id, and `/data` mount. `None` without an
/// engine (dev, CI) or without a shareable `/data`.
pub async fn own_container() -> Option<OwnContainer> {
    let id = own_container_id()?;
    let text = docker(&["inspect", &id], Duration::from_secs(10))
        .await
        .and_then(|out| {
            if out.status.success() {
                stdout_text(&out)
            } else {
                None
            }
        })?;
    parse_own_container(&id, &text)
}

/// What `ensure_networks` found: whether the engine answered at all, and the
/// validated celld bridge subnets (empty when the engine is down or a bridge
/// is still missing).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlaneNets {
    pub engine: bool,
    pub subnets: Vec<String>,
}

/// Inspect one celld bridge: its validated subnets when it exists.
async fn inspect_network(name: &str) -> Option<(String, Vec<String>)> {
    let out = docker(&["network", "inspect", name], Duration::from_secs(10)).await?;
    if !out.status.success() {
        return None;
    }
    let text = stdout_text(&out)?;
    parse_network_inspect(&text)
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, subnets)| (text, subnets))
}

/// Create one celld bridge exactly as celld 0.6.3 does (`container.rs`,
/// `networks()`): bridge driver, `Internal` flag, `enable_icc=false`, the
/// pinned bridge name. Engine-assigned subnet, like celld's.
fn create_args(name: &str, internal: bool, bridge: &str) -> Vec<String> {
    let mut args = vec![
        "network".to_string(),
        "create".to_string(),
        "--driver".to_string(),
        "bridge".to_string(),
    ];
    if internal {
        args.push("--internal".to_string());
    }
    args.extend(
        [
            "--opt",
            &format!("{ICC_OPTION}=false"),
            "--opt",
            &format!("{BRIDGE_NAME_OPTION}={bridge}"),
            name,
        ]
        .into_iter()
        .map(str::to_string),
    );
    args
}

/// Make sure celld's bridges exist, creating only the missing ones (never
/// deleting: a bridge with stale options keeps serving until celld itself
/// replaces it idle). Returns the validated subnets, so the gateway table
/// and `/ready` know the plane before any fleet dials.
pub async fn ensure_networks() -> PlaneNets {
    let mut nets = PlaneNets::default();
    for (name, internal, bridge) in CELLD_NETWORKS {
        if let Some((text, subnets)) = inspect_network(name).await {
            nets.engine = true;
            if !bridge_matches(&text, name, *internal, bridge) {
                tracing::warn!(
                    network = name,
                    "celld bridge predates container isolation; celld replaces it once idle"
                );
            }
            nets.subnets.extend(subnets);
            continue;
        }
        // Missing, or the engine is down: a create distinguishes them.
        let args = create_args(name, *internal, bridge);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let out = docker(&refs, Duration::from_secs(30)).await;
        let Some(out) = out else {
            tracing::debug!(network = name, "engine unreachable; no sandbox plane");
            continue;
        };
        if out.status.success() {
            nets.engine = true;
            tracing::info!(network = name, "created celld bridge");
            if let Some((_, subnets)) = inspect_network(name).await {
                nets.subnets.extend(subnets);
            }
            continue;
        }
        // 409-style race: celld created it between our inspect and create.
        if stderr_text(&out).contains("already exists") {
            nets.engine = true;
            if let Some((_, subnets)) = inspect_network(name).await {
                nets.subnets.extend(subnets);
            }
            continue;
        }
        tracing::debug!(
            network = name,
            error = stderr_text(&out).trim(),
            "engine unreachable; no sandbox plane"
        );
    }
    nets.subnets.sort();
    nets.subnets.dedup();
    nets
}

/// The `/ready` sandbox surface (informational only: it never fails the
/// gate). Written by the boot/refresh passes, read by the handler.
#[derive(Clone, Debug, Default)]
struct SandboxProbe {
    probed: bool,
    engine: bool,
    relay: bool,
    gateway_table: bool,
    subnets: Vec<String>,
}

static PROBE: Mutex<SandboxProbe> = Mutex::new(SandboxProbe {
    probed: false,
    engine: false,
    relay: false,
    gateway_table: false,
    subnets: Vec::new(),
});

/// Record one boot/refresh pass. The subnets overwrite every pass (an empty
/// discovery honestly shows empty); the gateway table keeps its own applied
/// state so a flapping engine never cuts live traffic.
pub fn record(engine: bool, subnets: Vec<String>, relay: bool, gateway_table: bool) {
    if let Ok(mut probe) = PROBE.lock() {
        probe.probed = true;
        probe.engine = engine;
        probe.relay = relay;
        probe.gateway_table = gateway_table;
        probe.subnets = subnets;
    }
}

/// Current celld subnets for the gateway's destination check.
pub fn current_subnets() -> Vec<String> {
    PROBE
        .lock()
        .map(|probe| probe.subnets.clone())
        .unwrap_or_default()
}

/// The `/ready` `sandbox` object: enabled/engine/relay booleans, the known
/// subnets, and the first problem (or `ok`).
pub fn sandbox_status(sandbox_disabled: bool) -> serde_json::Value {
    if sandbox_disabled {
        return serde_json::json!({
            "enabled": false,
            "engine": false,
            "relay": false,
            "subnets": Vec::<String>::new(),
            "detail": "sandbox disabled (NOITE_SANDBOX=off)",
        });
    }
    let probe = PROBE.lock().map(|p| p.clone()).unwrap_or_default();
    let detail = if !probe.probed {
        "starting"
    } else if !probe.engine {
        "engine unreachable"
    } else if probe.subnets.is_empty() {
        "celld networks unavailable"
    } else if !probe.relay {
        "relay not running"
    } else if !probe.gateway_table {
        "gateway table not installed"
    } else {
        "ok"
    };
    serde_json::json!({
        "enabled": true,
        "engine": probe.engine,
        "relay": probe.relay,
        "subnets": probe.subnets,
        "detail": detail,
    })
}

/// A one-shot host helper: this same image on the host netns, `NET_ADMIN`,
/// entrypoint overridden to the firewall tool. Argv only, like every engine
/// call here. `None` unless the tool exits 0.
async fn helper(image: &str, tool_args: &[&str]) -> Option<String> {
    let mut cmd = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--network".to_string(),
        "host".to_string(),
        "--cap-add".to_string(),
        "NET_ADMIN".to_string(),
        "--entrypoint".to_string(),
        NFT_PATH.to_string(),
        image.to_string(),
    ];
    cmd.extend(tool_args.iter().map(|s| s.to_string()));
    let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
    let out = docker(&refs, Duration::from_secs(30)).await?;
    if !out.status.success() {
        return None;
    }
    stdout_text(&out)
}

/// Handles of alpha.14's `DOCKER-USER` rules in `nft -a list chain ip filter
/// DOCKER-USER` output. Alpha.14 installed, per install subnet, `iptables -s
/// <cidr> -o <celld0|celld1> -p tcp -j ACCEPT`, plus two `-i <celld0|celld1>
/// -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` reply legs
/// (`afb31be`); iptables-nft renders them with `counter` clauses and `# handle
/// N` comments. A line only qualifies when its match set is exactly one of
/// those two shapes (order-insensitive, counter-insensitive): anything with
/// an extra match (a port, a second address) is someone else's rule and stays.
pub fn cleanup_handles(listing: &str) -> Vec<u64> {
    let mut handles = Vec::new();
    for line in listing.lines() {
        if !line.contains("accept") {
            continue;
        }
        let Some(handle) = line
            .split("# handle ")
            .nth(1)
            .and_then(|r| r.split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok())
        else {
            continue;
        };
        let body = line.split('#').next().unwrap_or("");
        let mut tokens: Vec<&str> = body.split_whitespace().collect();
        // Strip the `counter packets P bytes B` clause iptables-nft adds.
        if let Some(at) = tokens.iter().position(|t| *t == "counter") {
            if tokens.len() >= at + 5 && tokens[at + 1] == "packets" && tokens[at + 3] == "bytes" {
                tokens.drain(at..at + 5);
            } else {
                continue;
            }
        }
        if is_outbound_shape(&tokens) || is_reply_shape(&tokens) {
            handles.push(handle);
        }
    }
    handles.sort_unstable();
    handles.dedup();
    handles
}

/// `ip saddr <cidr> oifname "celld0"|"celld1" meta l4proto tcp accept`,
/// exactly: the token multiset is the fixed vocabulary plus one valid CIDR
/// and one celld interface (match order is iptables-nft's, not ours, and a
/// CIDR or interface name is unambiguous wherever it sits).
fn is_outbound_shape(tokens: &[&str]) -> bool {
    if tokens.len() != 9 {
        return false;
    }
    let mut rest: Vec<&str> = tokens.to_vec();
    for fixed in ["ip", "saddr", "oifname", "meta", "l4proto", "tcp", "accept"] {
        let Some(at) = rest.iter().position(|t| *t == fixed) else {
            return false;
        };
        rest.remove(at);
    }
    if rest.len() != 2 {
        return false;
    }
    let (a, b) = (rest[0], rest[1]);
    (valid_cidr(a) && matches!(b.trim_matches('"'), "celld0" | "celld1"))
        || (valid_cidr(b) && matches!(a.trim_matches('"'), "celld0" | "celld1"))
}

/// `iifname "celld0"|"celld1" ct state established,related accept`, exactly:
/// the fixed vocabulary plus one celld interface, in any order.
fn is_reply_shape(tokens: &[&str]) -> bool {
    if tokens.len() != 6 {
        return false;
    }
    let mut rest: Vec<&str> = tokens.to_vec();
    for fixed in ["iifname", "ct", "state", "established,related", "accept"] {
        let Some(at) = rest.iter().position(|t| *t == fixed) else {
            return false;
        };
        rest.remove(at);
    }
    rest.len() == 1 && matches!(rest[0].trim_matches('"'), "celld0" | "celld1")
}

/// Which stale `noite_sandbox` tables a `nft list tables` output carries:
/// `(family, name)` pairs for `ip`/`inet`, the families alpha.12/13 used.
pub fn stale_tables(listing: &str) -> Vec<(String, String)> {
    let mut tables = Vec::new();
    for line in listing.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        if words.len() == 3
            && words[0] == "table"
            && matches!(words[1], "ip" | "inet")
            && words[2] == STALE_TABLE
        {
            tables.push((words[1].to_string(), words[2].to_string()));
        }
    }
    tables.sort();
    tables.dedup();
    tables
}

/// One-time-per-boot cleanup of what alpha.12–14 left on the host: our own
/// old `DOCKER-USER` rules (by handle, exact shapes only) and the stale
/// `noite_sandbox` tables. Lists first; the deletion helper runs only when
/// there is something to delete. Never touches Docker's rules or the `raw`
/// pins the old sweep wrongly deleted.
pub async fn cleanup_legacy() {
    let Some(own) = own_container().await else {
        return;
    };
    let chain = helper(
        &own.image,
        &["-a", "list", "chain", "ip", "filter", "DOCKER-USER"],
    )
    .await;
    let tables = helper(&own.image, &["list", "tables"]).await;
    let handles = chain.as_deref().map(cleanup_handles).unwrap_or_default();
    let stale = tables.as_deref().map(stale_tables).unwrap_or_default();
    if handles.is_empty() && stale.is_empty() {
        return;
    }
    for handle in handles {
        let arg = handle.to_string();
        if helper(
            &own.image,
            &[
                "delete",
                "rule",
                "ip",
                "filter",
                "DOCKER-USER",
                "handle",
                &arg,
            ],
        )
        .await
        .is_some()
        {
            tracing::info!(handle, "deleted legacy sandbox DOCKER-USER rule");
        }
    }
    for (family, name) in stale {
        if helper(&own.image, &["delete", "table", &family, &name])
            .await
            .is_some()
        {
            tracing::info!(table = %name, family = %family, "deleted stale sandbox host table");
        }
    }
}

/// Ensure the relay socket directory exists for the relay uid: owned
/// 65534:65534, mode 0700, so fleets cannot even traverse it.
pub fn ensure_relay_dir() -> bool {
    if std::fs::create_dir_all(super::RELAY_DIR).is_err() {
        return false;
    }
    let path = std::ffi::CString::new(super::RELAY_DIR).unwrap_or_default();
    if path.as_bytes().is_empty() {
        return false;
    }
    // SAFETY: chown on our own path with numeric ids.
    let chowned = unsafe { libc::chown(path.as_ptr(), RELAY_UID, RELAY_UID) } == 0;
    let moded =
        std::fs::set_permissions(super::RELAY_DIR, std::fs::Permissions::from_mode(0o700)).is_ok();
    chowned && moded
}

#[cfg(test)]
mod tests {
    use super::{
        bridge_matches, cleanup_handles, create_args, is_outbound_shape, is_reply_shape,
        parse_network_inspect, parse_own_container, stale_tables, valid_cidr, DataMount,
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
    fn bridge_match_checks_celld_options() {
        let matching = r#"[{"Name": "celld", "Internal": false,
          "Options": {"com.docker.network.bridge.enable_icc": "false",
                      "com.docker.network.bridge.name": "celld0"},
          "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}]}}]"#;
        assert!(bridge_matches(matching, "celld", false, "celld0"));
        assert!(!bridge_matches(matching, "celld", true, "celld0"));
        assert!(!bridge_matches(matching, "celld", false, "celld1"));
        let stale = r#"[{"Name": "celld", "Internal": false,
          "Options": {"com.docker.network.bridge.name": "celld0"},
          "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}]}}]"#;
        assert!(!bridge_matches(stale, "celld", false, "celld0"));
        assert!(!bridge_matches("bogus", "celld", false, "celld0"));
    }

    #[test]
    fn create_args_match_celld_exactly() {
        assert_eq!(
            create_args("celld", false, "celld0"),
            vec![
                "network",
                "create",
                "--driver",
                "bridge",
                "--opt",
                "com.docker.network.bridge.enable_icc=false",
                "--opt",
                "com.docker.network.bridge.name=celld0",
                "celld",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
        let internal = create_args("celld-internal", true, "celld1");
        assert!(internal.contains(&"--internal".to_string()));
        assert!(internal.contains(&"com.docker.network.bridge.name=celld1".to_string()));
    }

    #[test]
    fn own_container_reads_image_and_data_mount() {
        let json = r#"[{
          "Image": "sha256:abc123",
          "Mounts": [
            {"Type": "bind", "Source": "/run/docker.sock", "Destination": "/run/docker.sock"},
            {"Type": "volume", "Name": "noite_data", "Destination": "/data"}
          ]
        }]"#;
        assert_eq!(
            parse_own_container("9f2c4b1a8e03", json),
            Some(super::OwnContainer {
                id: "9f2c4b1a8e03".to_string(),
                short_id: "9f2c4b1a8e03".to_string(),
                image: "sha256:abc123".to_string(),
                data: DataMount::Volume("noite_data".to_string()),
            })
        );
        let bind = r#"[{
          "Image": "sha256:abc123",
          "Mounts": [{"Type": "bind", "Source": "/srv/noite", "Destination": "/data"}]
        }]"#;
        assert_eq!(
            parse_own_container("9f2c4b1a8e03extra", bind).map(|o| (o.short_id, o.data)),
            Some((
                "9f2c4b1a8e03".to_string(),
                DataMount::Bind("/srv/noite".to_string())
            ))
        );
        // No /data mount, tmpfs /data, empty image, garbage: all None.
        let nomount = r#"[{"Image": "sha256:abc123", "Mounts": []}]"#;
        assert_eq!(parse_own_container("9f2c4b1a8e03", nomount), None);
        let tmpfs = r#"[{
          "Image": "sha256:abc123",
          "Mounts": [{"Type": "tmpfs", "Destination": "/data"}]
        }]"#;
        assert_eq!(parse_own_container("9f2c4b1a8e03", tmpfs), None);
        let noimage = r#"[{"Mounts": [{"Type": "bind", "Source": "/x", "Destination": "/data"}]}]"#;
        assert_eq!(parse_own_container("9f2c4b1a8e03", noimage), None);
        assert_eq!(parse_own_container("", json), None);
        assert_eq!(parse_own_container("9f2c4b1a8e03", "bogus"), None);
    }

    #[test]
    fn outbound_shape_is_exact() {
        let good: Vec<&str> = "ip saddr 172.18.0.0/16 oifname \"celld0\" meta l4proto tcp accept"
            .split_whitespace()
            .collect();
        assert!(is_outbound_shape(&good));
        // Order-insensitive (iptables-nft's order is not ours to dictate).
        let mut flipped = good.clone();
        flipped.reverse();
        assert!(is_outbound_shape(&flipped));
        // An extra match is someone else's rule.
        let with_port: Vec<&str> =
            "ip saddr 172.18.0.0/16 oifname \"celld0\" meta l4proto tcp tcp dport 80 accept"
                .split_whitespace()
                .collect();
        assert!(!is_outbound_shape(&with_port));
        let wrong_iface: Vec<&str> =
            "ip saddr 172.18.0.0/16 oifname \"docker0\" meta l4proto tcp accept"
                .split_whitespace()
                .collect();
        assert!(!is_outbound_shape(&wrong_iface));
        let bad_cidr: Vec<&str> = "ip saddr 10.0.0.1/8 oifname \"celld0\" meta l4proto tcp accept"
            .split_whitespace()
            .collect();
        assert!(!is_outbound_shape(&bad_cidr));
        let udp: Vec<&str> = "ip saddr 172.18.0.0/16 oifname \"celld0\" meta l4proto udp accept"
            .split_whitespace()
            .collect();
        assert!(!is_outbound_shape(&udp));
    }

    #[test]
    fn reply_shape_is_exact() {
        let good: Vec<&str> = "iifname \"celld1\" ct state established,related accept"
            .split_whitespace()
            .collect();
        assert!(is_reply_shape(&good));
        let with_extra: Vec<&str> =
            "iifname \"celld1\" ip saddr 1.2.3.0/24 ct state established,related accept"
                .split_whitespace()
                .collect();
        assert!(!is_reply_shape(&with_extra));
        let new_state: Vec<&str> = "iifname \"celld1\" ct state new accept"
            .split_whitespace()
            .collect();
        assert!(!is_reply_shape(&new_state));
    }

    #[test]
    fn cleanup_deletes_only_our_old_rules() {
        // Verbatim shape of `nft -a list chain ip filter DOCKER-USER` on a
        // host that ran alpha.14 (iptables-nft rendering: counters, quoted
        // interface names, `# handle N`), plus Docker's and foreign rules.
        let listing = r#"chain DOCKER-USER {
                ip saddr 172.18.0.0/16 oifname "celld0" meta l4proto tcp counter packets 12 bytes 720 accept # handle 5
                ip saddr 172.18.0.0/16 oifname "celld1" meta l4proto tcp counter packets 0 bytes 0 accept # handle 6
                iifname "celld0" ct state established,related counter packets 40 bytes 2400 accept # handle 7
                iifname "celld1" ct state established,related counter packets 0 bytes 0 accept # handle 8
                ip saddr 172.18.0.0/16 oifname "celld0" meta l4proto tcp tcp dport 443 counter packets 0 bytes 0 accept # handle 9
                iifname "docker0" counter packets 0 bytes 0 return # handle 10
                counter packets 3 bytes 180 return # handle 11
                ip saddr 172.18.0.0/16 oifname "celld0" meta l4proto tcp counter packets 0 bytes 0 accept
        }"#;
        assert_eq!(cleanup_handles(listing), vec![5, 6, 7, 8]);
        assert!(cleanup_handles("").is_empty());
        assert!(cleanup_handles("chain DOCKER-USER {\n}").is_empty());
    }

    #[test]
    fn stale_table_detection_covers_both_families() {
        let listing =
            "table ip filter\ntable ip noite_sandbox\ntable inet noite_sandbox\ntable inet celld\n";
        assert_eq!(
            stale_tables(listing),
            vec![
                ("inet".to_string(), "noite_sandbox".to_string()),
                ("ip".to_string(), "noite_sandbox".to_string()),
            ]
        );
        assert!(stale_tables("table ip filter\n").is_empty());
        assert!(stale_tables("").is_empty());
    }
}
