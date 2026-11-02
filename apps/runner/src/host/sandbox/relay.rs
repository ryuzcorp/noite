//! The sandbox relay: one helper container in the host network
//! namespace dialing celld's bridges from the host side, where celld's fence
//! admits the replies.
//!
//! The relay listens on a unix socket in the shared data volume and, per
//! connection, reads one `CONNECT <ipv4>:<port>` header, dials it only when
//! the address sits inside a subnet currently assigned to `celld0`/`celld1`
//! (getifaddrs at connect time — nothing else is ever dialable), answers
//! `OK`/`ERR`, then splices. It runs as uid 65534 with no capabilities, a
//! read-only rootfs, and only the relay directory mounted.
//!
//! `noite-runner sandbox-relay <socket-path>` is the relay entrypoint (no
//! runner env needed); `ensure` is the runner-side lifecycle.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::AsyncWriteExt;

/// Max header line (`CONNECT 255.255.255.255:65535\n` is 30 bytes; 64 leaves
/// no room for smuggling while accepting every valid line).
const MAX_HEADER: usize = 64;
/// Deadline for the one header line.
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
/// Timeout for the relayed TCP dial.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Concurrent relayed connections (fd-exhaustion guard).
const MAX_CONNS: usize = 512;
/// Host interfaces whose subnets are dialable.
const CELLD_IFACES: &[&str] = &["celld0", "celld1"];
/// Entrypoint override for the relay container (the runner binary's path in
/// the image; the image boots it under tini, the relay runs it directly).
const RUNNER_BIN: &str = "/usr/local/bin/noite-runner";
/// Probing address for the liveness check: TEST-NET-1 is never a bridge
/// subnet, so the relay always answers `ERR` — which proves it answers.
const PROBE_TARGET: &str = "192.0.2.1:1";

/// Parse one header line (including its trailing `\n`) into the dial target.
/// Strict: exactly `CONNECT <ipv4>:<port>`, no hostnames, no v6, no port 0.
pub fn parse_connect_header(line: &str) -> Option<SocketAddrV4> {
    let line = line.strip_suffix('\n')?;
    let line = line.strip_suffix('\r').unwrap_or(line);
    let target = line.strip_prefix("CONNECT ")?;
    if target.contains([' ', '\t']) {
        return None;
    }
    let addr: SocketAddrV4 = target.parse().ok()?;
    if addr.port() == 0 {
        return None;
    }
    Some(addr)
}

/// Whether `ip` sits inside one of `nets` (`(network, prefix)` pairs).
pub fn allowed(ip: Ipv4Addr, nets: &[(Ipv4Addr, u32)]) -> bool {
    let addr = u32::from(ip);
    nets.iter().any(|(net, prefix)| {
        if *prefix == 0 || *prefix > 32 {
            return false;
        }
        let mask = !0u32 << (32 - prefix);
        addr & mask == u32::from(*net) & mask
    })
}

/// Subnets currently assigned to `celld0`/`celld1`: `(network, prefix)` from
/// getifaddrs, evaluated per connection so a bridge re-creation takes effect
/// on the next dial. Non-contiguous masks are dropped, never trusted.
fn local_celld_subnets() -> Vec<(Ipv4Addr, u32)> {
    let mut subnets = Vec::new();
    // SAFETY: getifaddrs/freeifaddrs pairing; the list is only read.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 || list.is_null() {
            return subnets;
        }
        let mut item = list;
        while !item.is_null() {
            let ifa = &*item;
            let name = std::ffi::CStr::from_ptr(ifa.ifa_name)
                .to_string_lossy()
                .into_owned();
            if CELLD_IFACES.contains(&name.as_str())
                && !ifa.ifa_addr.is_null()
                && !ifa.ifa_netmask.is_null()
                && (*ifa.ifa_addr).sa_family as i32 == libc::AF_INET
                && (*ifa.ifa_netmask).sa_family as i32 == libc::AF_INET
            {
                let addr = &*(ifa.ifa_addr as *const libc::sockaddr_in);
                let mask = &*(ifa.ifa_netmask as *const libc::sockaddr_in);
                let ip = Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr));
                let bits = u32::from_be(mask.sin_addr.s_addr);
                let prefix = bits.count_ones();
                if prefix > 0 && bits == (!0u32 << (32 - prefix)) {
                    subnets.push((Ipv4Addr::from(u32::from(ip) & bits), prefix));
                }
            }
            item = ifa.ifa_next;
        }
        libc::freeifaddrs(list);
    }
    subnets.sort();
    subnets.dedup();
    subnets
}

/// Read the one header line, byte by byte (a buffered read could swallow
/// the client's first spliced bytes past the `\n`, and they would never
/// reach the upstream). `None` on timeout, EOF, overlong line, or garbage.
async fn read_header(stream: &mut tokio::net::UnixStream) -> Option<SocketAddrV4> {
    use tokio::io::AsyncReadExt;
    let mut line = Vec::new();
    loop {
        if line.len() > MAX_HEADER {
            return None;
        }
        let mut byte = [0u8; 1];
        stream.read_exact(&mut byte).await.ok()?;
        line.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    parse_connect_header(std::str::from_utf8(&line).ok()?)
}

/// Serve one relay connection: header, allow-check, dial, splice.
async fn handle(mut stream: tokio::net::UnixStream) {
    let header = tokio::time::timeout(HEADER_TIMEOUT, read_header(&mut stream)).await;
    let Ok(Some(target)) = header else {
        let _ = stream.write_all(b"ERR bad header\n").await;
        return;
    };
    if !allowed(*target.ip(), &local_celld_subnets()) {
        let _ = stream.write_all(b"ERR forbidden\n").await;
        return;
    }
    let upstream =
        match tokio::time::timeout(DIAL_TIMEOUT, tokio::net::TcpStream::connect(target)).await {
            Ok(Ok(upstream)) => upstream,
            _ => {
                let _ = stream.write_all(b"ERR dial failed\n").await;
                return;
            }
        };
    if stream.write_all(b"OK\n").await.is_err() {
        return;
    }
    let mut upstream = upstream;
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
}

/// Listen on `socket_path` until the process dies. Removes a stale socket
/// file first; the socket is 0600 (the relay uid owns the directory, and the
/// runner connects as root).
pub async fn serve(socket_path: &str) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(socket_path);
    let listener = tokio::net::UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONNS));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        tokio::spawn(async move {
            let _permit = permit;
            handle(stream).await;
        });
    }
}

/// The `sandbox-relay <socket-path>` subcommand: no config, no runner env.
/// Logging is a plain stderr filter (the daemon's logging setup never runs
/// on this path).
pub async fn run_standalone(argv: &[String]) -> anyhow::Result<()> {
    let Some(path) = argv.first() else {
        eprintln!("usage: noite-runner sandbox-relay <socket-path>");
        std::process::exit(2);
    };
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "noite_runner=info".into()),
        )
        .init();
    tracing::info!(socket = %path, "sandbox relay listening");
    serve(path).await
}

/// This install's relay container name.
pub fn relay_name(short_id: &str) -> String {
    format!("noite-sandbox-relay-{short_id}")
}

/// One `noite.relay`-labelled container, as the lifecycle needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub running: bool,
    pub owner: String,
}

/// Parse `docker inspect` output over relay containers: id, name (leading
/// `/` stripped), image id, running state, and the owner label.
pub fn parse_relay_inspect(json: &str) -> Vec<RelayInfo> {
    let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for value in values {
        let (Some(id), Some(name), Some(image)) = (
            value.pointer("/Id").and_then(|v| v.as_str()),
            value.pointer("/Name").and_then(|v| v.as_str()),
            value.pointer("/Image").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let running = value
            .pointer("/State/Running")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let owner = value
            .pointer("/Config/Labels/noite.relay")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        out.push(RelayInfo {
            id: id.to_string(),
            name: name.trim_start_matches('/').to_string(),
            image: image.to_string(),
            running,
            owner: owner.to_string(),
        });
    }
    out
}

async fn docker(args: &[&str], timeout: Duration) -> Option<std::process::Output> {
    let mut cmd = tokio::process::Command::new("docker");
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let child = cmd.spawn().ok()?;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .ok()?
        .ok()
}

/// The `docker run` argv for our relay: host netns, no capabilities, no new
/// privileges, read-only rootfs, uid 65534, tight pids/memory caps, the
/// relay directory mounted at `/relay`, entrypoint overridden to the runner
/// binary. No restart policy (the runner owns the lifecycle).
fn run_args(name: &str, own: &super::plane::OwnContainer) -> Vec<String> {
    let mount = match &own.data {
        super::plane::DataMount::Volume(vol) => {
            format!("type=volume,src={vol},dst=/relay,volume-subpath=sandbox-relay")
        }
        super::plane::DataMount::Bind(src) => {
            format!("type=bind,src={src}/sandbox-relay,dst=/relay")
        }
    };
    [
        "run",
        "-d",
        "--name",
        name,
        "--network",
        "host",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--user",
        "65534:65534",
        "--pids-limit",
        "64",
        "--memory",
        "64m",
        "--label",
        &format!("{}={}", super::RELAY_LABEL, own.id),
        "--mount",
        &mount,
        "--entrypoint",
        RUNNER_BIN,
        &own.image,
        "sandbox-relay",
        "/relay/relay.sock",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

/// Whether the named container exists (by inspect exit status).
async fn container_exists(name: &str) -> bool {
    docker(&["inspect", name], Duration::from_secs(10))
        .await
        .is_some_and(|out| out.status.success())
}

/// Ensure our relay container runs from our own image, replacing one whose
/// image differs or that is not running, and removing relays whose owner is
/// gone (a previous install's relay on a shared engine). True when our relay
/// is running afterwards.
pub async fn ensure() -> bool {
    if !super::plane::ensure_relay_dir() {
        tracing::warn!("cannot prepare the relay directory; sandbox relay not running");
        return false;
    }
    let Some(own) = super::plane::own_container().await else {
        return false;
    };
    let name = relay_name(&own.short_id);
    let ids = docker(
        &[
            "ps",
            "-a",
            "--filter",
            "label=noite.relay",
            "--format",
            "{{.ID}}",
        ],
        Duration::from_secs(10),
    )
    .await
    .and_then(|out| String::from_utf8(out.stdout).ok())
    .map(|text| {
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();
    // Inspect the labelled containers (usually none or one) to learn their
    // image, state, and owner.
    let mut relays = Vec::new();
    for id in &ids {
        let infos = docker(&["inspect", id], Duration::from_secs(10))
            .await
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| parse_relay_inspect(&text))
            .unwrap_or_default();
        relays.extend(infos);
    }
    let mut ours_running = false;
    for relay in &relays {
        if relay.name == name {
            if relay.image == own.image && relay.running {
                ours_running = true;
                continue;
            }
            tracing::info!(
                image_matches = relay.image == own.image,
                running = relay.running,
                "replacing sandbox relay"
            );
            docker(&["rm", "-f", &relay.id], Duration::from_secs(30)).await;
            continue;
        }
        // Another install's relay: remove it only when its owner is gone.
        // An ownerless label or a live foreign owner is left alone.
        if relay.owner.is_empty() || relay.owner == own.id {
            if relay.owner == own.id {
                docker(&["rm", "-f", &relay.id], Duration::from_secs(30)).await;
            }
            continue;
        }
        if !container_exists(&relay.owner).await {
            tracing::info!(relay = %relay.name, "removing orphaned sandbox relay");
            docker(&["rm", "-f", &relay.id], Duration::from_secs(30)).await;
        }
    }
    if !ours_running {
        let args = run_args(&name, &own);
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let started = docker(&refs, Duration::from_secs(60))
            .await
            .is_some_and(|out| out.status.success());
        if !started {
            tracing::warn!("could not start the sandbox relay");
            return false;
        }
        tracing::info!(relay = %name, "started sandbox relay");
        // The name now exists; confirm it runs (a create that exits at once
        // must read back as not running, not as success).
        ours_running = docker(&["inspect", &name], Duration::from_secs(10))
            .await
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .map(|text| {
                parse_relay_inspect(&text)
                    .iter()
                    .any(|r| r.name == name && r.running)
            })
            .unwrap_or(false);
    }
    ours_running
}

/// Whether the relay answers: our container runs and the socket speaks the
/// protocol (a probe header for an undialable address must draw `ERR`).
pub async fn healthy() -> bool {
    let short = std::fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().chars().take(12).collect::<String>())
        .unwrap_or_default();
    if short.is_empty() {
        return false;
    }
    let running = docker(&["inspect", &relay_name(&short)], Duration::from_secs(10))
        .await
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| {
            parse_relay_inspect(&text)
                .iter()
                .any(|r| r.name == relay_name(&short) && r.running)
        })
        .unwrap_or(false);
    if !running {
        return false;
    }
    let stream = match tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::UnixStream::connect(super::RELAY_SOCKET),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        _ => return false,
    };
    let (reader, mut writer) = stream.into_split();
    if tokio::time::timeout(
        Duration::from_secs(2),
        writer.write_all(format!("CONNECT {PROBE_TARGET}\n").as_bytes()),
    )
    .await
    .is_err()
    {
        return false;
    }
    use tokio::io::AsyncBufReadExt;
    let mut reader = tokio::io::BufReader::new(reader);
    let mut line = String::new();
    let Ok(Ok(_)) =
        tokio::time::timeout(Duration::from_secs(15), reader.read_line(&mut line)).await
    else {
        return false;
    };
    // Any well-formed answer proves the relay serves; the probe target is
    // undialable, so a correct relay answers `ERR`.
    line == "ERR forbidden\n" || line.starts_with("ERR ")
}

/// Remove our relay container (graceful shutdown). Best-effort: the next
/// boot's `ensure` replaces a leftover, and the socket file is stale-removed
/// on the next listen.
pub async fn remove_ours() {
    let short = std::fs::read_to_string("/etc/hostname")
        .map(|h| h.trim().chars().take(12).collect::<String>())
        .unwrap_or_default();
    if short.is_empty() {
        return;
    }
    docker(&["rm", "-f", &relay_name(&short)], Duration::from_secs(30)).await;
}

#[cfg(test)]
mod tests {
    use super::{allowed, parse_connect_header, parse_relay_inspect, relay_name, run_args};
    use std::net::Ipv4Addr;

    #[test]
    fn header_parsing_is_strict() {
        let addr = parse_connect_header("CONNECT 172.19.0.2:8080\n").expect("valid");
        assert_eq!(addr.ip(), &Ipv4Addr::new(172, 19, 0, 2));
        assert_eq!(addr.port(), 8080);
        for bad in [
            "",
            "CONNECT 172.19.0.2:8080",
            "CONNECT 172.19.0.2:8080\r",
            "connect 172.19.0.2:8080\n",
            "CONNECT  172.19.0.2:8080\n",
            "CONNECT 172.19.0.2\n",
            "CONNECT 172.19.0.2:0\n",
            "CONNECT example.com:80\n",
            "CONNECT ::1:80\n",
            "CONNECT 172.19.0.2:80 extra\n",
            "CONNECT 172.19.0.2:99999\n",
            "GET / HTTP/1.1\n",
        ] {
            assert_eq!(parse_connect_header(bad), None, "{bad:?}");
        }
        // Tolerate CRLF (a raw TCP client), nothing else.
        assert!(parse_connect_header("CONNECT 172.19.0.2:80\r\n").is_some());
    }

    #[test]
    fn allowlist_is_subnet_membership_only() {
        let nets = vec![
            (Ipv4Addr::new(172, 19, 0, 0), 16),
            (Ipv4Addr::new(172, 20, 5, 0), 24),
        ];
        assert!(allowed(Ipv4Addr::new(172, 19, 0, 2), &nets));
        assert!(allowed(Ipv4Addr::new(172, 20, 5, 200), &nets));
        for denied in [
            Ipv4Addr::new(172, 18, 0, 2),
            Ipv4Addr::new(172, 20, 6, 1),
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(10, 0, 0, 1),
            Ipv4Addr::LOCALHOST,
        ] {
            assert!(!allowed(denied, &nets), "{denied}");
        }
        assert!(!allowed(Ipv4Addr::new(172, 19, 0, 2), &[]));
        // Degenerate prefixes never match.
        assert!(!allowed(
            Ipv4Addr::new(172, 19, 0, 2),
            &[(Ipv4Addr::new(0, 0, 0, 0), 0)]
        ));
    }

    #[test]
    fn relay_inspect_parses_state_and_owner() {
        let json = r#"[{
          "Id": "abc123", "Name": "/noite-sandbox-relay-9f2c4b1a8e03",
          "Image": "sha256:img",
          "State": {"Running": true},
          "Config": {"Labels": {"noite.relay": "9f2c4b1a8e03"}}
        }, {
          "Id": "def456", "Name": "/noite-sandbox-relay-deadbeef0001",
          "Image": "sha256:old",
          "State": {"Running": false},
          "Config": {"Labels": {"noite.relay": "deadbeef0001"}}
        }, {
          "Id": "zzz", "Name": 42
        }]"#;
        let infos = parse_relay_inspect(json);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "noite-sandbox-relay-9f2c4b1a8e03");
        assert!(infos[0].running);
        assert_eq!(infos[0].owner, "9f2c4b1a8e03");
        assert!(!infos[1].running);
        assert!(parse_relay_inspect("bogus").is_empty());
    }

    #[test]
    fn relay_name_and_run_argv() {
        assert_eq!(
            relay_name("9f2c4b1a8e03"),
            "noite-sandbox-relay-9f2c4b1a8e03"
        );
        let own = super::super::plane::OwnContainer {
            id: "9f2c4b1a8e03".to_string(),
            short_id: "9f2c4b1a8e03".to_string(),
            image: "sha256:img".to_string(),
            data: super::super::plane::DataMount::Volume("noite_data".to_string()),
        };
        let args = run_args("noite-sandbox-relay-9f2c4b1a8e03", &own);
        let rendered = args.join(" ");
        assert!(
            rendered.starts_with("run -d --name noite-sandbox-relay-9f2c4b1a8e03 "),
            "{rendered}"
        );
        for flag in [
            "--network host",
            "--cap-drop ALL",
            "--security-opt no-new-privileges",
            "--read-only",
            "--user 65534:65534",
            "--pids-limit 64",
            "--memory 64m",
            "--label noite.relay=9f2c4b1a8e03",
            "--mount type=volume,src=noite_data,dst=/relay,volume-subpath=sandbox-relay",
            "--entrypoint /usr/local/bin/noite-runner",
            "sha256:img sandbox-relay /relay/relay.sock",
        ] {
            assert!(rendered.contains(flag), "missing {flag} in {rendered}");
        }
        assert!(
            !rendered.contains("--restart"),
            "no restart policy: {rendered}"
        );
        assert!(!rendered.contains("-i "), "detached, no stdin: {rendered}");
        let bind = super::super::plane::OwnContainer {
            data: super::super::plane::DataMount::Bind("/srv/noite".to_string()),
            ..own
        };
        let rendered = run_args("n", &bind).join(" ");
        assert!(
            rendered.contains("--mount type=bind,src=/srv/noite/sandbox-relay,dst=/relay"),
            "{rendered}"
        );
    }
}
