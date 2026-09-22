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
    pub port_base: u16,
    pub poll_ms: u64,
    pub caddy_upstream_host: String,
    /// Caddy `auto_https`: unset = on except `localhost`; explicit
    /// `off` for behind-proxy deployments (our Caddy still terminates
    /// per-host TLS itself via on-demand certs).
    pub auto_https: bool,
    pub caddy_control_upstream: String,
    pub caddy_api_upstream: String,
    /// Public base for Git smart-HTTP remotes (no trailing slash).
    pub git_public_base: String,
    /// Control UI base URL for Git API-key auth (runner → UI).
    pub ui_url: String,
    /// Caddy JSON access log the device/path/ref tick tails. The Caddy `log`
    /// block is path-fixed at the volume root; the Caddyfile itself may live
    /// in a subpath (dev `dynamic/`).
    pub caddy_access_log: String,
    /// Run a loopback S3 sidecar (rustfs on 127.0.0.1:9000) and talk to it
    /// instead of `S3_ENDPOINT`. Set in the container cell, where the celld
    /// fence blocks every route to the compose-network object store; the
    /// worker relays durability into R2. Off in compose mode.
    pub sidecar_s3: bool,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let runner_token = env_or(
            &["RUNNER_TOKEN", "HOST_TOKEN", "AGENT_TOKEN"],
            "dev-runner-token",
        );
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
        let ui_url = env_or(&["UI_URL", "CONTROL_URL"], "http://ui:8080");
        let auto_https = parse_auto_https(
            env::var("CADDY_AUTO_HTTPS").ok().as_deref(),
            &base_domain,
        );
        Ok(Self {
            bind: env_or(
                &["RUNNER_BIND", "HOST_BIND", "AGENT_BIND"],
                "0.0.0.0:8080",
            ),
            runner_token,
            database_url,
            s3_endpoint: env::var("S3_ENDPOINT").unwrap_or_else(|_| "http://rustfs:9000".into()),
            s3_public_endpoint: env::var("S3_PUBLIC_ENDPOINT")
                .unwrap_or_else(|_| "http://127.0.0.1:9000".into()),
            s3_bucket: env_or(&["NOITE_S3_BUCKET", "S3_BUCKET"], "noite"),
            aws_region: env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".into()),
            aws_access_key_id: env::var("AWS_ACCESS_KEY_ID")
                .or_else(|_| env::var("RUSTFS_ACCESS_KEY"))
                .unwrap_or_else(|_| "noiteaccess".into()),
            aws_secret_access_key: env::var("AWS_SECRET_ACCESS_KEY")
                .or_else(|_| env::var("RUSTFS_SECRET_KEY"))
                .unwrap_or_else(|_| "noitesecretnoitesecretnoite12".into()),
            base_domain,
            control_subdomain: env::var("CONTROL_SUBDOMAIN").unwrap_or_default(),
            control_extra_hosts: env::var("CONTROL_EXTRA_HOSTS")
                .map(|v| parse_host_list(&v))
                .unwrap_or_default(),
            work_dir: env_or(
                &["RUNNER_WORK_DIR", "HOST_WORK_DIR", "AGENT_WORK_DIR"],
                "/data/runner",
            ),
            caddyfile_path: env::var("CADDYFILE_PATH")
                .unwrap_or_else(|_| "/caddy/Caddyfile".into()),
            caddy_access_log: env::var("CADDY_ACCESS_LOG")
                .unwrap_or_else(|_| "/caddy/access.log".into()),
            celld_bin: env::var("CELLD_BIN").unwrap_or_else(|_| "celld".into()),
            port_base: env_or(&["PORT_BASE"], "8100").parse().unwrap_or(8100),
            poll_ms: env_or(
                &["RUNNER_POLL_MS", "HOST_POLL_MS", "AGENT_POLL_MS"],
                "5000",
            )
            .parse()
            .unwrap_or(5000),
            caddy_upstream_host: env_or(&["CADDY_UPSTREAM_HOST"], "runner"),
            auto_https,
            caddy_control_upstream: env::var("CADDY_CONTROL_UPSTREAM")
                .unwrap_or_else(|_| "ui:8080".into()),
            caddy_api_upstream: env_or(&["CADDY_API_UPSTREAM"], "runner:8080"),
            git_public_base,
            ui_url: ui_url.trim_end_matches('/').to_string(),
            sidecar_s3: matches!(
                env_or(&["RUNNER_SIDECAR_S3"], "0").as_str(),
                "1" | "true" | "yes"
            ),
        })
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
            port_base: 8100,
            poll_ms: 5000,
            caddy_upstream_host: "runner".into(),
            auto_https: false,
            caddy_control_upstream: "ui:8080".into(),
            caddy_api_upstream: "runner:8080".into(),
            git_public_base: "https://git.localhost".into(),
            ui_url: "http://ui:8080".into(),
            caddy_access_log: "/caddy/access.log".into(),
            sidecar_s3: false,
        };
        assert_eq!(cfg.tenant_bases(), vec!["localhost", "noite.local"]);
    }
}
