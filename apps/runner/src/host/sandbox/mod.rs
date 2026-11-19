//! Sandbox containers (Cello `containers` classes, e.g. the agent template)
//! on the host's container engine, without handing tenants the engine or
//! touching the host firewall.
//!
//! Cello assumes it runs in the host network namespace: it dials a container
//! at its bridge address, and its own host fence (`table inet cello`)
//! rejects anything a container sends toward a private address unless it is
//! a reply arriving on the host's INPUT path. Noite runs Cello inside a
//! container on a private compose bridge, so a direct dial's replies are
//! forwarded toward a private address and rejected. Three pieces route
//! around that:
//!
//! - **relay**: one helper container in the host network namespace, no
//!   capabilities, listening on a unix socket in the shared data volume. It
//!   dials only addresses on Cello's bridges, from the host side, where
//!   Cello's fence admits the replies.
//! - **gateway**: fleet TCP toward Cello's bridges is redirected (nft `nat`
//!   output, this container's namespace) to a runner listener, which checks
//!   the connecting fleet owns the destination container and splices the
//!   connection through the relay.
//! - **engine**: fleets never see the engine socket. Each fleet gets its own
//!   unix socket served by the runner, which forwards only the Engine API
//!   calls Cello makes, validated (no privilege, no host paths, no foreign
//!   containers), and labels every container with its fleet for cleanup.
//!
//! [`registry`] is the shared ownership state between them.

pub mod engine;
pub mod gateway;
pub mod plane;
pub mod registry;
pub mod relay;

/// Loopback port of the gateway listener; fleet dials to Cello's bridges are
/// redirected here. Below the fleet port range (`db::alloc`, 20000+).
pub const GATEWAY_PORT: u16 = 8071;

/// Directory of the per-fleet engine sockets (one `<fleet>.sock` each,
/// owned by the fleet uid, 0600).
pub const ENGINE_SOCKET_DIR: &str = "/run/noite-engine";

/// Directory, inside the data volume, of the relay's unix socket. The relay
/// container mounts the same volume at the same path.
pub const RELAY_DIR: &str = "/data/sandbox-relay";

/// The relay's socket inside [`RELAY_DIR`].
pub const RELAY_SOCKET: &str = "/data/sandbox-relay/relay.sock";

/// Label on every container the engine proxy lets a fleet create:
/// `<install>:<fleet key>` ([`owner`]). The runner removes a fleet's
/// containers by it when the fleet exits.
pub const FLEET_LABEL: &str = "noite.fleet";

/// Label on every container the engine proxy lets a fleet create: the
/// install id alone, so the boot sweep removes this install's containers
/// and never another install's on a shared engine.
pub const INSTALL_LABEL: &str = "noite.install";

/// Cello 0.1.0's container networks (fixed names; subnets are
/// engine-assigned), exactly as `crates/cello/container.rs`
/// (`OPEN_BRIDGE`/`INTERNAL_BRIDGE`, `networks()`) creates them. Every
/// sandbox surface (plane, relay, gateway subnets, engine-proxy validation)
/// reads these, so the names cannot drift apart again.
pub const OPEN_NETWORK: &str = "cello";
pub const INTERNAL_NETWORK: &str = "cello-internal";
pub const OPEN_BRIDGE: &str = "cello0";
pub const INTERNAL_BRIDGE: &str = "cello1";
/// `(network name, internal, bridge interface)` for both Cello bridges.
pub const NETWORKS: &[(&str, bool, &str)] = &[
    (OPEN_NETWORK, false, OPEN_BRIDGE),
    (INTERNAL_NETWORK, true, INTERNAL_BRIDGE),
];
/// Host interfaces the relay may dial (the bridges' host sides).
pub const BRIDGE_IFACES: &[&str] = &[OPEN_BRIDGE, INTERNAL_BRIDGE];
static INSTALL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Record this install's id (the store-derived install tag,
/// `credentials::install_tag`) once at boot, before any fleet starts.
pub fn set_install(id: String) {
    let _ = INSTALL.set(id);
}

/// This install's id; empty before [`set_install`] (tests).
pub fn install() -> &'static str {
    INSTALL.get().map_or("", String::as_str)
}

/// The [`FLEET_LABEL`] value for a fleet of this install.
pub fn owner(fleet: &str) -> String {
    format!("{}:{fleet}", install())
}

/// Label on the relay container (value: the noite container's id).
pub const RELAY_LABEL: &str = "noite.relay";
