//! The sandbox gateway: fleet TCP toward celld's bridges is redirected
//! here (nft `nat` output, this container's namespace), and the gateway
//! splices it through the relay only when the connecting fleet owns the
//! destination container.
//!
//! Per connection: `SO_ORIGINAL_DST` recovers the pre-redirect destination
//! (it must lie in the current celld subnets); the client socket's cgroup v2
//! id (netlink `sock_diag` with an `INET_DIAG_BC_CGROUP_COND` filter — the
//! kernel reports it, so no ptrace and no `/proc/<pid>/fd`, and non-dumpable
//! fleets attribute fine) names the live fleet whose cgroup holds the
//! (peer, destination) pair. The pid-fd scan (`/proc/net/tcp` → inode →
//! the pid holding `socket:[inode]`) remains as the fallback for dumpable
//! celld and kernels without the cgroup filter. Unless the engine proxy's
//! registry says that fleet owns the destination IP, the connection is
//! refused. This closes the shared-fleet-uid hole: every tenant shares the
//! uid, so the filter table cannot tell fleets apart, but cgroups (and, for
//! dumpable celld, pids) can. Single tenancy without per-fleet cgroups
//! cannot attribute at all: an otherwise-valid dial to a known fleet's
//! container is then allowed degraded (one trust domain; surfaced in
//! `isolation::self_check`), anything else refused.

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
/// netlink `sock_diag` request shape, hand-rolled (no new crate): one nlmsg
/// (`SOCK_DIAG_BY_FAMILY`) + `inet_diag_req_v2` + a single-op
/// `INET_DIAG_BC_CGROUP_COND` bytecode program, exactly the encoding `ss`
/// emits for one `cgroup = <path>` condition (op `yes` = its length,
/// `no` = length + 4: reaching the end accepts, overshooting rejects).
/// Older kernels without the cgroup condition answer `EINVAL`; the caller
/// treats any transport failure as "no answer" and falls back to the pid-fd
/// scan.
#[cfg(target_os = "linux")]
const NETLINK_SOCK_DIAG: libc::c_int = 4;
#[cfg(target_os = "linux")]
const SOCK_DIAG_BY_FAMILY: u16 = 20;
#[cfg(target_os = "linux")]
const NLM_F_REQUEST: u16 = 1;
#[cfg(target_os = "linux")]
const NLM_F_DUMP: u16 = 0x300;
#[cfg(target_os = "linux")]
const NLMSG_ERROR: u16 = 2;
#[cfg(target_os = "linux")]
const NLMSG_DONE: u16 = 3;
#[cfg(target_os = "linux")]
const DIAG_FAMILY_INET: u8 = 2;
#[cfg(target_os = "linux")]
const DIAG_PROTO_TCP: u8 = 6;
#[cfg(target_os = "linux")]
const INET_DIAG_REQ_BYTECODE: u16 = 1;
#[cfg(target_os = "linux")]
const BC_CGROUP_COND: u8 = 13;
/// `idiag_states` mask: only established sockets can be a live client.
#[cfg(target_os = "linux")]
const TCP_ESTABLISHED_MASK: u32 = 1 << 1;
/// One `recv` is one datagram; 64 KiB holds any single reply.
#[cfg(target_os = "linux")]
const DIAG_RECV_LEN: usize = 65536;

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
/// The cgroup v2 id of a fleet's leaf: the kernfs inode of its directory.
/// `None` when the install has no per-fleet cgroups (single tenancy without
/// the grant) or the leaf is gone.
fn cgroup_id_of(dir: &std::path::Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(dir).ok().map(|m| m.ino())
}

/// The `sock_diag` request for "established TCP sockets in cgroup `id`":
/// nlmsg + `inet_diag_req_v2` (IPv4/TCP, no address filter) + one
/// `INET_DIAG_REQ_BYTECODE` attribute holding a single `BC_CGROUP_COND` op.
/// Pure so the unit test pins it against `ss`'s own encoding.
#[cfg(target_os = "linux")]
fn cgroup_query(cgroup_id: u64) -> Vec<u8> {
    let mut req = Vec::with_capacity(88);
    // nlmsghdr: len, type, flags, seq, pid.
    req.extend_from_slice(&88u32.to_le_bytes());
    req.extend_from_slice(&SOCK_DIAG_BY_FAMILY.to_le_bytes());
    req.extend_from_slice(&(NLM_F_REQUEST | NLM_F_DUMP).to_le_bytes());
    req.extend_from_slice(&0u32.to_le_bytes());
    req.extend_from_slice(&0u32.to_le_bytes());
    // inet_diag_req_v2: family, protocol, ext, pad, states, then the
    // 48-byte sockid left zeroed (wildcard: the bytecode filters).
    req.push(DIAG_FAMILY_INET);
    req.push(DIAG_PROTO_TCP);
    req.push(0);
    req.push(0);
    req.extend_from_slice(&TCP_ESTABLISHED_MASK.to_le_bytes());
    req.extend_from_slice(&[0u8; 48]);
    // The bytecode attribute: len, type, then op (code, yes, no) + the id.
    // `ss`'s single-condition shape: `yes` = op length (12), `no` = 16.
    req.extend_from_slice(&16u16.to_le_bytes());
    req.extend_from_slice(&INET_DIAG_REQ_BYTECODE.to_le_bytes());
    req.push(BC_CGROUP_COND);
    req.push(12);
    req.extend_from_slice(&16u16.to_le_bytes());
    req.extend_from_slice(&cgroup_id.to_le_bytes());
    req
}

/// Parse a `sock_diag` dump into `(local, remote)` IPv4 pairs. `None` when
/// the kernel refused the dump (`NLMSG_ERROR`, e.g. `EINVAL` on a kernel
/// without the cgroup condition): the caller falls back to the pid-fd scan.
/// Truncated tails and non-IPv4 entries are skipped, never fatal.
#[cfg(target_os = "linux")]
fn parse_diag_response(buf: &[u8]) -> Option<Vec<(SocketAddrV4, SocketAddrV4)>> {
    let mut out = Vec::new();
    let mut off = 0;
    while off + 16 <= buf.len() {
        let len = u32::from_le_bytes(buf[off..off + 4].try_into().ok()?) as usize;
        let typ = u16::from_le_bytes(buf[off + 4..off + 6].try_into().ok()?);
        if len < 16 || off + len > buf.len() {
            break;
        }
        if typ == NLMSG_ERROR {
            return None;
        }
        if typ == NLMSG_DONE {
            return Some(out);
        }
        // inet_diag_msg is 72 bytes after the nlmsg header: family, state,
        // timer, retrans, then the 48-byte sockid (sport/dport be16, IPv4
        // addresses first in each 16-byte slot).
        let base = off + 16;
        if typ == SOCK_DIAG_BY_FAMILY && base + 72 <= off + len && buf[base] == DIAG_FAMILY_INET {
            let sport = u16::from_be_bytes(buf[base + 4..base + 6].try_into().ok()?);
            let dport = u16::from_be_bytes(buf[base + 6..base + 8].try_into().ok()?);
            let src = Ipv4Addr::new(buf[base + 8], buf[base + 9], buf[base + 10], buf[base + 11]);
            let dst = Ipv4Addr::new(
                buf[base + 24],
                buf[base + 25],
                buf[base + 26],
                buf[base + 27],
            );
            out.push((SocketAddrV4::new(src, sport), SocketAddrV4::new(dst, dport)));
        }
        off += (len + 3) & !3;
    }
    Some(out)
}

/// Established TCP 4-tuples owned by cgroup `id` right now. Blocking (one
/// netlink round trip); the caller runs it off the async runtime. `None`
/// when the kernel cannot answer — no sock_diag, no cgroup condition — so
/// the caller falls back to the pid-fd scan. Unprivileged: the filter runs
/// in the kernel, no ptrace and no `/proc/<pid>/fd`, so a non-dumpable
/// fleet's sockets attribute fine.
#[cfg(target_os = "linux")]
fn sockets_in_cgroup(cgroup_id: u64) -> Option<Vec<(SocketAddrV4, SocketAddrV4)>> {
    // SAFETY: plain netlink send/recv on a owned fd; the timeout bounds one
    // sick call, the fd always closes.
    unsafe {
        let fd = libc::socket(
            libc::AF_NETLINK,
            libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
            NETLINK_SOCK_DIAG,
        );
        if fd < 0 {
            return None;
        }
        struct Guard(libc::c_int);
        impl Drop for Guard {
            fn drop(&mut self) {
                unsafe { libc::close(self.0) };
            }
        }
        let _guard = Guard(fd);
        let tv = libc::timeval {
            tv_sec: 5,
            tv_usec: 0,
        };
        if libc::setsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            (&tv as *const libc::timeval).cast(),
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        ) != 0
        {
            return None;
        }
        let query = cgroup_query(cgroup_id);
        if libc::send(fd, query.as_ptr().cast(), query.len(), 0) < 0 {
            return None;
        }
        let mut sockets = Vec::new();
        let mut buf = vec![0u8; DIAG_RECV_LEN];
        // The dump is multipart: accumulate batches until a datagram carries
        // `NLMSG_DONE`. A kernel refusal (`None`) aborts the whole query.
        loop {
            let n = libc::recv(fd, buf.as_mut_ptr().cast(), buf.len(), 0);
            if n <= 0 {
                return None;
            }
            let page = &buf[..n as usize];
            let done = has_diag_done(page);
            sockets.extend(parse_diag_response(page)?);
            if done {
                return Some(sockets);
            }
        }
    }
}

/// Whether a raw `sock_diag` reply datagram carries the dump terminator.
#[cfg(target_os = "linux")]
fn has_diag_done(buf: &[u8]) -> bool {
    let mut off = 0;
    while off + 16 <= buf.len() {
        let Ok(len) = buf[off..off + 4].try_into().map(u32::from_le_bytes) else {
            return false;
        };
        let Ok(typ) = buf[off + 4..off + 6].try_into().map(u16::from_le_bytes) else {
            return false;
        };
        if len < 16 || off + len as usize > buf.len() {
            return false;
        }
        if typ == NLMSG_DONE {
            return true;
        }
        off += (len as usize + 3) & !3;
    }
    false
}

/// No `sock_diag` on this platform: every cgroup query falls back.
#[cfg(not(target_os = "linux"))]
fn sockets_in_cgroup(_cgroup_id: u64) -> Option<Vec<(SocketAddrV4, SocketAddrV4)>> {
    None
}

/// The live fleet whose cgroup holds the client socket (`peer` → `dst`),
/// from per-fleet socket sets. Two fleets matching one socket is impossible
/// (cgroups are disjoint) and reads as no match — fail closed. Pure so the
/// matching rule (exact 4-tuple, established only by construction) is pinned
/// without netlink.
fn owner_of_socket(
    peer: SocketAddrV4,
    dst: SocketAddrV4,
    candidates: &[(String, Vec<(SocketAddrV4, SocketAddrV4)>)],
) -> Option<String> {
    let mut hit: Option<&str> = None;
    for (fleet, sockets) in candidates {
        if sockets
            .iter()
            .any(|(local, remote)| *local == peer && *remote == dst)
        {
            if hit.is_some() {
                return None;
            }
            hit = Some(fleet);
        }
    }
    hit.map(str::to_string)
}

/// The live fleet whose cgroup holds the client socket. One `sock_diag`
/// query per fleet cgroup, off the async runtime. `None` when no fleet
/// matches, when no fleet has a cgroup, or when the kernel cannot answer
/// (the caller then tries the pid-fd scan).
async fn fleet_of_cgroup(peer: SocketAddrV4, dst: SocketAddrV4) -> Option<String> {
    crate::host::cgroups::anchor()?;
    let fleets: Vec<(String, u64)> = super::registry::fleet_pids()
        .into_iter()
        .filter_map(|(fleet, _)| {
            crate::host::cgroups::fleet_cgroup_path(&fleet)
                .and_then(|dir| cgroup_id_of(&dir))
                .map(|id| (fleet, id))
        })
        .collect();
    if fleets.is_empty() {
        return None;
    }
    tokio::task::spawn_blocking(move || {
        let mut candidates = Vec::with_capacity(fleets.len());
        for (fleet, id) in &fleets {
            let sockets = sockets_in_cgroup(*id)?;
            candidates.push((fleet.clone(), sockets));
        }
        owner_of_socket(peer, dst, &candidates)
    })
    .await
    .ok()
    .flatten()
}

/// The ownership decision: allow only when the connecting process is a known
/// fleet's and that same fleet owns the destination container's IP — or,
/// when `degraded`, when no client could be attributed but the destination
/// is a known fleet's. The caller sets `degraded` only for single tenancy
/// without per-fleet cgroups (attribution impossible by construction; one
/// trust domain, surfaced in `isolation::self_check`): multi never takes
/// that path. An unowned destination stays refused either way.
pub fn authorized(client_fleet: Option<&str>, owner: Option<&str>, degraded: bool) -> bool {
    match (client_fleet, owner) {
        (Some(c), Some(o)) => c == o,
        (None, Some(_)) => degraded,
        (_, None) => false,
    }
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
/// through the relay. `single` is the tenancy: only single tenancy without
/// per-fleet cgroups may take the degraded path (unknown client, owned
/// destination); multi refuses unknown attribution outright.
async fn handle(mut stream: tokio::net::TcpStream, fleet_ids: Option<(u32, u32)>, single: bool) {
    let peer = stream.peer_addr().ok().and_then(|a| match a {
        std::net::SocketAddr::V4(v4) => Some(v4),
        _ => None,
    });
    let dst = original_dst(&stream);
    let (Some(peer), Some(dst)) = (peer, dst) else {
        return;
    };
    // The installed table's own subnets: exactly what nft redirects here,
    // and kept through a probe that briefly saw no engine.
    if !in_subnets(*dst.ip(), &applied()) {
        return;
    }
    // Authoritative where per-fleet cgroups exist (multi always; single when
    // the grant is present): the client socket's cgroup. Then the
    // dumpable-era pid-fd scan (dead on non-dumpable celld, where it just
    // yields nothing and falls through).
    let fleet = match fleet_of_cgroup(peer, dst).await {
        some @ Some(_) => some,
        None => {
            let tcp = std::fs::read_to_string("/proc/net/tcp").unwrap_or_default();
            match find_client_inode(&tcp, peer, dst) {
                Some(inode) => {
                    fleet_of_inode(inode, super::registry::fleet_pids(), fleet_ids).await
                }
                None => None,
            }
        }
    };
    let owner = super::registry::owner_of_ip(*dst.ip());
    // Degraded only when attribution is impossible by construction: single
    // tenancy and the runner never got its cgroup anchor, so no fleet has a
    // leaf to match. Any cgroups at all keep the cgroup verdict authoritative.
    let degraded = fleet.is_none() && single && crate::host::cgroups::anchor().is_none();
    if !authorized(fleet.as_deref(), owner.as_deref(), degraded) {
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
async fn accept_loop(fleet_ids: Option<(u32, u32)>, single: bool) {
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
                handle(stream, fleet_ids, single).await;
            });
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Spawn the gateway accept loop (idempotent for the boot path: one
/// listener; the loop itself survives bind failures). `fleet_ids` are the
/// fleet user's uid/gid (`None` when fleets run as the runner's own user);
/// `single` is the tenancy, gating the degraded unattributed-allow path.
pub fn spawn(fleet_ids: Option<(u32, u32)>, single: bool) {
    tokio::spawn(accept_loop(fleet_ids, single));
}

/// The gateway nftables ruleset: fleet TCP toward the celld bridges is
/// redirected to the gateway listener. A separate table from the egress
/// policy, installed in both tenancies; the atomic `table` / `delete table`
/// / `table {}` replace is the same shape `netisolation` uses. Only the fleet
/// user's dials are redirected (`None`: fleets run as the runner's own user,
/// dev only, so every dial is): nothing else on this host dials containers.
pub fn gateway_ruleset(subnets: &[String], fleet_uid: Option<u32>) -> String {
    let valid: Vec<&str> = subnets
        .iter()
        .map(String::as_str)
        .filter(|s| super::plane::valid_cidr(s))
        .collect();
    let owner = fleet_uid
        .map(|uid| format!("meta skuid {uid} "))
        .unwrap_or_default();
    format!(
        r#"table inet noite_gateway
delete table inet noite_gateway
table inet noite_gateway {{
  chain output {{
    type nat hook output priority -100; policy accept;
    {}ip daddr {{ {} }} meta l4proto tcp redirect to :{}
  }}
}}"#,
        owner,
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
pub async fn ensure_table(subnets: &[String], fleet_uid: Option<u32>) -> bool {
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
    let rules = gateway_ruleset(&valid, fleet_uid);
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
    use super::{
        authorized, find_client_inode, gateway_ruleset, in_subnets, owner_of_socket,
        parse_hex_sockaddr,
    };
    #[cfg(target_os = "linux")]
    use super::{cgroup_id_of, cgroup_query, has_diag_done, parse_diag_response};
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
        // Strict path (multi, and single with per-fleet cgroups): only the
        // owning fleet's own dial passes.
        assert!(authorized(Some("fleet-a"), Some("fleet-a"), false));
        assert!(!authorized(Some("fleet-a"), Some("fleet-b"), false));
        assert!(!authorized(Some("fleet-a"), None, false));
        assert!(!authorized(None, Some("fleet-a"), false));
        assert!(!authorized(None, None, false));
        // Degraded path (single tenancy without per-fleet cgroups): an
        // unattributed dial to a known fleet's container passes, an unowned
        // destination stays refused either way. An attributed dial keeps the
        // strict rule even when degraded is set.
        assert!(authorized(Some("fleet-a"), Some("fleet-a"), true));
        assert!(!authorized(Some("fleet-a"), Some("fleet-b"), true));
        assert!(authorized(None, Some("fleet-a"), true));
        assert!(!authorized(None, None, true));
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
        let rules = gateway_ruleset(&subnets, Some(10020));
        assert!(
            rules.starts_with("table inet noite_gateway\ndelete table inet noite_gateway\n"),
            "{rules}"
        );
        assert!(
            rules.contains("type nat hook output priority -100; policy accept;"),
            "{rules}"
        );
        assert!(
            rules.contains(
                "meta skuid 10020 ip daddr { 172.19.0.0/16 } meta l4proto tcp redirect to :8071"
            ),
            "{rules}"
        );
        assert!(
            !rules.contains("bogus"),
            "invalid subnets never render: {rules}"
        );
    }

    #[test]
    fn socket_owner_needs_the_exact_four_tuple() {
        let peer = SocketAddrV4::new(Ipv4Addr::new(172, 18, 0, 4), 45678);
        let dst = SocketAddrV4::new(Ipv4Addr::new(172, 19, 0, 2), 9000);
        let other = SocketAddrV4::new(Ipv4Addr::new(172, 19, 0, 3), 9000);
        let dial = (peer, dst);
        let candidates = vec![
            ("fleet-a".to_string(), vec![dial]),
            ("fleet-b".to_string(), vec![]),
        ];
        assert_eq!(
            owner_of_socket(peer, dst, &candidates),
            Some("fleet-a".to_string())
        );
        // Wrong port, wrong address, swapped direction: nobody's socket.
        let wrong_port = SocketAddrV4::new(*peer.ip(), 45679);
        assert_eq!(owner_of_socket(wrong_port, dst, &candidates), None);
        assert_eq!(owner_of_socket(peer, other, &candidates), None);
        assert_eq!(owner_of_socket(dst, peer, &candidates), None);
        assert_eq!(owner_of_socket(peer, dst, &[]), None);
        // Two fleets claiming one socket is impossible (cgroups are
        // disjoint): fail closed rather than pick one.
        let both = vec![
            ("fleet-a".to_string(), vec![dial]),
            ("fleet-b".to_string(), vec![dial]),
        ];
        assert_eq!(owner_of_socket(peer, dst, &both), None);
    }

    #[test]
    fn cgroup_id_is_the_directory_inode() {
        let dir = std::env::temp_dir().join(format!("gateway-cgroup-id-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = cgroup_id_of(&dir);
        let ino = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(&dir).unwrap().ino()
        };
        assert_eq!(id, Some(ino));
        assert_eq!(cgroup_id_of(&dir.join("missing")), None);
        std::fs::remove_dir(&dir).ok();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cgroup_query_matches_ss_single_condition_encoding() {
        // Byte-for-byte the request `ss` sends for one `cgroup = <path>`
        // condition (captured from iproute2 6.17): nlmsg, req_v2, then the
        // 12-byte `BC_CGROUP_COND` op with `yes` = 12, `no` = 16.
        let mut want = Vec::new();
        want.extend_from_slice(&88u32.to_le_bytes());
        want.extend_from_slice(&20u16.to_le_bytes());
        want.extend_from_slice(&0x301u16.to_le_bytes());
        want.extend_from_slice(&0u32.to_le_bytes());
        want.extend_from_slice(&0u32.to_le_bytes());
        want.extend_from_slice(&[2u8, 6, 0, 0]);
        want.extend_from_slice(&2u32.to_le_bytes());
        want.extend_from_slice(&[0u8; 48]);
        want.extend_from_slice(&16u16.to_le_bytes());
        want.extend_from_slice(&1u16.to_le_bytes());
        want.extend_from_slice(&[13u8, 12]);
        want.extend_from_slice(&16u16.to_le_bytes());
        want.extend_from_slice(&14656u64.to_le_bytes());
        assert_eq!(cgroup_query(14656), want);
    }

    #[cfg(target_os = "linux")]
    fn diag_entry(family: u8, sport: u16, dport: u16, src: [u8; 4], dst: [u8; 4]) -> Vec<u8> {
        let mut entry = Vec::new();
        entry.extend_from_slice(&88u32.to_le_bytes());
        entry.extend_from_slice(&20u16.to_le_bytes());
        entry.extend_from_slice(&0u16.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.push(family);
        entry.extend_from_slice(&[1, 0, 0]);
        entry.extend_from_slice(&sport.to_be_bytes());
        entry.extend_from_slice(&dport.to_be_bytes());
        entry.extend_from_slice(&src);
        entry.extend_from_slice(&[0u8; 12]);
        entry.extend_from_slice(&dst);
        entry.extend_from_slice(&[0u8; 12]);
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&[0u8; 8]);
        entry.extend_from_slice(
            &[0u32; 5]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>(),
        );
        entry
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn diag_response_parses_established_pairs() {
        let mut dump = diag_entry(2, 45678, 9000, [172, 18, 0, 4], [172, 19, 0, 2]);
        // A non-IPv4 entry is skipped, never fatal.
        dump.extend(diag_entry(
            10,
            45678,
            9000,
            [172, 18, 0, 4],
            [172, 19, 0, 2],
        ));
        dump.extend_from_slice(&16u32.to_le_bytes());
        dump.extend_from_slice(&3u16.to_le_bytes());
        dump.extend_from_slice(&[0u8; 10]);
        let peer = SocketAddrV4::new(Ipv4Addr::new(172, 18, 0, 4), 45678);
        let dst = SocketAddrV4::new(Ipv4Addr::new(172, 19, 0, 2), 9000);
        assert_eq!(parse_diag_response(&dump), Some(vec![(peer, dst)]));
        assert!(has_diag_done(&dump));
        // A kernel refusal reads as no answer, not an empty set.
        let mut error = Vec::new();
        error.extend_from_slice(&20u32.to_le_bytes());
        error.extend_from_slice(&2u16.to_le_bytes());
        error.extend_from_slice(&[0u8; 12]);
        error.extend_from_slice(&(-22i32).to_le_bytes());
        assert_eq!(parse_diag_response(&error), None);
        assert!(!has_diag_done(&error));
        // Garbage never panics.
        assert_eq!(parse_diag_response(&[]), Some(vec![]));
        assert_eq!(parse_diag_response(&[0u8; 3]), Some(vec![]));
        assert_eq!(parse_diag_response(&dump[..20]), Some(vec![]));
    }

    #[cfg(target_os = "linux")]
    fn own_cgroup_id() -> Option<u64> {
        // This process's cgroup v2 id: the `0::/…` unified-hierarchy line of
        // /proc/self/cgroup, resolved under the cgroupfs mount. `None`
        // without v2 (the caller skips the live test there).
        let text = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        let path = text.lines().find_map(|line| line.strip_prefix("0::"))?;
        cgroup_id_of(&std::path::Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/')))
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cgroup_attribution_finds_a_nondumpable_dialer() {
        use std::time::Duration;

        // The celld .10 regression in miniature: the dialer is non-dumpable
        // (`prctl(PR_SET_DUMPABLE, 0)`, what .9's patch 0053 does to every
        // serving celld), so the pid-fd scan cannot see it — only the
        // kernel-reported cgroup id attributes it. Needs cgroup v2 and
        // sock_diag (CI and every supported install); anything else skips.
        let Some(cgroup) = own_cgroup_id() else {
            eprintln!("SKIP: no cgroup v2 hierarchy for this process");
            return;
        };
        // The flag is process-wide: take it for the dial window only, and
        // always give it back.
        struct Dumpable;
        impl Drop for Dumpable {
            fn drop(&mut self) {
                unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 1, 0, 0, 0) };
            }
        }
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) },
            0,
            "prctl(PR_SET_DUMPABLE, 0) must work to simulate non-dumpable celld"
        );
        let _dumpable = Dumpable;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = listener.local_addr().unwrap();
        // The dialer thread holds its socket open until the parent unparks
        // it; a failed dial is sent back and fails loudly, never hangs.
        let (send, recv) = std::sync::mpsc::channel::<std::io::Result<std::net::TcpStream>>();
        let dialer = std::thread::spawn(move || {
            let stream = std::net::TcpStream::connect_timeout(&server, Duration::from_secs(10));
            let _ =
                send.send(stream.map_err(|e| {
                    std::io::Error::new(e.kind(), format!("dialer connect failed: {e}"))
                }));
            std::thread::park();
        });
        let client = recv.recv().unwrap().unwrap();
        let (accepted, peer) = listener.accept().unwrap();
        assert_eq!(peer.ip(), std::net::IpAddr::V4(Ipv4Addr::LOCALHOST));
        let peer = match peer {
            std::net::SocketAddr::V4(v4) => v4,
            _ => unreachable!(),
        };
        let dst = match server {
            std::net::SocketAddr::V4(v4) => v4,
            _ => unreachable!(),
        };
        let client_local = match client.local_addr().unwrap() {
            std::net::SocketAddr::V4(v4) => v4,
            _ => unreachable!(),
        };
        assert_eq!(client_local.port(), peer.port());
        // The kernel must report the dialer's socket in our own cgroup.
        let sockets =
            super::sockets_in_cgroup(cgroup).expect("sock_diag must answer on a cgroup v2 kernel");
        let present = sockets
            .iter()
            .any(|(local, remote)| *local == peer && *remote == dst);
        assert!(
            present,
            "dialer socket {peer} → {dst} missing from its cgroup dump"
        );
        // …and the matching rule names the right fleet for it.
        let candidates = vec![
            ("fleet-a".to_string(), sockets),
            ("fleet-b".to_string(), Vec::new()),
        ];
        assert_eq!(
            super::owner_of_socket(peer, dst, &candidates),
            Some("fleet-a".to_string())
        );
        drop(accepted);
        dialer.thread().unpark();
        dialer.join().unwrap();
    }
}
