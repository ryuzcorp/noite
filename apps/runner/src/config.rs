use std::env;

/// Caddy `auto_https`: explicit off wins (behind-proxy deployments like
/// Coolify, where Traefik TCP-forwards SNI and our Caddy terminates per-host
/// TLS itself via on-demand certs); otherwise on except `localhost`.
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
        None => base_domain != "localhost",
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
    let host = auth.split(':').next().unwrap_or("").trim().trim_matches('.');
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
    let raw = raw.map(str::trim).filter(|v| !v.is_empty()).map(|v| v.to_ascii_lowercase());
    match raw.as_deref() {
        Some("single") => Tenancy::Single,
        Some("multi") => Tenancy::Multi,
        _ => {
            if base_domain == "localhost" {
                Tenancy::Single
            } else {
                Tenancy::Multi
            }
        }
    }
}

fn parse_opt_uid(raw: Option<&str>, def: u32) -> Option<u32> {
    match raw.map(str::trim) {
        None => Some(def),
        Some("") => Some(def),
        Some("none") | Some("disabled") | Some("-1") => None,
        Some(v) => v.parse().ok().or(Some(def)),
    }
}

/// Control UI inside this container: fleet #0 in prod, `vite dev` in dev.
pub const CONTROL_UPSTREAM: &str = "127.0.0.1:8090";
pub const CONTROL_UPSTREAM_URL: &str = "http://127.0.0.1:8090";
/// The runner's own API, as Caddy reaches it for `api.` and `git.`.
pub const API_UPSTREAM: &str = "127.0.0.1:8080";

fn parse_fleet_ports() -> (u16, u16) {
    if let Ok(raw) = env::var("NOITE_FLEET_PORTS") {
        let raw = raw.trim();
        if let Some((a, b)) = raw.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                if lo != 0 && hi > lo {
                    return (lo, hi);
                }
            }
        }
    }
    (20000, 29999)
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
     /// celld's shedding threshold in MiB (`CELLD_MAX_RSS_MB`); 0 leaves
     /// celld's default, 80% of the container's memory. celld compares it with
     /// the greater of its own RSS and the cgroup's working set, and every
     /// fleet shares the one container cgroup, so this is a container-wide
     /// threshold, not a per-tenant cap (SPEC, Limits): a per-fleet value
     /// such as 512 closes every fleet's admission as soon as the container
     /// as a whole passes it.
     pub fleet_max_rss_mb: u32,
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
     /// Graceful-stop budget in ms (SPEC, Shutdown). Fleets get
     /// budget - 3000 as CELLD_SHUTDOWN_TOTAL_MS.
     pub stop_budget_ms: u64,
    /// Max worktree bytes before a build is refused (RUNNER_BUILD_MAX_MB).
    pub build_max_mb: u64,
    /// Cap per app on the persistent bun cache (RUNNER_BUILD_CACHE_MB).
    /// Pruned oldest-first after each deploy; 0 disables persistence.
    pub build_cache_mb: u64,
    /// Days of telemetry kept everywhere (RUNNER_TELEMETRY_RETENTION_DAYS):
    /// celld's bucket prune, the metric table prune and the glob floor.
    pub telemetry_retention_days: i64,
    /// celld OTel bucket-flush interval in ms (`CELLD_OTEL_FLUSH_MS`), and the
    /// ingest tick cadence (spec T3.4). 30 s means ~6x fewer Parquet PUTs and
    /// files than the old 5 s; dashboards lag live traffic by up to ~40 s.
    pub otel_flush_ms: u64,
    /// Uids for the build sandbox (10010) and tenant fleets (10020).
    /// None = current user (dev only, single-tenant).
    pub build_uid: Option<u32>,
    pub build_gid: Option<u32>,
    pub fleet_uid: Option<u32>,
    pub fleet_gid: Option<u32>,
     /// Baked control bundle (fleet #0 source; absent in the dev image).
     pub control_bundle_dir: String,
     /// Better-auth origin for boot validation (host must be served).
     pub better_auth_url: String,
 }

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let runner_token = env_or(&["RUNNER_TOKEN"], "dev-runner-token");
        if runner_token.is_empty() {
            anyhow::bail!("RUNNER_TOKEN must not be empty");
        }
        let base_domain = env::var("BASE_DOMAIN").unwrap_or_else(|_| "localhost".into());
        if base_domain.trim().is_empty() {
            anyhow::bail!("BASE_DOMAIN must not be empty (got blank); set it to your domain, e.g. noite.now");
        }
        if base_domain != "localhost" && runner_token == "dev-runner-token" {
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
        let git_public_base = env::var("GIT_PUBLIC_BASE").unwrap_or_else(|_| {
            if base_domain == "localhost" {
                let port = env_or(&["HTTP_PORT"], "9080");
                format!("http://git.localhost:{port}")
            } else {
                format!("https://git.{base_domain}")
            }
        });
        let auto_https = parse_auto_https(
            env::var("CADDY_AUTO_HTTPS").ok().as_deref(),
            &base_domain,
        );
        let tenancy = parse_tenancy(env::var("NOITE_TENANCY").ok().as_deref(), &base_domain);
        let (fleet_port_min, fleet_port_max) = parse_fleet_ports();
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
            caddy_access_log: env::var("CADDY_ACCESS_LOG")
                .unwrap_or_else(|_| "/data/caddy/access.log".into()),
            celld_bin: env::var("CELLD_BIN").unwrap_or_else(|_| "celld".into()),
            fleet_port_min,
            fleet_port_max,
            poll_ms: env_or(&["RUNNER_POLL_MS"], "5000").parse().unwrap_or(5000),
            tip_sweep_s: env_or(&["RUNNER_TIP_SWEEP_S"], "60").parse().unwrap_or(60),
            // Everything Caddy proxies to lives in this container.
            caddy_upstream_host: "127.0.0.1".into(),
            auto_https,
            caddy_control_upstream: CONTROL_UPSTREAM.into(),
            caddy_api_upstream: API_UPSTREAM.into(),
            caddy_admin_url: env::var("CADDY_ADMIN_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:2019".into()),
            git_public_base,
            max_apps_per_user: env_or(&["RUNNER_MAX_APPS_PER_USER"], "10")
                .parse()
                .unwrap_or(10),
            fleet_max_rss_mb: env_or(&["RUNNER_FLEET_MAX_RSS_MB"], "0")
                .parse()
                .unwrap_or(0),
            fleet_log: env_or(&["RUNNER_FLEET_LOG"], "error,celld=warn"),
            fleet_idle_evict_s: env_or(&["RUNNER_FLEET_IDLE_EVICT_S"], "120")
                .parse()
                .unwrap_or(120),
            fleet_deploy_poll_s: env_or(&["RUNNER_FLEET_DEPLOY_POLL_S"], "300")
                .parse()
                .unwrap_or(300),
            sleep_after_h: env_or(&["RUNNER_SLEEP_AFTER_H"], "24")
                .parse()
                .unwrap_or(24),
            sleep_sweep_s: env_or(&["RUNNER_SLEEP_SWEEP_S"], "3600")
                .parse()
                .unwrap_or(3600),
            wake_timeout_s: env_or(&["RUNNER_WAKE_TIMEOUT_S"], "120")
                .parse()
                .unwrap_or(120),
            fleet_asset_cache_mb: env_or(&["RUNNER_FLEET_ASSET_CACHE_MB"], "64")
                .parse()
                .unwrap_or(64),
            tenancy,
            stop_budget_ms: env_or(&["NOITE_STOP_BUDGET_MS"], "25000")
                .parse()
                .unwrap_or(25000),
            build_max_mb: env_or(&["RUNNER_BUILD_MAX_MB"], "2048")
                .parse()
                .unwrap_or(2048),
            build_cache_mb: env_or(&["RUNNER_BUILD_CACHE_MB"], "512")
                .parse()
                .unwrap_or(512),
            telemetry_retention_days: env_or(&["RUNNER_TELEMETRY_RETENTION_DAYS"], "14")
                .parse()
                .unwrap_or(14),
            otel_flush_ms: env_or(&["RUNNER_OTEL_FLUSH_MS"], "30000")
                .parse()
                .unwrap_or(30000),
            build_uid: parse_opt_uid(env::var("RUNNER_BUILD_UID").ok().as_deref(), 10010),
            build_gid: parse_opt_uid(env::var("RUNNER_BUILD_GID").ok().as_deref(), 10010),
            fleet_uid: parse_opt_uid(env::var("RUNNER_FLEET_UID").ok().as_deref(), 10020),
            fleet_gid: parse_opt_uid(env::var("RUNNER_FLEET_GID").ok().as_deref(), 10020),
            control_bundle_dir: env::var("CONTROL_BUNDLE_DIR")
                .unwrap_or_else(|_| "/opt/noite/control/dist".into()),
            better_auth_url: env::var("BETTER_AUTH_URL").unwrap_or_default(),
        };
        cfg.validate()?;
        Ok(cfg)
    }
    /// Boot validation (SPEC, Configuration): fail fast with a
    /// list of problems instead of serving half-configured.
    pub fn validate(&self) -> anyhow::Result<()> {
        let mut problems: Vec<String> = Vec::new();
        let dev_token = self.runner_token == "dev-runner-token";
        let dev_auth = std::env::var("BETTER_AUTH_SECRET")
            .map(|v| v.trim().is_empty() || v.starts_with("dev-"))
            .unwrap_or(true);
        let dev_s3 = self.aws_access_key_id == "noiteaccess"
            || self.aws_secret_access_key == "noitesecretnoitesecretnoite12";
        if self.base_domain != "localhost" {
            if dev_token {
                problems.push("RUNNER_TOKEN is the dev default on a non-localhost BASE_DOMAIN".into());
            }
            if dev_s3 {
                problems.push("S3 keys are RustFS dev defaults on a non-localhost BASE_DOMAIN".into());
            }
        }
        if !self.better_auth_url.is_empty() {
            match url_host(&self.better_auth_url) {
                Some(host) => {
                    let served = self.control_hosts().iter().any(|h| h.eq_ignore_ascii_case(&host));
                    if !served {
                        problems.push(format!("BETTER_AUTH_URL host {host} is not a served control host"));
                    }
                }
                None => problems.push("BETTER_AUTH_URL does not parse".into()),
            }
            if dev_auth && self.base_domain != "localhost" {
                problems.push("BETTER_AUTH_SECRET is a dev default on a non-localhost BASE_DOMAIN".into());
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
        if self.otel_flush_ms < 1000 {
            problems.push("RUNNER_OTEL_FLUSH_MS must be >= 1000".into());
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

    /// Fleet shutdown bound for one celld node (budget minus drain margin).
    pub fn fleet_shutdown_ms(&self) -> u64 {
        self.stop_budget_ms.saturating_sub(3000)
    }

    /// Object-key prefix for tip bundles: `git/{slug}/`.
    pub fn git_prefix(slug: &str) -> String {
        format!("git/{slug}/")
    }

    /// Internal S3 layout URL (debug / tip poll); clients use `git_http_remote`.
    pub fn s3_git_remote(&self, slug: &str) -> String {
        format!("s3://{}/git/{slug}", self.s3_bucket)
    }

    /// Stock Git remote URL (no embedded credentials — use Profile API key).
    pub fn git_http_remote(&self, slug: &str) -> String {
        self.git_http_url(slug)
    }

    /// Embed Basic credentials for local scripts (`git:TOKEN@host/slug`).
    pub fn git_http_remote_with_token(&self, slug: &str, token: &str) -> String {
        let base = self.git_public_base.trim_end_matches('/');
        if let Some((scheme, rest)) = base.split_once("://") {
            format!("{scheme}://git:{token}@{rest}/{slug}")
        } else {
            format!("git:{token}@{base}/{slug}")
        }
    }

    pub fn git_http_url(&self, slug: &str) -> String {
        format!("{}/{slug}", self.git_public_base.trim_end_matches('/'))
    }

    /// celld fleet bucket URI: `s3://{bucket}/fleets/{slug}`.
    pub fn fleets_uri(&self, slug: &str) -> String {
        format!("s3://{}/fleets/{slug}", self.s3_bucket)
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
        assert!(parse_auto_https(None, "noite.now"));
    }

    #[test]
    fn tenant_bases_skips_ips_ports_and_dupes() {
        let cfg = Config {
            bind: "0.0.0.0:8080".into(),
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
            control_extra_hosts: vec![
                "noite.local".into(),
                "192.168.10.62".into(),
                "noite.local".into(),
                "weird:9080".into(),
                "".into(),
            ],
            work_dir: "/tmp/noite-test".into(),
            caddyfile_path: "/tmp/noite-test-bases".into(),
            celld_bin: "celld".into(),
            fleet_port_min: 20000,
            fleet_port_max: 29999,
            poll_ms: 5000,
            tip_sweep_s: 60,
            caddy_upstream_host: "127.0.0.1".into(),
            auto_https: false,
            fleet_log: "error,celld=warn".into(),
            max_apps_per_user: 10,
            fleet_max_rss_mb: 0,
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
            stop_budget_ms: 25000,
            build_max_mb: 2048,
            build_cache_mb: 512,
            telemetry_retention_days: 14,
            otel_flush_ms: 30000,
            build_uid: None,
            build_gid: None,
            fleet_uid: None,
            fleet_gid: None,
            control_bundle_dir: "/opt/noite/control/dist".into(),
            better_auth_url: "".into(),
        };
        assert_eq!(cfg.tenant_bases(), vec!["localhost", "noite.local"]);
    }
}
