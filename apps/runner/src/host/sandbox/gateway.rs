//! The sandbox gateway: fleet TCP toward celld's bridges is redirected
//! here (nft `nat` output, this container's namespace), and the gateway
//! splices it through the relay only when the connecting fleet owns the
//! destination container.
//!
//! Per connection: `SO_ORIGINAL_DST` recovers the pre-redirect destination
//! (it must lie in the current celld subnets); the accepted socket's peer
//! plus that destination identify the client socket in `/proc/net/tcp`
//! (local = peer, remote = original dst) → its inode → the fleet pid
//! holding `socket:[inode]` → the fleet. Unless the engine proxy's registry
//! says that fleet owns the destination IP, the connection is refused. This
//! closes the shared-fleet-uid hole: every tenant shares the uid, so the
//! filter table cannot tell fleets apart, but pids can.

use std::net::{Ipv4Addr, SocketAddrV4};
use std::os::fd::AsRawFd;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// `SO_ORIGINAL_DST` (not in libc): `getsockopt(SOL_IP, 80)`.
const SO_ORIGINAL_DST: libc::c_int = 80;
/// Concurrent gateway connections (fd-exhaustion guard; the relay bounds
/// the splices behind us more tightly).
const MAX_CONNS: usize = 1024;
/// Relay liveness probe timeouts (connect, write, one answer line).
const RELAY_TIMEOUT: Duration = Duration::from_secs(5);
/// Answer wait: the relay dials with a 10 s timeout, so 15 s covers it.
const RELAY_ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// Minimum gap between relay re-ensures triggered by gateway failures.
const RELAY_ENSURE_DEBOUNCE: Duration = Duration::from_secs(30);
/// Minimum gap between ownership-refusal warnings (a hostile fleet could
/// otherwise flood the log one line per dial).
const WARN_EVERY: Duration = Duration::from_secs(10);

/// The pre-redirect destination of an accepted connection, via
/// `getsockopt(SOL_IP, SO_ORIGINAL_DST)`. `None` when the socket was not
/// redirected through conntrack (or the call fails).
fn original_dst(stream: &tokio::net::TcpStream) -> Option<SocketAddrV4> {
    let fd = stream.as_raw_fd();
    let mut addr: libc::sockaddr_in = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most `len` bytes into a live sockaddr_in.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_IP,
            SO_ORIGINAL_DST,
            &mut addr as *mut libc::sockaddr_in as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 || addr.sin_family as i32 != libc::AF_INET {
        return None;
    }
    Some(SocketAddrV4::new(
        Ipv4Addr::from(u32::from_be(addr.sin_addr.s_addr)),
        u16::from_be(addr.sin_port),
    ))
}

/// Parse one `/proc/net/tcp` address (`0100007F:1F90`): the IP is hex in
/// *network* display order of a little-endian word (so `0100007F` is
/// 127.0.0.1), the port is plain hex.
pub fn parse_hex_sockaddr(s: &str) -> Option<SocketAddrV4> {
    let (ip_hex, port_hex) = s.split_once(':')?;
    let word = u32::from_str_radix(ip_hex, 16).ok()?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;
    Some(SocketAddrV4::new(Ipv4Addr::from(word.to_le_bytes()), port))
}

/// The inode of the client socket with this local/remote pair in
/// `/proc/net/tcp` output. When several rows match (a stale TIME_WAIT beside
/// the live socket), the established one wins.
pub fn find_client_inode(text: &str, local: SocketAddrV4, remote: SocketAddrV4) -> Option<u64> {
    let mut fallback = None;
    for line in text.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 {
            continue;
        }
        let (Some(have_local), Some(have_remote)) =
            (parse_hex_sockaddr(parts[1]), parse_hex_sockaddr(parts[2]))
        else {
            continue;
        };
        if have_local != local || have_remote != remote {
            continue;
        }
        let Ok(inode) = parts[9].parse::<u64>() else {
            continue;
        };
        if inode == 0 {
            continue;
        }
        // `0A` is ESTABLISHED (`include/net/tcp_states.h`).
        if parts[3] == "0A" {
            return Some(inode);
        }
        fallback.get_or_insert(inode);
    }
    fallback
}

/// The fleet whose pid holds `socket:[inode]` in its fd table. Only live
/// fleet pids are scanned (the registry's): anything else dialing is not a
/// tenant dial.
///
/// Reading another user's `/proc/<pid>/fd` links is a ptrace-read check
/// against the caller's *filesystem* ids, and the runner (root without
/// `CAP_SYS_PTRACE`) fails it for fleets, which run as the fleet user. So
/// the scan runs on a thread of its own that first takes the fleet's ids as
/// its fsuid/fsgid (`setfsuid` is per thread) and then exits, so no pooled
/// thread ever keeps them.
async fn fleet_of_inode(
    inode: u64,
    pids: Vec<(String, u32)>,
    fleet_ids: Option<(u32, u32)>,
) -> Option<String> {
    let (send, recv) = tokio::sync::oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("gateway-fd-scan".to_string())
        .spawn(move || {
            if let Some((uid, gid)) = fleet_ids {
                // SAFETY: setfsgid/setfsuid only change this thread's
                // filesystem ids; the thread exits right after the scan.
                unsafe {
                    libc::setfsgid(gid);
                    libc::setfsuid(uid);
                }
            }
            let _ = send.send(scan_fds(inode, &pids));
        });
    if spawned.is_err() {
        return None;
    }
    recv.await.ok().flatten()
}

fn scan_fds(inode: u64, pids: &[(String, u32)]) -> Option<String> {
    let want = format!("socket:[{inode}]");
    for (fleet, pid) in pids {
        let dir = format!("/proc/{pid}/fd");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if std::fs::read_link(entry.path())
                .map(|target| target.to_string_lossy() == want)
                .unwrap_or(false)
            {
                return Some(fleet.clone());
            }
        }
    }
    None
}

/// The ownership decision: allow only when the connecting process is a known
/// fleet's and that same fleet owns the destination container's IP.
pub fn authorized(client_fleet: Option<&str>, owner: Option<&str>) -> bool {
    matches!((client_fleet, owner), (Some(c), Some(o)) if c == o)
}

/// Whether `ip` sits inside one of the validated CIDRs.
fn in_subnets(ip: Ipv4Addr, subnets: &[String]) -> bool {
    let addr = u32::from(ip);
    subnets.iter().any(|cidr| {
        let Some((net, prefix)) = cidr.split_once('/') else {
            return false;
        };
        let (Ok(net), Ok(bits)) = (net.parse::<Ipv4Addr>(), prefix.parse::<u32>()) else {
            return false;
        };
        if !(1..=32).contains(&bits) {
            return false;
        }
        let mask = !0u32 << (32 - bits);
        addr & mask == u32::from(net) & mask
    })
}

static LAST_WARN: Mutex<Option<Instant>> = Mutex::new(None);

/// Warn at most every `WARN_EVERY`: one line per refused dial would let a
/// hostile fleet flood the log.
fn warn_limited(fleet: &str, dst: SocketAddrV4) {
    let now = Instant::now();
    let due = LAST_WARN
        .lock()
        .map(|mut last| {
            let due = last
                .map(|at| now.duration_since(at) >= WARN_EVERY)
                .unwrap_or(true);
            if due {
                *last = Some(now);
            }
            due
        })
        .unwrap_or(true);
    if due {
        tracing::warn!(fleet = %fleet, dst = %dst, "sandbox gateway refused a dial to a container the fleet does not own");
    }
}

static LAST_RELAY_ENSURE: Mutex<Option<Instant>> = Mutex::new(None);

/// The relay is unreachable: trigger a re-ensure, debounced, and let this
/// connection go (its retry rides the fresh relay).
fn trigger_relay_ensure() {
    let now = Instant::now();
    let due = LAST_RELAY_ENSURE
        .lock()
        .map(|mut last| {
            let due = last
                .map(|at| now.duration_since(at) >= RELAY_ENSURE_DEBOUNCE)
                .unwrap_or(true);
            if due {
                *last = Some(now);
            }
            due
        })
        .unwrap_or(true);
    if due {
        tracing::warn!("sandbox relay unreachable; re-ensuring it");
        tokio::spawn(async move {
            super::relay::ensure().await;
        });
    }
}

/// Serve one gateway connection: original destination, ownership, splice
/// through the relay.
async fn handle(mut stream: tokio::net::TcpStream, fleet_ids: Option<(u32, u32)>) {
    let peer = stream.peer_addr().ok().and_then(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4),
        _ => None,
    });
    let dst = original_dst(&stream);
    let (Some(peer), Some(dst)) = (peer, dst) else {
        return;
    };
    if !in_subnets(*dst.ip(), &super::plane::current_subnets()) {
        return;
    }
    let tcp = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
    let fleet = match find_client_inode(&tcp, peer, dst) {
        Some(inode) => fleet_of_inode(inode, super::registry::fleet_pids(), fleet_ids).await,
        None => None,
    };
    let owner = super::registry::owner_of_ip(*dst.ip());
    if !authorized(fleet.as_deref(), owner.as_deref()) {
        warn_limited(fleet.as_deref().unwrap_or("unknown"), dst);
        return;
    }
    let mut relay = match tokio::time::timeout(
        RELAY_TIMEOUT,
        tokio::net::UnixStream::connect(super::RELAY_SOCKET),
    )
    .await
    {
        Ok(Ok(relay)) => relay,
        _ => {
            trigger_relay_ensure();
            return;
        }
    };
    let header = format!("CONNECT {dst}\n");
    {
        use tokio::io::AsyncWriteExt;
        if tokio::time::timeout(RELAY_TIMEOUT, relay.write_all(header.as_bytes()))
            .await
            .is_err()
        {
            trigger_relay_ensure();
            return;
        }
    }
    // The answer line, byte by byte: a buffered read could swallow the
    // upstream's first spliced bytes past the `\n`.
    let answer = tokio::time::timeout(RELAY_ANSWER_TIMEOUT, async {
        use tokio::io::AsyncReadExt;
        let mut line = Vec::new();
        loop {
            if line.len() > 128 {
                return None;
            }
            let mut byte = [0u8; 1];
            relay.read_exact(&mut byte).await.ok()?;
            line.push(byte[0]);
            if byte[0] == b'\n' {
                break;
            }
        }
        Some(line)
    })
    .await;
    match answer {
        Ok(Some(line)) if line == b"OK\n" => {}
        Ok(_) => return,
        Err(_) => {
            trigger_relay_ensure();
            return;
        }
    }
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut relay).await;
}

/// Accept loop: binds `127.0.0.1:GATEWAY_PORT`, rebinds after failures (a
/// lost listener would blackhole every sandbox dial until the next boot).
async fn accept_loop(fleet_ids: Option<(u32, u32)>) {
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONNS));
    loop {
        let listener =
            match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, super::GATEWAY_PORT)).await {
                Ok(listener) => listener,
                Err(e) => {
                    tracing::warn!(error = %e, "sandbox gateway cannot bind; retrying");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            };
        tracing::info!(port = super::GATEWAY_PORT, "sandbox gateway listening");
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Ok(permit) = semaphore.clone().try_acquire_owned() else {
                drop(stream);
                continue;
            };
            tokio::spawn(async move {
                let _permit = permit;
                handle(stream, fleet_ids).await;
            });
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Spawn the gateway accept loop (idempotent for the boot path: one
/// listener; the loop itself survives bind failures). `fleet_ids` are the
/// fleet user's uid/gid (`None` when fleets run as the runner's own user).
pub fn spawn(fleet_ids: Option<(u32, u32)>) {
    tokio::spawn(accept_loop(fleet_ids));
}

/// The gateway nftables ruleset: fleet TCP toward the celld bridges is
/// redirected to the gateway listener. A separate table from the egress
/// policy, installed in both tenancies; the atomic `table` / `delete table`
/// / `table {}` replace is the same shape `netisolation` uses.
pub fn gateway_ruleset(subnets: &[String]) -> String {
    let valid: Vec<&str> = subnets
        .iter()
        .map(String::as_str)
        .filter(|s| super::plane::valid_cidr(s))
        .collect();
    format!(
        r#"table inet noite_gateway
delete table inet noite_gateway
table inet noite_gateway {{
  chain output {{
    type nat hook output priority -100; policy accept;
    ip daddr {{ {} }} meta l4proto tcp redirect to :{}
  }}
}}"#,
        valid.join(", "),
        super::GATEWAY_PORT,
    )
}

static APPLIED_GATEWAY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static TABLE_OK: Mutex<bool> = Mutex::new(false);

fn applied() -> Vec<String> {
    APPLIED_GATEWAY
        .lock()
        .map(|applied| applied.clone())
        .unwrap_or_default()
}

fn table_ok() -> bool {
    TABLE_OK.lock().map(|ok| *ok).unwrap_or(false)
}

/// Install the gateway table when the subnets are known and moved. An empty
/// discovery keeps the applied table (a flapping engine must not cut live
/// traffic); returns whether the table is currently correct.
pub async fn ensure_table(subnets: &[String]) -> bool {
    let valid: Vec<String> = subnets
        .iter()
        .filter(|s| super::plane::valid_cidr(s))
        .cloned()
        .collect();
    if valid.is_empty() {
        return table_ok();
    }
    if table_ok() && applied() == valid {
        return true;
    }
    let rules = gateway_ruleset(&valid);
    match super::super::netisolation::nft_run(&["-f", "-"], Some(rules.as_str())).await {
        Ok(()) => {
            if let Ok(mut ok) = TABLE_OK.lock() {
                *ok = true;
            }
            if let Ok(mut applied) = APPLIED_GATEWAY.lock() {
                *applied = valid;
            }
            tracing::info!("sandbox gateway nft table installed");
            true
        }
        Err(e) => {
            if let Ok(mut ok) = TABLE_OK.lock() {
                *ok = false;
            }
            tracing::warn!(error = %e, "sandbox gateway nft table not installed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{authorized, find_client_inode, gateway_ruleset, in_subnets, parse_hex_sockaddr};
    use std::net::{Ipv4Addr, SocketAddrV4};

    #[test]
    fn hex_sockaddr_parses_little_endian_ip_and_hex_port() {
        // 127.0.0.1:8080 and 172.19.0.2:9000 as /proc/net/tcp prints them.
        assert_eq!(
            parse_hex_sockaddr("0100007F:1F90"),
            Some(SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 1), 8080))
        );
        assert_eq!(
            parse_hex_sockaddr("020013AC:2328"),
            Some(SocketAddrV4::new(Ipv4Addr::new(172, 19, 0, 2), 9000))
        );
        assert_eq!(parse_hex_sockaddr("bogus"), None);
        assert_eq!(parse_hex_sockaddr("0100007F"), None);
        assert_eq!(parse_hex_sockaddr("0100007F:ZZZZ"), None);
        assert_eq!(parse_hex_sockaddr(""), None);
    }

    #[test]
    fn client_inode_matches_local_peer_and_remote_dst() {
        // Verbatim /proc/net/tcp shape: the fleet's dial (172.18.0.4:45678 →
        // 172.19.0.2:9000), the gateway's accepted side, a listener, and a
        // stale TIME_WAIT for the same tuple with another inode.
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
           0: 040012AC:B26E 020013AC:2328 0A 00000000:00000000 00:00000000 00000000 10020        0 98765 1 0000000000000000 20 4 1 10 -1\n\
           1: 0100007F:1FAB 040012AC:B26E 0A 00000000:00000000 00:00000000 00000000     0        0 98766 1 0000000000000000 20 4 1 10 -1\n\
           2: 0100007F:1FAB 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000000000000000 20 4 1 10 -1\n\
           3: 040012AC:B26E 020013AC:2328 06 00000000:00000000 00:00000000 00000000 10020        0 22222 1 0000000000000000 20 4 1 10 -1\n";
        let peer = SocketAddrV4::new(Ipv4Addr::new(172, 18, 0, 4), 45678);
        let dst = SocketAddrV4::new(Ipv4Addr::new(172, 19, 0, 2), 9000);
        // The established client socket wins over the TIME_WAIT twin.
        assert_eq!(find_client_inode(text, peer, dst), Some(98765));
        // The gateway's accepted side is not the client (local differs).
        let gateway_local = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8107);
        assert_eq!(find_client_inode(text, gateway_local, dst), None);
        // Unknown tuple: nothing.
        let other = SocketAddrV4::new(Ipv4Addr::new(10, 0, 0, 1), 80);
        assert_eq!(find_client_inode(text, peer, other), None);
        assert_eq!(find_client_inode("", peer, dst), None);
        // Header only: nothing.
        assert_eq!(
            find_client_inode(text.lines().next().unwrap_or_default(), peer, dst),
            None
        );
    }

    #[test]
    fn ownership_decision_needs_the_same_fleet_on_both_sides() {
        assert!(authorized(Some("fleet-a"), Some("fleet-a")));
        assert!(!authorized(Some("fleet-a"), Some("fleet-b")));
        assert!(!authorized(Some("fleet-a"), None));
        assert!(!authorized(None, Some("fleet-a")));
        assert!(!authorized(None, None));
    }

    #[test]
    fn subnet_membership_is_strict() {
        let subnets = vec!["172.19.0.0/16".to_string(), "172.20.5.0/24".to_string()];
        assert!(in_subnets(Ipv4Addr::new(172, 19, 0, 2), &subnets));
        assert!(in_subnets(Ipv4Addr::new(172, 20, 5, 1), &subnets));
        assert!(!in_subnets(Ipv4Addr::new(172, 18, 0, 2), &subnets));
        assert!(!in_subnets(Ipv4Addr::LOCALHOST, &subnets));
        assert!(!in_subnets(Ipv4Addr::new(172, 19, 0, 2), &[]));
        assert!(!in_subnets(
            Ipv4Addr::new(172, 19, 0, 2),
            &["bogus".to_string()]
        ));
    }

    #[test]
    fn gateway_ruleset_redirects_celld_tcp_to_the_gateway() {
        let subnets = vec!["172.19.0.0/16".to_string(), "bogus".to_string()];
        let rules = gateway_ruleset(&subnets);
        assert!(
            rules.starts_with("table inet noite_gateway\ndelete table inet noite_gateway\n"),
            "{rules}"
        );
        assert!(
            rules.contains("type nat hook output priority -100; policy accept;"),
            "{rules}"
        );
        assert!(
            rules.contains("ip daddr { 172.19.0.0/16 } meta l4proto tcp redirect to :8071"),
            "{rules}"
        );
        assert!(
            !rules.contains("bogus"),
            "invalid subnets never render: {rules}"
        );
    }
}
