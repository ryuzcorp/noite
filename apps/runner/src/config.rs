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
/// Host part of an http(s) URL without new deps: strip scheme, authority,
/// port. None when no `://` or empty host.
fn url_host(raw: &str) -> Option<String> {
    let (_, rest) = raw.split_once("://")?;
    let auth = rest.split('/').next().unwrap_or("");
    let auth = auth.split('@').next_back().unwrap_or("");
    let host = auth
        .split(':')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('.');
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

/// `DO_NOT_TRACK` (https://donottrack.sh): any non-empty value other than `0`
/// is a global opt-out and locks telemetry off.
pub fn parse_do_not_track(raw: Option<&str>) -> bool {
    raw.map(str::trim)
        .is_some_and(|v| !v.is_empty() && v != "0")
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
    /// celld's default, 80% of the container's memory. celld compares it with
    /// the greater of its own RSS and the cgroup's working set, and every
    /// fleet shares the one container cgroup, so this is a container-wide
    /// threshold, not a per-tenant cap (SPEC, Limits): a per-fleet value
    /// such as 512 closes every fleet's admission as soon as the container
    /// as a whole passes it.
    pub fleet_max_rss_mb: u32,
    /// Per-fleet memory cap in MiB (`RUNNER_FLEET_MEMORY_MB`, 512): each
    /// tenant fleet runs in its own cgroup v2 child with this `memory.max`,
    /// so one fleet's growth is OOM-killed inside its own group — contained,
    /// and the supervisor restarts it — instead of pushing every fleet toward
    /// the shared shed threshold (SPEC, Tenant isolation). An app's
    /// `app_limit.memory_mb` overrides it. `CELLD_MAX_RSS_MB` deliberately
    /// does not follow it: celld measures container-scale working set, so a
    /// per-fleet value would close every fleet's ready gate.
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
    /// Opt-out instance heartbeat (SPEC, telemetry): `NOITE_TELEMETRY`
    /// (`0`/`false`/`off`) locks it off.
    pub telemetry_disabled: bool,
    /// `DO_NOT_TRACK` set to anything but `0`/empty locks it off.
    pub do_not_track: bool,
    /// Opt-out update check (SPEC, update check): `NOITE_UPDATE_CHECK`
    /// (`0`/`false`/`off`) locks it off.
    pub update_check_disabled: bool,
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
        let cfg = Self {
            bind: env_or(&["RUNNER_BIND"], "0.0.0.0:8080"),
            runner_token,
            database_url,
            s3_endpoint: env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://rustfs:9000".into()),
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
                    // Resolved from the same vars as the literal below; kept
                    // inline so the two cannot drift.
                    endpoint: env::var("S3_ENDPOINT")
                        .unwrap_or_else(|_| "http://rustfs:9000".into()),
                    region: env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()),
                    access_key: env::var("AWS_ACCESS_KEY_ID")
                        .or_else(|_| env::var("RUSTFS_ACCESS_KEY"))
                        .unwrap_or_else(|_| "noiteaccess".into()),
                    secret_key: env::var("AWS_SECRET_ACCESS_KEY")
                        .or_else(|_| env::var("RUSTFS_SECRET_KEY"))
                        .unwrap_or_else(|_| "noitesecretnoitesecretnoite12".into()),
                },
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
            telemetry_disabled: parse_telemetry_disabled(
                env::var("NOITE_TELEMETRY").ok().as_deref(),
            ),
            do_not_track: parse_do_not_track(env::var("DO_NOT_TRACK").ok().as_deref()),
            update_check_disabled: parse_update_check_disabled(
                env::var("NOITE_UPDATE_CHECK").ok().as_deref(),
            ),
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
            self.credentials =
                crate::host::credentials::detect(&StoreAccess::from_config(self)).await?;
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
        // The platform default shares the per-app override's floor: below it
        // celld cannot boot, so a typo'd `1` refuses loudly instead of
        // OOM-looping every fleet. 0 disables the cap.
        if self.fleet_memory_mb != 0 && self.fleet_memory_mb < 64 {
            problems.push("RUNNER_FLEET_MEMORY_MB must be 0 (no cap) or >= 64".into());
        }
        if self.otel_flush_ms < 1000 {
            problems.push("RUNNER_OTEL_FLUSH_MS must be >= 1000".into());
        }
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
        build_uid_base: None,
        build_uid_range: BUILD_UID_RANGE,
        fleet_uid: None,
        fleet_gid: None,
        control_bundle_dir: "/opt/noite/control/dist".into(),
        better_auth_url: "".into(),
        edge: EdgeLimits::default(),
        telemetry_disabled: false,
        do_not_track: false,
        update_check_disabled: false,
        env_problems: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        "RUNNER_FLEET_IDLE_EVICT_S",
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
    /// cleared, `BASE_DOMAIN` pinned to the dev base, then `set` applied.
    /// Holds `ENV_LOCK` throughout and restores everything after, so a
    /// parallel `from_env` elsewhere never observes the mutation.
    fn with_env(set: &[(&str, &str)], f: impl FnOnce()) {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved: Vec<(&str, Option<String>)> = Vec::new();
        for key in STRICT_NUMERIC_VARS.iter().copied().chain(["BASE_DOMAIN"]) {
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
}
