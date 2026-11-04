//! Control UI as fleet #0 (SPEC, Control UI).
//!
//! The control worker is a reserved fleet the runner supervises (see
//! `supervise`), with three differences from an app: created at
//! boot, bundle from the image (`/opt/noite/control/dist`), cannot be
//! deleted. At boot: build the worker vars from the runner's config and
//! environment, revision-gate (`sha256(bundle REVISION ‖ canonical-json(vars))`
//! against `ui/revision` in the bucket), and `celld deploy` when it changed.
//! The control D1 lives at `s3://{bucket}/control`; the worker reaches the
//! runner at `http://127.0.0.1:8080`.

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::host::children::Supervised;
use crate::host::logs::LogState;
use crate::host::{exec, s3};

const MARKER_KEY: &str = "ui/revision";

/// Reserved telemetry key of the control fleet. There is deliberately no
/// `app` row for it (nothing that iterates apps — reconcile, Caddy, sleep,
/// purge, list_apps — may ever see the control plane), so the metrics ingest
/// attributes its rows to this key and reads its Parquet from its own bucket
/// prefix (`control/telemetry/...`, see `metrics::telemetry_prefix`).
pub const SLUG: &str = "_control";

/// Control-worker vars taken verbatim from the environment (see
/// `control_vars`). Keep in sync with the worker's `KitEnv`.
const CONTROL_PASSTHROUGH: &[&str] = &[
    "BETTER_AUTH_SECRET",
    "NOITE_ADMIN_EMAIL",
    "NOITE_AUTH_RATE_LIMIT",
    "NOITE_EMAIL_WEBHOOK_URL",
    "NOITE_RATE_LIMIT_RPM",
    "NOITE_SMTP_FROM",
];

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_default(),
                        canonical_json(&map[*k])
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

fn control_vars(cfg: &Config) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    let mut put = |k: &str, v: &str| {
        if !v.trim().is_empty() {
            map.insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
    };
    put("AWS_ACCESS_KEY_ID", &cfg.aws_access_key_id);
    put("AWS_SECRET_ACCESS_KEY", &cfg.aws_secret_access_key);
    put("AWS_REGION", &cfg.aws_region);
    put("BASE_DOMAIN", &cfg.base_domain);
    put("CONTROL_EXTRA_HOSTS", &cfg.control_extra_hosts.join(","));
    put("CONTROL_SUBDOMAIN", &cfg.control_subdomain);
    put("GIT_PUBLIC_BASE", &cfg.git_public_base);
    put("NOITE_S3_BUCKET", &cfg.s3_bucket);
    put("RUNNER_TOKEN", &cfg.runner_token);
    put("RUNNER_URL", "http://127.0.0.1:8080");
    put("S3_ENDPOINT", &cfg.s3_endpoint);
    put("S3_PUBLIC_ENDPOINT", &cfg.s3_public_endpoint);
    if !cfg.better_auth_url.is_empty() {
        put("BETTER_AUTH_URL", &cfg.better_auth_url);
    }
    // Worker settings the runner does not use itself: passed through from
    // the container environment. Without BETTER_AUTH_SECRET every /api/auth/* call fails.
    for key in CONTROL_PASSTHROUGH {
        if let Ok(value) = std::env::var(key) {
            put(key, &value);
        }
    }
    serde_json::Value::Object(map)
}

/// Revision of bundle + vars (matches entrypoint `REV`).
pub fn revision(bundle_rev: &str, vars: &serde_json::Value) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bundle_rev.as_bytes());
    h.update(canonical_json(vars).as_bytes());
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    format!("{bundle_rev}-{}", &hex[..16.min(hex.len())])
}

/// True when this image carries the baked control bundle: the release image
/// does (`docker/Dockerfile` target `noite` copies `dist`), the dev image does
/// not (`vite dev` serves the UI on the same port). `main` then deploys and
/// supervises no control fleet at all — no control celld, therefore no control
/// telemetry — and surfaces that on `GET /v1/admin/stats` as `control_fleet` so
/// the UI says so instead of showing empty charts.
pub fn bundle_present(cfg: &Config) -> bool {
    let dir = Path::new(&cfg.control_bundle_dir);
    dir.join("wrangler.json").exists() || dir.join("wrangler.jsonc").exists()
}

/// Deploy the baked bundle when revision differs, then return the vars.
/// Runner-owned tool path (`celld deploy` via run_cmd, env_clear + explicit).
pub async fn ensure_deployed(cfg: &Config) -> anyhow::Result<serde_json::Value> {
    let dist = PathBuf::from(&cfg.control_bundle_dir);
    if !bundle_present(cfg) {
        anyhow::bail!(
            "control bundle missing at {} (image without UI stage?)",
            dist.display()
        );
    }
    let bundle_rev = tokio::fs::read_to_string(dist.join("REVISION"))
        .await
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let vars = control_vars(cfg);
    let rev = revision(&bundle_rev, &vars);
    // Compare with marker.
    let tmp = std::env::temp_dir().join("noite-ui-revision");
    let deployed = fetch_marker(cfg).await.unwrap_or_default();
    if deployed.trim() == rev {
        tracing::info!("control bundle at revision; skipping deploy");
        return Ok(vars);
    }
    // Patch wrangler.json vars into a temp copy.
    let work = std::env::temp_dir().join(format!("noite-ui-{}", &rev[..8.min(rev.len())]));
    let _ = tokio::fs::remove_dir_all(&work).await;
    copy_dir(&dist, &work).await?;
    let wrangler = if work.join("wrangler.json").exists() {
        work.join("wrangler.json")
    } else {
        work.join("wrangler.jsonc")
    };
    let text = tokio::fs::read_to_string(&wrangler).await?;
    let mut doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| anyhow::anyhow!("control wrangler parse: {e}"))?;
    if let Some(obj) = doc.as_object_mut() {
        obj.insert("vars".to_string(), vars.clone());
    }
    tokio::fs::write(&wrangler, serde_json::to_string_pretty(&doc)?).await?;
    let bucket = format!("s3://{}/control", cfg.s3_bucket);
    let env_owned = s3::celld_cli_env(cfg, crate::host::credentials::CONTROL_OPERATOR_SCOPE);
    let env: Vec<(&str, &str)> = env_owned.iter().map(|(k, v)| (*k, v.as_str())).collect();
    // Retry: S3 can flip 503 mid-deploy (rustfs restart); give up loudly.
    let mut last = anyhow::anyhow!("not attempted");
    for attempt in 1..=5 {
        match exec::run_cmd(
            &cfg.celld_bin,
            &[
                "deploy",
                work.to_str().unwrap_or("."),
                "--bucket",
                &bucket,
                "--endpoint",
                &cfg.s3_endpoint,
                "--region",
                &cfg.aws_region,
            ],
            None,
            &env,
            Duration::from_secs(120),
        )
        .await
        {
            Ok(_) => {
                last = anyhow::anyhow!("ok");
                break;
            }
            Err(e) => {
                last = e;
                tracing::warn!(attempt, "control deploy failed; retrying");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
    if last.to_string() != "ok" {
        return Err(anyhow::anyhow!("control deploy failed: {last:#}"));
    }
    store_marker(cfg, &rev).await?;
    let _ = tokio::fs::remove_dir_all(&work).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(vars)
}

async fn fetch_marker(cfg: &Config) -> anyhow::Result<String> {
    let dest = std::env::temp_dir().join("noite-ui-revision-fetch");
    let _ = tokio::fs::remove_file(&dest).await;
    let uri = format!("s3://{}/{MARKER_KEY}", cfg.s3_bucket);
    s3::s3_cp_download(cfg, &uri, &dest).await?;
    Ok(tokio::fs::read_to_string(&dest).await.unwrap_or_default())
}

async fn store_marker(cfg: &Config, rev: &str) -> anyhow::Result<()> {
    let dest = std::env::temp_dir().join("noite-ui-revision-store");
    tokio::fs::write(&dest, rev).await?;
    s3::s3_cp_upload(cfg, &dest, MARKER_KEY).await?;
    Ok(())
}

async fn copy_dir(src: &Path, dst: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dst).await?;
    let mut rd = tokio::fs::read_dir(src).await?;
    while let Some(e) = rd.next_entry().await? {
        let ft = e.file_type().await?;
        let to = dst.join(e.file_name());
        if ft.is_dir() {
            Box::pin(copy_dir(&e.path(), &to)).await?;
        } else {
            tokio::fs::copy(e.path(), &to).await?;
        }
    }
    Ok(())
}

/// Control fleet #0: celld with the public listener on loopback (Caddy is in
/// the same container) and the internal one on the private address (see
/// `control_advertise`). Supervised: restarted on exit, stopped with the
/// fleets on shutdown. It runs the same telemetry environment as a tenant
/// fleet (`metrics::otel_env`), so its Parquet lands under
/// `s3://<bucket>/control/telemetry/...` (celld writes `telemetry/` relative
/// to `--bucket`) and the ingest, compaction, error grouping and prune treat
/// it as one more source — keyed `_control`, with no `app` row. Its pid is
/// mirrored into `control_pid` and its stdout+stderr into the shared log
/// buffer under the same key. `operator_token` guards its internal listener
/// like every tenant fleet's; the caller refuses to spawn on an empty token
/// (failing closed), and the empty path below only deletes the stale
/// published file as belt-and-braces.
pub fn supervise(
    config: &Config,
    control_pid: Arc<AtomicU32>,
    logs: LogState,
    operator_token: String,
) -> Supervised {
    let args = spawn_args(config);
    let celld = config.celld_bin.clone();
    let work_dir = config.work_dir.clone();
    let fleet_cfg = config.clone();
    Supervised::start_observed(
        "control",
        Some(control_pid),
        Some((logs, SLUG.to_string())),
        move || {
            let state_dir = "/data/control";
            let _ = std::fs::create_dir_all(state_dir);
            // The control fleet's operator token for `make doctor`'s `celld
            // diagnose` (an in-tree internal client that authenticates from
            // its own env): rewritten on every spawn so it never drifts from
            // the ensured row. Root-only: tenants must never read it. Empty
            // (the caller refuses to spawn then, but belt-and-braces) deletes
            // the stale file instead of publishing nothing.
            if operator_token.is_empty() {
                remove_operator_token_file(&work_dir);
            } else {
                write_operator_token_file(&work_dir, &operator_token);
            }
            let mut cmd = tokio::process::Command::new(&celld);
            cmd.args(&args)
                // Piped so the supervisor captures the node's own log into the
                // shared buffer (the OTel ring carries the worker's console).
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            // Explicit environment only (`host::fleet_env`): the spawn
            // inherits nothing — no `RUNNER_TOKEN`, no operator-global
            // `CELLD_*` — and the store credentials the spawn used to
            // inherit are passed explicitly. This `apply` call is
            // load-bearing (nothing here fails if it is dropped): the
            // builder and the spawn-path tests in `host::fleet_env` pin
            // what it applies.
            let inherited = crate::host::fleet_env::runner_inherited();
            let env = crate::host::fleet_env::control_fleet_env(
                &crate::host::fleet_env::ControlFleetEnv {
                    cfg: &fleet_cfg,
                    operator_token: &operator_token,
                    inherited: &inherited,
                },
            );
            crate::host::fleet_env::apply(&mut cmd, &env);
            cmd
        },
    )
}

/// Where the runner publishes the control fleet's operator token for
/// `make doctor`'s `celld diagnose`: under the runner work dir, not the
/// node's `CELLD_WATCH` working dir (whose contents celld owns).
fn operator_token_path(work_dir: &str) -> std::path::PathBuf {
    std::path::Path::new(work_dir).join("control-operator-token")
}

/// Delete the published control token, if any: when the token cannot be
/// ensured the stale file must not linger, or `make doctor` would probe
/// with a dead token instead of failing loudly.
pub fn remove_operator_token_file(work_dir: &str) {
    let _ = std::fs::remove_file(operator_token_path(work_dir));
}

/// Publish the control fleet's operator token for `make doctor`: root-only
/// (`0600`), best-effort — without it diagnose's peer probes fail closed
/// with 401s, which is what the warning says.
fn write_operator_token_file(work_dir: &str, token: &str) {
    let path = operator_token_path(work_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = write_private_atomically(&path, token.as_bytes()) {
        tracing::warn!(path = %path.display(), error = %e, "could not write the control operator token file; `make doctor`'s celld diagnose will fail its peer probes");
    }
}

/// Write `bytes` to `path` as a `0600` file that is never readable by anyone
/// else, not even while it is written: a fresh temp file is created with
/// mode `0600` (no umask window), filled, synced, then renamed over `path`,
/// so readers see the old file or the whole new one. Exact bytes, no
/// trailing newline: celld refuses a token with surrounding whitespace, and
/// `$(cat …)` must reproduce it verbatim.
fn write_private_atomically(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Spawn arguments for the control fleet (SPEC, Control UI).
pub fn spawn_args(cfg: &Config) -> Vec<String> {
    let bucket = format!("s3://{}/control", cfg.s3_bucket);
    vec![
        "--bucket".into(),
        bucket,
        "--endpoint".into(),
        cfg.s3_endpoint.clone(),
        "--region".into(),
        cfg.aws_region.clone(),
        "--listen".into(),
        "127.0.0.1:8090".into(),
        "--internal-listen".into(),
        "0.0.0.0:8091".into(),
        "--advertise".into(),
        control_advertise(),
    ]
}

/// Peer address of the control node. Not loopback: during a platform's
/// overlapping redeploy (Railway starts the new container before stopping
/// the old one) the new node takes cells over from the old one through this
/// address, and a loopback advertise makes it dial itself. The operator API
/// on this listener is closed to tenant code by the fleet egress policy
/// (loopback and private ranges, IPv6 ULA included), not by the bind.
pub fn control_advertise() -> String {
    let host = std::env::var("CELLD_ADVERTISE")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("RAILWAY_PRIVATE_DOMAIN")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .unwrap_or_else(|| "127.0.0.1".into());
    format!("{host}:8091")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published control token file carries the exact token bytes and is
    /// root-only: tenants must never read it.
    #[test]
    fn control_token_file_is_exact_and_root_only() {
        let dir =
            std::env::temp_dir().join(format!("noite-control-token-{}", crate::models::new_id()));
        write_operator_token_file(&dir.to_string_lossy(), "tok-abc-123");
        let path = operator_token_path(&dir.to_string_lossy());
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            "tok-abc-123",
            "exact bytes, no trailing newline"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777,
                0o600,
                "root-only"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_presence_needs_a_wrangler_config() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut cfg = Config::from_env().expect("config");
        let dir =
            std::env::temp_dir().join(format!("noite-control-bundle-{}", crate::models::new_id()));
        cfg.control_bundle_dir = dir.to_string_lossy().into_owned();
        // The dev image has the env var but no bundle: nothing to deploy, no
        // control celld, no control telemetry.
        assert!(!bundle_present(&cfg));
        std::fs::create_dir_all(&dir).expect("temp dir");
        assert!(!bundle_present(&cfg));
        std::fs::write(dir.join("wrangler.json"), "{}").expect("wrangler");
        assert!(bundle_present(&cfg));
        let _ = std::fs::remove_dir_all(dir);
    }
}
