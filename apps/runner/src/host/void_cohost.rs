//! Runner-owned cohosted scripts (SPEC, Void platform proxy): the one
//! reusable mechanism that deploys extra Worker scripts into a fleet before
//! the tenant app.
//!
//! A Void fleet carries the tenant app plus runner-owned scripts — today
//! `noite-void-proxy` ([`super::void_proxy`]), later `noite-void-sandbox` —
//! each with embedded sources and a per-fleet rendered config. celld
//! resolves `services` within the fleet bucket only and moves the
//! fleet-wide pointer on every deploy, so deploy order is load-bearing:
//! cohosted scripts first (lowest [`CohostedScript::order`] first), the app
//! last, then the one `/reload` whose outcome the deploy already checks.
//! A later script only adds its [`CohostedScript`] and its render: the
//! order, the skip rule and the invocation below stay untouched.
//!
//! Skip-when-unchanged: the bundle and rendered config are the runner's
//! own, so a script whose [`RenderedCohost::content_hash`] matches the
//! stored one (per fleet, the `void_cohost_hash` table) is not
//! redeployed. Steady state is one app
//! deploy, zero pointer flapping, zero multi-script window. The hash
//! covers the sources and the rendered config with secret values
//! substituted by their hashes, so a rotation redeploys the script while
//! the stored row holds a digest only — never a secret.
//!
//! Failure windows (design §2.4): tenant-code failures are pre-pointer
//! (celld bundles before writing anything). If a cohosted deploy succeeds
//! and the app deploy then fails on infra (S3/CAS errors), the fleet
//! pointer names the cohosted script until the next successful deploy —
//! the 300 s poll backstop could adopt it as primary in that window and
//! serve its 404s. Mitigations: the app deploy retries once on infra
//! errors ([`celld_deploy_app`], idempotent); anything else fails loudly;
//! the next successful deploy heals. Cohosted scripts themselves get no
//! retry: a failed one fails the deploy before the app moves the pointer,
//! so the fleet keeps serving its old generation.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sqlx::SqlitePool;

use crate::db;
use crate::host::exec;

/// One embedded source file: its path inside the deploy project and its
/// bytes. Paths are relative and never escape the project root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CohostSource {
    pub path: &'static str,
    pub contents: &'static str,
}

/// A runner-owned script: its celld identity, its embedded sources, and
/// its place in the deploy order (lowest first; the tenant app always
/// deploys last, after every cohosted script).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CohostedScript {
    pub name: &'static str,
    pub main: &'static str,
    pub sources: &'static [CohostSource],
    pub order: u32,
}

/// One script's rendered deploy project: the script, its `wrangler.json`,
/// and the names of the vars holding secrets. Secret values are
/// substituted by their hashes for the content hash, so a rotation
/// redeploys the script without the secret itself entering the digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedCohost {
    pub script: &'static CohostedScript,
    pub secret_vars: &'static [&'static str],
    pub config: Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

impl RenderedCohost {
    /// The `wrangler.json` written beside the sources.
    pub fn config_json(&self) -> anyhow::Result<String> {
        serde_json::to_string_pretty(&self.config).map_err(anyhow::Error::from)
    }

    /// The skip-when-unchanged digest: SHA-256 over the source paths and
    /// bytes in order, then the rendered config with every secret var's
    /// value substituted by its hash. Deterministic: same inputs, same
    /// digest — and any source, config or secret change flips it.
    pub fn content_hash(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        for source in self.script.sources {
            hasher.update(source.path.as_bytes());
            hasher.update([0]);
            hasher.update(source.contents.as_bytes());
            hasher.update([0]);
        }
        let mut config = self.config.clone();
        if let Some(vars) = config.get_mut("vars").and_then(Value::as_object_mut) {
            for name in self.secret_vars {
                let digest = vars
                    .get(*name)
                    .and_then(Value::as_str)
                    .map(|value| sha256_hex(value.as_bytes()));
                if let Some(digest) = digest {
                    vars.insert((*name).to_string(), Value::String(digest));
                }
            }
        }
        // `serde_json::Map` without `preserve_order` is a `BTreeMap`: keys
        // serialize sorted, so this is canonical across renders.
        hasher.update(
            serde_json::to_string(&config)
                .unwrap_or_default()
                .as_bytes(),
        );
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect()
    }

    /// Write the deploy project: every embedded source at its path plus
    /// the rendered `wrangler.json`. Paths are compile-time constants from
    /// the script's own module, but a path escaping the root is still
    /// refused — a deploy project that writes outside itself is never run.
    pub fn write_project(&self, dir: &Path) -> anyhow::Result<()> {
        use std::path::Component;
        std::fs::create_dir_all(dir)?;
        for source in self.script.sources {
            // A lexical `starts_with` cannot see through `..` (`join` never
            // normalizes), so the path itself must be all normal components.
            let inside = Path::new(source.path)
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
            if !inside {
                anyhow::bail!(
                    "cohosted script `{}` source path {:?} escapes its project",
                    self.script.name,
                    source.path
                );
            }
            let target = dir.join(source.path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, source.contents)?;
        }
        std::fs::write(dir.join("wrangler.json"), self.config_json()?)?;
        Ok(())
    }
}

/// What `celld deploy` needs: the binary, the fleet bucket and the env.
/// One value serves the cohosted scripts and the app alike — same binary,
/// same bucket, same invocation shape.
#[derive(Clone, Copy)]
pub struct CelldDeploy<'a> {
    pub celld_bin: &'a str,
    pub env: &'a [(&'a str, &'a str)],
    pub bucket: &'a str,
    pub endpoint: &'a str,
    pub region: &'a str,
    pub timeout: Duration,
}

/// One `celld deploy` of a project dir into the fleet bucket.
pub async fn celld_deploy(
    celld: &CelldDeploy<'_>,
    project_dir: &Path,
    cwd: Option<&Path>,
) -> anyhow::Result<String> {
    let Some(dir) = project_dir.to_str() else {
        anyhow::bail!("deploy root is not valid UTF-8: {}", project_dir.display());
    };
    exec::run_cmd(
        celld.celld_bin,
        &[
            "deploy",
            dir,
            "--bucket",
            celld.bucket,
            "--endpoint",
            celld.endpoint,
            "--region",
            celld.region,
        ],
        cwd,
        celld.env,
        celld.timeout,
    )
    .await
}

/// `celld deploy` failures that come from the project itself: bundling a
/// broken entry or a malformed config. All deterministic and pre-pointer
/// (celld bundles before writing anything), so retrying cannot help and
/// the deploy fails at once. The markers are celld's own error strings
/// (pinned celld, `deploy.rs`), quoted narrowly enough that no S3, CAS or
/// transport error matches them.
const TENANT_ERROR_MARKERS: &[&str] = &[
    "esbuild failed:",
    "is not a JSON object",
    "`name` must contain",
    "has no `",
    "has an invalid",
    "has an empty",
    "has a non-string",
    "must be a ",
    "must be an ",
    "must be between",
    "binding name",
    "does not support these config keys",
    "wrangler.toml is not supported",
    "is not a regular file",
    "config has neither",
    "is a runtime class",
    "without `main`",
    "which celld does not model",
    "duplicate kv namespace id",
    "takes one project path",
    "unknown argument",
];

/// True when a `celld deploy` failure reads as tenant-caused (no retry).
/// Everything else — S3/CAS answers, timeouts, a hung celld — reads as
/// infra and the app deploy retries once.
pub fn is_tenant_error(output: &str) -> bool {
    TENANT_ERROR_MARKERS.iter().any(|m| output.contains(m))
}

/// What the app deploy took: whether it retried (celld's own stdout is
/// discarded, as the previous inline deploy did — the log carries the
/// attempts, the row carries the outcome).
#[derive(Debug)]
pub struct AppDeploy {
    /// 1, or 2 when the first attempt failed on infra and the retry ran.
    pub attempts: u32,
}

/// Deploy the tenant app: one `celld deploy`, retried once when the
/// failure reads as infra (S3/CAS errors, timeouts — [`is_tenant_error`]
/// decides). The retry is idempotent (content-versioned deploys), and it
/// narrows §2.4's window: a transient store blip between the cohosted and
/// app deploys heals inside this deploy instead of leaving the pointer on
/// a cohosted script. A twice-failed deploy carries both attempts'
/// errors; the row's summary still truncates to one line.
pub async fn celld_deploy_app(
    celld: &CelldDeploy<'_>,
    project_dir: &Path,
    cwd: Option<&Path>,
) -> anyhow::Result<AppDeploy> {
    match celld_deploy(celld, project_dir, cwd).await {
        Ok(_) => Ok(AppDeploy { attempts: 1 }),
        Err(first) => {
            if is_tenant_error(&format!("{:#}", first)) {
                return Err(first);
            }
            tracing::warn!("celld deploy failed (infra); retrying once");
            match celld_deploy(celld, project_dir, cwd).await {
                Ok(_) => Ok(AppDeploy { attempts: 2 }),
                Err(second) => Err(anyhow::anyhow!(
                    "celld deploy failed twice (one infra retry):\nfirst: {:#}\nsecond: {:#}",
                    first,
                    second
                )),
            }
        }
    }
}

/// What one cohosted script's deploy did, for the deploy log.
#[derive(Debug, PartialEq, Eq)]
pub struct CohostOutcome {
    pub script: &'static str,
    pub skipped: bool,
    /// The content hash deployed (or matched, when skipped).
    pub hash: String,
}

impl CohostOutcome {
    /// The deploy-log line: names and a hash prefix only, never values.
    pub fn log_line(&self) -> String {
        let short = &self.hash[..12.min(self.hash.len())];
        if self.skipped {
            format!(
                "void: cohosted script `{}` unchanged ({}); skipping deploy\n",
                self.script, short
            )
        } else {
            format!(
                "void: deployed cohosted script `{}` ({})\n",
                self.script, short
            )
        }
    }
}

/// Deploy the fleet's runner-owned scripts in order (lowest `order`
/// first): each renders to a fresh temp project, deploys with
/// `celld deploy` into the fleet bucket, and stores its content hash —
/// unless the hash matches the stored one, in which case the script is
/// skipped. A failure fails the deploy at once, with no retry: the
/// sources are the runner's own, so a failure is dead infra (the next
/// deploy starts over) or a runner bug (loud, names only in the error).
/// The temp project holds the fleet's secrets in plaintext, so it is
/// owner-only from birth and removed on every path — success or failure —
/// and failed deploys leave nothing on runner disk.
pub async fn ensure_cohosted(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    celld: &CelldDeploy<'_>,
    renders: &[RenderedCohost],
) -> anyhow::Result<Vec<CohostOutcome>> {
    let mut ordered: Vec<&RenderedCohost> = renders.iter().collect();
    ordered.sort_by_key(|render| render.script.order);
    let mut outcomes = Vec::with_capacity(ordered.len());
    for render in ordered {
        let hash = render.content_hash();
        let stored = db::get_cohost_hash(pool, app_id, environment_id, render.script.name).await?;
        if stored.as_deref() == Some(hash.as_str()) {
            outcomes.push(CohostOutcome {
                script: render.script.name,
                skipped: true,
                hash,
            });
            continue;
        }
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "noite-cohost-{}-{}",
            render.script.name,
            crate::models::new_id()
        ));
        // Owner-only from birth: the rendered config carries the fleet's
        // token and proxy credentials in plaintext.
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&dir)?;
        }
        render.write_project(&dir)?;
        if let Err(e) = celld_deploy(celld, &dir, None).await {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(anyhow::anyhow!(
                "cohosted script `{}` deploy failed: {:#}",
                render.script.name,
                e
            ));
        }
        let _ = std::fs::remove_dir_all(&dir);
        db::set_cohost_hash(pool, app_id, environment_id, render.script.name, &hash).await?;
        outcomes.push(CohostOutcome {
            script: render.script.name,
            skipped: false,
            hash,
        });
    }
    Ok(outcomes)
}

/// The tenant app's side of the ordered deploy: its project dir, the cwd
/// `celld deploy` runs from, and its own (container-aware) timeout.
pub struct FleetApp<'a> {
    pub dir: &'a Path,
    pub cwd: Option<&'a Path>,
    pub timeout: Duration,
}

/// What the ordered fleet deploy did, for the deploy log.
#[derive(Debug)]
pub struct FleetDeployStats {
    pub cohosted: Vec<CohostOutcome>,
    pub app_attempts: u32,
}

impl FleetDeployStats {
    /// The deploy-log lines: one per cohosted script, plus the app retry
    /// note when the second attempt ran.
    pub fn log_lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self.cohosted.iter().map(CohostOutcome::log_line).collect();
        if self.app_attempts > 1 {
            lines.push(format!(
                "void: app deploy succeeded on attempt {} after an infra failure\n",
                self.app_attempts
            ));
        }
        lines
    }
}

/// The whole ordered fleet deploy: the cohosted scripts first (each
/// skipped when unchanged), the tenant app last with its one infra
/// retry. One function owns the sequence, so the order — proxy first,
/// app last, fleet pointer ends on the app — holds by construction.
pub async fn deploy_fleet_in_order(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
    celld: &CelldDeploy<'_>,
    cohosted: &[RenderedCohost],
    app: &FleetApp<'_>,
) -> anyhow::Result<FleetDeployStats> {
    let outcomes = ensure_cohosted(pool, app_id, environment_id, celld, cohosted).await?;
    let app_celld = CelldDeploy {
        timeout: app.timeout,
        ..*celld
    };
    let deployed = celld_deploy_app(&app_celld, app.dir, app.cwd).await?;
    Ok(FleetDeployStats {
        cohosted: outcomes,
        app_attempts: deployed.attempts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SOURCES: &[CohostSource] = &[
        CohostSource {
            path: "worker.ts",
            contents: "export default { fetch: () => new Response('ok') }",
        },
        CohostSource {
            path: "src/util.ts",
            contents: "export const one = 1;",
        },
    ];

    const SCRIPT: CohostedScript = CohostedScript {
        name: "noite-test-cohost",
        main: "worker.ts",
        sources: SOURCES,
        order: 10,
    };

    fn render(token: &str) -> RenderedCohost {
        RenderedCohost {
            script: &SCRIPT,
            secret_vars: &["__VOID_PROXY_TOKEN"],
            config: json!({
                "name": "noite-test-cohost",
                "main": "worker.ts",
                "vars": {"__VOID_PROXY_TOKEN": token, "MODE": "prod"},
            }),
        }
    }

    /// The digest is stable, and any source, config or secret change flips
    /// it — including a token rotation, which is what redeploys the proxy
    /// beside a rotated app.
    #[test]
    fn content_hash_is_stable_and_flips_on_any_change() {
        let base = render("tok-1").content_hash();
        assert_eq!(base.len(), 64);
        assert_eq!(render("tok-1").content_hash(), base);
        assert_ne!(render("tok-2").content_hash(), base);

        let mut config_changed = render("tok-1");
        config_changed.config["vars"]["MODE"] = json!("dev");
        assert_ne!(config_changed.content_hash(), base);

        const OTHER_SOURCES: &[CohostSource] = &[CohostSource {
            path: "worker.ts",
            contents: "export default { fetch: () => new Response('changed') }",
        }];
        const OTHER: CohostedScript = CohostedScript {
            name: "noite-test-cohost",
            main: "worker.ts",
            sources: OTHER_SOURCES,
            order: 10,
        };
        let mut source_changed = render("tok-1");
        source_changed.script = &OTHER;
        assert_ne!(source_changed.content_hash(), base);
    }

    /// The project lands exactly: sources at their paths with their bytes,
    /// the rendered config beside them — and a path escaping the root is
    /// refused instead of written.
    #[test]
    fn write_project_lays_out_sources_and_config() {
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-project-{}", crate::models::new_id()));
        render("tok").write_project(&dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("worker.ts")).unwrap(),
            "export default { fetch: () => new Response('ok') }"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("src/util.ts")).unwrap(),
            "export const one = 1;"
        );
        let config: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.json")).unwrap())
                .unwrap();
        assert_eq!(config["name"], "noite-test-cohost");
        assert_eq!(config["vars"]["__VOID_PROXY_TOKEN"], "tok");
        std::fs::remove_dir_all(&dir).unwrap();

        const ESCAPING: &[CohostSource] = &[CohostSource {
            path: "../escape.ts",
            contents: "x",
        }];
        const EVIL: CohostedScript = CohostedScript {
            name: "noite-test-cohost",
            main: "worker.ts",
            sources: ESCAPING,
            order: 10,
        };
        let dir =
            std::env::temp_dir().join(format!("noite-cohost-escape-{}", crate::models::new_id()));
        let evil = RenderedCohost {
            script: &EVIL,
            secret_vars: &[],
            config: json!({"name": "x"}),
        };
        let err = evil.write_project(&dir).unwrap_err();
        assert!(format!("{:#}", err).contains("escapes"), "{:#}", err);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// celld's own project failures (bundling, config shape) read as
    /// tenant — no retry — while store, CAS and transport failures read
    /// as infra. Markers are quoted from the pinned celld's `deploy.rs`.
    #[test]
    fn tenant_and_infra_errors_classify() {
        for tenant in [
            "celld [\"deploy\"] exit Some(1)\nesbuild failed:\nERROR: Could not resolve \"x\"",
            "/w/wrangler.json is not a JSON object",
            "config has no `name`",
            "config `name` must contain 1 to 63 bytes of lowercase ASCII",
            "`celld deploy` does not support these config keys: secrets.",
            "wrangler.toml is not supported; convert it to wrangler.jsonc",
            "invalid service binding name: \"x\"",
            "service binding __VOID_PROXY has no `service`",
            "config `services` must be an array",
            "config `kv_namespaces` must be an object",
            "entry point main.js is not a regular file",
            "d1 database \"db\" has an invalid `database_id`",
            "d1 binding data has an empty `database_name`",
            "d1 database \"db\" has a non-string `migrations_dir`",
            "queue producer delivery_delay must be between 0 and 86400 seconds",
            "config has neither `main` nor `assets`",
            "`room` is a runtime class; remove it from `migrations`",
            "config sets `triggers.crons` without `main`; a cron trigger needs a `scheduled` handler to call",
            "config `queues` declares `x`, which celld does not model",
            "duplicate kv namespace id: \"a\"",
            "`celld deploy` takes one project path, and already has one: x",
            "unknown argument for `celld deploy`: --nope",
        ] {
            assert!(is_tenant_error(tenant), "tenant not recognized: {}", tenant);
        }
        for infra in [
            "Error communicating with S3: service error: SlowDown: Please reduce your request rate",
            "put deploy/current.json: connection refused (os error 111)",
            "command timeout: celld [\"deploy\", \"/w\"] timed out after 120s",
            "500 Internal Server Error",
            "If-Match precondition failed: 412",
            "failed to lookup address information",
            "TLS handshake failed",
            "esbuild not found (esbuild). `celld deploy` bundles with esbuild; install it and retry",
            "save container image failed:\nError: daemon not running",
            "thread 'main' panicked at crates/celld/deploy.rs:973",
        ] {
            assert!(!is_tenant_error(infra), "infra misread as tenant: {}", infra);
        }
    }

    /// A fake `celld`: appends its argv to `$FAKE_CELLD_LOG`, then fails
    /// invocation `n` (zero-based) when `$FAKE_CELLD_DIR/fail-<n>` exists
    /// (file content to stderr, exit 1). The control files make order,
    /// skip and retry observable without sleeps.
    const FAKE_CELLD: &str = r#"#!/bin/sh
n=0
if [ -f "$FAKE_CELLD_LOG" ]; then n=$(wc -l < "$FAKE_CELLD_LOG"); fi
printf '%s\n' "$*" >> "$FAKE_CELLD_LOG"
fail="$FAKE_CELLD_DIR/fail-$n"
if [ -f "$fail" ]; then cat "$fail" >&2; exit 1; fi
echo "deployed $2"
"#;

    struct FakeCelld {
        dir: PathBuf,
    }

    impl FakeCelld {
        fn spawn() -> Self {
            let dir =
                std::env::temp_dir().join(format!("noite-fake-celld-{}", crate::models::new_id()));
            std::fs::create_dir_all(&dir).unwrap();
            let bin = dir.join("celld");
            std::fs::write(&bin, FAKE_CELLD).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            Self { dir }
        }

        fn bin(&self) -> String {
            self.dir.join("celld").to_string_lossy().into_owned()
        }

        fn log(&self) -> String {
            self.dir
                .join("invocations.log")
                .to_string_lossy()
                .into_owned()
        }

        /// Fail invocation `n` with `message` on stderr.
        fn fail(&self, n: usize, message: &str) {
            std::fs::write(self.dir.join(format!("fail-{}", n)), message).unwrap();
        }

        fn invocations(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.join("invocations.log"))
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    impl Drop for FakeCelld {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn seed(pool: &SqlitePool) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "cohost-app",
                slug: "cohost-app",
                user_id: "local",
                subdomain: "cohost-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    /// Proxy first, app last: the ordered deploy runs `celld deploy` for
    /// the cohosted project before the app's, into the same bucket — and
    /// the cohosted temp project is removed afterwards.
    #[tokio::test]
    async fn ordered_deploy_runs_cohosted_before_the_app() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let app_dir =
            std::env::temp_dir().join(format!("noite-cohost-app-{}", crate::models::new_id()));
        std::fs::create_dir_all(&app_dir).unwrap();

        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok")],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.app_attempts, 1);
        assert_eq!(stats.cohosted.len(), 1);
        assert!(!stats.cohosted[0].skipped);

        let calls = fake.invocations();
        assert_eq!(calls.len(), 2, "{:?}", calls);
        assert!(
            calls[0].contains("noite-cohost-noite-test-cohost-"),
            "{:?}",
            calls
        );
        assert!(
            calls[0].contains("s3://noite/fleets/cohost-app"),
            "{:?}",
            calls
        );
        assert!(
            calls[1].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        assert!(
            calls[1].contains("s3://noite/fleets/cohost-app"),
            "{:?}",
            calls
        );
        // The cohosted temp project is gone: argv[1] is its dir.
        let project = calls[0].split(' ').nth(1).expect("deploy argv");
        assert!(!Path::new(project).exists(), "{} left behind", project);
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    /// Second deploy with the same content: the cohosted script is
    /// skipped (one `celld deploy` total — the app's), and a rotation
    /// redeploys it.
    #[tokio::test]
    async fn unchanged_cohost_is_skipped_rotation_redeploys() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let app_dir =
            std::env::temp_dir().join(format!("noite-cohost-app2-{}", crate::models::new_id()));
        std::fs::create_dir_all(&app_dir).unwrap();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
        };

        let first =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(!first.cohosted[0].skipped);
        assert_eq!(fake.invocations().len(), 2);

        let second =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
                .await
                .unwrap();
        assert!(second.cohosted[0].skipped);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        assert!(
            calls[2].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );

        // A rotation flips the hash: the proxy deploys again beside the app.
        let third =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok-2")], &app_side)
                .await
                .unwrap();
        assert!(!third.cohosted[0].skipped);
        assert_eq!(fake.invocations().len(), 5);
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    /// The app deploy retries once on infra and then succeeds; the stats
    /// carry the attempt count for the log.
    #[tokio::test]
    async fn app_deploy_retries_once_on_infra() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        // Invocation 1 is the app's first attempt (0 is the cohosted one).
        fake.fail(
            1,
            "put deploy/current.json: connection refused (os error 111)",
        );
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let app_dir =
            std::env::temp_dir().join(format!("noite-cohost-retry-{}", crate::models::new_id()));
        std::fs::create_dir_all(&app_dir).unwrap();

        let stats = deploy_fleet_in_order(
            &pool,
            &app.id,
            None,
            &celld,
            &[render("tok")],
            &FleetApp {
                dir: &app_dir,
                cwd: None,
                timeout: Duration::from_secs(30),
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.app_attempts, 2);
        let lines = stats.log_lines().join("");
        assert!(lines.contains("attempt 2"), "{}", lines);
        let calls = fake.invocations();
        assert_eq!(calls.len(), 3, "{:?}", calls);
        // The cohosted script deployed once — the retry is the app's alone.
        assert!(calls[0].contains("noite-cohost-"), "{:?}", calls);
        assert!(
            calls[1].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        assert!(
            calls[2].contains(&app_dir.to_string_lossy().into_owned()),
            "{:?}",
            calls
        );
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    /// Tenant failures fail at once (no retry), and a twice-failed app
    /// deploy carries both attempts' errors.
    #[tokio::test]
    async fn tenant_failures_fail_fast_twice_failed_carries_both() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        fake.fail(1, "esbuild failed:\nERROR: Could not resolve \"x\"");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let app_dir =
            std::env::temp_dir().join(format!("noite-cohost-tenant-{}", crate::models::new_id()));
        std::fs::create_dir_all(&app_dir).unwrap();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
        };

        let err = deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
            .await
            .unwrap_err();
        assert!(format!("{:#}", err).contains("esbuild failed"), "{:#}", err);
        assert_eq!(fake.invocations().len(), 2);

        // Both app attempts fail on infra: one retry, then both errors.
        // A fresh token keeps the cohosted deploy (invocation 0) so the
        // app's attempts stay 1 and 2.
        let fake = FakeCelld::spawn();
        fake.fail(1, "first: connection refused");
        fake.fail(2, "second: 503 SlowDown");
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let err =
            deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok-2")], &app_side)
                .await
                .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.contains("failed twice"), "{}", text);
        assert!(text.contains("first: connection refused"), "{}", text);
        assert!(text.contains("second: 503 SlowDown"), "{}", text);
        assert_eq!(fake.invocations().len(), 3);
        std::fs::remove_dir_all(&app_dir).unwrap();
    }

    /// A failed cohosted deploy fails the deploy before the app moves the
    /// pointer: no app invocation, no stored hash, the secret-bearing temp
    /// project removed — and the next deploy starts over.
    #[tokio::test]
    async fn cohost_failure_fails_before_the_app() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let fake = FakeCelld::spawn();
        fake.fail(
            0,
            "put deploy/current.json: connection refused (os error 111)",
        );
        let log = fake.log();
        let dir = fake.dir.to_string_lossy().into_owned();
        let env = vec![
            ("FAKE_CELLD_LOG", log.as_str()),
            ("FAKE_CELLD_DIR", dir.as_str()),
        ];
        let bin = fake.bin();
        let celld = CelldDeploy {
            celld_bin: &bin,
            env: &env,
            bucket: "s3://noite/fleets/cohost-app",
            endpoint: "http://rustfs:9000",
            region: "us-east-1",
            timeout: Duration::from_secs(30),
        };
        let app_dir =
            std::env::temp_dir().join(format!("noite-cohost-cofail-{}", crate::models::new_id()));
        std::fs::create_dir_all(&app_dir).unwrap();
        let app_side = FleetApp {
            dir: &app_dir,
            cwd: None,
            timeout: Duration::from_secs(30),
        };

        let err = deploy_fleet_in_order(&pool, &app.id, None, &celld, &[render("tok")], &app_side)
            .await
            .unwrap_err();
        let text = format!("{:#}", err);
        assert!(text.contains("noite-test-cohost"), "{}", text);
        assert!(!text.contains("project kept at"), "{}", text);
        assert_eq!(fake.invocations().len(), 1);
        // The temp project is gone on the failure path too.
        let project = fake.invocations()[0]
            .split(' ')
            .nth(1)
            .expect("deploy argv")
            .to_string();
        assert!(!Path::new(&project).exists(), "{}", project);
        // Nothing stored: the next deploy tries the cohosted script again.
        assert_eq!(
            db::get_cohost_hash(&pool, &app.id, None, "noite-test-cohost")
                .await
                .unwrap(),
            None
        );
        std::fs::remove_dir_all(&app_dir).unwrap();
    }
}
