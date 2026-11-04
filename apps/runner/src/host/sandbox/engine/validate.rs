//! What a fleet may ask the engine: the exact Engine API surface celld
//! 0.6.3 uses (`/tmp/celld-src/crates/celld/container.rs`, `docker.rs`), no
//! more. Pure functions over method/path/query/JSON so tests pin every
//! accept and every refusal without a socket; [`super`] wires them to the
//! proxy loop.

use std::net::Ipv4Addr;

use bytes::Bytes;
use serde_json::Value;

use super::super::{install, FLEET_LABEL, INSTALL_LABEL};

/// celld 0.6.3's fence ruleset, byte-identical to `FENCE_RULES` in
/// `crates/celld/container.rs:146-160`. The fence installer is the one
/// create a fleet may make outside the locked-down app shape, and its only
/// authority is that these rules are exactly celld's own: a celld bump must
/// re-verify this constant before the proxy accepts the new version's
/// installer.
pub const FENCE_RULES: &str = r#"table inet celld
delete table inet celld
table inet celld {
  chain input {
    type filter hook input priority -10; policy accept;
    iifname { "celld0", "celld1" } ct state established,related accept
    iifname { "celld0", "celld1" } reject
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname { "celld0", "celld1" } ip daddr { 169.254.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } reject
    iifname { "celld0", "celld1" } ip6 daddr { fe80::/10, fc00::/7 } reject
  }
}
"#;

/// The fence installer's command, exactly as celld 0.6.3 builds it
/// (`container.rs:697`).
const FENCE_CMD: &str = "printf '%s' \"$CELLD_NFT\" | nft -f -";

/// Strip an optional `/v1.NN` API prefix for matching. celld sends
/// unversioned paths; a versioned caller is matched (and forwarded) on the
/// unversioned remainder.
pub fn strip_api_version(path: &str) -> &str {
    let Some(rest) = path.strip_prefix("/v1.") else {
        return path;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return path;
    }
    match rest.get(digits..) {
        Some(remaining) if remaining.starts_with('/') => remaining,
        Some("") => "/",
        _ => path,
    }
}

/// A per-container operation celld performs on its own containers.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ContainerOp {
    Start,
    Wait,
    Kill,
    Inspect,
    Logs,
    Exec,
}

/// Where one request goes. The proxy still checks ownership (container
/// label, remembered exec id) before forwarding the [`Route::Container`],
/// [`Route::Remove`], [`Route::ExecStart`], [`Route::ExecInspect`] and
/// [`Route::ExecResize`] variants.
#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    /// `GET /containers/json`: list, with filters rewritten to this fleet.
    List,
    /// `POST /containers/create`: app shape, or the fence installer.
    Create,
    /// A per-container op on one the fleet owns.
    Container { id: &'a str, op: ContainerOp },
    /// `DELETE /containers/{id}` on one the fleet owns.
    Remove { id: &'a str },
    /// `POST /exec/{id}/start` for a remembered exec id.
    ExecStart { id: &'a str },
    /// `GET /exec/{id}/json` for a remembered exec id.
    ExecInspect { id: &'a str },
    /// `POST /exec/{id}/resize` for a remembered exec id, with its query
    /// rebuilt by [`validate_exec_resize_query`].
    ExecResize { id: &'a str },
    /// `GET /images/{name}/json` for a celld content tag.
    ImageInspect { name: &'a str },
    /// `POST /images/load`: always refused (the runner deployed the images).
    ImageLoad,
    /// `GET /networks/{name}` for a celld bridge.
    NetworkInspect { name: &'a str },
    /// `POST /networks/create` with celld's exact bridge body.
    NetworkCreate,
    /// Anything else: refused, with the reason celld sees after `noite: `.
    Refused(&'static str),
}

/// Route one request. `path` must already be [`strip_api_version`]ed; the
/// query is only parsed by the routes that take one. Container and exec ids
/// are interpolated into the upstream path, so they must be plain names
/// (no `%`-escapes, no `.`/`..` segments): an encoded `/` would let the
/// daemon route the request somewhere the allowlist never looked.
pub fn classify<'a>(method: &str, path: &'a str) -> Route<'a> {
    let segments: Vec<&str> = path.split('/').collect();
    let segments = segments.as_slice();
    match (method, segments) {
        ("GET", ["", "containers", "json"]) => Route::List,
        ("POST", ["", "containers", "create"]) => Route::Create,
        ("DELETE", ["", "containers", id]) if valid_ref(id) => Route::Remove { id },
        (_, ["", "containers", id, op]) if valid_ref(id) => {
            let op = match (*op, method) {
                ("start", "POST") => ContainerOp::Start,
                ("wait", "POST") => ContainerOp::Wait,
                ("kill", "POST") => ContainerOp::Kill,
                ("json", "GET") => ContainerOp::Inspect,
                ("logs", "GET") => ContainerOp::Logs,
                ("exec", "POST") => ContainerOp::Exec,
                _ => return Route::Refused("no such container operation"),
            };
            Route::Container { id, op }
        }
        ("POST", ["", "exec", id, "start"]) if valid_ref(id) => Route::ExecStart { id },
        ("GET", ["", "exec", id, "json"]) if valid_ref(id) => Route::ExecInspect { id },
        ("POST", ["", "exec", id, "resize"]) if valid_ref(id) => Route::ExecResize { id },
        ("GET", ["", "images", name, "json"]) => Route::ImageInspect { name },
        ("POST", ["", "images", "load"]) => Route::ImageLoad,
        ("GET", ["", "networks", name]) if !name.is_empty() => Route::NetworkInspect { name },
        ("POST", ["", "networks", "create"]) => Route::NetworkCreate,
        _ => Route::Refused("no such engine call"),
    }
}

/// A container name/id or exec id as the engine issues them: 1..=128 of
/// `[A-Za-z0-9_.-]`, starting alphanumeric (so never `.` or `..`).
fn valid_ref(id: &str) -> bool {
    id.len() <= 128
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// The validated `name` query of a create: `Some` app-container name, `None`
/// for the nameless fence installer. Anything else is refused.
pub fn create_name(query: Option<&str>) -> Result<Option<String>, String> {
    let Some(query) = query else {
        return Ok(None);
    };
    if query.is_empty() {
        return Ok(None);
    }
    let mut pairs = query.split('&');
    let Some(pair) = pairs.next() else {
        return Ok(None);
    };
    if pairs.next().is_some() {
        return Err("create takes only ?name=".to_string());
    }
    let Some(value) = pair.strip_prefix("name=") else {
        return Err("create takes only ?name=".to_string());
    };
    if !valid_container_name(value) {
        return Err(format!("bad container name {value:?}"));
    }
    Ok(Some(value.to_string()))
}

/// celld's container names: `celld-` plus 24 hex digits (96 bits of
/// `sha256("node\nscope")`, `container.rs:1584-1587`).
fn valid_container_name(name: &str) -> bool {
    let Some(hex) = name.strip_prefix("celld-") else {
        return false;
    };
    hex.len() == 24 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A celld content tag: `celld-image:` plus the 64 hex digits of the layer +
/// config hash (`deploy.rs:790-843`).
pub fn valid_image_name(name: &str) -> bool {
    let Some(hex) = name.strip_prefix("celld-image:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The two bridges celld joins its containers to.
pub fn valid_network_name(name: &str) -> bool {
    name == "celld" || name == "celld-internal"
}

/// Rewrite a `GET /containers/json` query so the list can only return this
/// fleet's containers: the `filters` object gains a
/// `label=noite.fleet=<fleet>` requirement. A missing or unparsable filters
/// value becomes exactly that requirement rather than an open list.
///
/// Keys are matched after percent-decoding, as the daemon matches them (a
/// `%66ilters` pair is the daemon's `filters`, and its first value wins),
/// and only the list's own scalar keys pass through; anything else is
/// dropped rather than forwarded unseen.
pub fn rewrite_list_query(query: Option<&str>, fleet: &str) -> String {
    let required = format!("{fleet_label}={fleet}", fleet_label = FLEET_LABEL);
    let mut kept: Vec<String> = Vec::new();
    let mut filters: Option<serde_json::Map<String, Value>> = None;
    for pair in query.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (raw_key, encoded) = pair.split_once('=').unwrap_or((pair, ""));
        let Ok(key) = percent_decode(raw_key) else {
            continue;
        };
        match key.as_str() {
            "filters" => {}
            "all" | "limit" | "size" => {
                kept.push(format!("{key}={encoded}"));
                continue;
            }
            _ => continue,
        }
        if filters.is_some() {
            continue;
        }
        let mut object: serde_json::Map<String, Value> = percent_decode(encoded)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        match object.get_mut("label") {
            Some(Value::Array(labels)) => {
                if !labels.iter().any(|l| l.as_str() == Some(&required)) {
                    labels.push(Value::String(required.clone()));
                }
            }
            _ => {
                object.insert(
                    "label".to_string(),
                    Value::Array(vec![Value::String(required.clone())]),
                );
            }
        }
        filters = Some(object);
    }
    let mut object = filters.unwrap_or_default();
    if !object
        .get("label")
        .and_then(Value::as_array)
        .is_some_and(|labels| labels.iter().any(|l| l.as_str() == Some(&required)))
    {
        object.insert(
            "label".to_string(),
            Value::Array(vec![Value::String(required)]),
        );
    }
    kept.push(format!(
        "filters={}",
        percent_encode(&Value::Object(object).to_string())
    ));
    kept.join("&")
}

/// Decode `%XX` sequences. `+` stays literal: celld encodes with
/// `NON_ALPHANUMERIC`, which never emits a bare `+`.
fn percent_decode(raw: &str) -> Result<String, ()> {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = raw.get(i + 1..i + 3).ok_or(())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

/// Encode like celld's `NON_ALPHANUMERIC`: alphanumerics stay, every other
/// byte becomes `%XX`.
pub(crate) fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Whether every key of `object` is in `allowed`.
fn keys_subset(object: &serde_json::Map<String, Value>, allowed: &[&str]) -> Option<String> {
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Some(key.clone());
        }
    }
    None
}

fn is_string_array(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(|item| item.is_string()))
}

/// Validate an app-container create body (celld `container.rs:1040-1098`),
/// returning it with the fleet label injected. The shape is exactly what
/// celld 0.6.3 sends: anything else — privilege, host namespaces, mounts,
/// devices, port bindings, a caller-supplied runtime or resolv.conf bind —
/// is refused.
pub fn validate_app_create(body: &Value, fleet: &str) -> Result<Value, String> {
    let Some(object) = body.as_object() else {
        return Err("create body must be an object".to_string());
    };
    if let Some(key) = keys_subset(object, &["Image", "Env", "Labels", "HostConfig", "Cmd"]) {
        return Err(format!("create takes no {key:?}"));
    }
    let image = object.get("Image").and_then(Value::as_str).unwrap_or("");
    if !valid_image_name(image) {
        return Err("create Image must be a celld-image:<content key> tag".to_string());
    }
    if let Some(env) = object.get("Env") {
        if !is_string_array(env) {
            return Err("create Env must be an array of strings".to_string());
        }
    }
    if let Some(cmd) = object.get("Cmd") {
        if !is_string_array(cmd) {
            return Err("create Cmd must be an array of strings".to_string());
        }
    }
    if let Some(labels) = object.get("Labels") {
        let Some(labels) = labels.as_object() else {
            return Err("create Labels must be an object".to_string());
        };
        if labels.values().any(|v| !v.is_string()) {
            return Err("create Labels must map to strings".to_string());
        }
        if labels.keys().any(|k| k.starts_with("noite.")) {
            return Err("create Labels must not set noite.* labels".to_string());
        }
    }
    let Some(host) = object.get("HostConfig").and_then(Value::as_object) else {
        return Err("create needs its HostConfig".to_string());
    };
    validate_app_host_config(host)?;
    let mut body = body.clone();
    let labels = body.as_object_mut().and_then(|o| {
        o.entry("Labels")
            .or_insert(Value::Object(Default::default()))
            .as_object_mut()
    });
    let Some(labels) = labels else {
        return Err("create Labels must be an object".to_string());
    };
    labels.insert(FLEET_LABEL.to_string(), Value::String(fleet.to_string()));
    labels.insert(
        INSTALL_LABEL.to_string(),
        Value::String(install().to_string()),
    );
    Ok(body)
}

/// The locked-down app-container `HostConfig` (celld `container.rs:1040-1051`
/// plus the instance-type limits at `1085-1089`). The security boundary —
/// bridge, dropped capabilities, no-new-privileges, pid ceiling — is
/// required; the harmless scheduling keys are validated when present.
/// `Runtime` and `Binds` are refused outright: Noite sets no container
/// runtime or DNS, so celld 0.6.3 never sends them, and either would hand a
/// fleet host paths or a weaker runtime.
fn validate_app_host_config(host: &serde_json::Map<String, Value>) -> Result<(), String> {
    if let Some(key) = keys_subset(
        host,
        &[
            "NetworkMode",
            "PublishAllPorts",
            "CapDrop",
            "SecurityOpt",
            "PidsLimit",
            "Init",
            "NanoCpus",
            "Memory",
            "MemorySwap",
        ],
    ) {
        return Err(format!("HostConfig takes no {key:?}"));
    }
    match host.get("NetworkMode").and_then(Value::as_str) {
        Some("celld" | "celld-internal") => {}
        _ => return Err("HostConfig NetworkMode must be celld or celld-internal".to_string()),
    }
    if host.get("CapDrop") != Some(&Value::Array(vec![Value::String("ALL".to_string())])) {
        return Err("HostConfig CapDrop must be [\"ALL\"]".to_string());
    }
    if host.get("SecurityOpt")
        != Some(&Value::Array(vec![Value::String(
            "no-new-privileges".to_string(),
        )]))
    {
        return Err("HostConfig SecurityOpt must be [\"no-new-privileges\"]".to_string());
    }
    let pids = host.get("PidsLimit").and_then(Value::as_u64);
    if !pids.is_some_and(|pids| (1..=1024).contains(&pids)) {
        return Err("HostConfig PidsLimit must be 1..=1024".to_string());
    }
    if let Some(publish) = host.get("PublishAllPorts") {
        if publish != &Value::Bool(false) {
            return Err("HostConfig PublishAllPorts must be false".to_string());
        }
    }
    if let Some(init) = host.get("Init") {
        if init != &Value::Bool(true) {
            return Err("HostConfig Init must be true".to_string());
        }
    }
    // Every container has limits, never above the largest instance type
    // celld knows (`standard-4`: 4 vCPU, 12 GiB; `container.rs:77-88`):
    // absent or zero would mean unlimited on the daemon, and a huge value
    // the same in practice. Swap is never extended beyond memory.
    let cpus = host.get("NanoCpus").and_then(Value::as_u64);
    if !cpus.is_some_and(|cpus| (1..=MAX_NANO_CPUS).contains(&cpus)) {
        return Err(format!("HostConfig NanoCpus must be 1..={MAX_NANO_CPUS}"));
    }
    let memory = host.get("Memory").and_then(Value::as_u64);
    if !memory.is_some_and(|memory| (1..=MAX_MEMORY_BYTES).contains(&memory)) {
        return Err(format!("HostConfig Memory must be 1..={MAX_MEMORY_BYTES}"));
    }
    if host.get("MemorySwap").and_then(Value::as_u64) != memory {
        return Err("HostConfig MemorySwap must equal Memory".to_string());
    }
    Ok(())
}

/// The largest instance type celld knows (`standard-4`), as the daemon's
/// `NanoCpus` and `Memory` values.
const MAX_NANO_CPUS: u64 = 4_000_000_000;
const MAX_MEMORY_BYTES: u64 = 12 * 1024 * 1024 * 1024;

/// Validate the fence installer's create body (celld `container.rs:694-700`)
/// and return the body Noite actually creates. This is the one host-network,
/// `NET_ADMIN` container a fleet may ask for, so only celld's installer
/// verbatim passes (node label aside, every byte is pinned, above all the
/// ruleset) and its image is replaced by `trusted_image`, the runner's own:
/// a `celld-image:` tag is whatever image a tenant deployed, and its `sh`
/// or `nft` would otherwise run in the host netns with `NET_ADMIN`. The
/// runner image carries `sh` and `nft`; the entrypoint is set explicitly
/// because that image's own entrypoint is the runner.
pub fn validate_fence_create(
    body: &Value,
    fleet: &str,
    trusted_image: &str,
) -> Result<Value, String> {
    let Some(object) = body.as_object() else {
        return Err("fence body must be an object".to_string());
    };
    if object.len() != 5
        || keys_subset(object, &["Image", "Env", "Cmd", "Labels", "HostConfig"]).is_some()
    {
        return Err("fence body must be exactly celld's installer".to_string());
    }
    let image = object.get("Image").and_then(Value::as_str).unwrap_or("");
    if !image.starts_with("celld-image:") {
        return Err("fence Image must be a celld-image: tag".to_string());
    }
    let env = [format!("CELLD_NFT={FENCE_RULES}")];
    if object.get("Env") != Some(&Value::Array(env.map(Value::String).to_vec())) {
        return Err("fence Env must be exactly celld's ruleset".to_string());
    }
    let cmd = ["sh", "-c", FENCE_CMD]
        .map(String::from)
        .map(Value::String)
        .to_vec();
    if object.get("Cmd") != Some(&Value::Array(cmd)) {
        return Err("fence Cmd must be exactly celld's installer".to_string());
    }
    let labels = object.get("Labels").and_then(Value::as_object);
    let Some(labels) = labels else {
        return Err("fence Labels must be exactly celld's installer".to_string());
    };
    if labels.len() != 2
        || !labels.get("celld.node").is_some_and(Value::is_string)
        || labels.get("celld.fence") != Some(&Value::String("1".to_string()))
    {
        return Err("fence Labels must be exactly celld's installer".to_string());
    }
    let host = object.get("HostConfig").and_then(Value::as_object);
    let Some(host) = host else {
        return Err("fence HostConfig must be exactly celld's installer".to_string());
    };
    if host.len() != 2
        || host.get("NetworkMode") != Some(&Value::String("host".to_string()))
        || host.get("CapAdd") != Some(&Value::Array(vec![Value::String("NET_ADMIN".to_string())]))
    {
        return Err("fence HostConfig must be exactly celld's installer".to_string());
    }
    let node = labels.get("celld.node").cloned().unwrap_or(Value::Null);
    Ok(serde_json::json!({
        "Image": trusted_image,
        "Entrypoint": ["sh", "-c", FENCE_CMD],
        "Env": [format!("CELLD_NFT={FENCE_RULES}")],
        "Labels": {
            "celld.node": node,
            "celld.fence": "1",
            FLEET_LABEL: fleet,
            INSTALL_LABEL: install(),
        },
        "HostConfig": { "NetworkMode": "host", "CapAdd": ["NET_ADMIN"] },
    }))
}

/// Validate an exec-create body (celld `exec_create_body`,
/// `container.rs:1925`, plus the attachless kill form at `1973`): the stdio
/// wiring, command, environment, directory and user — no privilege bit, no
/// detach extras. The kill form is `sh -c` over a `/proc` scan for the
/// exec's `CELLD_EXEC_ID` marker, run as the exec's user when it had one.
/// `Tty` may be true (a PTY exec, whose attach flags celld sends exactly as
/// for a plain one) or false.
pub fn validate_exec_create(body: &Value) -> Result<(), String> {
    let Some(object) = body.as_object() else {
        return Err("exec body must be an object".to_string());
    };
    if let Some(key) = keys_subset(
        object,
        &[
            "AttachStdin",
            "AttachStdout",
            "AttachStderr",
            "Tty",
            "Cmd",
            "Env",
            "WorkingDir",
            "User",
        ],
    ) {
        return Err(format!("exec takes no {key:?}"));
    }
    for key in ["AttachStdin", "AttachStdout", "AttachStderr"] {
        if let Some(value) = object.get(key) {
            if !value.is_boolean() {
                return Err(format!("exec {key} must be a boolean"));
            }
        }
    }
    if let Some(tty) = object.get("Tty") {
        if !tty.is_boolean() {
            return Err("exec Tty must be a boolean".to_string());
        }
    }
    let cmd = object.get("Cmd").and_then(Value::as_array);
    let Some(cmd) = cmd else {
        return Err("exec needs its Cmd".to_string());
    };
    if cmd.is_empty() || !cmd.iter().all(Value::is_string) {
        return Err("exec Cmd must be a non-empty array of strings".to_string());
    }
    if let Some(env) = object.get("Env") {
        if !is_string_array(env) {
            return Err("exec Env must be an array of strings".to_string());
        }
    }
    for key in ["WorkingDir", "User"] {
        if let Some(value) = object.get(key) {
            if !value.is_string() {
                return Err(format!("exec {key} must be a string"));
            }
        }
    }
    Ok(())
}

/// Validate an exec-start body: celld's hijacked form
/// (`{"Detach": false, "Tty": false}`, `container.rs:1793`, or `"Tty": true`
/// for a PTY exec) and its kill-via-exec form (`{"Detach": true}`,
/// `container.rs:2020`).
pub fn validate_exec_start(body: &Value) -> Result<(), String> {
    let Some(object) = body.as_object() else {
        return Err("exec start body must be an object".to_string());
    };
    if let Some(key) = keys_subset(object, &["Detach", "Tty"]) {
        return Err(format!("exec start takes no {key:?}"));
    }
    if let Some(detach) = object.get("Detach") {
        if !detach.is_boolean() {
            return Err("exec start Detach must be a boolean".to_string());
        }
    }
    if let Some(tty) = object.get("Tty") {
        if !tty.is_boolean() {
            return Err("exec start Tty must be a boolean".to_string());
        }
    }
    Ok(())
}

/// Validate a `POST /exec/{id}/resize` query and rebuild it canonically:
/// exactly one `h` (rows) and one `w` (cols), each `1..=65535`, as celld
/// sends them (`/exec/{id}/resize?h={rows}&w={cols}`). Missing, extra or
/// duplicate parameters, and non-numeric or out-of-range dimensions, are
/// refused; the proxy forwards only the rebuilt query, so nothing unseen
/// reaches the daemon.
pub fn validate_exec_resize_query(query: Option<&str>) -> Result<String, String> {
    let Some(query) = query.filter(|query| !query.is_empty()) else {
        return Err("resize needs ?h=<rows>&w=<cols>".to_string());
    };
    let mut rows: Option<u32> = None;
    let mut cols: Option<u32> = None;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            return Err("resize takes only ?h=<rows>&w=<cols>".to_string());
        };
        let dim = match key {
            "h" => &mut rows,
            "w" => &mut cols,
            _ => return Err("resize takes only ?h=<rows>&w=<cols>".to_string()),
        };
        if dim.is_some() {
            return Err(format!("resize takes one {}", key));
        }
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("resize {} must be 1..=65535", key));
        }
        let size: u32 = value
            .parse()
            .map_err(|_| format!("resize {} must be 1..=65535", key))?;
        if !(1..=65535).contains(&size) {
            return Err(format!("resize {} must be 1..=65535", key));
        }
        *dim = Some(size);
    }
    match (rows, cols) {
        (Some(rows), Some(cols)) => Ok(format!("h={}&w={}", rows, cols)),
        _ => Err("resize needs ?h=<rows>&w=<cols>".to_string()),
    }
}

/// Validate a bridge create body: exactly celld's (`container.rs:650-658`)
/// for one of the two bridges, with the matching isolation flag and host
/// interface name. The runner owns the bridges; anything else is refused.
pub fn validate_network_create(body: &Value) -> Result<(), String> {
    let Some(object) = body.as_object() else {
        return Err("network body must be an object".to_string());
    };
    if object.len() != 4
        || keys_subset(object, &["Name", "Driver", "Internal", "Options"]).is_some()
    {
        return Err("network body must be exactly celld's bridge".to_string());
    }
    let name = object.get("Name").and_then(Value::as_str).unwrap_or("");
    if !valid_network_name(name) {
        return Err("network Name must be celld or celld-internal".to_string());
    }
    if object.get("Driver") != Some(&Value::String("bridge".to_string())) {
        return Err("network Driver must be bridge".to_string());
    }
    let internal = name == "celld-internal";
    if object.get("Internal") != Some(&Value::Bool(internal)) {
        return Err("network Internal must match its bridge".to_string());
    }
    let bridge = if internal { "celld1" } else { "celld0" };
    let options = object.get("Options").and_then(Value::as_object);
    let Some(options) = options else {
        return Err("network Options must be exactly celld's bridge".to_string());
    };
    if options.len() != 2
        || options.get("com.docker.network.bridge.enable_icc")
            != Some(&Value::String("false".to_string()))
        || options.get("com.docker.network.bridge.name") != Some(&Value::String(bridge.to_string()))
    {
        return Err("network Options must be exactly celld's bridge".to_string());
    }
    Ok(())
}

/// A network inspect answer without its member list: `Containers` (and the
/// per-container `Services` some daemons add) become empty, so a fleet never
/// learns another app's container names or addresses. A non-JSON answer
/// (an engine error) passes as is.
pub fn without_network_members(body: &[u8]) -> Bytes {
    let Ok(mut value) = serde_json::from_slice::<Value>(body) else {
        return Bytes::copy_from_slice(body);
    };
    if let Some(object) = value.as_object_mut() {
        for key in ["Containers", "Services"] {
            if object.contains_key(key) {
                object.insert(key.to_string(), Value::Object(Default::default()));
            }
        }
    }
    Bytes::from(value.to_string())
}

/// Whether an inspected container is celld's fence installer: its label, or
/// host networking (no app container is ever created with it).
pub fn inspect_is_fence(info: &Value) -> bool {
    let labelled = ["/Config/Labels/celld.fence", "/Labels/celld.fence"]
        .iter()
        .any(|pointer| info.pointer(pointer).is_some());
    labelled || info.pointer("/HostConfig/NetworkMode") == Some(&Value::String("host".into()))
}

/// The fleet label on an inspected container, from either place the daemon
/// reports labels. `None` means unlabelled — owned by nobody.
pub fn inspect_fleet_label(info: &Value) -> Option<String> {
    for pointer in ["/Config/Labels", "/Labels"] {
        if let Some(label) = info
            .pointer(pointer)
            .and_then(|labels| labels.get(FLEET_LABEL))
            .and_then(Value::as_str)
        {
            return Some(label.to_string());
        }
    }
    None
}

/// The identity of an inspected container: its id and its name without the
/// daemon's leading slash.
pub fn inspect_identity(info: &Value) -> (Option<String>, Option<String>) {
    let id = info.get("Id").and_then(Value::as_str).map(str::to_string);
    let name = info
        .get("Name")
        .and_then(Value::as_str)
        .map(|name| name.trim_start_matches('/').to_string())
        .filter(|name| !name.is_empty());
    (id, name)
}

/// Every bridge address an inspect response reports for a container.
pub fn inspect_ips(info: &Value) -> Vec<Ipv4Addr> {
    info.pointer("/NetworkSettings/Networks")
        .and_then(Value::as_object)
        .map(|networks| {
            networks
                .values()
                .filter_map(|network| network.get("IPAddress").and_then(Value::as_str))
                .filter_map(|ip| ip.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const IMAGE: &str =
        "celld-image:6a76000000000000000000000000000000000000000000000000000000000000";
    const NODE: &str = "node-test-1";

    /// celld 0.6.3's app-container create body (`container.rs:1040-1098`) for
    /// the default `dev` instance type, with a tenant entrypoint.
    fn app_create_body() -> Value {
        json!({
            "Image": IMAGE,
            "Env": [
                "CLOUDFLARE_COUNTRY_A2=XX",
                "CLOUDFLARE_DEPLOYMENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                "CLOUDFLARE_LOCATION=loc01",
                "CLOUDFLARE_REGION=REGN",
                "CLOUDFLARE_APPLICATION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                "CLOUDFLARE_DURABLE_OBJECT_ID=cell-scope-1",
                "MODEL=faux",
            ],
            "Labels": {
                "celld.node": NODE,
                "celld.cell": "cell-scope-1",
                "celld.class": "Sandbox",
                "celld.user.owner": "tenant",
            },
            "HostConfig": {
                "NetworkMode": "celld",
                "PublishAllPorts": false,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges"],
                "PidsLimit": 1024,
                "Init": true,
                "NanoCpus": 62_500_000_u64,
                "Memory": 268_435_456_u64,
                "MemorySwap": 268_435_456_u64,
            },
            "Cmd": ["bun", "run", "server.ts"],
        })
    }

    /// celld 0.6.3's fence installer body (`container.rs:694-700`).
    fn fence_create_body() -> Value {
        json!({
            "Image": IMAGE,
            "Env": [format!("CELLD_NFT={FENCE_RULES}")],
            "Cmd": ["sh", "-c", FENCE_CMD],
            "Labels": { "celld.node": NODE, "celld.fence": "1" },
            "HostConfig": { "NetworkMode": "host", "CapAdd": ["NET_ADMIN"] },
        })
    }

    /// celld's kill scan (`kill_scan_script`, `container.rs:1964`) for one
    /// exec id and signal, byte-identical to what the daemon receives.
    fn kill_scan(id: u64, signal: u32) -> String {
        format!(
            "for d in /proc/[0-9]*;do grep -qa \"CELLD_EXEC_ID={id};\" \"$d/environ\" 2>/dev/null&&kill -{signal} \"${{d#/proc/}}\";done"
        )
    }

    /// celld's kill exec create (`kill_exec_body`, `container.rs:1973`):
    /// the attachless `sh -c` scan, run as the exec's user when it had one.
    fn kill_exec_body(id: u64, signal: u32, user: Option<&str>) -> Value {
        let mut body = json!({
            "AttachStdin": false, "AttachStdout": false, "AttachStderr": false,
            "Cmd": ["sh", "-c", kill_scan(id, signal)],
        });
        if let Some(user) = user {
            body["User"] = json!(user);
        }
        body
    }

    #[test]
    fn version_prefix_strips_for_matching_only() {
        assert_eq!(strip_api_version("/containers/json"), "/containers/json");
        assert_eq!(
            strip_api_version("/v1.44/containers/json"),
            "/containers/json"
        );
        assert_eq!(
            strip_api_version("/v1.29/exec/abc/start"),
            "/exec/abc/start"
        );
        assert_eq!(strip_api_version("/v1.44"), "/");
        // Not a version: left alone, so classification refuses them.
        assert_eq!(
            strip_api_version("/v1/containers/json"),
            "/v1/containers/json"
        );
        assert_eq!(
            strip_api_version("/v1.x/containers/json"),
            "/v1.x/containers/json"
        );
        assert_eq!(
            strip_api_version("/v1.44x/containers/json"),
            "/v1.44x/containers/json"
        );
    }

    #[test]
    fn routes_match_cellds_calls_and_refuse_the_rest() {
        use ContainerOp::*;
        assert_eq!(classify("GET", "/containers/json"), Route::List);
        assert_eq!(classify("POST", "/containers/create"), Route::Create);
        for (op, method, tail) in [
            (Start, "POST", "start"),
            (Wait, "POST", "wait"),
            (Kill, "POST", "kill"),
            (Inspect, "GET", "json"),
            (Logs, "GET", "logs"),
            (Exec, "POST", "exec"),
        ] {
            assert_eq!(
                classify(method, &format!("/containers/abc/{tail}")),
                Route::Container { id: "abc", op }
            );
        }
        assert_eq!(
            classify("DELETE", "/containers/abc"),
            Route::Remove { id: "abc" }
        );
        assert_eq!(
            classify("POST", "/exec/abc/start"),
            Route::ExecStart { id: "abc" }
        );
        assert_eq!(
            classify("GET", "/exec/abc/json"),
            Route::ExecInspect { id: "abc" }
        );
        assert_eq!(
            classify("POST", "/exec/abc/resize"),
            Route::ExecResize { id: "abc" }
        );
        assert_eq!(
            classify("GET", &format!("/images/{IMAGE}/json")),
            Route::ImageInspect { name: IMAGE }
        );
        assert_eq!(classify("POST", "/images/load"), Route::ImageLoad);
        assert_eq!(
            classify("GET", "/networks/celld"),
            Route::NetworkInspect { name: "celld" }
        );
        assert_eq!(classify("POST", "/networks/create"), Route::NetworkCreate);
        // celld never calls these: no ping/version handshake, no daemon
        // introspection, no runner-owned network deletes, no container
        // management beyond its own lifecycle.
        for (method, path) in [
            ("GET", "/_ping"),
            ("GET", "/version"),
            ("GET", "/info"),
            ("POST", "/containers/json"),
            ("POST", "/containers/abc/stop"),
            ("POST", "/containers/abc/restart"),
            ("POST", "/containers/abc/pause"),
            ("POST", "/containers/abc/rename"),
            ("POST", "/containers/abc/update"),
            ("POST", "/containers/abc/resize"),
            ("POST", "/containers/abc/attach"),
            ("GET", "/containers/abc/top"),
            ("GET", "/containers/abc/changes"),
            ("GET", "/containers/abc/export"),
            ("PUT", "/containers/abc/archive"),
            ("POST", "/containers/prune"),
            ("DELETE", "/exec/abc/start"),
            ("POST", "/images/create"),
            ("DELETE", "/images/abc"),
            ("POST", "/images/prune"),
            ("GET", "/images/json"),
            ("GET", "/networks"),
            ("DELETE", "/networks/celld"),
            ("POST", "/networks/celld/connect"),
            ("GET", "/volumes"),
            ("POST", "/volumes/create"),
            ("GET", "/plugins"),
            ("POST", "/auth"),
            ("GET", "/events"),
            ("POST", "/commit"),
            ("POST", "/build"),
            ("GET", "/distribution/abc/json"),
            // Ids are interpolated into the upstream path: an encoded `/`
            // or a dot segment would reroute the daemon past the allowlist.
            ("POST", "/containers/x%2F..%2F..%2Fbuild/start"),
            ("DELETE", "/containers/.."),
            ("GET", "/containers/../json"),
            ("POST", "/exec/%2E%2E/start"),
            ("GET", "/exec/.hidden/json"),
            ("GET", "/exec/abc/resize"),
            ("POST", "/exec/abc/resize/extra"),
            ("POST", "/exec/../resize"),
            ("POST", "/exec/%2E%2E/resize"),
        ] {
            assert!(
                matches!(classify(method, path), Route::Refused(_)),
                "{method} {path} refused"
            );
        }
        // Wrong methods on real routes refuse too.
        assert!(matches!(
            classify("DELETE", "/containers/abc/start"),
            Route::Refused(_)
        ));
        assert!(matches!(
            classify("POST", "/containers/abc/json"),
            Route::Refused(_)
        ));
        assert!(matches!(
            classify("GET", "/containers/abc/exec"),
            Route::Refused(_)
        ));
    }

    #[test]
    fn create_names_are_celld_shaped_or_absent() {
        assert_eq!(create_name(None), Ok(None));
        assert_eq!(create_name(Some("")), Ok(None));
        let name = "celld-0123456789abcdef01234567";
        assert_eq!(
            create_name(Some(&format!("name={name}"))),
            Ok(Some(name.to_string()))
        );
        for bad in [
            "name=",
            "name=celld-xyz",
            "name=celld-0123456789abcdef0123456",
            "name=celld-0123456789abcdef012345678",
            "name=celld-0123456789abcdef0123456g",
            "name=other-0123456789abcdef01234567",
            "name=celld-0123456789abcdef01234567&force=true",
            "force=true",
            "Name=celld-0123456789abcdef01234567",
        ] {
            assert!(create_name(Some(bad)).is_err(), "{bad} refused");
        }
    }

    #[test]
    fn image_names_are_content_tags() {
        assert!(valid_image_name(IMAGE));
        assert!(valid_image_name(&format!(
            "celld-image:{}",
            "ab".repeat(32)
        )));
        for bad in [
            "celld-image:short",
            "celld-image:",
            "celld-image:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "alpine:3.20",
            "noite:latest",
            "",
        ] {
            assert!(!valid_image_name(bad), "{bad} refused");
        }
    }

    #[test]
    fn list_filters_gain_the_fleet_label_and_keep_cellds() {
        // celld's real reap query shape: all=true plus one percent-encoded
        // {"label":["celld.node=N"]} filters object.
        let filters = percent_encode(&format!(r#"{{"label":["celld.node={NODE}"]}}"#));
        let rewritten = rewrite_list_query(Some(&format!("all=true&filters={filters}")), "shop");
        assert!(rewritten.starts_with("all=true&filters="), "{rewritten}");
        let encoded = rewritten.strip_prefix("all=true&filters=").unwrap();
        let object: Value = serde_json::from_str(&percent_decode(encoded).unwrap()).unwrap();
        let labels = object.pointer("/label").unwrap().as_array().unwrap();
        assert!(
            labels.contains(&json!(format!("celld.node={NODE}"))),
            "{labels:?}"
        );
        assert!(labels.contains(&json!("noite.fleet=shop")), "{labels:?}");
    }

    #[test]
    fn list_rewrite_never_leaves_an_open_list() {
        for query in [
            None,
            Some("all=true"),
            Some("all=true&filters=%7B%7D"),
            Some("all=true&filters=%5B%5D"),
            Some("all=true&filters=%%%"),
            Some("all=true&filters=%7B%22label%22%3A%22celld%2Enode%3Dx%22%7D"),
        ] {
            let rewritten = rewrite_list_query(query, "shop");
            let encoded = rewritten.rsplit("filters=").next().unwrap();
            let object: Value = serde_json::from_str(&percent_decode(encoded).unwrap()).unwrap();
            let labels = object.pointer("/label").unwrap().as_array().unwrap();
            assert_eq!(labels, &vec![json!("noite.fleet=shop")], "{query:?}");
        }
        // A second filters parameter cannot smuggle a wider list past the
        // rewrite: only one survives, and it carries the fleet.
        let encoded = percent_encode(r#"{"label":["celld.node=x"]}"#);
        let open = percent_encode(r#"{}"#);
        let rewritten = rewrite_list_query(
            Some(&format!("all=true&filters={encoded}&filters={open}")),
            "shop",
        );
        assert_eq!(rewritten.matches("filters=").count(), 1, "{rewritten}");
        assert!(rewritten.contains("noite"), "{rewritten}");
        // The daemon decodes keys: an encoded `filters` key is the same
        // parameter, so it is rewritten too, never forwarded beside ours.
        // Unknown keys are dropped.
        for query in [
            format!("all=true&%66ilters={open}"),
            format!("all=true&%66ilters={open}&filters={encoded}"),
            format!("all=true&%66%69%6c%74%65%72%73={open}&x%3Dy=1"),
        ] {
            let rewritten = rewrite_list_query(Some(&query), "shop");
            assert!(rewritten.starts_with("all=true&filters="), "{rewritten}");
            assert_eq!(rewritten.matches('&').count(), 1, "{rewritten}");
            let encoded = rewritten.rsplit("filters=").next().unwrap();
            let object: Value = serde_json::from_str(&percent_decode(encoded).unwrap()).unwrap();
            let labels = object.pointer("/label").unwrap().as_array().unwrap();
            assert!(labels.contains(&json!("noite.fleet=shop")), "{query}");
        }
    }

    #[test]
    fn app_create_accepts_cellds_body_and_injects_the_fleet() {
        let checked = validate_app_create(&app_create_body(), "shop").expect("celld's body");
        assert_eq!(checked.pointer("/Labels/noite.fleet"), Some(&json!("shop")));
        assert_eq!(
            checked.pointer("/Labels/celld.node"),
            Some(&json!(NODE)),
            "celld's own labels survive"
        );
        // The offline bridge and a body without Cmd (no tenant entrypoint)
        // are celld's too.
        let mut offline = app_create_body();
        offline["HostConfig"]["NetworkMode"] = json!("celld-internal");
        offline.as_object_mut().unwrap().remove("Cmd");
        validate_app_create(&offline, "shop").expect("offline body");
    }

    #[test]
    fn app_create_refuses_every_dangerous_variant() {
        let base = app_create_body();
        let mut variant = base.clone();
        variant["Privileged"] = json!(true);
        let mut cases: Vec<(&str, Value)> = vec![("Privileged", variant)];
        let mut host_cases: Vec<(&str, Value)> = vec![
            ("CapAdd", json!(["NET_ADMIN"])),
            ("Binds", json!(["/:/host"])),
            ("Runtime", json!("runc")),
            ("PidMode", json!("host")),
            ("IpcMode", json!("host")),
            ("UsernsMode", json!("host")),
            ("Devices", json!([])),
            ("Mounts", json!([])),
            ("PortBindings", json!({})),
            ("VolumesFrom", json!([])),
            ("Sysctls", json!({})),
            ("NetworkMode host", json!("host")),
            ("NetworkMode default bridge", json!("bridge")),
            ("NetworkMode none", json!("none")),
            ("missing NetworkMode", Value::Null),
            ("CapDrop missing", Value::Null),
            ("CapDrop empty", json!([])),
            ("SecurityOpt missing", Value::Null),
            ("PidsLimit missing", Value::Null),
            ("PidsLimit zero", json!(0)),
            ("PidsLimit huge", json!(999_999)),
            ("PidsLimit float", json!(1024.0)),
            ("PublishAllPorts true", json!(true)),
            ("Init false", json!(false)),
            ("Memory negative", json!(-1)),
            ("Memory zero (unlimited)", json!(0)),
            ("Memory huge", json!(1_u64 << 50)),
            ("missing Memory", Value::Null),
            ("NanoCpus zero (unlimited)", json!(0)),
            ("missing NanoCpus", Value::Null),
            ("MemorySwap unlimited", json!(-1)),
        ]
        .into_iter()
        .map(|(name, value)| {
            let mut body = base.clone();
            let host = body["HostConfig"].as_object_mut().unwrap();
            let key = name
                .strip_prefix("missing ")
                .unwrap_or_else(|| name.split(' ').next().unwrap());
            if value.is_null() {
                host.remove(key);
            } else {
                host.insert(key.to_string(), value);
            }
            (name, body)
        })
        .collect();
        cases.append(&mut host_cases);
        let mut no_host = base.clone();
        no_host.as_object_mut().unwrap().remove("HostConfig");
        cases.push(("missing HostConfig", no_host));
        let mut foreign_label = base.clone();
        foreign_label["Labels"]["noite.fleet"] = json!("other");
        cases.push(("foreign noite.fleet label", foreign_label));
        let mut foreign_prefix = base.clone();
        foreign_prefix["Labels"]["noite.evil"] = json!("1");
        cases.push(("foreign noite.* label", foreign_prefix));
        let mut other_image = base.clone();
        other_image["Image"] = json!("alpine:3.20");
        cases.push(("non-celld image", other_image));
        for loose in [
            "celld-image:evil",
            "celld-image:foo/bar",
            "celld-image:abc@sha256:00",
        ] {
            let mut body = base.clone();
            body["Image"] = json!(loose);
            cases.push(("loose celld-image tag", body));
        }
        for (name, body) in cases {
            assert!(
                validate_app_create(&body, "shop").is_err(),
                "{name} refused"
            );
        }
    }

    #[test]
    fn fence_create_runs_cellds_rules_from_the_runner_image() {
        const TRUSTED: &str = "sha256:runner-image";
        let checked =
            validate_fence_create(&fence_create_body(), "shop", TRUSTED).expect("celld's fence");
        // Whatever celld-image tag celld named, the host-network container
        // runs the runner's image with celld's exact ruleset and command.
        assert_eq!(checked.pointer("/Image"), Some(&json!(TRUSTED)));
        assert_eq!(
            checked.pointer("/Entrypoint"),
            Some(&json!(["sh", "-c", FENCE_CMD]))
        );
        assert_eq!(checked.get("Cmd"), None);
        assert_eq!(
            checked.pointer("/Env"),
            Some(&json!([format!("CELLD_NFT={FENCE_RULES}")]))
        );
        assert_eq!(checked.pointer("/Labels/noite.fleet"), Some(&json!("shop")));
        assert_eq!(checked.pointer("/Labels/celld.node"), Some(&json!(NODE)));
        assert_eq!(
            checked.pointer("/HostConfig"),
            Some(&json!({ "NetworkMode": "host", "CapAdd": ["NET_ADMIN"] }))
        );
    }

    #[test]
    fn fence_create_refuses_anything_but_cellds_installer() {
        let base = fence_create_body();
        let mut altered_rules = base.clone();
        altered_rules["Env"] = json!([format!(
            "CELLD_NFT={}",
            FENCE_RULES.replace("reject", "accept")
        )]);
        let mut extra_env = base.clone();
        extra_env["Env"] = json!([format!("CELLD_NFT={FENCE_RULES}"), "EXTRA=1"]);
        let mut altered_cmd = base.clone();
        altered_cmd["Cmd"] = json!(["sh", "-c", "nft -f /etc/evil.nft"]);
        let mut extra_key = base.clone();
        extra_key["User"] = json!("0");
        let mut privileged_host = base.clone();
        privileged_host["HostConfig"]["Privileged"] = json!(true);
        let mut extra_cap = base.clone();
        extra_cap["HostConfig"]["CapAdd"] = json!(["NET_ADMIN", "SYS_ADMIN"]);
        let mut other_image = base.clone();
        other_image["Image"] = json!("alpine:3.20");
        let mut fence_zero = base.clone();
        fence_zero["Labels"]["celld.fence"] = json!("0");
        for (name, body) in [
            ("altered rules", altered_rules),
            ("extra env", extra_env),
            ("altered cmd", altered_cmd),
            ("extra top-level key", extra_key),
            ("privileged fence", privileged_host),
            ("extra capability", extra_cap),
            ("non-celld image", other_image),
            ("fence label off", fence_zero),
        ] {
            assert!(
                validate_fence_create(&body, "shop", "sha256:runner-image").is_err(),
                "{name} refused"
            );
        }
        // And the fence shape never passes the app validator either: host
        // networking is only ever the installer's.
        assert!(validate_app_create(&base, "shop").is_err());
    }

    #[test]
    fn exec_bodies_match_cellds_two_forms() {
        validate_exec_create(&json!({
            "AttachStdin": true, "AttachStdout": true, "AttachStderr": true,
            "Tty": false, "Cmd": ["bun", "x", "lint"],
            "Env": ["MODEL=faux"], "WorkingDir": "/work", "User": "1000",
        }))
        .expect("celld's exec");
        // The kill-via-exec form (celld 0015): no stdio, no Tty key at
        // all, a `sh -c` scan for the exec's marker.
        validate_exec_create(&kill_exec_body(12, 9, None)).expect("celld's kill exec");
        validate_exec_start(&json!({ "Detach": false, "Tty": false })).expect("hijacked start");
        validate_exec_start(&json!({ "Detach": true })).expect("detached start");
        for (name, body) in [
            (
                "privileged exec",
                json!({"Cmd": ["id"], "Privileged": true}),
            ),
            ("string tty", json!({"Cmd": ["id"], "Tty": "yes"})),
            ("detach extras", json!({"Cmd": ["id"], "Detach": true})),
            ("missing cmd", json!({"AttachStdout": true})),
            ("empty cmd", json!({"Cmd": []})),
            ("numeric tty start", json!({"Detach": false, "Tty": 1})),
            ("extra start key", json!({"Detach": false, "Cmd": ["id"]})),
        ] {
            let refused = if name.ends_with("start") {
                validate_exec_start(&body).is_err()
            } else {
                validate_exec_create(&body).is_err()
            };
            assert!(refused, "{name} refused");
        }
    }

    #[test]
    fn exec_accepts_cellds_pty_forms() {
        // celld's PTY exec create: the same attach flags as a plain exec,
        // with `Tty` true (`container.rs` `exec_create_body`).
        validate_exec_create(&json!({
            "AttachStdin": true, "AttachStdout": true, "AttachStderr": true,
            "Tty": true, "Cmd": ["sh"],
            "Env": ["MODEL=faux"], "WorkingDir": "/work", "User": "1000",
        }))
        .expect("celld's pty exec");
        validate_exec_start(&json!({ "Detach": false, "Tty": true })).expect("pty start");
    }

    #[test]
    fn kill_exec_shape_matches_celld_0015_exactly() {
        // The abort path (celld 0010) kills through this shape: the scan
        // carries the target exec's marker and the signal, runs as the
        // exec's user when it had one, and starts detached.
        for (id, signal, user) in [(12, 9, None), (7, 15, Some("nobody"))] {
            let body = kill_exec_body(id, signal, user);
            validate_exec_create(&body).expect("celld's kill exec");
            let script = body["Cmd"][2].as_str().expect("scan script");
            assert!(script.contains(&format!("CELLD_EXEC_ID={id};")), "{script}");
            assert!(script.contains(&format!("kill -{signal} ")), "{script}");
            assert_eq!(
                body.get("User").and_then(Value::as_str),
                user,
                "kill runs as the exec's user"
            );
        }
        validate_exec_start(&json!({ "Detach": true })).expect("detached kill start");
        // Near-misses: the kill shape with anything extra or mistyped is
        // refused, exactly like any other exec.
        let base = kill_exec_body(12, 9, Some("nobody"));
        let mut privileged = base.clone();
        privileged["Privileged"] = json!(true);
        let mut detached = base.clone();
        detached["Detach"] = json!(true);
        let mut string_cmd = base.clone();
        string_cmd["Cmd"] = json!("sh -c true");
        let mut empty_cmd = base.clone();
        empty_cmd["Cmd"] = json!([]);
        let mut object_env = base.clone();
        object_env["Env"] = json!({"CELLD_EXEC_ID": "12;"});
        let mut string_tty = base.clone();
        string_tty["Tty"] = json!("no");
        let mut numeric_user = base.clone();
        numeric_user["User"] = json!(0);
        let mut numeric_dir = base.clone();
        numeric_dir["WorkingDir"] = json!(42);
        let mut missing_cmd = base.clone();
        missing_cmd
            .as_object_mut()
            .expect("kill body is an object")
            .remove("Cmd");
        for (name, body) in [
            ("privileged kill", privileged),
            ("detach extras", detached),
            ("string cmd", string_cmd),
            ("empty cmd", empty_cmd),
            ("missing cmd", missing_cmd),
            ("object env", object_env),
            ("string tty", string_tty),
            ("numeric user", numeric_user),
            ("numeric working dir", numeric_dir),
        ] {
            assert!(validate_exec_create(&body).is_err(), "{name} refused");
        }
    }

    #[test]
    fn resize_routes_match_only_the_resize_call() {
        assert_eq!(
            classify("POST", "/exec/abc/resize"),
            Route::ExecResize { id: "abc" }
        );
        for (method, path) in [
            ("GET", "/exec/abc/resize"),
            ("DELETE", "/exec/abc/resize"),
            ("POST", "/exec/abc/resize/extra"),
            ("POST", "/exec/../resize"),
            ("POST", "/exec/.hidden/resize"),
            ("POST", "/exec/%2E%2E/resize"),
            ("POST", "/exec//resize"),
        ] {
            assert!(
                matches!(classify(method, path), Route::Refused(_)),
                "{method} {path} refused"
            );
        }
    }

    #[test]
    fn resize_query_rebuilds_exactly_h_and_w() {
        assert_eq!(
            validate_exec_resize_query(Some("h=30&w=100")),
            Ok("h=30&w=100".to_string())
        );
        // Order is canonicalized, bounds are inclusive, leading zeroes are
        // normalized away.
        assert_eq!(
            validate_exec_resize_query(Some("w=100&h=30")),
            Ok("h=30&w=100".to_string())
        );
        assert_eq!(
            validate_exec_resize_query(Some("h=1&w=65535")),
            Ok("h=1&w=65535".to_string())
        );
        assert_eq!(
            validate_exec_resize_query(Some("h=007&w=0100")),
            Ok("h=7&w=100".to_string())
        );
        for bad in [
            None,
            Some(""),
            // Missing a dimension.
            Some("h=30"),
            Some("w=100"),
            Some("h=30&w="),
            // Extra parameters, including an empty one.
            Some("h=30&w=100&signal=9"),
            Some("h=30&w=100&"),
            Some("&h=30&w=100"),
            // Duplicates.
            Some("h=30&h=31&w=100"),
            Some("h=30&w=100&w=101"),
            // Non-numeric.
            Some("h=x&w=100"),
            Some("h=30&w=1e2"),
            Some("h=3.0&w=100"),
            Some("h=+30&w=100"),
            Some("h=%33%30&w=100"),
            Some("h= 30&w=100"),
            Some("H=30&w=100"),
            Some("h"),
            // Out of range.
            Some("h=0&w=100"),
            Some("h=30&w=0"),
            Some("h=65536&w=100"),
            Some("h=30&w=65536"),
            Some("h=99999999999999999999&w=100"),
        ] {
            assert!(validate_exec_resize_query(bad).is_err(), "{bad:?} refused");
        }
    }

    #[test]
    fn fence_is_recognised_by_label_or_host_network() {
        assert!(inspect_is_fence(
            &json!({"Config": {"Labels": {"celld.fence": "1"}}})
        ));
        assert!(inspect_is_fence(
            &json!({"Config": {"Labels": {"celld.fence": "0"}}})
        ));
        assert!(inspect_is_fence(
            &json!({"HostConfig": {"NetworkMode": "host"}})
        ));
        assert!(!inspect_is_fence(&json!({
            "Config": {"Labels": {"celld.cell": "c"}},
            "HostConfig": {"NetworkMode": "celld"},
        })));
    }

    #[test]
    fn network_inspect_hides_every_member() {
        let upstream = json!({
            "Name": "celld",
            "Internal": false,
            "Options": {
                "com.docker.network.bridge.enable_icc": "false",
                "com.docker.network.bridge.name": "celld0",
            },
            "Containers": {
                "abc": { "Name": "celld-0123456789abcdef01234567", "IPv4Address": "172.19.0.2/16" },
            },
        });
        let filtered: Value =
            serde_json::from_slice(&without_network_members(upstream.to_string().as_bytes()))
                .unwrap();
        assert_eq!(filtered["Containers"], json!({}));
        // What celld decides on survives.
        assert_eq!(filtered["Options"], upstream["Options"]);
        assert_eq!(filtered["Internal"], json!(false));
        // An engine error passes through untouched.
        assert_eq!(&without_network_members(b"not json")[..], b"not json");
    }

    #[test]
    fn network_create_accepts_only_cellds_two_bridges() {
        for (name, internal, bridge) in [
            ("celld", false, "celld0"),
            ("celld-internal", true, "celld1"),
        ] {
            validate_network_create(&json!({
                "Name": name, "Driver": "bridge", "Internal": internal,
                "Options": {
                    "com.docker.network.bridge.enable_icc": "false",
                    "com.docker.network.bridge.name": bridge,
                },
            }))
            .expect(name);
        }
        assert!(valid_network_name("celld"));
        assert!(valid_network_name("celld-internal"));
        assert!(!valid_network_name("bridge"));
        assert!(!valid_network_name("evil"));
        for (name, body) in [
            (
                "icc on",
                json!({
                    "Name": "celld", "Driver": "bridge", "Internal": false,
                    "Options": {
                        "com.docker.network.bridge.enable_icc": "true",
                        "com.docker.network.bridge.name": "celld0",
                    },
                }),
            ),
            (
                "wrong bridge iface",
                json!({
                    "Name": "celld", "Driver": "bridge", "Internal": false,
                    "Options": {
                        "com.docker.network.bridge.enable_icc": "false",
                        "com.docker.network.bridge.name": "celld9",
                    },
                }),
            ),
            (
                "swapped isolation",
                json!({
                    "Name": "celld", "Driver": "bridge", "Internal": true,
                    "Options": {
                        "com.docker.network.bridge.enable_icc": "false",
                        "com.docker.network.bridge.name": "celld0",
                    },
                }),
            ),
            (
                "foreign bridge",
                json!({
                    "Name": "evil", "Driver": "bridge", "Internal": false,
                    "Options": {
                        "com.docker.network.bridge.enable_icc": "false",
                        "com.docker.network.bridge.name": "celld0",
                    },
                }),
            ),
            (
                "overlay driver",
                json!({
                    "Name": "celld", "Driver": "overlay", "Internal": false,
                    "Options": {
                        "com.docker.network.bridge.enable_icc": "false",
                        "com.docker.network.bridge.name": "celld0",
                    },
                }),
            ),
        ] {
            assert!(validate_network_create(&body).is_err(), "{name} refused");
        }
    }

    #[test]
    fn inspect_helpers_read_labels_identity_and_addresses() {
        let info = json!({
            "Id": "abc123",
            "Name": "/celld-0123456789abcdef01234567",
            "Config": { "Labels": { "celld.node": NODE, "noite.fleet": "shop" } },
            "NetworkSettings": { "Networks": {
                "celld": { "IPAddress": "172.19.0.2" },
                "celld-internal": { "IPAddress": "" },
            } },
        });
        assert_eq!(inspect_fleet_label(&info).as_deref(), Some("shop"));
        assert_eq!(
            inspect_identity(&info),
            (
                Some("abc123".to_string()),
                Some("celld-0123456789abcdef01234567".to_string())
            )
        );
        assert_eq!(inspect_ips(&info), vec![Ipv4Addr::new(172, 19, 0, 2)]);
        assert_eq!(inspect_fleet_label(&json!({"Config": {}})), None);
        assert!(inspect_ips(&json!({})).is_empty());
    }
}
