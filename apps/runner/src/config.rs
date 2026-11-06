use std::env;

use crate::host::credentials::{Credentials, ProviderSetting, StoreAccess};

/// Process-wide lock serializing tests that mutate process env (and every
/// other test that reads the whole env through `Config::from_env`): tests run
/// in threads, so an uncleared `RUNNER_POLL_MS=abc` would otherwise fail a
/// parallel `from_env().expect(...)` elsewhere.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Caddy `auto_https`: explicit off wins (behind-proxy deployments like
/// Coolify, where Traefik TCP-forwards SNI and our Caddy terminates per-host
/// TLS itself via on-demand certs); otherwise on except the `localhost`
/// family (a `*.localhost` dev base serves plain http too).
/// Comma-separated hostname list (`CONTROL_EXTRA_HOSTS`).
fn parse_host_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect()
}

fn parse_auto_https(raw: Option<&str>, base_domain: &str) -> bool {
    // An empty value means "not configured" (compose renders
    // `CADDY_AUTO_HTTPS: ""` when the operator leaves it unset), so trim and
    // treat it as absent rather than as an explicit on.
    let raw = raw.map(str::trim).filter(|value| !value.is_empty());
    match raw {
        Some("off") | Some("0") | Some("false") => false,
        Some(_) => true,
        None => !is_localhost_domain(base_domain),
    }
}

fn env_or(keys: &[&str], default: &str) -> String {
    for key in keys {
        if let Ok(v) = env::var(key) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    default.to_string()
}

/// `S3_ENDPOINT` without userinfo. Every store client here and in celld
/// signs with the access keys (SigV4), so URL credentials never
/// authenticated anything, but the endpoint travels on: fleet argv and env,
/// celld CLI env, release-command env, the control Worker. Stripping once
/// at load keeps credentials out of all of them; `main` warns when it did.
/// An unparseable endpoint passes through verbatim so it fails loudly where
/// it is used instead of as a rewritten URL. Apart from the userinfo the
/// value stays byte-identical.
pub fn strip_endpoint_userinfo(endpoint: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(endpoint) else {
        return endpoint.to_string();
    };
    if url.username().is_empty() && url.password().is_none() {
        return endpoint.to_string();
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    let mut out = url.to_string();
    // Serializing adds a `/` to a bare host: drop it again.
    if url.path() == "/" && !endpoint.ends_with('/') {
        out.truncate(out.len().saturating_sub(1));
    }
    out
}

/// Host part of an http(s) URL without new deps: strip scheme, authority,
/// port. None when no `://` or empty host. A bracketed literal yields its
/// address (`https://[::1]:8080/x` → `::1`); splitting the port at the
/// first colon would return `[` instead.
fn url_host(raw: &str) -> Option<String> {
    let (_, rest) = raw.split_once("://")?;
    let auth = rest.split('/').next().unwrap_or("");
    let auth = auth.split('@').next_back().unwrap_or("");
    let host = if let Some(bracketed) = auth.strip_prefix('[') {
        bracketed.split(']').next().unwrap_or("")
    } else {
        auth.split(':').next().unwrap_or("")
    };
    let host = host.trim().trim_matches('.');
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tenancy {
    Single,
    Multi,
}

impl Tenancy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tenancy::Single => "single",
            Tenancy::Multi => "multi",
        }
    }
}

fn parse_tenancy(raw: Option<&str>, base_domain: &str) -> Tenancy {
    let raw = raw
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_ascii_lowercase());
    match raw.as_deref() {
        Some("single") => Tenancy::Single,
        Some("multi") => Tenancy::Multi,
        _ => {
            if is_localhost_domain(base_domain) {
                Tenancy::Single
            } else {
                Tenancy::Multi
            }
        }
    }
}

/// Telemetry DuckDB's derived memory cap: 10% of the memory this container
/// may use, clamped 128..1024 MiB. Hidden is the alternative: DuckDB's own
/// default is 80% of the machine, and on a 2 GB install that single scan is
/// larger than every resident fleet together (`apps/runner/src/host/memory.rs`
/// is the detection). 256 MiB when memory is unreadable.
fn duckdb_memory_default_mb(total_bytes: Option<u64>) -> u64 {
    let Some(total) = total_bytes else {
        return 256;
    };
    (total / 10 / (1024 * 1024)).clamp(128, 1024)
}

/// Telemetry DuckDB's derived worker count: the cores this container may
/// use, capped at 4. A big host does not need a 32-thread scan for an
/// hourly aggregation, and the memory cap (not the thread count) is what
/// keeps the scan off the fleets: a 2 vCPU box finishes in half the time
/// with both cores than with one.
fn duckdb_threads_default(cores: usize) -> u32 {
    cores.clamp(1, 4) as u32
}

/// Parse one numeric env var: unset or blank means the default (compose
/// renders an unset var as an empty string, so blank counts as unset — never
/// as a value). A set-but-malformed value records a boot problem naming the
/// var, its value and the expected form, and yields the default so `from_env`
/// still builds a `Config` for `validate` to refuse all at once.
fn env_num<T>(key: &str, default: T, expected: &str, problems: &mut Vec<String>) -> T
where
    T: std::str::FromStr + Copy,
{
    let raw = match env::var(key) {
        Err(_) => return default,
        Ok(v) if v.trim().is_empty() => return default,
        Ok(v) => v,
    };
    match raw.trim().parse() {
        Ok(v) => v,
        Err(_) => {
            problems.push(format!("{key} must be {expected}, got {:?}", raw.trim()));
            default
        }
    }
}

/// Strict `Option<u32>` env var (`RUNNER_BUILD_UID_BASE`, `RUNNER_FLEET_UID`,
/// `RUNNER_FLEET_GID`): unset/blank is the default, `none`/`disabled`/`-1`
/// unsets it, anything else must be a user id.
fn env_opt_uid(key: &str, default: u32, problems: &mut Vec<String>) -> Option<u32> {
    let raw = match env::var(key) {
        Err(_) => return Some(default),
        Ok(v) if v.trim().is_empty() => return Some(default),
        Ok(v) => v,
    };
    match raw.trim() {
        "none" | "disabled" | "-1" => None,
        v => match v.parse() {
            Ok(n) => Some(n),
            Err(_) => {
                problems.push(format!(
                    "{key} must be a user id, `none`, `disabled` or `-1`, got {v:?}"
                ));
                Some(default)
            }
        },
    }
}

/// `NOITE_TELEMETRY` kill switch: `0`/`false`/`off` (case-insensitive) lock the
/// instance heartbeat off. Anything else — including unset — leaves it on
/// (opt-out).
pub fn parse_telemetry_disabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("0") | Some("false") | Some("off")
    )
}
/// `NOITE_UPDATE_CHECK` force-off: `0`/`false`/`off` (case-insensitive) lock
/// the opt-out update check off. Anything else — including unset — leaves the
/// stored preference (on unless the admin disables it) in charge.
pub fn parse_update_check_disabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("0") | Some("false") | Some("off")
    )
}

/// `NOITE_SANDBOX` force-off: `0`/`false`/`off` (case-insensitive) disables
/// Sandbox containers for the whole install (no engine proxy, no relay, and
/// fleets get no `DOCKER_HOST`); deploys declaring `containers` are refused.
/// Anything else, including unset, leaves them on when an engine answers.
pub fn parse_sandbox_disabled(raw: Option<&str>) -> bool {
    parse_update_check_disabled(raw)
}

/// `DO_NOT_TRACK` (https://donottrack.sh): any non-empty value other than `0`
/// is a global opt-out and locks telemetry off.
pub fn parse_do_not_track(raw: Option<&str>) -> bool {
    raw.map(str::trim)
        .is_some_and(|v| !v.is_empty() && v != "0")
}

/// Strict opt-in flag (`NOITE_VOID_AI_ENABLED`, `NOITE_VOID_SMTP_ALLOW_PLAINTEXT`,
/// `NOITE_VOID_AI_ALLOW_PLAINTEXT`):
/// unset or blank is off, `1`/`true`/`on` (case-insensitive) is on,
/// `0`/`false`/`off` is explicitly off, and anything else records a boot
/// problem naming the var — a typo'd `yes` must fail loudly, never arm a
/// capability (or silently leave one off).
fn env_flag(key: &str, problems: &mut Vec<String>) -> bool {
    let raw = match env::var(key) {
        Err(_) => return false,
        Ok(v) if v.trim().is_empty() => return false,
        Ok(v) => v,
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" => true,
        "0" | "false" | "off" => false,
        _ => {
            problems.push(format!(
                "{} must be `1`, `true` or `on` (or unset), got {:?}",
                key,
                raw.trim()
            ));
            false
        }
    }
}

/// SMTP transport mode for the Void proxy's relay (`NOITE_VOID_SMTP_MODE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum VoidSmtpMode {
    #[default]
    Starttls,
    Implicit,
    Plain,
}

impl VoidSmtpMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            VoidSmtpMode::Starttls => "starttls",
            VoidSmtpMode::Implicit => "implicit",
            VoidSmtpMode::Plain => "plain",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "starttls" => Some(VoidSmtpMode::Starttls),
            "implicit" => Some(VoidSmtpMode::Implicit),
            "plain" => Some(VoidSmtpMode::Plain),
            _ => None,
        }
    }
}

/// Operator config for Noite's Void platform proxy (SPEC, Void platform
/// proxy): what every Void fleet's `noite-void-proxy` script renders from.
/// Email and AI are both off unless configured here; per-app credentials
/// (SMTP user/password, AI endpoint key) are tenant settings, never
/// operator config — proxy vars are plaintext in the fleet bucket, so no
/// operator-wide secret may ever land in them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VoidProxyConfig {
    /// Sender domain every `from` address is pinned to
    /// (`NOITE_VOID_EMAIL_DOMAIN` → `__VOID_EMAIL_DOMAIN`, proxy and app).
    pub email_domain: String,
    /// SMTP relay host (`NOITE_VOID_SMTP_HOST`); email is enabled iff set.
    pub smtp_host: String,
    /// Explicit relay port (`NOITE_VOID_SMTP_PORT`); unset leaves the
    /// proxy's per-mode default (587/465/25).
    pub smtp_port: Option<u16>,
    /// Relay transport (`NOITE_VOID_SMTP_MODE`).
    pub smtp_mode: VoidSmtpMode,
    /// `plain` transport allowed (`NOITE_VOID_SMTP_ALLOW_PLAINTEXT=1`):
    /// without it the proxy refuses `plain` outright.
    pub smtp_allow_plaintext: bool,
    /// Admission allowlist (`NOITE_VOID_EMAIL_ALLOWLIST`, comma/whitespace
    /// separated): exact addresses or `@domain` suffixes. Empty fails
    /// closed — every recipient is unverified.
    pub email_allowlist: Vec<String>,
    /// `/ai/*` live (`NOITE_VOID_AI_ENABLED=1`); otherwise every AI call
    /// answers 501.
    pub ai_enabled: bool,
    /// Model map JSON for `/ai/run` (`NOITE_VOID_AI_MODELS`):
    /// `{ "<model>": { "endpoint", "model" } }`. Validated at boot.
    pub ai_models: String,
    /// Plaintext AI endpoints allowed (`NOITE_VOID_AI_ALLOW_PLAINTEXT=1`):
    /// without it every `http://` model endpoint fails the boot, and with
    /// it only loopback endpoints boot — the per-app key travels in the
    /// upstream `Authorization` header, so plaintext past loopback would
    /// leak it on the wire. In multi tenancy the allowance is inert:
    /// loopback endpoints are unreachable from tenant fleets, so they
    /// fail the boot with or without it.
    pub ai_allow_plaintext: bool,
}

impl VoidProxyConfig {
    fn from_env(problems: &mut Vec<String>) -> Self {
        let smtp_mode = match env::var("NOITE_VOID_SMTP_MODE") {
            Err(_) => VoidSmtpMode::Starttls,
            Ok(v) if v.trim().is_empty() => VoidSmtpMode::Starttls,
            Ok(v) => match VoidSmtpMode::parse(&v) {
                Some(mode) => mode,
                None => {
                    problems.push(format!(
                        "NOITE_VOID_SMTP_MODE must be `starttls`, `implicit` or `plain`, got {:?}",
                        v.trim()
                    ));
                    VoidSmtpMode::Starttls
                }
            },
        };
        let smtp_port = match env::var("NOITE_VOID_SMTP_PORT") {
            Err(_) => None,
            Ok(v) if v.trim().is_empty() => None,
            Ok(v) => match v.trim().parse::<u16>() {
                Ok(0) | Err(_) => {
                    problems.push(format!(
                        "NOITE_VOID_SMTP_PORT must be a port number (1-65535), got {:?}",
                        v.trim()
                    ));
                    None
                }
                Ok(port) => Some(port),
            },
        };
        Self {
            email_domain: env::var("NOITE_VOID_EMAIL_DOMAIN")
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            smtp_host: env::var("NOITE_VOID_SMTP_HOST")
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            smtp_port,
            smtp_mode,
            smtp_allow_plaintext: env_flag("NOITE_VOID_SMTP_ALLOW_PLAINTEXT", problems),
            email_allowlist: env::var("NOITE_VOID_EMAIL_ALLOWLIST")
                .map(|v| {
                    v.split([',', ' ', '\t', '\n'])
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            ai_enabled: env_flag("NOITE_VOID_AI_ENABLED", problems),
            ai_models: env::var("NOITE_VOID_AI_MODELS")
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            ai_allow_plaintext: env_flag("NOITE_VOID_AI_ALLOW_PLAINTEXT", problems),
        }
    }

    /// Boot validation for the proxy section, appended to `validate`'s
    /// problems: shapes first, then the cross-field rules that would
    /// otherwise fail only at send time. In multi tenancy the relay and
    /// every AI endpoint must additionally be publicly reachable — the
    /// proxy runs in the tenant fleet, whose egress policy rejects
    /// loopback/private destinations.
    fn validate(&self, tenancy: Tenancy, problems: &mut Vec<String>) {
        if !self.email_domain.is_empty()
            && (self
                .email_domain
                .contains([' ', '\t', '\n', '\r', '@', '/'])
                || !self.email_domain.contains('.'))
        {
            problems.push(format!(
                "NOITE_VOID_EMAIL_DOMAIN must be a bare domain (e.g. `mail.example.com`), got {:?}",
                self.email_domain
            ));
        }
        if self.smtp_host.contains([' ', '\t', '\n', '\r']) {
            problems.push(format!(
                "NOITE_VOID_SMTP_HOST must be a hostname or IP, got {:?}",
                self.smtp_host
            ));
        }
        for entry in &self.email_allowlist {
            let ok = !entry.contains([' ', '\t', '\n', '\r'])
                && (entry
                    .strip_prefix('@')
                    .is_some_and(|rest| !rest.is_empty() && !rest.contains('@'))
                    || entry.split_once('@').is_some_and(|(local, domain)| {
                        !local.is_empty() && !domain.is_empty() && !domain.contains('@')
                    }));
            if !ok {
                problems.push(format!(
                    "NOITE_VOID_EMAIL_ALLOWLIST entry {:?} must be an exact address (`user@example.com`) or a domain suffix (`@example.com`)",
                    entry
                ));
            }
        }
        if !self.smtp_host.is_empty() && self.email_domain.is_empty() {
            problems.push(
                "NOITE_VOID_SMTP_HOST is set but NOITE_VOID_EMAIL_DOMAIN is empty (the proxy pins every sender to <slug>@<domain>)"
                    .into(),
            );
        }
        if self.smtp_mode == VoidSmtpMode::Plain && !self.smtp_allow_plaintext {
            problems.push(
                "NOITE_VOID_SMTP_MODE=plain needs NOITE_VOID_SMTP_ALLOW_PLAINTEXT=1 (the proxy refuses plaintext SMTP without it)"
                    .into(),
            );
        }
        let smtp_refusal = if tenancy == Tenancy::Multi && !self.smtp_host.is_empty() {
            proxy_egress_refusal(&self.smtp_host)
        } else {
            None
        };
        if let Some(reason) = smtp_refusal {
            problems.push(format!(
                "NOITE_VOID_SMTP_HOST {:?} is unreachable from tenant fleets in multi tenancy ({}; fleet egress rejects loopback and private destinations, so use a publicly reachable relay)",
                self.smtp_host, reason
            ));
        }
        if !self.ai_models.is_empty() {
            match serde_json::from_str::<serde_json::Value>(&self.ai_models) {
                Ok(serde_json::Value::Object(map)) => {
                    for (model, mapping) in &map {
                        let endpoint = mapping.get("endpoint").and_then(|v| v.as_str());
                        let target = mapping.get("model").and_then(|v| v.as_str());
                        let endpoint_ok = endpoint.is_some_and(|url| {
                            (url.starts_with("http://") || url.starts_with("https://"))
                                && url_host(url).is_some()
                        });
                        if !endpoint_ok {
                            problems.push(format!(
                                "NOITE_VOID_AI_MODELS[{:?}] needs an `endpoint` http(s) URL, got {}",
                                model,
                                endpoint.map_or("nothing".to_string(), |u| format!("{:?}", u))
                            ));
                        }
                        // Plaintext AI endpoints carry the per-app key in an
                        // `Authorization` header, so `http` needs the
                        // explicit allowance — and even then only loopback
                        // sidecars boot (anything past loopback would leak
                        // the key on the wire).
                        if let Some(url) = endpoint.filter(|url| url.starts_with("http://")) {
                            if !self.ai_allow_plaintext {
                                problems.push(format!(
                                    "NOITE_VOID_AI_MODELS[{:?}] uses a plaintext http endpoint; set NOITE_VOID_AI_ALLOW_PLAINTEXT=1 to allow http loopback endpoints",
                                    model
                                ));
                            } else if !url_host(url).is_some_and(|host| is_loopback_host(&host)) {
                                problems.push(format!(
                                    "NOITE_VOID_AI_MODELS[{:?}] uses a plaintext http endpoint to a non-loopback host (http endpoints must be loopback sidecars)",
                                    model
                                ));
                            }
                        }
                        let endpoint_refusal = if tenancy == Tenancy::Multi {
                            endpoint.and_then(url_host).and_then(|host| {
                                proxy_egress_refusal(&host).map(|reason| (host, reason))
                            })
                        } else {
                            None
                        };
                        if let Some((host, reason)) = endpoint_refusal {
                            problems.push(format!(
                                "NOITE_VOID_AI_MODELS[{:?}] endpoint host {:?} is unreachable from tenant fleets in multi tenancy ({}; fleet egress rejects loopback and private destinations, so use a publicly reachable endpoint)",
                                model, host, reason
                            ));
                        }
                        if target.is_none_or(|m| m.trim().is_empty()) {
                            problems.push(format!(
                                "NOITE_VOID_AI_MODELS[{:?}] needs a non-empty `model` name",
                                model
                            ));
                        }
                    }
                }
                _ => problems.push(
                    "NOITE_VOID_AI_MODELS must be a JSON object like `{\"<model>\": {\"endpoint\": \"https://…\", \"model\": \"…\"}}`"
                        .into(),
                ),
            }
        }
        if !self.ai_models.is_empty() && !self.ai_enabled {
            problems.push(
                "NOITE_VOID_AI_MODELS is set but NOITE_VOID_AI_ENABLED is not `1` (every AI call would answer 501)"
                    .into(),
            );
        }
    }
}

/// Whether a base domain is the `localhost` family: bare `localhost` or any
/// `*.localhost` name. Browsers resolve every `*.localhost` host to loopback
/// and treat it as a secure context, so the dev stack runs on
/// `noite.localhost` (same registrable domain for the control UI and every
/// app/preview host — privacy browsers refuse a cross-site frame's IndexedDB
/// and service workers). Every dev-only shortcut keys on this, never on the
/// literal `localhost`, or a `*.localhost` dev install would be treated as a
/// real domain (TLS on the plaintext dev edge, refused dev secrets, multi
/// tenancy).
pub fn is_localhost_domain(domain: &str) -> bool {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    domain == "localhost" || domain.ends_with(".localhost")
}

/// Whether a base domain is local/dev-only: the `localhost` family (see
/// [`is_localhost_domain`]), `*.local`, `*.test`, `*.internal`, or an IP
/// literal. Such an install never reports (a dev box, the e2e lane, or a LAN
/// name); an sslip.io install resolves to an IP but is a real public host, so
/// it does report.
/// Whether a URL host is loopback: an IP literal in `127/8` or `::1`, or
/// the `localhost` family. Plaintext AI endpoints are only ever allowed
/// here — a LAN name still crosses the wire in cleartext.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_matches('.');
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    is_localhost_domain(host)
}

/// Whether an IPv4 literal sits in carrier-grade NAT space
/// (`100.64.0.0/10`, RFC 6598): no `is_*` API covers it, so match the
/// prefix (`100.64`–`100.127` in the second octet).
fn is_cgnat_v4(ip: &std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (octets[1] & 0xc0) == 0x40
}

/// Why a Void proxy upstream host (`NOITE_VOID_SMTP_HOST`, an
/// `NOITE_VOID_AI_MODELS` endpoint) can never answer from a tenant fleet
/// in multi tenancy: the fleet egress policy rejects fleet→loopback/private
/// destinations, so the boot refuses it instead of 502ing at send time.
/// Literal IPs classify by range (loopback, private including ULA,
/// link-local, CGNAT); names classify by obviously-local form only — boot
/// resolves nothing, so a name that merely points inside still fails at
/// send time.
fn proxy_egress_refusal(host: &str) -> Option<&'static str> {
    let host = host.trim().trim_matches('.');
    // A `:port` suffix is not part of the contract (the relay port is its
    // own var; endpoint URLs lose theirs in `url_host`), but classify the
    // host part anyway so `127.0.0.1:2525` still refuses. Only a single
    // colon strips, so IPv6 literals pass through untouched.
    let host = match host.split_once(':') {
        Some((bare, port))
            if !port.contains(':')
                && !port.is_empty()
                && port.bytes().all(|b| b.is_ascii_digit()) =>
        {
            bare
        }
        _ => host,
    };
    let bare = host.trim_matches(['[', ']']);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return match ip {
            ip if ip.is_unspecified() => Some("unspecified address"),
            std::net::IpAddr::V4(v4) if v4.is_loopback() => Some("loopback address"),
            std::net::IpAddr::V4(v4) if v4.is_private() => Some("private address"),
            std::net::IpAddr::V4(v4) if v4.is_link_local() => Some("link-local address"),
            std::net::IpAddr::V4(v4) if is_cgnat_v4(&v4) => Some("CGNAT address"),
            std::net::IpAddr::V6(v6) if v6.is_loopback() => Some("loopback address"),
            std::net::IpAddr::V6(v6) if v6.is_unique_local() => Some("private ULA address"),
            std::net::IpAddr::V6(v6) if v6.is_unicast_link_local() => Some("link-local address"),
            std::net::IpAddr::V6(v6)
                if v6.to_ipv4_mapped().is_some_and(|m| {
                    m.is_loopback() || m.is_private() || m.is_link_local() || is_cgnat_v4(&m)
                }) =>
            {
                Some("private IPv4-mapped address")
            }
            _ => None,
        };
    }
    let lower = host.to_ascii_lowercase();
    if is_localhost_domain(&lower) {
        Some("loopback name")
    } else if lower.ends_with(".local") || lower.ends_with(".internal") {
        Some("local-only DNS name")
    } else if !lower.contains('.') {
        Some("single-label name")
    } else {
        None
    }
}

pub fn is_local_domain(domain: &str) -> bool {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() {
        return false;
    }
    if domain.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    is_localhost_domain(&domain)
        || domain.ends_with(".local")
        || domain.ends_with(".test")
        || domain.ends_with(".internal")
}

/// First uid of the reserved per-app build range. The range must not overlap
/// the fleet uid (10020) or a system user, and is baked into the image's
/// `/etc/passwd` (docker/Dockerfile) because Node's `os.userInfo()` throws
/// for a uid with no passwd entry.
pub const BUILD_UID_BASE: u32 = 10030;
/// Apps covered by the build uid range (one uid per app).
pub const BUILD_UID_RANGE: u32 = 1024;

/// Control UI inside this container: fleet #0 in prod, `vite dev` in dev.
pub const CONTROL_UPSTREAM: &str = "127.0.0.1:8090";
pub const CONTROL_UPSTREAM_URL: &str = "http://127.0.0.1:8090";
/// The runner's own API, as Caddy reaches it for `api.` and `git.`.
pub const API_UPSTREAM: &str = "127.0.0.1:8080";

/// Cloudflare's published edge ranges (cloudflare.com/ips-v4 and ips-v6),
/// what `NOITE_TRUSTED_PROXIES=cloudflare` expands to. They change rarely;
/// an out-of-date list only means a request from a new range is keyed on the
/// proxy's address instead of the visitor's.
pub const CLOUDFLARE_RANGES: &[&str] = &[
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

/// Proxies in front of the edge whose forwarded client address Caddy
/// believes (`NOITE_TRUSTED_PROXIES`): `cloudflare`, Caddy's
/// `private_ranges`, or IPs/CIDRs, separated by commas or spaces.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustedProxies {
    /// Cloudflare's ranges are in `ranges`; the client address then comes
    /// from `CF-Connecting-IP` first.
    pub cloudflare: bool,
    /// Caddy `trusted_proxies static` arguments (CIDRs, IPs, `private_ranges`).
    pub ranges: Vec<String>,
}

impl TrustedProxies {
    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }
}

/// An IP or CIDR as Caddy's `trusted_proxies static` accepts it.
fn cidr_ok(raw: &str) -> bool {
    let (ip, prefix) = match raw.split_once('/') {
        Some((ip, prefix)) => (ip, Some(prefix)),
        None => (raw, None),
    };
    let Ok(ip) = ip.parse::<std::net::IpAddr>() else {
        return false;
    };
    let max = if ip.is_ipv4() { 32 } else { 128 };
    prefix.is_none_or(|p| p.parse::<u8>().is_ok_and(|p| p <= max))
}

/// Parse `NOITE_TRUSTED_PROXIES`; unknown tokens come back as errors.
fn parse_trusted_proxies(raw: &str) -> (TrustedProxies, Vec<String>) {
    let mut out = TrustedProxies::default();
    let mut bad = Vec::new();
    for token in raw
        .split([',', ' ', '\t', '\n'])
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        match token.to_ascii_lowercase().as_str() {
            "cloudflare" => {
                if !out.cloudflare {
                    out.cloudflare = true;
                    out.ranges
                        .extend(CLOUDFLARE_RANGES.iter().map(|r| (*r).to_string()));
                }
            }
            "private_ranges" => out.ranges.push("private_ranges".into()),
            _ if cidr_ok(token) => out.ranges.push(token.to_string()),
            _ => bad.push(token.to_string()),
        }
    }
    out.ranges.dedup();
    (out, bad)
}

/// Edge protection (SPEC, Edge limits): Caddy's per-client and per-app
/// request limits, the proxies whose client address the edge believes, and
/// the host-wide bound on apps cold-starting at once. Every rate is requests per minute; 0 turns
/// that limit off.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EdgeLimits {
    /// Per client IP, per site: control, API, the fallback page, and each app
    /// (all of an app's hostnames share one budget). `NOITE_EDGE_RPM`.
    pub client_rpm: u32,
    /// Per client IP on `git.` (`NOITE_EDGE_GIT_RPM`): a clone or push is a
    /// handful of requests, so this is far tighter than `client_rpm`.
    pub git_rpm: u32,
    /// Per app, across every client (`NOITE_EDGE_APP_RPM`): the ceiling that
    /// stops a flood from many addresses taking the host's CPU from the other
    /// apps. Off by default; an app can set its own in Settings.
    pub app_rpm: u32,
    pub trusted_proxies: TrustedProxies,
    /// Apps allowed to cold-start at once when requests wake them
    /// (`RUNNER_WAKE_CONCURRENCY`); later wakes queue inside the wake budget.
    pub wake_concurrency: u32,
}

impl Default for EdgeLimits {
    fn default() -> Self {
        Self {
            client_rpm: 1800,
            git_rpm: 120,
            app_rpm: 0,
            trusted_proxies: TrustedProxies::default(),
            wake_concurrency: 4,
        }
    }
}

impl EdgeLimits {
    fn from_env(problems: &mut Vec<String>) -> anyhow::Result<Self> {
        let d = Self::default();
        let (trusted_proxies, bad) =
            parse_trusted_proxies(&env::var("NOITE_TRUSTED_PROXIES").unwrap_or_default());
        if !bad.is_empty() {
            anyhow::bail!(
                "NOITE_TRUSTED_PROXIES: {} not an IP, a CIDR, `cloudflare` or `private_ranges`",
                bad.join(", ")
            );
        }
        Ok(Self {
            client_rpm: env_num(
                "NOITE_EDGE_RPM",
                d.client_rpm,
                "a non-negative integer",
                problems,
            ),
            git_rpm: env_num(
                "NOITE_EDGE_GIT_RPM",
                d.git_rpm,
                "a non-negative integer",
                problems,
            ),
            app_rpm: env_num(
                "NOITE_EDGE_APP_RPM",
                d.app_rpm,
                "a non-negative integer",
                problems,
            ),
            trusted_proxies,
            wake_concurrency: env_num(
                "RUNNER_WAKE_CONCURRENCY",
                d.wake_concurrency,
                "a non-negative integer",
                problems,
            )
            .max(1),
        })
    }
}

fn parse_fleet_ports(problems: &mut Vec<String>) -> (u16, u16) {
    const DEFAULT: (u16, u16) = (20000, 29999);
    let raw = match env::var("NOITE_FLEET_PORTS") {
        Err(_) => return DEFAULT,
        Ok(v) if v.trim().is_empty() => return DEFAULT,
        Ok(v) => v,
    };
    let trimmed = raw.trim();
    let parsed = trimmed.split_once('-').and_then(|(a, b)| {
        let (Ok(lo), Ok(hi)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) else {
            return None;
        };
        (lo != 0 && hi > lo).then_some((lo, hi))
    });
    match parsed {
        Some(ports) => ports,
        None => {
            problems.push(format!(
                "NOITE_FLEET_PORTS must be `<min>-<max>` (e.g. `20000-29999`), got {trimmed:?}"
            ));
            DEFAULT
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub runner_token: String,
    pub database_url: String,
    pub s3_endpoint: String,
    /// `S3_ENDPOINT` exactly as configured, userinfo included. Only the
    /// store identity reads it (the scoped-credential install tag and store
    /// id), so stripping userinfo for use never re-tags an install or
    /// strands its keys; it never reaches a process or a request.
    pub s3_endpoint_as_configured: String,
    pub s3_public_endpoint: String,
    /// Single rustfs bucket; git + fleets are prefixes under it.
    pub s3_bucket: String,
    pub aws_region: String,
    pub aws_access_key_id: String,
    pub aws_secret_access_key: String,
    pub base_domain: String,
    /// Control-plane subdomain: empty = bare domain (dev `localhost` — the
    /// only hostname Bitwarden's matcher accepts without https); prod sets
    /// `app` so control serves `app.{BASE_DOMAIN}` and the apex stays free.
    pub control_subdomain: String,
    /// Extra hostnames serving the control UI (comma-separated
    /// `CONTROL_EXTRA_HOSTS`) — e.g. Coolify's generated domain.
    pub control_extra_hosts: Vec<String>,
    pub work_dir: String,
    pub caddyfile_path: String,
    /// Pushed route-table file the edge module loads in Provision and the
    /// runner re-pushes live on every lifecycle event (`CADDY_ROUTES_PATH`).
    pub routes_path: String,
    pub celld_bin: String,
    /// Fleet port range (SPEC, Ports): two ports per app.
    pub fleet_port_min: u16,
    pub fleet_port_max: u16,
    pub poll_ms: u64,
    /// Fallback S3 tip sweep interval (T2.2): pushes notify the reconcile
    /// loop over an in-process channel, and this only covers bundles written
    /// behind the runner's back (another runner, a manual bucket write).
    pub tip_sweep_s: u64,
    pub caddy_upstream_host: String,
    /// Host HTTP port the edge is published on (`HTTP_PORT`, 9080; 80 in
    /// prod): what a plaintext tenant URL carries after the host.
    pub http_port: u16,
    /// Host HTTPS port the edge is published on (`HTTPS_PORT`, 9443; 443 in
    /// prod): carried only when non-default, like a browser would show.
    pub https_port: u16,
    /// Caddy `auto_https`: unset = on except `localhost`; explicit
    /// `off` for behind-proxy deployments (our Caddy still terminates
    /// per-host TLS itself via on-demand certs).
    pub auto_https: bool,
    pub caddy_control_upstream: String,
    pub caddy_api_upstream: String,
    /// Caddy admin endpoint (the child's 127.0.0.1:2019). The generator
    /// stays; the writer POSTs to /load instead of the shared volume.
    pub caddy_admin_url: String,
    /// Public base for Git smart-HTTP remotes (no trailing slash).
    pub git_public_base: String,
    /// Per-account app quota. Every app is its own celld fleet, so this is the
    /// knob that bounds how much of the host one account can claim.
    pub max_apps_per_user: u32,
    /// Preview environments one app may have at once
    /// (`RUNNER_MAX_ENVIRONMENTS_PER_APP`, 5 — ROADMAP). Each environment is
    /// its own celld process against the container-wide memory budget.
    pub max_environments_per_app: u32,
    /// Preview environments the whole install may have at once
    /// (`RUNNER_MAX_ENVIRONMENTS`, 25). The per-app cap bounds one busy app;
    /// this bounds the host, which is what keeps a crowd of previews from
    /// shedding production (SPEC, Limits).
    pub max_environments: u32,
    /// Hours a workspace preview lives without a deploy
    /// (`RUNNER_ENVIRONMENT_TTL_H`, 168 = 7 days — ROADMAP); 0 disables the
    /// expiry sweep.
    pub environment_ttl_h: u64,
    /// celld's shedding threshold in MiB (`CELLD_MAX_RSS_MB`); 0 leaves
    /// celld's default. Fleets in their own cgroup leaf measure the leaf
    /// (`CELLD_MEMORY_SCOPE=self`), so the default is 80% of the fleet's own
    /// `memory.max` and an explicit value is a per-fleet-leaf threshold
    /// (SPEC, Tenant isolation). Without a leaf (no cgroup grant) the knob
    /// keeps its container-wide meaning: celld compares it with the greater
    /// of its own RSS and the container working set.
    pub fleet_max_rss_mb: u32,
    /// Per-fleet memory cap in MiB (`RUNNER_FLEET_MEMORY_MB`, 512): each
    /// tenant fleet runs in its own cgroup v2 child with this `memory.max`,
    /// so one fleet's growth is OOM-killed inside its own group — contained,
    /// and the supervisor restarts it — instead of pushing every fleet toward
    /// the shared shed threshold (SPEC, Tenant isolation). An app's
    /// `app_limit.memory_mb` overrides it. The shed threshold measures this
    /// leaf too (`CELLD_MEMORY_SCOPE=self`), so an unset threshold sheds
    /// gracefully at 80% of it before the kernel OOM-kills the fleet.
    pub fleet_memory_mb: u32,
    /// Ceiling for a tenant's per-app memory override in MiB
    /// (`RUNNER_FLEET_MEMORY_MAX_MB`, default = the effective default cap):
    /// in `multi` a tenant can only lower its cap, never raise it past this.
    /// Single-tenant installs ignore it (the operator is the only admin).
    pub fleet_memory_max_mb: u32,
    /// Cgroup v2 mount the runner manages fleet groups under
    /// (`RUNNER_CGROUP_ROOT`, `/sys/fs/cgroup`). Tests point it at a tempdir
    /// fake; operators leave it alone unless the container mounts cgroupfs
    /// elsewhere.
    pub cgroup_root: std::path::PathBuf,
    /// celld's own log filter for tenant fleets (`RUNNER_FLEET_LOG`). The
    /// runner's RUST_LOG describes the runner's modules, so inheriting it left
    /// a fleet's runtime logs out of the per-app log view entirely.
    pub fleet_log: String,
    /// Idle seconds after which a fleet's cells hibernate
    /// (`CELLD_IDLE_EVICT_S`). The docs' default evicts only under memory
    /// pressure, which keeps idle fleets resident forever.
    pub fleet_idle_evict_s: u32,
    /// Node lease lifetime for every celld this runner starts, control
    /// included (`CELLD_TTL_MS`). celld renews at a third of it and halts
    /// (exit 3, "SELF-FENCE") once it passes, so a store or disk stall longer
    /// than two thirds of it restarts every fleet at once and celld reaps
    /// each fleet's Sandbox containers on start. celld's 10 s default suits
    /// a multi-node fleet that hands cells over fast; Noite runs one node
    /// per app, so there is no peer to hand to, and 60 s rides out the
    /// stalls a small host shows when a container starts. The cost: a fleet
    /// that dies without a clean handoff (SIGKILL, OOM) may wait up to this
    /// long to own its cells again.
    pub fleet_lease_ttl_ms: u64,
    /// Seconds between a fleet's own polls for new deployments
    /// (`CELLD_DEPLOY_POLL_S`). The runner POSTs /reload after every deploy,
    /// so this only covers a missed reload — 300 keeps the fleet quiet.
    pub fleet_deploy_poll_s: u64,
    /// Scale to zero: park an app after this many hours without a request
    /// (`RUNNER_SLEEP_AFTER_H`, 24; 0 disables). SPEC, Scale to zero.
    pub sleep_after_h: u64,
    /// How often the sleep sweep runs (`RUNNER_SLEEP_SWEEP_S`, 3600).
    pub sleep_sweep_s: u64,
    /// Upper bound a woken request waits for the fleet's health gate
    /// (`RUNNER_WAKE_TIMEOUT_S`, 120: covers celld's ready gate).
    pub wake_timeout_s: u64,
    /// Per-fleet on-disk asset cache in MiB (`CELLD_ASSET_CACHE_BYTES`),
    /// bounding the 512 MiB celld default per idle app.
    pub fleet_asset_cache_mb: u64,
    /// Caddy JSON access log the device/path/ref tick tails. The Caddy `log`
    /// block is path-fixed at the volume root; the Caddyfile itself may live
    /// in a subpath (dev `dynamic/`).
    pub caddy_access_log: String,
    /// Tenancy mode (SPEC). Default multi off localhost.
    pub tenancy: Tenancy,
    /// Where tenant fleet keys come from (SPEC, Scoped credentials):
    /// `NOITE_CREDENTIAL_PROVIDER` resolved at boot (`auto` probes an
    /// unknown store once the bucket answers). `Detect` before that.
    pub credentials: Credentials,
    /// Graceful-stop budget in ms (SPEC, Shutdown). Fleets get
    /// budget - 3000 as CELLD_SHUTDOWN_TOTAL_MS.
    pub stop_budget_ms: u64,
    /// Max worktree bytes before a build is refused (RUNNER_BUILD_MAX_MB).
    pub build_max_mb: u64,
    /// Cap per app on the persistent bun cache (RUNNER_BUILD_CACHE_MB).
    /// Pruned oldest-first after each deploy; 0 disables persistence.
    pub build_cache_mb: u64,
    /// Bound on each tenant install and build step (RUNNER_BUILD_TIMEOUT_S).
    pub build_timeout_s: u64,
    /// Days of telemetry kept everywhere (RUNNER_TELEMETRY_RETENTION_DAYS):
    /// celld's bucket prune, the metric table prune and the glob floor.
    pub telemetry_retention_days: i64,
    /// celld OTel bucket-flush interval in ms (`CELLD_OTEL_FLUSH_MS`), and the
    /// ingest tick cadence (spec T3.4). 30 s means ~6x fewer Parquet PUTs and
    /// files than the old 5 s; dashboards lag live traffic by up to ~40 s.
    pub otel_flush_ms: u64,
    /// Telemetry DuckDB's memory cap in MiB (`RUNNER_DUCKDB_MEMORY_MB`).
    /// Unset derives 10% of the detected cgroup/host memory, clamped
    /// 128..1024: DuckDB's own default is 80% of the machine, and on a 2 GB
    /// box that scan collides with the resident fleets.
    pub duckdb_memory_mb: u64,
    /// Telemetry DuckDB's worker threads (`RUNNER_DUCKDB_THREADS`). Unset
    /// derives the container's cores, capped at 4.
    pub duckdb_threads: u32,
    /// Cap on DuckDB's spill directory in MiB (`RUNNER_DUCKDB_TEMP_MB`,
    /// default 1024; 0 = DuckDB's own default). The directory is
    /// `<work_dir>/duckdb-tmp`, on the data volume, never `/tmp`.
    pub duckdb_temp_mb: u64,
    /// The per-app build uid range: `[base, base + range)`, allocated
    /// one-to-one to apps (`db::ensure_app_build_uid`). Every app's builds
    /// and release commands run as their own uid in this range, so two
    /// concurrent builds cannot read each other's worktree or cache.
    /// `base: None` = no uid drop (dev only, single-tenant).
    pub build_uid_base: Option<u32>,
    pub build_uid_range: u32,
    /// Tenant fleet uid (10020). None = current user (dev only, single-tenant).
    pub fleet_uid: Option<u32>,
    pub fleet_gid: Option<u32>,
    /// Baked control bundle (fleet #0 source; absent in the dev image).
    pub control_bundle_dir: String,
    /// Better-auth origin for boot validation (host must be served).
    pub better_auth_url: String,
    /// Edge rate limits, request bounds and trusted proxies.
    pub edge: EdgeLimits,
    /// Operator config for Noite's Void platform proxy: email relay and AI
    /// endpoint rendered into every Void fleet's `noite-void-proxy`.
    pub void_proxy: VoidProxyConfig,
    /// Max concurrent live sandboxes per fleet
    /// (`NOITE_VOID_SANDBOX_MAX_CONCURRENT`, default 4): rendered into
    /// every sandbox controller as `__VOID_SANDBOX_MAX_CONCURRENT` and as
    /// the moved entry's `max_instances` backstop. `0` admits nothing.
    pub void_sandbox_max_concurrent: u32,
    /// Fixed sandbox controller bundle (`worker.js` + `meta.json`)
    /// deployed as `noite-void-sandbox`. The image ships it; a dev
    /// checkout overrides this at its built `apps/void-sandbox/dist`.
    pub void_sandbox_bundle_dir: String,
    /// Opt-out instance heartbeat (SPEC, telemetry): `NOITE_TELEMETRY`
    /// (`0`/`false`/`off`) locks it off.
    pub telemetry_disabled: bool,
    /// `DO_NOT_TRACK` set to anything but `0`/empty locks it off.
    pub do_not_track: bool,
    /// Opt-out update check (SPEC, update check): `NOITE_UPDATE_CHECK`
    /// (`0`/`false`/`off`) locks it off.
    pub update_check_disabled: bool,
    /// Sandbox containers off for the install (`NOITE_SANDBOX=off`): see
    /// `parse_sandbox_disabled` and `host::sandbox`.
    pub sandbox_disabled: bool,
    /// Malformed numeric env values seen by `from_env` (var, value and
    /// expected form per entry). `validate` refuses the boot with all of
    /// them at once; empty for configs built any other way.
    pub env_problems: Vec<String>,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let runner_token = env_or(&["RUNNER_TOKEN"], "dev-runner-token");
        if runner_token.is_empty() {
            anyhow::bail!("RUNNER_TOKEN must not be empty");
        }
        let base_domain = env::var("BASE_DOMAIN").unwrap_or_else(|_| "localhost".into());
        if base_domain.trim().is_empty() {
            anyhow::bail!(
                "BASE_DOMAIN must not be empty (got blank); set it to your domain, e.g. noite.now"
            );
        }
        if !is_localhost_domain(&base_domain) && runner_token == "dev-runner-token" {
            anyhow::bail!(
                "refusing default RUNNER_TOKEN on non-localhost {base_domain}; set RUNNER_TOKEN in .env"
            );
        }
        let db = env::var("NOITE_DB").unwrap_or_else(|_| "./data/noite.sqlite".into());
        let database_url = if db.starts_with("sqlite:") {
            db
        } else {
            format!("sqlite:{db}?mode=rwc")
        };
        let mut env_problems: Vec<String> = Vec::new();
        let http_port: u16 = env_num("HTTP_PORT", 9080, "a port number", &mut env_problems);
        let https_port: u16 = env_num("HTTPS_PORT", 9443, "a port number", &mut env_problems);
        let git_public_base = env::var("GIT_PUBLIC_BASE").unwrap_or_else(|_| {
            if is_localhost_domain(&base_domain) {
                format!("http://git.{base_domain}:{http_port}")
            } else {
                format!("https://git.{base_domain}")
            }
        });
        let auto_https =
            parse_auto_https(env::var("CADDY_AUTO_HTTPS").ok().as_deref(), &base_domain);
        let tenancy = parse_tenancy(env::var("NOITE_TENANCY").ok().as_deref(), &base_domain);
        let credential_setting = ProviderSetting::parse(
            env::var("NOITE_CREDENTIAL_PROVIDER").ok().as_deref(),
            &mut env_problems,
        );
        let (fleet_port_min, fleet_port_max) = parse_fleet_ports(&mut env_problems);
        // The per-app ceiling defaults to the effective platform default, so
        // in multi a tenant can only lower its cap until the operator raises
        // the ceiling.
        let fleet_memory_mb: u32 = env_num(
            "RUNNER_FLEET_MEMORY_MB",
            512,
            "a non-negative integer",
            &mut env_problems,
        );
        // Telemetry's DuckDB CLI defaults to 80% of the machine and every
        // core. On a small host that scan lands on top of the resident
        // fleets, so size it from what this container may actually use.
        let duckdb_memory_default = duckdb_memory_default_mb(crate::host::memory::total_bytes());
        let duckdb_threads_default = duckdb_threads_default(crate::host::memory::cores());
        // Read once, stripped, for `s3_endpoint` and the credential
        // provider's `StoreAccess` alike: provider detection, the install tag
        // and request URLs must see the same endpoint the rest of the runner
        // does.
        let s3_endpoint_as_configured =
            env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://rustfs:9000".into());
        let s3_endpoint = strip_endpoint_userinfo(&s3_endpoint_as_configured);
        let cfg = Self {
            bind: env_or(&["RUNNER_BIND"], "0.0.0.0:8080"),
            runner_token,
            database_url,
            s3_endpoint: s3_endpoint.clone(),
            s3_endpoint_as_configured: s3_endpoint_as_configured.clone(),
            s3_public_endpoint: env::var("S3_PUBLIC_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:9000".into()),
            s3_bucket: env_or(&["NOITE_S3_BUCKET"], "noite"),
            aws_region: env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()),
            aws_access_key_id: env::var("AWS_ACCESS_KEY_ID")
                .or_else(|_| env::var("RUSTFS_ACCESS_KEY"))
                .unwrap_or_else(|_| "noiteaccess".into()),
            aws_secret_access_key: env::var("AWS_SECRET_ACCESS_KEY")
                .or_else(|_| env::var("RUSTFS_SECRET_KEY"))
                .unwrap_or_else(|_| "noitesecretnoitesecretnoite12".into()),
            base_domain: base_domain.clone(),
            control_subdomain: env::var("CONTROL_SUBDOMAIN").unwrap_or_default(),
            control_extra_hosts: env::var("CONTROL_EXTRA_HOSTS")
                .map(|v| parse_host_list(&v))
                .unwrap_or_default(),
            work_dir: env_or(&["RUNNER_WORK_DIR"], "/data/runner"),
            caddyfile_path: env::var("CADDYFILE_PATH")
                .unwrap_or_else(|_| "/data/caddy/Caddyfile".into()),
            routes_path: env::var("CADDY_ROUTES_PATH")
                .unwrap_or_else(|_| "/data/caddy/routes.json".into()),
            caddy_access_log: env::var("CADDY_ACCESS_LOG")
                .unwrap_or_else(|_| "/data/caddy/access.log".into()),
            celld_bin: env::var("CELLD_BIN").unwrap_or_else(|_| "celld".into()),
            fleet_port_min,
            fleet_port_max,
            poll_ms: env_num(
                "RUNNER_POLL_MS",
                5000,
                "a non-negative integer",
                &mut env_problems,
            ),
            tip_sweep_s: env_num(
                "RUNNER_TIP_SWEEP_S",
                60,
                "a non-negative integer",
                &mut env_problems,
            ),
            // Everything Caddy proxies to lives in this container.
            caddy_upstream_host: "127.0.0.1".into(),
            http_port,
            https_port,
            auto_https,
            caddy_control_upstream: CONTROL_UPSTREAM.into(),
            caddy_api_upstream: API_UPSTREAM.into(),
            caddy_admin_url: env::var("CADDY_ADMIN_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:2019".into()),
            git_public_base,
            max_apps_per_user: env_num(
                "RUNNER_MAX_APPS_PER_USER",
                10,
                "a non-negative integer",
                &mut env_problems,
            ),
            max_environments_per_app: env_num(
                "RUNNER_MAX_ENVIRONMENTS_PER_APP",
                5,
                "a non-negative integer",
                &mut env_problems,
            ),
            max_environments: env_num(
                "RUNNER_MAX_ENVIRONMENTS",
                25,
                "a non-negative integer",
                &mut env_problems,
            ),
            environment_ttl_h: env_num(
                "RUNNER_ENVIRONMENT_TTL_H",
                168,
                "a non-negative integer",
                &mut env_problems,
            ),
            fleet_max_rss_mb: env_num(
                "RUNNER_FLEET_MAX_RSS_MB",
                0,
                "a non-negative integer",
                &mut env_problems,
            ),
            fleet_memory_mb,
            fleet_memory_max_mb: env_num(
                "RUNNER_FLEET_MEMORY_MAX_MB",
                fleet_memory_mb,
                "a non-negative integer",
                &mut env_problems,
            ),
            cgroup_root: std::path::PathBuf::from(env_or(
                &["RUNNER_CGROUP_ROOT"],
                "/sys/fs/cgroup",
            )),
            fleet_log: env_or(&["RUNNER_FLEET_LOG"], "error,celld=warn"),
            fleet_idle_evict_s: env_num(
                "RUNNER_FLEET_IDLE_EVICT_S",
                120,
                "a non-negative integer",
                &mut env_problems,
            ),
            fleet_lease_ttl_ms: env_num(
                "RUNNER_FLEET_LEASE_TTL_MS",
                60_000,
                "a whole number of milliseconds",
                &mut env_problems,
            ),
            fleet_deploy_poll_s: env_num(
                "RUNNER_FLEET_DEPLOY_POLL_S",
                300,
                "a non-negative integer",
                &mut env_problems,
            ),
            sleep_after_h: env_num(
                "RUNNER_SLEEP_AFTER_H",
                24,
                "a non-negative integer",
                &mut env_problems,
            ),
            sleep_sweep_s: env_num(
                "RUNNER_SLEEP_SWEEP_S",
                3600,
                "a non-negative integer",
                &mut env_problems,
            ),
            wake_timeout_s: env_num(
                "RUNNER_WAKE_TIMEOUT_S",
                120,
                "a non-negative integer",
                &mut env_problems,
            ),
            fleet_asset_cache_mb: env_num(
                "RUNNER_FLEET_ASSET_CACHE_MB",
                64,
                "a non-negative integer",
                &mut env_problems,
            ),
            tenancy,
            credentials: Credentials::configure(
                credential_setting,
                &StoreAccess {
                    // The same stripped endpoint as `s3_endpoint` above; the
                    // other fields resolve from the same vars as the literal
                    // below, kept inline so the two cannot drift.
                    endpoint: s3_endpoint,
                    identity_endpoint: s3_endpoint_as_configured,
                    region: env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()),
                    access_key: env::var("AWS_ACCESS_KEY_ID")
                        .or_else(|_| env::var("RUSTFS_ACCESS_KEY"))
                        .unwrap_or_else(|_| "noiteaccess".into()),
                    secret_key: env::var("AWS_SECRET_ACCESS_KEY")
                        .or_else(|_| env::var("RUSTFS_SECRET_KEY"))
                        .unwrap_or_else(|_| "noitesecretnoitesecretnoite12".into()),
                },
                // The install tag derives from the configured store (see
                // `host::credentials::install_tag`); read the same var as
                // `s3_bucket` above so the two cannot drift.
                &env_or(&["NOITE_S3_BUCKET"], "noite"),
            ),
            stop_budget_ms: env_num(
                "NOITE_STOP_BUDGET_MS",
                25000,
                "a non-negative integer",
                &mut env_problems,
            ),
            build_max_mb: env_num(
                "RUNNER_BUILD_MAX_MB",
                2048,
                "a non-negative integer",
                &mut env_problems,
            ),
            build_cache_mb: env_num(
                "RUNNER_BUILD_CACHE_MB",
                512,
                "a non-negative integer",
                &mut env_problems,
            ),
            build_timeout_s: env_num(
                "RUNNER_BUILD_TIMEOUT_S",
                300,
                "a non-negative integer",
                &mut env_problems,
            ),
            telemetry_retention_days: env_num(
                "RUNNER_TELEMETRY_RETENTION_DAYS",
                30,
                "an integer",
                &mut env_problems,
            ),
            otel_flush_ms: env_num(
                "RUNNER_OTEL_FLUSH_MS",
                30000,
                "a non-negative integer",
                &mut env_problems,
            ),
            duckdb_memory_mb: env_num(
                "RUNNER_DUCKDB_MEMORY_MB",
                duckdb_memory_default,
                "an integer",
                &mut env_problems,
            ),
            duckdb_threads: env_num(
                "RUNNER_DUCKDB_THREADS",
                duckdb_threads_default,
                "an integer",
                &mut env_problems,
            ),
            duckdb_temp_mb: env_num(
                "RUNNER_DUCKDB_TEMP_MB",
                1024,
                "a non-negative integer",
                &mut env_problems,
            ),
            build_uid_base: env_opt_uid("RUNNER_BUILD_UID_BASE", BUILD_UID_BASE, &mut env_problems),
            build_uid_range: env_num(
                "RUNNER_BUILD_UID_RANGE",
                BUILD_UID_RANGE,
                "a non-negative integer",
                &mut env_problems,
            ),
            fleet_uid: env_opt_uid("RUNNER_FLEET_UID", 10020, &mut env_problems),
            fleet_gid: env_opt_uid("RUNNER_FLEET_GID", 10020, &mut env_problems),
            control_bundle_dir: env::var("CONTROL_BUNDLE_DIR")
                .unwrap_or_else(|_| "/opt/noite/control/dist".into()),
            better_auth_url: env::var("BETTER_AUTH_URL").unwrap_or_default(),
            edge: EdgeLimits::from_env(&mut env_problems)?,
            void_proxy: VoidProxyConfig::from_env(&mut env_problems),
            void_sandbox_max_concurrent: env_num(
                "NOITE_VOID_SANDBOX_MAX_CONCURRENT",
                4,
                "a non-negative integer",
                &mut env_problems,
            ),
            void_sandbox_bundle_dir: env::var("VOID_SANDBOX_BUNDLE_DIR")
                .unwrap_or_else(|_| "/opt/noite/void-sandbox".into()),
            telemetry_disabled: parse_telemetry_disabled(
                env::var("NOITE_TELEMETRY").ok().as_deref(),
            ),
            do_not_track: parse_do_not_track(env::var("DO_NOT_TRACK").ok().as_deref()),
            update_check_disabled: parse_update_check_disabled(
                env::var("NOITE_UPDATE_CHECK").ok().as_deref(),
            ),
            sandbox_disabled: parse_sandbox_disabled(env::var("NOITE_SANDBOX").ok().as_deref()),
            env_problems,
        };
        cfg.validate()?;
        Ok(cfg)
    }
    /// Finish resolving where tenant keys come from, once the bucket
    /// answers. `auto` against an unknown store probes it for the MinIO
    /// admin API; anything already decided stays. Runs before the first
    /// fleet spawn (existing installs mint their keys lazily from there).
    pub async fn resolve_credentials(&mut self) -> anyhow::Result<()> {
        if matches!(self.credentials, Credentials::Detect) {
            self.credentials = crate::host::credentials::detect(
                &StoreAccess::from_config(self),
                &self.s3_bucket.clone(),
            )
            .await?;
        }
        Ok(())
    }

    /// Boot validation (SPEC, Configuration): fail fast with a
    /// list of problems instead of serving half-configured.
    pub fn validate(&self) -> anyhow::Result<()> {
        // Malformed numeric env values never fall back silently: `from_env`
        // records each one (var, value, expected form) and the boot fails
        // here naming them all, before any range complaint below.
        let mut problems: Vec<String> = self.env_problems.clone();
        let dev_token = self.runner_token == "dev-runner-token";
        let dev_auth = std::env::var("BETTER_AUTH_SECRET")
            .map(|v| v.trim().is_empty() || v.starts_with("dev-"))
            .unwrap_or(true);
        let dev_s3 = self.aws_access_key_id == "noiteaccess"
            || self.aws_secret_access_key == "noitesecretnoitesecretnoite12";
        if !is_localhost_domain(&self.base_domain) {
            if dev_token {
                problems
                    .push("RUNNER_TOKEN is the dev default on a non-localhost BASE_DOMAIN".into());
            }
            if dev_s3 {
                problems
                    .push("S3 keys are RustFS dev defaults on a non-localhost BASE_DOMAIN".into());
            }
        }
        if !self.better_auth_url.is_empty() {
            match url_host(&self.better_auth_url) {
                Some(host) => {
                    let served = self
                        .control_hosts()
                        .iter()
                        .any(|h| h.eq_ignore_ascii_case(&host));
                    if !served {
                        problems.push(format!(
                            "BETTER_AUTH_URL host {host} is not a served control host"
                        ));
                    }
                }
                None => problems.push("BETTER_AUTH_URL does not parse".into()),
            }
            if dev_auth && !is_localhost_domain(&self.base_domain) {
                problems.push(
                    "BETTER_AUTH_SECRET is a dev default on a non-localhost BASE_DOMAIN".into(),
                );
            }
        }
        if self.fleet_port_min >= self.fleet_port_max {
            problems.push("NOITE_FLEET_PORTS min must be below max".into());
        }
        if self.stop_budget_ms < 5000 {
            problems.push("NOITE_STOP_BUDGET_MS must be >= 5000".into());
        }
        if self.telemetry_retention_days < 1 {
            problems.push("RUNNER_TELEMETRY_RETENTION_DAYS must be >= 1".into());
        }
        // celld's own default is the floor: shorter only self-fences fleets
        // sooner on a slow store, and 0 would stop every celld from booting.
        if self.fleet_lease_ttl_ms < 10_000 {
            problems.push("RUNNER_FLEET_LEASE_TTL_MS must be >= 10000".into());
        }
        // The platform default shares the per-app override's floor: below it
        // celld cannot boot, so a typo'd `1` refuses loudly instead of
        // OOM-looping every fleet. In multi the default is the enforced cap,
        // so 0 there means "no containment at all" and refuses; single keeps
        // 0 as no cap.
        if self.tenancy == Tenancy::Multi && self.fleet_memory_mb == 0 {
            problems.push(
                "RUNNER_FLEET_MEMORY_MB must be >= 64 in multi (0 would leave every fleet uncapped)".into(),
            );
        }
        if self.fleet_memory_mb != 0 && self.fleet_memory_mb < 64 {
            problems.push("RUNNER_FLEET_MEMORY_MB must be 0 (no cap) or >= 64".into());
        }
        // The operator ceiling binds every per-app override in multi, so it
        // carries the same floor (0 must not mean uncapped here) and must
        // cover the default: a ceiling below the default would silently
        // lower every fleet, including untouched ones. Inert only for an
        // uncapped single install, where the ceiling binds nothing.
        let ceiling_inert = self.tenancy != Tenancy::Multi && self.fleet_memory_mb == 0;
        if !ceiling_inert {
            if self.fleet_memory_max_mb < 64 {
                problems.push(
                    "RUNNER_FLEET_MEMORY_MAX_MB must be >= 64 (0 must not mean uncapped)".into(),
                );
            } else if self.fleet_memory_max_mb < self.fleet_memory_mb {
                problems.push(format!(
                    "RUNNER_FLEET_MEMORY_MAX_MB ({}) must cover RUNNER_FLEET_MEMORY_MB ({})",
                    self.fleet_memory_max_mb, self.fleet_memory_mb
                ));
            }
        }
        if self.otel_flush_ms < 1000 {
            problems.push("RUNNER_OTEL_FLUSH_MS must be >= 1000".into());
        }
        // A 0 memory limit means DuckDB's own 80%-of-RAM default, which is
        // exactly what this knob exists to avoid; a tiny one makes every
        // query spill forever. 64 MiB is the floor DuckDB can run a scan in.
        if self.duckdb_memory_mb < 64 {
            problems.push("RUNNER_DUCKDB_MEMORY_MB must be >= 64".into());
        }
        if self.duckdb_threads == 0 {
            problems.push("RUNNER_DUCKDB_THREADS must be >= 1".into());
        }
        self.void_proxy.validate(self.tenancy, &mut problems);
        if self.build_uid_range == 0 {
            problems.push("RUNNER_BUILD_UID_RANGE must be >= 1".into());
        }
        if let Some(base) = self.build_uid_base {
            let end = base.saturating_add(self.build_uid_range);
            if base < 1000 {
                problems.push("RUNNER_BUILD_UID_BASE must be >= 1000 (system users below)".into());
            }
            if end > 65534 {
                problems.push(format!(
                    "RUNNER_BUILD_UID_BASE({base}) + RUNNER_BUILD_UID_RANGE({}) must stay below 65534",
                    self.build_uid_range
                ));
            }
            if let Some(fleet) = self.fleet_uid {
                if fleet >= base && fleet < end {
                    problems.push(format!(
                        "RUNNER_BUILD_UID_BASE range {base}..{end} covers the fleet uid {fleet}"
                    ));
                }
            }
        }
        if std::env::var("RAILWAY_DEPLOYMENT_ID").is_ok() {
            if let Ok(grace) = std::env::var("RAILWAY_DEPLOYMENT_DRAINING_SECONDS") {
                if let Ok(g) = grace.parse::<u64>() {
                    if self.stop_budget_ms / 1000 + 5 > g && g != 0 {
                        problems.push(format!("stop budget {}ms exceeds Railway drain {g}s; raise RAILWAY_DEPLOYMENT_DRAINING_SECONDS", self.stop_budget_ms));
                    }
                }
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            anyhow::bail!("config invalid:\n- {}", problems.join("\n- "))
        }
    }

    /// Hostnames serving the control UI (bare/sub + extras).
    pub fn control_hosts(&self) -> Vec<String> {
        let mut out = vec![if self.control_subdomain.is_empty() {
            self.base_domain.clone()
        } else {
            format!("{}.{}", self.control_subdomain, self.base_domain)
        }];
        out.extend(self.control_extra_hosts.iter().cloned());
        out
    }

    /// Why the instance heartbeat is locked off, if it is: the env kill
    /// switches first (`NOITE_TELEMETRY` wins over `DO_NOT_TRACK`), then a
    /// local base domain. `None` means the stored preference decides.
    pub fn telemetry_lock_reason(&self) -> Option<&'static str> {
        if self.telemetry_disabled {
            return Some("NOITE_TELEMETRY=0");
        }
        if self.do_not_track {
            return Some("DO_NOT_TRACK");
        }
        if is_local_domain(&self.base_domain) {
            return Some("local domain");
        }
        None
    }
    /// Why the update check is locked off, if it is: only the
    /// `NOITE_UPDATE_CHECK=0` force-off locks it. Unlike the heartbeat, a
    /// local domain does not lock it — the e2e lane runs on `localhost` and
    /// still exercises the toggle. `None` means the stored preference (off
    /// unless the admin disables it) decides.
    pub fn update_check_lock_reason(&self) -> Option<&'static str> {
        if self.update_check_disabled {
            return Some("NOITE_UPDATE_CHECK=off");
        }
        None
    }

    /// Whether the edge can tell visitors apart, which per-client limits need.
    /// Behind a terminating proxy (`CADDY_AUTO_HTTPS=off` on a real domain:
    /// Coolify, Railway) every request arrives from the proxy, and without
    /// `NOITE_TRUSTED_PROXIES` a per-client limit would throttle the whole
    /// install as one client.
    pub fn edge_sees_clients(&self) -> bool {
        is_localhost_domain(&self.base_domain)
            || self.auto_https
            || !self.edge.trusted_proxies.is_empty()
    }

    /// Fleet shutdown bound for one celld node (budget minus drain margin).
    pub fn fleet_shutdown_ms(&self) -> u64 {
        self.stop_budget_ms.saturating_sub(3000)
    }

    /// Object-key prefix for tip bundles: `git/{slug}/`.
    pub fn git_prefix(slug: &str) -> String {
        format!("git/{slug}/")
    }

    /// Internal S3 layout URL (debug / tip poll); clients use `git_http_url`.
    pub fn s3_git_remote(&self, slug: &str) -> String {
        format!("s3://{}/git/{slug}", self.s3_bucket)
    }

    /// Stock Git remote URL (no embedded credentials — use Profile API key).
    pub fn git_http_url(&self, slug: &str) -> String {
        format!("{}/{slug}", self.git_public_base.trim_end_matches('/'))
    }

    /// Browser URL of an app from its stored subdomain (`{slug}.{base}`).
    /// The edge serves tenants there, so the scheme and port follow the edge
    /// — never the git remote (the runner API's raw port is not reachable
    /// from a browser). Mirrors the control UI's `appUrl` and the CLI's
    /// `deployUrlOf`: dev carries the public HTTP port over http, prod links
    /// plain https (a non-default HTTPS port is carried), and
    /// `CADDY_AUTO_HTTPS=off` answers plaintext http behind the proxy.
    pub fn public_app_url(&self, subdomain: &str) -> String {
        let host = subdomain.trim().trim_end_matches('.');
        if is_localhost_domain(&self.base_domain) || !self.auto_https {
            if self.http_port == 80 {
                format!("http://{}", host)
            } else {
                format!("http://{}:{}", host, self.http_port)
            }
        } else if self.https_port == 443 {
            format!("https://{}", host)
        } else {
            format!("https://{}:{}", host, self.https_port)
        }
    }

    /// celld fleet bucket URI: `s3://{bucket}/fleets/{slug}`.
    pub fn fleets_uri(&self, slug: &str) -> String {
        format!("s3://{}/fleets/{slug}", self.s3_bucket)
    }

    /// celld bucket URI of one preview environment:
    /// `s3://{bucket}/envs/{slug}/{label}` (ROADMAP: a sibling prefix, never
    /// `fleets/{slug}--{label}` — a slug may itself contain `--`).
    pub fn envs_uri(&self, slug: &str, label: &str) -> String {
        format!("s3://{}/envs/{slug}/{label}", self.s3_bucket)
    }

    /// Every environment of one app, as an S3 prefix (`envs/{slug}/`): what
    /// delete, purge and rename walk.
    pub fn envs_prefix(&self, slug: &str) -> String {
        format!("envs/{slug}/")
    }

    /// DNS bases tenants are served under: the configured domain first, then
    /// every extra control hostname that is a DNS name (dev-host LAN name,
    /// Coolify domain). Bare IPs can't parent subdomains (`*.1.2.3.4` never
    /// matches) so they're control-only; entries with ports/paths are
    /// operator error — skipped rather than rendered half-working.
    pub fn tenant_bases(&self) -> Vec<String> {
        let mut bases = vec![self.base_domain.clone()];
        for raw in &self.control_extra_hosts {
            let host = raw.trim().trim_matches('.');
            if host.is_empty()
                || host.parse::<std::net::IpAddr>().is_ok()
                || host.contains(':')
                || host.contains('/')
            {
                continue;
            }
            if !bases.iter().any(|b| b.eq_ignore_ascii_case(host)) {
                bases.push(host.to_string());
            }
        }
        bases
    }

    /// S3 URI for a key already under the shared bucket (e.g. tip bundle key).
    pub fn s3_uri(&self, key: &str) -> String {
        let key = key.trim_start_matches('/');
        format!("s3://{}/{key}", self.s3_bucket)
    }
}

/// Minimal literal `Config` for tests outside this module (no env, no S3, no
/// control hosts): callers clone it and mutate the few fields they exercise.
#[cfg(test)]
pub(crate) fn config_for_tests() -> Config {
    Config {
        bind: "127.0.0.1:0".into(),
        runner_token: "test-token".into(),
        database_url: "sqlite::memory:".into(),
        s3_endpoint: "http://rustfs:9000".into(),
        s3_endpoint_as_configured: "http://rustfs:9000".into(),
        s3_public_endpoint: "http://rustfs:9000".into(),
        s3_bucket: "noite".into(),
        aws_region: "us-east-1".into(),
        aws_access_key_id: "key".into(),
        aws_secret_access_key: "secret".into(),
        base_domain: "localhost".into(),
        control_subdomain: "".into(),
        control_extra_hosts: Vec::new(),
        work_dir: "/tmp/noite-test".into(),
        caddyfile_path: "/tmp/noite-test-bases".into(),
        routes_path: "/tmp/noite-test-routes.json".into(),
        celld_bin: "celld".into(),
        fleet_port_min: 20000,
        fleet_port_max: 29999,
        poll_ms: 5000,
        tip_sweep_s: 60,
        caddy_upstream_host: "127.0.0.1".into(),
        http_port: 9080,
        https_port: 9443,
        auto_https: false,
        fleet_log: "error,celld=warn".into(),
        max_apps_per_user: 10,
        max_environments_per_app: 5,
        max_environments: 25,
        environment_ttl_h: 168,
        fleet_max_rss_mb: 0,
        fleet_memory_mb: 512,
        fleet_memory_max_mb: 512,
        cgroup_root: std::path::PathBuf::from("/sys/fs/cgroup"),
        fleet_idle_evict_s: 120,
        fleet_lease_ttl_ms: 60_000,
        fleet_deploy_poll_s: 300,
        sleep_after_h: 24,
        sleep_sweep_s: 3600,
        wake_timeout_s: 120,
        fleet_asset_cache_mb: 64,
        caddy_control_upstream: CONTROL_UPSTREAM.into(),
        caddy_api_upstream: API_UPSTREAM.into(),
        caddy_admin_url: "http://127.0.0.1:2019".into(),
        git_public_base: "https://git.localhost".into(),
        caddy_access_log: "/caddy/access.log".into(),
        tenancy: Tenancy::Single,
        credentials: Credentials::Detect,
        stop_budget_ms: 25000,
        build_max_mb: 2048,
        build_cache_mb: 512,
        build_timeout_s: 300,
        telemetry_retention_days: 30,
        otel_flush_ms: 30000,
        duckdb_memory_mb: 256,
        duckdb_threads: 1,
        duckdb_temp_mb: 1024,
        build_uid_base: None,
        build_uid_range: BUILD_UID_RANGE,
        fleet_uid: None,
        fleet_gid: None,
        control_bundle_dir: "/opt/noite/control/dist".into(),
        better_auth_url: "".into(),
        edge: EdgeLimits::default(),
        void_proxy: VoidProxyConfig::default(),
        void_sandbox_max_concurrent: 4,
        void_sandbox_bundle_dir: "/opt/noite/void-sandbox".into(),
        telemetry_disabled: false,
        do_not_track: false,
        update_check_disabled: false,
        sandbox_disabled: false,
        env_problems: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint keeps its shape apart from userinfo: a plain endpoint
    /// passes through byte-identical, credentials are dropped (keeping a
    /// configured trailing slash or path), and garbage passes through to
    /// fail loudly where it is used.
    #[test]
    fn endpoint_userinfo_is_stripped_nothing_else() {
        assert_eq!(
            strip_endpoint_userinfo("http://rustfs:9000"),
            "http://rustfs:9000"
        );
        assert_eq!(
            strip_endpoint_userinfo("http://user:pass@rustfs:9000"),
            "http://rustfs:9000"
        );
        assert_eq!(
            strip_endpoint_userinfo("https://user@store.example:9443/prefix/"),
            "https://store.example:9443/prefix/"
        );
        assert_eq!(strip_endpoint_userinfo("not a url"), "not a url");
    }

    #[test]
    fn auto_https_explicit_off_wins() {
        for raw in ["off", "0", "false"] {
            assert!(!parse_auto_https(Some(raw), "noite.now"));
        }
    }

    #[test]
    fn auto_https_explicit_on_wins() {
        assert!(parse_auto_https(Some("on"), "localhost"));
    }

    #[test]
    fn auto_https_empty_value_is_unset() {
        // Compose renders `CADDY_AUTO_HTTPS: ""` when the operator leaves it
        // unset, which must fall back to the domain default — not force on.
        assert!(!parse_auto_https(Some(""), "localhost"));
        assert!(parse_auto_https(Some(""), "noite.now"));
        assert!(!parse_auto_https(Some("  "), "localhost"));
    }

    #[test]
    fn extra_hosts_split_and_trim() {
        assert!(parse_host_list("").is_empty());
        assert_eq!(
            parse_host_list("a.example.com, b.example.com,,"),
            vec!["a.example.com", "b.example.com"]
        );
    }

    #[test]
    fn auto_https_defaults_by_domain() {
        assert!(!parse_auto_https(None, "localhost"));
        // The dev stack's `*.localhost` base is a loopback, plain-http install
        // exactly like bare `localhost`.
        assert!(!parse_auto_https(None, "noite.localhost"));
        assert!(parse_auto_https(None, "noite.now"));
    }

    #[test]
    fn localhost_family_is_detected() {
        for domain in [
            "localhost",
            "LOCALHOST",
            "localhost.",
            "noite.localhost",
            " app.noite.localhost ",
        ] {
            assert!(
                is_localhost_domain(domain),
                "{domain:?} is the localhost family"
            );
        }
        for domain in [
            "noite.now",
            "noite.local",
            "notlocalhost",
            "localhost.noite.now",
            "noite.now.local",
            "",
        ] {
            assert!(
                !is_localhost_domain(domain),
                "{domain:?} is not the localhost family"
            );
        }
    }

    #[test]
    fn tenancy_defaults_single_on_the_localhost_family() {
        assert_eq!(parse_tenancy(None, "localhost"), Tenancy::Single);
        assert_eq!(parse_tenancy(None, "noite.localhost"), Tenancy::Single);
        assert_eq!(parse_tenancy(None, "noite.now"), Tenancy::Multi);
        assert_eq!(
            parse_tenancy(Some("multi"), "noite.localhost"),
            Tenancy::Multi
        );
        assert_eq!(parse_tenancy(Some("single"), "noite.now"), Tenancy::Single);
    }

    #[test]
    fn the_edge_sees_clients_on_a_dev_base() {
        let mut cfg = config_for_tests();
        assert!(cfg.edge_sees_clients(), "bare localhost dev");
        cfg.base_domain = "noite.localhost".into();
        assert!(cfg.edge_sees_clients(), "a *.localhost dev base");
        cfg.base_domain = "noite.now".into();
        cfg.auto_https = true;
        assert!(cfg.edge_sees_clients(), "TLS terminated here");
        cfg.auto_https = false;
        assert!(!cfg.edge_sees_clients(), "behind a proxy, no trusted list");
    }

    /// Every numeric env var `from_env` parses strictly. Kept next to the
    /// parse sites so a new knob must add its name here too.
    const STRICT_NUMERIC_VARS: &[&str] = &[
        "HTTP_PORT",
        "HTTPS_PORT",
        "RUNNER_POLL_MS",
        "RUNNER_MAX_APPS_PER_USER",
        "RUNNER_MAX_ENVIRONMENTS_PER_APP",
        "RUNNER_MAX_ENVIRONMENTS",
        "RUNNER_ENVIRONMENT_TTL_H",
        "RUNNER_FLEET_MAX_RSS_MB",
        "RUNNER_FLEET_MEMORY_MB",
        "RUNNER_FLEET_MEMORY_MAX_MB",
        "RUNNER_FLEET_IDLE_EVICT_S",
        "RUNNER_FLEET_LEASE_TTL_MS",
        "RUNNER_FLEET_DEPLOY_POLL_S",
        "RUNNER_SLEEP_AFTER_H",
        "RUNNER_SLEEP_SWEEP_S",
        "RUNNER_WAKE_TIMEOUT_S",
        "RUNNER_FLEET_ASSET_CACHE_MB",
        "NOITE_STOP_BUDGET_MS",
        "RUNNER_BUILD_MAX_MB",
        "RUNNER_BUILD_CACHE_MB",
        "RUNNER_BUILD_TIMEOUT_S",
        "RUNNER_TELEMETRY_RETENTION_DAYS",
        "RUNNER_OTEL_FLUSH_MS",
        "RUNNER_DUCKDB_MEMORY_MB",
        "RUNNER_DUCKDB_THREADS",
        "RUNNER_DUCKDB_TEMP_MB",
        "RUNNER_BUILD_UID_RANGE",
        "RUNNER_BUILD_UID_BASE",
        "RUNNER_FLEET_UID",
        "RUNNER_FLEET_GID",
        "NOITE_FLEET_PORTS",
        "NOITE_EDGE_RPM",
        "NOITE_EDGE_GIT_RPM",
        "NOITE_EDGE_APP_RPM",
        "RUNNER_WAKE_CONCURRENCY",
    ];

    /// Run `f` with a hermetic env: every strictly-parsed numeric var
    /// cleared, `BASE_DOMAIN` pinned to the dev base, `NOITE_TENANCY`
    /// cleared (a test-set tenancy must not leak into later tests, and a
    /// caller-shell value must not leak in), then `set` applied.
    /// Holds `ENV_LOCK` throughout and restores everything after, so a
    /// parallel `from_env` elsewhere never observes the mutation.
    fn with_env(set: &[(&str, &str)], f: impl FnOnce()) {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved: Vec<(&str, Option<String>)> = Vec::new();
        for key in STRICT_NUMERIC_VARS
            .iter()
            .copied()
            .chain(["BASE_DOMAIN", "NOITE_TENANCY"])
            // The Void proxy/sandbox sections read these; a test-set value
            // must not leak into a parallel `from_env`.
            .chain([
                "NOITE_VOID_EMAIL_DOMAIN",
                "NOITE_VOID_SMTP_HOST",
                "NOITE_VOID_SMTP_PORT",
                "NOITE_VOID_SMTP_MODE",
                "NOITE_VOID_SMTP_ALLOW_PLAINTEXT",
                "NOITE_VOID_EMAIL_ALLOWLIST",
                "NOITE_VOID_AI_ENABLED",
                "NOITE_VOID_AI_MODELS",
                "NOITE_VOID_AI_ALLOW_PLAINTEXT",
                "NOITE_VOID_SANDBOX_MAX_CONCURRENT",
                "VOID_SANDBOX_BUNDLE_DIR",
            ])
        {
            saved.push((key, env::var(key).ok()));
            env::remove_var(key);
        }
        env::set_var("BASE_DOMAIN", "noite.localhost");
        for (key, value) in set {
            env::set_var(key, value);
        }
        f();
        for (key, old) in saved {
            match old {
                Some(v) => env::set_var(key, v),
                None => env::remove_var(key),
            }
        }
    }

    #[test]
    fn with_env_seals_noite_tenancy_both_ways() {
        // A caller-shell value must not leak in, and a test-set value must
        // not leak out (NOITE_TENANCY sits outside STRICT_NUMERIC_VARS).
        let initial = env::var("NOITE_TENANCY").ok();
        {
            let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            env::set_var("NOITE_TENANCY", "single");
        }
        with_env(&[], || {
            assert!(env::var("NOITE_TENANCY").is_err());
        });
        assert_eq!(env::var("NOITE_TENANCY").as_deref(), Ok("single"));
        with_env(&[("NOITE_TENANCY", "multi")], || {
            assert_eq!(env::var("NOITE_TENANCY").as_deref(), Ok("multi"));
        });
        assert_eq!(env::var("NOITE_TENANCY").as_deref(), Ok("single"));
        match initial {
            Some(v) => env::set_var("NOITE_TENANCY", v),
            None => env::remove_var("NOITE_TENANCY"),
        }
    }

    #[test]
    fn malformed_numeric_refuses_boot_naming_the_var() {
        with_env(&[("RUNNER_POLL_MS", "abc")], || {
            let err = Config::from_env().expect_err("malformed RUNNER_POLL_MS must fail boot");
            let msg = format!("{err:#}");
            assert!(msg.contains("RUNNER_POLL_MS"), "names the var: {msg}");
            assert!(msg.contains("abc"), "names the bad value: {msg}");
        });
    }

    #[test]
    fn fleet_memory_floor_matches_the_per_app_override() {
        with_env(&[("RUNNER_FLEET_MEMORY_MB", "16")], || {
            let err = Config::from_env().expect_err("16 MiB must fail boot");
            let msg = format!("{err:#}");
            assert!(
                msg.contains("RUNNER_FLEET_MEMORY_MB"),
                "names the var: {msg}"
            );
        });
        for ok in ["0", "64"] {
            with_env(&[("RUNNER_FLEET_MEMORY_MB", ok)], || {
                let cfg = Config::from_env().expect("floor value must boot");
                assert_eq!(cfg.fleet_memory_mb.to_string(), ok);
            });
        }
    }

    #[test]
    fn multi_rejects_an_uncapped_default_but_single_keeps_it() {
        with_env(
            &[("NOITE_TENANCY", "multi"), ("RUNNER_FLEET_MEMORY_MB", "0")],
            || {
                let err = Config::from_env().expect_err("multi+0 must fail boot");
                assert!(
                    format!("{err:#}").contains("multi"),
                    "names the reason: {err:#}"
                );
            },
        );
        with_env(
            &[("NOITE_TENANCY", "single"), ("RUNNER_FLEET_MEMORY_MB", "0")],
            || {
                Config::from_env().expect("single keeps 0 as no cap");
            },
        );
    }
    #[test]
    fn fleet_memory_ceiling_needs_a_floor_and_must_cover_the_default() {
        for bad in ["0", "16"] {
            with_env(&[("RUNNER_FLEET_MEMORY_MAX_MB", bad)], || {
                let err = Config::from_env().expect_err("a floor-less ceiling must fail boot");
                assert!(
                    format!("{err:#}").contains("RUNNER_FLEET_MEMORY_MAX_MB"),
                    "names the var: {err:#}"
                );
            });
        }
        with_env(&[("RUNNER_FLEET_MEMORY_MAX_MB", "256")], || {
            let err = Config::from_env().expect_err("a ceiling below the default must fail boot");
            assert!(
                format!("{err:#}").contains("must cover"),
                "says the ceiling must cover the default: {err:#}"
            );
        });
        for ok in ["512", "1024"] {
            with_env(&[("RUNNER_FLEET_MEMORY_MAX_MB", ok)], || {
                let cfg = Config::from_env().expect("a covering ceiling must boot");
                assert_eq!(cfg.fleet_memory_max_mb.to_string(), ok);
            });
        }
    }

    #[test]
    fn every_malformed_numeric_is_listed_at_once() {
        with_env(
            &[
                ("HTTP_PORT", "eighty"),
                ("RUNNER_POLL_MS", "abc"),
                ("RUNNER_MAX_APPS_PER_USER", "ten"),
                ("RUNNER_TELEMETRY_RETENTION_DAYS", "thirty"),
                ("NOITE_FLEET_PORTS", "banana"),
                ("NOITE_EDGE_RPM", "lots"),
                ("RUNNER_BUILD_UID_BASE", "nope"),
                ("RUNNER_WAKE_CONCURRENCY", "4.5"),
                ("RUNNER_FLEET_MEMORY_MAX_MB", "lots"),
            ],
            || {
                let err = Config::from_env().expect_err("malformed values must fail boot");
                let msg = format!("{err:#}");
                for (key, value) in [
                    ("HTTP_PORT", "eighty"),
                    ("RUNNER_POLL_MS", "abc"),
                    ("RUNNER_MAX_APPS_PER_USER", "ten"),
                    ("RUNNER_TELEMETRY_RETENTION_DAYS", "thirty"),
                    ("NOITE_FLEET_PORTS", "banana"),
                    ("NOITE_EDGE_RPM", "lots"),
                    ("RUNNER_BUILD_UID_BASE", "nope"),
                    ("RUNNER_WAKE_CONCURRENCY", "4.5"),
                    ("RUNNER_FLEET_MEMORY_MAX_MB", "lots"),
                ] {
                    assert!(msg.contains(key), "lists {key}: {msg}");
                    assert!(msg.contains(value), "lists the bad {value}: {msg}");
                }
            },
        );
    }

    #[test]
    fn unset_numerics_mean_defaults() {
        with_env(&[], || {
            let cfg = Config::from_env().expect("unset numerics must boot");
            assert!(cfg.env_problems.is_empty());
            assert_eq!(cfg.http_port, 9080);
            assert_eq!(cfg.https_port, 9443);
            assert_eq!(cfg.poll_ms, 5000);
            assert_eq!(cfg.tip_sweep_s, 60);
            assert_eq!(cfg.max_apps_per_user, 10);
            assert_eq!(cfg.max_environments_per_app, 5);
            assert_eq!(cfg.max_environments, 25);
            assert_eq!(cfg.environment_ttl_h, 168);
            assert_eq!(cfg.fleet_max_rss_mb, 0);
            assert_eq!(cfg.fleet_idle_evict_s, 120);
            assert_eq!(cfg.fleet_lease_ttl_ms, 60_000);
            assert_eq!(cfg.fleet_deploy_poll_s, 300);
            assert_eq!(cfg.sleep_after_h, 24);
            assert_eq!(cfg.sleep_sweep_s, 3600);
            assert_eq!(cfg.wake_timeout_s, 120);
            assert_eq!(cfg.fleet_asset_cache_mb, 64);
            assert_eq!(cfg.stop_budget_ms, 25000);
            assert_eq!(cfg.build_max_mb, 2048);
            assert_eq!(cfg.build_cache_mb, 512);
            assert_eq!(cfg.build_timeout_s, 300);
            assert_eq!(cfg.telemetry_retention_days, 30);
            assert_eq!(cfg.otel_flush_ms, 30000);
            // Derived from the machine the test runs on, so assert the band.
            assert!((128..=1024).contains(&cfg.duckdb_memory_mb));
            assert!((1..=4).contains(&cfg.duckdb_threads));
            assert_eq!(cfg.duckdb_temp_mb, 1024);
            assert_eq!(cfg.build_uid_range, BUILD_UID_RANGE);
            assert_eq!((cfg.fleet_port_min, cfg.fleet_port_max), (20000, 29999));
            assert_eq!(cfg.build_uid_base, Some(BUILD_UID_BASE));
            assert_eq!(cfg.fleet_uid, Some(10020));
            assert_eq!(cfg.fleet_gid, Some(10020));
            assert_eq!(cfg.edge.client_rpm, 1800);
            assert_eq!(cfg.edge.git_rpm, 120);
            assert_eq!(cfg.edge.app_rpm, 0);
            assert_eq!(cfg.edge.wake_concurrency, 4);
        });
    }

    #[test]
    fn blank_numerics_mean_defaults() {
        // Compose renders an unset var as an empty string: still the default,
        // never a boot failure.
        with_env(
            &[("RUNNER_POLL_MS", ""), ("NOITE_FLEET_PORTS", "  ")],
            || {
                let cfg = Config::from_env().expect("blank numerics must boot");
                assert!(cfg.env_problems.is_empty());
                assert_eq!(cfg.poll_ms, 5000);
                assert_eq!((cfg.fleet_port_min, cfg.fleet_port_max), (20000, 29999));
            },
        );
    }

    #[test]
    fn valid_numerics_parse() {
        with_env(
            &[
                ("RUNNER_POLL_MS", "1000"),
                ("RUNNER_MAX_APPS_PER_USER", "3"),
                ("RUNNER_TELEMETRY_RETENTION_DAYS", " 7 "),
                ("NOITE_FLEET_PORTS", "21000-21999"),
                ("NOITE_EDGE_RPM", "60"),
                ("RUNNER_WAKE_CONCURRENCY", "2"),
                ("RUNNER_BUILD_UID_BASE", "20000"),
                ("RUNNER_FLEET_UID", "10020"),
                ("RUNNER_SLEEP_AFTER_H", "0"),
                ("NOITE_STOP_BUDGET_MS", "5000"),
            ],
            || {
                let cfg = Config::from_env().expect("valid numerics must boot");
                assert!(cfg.env_problems.is_empty());
                assert_eq!(cfg.poll_ms, 1000);
                assert_eq!(cfg.max_apps_per_user, 3);
                assert_eq!(cfg.telemetry_retention_days, 7);
                assert_eq!((cfg.fleet_port_min, cfg.fleet_port_max), (21000, 21999));
                assert_eq!(cfg.edge.client_rpm, 60);
                assert_eq!(cfg.edge.wake_concurrency, 2);
                assert_eq!(cfg.build_uid_base, Some(20000));
                assert_eq!(cfg.fleet_uid, Some(10020));
                assert_eq!(cfg.sleep_after_h, 0);
                assert_eq!(cfg.stop_budget_ms, 5000);
            },
        );
    }

    #[test]
    fn telemetry_duckdb_defaults_follow_the_machine() {
        // 2 GB: a tenth is 204 MiB. Threads follow the container's cores,
        // capped at 4 so a huge host does not fan a scan out 32 ways.
        assert_eq!(duckdb_memory_default_mb(Some(2 * 1024 * 1024 * 1024)), 204);
        assert_eq!(duckdb_memory_default_mb(Some(512 * 1024 * 1024)), 128);
        assert_eq!(
            duckdb_memory_default_mb(Some(64 * 1024 * 1024 * 1024)),
            1024
        );
        assert_eq!(duckdb_memory_default_mb(None), 256);
        assert_eq!(duckdb_threads_default(1), 1);
        assert_eq!(duckdb_threads_default(2), 2);
        assert_eq!(duckdb_threads_default(4), 4);
        assert_eq!(duckdb_threads_default(32), 4);
    }

    #[test]
    fn duckdb_knobs_override_and_validate() {
        with_env(
            &[
                ("RUNNER_DUCKDB_MEMORY_MB", "320"),
                ("RUNNER_DUCKDB_THREADS", "2"),
                ("RUNNER_DUCKDB_TEMP_MB", "0"),
            ],
            || {
                let cfg = Config::from_env().expect("valid numerics must boot");
                assert!(cfg.env_problems.is_empty());
                assert_eq!(
                    (cfg.duckdb_memory_mb, cfg.duckdb_threads, cfg.duckdb_temp_mb),
                    (320, 2, 0)
                );
            },
        );
        with_env(
            &[
                ("RUNNER_DUCKDB_MEMORY_MB", "32"),
                ("RUNNER_DUCKDB_THREADS", "0"),
            ],
            || {
                let error = Config::from_env().expect_err("validate refuses");
                let message = format!("{error:#}");
                assert!(message.contains("RUNNER_DUCKDB_MEMORY_MB"), "{message}");
                assert!(message.contains("RUNNER_DUCKDB_THREADS"), "{message}");
            },
        );
    }

    #[test]
    fn uid_sentinels_unset_the_id() {
        with_env(&[("RUNNER_BUILD_UID_BASE", "none")], || {
            let cfg = Config::from_env().expect("`none` must boot");
            assert!(cfg.env_problems.is_empty());
            assert_eq!(cfg.build_uid_base, None);
        });
    }

    #[test]
    fn telemetry_kill_switches_parse() {
        for raw in ["0", "false", "off", " OFF ", "False"] {
            assert!(
                parse_telemetry_disabled(Some(raw)),
                "{raw:?} disables telemetry"
            );
        }
        for raw in ["1", "true", "on", "", "yes"] {
            assert!(
                !parse_telemetry_disabled(Some(raw)),
                "{raw:?} does not disable telemetry"
            );
        }
        assert!(!parse_telemetry_disabled(None), "unset leaves it enabled");

        for raw in ["1", "true", "yes", "false", " 1 "] {
            assert!(parse_do_not_track(Some(raw)), "{raw:?} opts out");
        }
        for raw in ["0", "", "  "] {
            assert!(!parse_do_not_track(Some(raw)), "{raw:?} does not opt out");
        }
        assert!(!parse_do_not_track(None), "unset does not opt out");
    }

    #[test]
    fn local_domains_are_detected() {
        for domain in [
            "localhost",
            "LOCALHOST",
            "localhost.",
            "dev.localhost",
            "noite.local",
            "app.test",
            "box.internal",
            "127.0.0.1",
            "10.0.0.5",
            "::1",
        ] {
            assert!(is_local_domain(domain), "{domain:?} is local");
        }
        for domain in [
            "noite.now",
            "app.noite.now",
            "127.0.0.1.sslip.io",
            "10-0-0-5.nip.io",
            "local",
            "test",
            "internal",
            "notlocalhost",
            "",
        ] {
            assert!(!is_local_domain(domain), "{domain:?} is public");
        }
    }

    #[test]
    fn telemetry_lock_precedence() {
        let mut cfg = config_for_tests();
        // localhost (the test default) is a local domain.
        assert_eq!(cfg.telemetry_lock_reason(), Some("local domain"));

        cfg.base_domain = "noite.now".into();
        assert_eq!(cfg.telemetry_lock_reason(), None, "a public domain is open");

        cfg.do_not_track = true;
        assert_eq!(cfg.telemetry_lock_reason(), Some("DO_NOT_TRACK"));

        // NOITE_TELEMETRY=0 is listed first and wins over DO_NOT_TRACK.
        cfg.telemetry_disabled = true;
        assert_eq!(cfg.telemetry_lock_reason(), Some("NOITE_TELEMETRY=0"));

        // A lock from env holds even on a public domain.
        cfg.do_not_track = false;
        assert_eq!(cfg.telemetry_lock_reason(), Some("NOITE_TELEMETRY=0"));
    }

    #[test]
    fn tenant_bases_skips_ips_ports_and_dupes() {
        let mut cfg = config_for_tests();
        cfg.control_extra_hosts = vec![
            "noite.local".into(),
            "192.168.10.62".into(),
            "noite.local".into(),
            "weird:9080".into(),
            "".into(),
        ];
        assert_eq!(cfg.tenant_bases(), vec!["localhost", "noite.local"]);
    }

    #[test]
    fn trusted_proxies_expand_presets_and_reject_junk() {
        let (tp, bad) = parse_trusted_proxies("cloudflare, 10.0.0.0/8 private_ranges 2001:db8::1");
        assert!(tp.cloudflare);
        assert!(tp.ranges.contains(&"173.245.48.0/20".to_string()));
        assert!(tp.ranges.contains(&"10.0.0.0/8".to_string()));
        assert!(tp.ranges.contains(&"private_ranges".to_string()));
        assert!(tp.ranges.contains(&"2001:db8::1".to_string()));
        assert!(bad.is_empty());
        let (tp, bad) = parse_trusted_proxies("10.0.0.0/33, example.com, 1.2.3");
        assert!(tp.is_empty());
        assert_eq!(bad, vec!["10.0.0.0/33", "example.com", "1.2.3"]);
        assert!(parse_trusted_proxies("").0.is_empty());
    }

    #[test]
    fn public_app_url_follows_the_edge_not_the_git_remote() {
        // Dev: http with the public (non-default) port, whatever the git
        // remote's port says — the runner API's raw port is unreachable.
        let mut cfg = config_for_tests();
        cfg.base_domain = "noite.localhost".into();
        cfg.git_public_base = "http://localhost:8080/v1/git".into();
        assert_eq!(
            cfg.public_app_url("blog.noite.localhost"),
            "http://blog.noite.localhost:9080"
        );
        // Prod: plain https, the default port omitted.
        cfg.base_domain = "noite.now".into();
        cfg.auto_https = true;
        cfg.https_port = 443;
        assert_eq!(
            cfg.public_app_url("blog.noite.now"),
            "https://blog.noite.now"
        );
        // A non-default HTTPS port is carried, like a browser would show.
        cfg.https_port = 9443;
        assert_eq!(
            cfg.public_app_url("blog.noite.now"),
            "https://blog.noite.now:9443"
        );
        // Behind a terminating proxy (`CADDY_AUTO_HTTPS=off`) the edge
        // answers plaintext http on the public HTTP port.
        cfg.auto_https = false;
        cfg.http_port = 80;
        assert_eq!(
            cfg.public_app_url("blog.noite.now"),
            "http://blog.noite.now"
        );
    }

    /// Unset proxy section: email and AI off, the boot passes — the proxy
    /// still deploys (revalidate needs no operator config).
    #[test]
    fn void_proxy_defaults_to_disabled() {
        with_env(&[], || {
            let cfg = Config::from_env().expect("unset proxy section must boot");
            assert_eq!(cfg.void_proxy, VoidProxyConfig::default());
            assert!(cfg.void_proxy.email_domain.is_empty());
            assert!(cfg.void_proxy.smtp_host.is_empty());
            assert_eq!(cfg.void_proxy.smtp_port, None);
            assert_eq!(cfg.void_proxy.smtp_mode, VoidSmtpMode::Starttls);
            assert!(!cfg.void_proxy.smtp_allow_plaintext);
            assert!(cfg.void_proxy.email_allowlist.is_empty());
            assert!(!cfg.void_proxy.ai_enabled);
            assert!(cfg.void_proxy.ai_models.is_empty());
        });
    }

    /// The sandbox section defaults: cap 4, the image bundle path — and a
    /// configured cap parses, `0` included (admits nothing). Malformed
    /// refuses the boot naming the var.
    #[test]
    fn void_sandbox_config_defaults_and_validates() {
        with_env(&[], || {
            let cfg = Config::from_env().expect("unset sandbox section must boot");
            assert_eq!(cfg.void_sandbox_max_concurrent, 4);
            assert_eq!(cfg.void_sandbox_bundle_dir, "/opt/noite/void-sandbox");
        });
        with_env(
            &[
                ("NOITE_VOID_SANDBOX_MAX_CONCURRENT", "8"),
                ("VOID_SANDBOX_BUNDLE_DIR", "/tmp/sb-dist"),
            ],
            || {
                let cfg = Config::from_env().expect("set sandbox section must boot");
                assert_eq!(cfg.void_sandbox_max_concurrent, 8);
                assert_eq!(cfg.void_sandbox_bundle_dir, "/tmp/sb-dist");
            },
        );
        with_env(&[("NOITE_VOID_SANDBOX_MAX_CONCURRENT", "0")], || {
            let cfg = Config::from_env().expect("zero cap must boot");
            assert_eq!(cfg.void_sandbox_max_concurrent, 0);
        });
        with_env(&[("NOITE_VOID_SANDBOX_MAX_CONCURRENT", "  ")], || {
            let cfg = Config::from_env().expect("blank cap must boot");
            assert_eq!(cfg.void_sandbox_max_concurrent, 4);
        });
        for bad in ["four", "-1", "4x"] {
            with_env(&[("NOITE_VOID_SANDBOX_MAX_CONCURRENT", bad)], || {
                let err = format!("{:#}", Config::from_env().unwrap_err());
                assert!(
                    err.contains("NOITE_VOID_SANDBOX_MAX_CONCURRENT"),
                    "{}: {}",
                    bad,
                    err
                );
            });
        }
    }

    /// A fully configured section parses: modes, ports, flags, allowlist
    /// splitting and the model map pass through verbatim.
    #[test]
    fn void_proxy_full_config_parses() {
        with_env(
            &[
                ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                ("NOITE_VOID_SMTP_HOST", "smtp.example.com"),
                ("NOITE_VOID_SMTP_PORT", "2525"),
                ("NOITE_VOID_SMTP_MODE", "implicit"),
                (
                    "NOITE_VOID_EMAIL_ALLOWLIST",
                    "ops@example.com, @example.com",
                ),
                ("NOITE_VOID_AI_ENABLED", "1"),
                (
                    "NOITE_VOID_AI_MODELS",
                    r#"{"@cf/meta/llama": {"endpoint": "https://ai.example.com/v1", "model": "llama"}}"#,
                ),
            ],
            || {
                let cfg = Config::from_env().expect("full proxy config must boot");
                let proxy = &cfg.void_proxy;
                assert_eq!(proxy.email_domain, "mail.example.com");
                assert_eq!(proxy.smtp_host, "smtp.example.com");
                assert_eq!(proxy.smtp_port, Some(2525));
                assert_eq!(proxy.smtp_mode, VoidSmtpMode::Implicit);
                assert!(!proxy.smtp_allow_plaintext);
                assert_eq!(
                    proxy.email_allowlist,
                    vec!["ops@example.com", "@example.com"]
                );
                assert!(proxy.ai_enabled);
                assert!(proxy.ai_models.contains("@cf/meta/llama"));
                assert!(!proxy.ai_allow_plaintext);
            },
        );
    }

    /// Every malformed proxy value refuses the boot naming the var: modes,
    /// ports, flags, domain/host shapes, allowlist entries and the model
    /// map — plus the cross-field rules (host without domain, plain
    /// without the allowance, models without the AI flag, `http` AI
    /// endpoints without the allowance or past loopback).
    #[test]
    fn void_proxy_misconfiguration_fails_boot_naming_the_var() {
        let models = r#"{"@cf/m": {"endpoint": "https://ai.example.com/v1", "model": "m"}}"#;
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[("NOITE_VOID_SMTP_MODE", "ssl")], "NOITE_VOID_SMTP_MODE"),
            (&[("NOITE_VOID_SMTP_PORT", "smtp")], "NOITE_VOID_SMTP_PORT"),
            (&[("NOITE_VOID_SMTP_PORT", "0")], "NOITE_VOID_SMTP_PORT"),
            (&[("NOITE_VOID_AI_ENABLED", "yes")], "NOITE_VOID_AI_ENABLED"),
            (
                &[("NOITE_VOID_SMTP_ALLOW_PLAINTEXT", "yes")],
                "NOITE_VOID_SMTP_ALLOW_PLAINTEXT",
            ),
            (
                &[("NOITE_VOID_EMAIL_DOMAIN", "not a domain")],
                "NOITE_VOID_EMAIL_DOMAIN",
            ),
            (
                &[("NOITE_VOID_EMAIL_DOMAIN", "user@example.com")],
                "NOITE_VOID_EMAIL_DOMAIN",
            ),
            // A CR would inject an SMTP line through `EHLO ${domain}`.
            // (Interior: the parse trims the value's edges first.)
            (
                &[("NOITE_VOID_EMAIL_DOMAIN", "mail.exam\rple.com")],
                "NOITE_VOID_EMAIL_DOMAIN",
            ),
            (
                &[("NOITE_VOID_EMAIL_ALLOWLIST", "ops@exam\rple.com")],
                "NOITE_VOID_EMAIL_ALLOWLIST",
            ),
            (
                &[
                    ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                    ("NOITE_VOID_SMTP_HOST", "smtp example.com"),
                ],
                "NOITE_VOID_SMTP_HOST",
            ),
            (
                &[
                    ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                    ("NOITE_VOID_SMTP_HOST", "smtp.exam\rple.com"),
                ],
                "NOITE_VOID_SMTP_HOST",
            ),
            (
                &[("NOITE_VOID_EMAIL_ALLOWLIST", "bare-host")],
                "NOITE_VOID_EMAIL_ALLOWLIST",
            ),
            (
                &[("NOITE_VOID_EMAIL_ALLOWLIST", "@")],
                "NOITE_VOID_EMAIL_ALLOWLIST",
            ),
            (
                &[("NOITE_VOID_EMAIL_ALLOWLIST", "a@b@c")],
                "NOITE_VOID_EMAIL_ALLOWLIST",
            ),
            (
                &[("NOITE_VOID_SMTP_HOST", "smtp.example.com")],
                "NOITE_VOID_EMAIL_DOMAIN",
            ),
            (
                &[("NOITE_VOID_SMTP_MODE", "plain")],
                "NOITE_VOID_SMTP_ALLOW_PLAINTEXT",
            ),
            (
                &[("NOITE_VOID_AI_MODELS", "not json")],
                "NOITE_VOID_AI_MODELS",
            ),
            (&[("NOITE_VOID_AI_MODELS", "[1]")], "NOITE_VOID_AI_MODELS"),
            (
                &[(
                    "NOITE_VOID_AI_MODELS",
                    r#"{"m": {"endpoint": "https://ai.example.com/v1"}}"#,
                )],
                "NOITE_VOID_AI_MODELS",
            ),
            (
                &[(
                    "NOITE_VOID_AI_MODELS",
                    r#"{"m": {"endpoint": "gopher://x", "model": "m"}}"#,
                )],
                "NOITE_VOID_AI_MODELS",
            ),
            // Plaintext AI endpoints: refused without the allowance, and
            // past loopback even with it (a LAN name still crosses the
            // wire in cleartext).
            (
                &[(
                    "NOITE_VOID_AI_MODELS",
                    r#"{"m": {"endpoint": "http://127.0.0.1:8080/v1", "model": "m"}}"#,
                )],
                "NOITE_VOID_AI_ALLOW_PLAINTEXT",
            ),
            (
                &[("NOITE_VOID_AI_ALLOW_PLAINTEXT", "yes")],
                "NOITE_VOID_AI_ALLOW_PLAINTEXT",
            ),
            (
                &[
                    ("NOITE_VOID_AI_ALLOW_PLAINTEXT", "1"),
                    (
                        "NOITE_VOID_AI_MODELS",
                        r#"{"m": {"endpoint": "http://ai.example.com/v1", "model": "m"}}"#,
                    ),
                ],
                "NOITE_VOID_AI_MODELS",
            ),
            (
                &[
                    ("NOITE_VOID_AI_ALLOW_PLAINTEXT", "1"),
                    (
                        "NOITE_VOID_AI_MODELS",
                        r#"{"m": {"endpoint": "http://nas.local:8080/v1", "model": "m"}}"#,
                    ),
                ],
                "NOITE_VOID_AI_MODELS",
            ),
            (&[("NOITE_VOID_AI_MODELS", models)], "NOITE_VOID_AI_ENABLED"),
        ];
        for (vars, var) in cases {
            with_env(vars, || {
                let err = Config::from_env().expect_err("proxy misconfig must fail boot");
                let msg = format!("{:#}", err);
                assert!(msg.contains(var), "names {}: {}", var, msg);
            });
        }
        // The mode parse is case-insensitive; `plain` boots with the
        // allowance; explicit off-flags boot.
        with_env(
            &[
                ("NOITE_VOID_SMTP_MODE", "PLAIN"),
                ("NOITE_VOID_SMTP_ALLOW_PLAINTEXT", "true"),
                ("NOITE_VOID_AI_ENABLED", "off"),
            ],
            || {
                let cfg = Config::from_env().expect("plain+allowance must boot");
                assert_eq!(cfg.void_proxy.smtp_mode, VoidSmtpMode::Plain);
                assert!(cfg.void_proxy.smtp_allow_plaintext);
                assert!(!cfg.void_proxy.ai_enabled);
            },
        );
        // `http` AI endpoints boot only with the allowance on loopback
        // sidecars (`127/8`, `localhost`).
        with_env(
            &[
                ("NOITE_VOID_AI_ENABLED", "1"),
                ("NOITE_VOID_AI_ALLOW_PLAINTEXT", "1"),
                (
                    "NOITE_VOID_AI_MODELS",
                    r#"{"a": {"endpoint": "http://127.0.0.1:8080/v1", "model": "m"}, "b": {"endpoint": "http://localhost:11434/v1", "model": "m"}}"#,
                ),
            ],
            || {
                let cfg = Config::from_env().expect("http loopback+allowance must boot");
                assert!(cfg.void_proxy.ai_allow_plaintext);
            },
        );
    }

    /// In multi tenancy the proxy's upstreams must be publicly reachable:
    /// the proxy runs in the tenant fleet, whose egress policy rejects
    /// loopback/private destinations. Every refused form — loopback,
    /// private (v4 + ULA), link-local and CGNAT literals, `localhost`,
    /// `*.local`, `*.internal` and single-label names — fails the boot
    /// naming the var; the same values boot in single tenancy.
    #[test]
    fn void_proxy_multi_refuses_fleet_unreachable_upstreams() {
        // SMTP relay spellings: bare hosts plus the operator-written
        // `:port` and bracketed forms, which classify by their host part.
        let refused_relays = [
            "127.0.0.1",
            "127.0.0.2",
            "::1",
            "[::1]",
            "127.0.0.1:2525",
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "::ffff:10.0.0.1",
            "169.254.169.254",
            "fe80::1",
            "100.64.0.1",
            "0.0.0.0",
            "[::]",
            "100.127.255.255",
            "fc00::1",
            "fd12:3456::1",
            "localhost",
            "app.localhost",
            "smtp.local",
            "smtp.internal",
            "smtp",
        ];
        for host in refused_relays {
            with_env(
                &[
                    ("NOITE_TENANCY", "multi"),
                    ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                    ("NOITE_VOID_SMTP_HOST", host),
                ],
                || {
                    let err = Config::from_env().expect_err("multi must refuse the relay");
                    let msg = format!("{err:#}");
                    assert!(
                        msg.contains("NOITE_VOID_SMTP_HOST"),
                        "names the var for {host:?}: {msg}"
                    );
                },
            );
            with_env(
                &[
                    ("NOITE_TENANCY", "single"),
                    ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                    ("NOITE_VOID_SMTP_HOST", host),
                ],
                || {
                    Config::from_env().expect("single keeps the relay it always allowed");
                },
            );
        }
        // AI endpoint URLs on the same forms. The plaintext allowance is
        // set throughout, so the `http` loopback legs pin that the
        // allowance cannot save them in multi.
        let refused_endpoints = [
            "https://127.0.0.1/v1",
            "https://[::1]/v1",
            "https://10.0.0.5/v1",
            "https://172.16.0.1/v1",
            "https://192.168.1.1/v1",
            "https://[::ffff:10.0.0.1]/v1",
            "https://169.254.169.254/v1",
            "https://[fe80::1]/v1",
            "https://100.64.0.1/v1",
            "https://[fd00::1]/v1",
            "https://localhost:11434/v1",
            "https://app.localhost/v1",
            "https://ai.local/v1",
            "https://ai.internal/v1",
            "https://modelserver/v1",
            "http://127.0.0.1:8080/v1",
            "http://localhost:11434/v1",
        ];
        for endpoint in refused_endpoints {
            let models = format!(
                "{{\"m\": {{\"endpoint\": {:?}, \"model\": \"m\"}}}}",
                endpoint
            );
            with_env(
                &[
                    ("NOITE_TENANCY", "multi"),
                    ("NOITE_VOID_AI_ENABLED", "1"),
                    ("NOITE_VOID_AI_ALLOW_PLAINTEXT", "1"),
                    ("NOITE_VOID_AI_MODELS", models.as_str()),
                ],
                || {
                    let err = Config::from_env().expect_err("multi must refuse the endpoint");
                    let msg = format!("{err:#}");
                    assert!(
                        msg.contains("NOITE_VOID_AI_MODELS"),
                        "names the var for {endpoint:?}: {msg}"
                    );
                },
            );
            with_env(
                &[
                    ("NOITE_TENANCY", "single"),
                    ("NOITE_VOID_AI_ENABLED", "1"),
                    ("NOITE_VOID_AI_ALLOW_PLAINTEXT", "1"),
                    ("NOITE_VOID_AI_MODELS", models.as_str()),
                ],
                || {
                    Config::from_env().expect("single keeps the endpoint it always allowed");
                },
            );
        }
    }

    /// Public upstreams boot in both tenancies: names, public literals,
    /// and the addresses just outside each refused range. The bracketed
    /// public IPv6 endpoint pins that `url_host` yields the literal, not
    /// `[` (which would refuse as a single-label name).
    #[test]
    fn void_proxy_public_upstreams_boot_in_both_tenancies() {
        let relays = [
            "smtp.example.com",
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.167.0.1",
            "169.253.0.1",
            "2606:4700:4700::1111",
        ];
        let endpoints = [
            "https://ai.example.com/v1",
            "https://8.8.8.8/v1",
            "https://100.128.0.1/v1",
            "https://[2606:4700:4700::1111]/v1",
        ];
        for tenancy in ["single", "multi"] {
            for host in relays {
                with_env(
                    &[
                        ("NOITE_TENANCY", tenancy),
                        ("NOITE_VOID_EMAIL_DOMAIN", "mail.example.com"),
                        ("NOITE_VOID_SMTP_HOST", host),
                    ],
                    || {
                        Config::from_env().expect("public relay must boot");
                    },
                );
            }
            for endpoint in endpoints {
                let models = format!(
                    "{{\"m\": {{\"endpoint\": {:?}, \"model\": \"m\"}}}}",
                    endpoint
                );
                with_env(
                    &[
                        ("NOITE_TENANCY", tenancy),
                        ("NOITE_VOID_AI_ENABLED", "1"),
                        ("NOITE_VOID_AI_MODELS", models.as_str()),
                    ],
                    || {
                        Config::from_env().expect("public endpoint must boot");
                    },
                );
            }
        }
    }
}
