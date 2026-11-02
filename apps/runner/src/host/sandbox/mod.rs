//! Sandbox containers (celld `containers` classes, e.g. the agent template)
//! on the host's container engine, without handing tenants the engine or
//! touching the host firewall.
//!
//! celld assumes it runs in the host network namespace: it dials a container
//! at its bridge address, and its own host fence (`table inet celld`) rejects
//! anything a container sends toward a private address unless it is a reply
//! arriving on the host's INPUT path. Noite runs celld inside a container on
//! a private compose bridge, so a direct dial's replies are forwarded toward
//! a private address and rejected. Three pieces route around that:
//!
//! - **relay**: one helper container in the host network namespace, no
//!   capabilities, listening on a unix socket in the shared data volume. It
//!   dials only addresses on celld's bridges, from the host side, where
//!   celld's fence admits the replies.
//! - **gateway**: fleet TCP toward celld's bridges is redirected (nft `nat`
//!   output, this container's namespace) to a runner listener, which checks
//!   the connecting fleet owns the destination container and splices the
//!   connection through the relay.
//! - **engine**: fleets never see the engine socket. Each fleet gets its own
//!   unix socket served by the runner, which forwards only the Engine API
//!   calls celld makes, validated (no privilege, no host paths, no foreign
//!   containers), and labels every container with its fleet for cleanup.
//!
//! [`registry`] is the shared ownership state between them.

pub mod engine;
pub mod registry;

/// Loopback port of the gateway listener; fleet dials to celld's bridges are
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

/// Label on every container the engine proxy lets a fleet create: the fleet
/// key. The runner removes a fleet's containers by it when the fleet exits,
/// and every labelled container at boot.
pub const FLEET_LABEL: &str = "noite.fleet";

/// Label on the relay container (value: the noite container's id).
pub const RELAY_LABEL: &str = "noite.relay";
