//! Per-fleet engine sockets: fleets never see the host engine socket.
//!
//! Every tenant fleet used to join the host socket's group, so any code
//! execution inside a fleet process was root on the host (`POST
//! /containers/create` with `Privileged` or `Binds: ["/:/host"]`). Now each
//! fleet gets `DOCKER_HOST=unix://<its own socket>` served here, and the
//! proxy forwards to the real engine only the calls celld 0.6.3 makes,
//! validated ([`validate`]): app creates in the locked-down shape, the fence
//! installer verbatim, per-container calls on the fleet's own containers,
//! remembered exec ids, celld's two bridges — everything else is refused.
//!
//! Two checks bind a socket to its fleet: the socket file is owned by the
//! fleet user at 0600, and every request's `SO_PEERCRED` pid must be the
//! fleet's registered celld pid (uids alone don't separate fleets: they
//! share one install-wide fleet user).

pub mod validate;

use std::collections::HashMap;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST, UPGRADE};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::net::{UnixListener, UnixStream};

use super::registry;
use super::{ENGINE_SOCKET_DIR, FLEET_LABEL, INSTALL_LABEL};
use validate::{ContainerOp, Route};

/// The engine socket celld dials when the operator names none (compose
/// mounts the host daemon here).
const ENGINE_SOCKET_DEFAULT: &str = "/var/run/docker.sock";

/// Cap on any request body the proxy buffers (1 MiB): celld's bodies are
/// small JSON documents, and a tar must never be buffered here.
const MAX_BODY: usize = 1024 * 1024;

/// Live proxy servers and exec ownership. A leaf lock: handlers also touch
/// [`registry`], which never calls back here.
#[derive(Default)]
struct State {
    /// Fleet key → its accept loop, aborted by [`close_fleet`].
    servers: HashMap<String, tokio::task::JoinHandle<()>>,
    /// Engine exec id → owning fleet key.
    execs: HashMap<String, String>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard: MutexGuard<'static, Option<State>> = STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(guard.get_or_insert_with(State::default))
}

/// What the proxy answers with: small built bodies and streamed upstream
/// bodies behind one type.
type ProxyBody = BoxBody<Bytes, hyper::Error>;

fn full(bytes: Bytes) -> ProxyBody {
    Full::new(bytes).map_err(|never| match never {}).boxed()
}

/// A Docker-shaped refusal: celld surfaces `message`, so the reason rides
/// there after the `noite: ` mark. The connection closes with it: refusals
/// don't drain the request body (a refused tar is never read), so the
/// connection cannot serve a further request.
fn refuse(reason: &str) -> Response<ProxyBody> {
    let body = serde_json::json!({"message": format!("noite: {reason}")}).to_string();
    Response::builder()
        .status(StatusCode::FORBIDDEN)
        .header(CONTENT_TYPE, "application/json")
        .header(CONNECTION, "close")
        .body(full(Bytes::from(body)))
        .expect("refusal response builds")
}

/// A Docker-shaped 404 for a container the daemon has no record of.
fn not_found(id: &str) -> Response<ProxyBody> {
    let body = serde_json::json!({"message": format!("No such container: {id}")}).to_string();
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(CONTENT_TYPE, "application/json")
        .header(CONNECTION, "close")
        .body(full(Bytes::from(body)))
        .expect("404 response builds")
}

/// Pass an upstream response through: its status, its content type, its
/// body streamed (logs and waits are long polls, not documents).
fn forward_response(response: Response<Incoming>) -> Response<ProxyBody> {
    let status = response.status();
    let mut out = Response::builder().status(status);
    if let Some(content_type) = response.headers().get(CONTENT_TYPE).cloned() {
        out = out.header(CONTENT_TYPE, content_type);
    }
    out.body(response.into_body().boxed())
        .expect("forwarded response builds")
}

/// Answer with a body the proxy already collected (a create/exec answer the
/// proxy read an id out of).
fn forward_bytes(status: StatusCode, body: Bytes) -> Response<ProxyBody> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "application/json")
        .body(full(body))
        .expect("forwarded response builds")
}

/// The fleet's socket path. The `.sock` suffix keeps even `.`/`..`-shaped
/// keys a plain filename inside the dir, and `/` never survives [`sanitize`].
pub fn socket_path(key: &str) -> PathBuf {
    Path::new(ENGINE_SOCKET_DIR).join(format!("{}.sock", sanitize(key)))
}

/// Fleet keys are `slug[.label]`, but the socket name must survive any
/// caller: everything outside filenames becomes `_`.
fn sanitize(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// The operator's engine socket: `DOCKER_HOST` when it names a `unix://`
/// socket (mirroring celld's own discovery), else the default path. `None`
/// when there is no engine to proxy to — or when the path is not a socket
/// (compose materializes a directory when the host socket is absent, and a
/// fleet must never be served that).
pub fn upstream_socket() -> Option<PathBuf> {
    upstream_socket_path(std::env::var("DOCKER_HOST").ok().as_deref())
}

fn upstream_socket_path(docker_host: Option<&str>) -> Option<PathBuf> {
    let path = match docker_host {
        Some(host) => host.strip_prefix("unix://")?,
        None => ENGINE_SOCKET_DEFAULT,
    };
    if path.is_empty() {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    if !meta.file_type().is_socket() {
        return None;
    }
    Some(PathBuf::from(path))
}

/// Own `path` by `uid:gid`.
fn chown(path: &Path, uid: u32, gid: u32) -> anyhow::Result<()> {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())?;
    // SAFETY: chown takes a NUL-terminated path and two ids, nothing else.
    let ret = unsafe { libc::chown(path.as_ptr(), uid as libc::uid_t, gid as libc::gid_t) };
    if ret == 0 {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "chown {} to {uid}:{gid}: {}",
            path.to_string_lossy(),
            std::io::Error::last_os_error()
        ))
    }
}

/// Serve one fleet its engine socket, root-owned 0666 in a root-owned 0711
/// dir, and answer it on an accept-loop task. Every fleet shares one uid, so
/// file modes cannot tell fleets apart anyway (the per-request peer pid
/// does); a root-owned socket keeps any fleet from `chmod`-ing another's
/// shut. Idempotent
/// while the fleet's loop lives. The upstream engine is resolved once per
/// serve (the engine socket is mount-static; a fleet respawn re-resolves).
/// Failing here must never fail the spawn: the supervisor logs and runs the
/// fleet without an engine instead.
pub fn serve_fleet(key: &str) -> anyhow::Result<PathBuf> {
    let upstream = upstream_socket();
    serve_inner(key, Path::new(ENGINE_SOCKET_DIR), upstream)
}

fn serve_inner(key: &str, dir: &Path, upstream: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    let socket = dir.join(format!("{}.sock", sanitize(key)));
    if socket.as_os_str().as_encoded_bytes().len() > 107 {
        anyhow::bail!("engine socket path too long for {}", socket.display());
    }
    if with(|s| s.servers.get(key).is_some_and(|h| !h.is_finished())) {
        return Ok(socket);
    }
    std::fs::create_dir_all(dir)?;
    // The dir lists every fleet's socket name: traversable, not readable,
    // owned by root when this process can own it (a non-root runner in
    // dev/tests just tightens the mode on its own dir).
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o711))?;
    // SAFETY: geteuid only reads.
    let root = unsafe { libc::geteuid() } == 0;
    if root {
        chown(dir, 0, 0)?;
    }
    // A previous run's socket (an unclean shutdown left the file behind).
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    if root {
        chown(&socket, 0, 0)?;
    }
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o666))?;
    let fleet = key.to_string();
    let task = tokio::spawn(accept_loop(listener, fleet, upstream));
    with(|s| {
        s.servers.insert(key.to_string(), task);
    });
    Ok(socket)
}

/// Stop a fleet's proxy: its accept loop, its socket, its containers on the
/// engine (labelled `noite.fleet=<key>`), and every record of them. Total:
/// safe for a fleet that never served, or with no engine behind.
pub async fn close_fleet(key: &str) {
    if let Some(handle) = with(|s| s.servers.remove(key)) {
        handle.abort();
    }
    forget_fleet_execs(key);
    let _ = tokio::fs::remove_file(socket_path(key)).await;
    if let Some(upstream) = upstream_socket() {
        let owner = super::owner(key);
        for id in list_labelled(&upstream, &format!("{FLEET_LABEL}={owner}")).await {
            delete_container(&upstream, &id).await;
        }
    }
    registry::forget_fleet_containers(key);
}

/// Remove every container carrying the fleet label, whatever its value: at
/// boot no fleet runs yet, so every labelled container is a previous run's.
/// The parent calls this from `main.rs` before fleets start. An unreachable
/// engine answers nothing to remove.
pub async fn sweep_boot() -> anyhow::Result<()> {
    let Some(upstream) = upstream_socket() else {
        return Ok(());
    };
    let install = format!("{INSTALL_LABEL}={}", super::install());
    for id in list_labelled(&upstream, &install).await {
        delete_container(&upstream, &id).await;
    }
    Ok(())
}

/// The pid on the other end of a fleet connection, via `SO_PEERCRED`.
/// `None` fails closed (the request is refused).
fn peer_pid(stream: &UnixStream) -> Option<u32> {
    // SAFETY: getsockopt with SO_PEERCRED writes one ucred for a socket fd.
    unsafe {
        let mut cred: libc::ucred = std::mem::zeroed();
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let ret = libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        );
        (ret == 0).then_some(cred.pid as u32)
    }
}

/// Concurrent connections per fleet socket: celld holds a handful (one per
/// call, plus exec streams and long-polled waits); the cap keeps a flood from
/// exhausting the runner's tasks and fds.
const MAX_CONNS: usize = 256;

async fn accept_loop(listener: UnixListener, fleet: String, upstream: Option<PathBuf>) {
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONNS));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // EMFILE and friends persist: back off instead of spinning.
                tracing::warn!(fleet = %fleet, error = %e, "engine proxy accept failed");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
        };
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let peer = peer_pid(&stream);
        let fleet = fleet.clone();
        let upstream = upstream.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = hyper::service::service_fn(|req: Request<Incoming>| {
                handle_request(req, fleet.clone(), upstream.clone(), peer)
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

async fn handle_request(
    req: Request<Incoming>,
    fleet: String,
    upstream: Option<PathBuf>,
    peer: Option<u32>,
) -> Result<Response<ProxyBody>, std::convert::Infallible> {
    // The socket is the fleet user's, but the fleet user is install-wide:
    // only the fleet's own celld pid may ask. Looked up per request so a
    // pid re-registration lands on live connections too.
    if peer.is_none() || registry::pid_of_fleet(&fleet) != peer {
        return Ok(refuse("unknown fleet process"));
    }
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(str::to_string);
    let stripped = validate::strip_api_version(&path).to_string();
    let route = validate::classify(method.as_str(), &stripped);
    Ok(match route {
        // Refusals need no engine.
        Route::Refused(reason) => refuse(reason),
        // The deploy, run by the runner against the real engine, already
        // pulled and tagged every image on this engine; a fleet-supplied
        // tar could re-tag any image on the host, so fleets never load.
        Route::ImageLoad => refuse("image missing from the engine; redeploy the app"),
        _ => {
            let Some(upstream) = upstream else {
                return Ok(refuse("engine unreachable"));
            };
            forward(req, &fleet, query.as_deref(), route, &upstream).await
        }
    })
}

async fn forward(
    req: Request<Incoming>,
    fleet: &str,
    query: Option<&str>,
    route: Route<'_>,
    upstream: &Path,
) -> Response<ProxyBody> {
    match route {
        Route::List => {
            let query = validate::rewrite_list_query(query, &super::owner(fleet));
            forward_simple(
                upstream,
                "GET",
                &format!("/containers/json?{query}"),
                Bytes::new(),
            )
            .await
        }
        Route::Create => create(req, fleet, query, upstream).await,
        Route::Container { id, op } => container(req, fleet, id, op, query, upstream).await,
        Route::Remove { id } => remove(fleet, id, query, upstream).await,
        Route::ExecStart { id } => exec_start(req, fleet, id, upstream).await,
        Route::ExecInspect { id } => {
            if exec_owner(id).as_deref() != Some(fleet) {
                return refuse("unknown exec");
            }
            forward_simple(upstream, "GET", &format!("/exec/{id}/json"), Bytes::new()).await
        }
        Route::ImageInspect { name } => {
            if !validate::valid_image_name(name) {
                return refuse("unknown image");
            }
            forward_simple(
                upstream,
                "GET",
                &format!("/images/{name}/json"),
                Bytes::new(),
            )
            .await
        }
        // Handled before the engine check; unreachable here.
        Route::ImageLoad | Route::Refused(_) => refuse("no such engine call"),
        Route::NetworkInspect { name } => {
            if !validate::valid_network_name(name) {
                return refuse("unknown network");
            }
            // The daemon lists every container on the bridge — every app's,
            // with names and addresses. celld only reads the options, so the
            // list never leaves the proxy.
            let response = match engine_call(
                upstream,
                "GET",
                &format!("/networks/{name}"),
                Bytes::new(),
                false,
            )
            .await
            {
                Ok(response) => response,
                Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
            };
            let status = response.status();
            let Ok(body) = response.into_body().collect().await else {
                return refuse("engine answer unreadable");
            };
            forward_bytes(status, validate::without_network_members(&body.to_bytes()))
        }
        Route::NetworkCreate => {
            let raw = match read_body(req.into_body()).await {
                Ok(raw) => raw,
                Err(reason) => return refuse(&reason),
            };
            let body: Value = match serde_json::from_slice(&raw) {
                Ok(body) => body,
                Err(_) => return refuse("network body must be JSON"),
            };
            if let Err(reason) = validate::validate_network_create(&body) {
                return refuse(&reason);
            }
            forward_simple(
                upstream,
                "POST",
                "/networks/create",
                Bytes::from(body.to_string()),
            )
            .await
        }
    }
}

/// Drain one request body, refusing past [`MAX_BODY`].
async fn read_body(body: Incoming) -> Result<Bytes, String> {
    let mut body = body;
    let mut out = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| "unreadable request body".to_string())?;
        let Some(data) = frame.data_ref() else {
            continue;
        };
        if out.len() + data.len() > MAX_BODY {
            return Err("request body too large".to_string());
        }
        out.extend_from_slice(data);
    }
    Ok(Bytes::from(out))
}

/// One upstream call over a fresh unix connection: small request, whole or
/// hijacked response. Enough for every forward (celld itself dials one
/// connection per call).
async fn engine_call(
    upstream: &Path,
    method: &str,
    path: &str,
    body: Bytes,
    upgrade: bool,
) -> anyhow::Result<Response<Incoming>> {
    let stream = UnixStream::connect(upstream).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
    // `with_upgrades`: a plain drive would drop an exec stream's upgrade
    // instead of fulfilling it (celld's `drive` does the same).
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(HOST, "docker")
        .header(CONTENT_TYPE, "application/json");
    if upgrade {
        builder = builder.header(CONNECTION, "Upgrade").header(UPGRADE, "tcp");
    }
    Ok(sender.send_request(builder.body(Full::new(body))?).await?)
}

/// One plain forward: upstream status and body, streamed through.
async fn forward_simple(
    upstream: &Path,
    method: &str,
    path: &str,
    body: Bytes,
) -> Response<ProxyBody> {
    match engine_call(upstream, method, path, body, false).await {
        Ok(response) => forward_response(response),
        Err(e) => refuse(&format!("engine unreachable: {e:#}")),
    }
}

/// Rebuild an upstream path with the caller's query untouched.
fn with_query(path: &str, query: Option<&str>) -> String {
    match query {
        Some(query) if !query.is_empty() => format!("{path}?{query}"),
        _ => path.to_string(),
    }
}

/// An authoritative ownership read: the upstream inspect of one container.
/// `Ok(Some)` inspected, `Ok(None)` when the daemon has no such container,
/// `Err` when the engine itself is unreachable.
async fn inspect(upstream: &Path, id: &str) -> anyhow::Result<Option<Value>> {
    let response = engine_call(
        upstream,
        "GET",
        &format!("/containers/{id}/json"),
        Bytes::new(),
        false,
    )
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        anyhow::bail!("inspect failed with [{}]", response.status().as_u16());
    }
    Ok(Some(serde_json::from_slice(
        &response.into_body().collect().await?.to_bytes(),
    )?))
}

/// Whether the fleet owns this container. Missing containers answer like
/// the daemon would (404, which celld handles), foreign ones are refused.
/// The upstream inspect is authoritative; the registry only caches.
async fn owned(upstream: &Path, fleet: &str, id: &str) -> Result<Value, Box<Response<ProxyBody>>> {
    match inspect(upstream, id).await {
        Ok(Some(info)) => {
            if validate::inspect_fleet_label(&info) == Some(super::owner(fleet)) {
                Ok(info)
            } else {
                Err(Box::new(refuse("foreign container")))
            }
        }
        Ok(None) => Err(Box::new(not_found(id))),
        Err(e) => Err(Box::new(refuse(&format!("engine unreachable: {e:#}")))),
    }
}

async fn create(
    req: Request<Incoming>,
    fleet: &str,
    query: Option<&str>,
    upstream: &Path,
) -> Response<ProxyBody> {
    let name = match validate::create_name(query) {
        Ok(name) => name,
        Err(reason) => return refuse(&reason),
    };
    let raw = match read_body(req.into_body()).await {
        Ok(raw) => raw,
        Err(reason) => return refuse(&reason),
    };
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(_) => return refuse("create body must be JSON"),
    };
    // A name means an app container; the nameless create is the fence
    // installer, and only the installer's verbatim body passes there.
    let (checked, record) = match name {
        Some(name) => match validate::validate_app_create(&body, &super::owner(fleet)) {
            Ok(checked) => (checked, Some(name)),
            Err(reason) => return refuse(&reason),
        },
        None => {
            // The fence runs from the runner's own image (see
            // `validate_fence_create`); unknown until the boot pass inspected
            // this container, and refused until then.
            let Some(image) = super::plane::own_image() else {
                return refuse("fence image not known yet; retry");
            };
            match validate::validate_fence_create(&body, &super::owner(fleet), &image) {
                Ok(checked) => (checked, None),
                Err(reason) => return refuse(&reason),
            }
        }
    };
    let path = match &record {
        Some(name) => format!("/containers/create?name={name}"),
        None => "/containers/create".to_string(),
    };
    let response = match engine_call(
        upstream,
        "POST",
        &path,
        Bytes::from(checked.to_string()),
        false,
    )
    .await
    {
        Ok(response) => response,
        Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
    };
    if !response.status().is_success() {
        return forward_response(response);
    }
    let status = response.status();
    let body = match response.into_body().collect().await {
        Ok(body) => body.to_bytes(),
        Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
    };
    let id = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|created| {
            created
                .get("Id")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    match (&record, id) {
        (Some(name), _) => registry::record_container(fleet, name, None),
        (None, Some(id)) => registry::record_container(fleet, &id, None),
        (None, None) => {}
    }
    forward_bytes(status, body)
}

fn op_name(op: ContainerOp) -> &'static str {
    match op {
        ContainerOp::Start => "start",
        ContainerOp::Wait => "wait",
        ContainerOp::Kill => "kill",
        ContainerOp::Inspect => "json",
        ContainerOp::Logs => "logs",
        ContainerOp::Exec => "exec",
    }
}

async fn container(
    req: Request<Incoming>,
    fleet: &str,
    id: &str,
    op: ContainerOp,
    query: Option<&str>,
    upstream: &Path,
) -> Response<ProxyBody> {
    let info = match owned(upstream, fleet, id).await {
        Ok(info) => info,
        Err(response) => return *response,
    };
    // The inspect just proved this container the fleet's: its aliases join
    // the registry too, so a later release by id finds them.
    let (iid, iname) = validate::inspect_identity(&info);
    for alias in [&iid, &iname].into_iter().flatten() {
        if alias != id {
            registry::record_container(fleet, alias, None);
        }
    }
    let path = with_query(&format!("/containers/{id}/{}", op_name(op)), query);
    match op {
        ContainerOp::Start | ContainerOp::Wait | ContainerOp::Kill => {
            let raw = match read_body(req.into_body()).await {
                Ok(raw) => raw,
                Err(reason) => return refuse(&reason),
            };
            if !raw.is_empty() {
                return refuse("takes no body");
            }
            forward_simple(upstream, "POST", &path, Bytes::new()).await
        }
        ContainerOp::Logs => forward_simple(upstream, "GET", &path, Bytes::new()).await,
        ContainerOp::Inspect => {
            let response = match engine_call(upstream, "GET", &path, Bytes::new(), false).await {
                Ok(response) => response,
                Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
            };
            if !response.status().is_success() {
                return forward_response(response);
            }
            let status = response.status();
            let body = match response.into_body().collect().await {
                Ok(body) => body.to_bytes(),
                Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
            };
            // The gateway routes fleet dials by container address: every
            // address this inspect reports now maps to the fleet.
            if let Ok(info) = serde_json::from_slice::<Value>(&body) {
                for ip in validate::inspect_ips(&info) {
                    registry::record_container(fleet, id, Some(ip));
                }
            }
            forward_bytes(status, body)
        }
        ContainerOp::Exec => {
            let raw = match read_body(req.into_body()).await {
                Ok(raw) => raw,
                Err(reason) => return refuse(&reason),
            };
            let body: Value = match serde_json::from_slice(&raw) {
                Ok(body) => body,
                Err(_) => return refuse("exec body must be JSON"),
            };
            if let Err(reason) = validate::validate_exec_create(&body) {
                return refuse(&reason);
            }
            let response = match engine_call(
                upstream,
                "POST",
                &path,
                Bytes::from(body.to_string()),
                false,
            )
            .await
            {
                Ok(response) => response,
                Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
            };
            if !response.status().is_success() {
                return forward_response(response);
            }
            let status = response.status();
            let body = match response.into_body().collect().await {
                Ok(body) => body.to_bytes(),
                Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
            };
            // Only an exec id this fleet created here may start or inspect
            // below: ids are unguessable, but guessing must fail closed.
            if let Some(exec) = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|created| {
                    created
                        .get("Id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            {
                remember_exec(fleet, &exec);
            }
            forward_bytes(status, body)
        }
    }
}

async fn remove(
    fleet: &str,
    id: &str,
    query: Option<&str>,
    upstream: &Path,
) -> Response<ProxyBody> {
    let info = match owned(upstream, fleet, id).await {
        Ok(info) => info,
        Err(response) => return *response,
    };
    let response = match engine_call(
        upstream,
        "DELETE",
        &with_query(&format!("/containers/{id}"), query),
        Bytes::new(),
        false,
    )
    .await
    {
        Ok(response) => response,
        Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
    };
    if response.status().is_success() {
        let (iid, iname) = validate::inspect_identity(&info);
        registry::forget_container(id);
        for alias in [iid, iname].into_iter().flatten() {
            if alias != id {
                registry::forget_container(&alias);
            }
        }
    }
    forward_response(response)
}

async fn exec_start(
    req: Request<Incoming>,
    fleet: &str,
    id: &str,
    upstream: &Path,
) -> Response<ProxyBody> {
    if exec_owner(id).as_deref() != Some(fleet) {
        return refuse("unknown exec");
    }
    let hijacked = req
        .headers()
        .get(UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"tcp"));
    let mut req = req;
    // The downstream upgrade latch is taken before the body is read:
    // answering 101 below resolves it into celld's stream.
    let downstream = hijacked.then(|| hyper::upgrade::on(&mut req));
    let raw = match read_body(req.into_body()).await {
        Ok(raw) => raw,
        Err(reason) => return refuse(&reason),
    };
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(body) => body,
        Err(_) => return refuse("exec start body must be JSON"),
    };
    if let Err(reason) = validate::validate_exec_start(&body) {
        return refuse(&reason);
    }
    let mut response = match engine_call(
        upstream,
        "POST",
        &format!("/exec/{id}/start"),
        Bytes::from(body.to_string()),
        hijacked,
    )
    .await
    {
        Ok(response) => response,
        Err(e) => return refuse(&format!("engine unreachable: {e:#}")),
    };
    if !hijacked || response.status() != StatusCode::SWITCHING_PROTOCOLS {
        return forward_response(response);
    }
    // 101: from here the connection is the process's stdio. Answer celld
    // first, then splice the two upgraded streams behind the response.
    let upstream_io = match hyper::upgrade::on(&mut response).await {
        Ok(io) => io,
        Err(_) => return refuse("exec upgrade failed"),
    };
    let Some(downstream) = downstream else {
        return forward_response(response);
    };
    tokio::spawn(async move {
        let Ok(downstream) = downstream.await else {
            return;
        };
        let mut up = TokioIo::new(upstream_io);
        let mut down = TokioIo::new(downstream);
        let _ = tokio::io::copy_bidirectional(&mut up, &mut down).await;
    });
    let mut out = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    for name in [UPGRADE, CONNECTION] {
        if let Some(value) = response.headers().get(&name).cloned() {
            out = out.header(name, value);
        }
    }
    out.body(full(Bytes::new())).expect("101 response builds")
}

/// Remember an exec id for its fleet, from the daemon's answer to a
/// validated exec create.
fn remember_exec(fleet: &str, id: &str) {
    with(|s| {
        s.execs.insert(id.to_string(), fleet.to_string());
    });
}

/// The fleet that created an exec id here.
fn exec_owner(id: &str) -> Option<String> {
    with(|s| s.execs.get(id).cloned())
}

/// Drop every exec id of a fleet whose proxy closes.
fn forget_fleet_execs(fleet: &str) {
    with(|s| {
        s.execs.retain(|_, owner| owner != fleet);
    });
}

/// Ids of every container (running or stopped) carrying one label filter.
async fn list_labelled(upstream: &Path, label: &str) -> Vec<String> {
    let filters = validate::percent_encode(&serde_json::json!({"label": [label]}).to_string());
    let response = match engine_call(
        upstream,
        "GET",
        &format!("/containers/json?all=true&filters={filters}"),
        Bytes::new(),
        false,
    )
    .await
    {
        Ok(response) => response,
        Err(e) => {
            tracing::warn!(error = %e, "engine list for cleanup failed");
            return Vec::new();
        }
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let body = match response.into_body().collect().await {
        Ok(body) => body.to_bytes(),
        Err(_) => return Vec::new(),
    };
    serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|list| list.as_array().cloned())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("Id").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

async fn delete_container(upstream: &Path, id: &str) {
    match engine_call(
        upstream,
        "DELETE",
        &format!("/containers/{id}?force=true"),
        Bytes::new(),
        false,
    )
    .await
    {
        Ok(response) if response.status().is_success() => {}
        Ok(response) => {
            tracing::debug!(id, status = %response.status(), "fleet container delete refused")
        }
        Err(e) => tracing::warn!(id, error = %e, "fleet container delete failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A unique short temp dir: unix socket paths cap at 107 bytes, so no
    /// UUIDs here — pid plus a counter is unique enough per test binary.
    fn test_dir(name: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!("ne-{name}-{}-{n}", std::process::id()))
    }

    /// A unique short fleet key for the same 107-byte reason.
    fn test_key(name: &str) -> String {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("{name}-{}-{n}", std::process::id() % 100000)
    }

    /// One plain call against a fleet socket, like celld's own client: one
    /// connection, whole body.
    async fn fleet_call(
        socket: &Path,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Bytes) {
        let stream = UnixStream::connect(socket)
            .await
            .expect("fleet socket connects");
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .expect("handshake");
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let body = body.map(|v| Bytes::from(v.to_string())).unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, "docker")
            .header(CONTENT_TYPE, "application/json")
            .body(Full::new(body))
            .unwrap();
        let response = sender.send_request(request).await.expect("response");
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        (status, body)
    }

    fn message(body: &Bytes) -> String {
        serde_json::from_slice::<Value>(body)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    }

    #[test]
    fn upstream_needs_a_unix_socket() {
        let dir = test_dir("upstream");
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("engine.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let sock = sock.to_string_lossy().into_owned();
        let plain = dir.join("regular");
        std::fs::write(&plain, b"").unwrap();
        let plain = plain.to_string_lossy().into_owned();
        let sub = dir.join("subdir");
        std::fs::create_dir(&sub).unwrap();
        let sub = sub.to_string_lossy().into_owned();
        // A unix:// DOCKER_HOST resolves to the socket; a TCP host, a
        // missing path, a regular file or a directory (compose materializes
        // one when the host socket is absent) resolves to no engine.
        assert_eq!(
            upstream_socket_path(Some(&format!("unix://{sock}"))),
            Some(PathBuf::from(&sock)),
        );
        assert_eq!(upstream_socket_path(Some("tcp://127.0.0.1:2375")), None);
        assert_eq!(upstream_socket_path(Some("unix:///nonexistent-sock")), None);
        assert_eq!(upstream_socket_path(Some(&format!("unix://{plain}"))), None);
        assert_eq!(upstream_socket_path(Some(&format!("unix://{sub}"))), None);
        assert_eq!(upstream_socket_path(Some("unix://")), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn socket_names_survive_any_key() {
        assert_eq!(sanitize("shop"), "shop");
        assert_eq!(sanitize("shop.feature"), "shop.feature");
        assert_eq!(sanitize("a/b"), "a_b");
        assert_eq!(sanitize(".."), "..");
        assert_eq!(sanitize(""), "");
        // Even hostile keys stay one filename inside the dir.
        for key in ["a/b", "..", "../x", "a\nb"] {
            let name = format!("{}.sock", sanitize(key));
            assert!(!name.contains('/'), "{name}");
            assert_eq!(Path::new(&name).components().count(), 1);
        }
    }

    #[test]
    fn exec_ids_belong_to_one_fleet_until_forgotten() {
        remember_exec("eng-a", "exec-1");
        remember_exec("eng-b", "exec-2");
        assert_eq!(exec_owner("exec-1").as_deref(), Some("eng-a"));
        assert_eq!(exec_owner("exec-2").as_deref(), Some("eng-b"));
        assert_eq!(exec_owner("exec-?"), None);
        forget_fleet_execs("eng-a");
        assert_eq!(exec_owner("exec-1"), None);
        assert_eq!(exec_owner("exec-2").as_deref(), Some("eng-b"));
        forget_fleet_execs("eng-b");
    }

    /// A fake engine: records every path it is asked for, answers `[]`.
    /// The listener binds before this spawns, so no connect can race it.
    async fn fake_engine(listener: UnixListener, seen: Arc<Mutex<Vec<String>>>) {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let seen = seen.clone();
                    async move {
                        seen.lock().unwrap().push(
                            req.uri()
                                .path_and_query()
                                .map(|pq| pq.to_string())
                                .unwrap_or_default(),
                        );
                        let _ = req.into_body().collect().await;
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .status(StatusCode::OK)
                                .header(CONTENT_TYPE, "application/json")
                                .body(full(Bytes::from_static(b"[]")))
                                .unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    }

    #[tokio::test]
    async fn proxy_forwards_a_list_and_refuses_a_privileged_create() {
        let dir = test_dir("fwd");
        let fleet_dir = dir.join("sockets");
        std::fs::create_dir_all(&fleet_dir).unwrap();
        let upstream_sock = dir.join("upstream.sock");
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let engine = tokio::spawn(fake_engine(
            UnixListener::bind(&upstream_sock).expect("fake engine binds"),
            seen.clone(),
        ));
        let key = test_key("fwd");
        let socket = serve_inner(&key, &fleet_dir, Some(upstream_sock)).expect("serve");
        // Serving again is the same socket, not a second loop.
        assert_eq!(
            serve_inner(&key, &fleet_dir, None).expect("re-serve"),
            socket
        );
        // The dir traverses but does not list; every fleet process may
        // connect (the peer pid decides), none may chmod the socket shut.
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&fleet_dir).unwrap().permissions().mode() & 0o777,
            0o711
        );
        assert_eq!(
            std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o666
        );
        registry::register_fleet(&key, std::process::id());

        // celld's reap list arrives upstream with the fleet label added.
        let filters = validate::percent_encode(r#"{"label":["celld.node=n1"]}"#);
        let (status, body) = fleet_call(
            &socket,
            "GET",
            &format!("/containers/json?all=true&filters={filters}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, Bytes::from_static(b"[]"));
        let paths = seen.lock().unwrap().clone();
        assert_eq!(paths.len(), 1, "{paths:?}");
        assert!(
            paths[0].starts_with("/containers/json?all=true&filters="),
            "{}",
            paths[0]
        );
        assert!(paths[0].contains("celld%2Enode%3Dn1"), "{}", paths[0]);
        assert!(paths[0].contains("noite%2Efleet%3D"), "{}", paths[0]);

        // A privileged create is refused before any upstream contact: the
        // 403 itself proves nothing was forwarded (a forward would answer
        // the upstream's response instead).
        let (status, body) = fleet_call(
            &socket,
            "POST",
            "/containers/create?name=celld-0123456789abcdef01234567",
            Some(json!({
                "Image": "celld-image:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "HostConfig": {"NetworkMode": "celld", "Privileged": true},
            })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(message(&body).starts_with("noite: "), "{}", message(&body));
        assert_eq!(seen.lock().unwrap().len(), 1);

        registry::unregister_fleet(&key);
        close_fleet(&key).await;
        engine.abort();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn proxy_refuses_connections_from_foreign_processes() {
        let dir = test_dir("peer");
        let fleet_dir = dir.join("sockets");
        std::fs::create_dir_all(&fleet_dir).unwrap();
        // Never registered: no fleet process owns this socket yet.
        let key = test_key("peer");
        let socket = serve_inner(&key, &fleet_dir, None).expect("serve");
        let (status, body) = fleet_call(&socket, "GET", "/containers/json?all=true", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(
            message(&body).contains("unknown fleet process"),
            "{}",
            message(&body)
        );
        // Registered under another pid: still refused.
        registry::register_fleet(&key, u32::MAX);
        let (status, _) = fleet_call(&socket, "GET", "/containers/json?all=true", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        registry::unregister_fleet(&key);
        close_fleet(&key).await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A fake engine that 101-upgrades one exec start and echoes 5 bytes.
    /// The listener binds before this spawns, so no connect can race it.
    async fn echo_engine(listener: UnixListener) {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let service = hyper::service::service_fn(|mut req: Request<Incoming>| async move {
            assert_eq!(req.uri().path(), "/exec/echo1/start");
            assert!(req.headers().contains_key(UPGRADE));
            let pending = hyper::upgrade::on(&mut req);
            let _ = req.into_body().collect().await;
            tokio::spawn(async move {
                let Ok(io) = pending.await else {
                    return;
                };
                let mut io = TokioIo::new(io);
                let mut buf = [0u8; 5];
                if io.read_exact(&mut buf).await.is_ok() {
                    let _ = io.write_all(&buf).await;
                }
            });
            Ok::<_, std::convert::Infallible>(
                Response::builder()
                    .status(StatusCode::SWITCHING_PROTOCOLS)
                    .header(UPGRADE, "tcp")
                    .header(CONNECTION, "Upgrade")
                    .body(full(Bytes::new()))
                    .unwrap(),
            )
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades()
            .await;
    }

    #[tokio::test]
    async fn exec_upgrade_splices_end_to_end() {
        let dir = test_dir("hijack");
        let fleet_dir = dir.join("sockets");
        std::fs::create_dir_all(&fleet_dir).unwrap();
        let upstream_sock = dir.join("upstream.sock");
        let engine = tokio::spawn(echo_engine(
            UnixListener::bind(&upstream_sock).expect("echo engine binds"),
        ));
        let key = test_key("jack");
        let socket = serve_inner(&key, &fleet_dir, Some(upstream_sock)).expect("serve");
        registry::register_fleet(&key, std::process::id());

        // An exec id this fleet never created here starts nothing.
        let (status, _) = fleet_call(
            &socket,
            "POST",
            "/exec/nope/start",
            Some(json!({"Detach": false, "Tty": false})),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = fleet_call(&socket, "GET", "/exec/nope/json", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // A remembered id upgrades through the proxy to the engine.
        remember_exec(&key, "echo1");
        let stream = UnixStream::connect(&socket)
            .await
            .expect("fleet socket connects");
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .expect("handshake");
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let request = Request::builder()
            .method("POST")
            .uri("/exec/echo1/start")
            .header(HOST, "docker")
            .header(CONTENT_TYPE, "application/json")
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "tcp")
            .body(Full::new(Bytes::from_static(
                br#"{"Detach":false,"Tty":false}"#,
            )))
            .unwrap();
        let mut response = sender.send_request(request).await.expect("101");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let mut io = TokioIo::new(hyper::upgrade::on(&mut response).await.expect("upgraded"));
        io.write_all(b"hello").await.expect("write through");
        let mut buf = [0u8; 5];
        io.read_exact(&mut buf).await.expect("echo back");
        assert_eq!(&buf, b"hello");

        forget_fleet_execs(&key);
        registry::unregister_fleet(&key);
        close_fleet(&key).await;
        engine.abort();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
