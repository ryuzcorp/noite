//! Explicit environment for fleet celld processes (SPEC, Tenant isolation).
//!
//! Every fleet spawn — tenant fleets in `host::supervisor`, the control
//! fleet in `host::control` — starts from `env_clear()` plus exactly the
//! entries built here. The runner's own environment (`RUNNER_TOKEN`, cloud
//! and store credentials, operator-global `CELLD_*`) never reaches a fleet:
//! each spawn passes only what celld and the fleet need, so the old
//! `env_remove` denylists are gone.
//!
//! What celld reads (fork `ryuzcorp/v0.6.3`, `docs/README.md` env table and
//! `crates/celld`): the `CELLD_*` knobs below plus `CELLD_OPERATOR_TOKEN`,
//! the store credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
//! `AWS_REGION`/`AWS_DEFAULT_REGION`, `S3_ENDPOINT`; the SDK-standard
//! `AWS_ENDPOINT_URL`/`AWS_ENDPOINT` fallback stays unset because the
//! runner always passes `--endpoint`), `RUST_LOG`, `DOCKER_HOST` (the
//! fleet's own proxy socket; unset means celld falls back to discovering a
//! daemon socket), `PATH` (the `esbuild`/`docker`/`hostname` lookups),
//! `HOME` (the Python runtime cache and docker-socket fallbacks) and
//! `TMPDIR` (the `temp_dir()` default; the hot paths use explicit
//! `CELLD_*` dirs). TLS trusts the system store plus three passthroughs:
//! `SSL_CERT_FILE`/`SSL_CERT_DIR` (rustls-native-certs, via the object
//! store's hyper client) and `AWS_CA_BUNDLE` (the S3 client) — the only
//! runner-env values a fleet inherits, so a BYO store behind a private CA
//! keeps working. celld pins its Worker TLS roots (webpki) and honors no
//! proxy env, so nothing else is passed.
//!
//! Tenant vars (`db::tenant_env`, already denylisted by
//! `db::env_reserved`) are applied first, so every platform knob wins over
//! them by construction — including `PATH`, `HOME` and `RUST_LOG`, which
//! previously kept a tenant-supplied value.

use crate::config::Config;

/// `PATH` for fleet processes: the toolchain lookups (`esbuild`,
/// `docker`, `hostname`) resolve from the image, never from the runner.
pub const FLEET_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// `TMPDIR` for fleet processes: today's effective value (the runner sets
/// none), kept so `temp_dir()` users behave exactly as before.
pub const FLEET_TMPDIR: &str = "/tmp";

/// The only runner-env values a fleet inherits: custom-CA trust for a BYO
/// store. Each is passed only when set and non-empty.
const TLS_PASSTHROUGH: &[&str] = &["SSL_CERT_FILE", "SSL_CERT_DIR", "AWS_CA_BUNDLE"];

/// Base every fleet needs: `PATH`, a writable `HOME`, `TMPDIR`, and the
/// TLS passthrough. Tenant fleets pass their state dir as `HOME` (owned by
/// the fleet uid); the control fleet passes `/root`, its effective value
/// today.
pub fn base_env(home: &str) -> Vec<(String, String)> {
    let mut env = vec![
        ("PATH".to_string(), FLEET_PATH.to_string()),
        ("HOME".to_string(), home.to_string()),
        ("TMPDIR".to_string(), FLEET_TMPDIR.to_string()),
    ];
    for key in TLS_PASSTHROUGH {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                env.push((key.to_string(), value));
            }
        }
    }
    env
}

/// Store credentials celld opens its bucket with: explicit values only, so
/// a fleet never falls back to an ambient credential chain.
pub fn store_env(
    access_key: &str,
    secret_key: &str,
    region: &str,
    endpoint: &str,
) -> Vec<(String, String)> {
    vec![
        ("AWS_ACCESS_KEY_ID".to_string(), access_key.to_string()),
        ("AWS_SECRET_ACCESS_KEY".to_string(), secret_key.to_string()),
        ("AWS_REGION".to_string(), region.to_string()),
        ("AWS_EC2_METADATA_DISABLED".to_string(), "true".to_string()),
        ("S3_ENDPOINT".to_string(), endpoint.to_string()),
    ]
}

/// The `CELLD_EGRESS_ALLOW` entry a fleet needs: its object store as
/// `host:port`, so Worker fetches keep reaching the store (which answers
/// 401/403 without keys). A hostname entry re-resolves on every check, so
/// a moved store stays allowed without a respawn. `None` when the endpoint
/// is not a URL with a host — the fleet then runs with no exception rather
/// than refusing to boot on an invalid entry (celld rejects a malformed
/// allowlist at startup).
pub fn egress_allow(s3_endpoint: &str) -> Option<String> {
    let url = reqwest::Url::parse(s3_endpoint).ok()?;
    // `host_str` keeps an IPv6 literal's brackets, which is exactly the
    // `host:port` spelling celld parses — and it excludes userinfo, so
    // credentials in the endpoint cannot leak into the allowlist.
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    // Port 0 is not a dialable exception: celld refuses to boot on it, so
    // a nonsense endpoint yields no entry instead. A comma would split into
    // two entries in celld's comma-separated list (`1.2.3.4,x` allows the
    // whole of 1.2.3.4 on any port), so it yields no entry either.
    if port == 0 || host.contains(',') {
        return None;
    }
    Some(format!("{host}:{port}"))
}

/// Inputs for one tenant fleet's environment: the platform config plus the
/// per-spawn values `ensure_spawned` already resolves (scoped credentials,
/// the ensured operator token, the cgroup leaf, the engine socket).
pub struct TenantFleetEnv<'a> {
    pub cfg: &'a Config,
    pub state_dir: &'a str,
    pub access_key: &'a str,
    pub secret_key: &'a str,
    pub operator_token: &'a str,
    pub tenant_env: &'a [(String, String)],
    pub has_cgroup_leaf: bool,
    pub engine_socket: Option<&'a str>,
}

/// Full environment for one tenant fleet spawn, in apply order: tenant
/// vars first, then every platform entry, so the platform wins each key it
/// sets. Knobs the fleet does not configure are simply absent — with
/// `env_clear()` there is nothing to remove.
pub fn tenant_fleet_env(input: &TenantFleetEnv<'_>) -> Vec<(String, String)> {
    let cfg = input.cfg;
    let mut env: Vec<(String, String)> = Vec::new();
    for (key, value) in input.tenant_env {
        env.push((key.clone(), value.clone()));
    }
    env.extend(base_env(input.state_dir));
    env.extend(store_env(
        input.access_key,
        input.secret_key,
        &cfg.aws_region,
        &cfg.s3_endpoint,
    ));
    let mut put = |key: &str, value: String| env.push((key.to_string(), value));
    put("CELLD_WATCH", input.state_dir.to_string());
    put("CELLD_DURABILITY", "bucket".to_string());
    // Inside the runner's stop budget, so celld seals its node log before
    // the runner's own SIGKILL fallback (SPEC, Shutdown).
    put(
        "CELLD_SHUTDOWN_TOTAL_MS",
        cfg.fleet_shutdown_ms().to_string(),
    );
    // Bounds: idle eviction returns memory when an app goes quiet; the
    // shedding threshold (set below only when configured) is container-wide.
    // celld's own logs are what an app owner reads when a deploy serves but
    // misbehaves; the runner's own filter must never suppress them.
    put("RUST_LOG", cfg.fleet_log.clone());
    put("CELLD_IDLE_EVICT_S", cfg.fleet_idle_evict_s.to_string());
    // See `Config::fleet_lease_ttl_ms`: a short store stall must not
    // self-fence every fleet at once.
    put("CELLD_TTL_MS", cfg.fleet_lease_ttl_ms.to_string());
    // T1.5: the runner POSTs /reload after every deploy path (push,
    // rollback, web commit, rename), so the fleet's own poll only covers a
    // missed reload — every 300 s instead of every 5 s.
    put("CELLD_DEPLOY_POLL_S", cfg.fleet_deploy_poll_s.to_string());
    // T1.8: bound the per-fleet on-disk asset cache (celld's 512 MiB
    // default, per idle app, is unbounded across fleets).
    put(
        "CELLD_ASSET_CACHE_BYTES",
        (cfg.fleet_asset_cache_mb * 1024 * 1024).to_string(),
    );
    // In the fleet's own state dir: celld's default, /tmp/celld/asset-cache,
    // is one directory for every node in the container, created 0700 by
    // whichever starts first (the control node, as root), so a fleet serving
    // assets as the fleet uid crash-looped on EACCES, and tenants would share
    // one cache even when it opened.
    put(
        "CELLD_ASSET_CACHE_DIR",
        format!("{}/asset-cache", input.state_dir),
    );
    put("CELLD_TRUST_FORWARDED_HEADERS", "1".to_string());
    put(
        crate::host::credentials::OPERATOR_TOKEN_ENV,
        input.operator_token.to_string(),
    );
    // Worker egress (SPEC, Egress policy): in `multi` the fleet's Workers
    // dial public addresses only, with the object store as the one named
    // exception. `single` keeps no egress policy, as before (its one tenant
    // is trusted).
    if matches!(cfg.tenancy, crate::config::Tenancy::Multi) {
        put("CELLD_EGRESS", "public".to_string());
        if let Some(allow) = egress_allow(&cfg.s3_endpoint) {
            put("CELLD_EGRESS_ALLOW", allow);
        }
    }
    // Fleet telemetry -> Parquet in the fleet bucket (celld OTel, bucket
    // sink), the documented query path for request counts.
    for (key, value) in crate::host::metrics::otel_env(cfg) {
        put(key, value);
    }
    // With its own leaf the fleet also sheds against it: `self` measures
    // the process's own cgroup instead of the container root, so the shed
    // threshold follows the per-fleet cap. Without a leaf (no cgroup grant)
    // the knob keeps its container-wide meaning, as before.
    if input.has_cgroup_leaf {
        put("CELLD_MEMORY_SCOPE", "self".to_string());
    }
    // The documented knob is `RUNNER_FLEET_MAX_RSS_MB`; a zero value sets
    // nothing instead of a container-wide threshold the operator never
    // configured per fleet.
    if cfg.fleet_max_rss_mb > 0 {
        put("CELLD_MAX_RSS_MB", cfg.fleet_max_rss_mb.to_string());
    }
    // The fleet reaches the engine only through its own proxy socket; with
    // sandboxing off (or the socket unservable) it gets no engine at all.
    if let Some(socket) = input.engine_socket {
        put("DOCKER_HOST", format!("unix://{socket}"));
    }
    env
}

/// Inputs for the control fleet's environment: the platform config (whose
/// store credentials the control node uses) plus its ensured operator
/// token.
pub struct ControlFleetEnv<'a> {
    pub cfg: &'a Config,
    pub operator_token: &'a str,
}

/// Full environment for the control fleet spawn. Like a tenant fleet but
/// with no tenant vars, no egress or memory-scope policy of its own, and
/// no engine: the control UI declares no container classes, and only the
/// runner holds the engine socket. The store credentials and `RUST_LOG`
/// below used to arrive by inheritance; they are explicit now.
pub fn control_fleet_env(input: &ControlFleetEnv<'_>) -> Vec<(String, String)> {
    let cfg = input.cfg;
    let mut env = base_env("/root");
    env.extend(store_env(
        &cfg.aws_access_key_id,
        &cfg.aws_secret_access_key,
        &cfg.aws_region,
        &cfg.s3_endpoint,
    ));
    let mut put = |key: &str, value: String| env.push((key.to_string(), value));
    put("CELLD_TRUST_FORWARDED_HEADERS", "1".to_string());
    put("CELLD_WATCH", "/data/control".to_string());
    put("CELLD_READY_FLEET_GATE_MS", "15000".to_string());
    put("CELLD_DURABILITY", "bucket".to_string());
    if !input.operator_token.is_empty() {
        put(
            crate::host::credentials::OPERATOR_TOKEN_ENV,
            input.operator_token.to_string(),
        );
    }
    put(
        "CELLD_SHUTDOWN_TOTAL_MS",
        cfg.fleet_shutdown_ms().to_string(),
    );
    // The same lease as tenant fleets (`Config::fleet_lease_ttl_ms`), and
    // the same log filter: the runner's own filter must never suppress the
    // control node's logs either.
    put("CELLD_TTL_MS", cfg.fleet_lease_ttl_ms.to_string());
    put("RUST_LOG", cfg.fleet_log.clone());
    for (key, value) in crate::host::metrics::otel_env(cfg) {
        put(key, value);
    }
    env
}

/// Apply a built fleet env to a spawn: nothing is inherited, so the child
/// sees exactly `env` (later entries win on duplicate keys, which is how
/// the platform knobs override tenant vars).
pub fn apply(cmd: &mut tokio::process::Command, env: &[(String, String)]) {
    cmd.env_clear();
    for (key, value) in env {
        cmd.env(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// Platform keys a tenant fleet spawn may set: the base, the store, the
    /// celld knobs, the token, the conditional knobs, and the TLS
    /// passthrough. Everything else in a child must be a tenant var the
    /// spawn was explicitly given.
    fn tenant_allowlist() -> HashSet<String> {
        [
            "PATH",
            "HOME",
            "TMPDIR",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
            "AWS_CA_BUNDLE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_REGION",
            "AWS_EC2_METADATA_DISABLED",
            "S3_ENDPOINT",
            "CELLD_WATCH",
            "CELLD_DURABILITY",
            "CELLD_SHUTDOWN_TOTAL_MS",
            "RUST_LOG",
            "CELLD_IDLE_EVICT_S",
            "CELLD_TTL_MS",
            "CELLD_DEPLOY_POLL_S",
            "CELLD_ASSET_CACHE_BYTES",
            "CELLD_ASSET_CACHE_DIR",
            "CELLD_TRUST_FORWARDED_HEADERS",
            "CELLD_OPERATOR_TOKEN",
            "CELLD_EGRESS",
            "CELLD_EGRESS_ALLOW",
            "CELLD_MEMORY_SCOPE",
            "CELLD_MAX_RSS_MB",
            "DOCKER_HOST",
            "CELLD_OTEL",
            "CELLD_OTEL_FLUSH_MS",
            "CELLD_OTEL_RETENTION",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    /// Secrets and operator-global knobs that must never reach a fleet even
    /// when the runner's own environment carries them.
    const HOSTILE: &[&str] = &[
        "RUNNER_TOKEN",
        "BETTER_AUTH_SECRET",
        "NOITE_SMTP_FROM",
        "CELLD_EGRESS",
        "CELLD_EGRESS_ALLOW",
        "CELLD_MEMORY_SCOPE",
        "CELLD_MAX_RSS_MB",
        "CELLD_CONTAINER_RUNTIME",
        "CELLD_CONTAINER_DNS",
        "DOCKER_HOST",
        "AWS_SESSION_TOKEN",
        "LD_PRELOAD",
    ];

    /// Install the hostile process env: every `HOSTILE` key set to a canary,
    /// the TLS passthrough cleared (set explicitly by the tests that need
    /// it), `BASE_DOMAIN` pinned, `NOITE_TENANCY` pinned to `tenancy`, and a
    /// hostile store endpoint the builder must reproduce verbatim in its own
    /// entries (and in the egress exception) without leaking userinfo into
    /// the allowlist. Returns the saved values for [`restore_env`]. The
    /// caller must hold `ENV_LOCK`.
    fn install_hostile_env(tenancy: Option<&str>) -> Vec<(&'static str, Option<String>)> {
        let mut saved: Vec<(&'static str, Option<String>)> = Vec::new();
        let mut stash = |key: &'static str| {
            saved.push((key, std::env::var(key).ok()));
        };
        for key in HOSTILE {
            stash(key);
            std::env::set_var(key, format!("hostile-{key}"));
        }
        for key in TLS_PASSTHROUGH {
            stash(key);
            std::env::remove_var(key);
        }
        for key in ["BASE_DOMAIN", "NOITE_TENANCY", "S3_ENDPOINT"] {
            stash(key);
        }
        std::env::set_var("BASE_DOMAIN", "noite.localhost");
        match tenancy {
            Some(t) => std::env::set_var("NOITE_TENANCY", t),
            None => std::env::remove_var("NOITE_TENANCY"),
        }
        std::env::set_var("S3_ENDPOINT", "http://user:pass@rustfs:9000");
        saved
    }

    fn restore_env(saved: Vec<(&'static str, Option<String>)>) {
        for (key, old) in saved {
            match old {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }

    /// Restores the pre-hostile env on drop, so a failing assert cannot leak
    /// the hostile values into another test.
    struct RestoreOnDrop(Option<Vec<(&'static str, Option<String>)>>);

    impl Drop for RestoreOnDrop {
        fn drop(&mut self) {
            if let Some(saved) = self.0.take() {
                restore_env(saved);
            }
        }
    }

    /// Run `f` with a hostile process env. Holds `ENV_LOCK` throughout and
    /// restores everything after, even on panic.
    fn with_hostile_env(tenancy: Option<&str>, f: impl FnOnce()) {
        let _lock = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreOnDrop(Some(install_hostile_env(tenancy)));
        f();
    }

    /// Last entry wins, like `Command::env` over `env_clear`.
    fn flattened(env: &[(String, String)]) -> HashMap<String, String> {
        let mut map = HashMap::new();
        for (key, value) in env {
            map.insert(key.clone(), value.clone());
        }
        map
    }

    fn tenant_input<'a>(cfg: &'a Config, tenant_env: &'a [(String, String)]) -> TenantFleetEnv<'a> {
        TenantFleetEnv {
            cfg,
            state_dir: "/data/fleets/app",
            access_key: "scoped-access",
            secret_key: "scoped-secret",
            operator_token: "op-token",
            tenant_env,
            has_cgroup_leaf: false,
            engine_socket: None,
        }
    }

    /// The store exception is the endpoint's `host:port` — a hostname entry
    /// re-resolves on every check, an IPv6 literal takes brackets, and a
    /// default port is spelled out (celld entries need one). Garbage yields
    /// no entry rather than a value that would refuse the node its boot.
    #[test]
    fn egress_allow_names_the_store_host_and_port() {
        assert_eq!(
            egress_allow("http://rustfs:9000"),
            Some("rustfs:9000".to_string())
        );
        assert_eq!(
            egress_allow("https://s3.example.com"),
            Some("s3.example.com:443".to_string())
        );
        assert_eq!(
            egress_allow("http://10.89.0.7:9000/noite"),
            Some("10.89.0.7:9000".to_string())
        );
        assert_eq!(
            egress_allow("http://[fd00::7]:9000"),
            Some("[fd00::7]:9000".to_string())
        );
        // Credentials in the endpoint stay out of the allowlist.
        assert_eq!(
            egress_allow("http://user:pass@rustfs:9000"),
            Some("rustfs:9000".to_string())
        );
        for bad in [
            "",
            "not a url",
            "http://",
            "unix:///sock",
            "http://rustfs:0",
            // A comma would split into two allowlist entries.
            "http://1.2.3.4,x:9000",
            "http://1.2.3.4%2Cx:9000",
        ] {
            assert_eq!(egress_allow(bad), None, "{bad:?} yields no entry");
        }
    }

    /// A tenant fleet's env under a hostile runner env: no `RUNNER_TOKEN`,
    /// nothing outside the allowlist plus the given tenant vars, the scoped
    /// store credentials (not the process env), and the platform winning
    /// every key it sets — including `PATH`, `HOME` and `RUST_LOG`, which
    /// previously kept a tenant-supplied value.
    #[test]
    fn tenant_fleet_env_holds_no_runner_secrets() {
        with_hostile_env(None, || {
            let mut cfg = Config::from_env().expect("config");
            cfg.aws_region = "us-east-1".into();
            cfg.fleet_log = "error,celld=warn".into();
            cfg.fleet_max_rss_mb = 0;
            let tenant_env = vec![
                ("DATABASE_URL".to_string(), "postgres://app/db".to_string()),
                ("PATH".to_string(), "/tenant/bin".to_string()),
                ("HOME".to_string(), "/tenant/home".to_string()),
                ("RUST_LOG".to_string(), "trace".to_string()),
            ];
            let flat = flattened(&tenant_fleet_env(&tenant_input(&cfg, &tenant_env)));
            assert!(
                !flat.contains_key("RUNNER_TOKEN"),
                "runner token must not reach a fleet"
            );
            let allowlist = tenant_allowlist();
            let tenant_keys: HashSet<String> = tenant_env.iter().map(|(k, _)| k.clone()).collect();
            for key in flat.keys() {
                assert!(
                    allowlist.contains(key) || tenant_keys.contains(key),
                    "{key} is outside the allowlist"
                );
            }
            for key in HOSTILE {
                if *key == "RUNNER_TOKEN" {
                    continue;
                }
                // No hostile value survives: single tenancy sets no egress
                // or memory knobs, no engine socket, and no TLS passthrough
                // was configured, so every hostile key is either absent or
                // overwritten by the platform.
                if let Some(value) = flat.get(*key) {
                    assert!(
                        !value.starts_with("hostile-"),
                        "{key} kept its hostile value: {value}"
                    );
                }
            }
            assert_eq!(flat["PATH"], FLEET_PATH, "platform PATH wins");
            assert_eq!(flat["HOME"], "/data/fleets/app", "platform HOME wins");
            assert_eq!(flat["TMPDIR"], FLEET_TMPDIR);
            assert_eq!(flat["RUST_LOG"], "error,celld=warn", "platform filter wins");
            assert_eq!(flat["AWS_ACCESS_KEY_ID"], "scoped-access");
            assert_eq!(flat["AWS_SECRET_ACCESS_KEY"], "scoped-secret");
            assert_eq!(flat["CELLD_OPERATOR_TOKEN"], "op-token");
            assert_eq!(flat["DATABASE_URL"], "postgres://app/db");
            assert!(
                !flat.contains_key("CELLD_EGRESS"),
                "single tenancy sets no egress policy, hostile or otherwise"
            );
            assert!(!flat.contains_key("CELLD_MEMORY_SCOPE"));
            assert!(!flat.contains_key("CELLD_MAX_RSS_MB"));
            assert!(!flat.contains_key("DOCKER_HOST"));
            assert!(!flat.contains_key("AWS_SESSION_TOKEN"));
            assert!(!flat.contains_key("LD_PRELOAD"));
        });
    }

    /// `multi` sets the egress policy from the platform config, and the
    /// exception carries the store host without its userinfo; the cgroup
    /// leaf, the RSS cap and the engine socket each add exactly their knob.
    #[test]
    fn tenant_fleet_env_multi_sets_its_own_policy() {
        with_hostile_env(Some("multi"), || {
            let mut cfg = Config::from_env().expect("config");
            cfg.aws_region = "us-east-1".into();
            cfg.fleet_max_rss_mb = 512;
            let tenant_env = vec![];
            let mut input = tenant_input(&cfg, &tenant_env);
            input.has_cgroup_leaf = true;
            input.engine_socket = Some("/run/noite/app.sock");
            let flat = flattened(&tenant_fleet_env(&input));
            assert_eq!(flat["CELLD_EGRESS"], "public");
            assert_eq!(
                flat["CELLD_EGRESS_ALLOW"], "rustfs:9000",
                "store host without userinfo"
            );
            assert_eq!(flat["CELLD_MEMORY_SCOPE"], "self");
            assert_eq!(flat["CELLD_MAX_RSS_MB"], "512");
            assert_eq!(flat["DOCKER_HOST"], "unix:///run/noite/app.sock");
            assert!(
                !flat.contains_key("RUNNER_TOKEN"),
                "runner token must not reach a fleet"
            );
        });
    }

    /// The TLS passthrough is opt-in per variable: set entries pass through
    /// verbatim (a BYO store behind a private CA keeps working), unset ones
    /// stay absent, and empties are dropped.
    #[test]
    fn tenant_fleet_env_passes_tls_trust_only_when_set() {
        with_hostile_env(None, || {
            std::env::set_var("SSL_CERT_FILE", "/certs/store.pem");
            std::env::set_var("SSL_CERT_DIR", "");
            let cfg = Config::from_env().expect("config");
            let tenant_env = vec![];
            let flat = flattened(&tenant_fleet_env(&tenant_input(&cfg, &tenant_env)));
            assert_eq!(flat["SSL_CERT_FILE"], "/certs/store.pem");
            assert!(!flat.contains_key("SSL_CERT_DIR"), "empty stays absent");
            assert!(!flat.contains_key("AWS_CA_BUNDLE"), "unset stays absent");
            std::env::remove_var("SSL_CERT_FILE");
            std::env::remove_var("SSL_CERT_DIR");
        });
    }

    /// The control fleet's env: the platform's own store credentials passed
    /// explicitly (they used to arrive by inheritance), the platform log
    /// filter, no egress or engine of its own — and no runner secrets.
    #[test]
    fn control_fleet_env_is_explicit_and_secret_free() {
        with_hostile_env(None, || {
            let mut cfg = Config::from_env().expect("config");
            cfg.aws_access_key_id = "platform-access".into();
            cfg.aws_secret_access_key = "platform-secret".into();
            cfg.aws_region = "us-east-1".into();
            cfg.fleet_log = "error,celld=warn".into();
            let flat = flattened(&control_fleet_env(&ControlFleetEnv {
                cfg: &cfg,
                operator_token: "control-op",
            }));
            assert!(
                !flat.contains_key("RUNNER_TOKEN"),
                "runner token must not reach the control fleet"
            );
            assert_eq!(flat["AWS_ACCESS_KEY_ID"], "platform-access");
            assert_eq!(flat["AWS_SECRET_ACCESS_KEY"], "platform-secret");
            assert_eq!(flat["S3_ENDPOINT"], "http://user:pass@rustfs:9000");
            assert_eq!(flat["RUST_LOG"], "error,celld=warn");
            assert_eq!(flat["HOME"], "/root");
            assert_eq!(flat["CELLD_WATCH"], "/data/control");
            assert_eq!(flat["CELLD_OPERATOR_TOKEN"], "control-op");
            assert!(!flat.contains_key("CELLD_EGRESS"));
            assert!(!flat.contains_key("CELLD_MEMORY_SCOPE"));
            assert!(!flat.contains_key("DOCKER_HOST"));
            for key in HOSTILE {
                if let Some(value) = flat.get(*key) {
                    assert!(
                        !value.starts_with("hostile-"),
                        "{key} kept its hostile value: {value}"
                    );
                }
            }
            // Belt-and-braces: an empty token sets nothing rather than an
            // operator-global value the runner does not know.
            let flat = flattened(&control_fleet_env(&ControlFleetEnv {
                cfg: &cfg,
                operator_token: "",
            }));
            assert!(!flat.contains_key("CELLD_OPERATOR_TOKEN"));
        });
    }

    /// The real spawn path, not just the builder: a child spawned through
    /// `apply` under a hostile parent env sees no `RUNNER_TOKEN` and
    /// nothing outside the allowlist plus its tenant vars.
    #[test]
    fn spawned_fleet_env_contains_no_runner_secrets() {
        // The hostile env must stay up while the child spawns, so the whole
        // spawn runs under the lock (no other test observes the mutation).
        // A local runtime — not `#[tokio::test]` — so no lock is held
        // across an await.
        let _lock = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _restore = RestoreOnDrop(Some(install_hostile_env(Some("multi"))));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        rt.block_on(async {
            let mut cfg = Config::from_env().expect("config");
            cfg.aws_region = "us-east-1".into();
            cfg.fleet_log = "error,celld=warn".into();
            let tenant_env = vec![("DATABASE_URL".to_string(), "postgres://app/db".to_string())];
            let env = tenant_fleet_env(&tenant_input(&cfg, &tenant_env));
            let mut cmd = tokio::process::Command::new("/usr/bin/env");
            apply(&mut cmd, &env);
            let out = cmd.output().await.expect("spawn env");
            assert!(out.status.success());
            let seen: HashMap<String, String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            assert!(
                !seen.contains_key("RUNNER_TOKEN"),
                "spawned fleet sees no runner token"
            );
            let allowlist = tenant_allowlist();
            for key in seen.keys() {
                assert!(
                    allowlist.contains(key) || key == "DATABASE_URL",
                    "spawned fleet sees {key}, outside the allowlist"
                );
            }
            assert_eq!(seen["DATABASE_URL"], "postgres://app/db");
            assert_eq!(seen["CELLD_EGRESS"], "public");
            assert_eq!(seen["AWS_ACCESS_KEY_ID"], "scoped-access");
            assert_eq!(seen["RUST_LOG"], "error,celld=warn");
            assert_eq!(seen["PATH"], FLEET_PATH);
        });
    }
}
