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
/// iptables in this image: the cleanup deletes alpha.14's `DOCKER-USER`
/// rules with the same tool (and so the same backend) that inserted them.
const IPTABLES_PATH: &str = "/usr/sbin/iptables";
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
    let own = parse_own_container(&id, &text)?;
    if let Ok(mut image) = OWN_IMAGE.lock() {
        *image = Some(own.image.clone());
    }
    Some(own)
}

/// This container's image id, once [`own_container`] read it: the trusted
/// image the engine proxy runs celld's fence installer from.
static OWN_IMAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The runner's own image id, when known (see [`OWN_IMAGE`]).
pub fn own_image() -> Option<String> {
    OWN_IMAGE.lock().ok().and_then(|image| image.clone())
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
/// entrypoint overridden to a firewall tool. Argv only, like every engine
/// call here. `None` unless the tool exits 0.
async fn helper(image: &str, tool: &str, tool_args: &[&str]) -> Option<String> {
    let mut cmd = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--network".to_string(),
        "host".to_string(),
        "--cap-add".to_string(),
        "NET_ADMIN".to_string(),
        "--entrypoint".to_string(),
        tool.to_string(),
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

/// alpha.14's `DOCKER-USER` rules in `iptables -S DOCKER-USER` output, as
/// the argv that deletes each (`-D DOCKER-USER …`). alpha.14 inserted them
/// with this image's `iptables` (`afb31be`): per install subnet
/// `-s <cidr> -o <celld0|celld1> -p tcp -j ACCEPT`, plus
/// `-i <celld0|celld1> -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`.
/// `-S` prints rules canonically, so only those exact lines qualify; any
/// other rule (Docker's, the operator's, one with an extra match) stays. A
/// duplicated rule yields one delete per copy.
pub fn legacy_rule_deletes(listing: &str) -> Vec<Vec<String>> {
    let mut deletes = Vec::new();
    for line in listing.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let ours = match words.as_slice() {
            ["-A", "DOCKER-USER", "-s", cidr, "-o", iface, "-p", "tcp", "-j", "ACCEPT"] => {
                valid_cidr(cidr) && matches!(*iface, "celld0" | "celld1")
            }
            ["-A", "DOCKER-USER", "-i", iface, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"] =>
            {
                matches!(*iface, "celld0" | "celld1")
            }
            _ => false,
        };
        if ours {
            let mut argv: Vec<String> = words.iter().map(|w| w.to_string()).collect();
            argv[0] = "-D".to_string();
            deletes.push(argv);
        }
    }
    deletes
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
/// old `DOCKER-USER` rules (exact specs only) and the stale `noite_sandbox`
/// tables. Lists first; deletion helpers run only when there is something
/// to delete. Never touches Docker's rules or the `raw` rules the old sweep
/// wrongly deleted (Docker re-creates those with its containers).
pub async fn cleanup_legacy() {
    let Some(own) = own_container().await else {
        return;
    };
    let chain = helper(&own.image, IPTABLES_PATH, &["-S", "DOCKER-USER"]).await;
    let tables = helper(&own.image, NFT_PATH, &["list", "tables"]).await;
    for argv in chain
        .as_deref()
        .map(legacy_rule_deletes)
        .unwrap_or_default()
    {
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        if helper(&own.image, IPTABLES_PATH, &refs).await.is_some() {
            tracing::info!(rule = ?argv, "deleted legacy sandbox DOCKER-USER rule");
        }
    }
    for (family, name) in tables.as_deref().map(stale_tables).unwrap_or_default() {
        if helper(&own.image, NFT_PATH, &["delete", "table", &family, &name])
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
        bridge_matches, create_args, legacy_rule_deletes, parse_network_inspect,
        parse_own_container, stale_tables, valid_cidr, DataMount,
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
    fn cleanup_deletes_only_our_old_rules() {
        // `iptables -S DOCKER-USER` on a Docker 29 host that ran alpha.14
        // (captured in the lab), plus Docker's and foreign rules.
        let listing = "-N DOCKER-USER
-A DOCKER-USER -i celld1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A DOCKER-USER -i celld0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A DOCKER-USER -s 172.18.0.0/16 -o celld1 -p tcp -j ACCEPT
-A DOCKER-USER -s 172.18.0.0/16 -o celld0 -p tcp -j ACCEPT
-A DOCKER-USER -s 172.18.0.0/16 -o celld0 -p tcp -j ACCEPT
-A DOCKER-USER -s 172.18.0.0/16 -o celld0 -p tcp -m tcp --dport 443 -j ACCEPT
-A DOCKER-USER -i docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A DOCKER-USER -s 10.0.0.1/8 -o celld0 -p tcp -j ACCEPT
-A DOCKER-USER -j RETURN
";
        let deletes: Vec<String> = legacy_rule_deletes(listing)
            .iter()
            .map(|argv| argv.join(" "))
            .collect();
        assert_eq!(
            deletes,
            vec![
                "-D DOCKER-USER -i celld1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
                "-D DOCKER-USER -i celld0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
                "-D DOCKER-USER -s 172.18.0.0/16 -o celld1 -p tcp -j ACCEPT",
                "-D DOCKER-USER -s 172.18.0.0/16 -o celld0 -p tcp -j ACCEPT",
                // A duplicate (alpha.14's refresh raced itself) is deleted per copy.
                "-D DOCKER-USER -s 172.18.0.0/16 -o celld0 -p tcp -j ACCEPT",
            ]
        );
        assert!(legacy_rule_deletes("").is_empty());
        assert!(legacy_rule_deletes("-N DOCKER-USER\n-A DOCKER-USER -j RETURN\n").is_empty());
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
