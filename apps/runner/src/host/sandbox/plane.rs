//! The sandbox plane on the host engine: Cello's bridges, this
//! container's own identity, and the `/ready` sandbox status.
//!
//! Everything here goes through the `docker` CLI (argv only, bounded
//! timeouts), never the Engine API: the runner holds the real socket and
//! fleets must never see it. `ensure_networks` pre-creates Cello's bridges
//! exactly as Cello 0.1.0 would (`container.rs`, `networks()`), so their
//! subnets are known before any fleet dials — Cello finds bridges with
//! matching options and keeps them, subnets included.

use super::NETWORKS;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use std::time::Duration;

/// Cello's bridge options (`container.rs`: `ICC_OPTION`, `BRIDGE_NAME_OPTION`).
const ICC_OPTION: &str = "com.docker.network.bridge.enable_icc";
const BRIDGE_NAME_OPTION: &str = "com.docker.network.bridge.name";
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

/// Whether an inspected bridge already matches what Cello 0.1.0 creates
/// (same check Cello runs before keeping a bridge: `Internal` flag plus the
/// `enable_icc=false` and bridge-name options). A mismatch only warns: we
/// never delete, and Cello replaces a stale bridge itself once it is idle.
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
/// image the engine proxy runs Cello's fence installer from.
static OWN_IMAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// The runner's own image id, when known (see [`OWN_IMAGE`]).
pub fn own_image() -> Option<String> {
    OWN_IMAGE.lock().ok().and_then(|image| image.clone())
}

/// What `ensure_networks` found: whether the engine answered at all, and the
/// validated Cello bridge subnets (empty when the engine is down or a bridge
/// is still missing).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlaneNets {
    pub engine: bool,
    pub subnets: Vec<String>,
}

/// Inspect one Cello bridge: its validated subnets when it exists.
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

/// Create one Cello bridge exactly as Cello 0.1.0 does (`container.rs`,
/// `networks()`): bridge driver, `Internal` flag, `enable_icc=false`, the
/// pinned bridge name. Engine-assigned subnet, like Cello's.
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

/// Make sure Cello's bridges exist, creating only the missing ones (never
/// deleting: a bridge with stale options keeps serving until Cello itself
/// replaces it idle). Returns the validated subnets, so the gateway table
/// and `/ready` know the plane before any fleet dials.
pub async fn ensure_networks() -> PlaneNets {
    let mut nets = PlaneNets::default();
    for (name, internal, bridge) in NETWORKS {
        if let Some((text, subnets)) = inspect_network(name).await {
            nets.engine = true;
            if !bridge_matches(&text, name, *internal, bridge) {
                tracing::warn!(
                    network = name,
                    "cello bridge predates container isolation; cello replaces it once idle"
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
            tracing::info!(network = name, "created cello bridge");
            if let Some((_, subnets)) = inspect_network(name).await {
                nets.subnets.extend(subnets);
            }
            continue;
        }
        // 409-style race: Cello created it between our inspect and create.
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
        "cello networks unavailable"
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
    use super::super::{
        BRIDGE_IFACES, INTERNAL_BRIDGE, INTERNAL_NETWORK, OPEN_BRIDGE, OPEN_NETWORK,
    };
    use super::{
        bridge_matches, create_args, parse_network_inspect, parse_own_container, valid_cidr,
        DataMount,
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
    fn network_names_match_cello_bridges() {
        // Pinned against Cello 0.1.0 `crates/cello/container.rs`
        // (`OPEN_BRIDGE`/`INTERNAL_BRIDGE`, `networks()`): Noite must create
        // and inspect exactly the bridges Cello joins its containers to, or
        // fleet→container dials bypass the ownership-checking gateway.
        assert_eq!(OPEN_NETWORK, "cello");
        assert_eq!(INTERNAL_NETWORK, "cello-internal");
        assert_eq!(OPEN_BRIDGE, "cello0");
        assert_eq!(INTERNAL_BRIDGE, "cello1");
        assert_eq!(
            super::super::NETWORKS,
            &[
                ("cello", false, "cello0"),
                ("cello-internal", true, "cello1")
            ]
        );
        // The relay dials exactly the same bridges the plane creates.
        assert_eq!(BRIDGE_IFACES, &["cello0", "cello1"]);
        // …and the engine proxy admits exactly those networks.
        assert!(super::super::engine::validate::valid_network_name(
            super::super::NETWORKS[0].0
        ));
        assert!(super::super::engine::validate::valid_network_name(
            super::super::NETWORKS[1].0
        ));
        assert!(!super::super::engine::validate::valid_network_name("Cello"));
        assert!(!super::super::engine::validate::valid_network_name(
            "cello0"
        ));
    }

    #[test]
    fn network_inspect_parses_subnets_and_drops_garbage() {
        let json = r#"[
          {"Name": "cello", "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}, {"Subnet": "bogus"}]}},
          {"Name": "noite_noite", "IPAM": {"Config": [{"Subnet": "172.18.0.0/16"}]}},
          {"Name": "", "IPAM": {"Config": [{"Subnet": "10.0.0.0/8"}]}},
          {"Name": "v6only", "IPAM": {"Config": [{"Subnet": "fd00::/64"}]}}
        ]"#;
        let parsed = parse_network_inspect(json);
        assert_eq!(
            parsed,
            vec![
                ("cello".to_string(), vec!["172.19.0.0/16".to_string()]),
                ("noite_noite".to_string(), vec!["172.18.0.0/16".to_string()]),
            ]
        );
        assert!(parse_network_inspect("").is_empty());
        assert!(parse_network_inspect("Cannot connect to the Docker daemon").is_empty());
        assert!(parse_network_inspect("{}").is_empty());
    }

    #[test]
    fn bridge_match_checks_cello_options() {
        let matching = r#"[{"Name": "cello", "Internal": false,
          "Options": {"com.docker.network.bridge.enable_icc": "false",
                      "com.docker.network.bridge.name": "cello0"},
          "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}]}}]"#;
        assert!(bridge_matches(matching, "cello", false, "cello0"));
        assert!(!bridge_matches(matching, "cello", true, "cello0"));
        assert!(!bridge_matches(matching, "cello", false, "cello1"));
        let stale = r#"[{"Name": "cello", "Internal": false,
          "Options": {"com.docker.network.bridge.name": "cello0"},
          "IPAM": {"Config": [{"Subnet": "172.19.0.0/16"}]}}]"#;
        assert!(!bridge_matches(stale, "cello", false, "cello0"));
        assert!(!bridge_matches("bogus", "cello", false, "cello0"));
    }

    #[test]
    fn create_args_match_cello_exactly() {
        assert_eq!(
            create_args("cello", false, "cello0"),
            vec![
                "network",
                "create",
                "--driver",
                "bridge",
                "--opt",
                "com.docker.network.bridge.enable_icc=false",
                "--opt",
                "com.docker.network.bridge.name=cello0",
                "cello",
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
        let internal = create_args("cello-internal", true, "cello1");
        assert!(internal.contains(&"--internal".to_string()));
        assert!(internal.contains(&"com.docker.network.bridge.name=cello1".to_string()));
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
}
