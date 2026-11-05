//! The managed Void sandbox controller as a cohosted script (SPEC, Void
//! sandbox controller): detection, protocol check, the moved containers
//! entry, and the per-fleet render.
//!
//! A Void app whose built config carries a `durable_object`-policy
//! `containers[]` entry has a managed sandbox: Void's runtime refuses to
//! start a local one under the vars Noite injects, so the deploy cohosts
//! the runner-owned `noite-void-sandbox` script in the fleet and binds it
//! into the app as `__VOID_SANDBOX`. The deploy pipeline
//! ([`super::deploy`]) runs, for such an app:
//!
//! 1. [`take_sandbox_entry`]: strip the managed entry from the app config
//!    (the app keeps its `SANDBOX` binding + migration — the managed
//!    runtime never instantiates the local class — but must not carry a
//!    container class Void's runtime refuses to start).
//! 2. [`StagedSandbox::stage`]: refuse a protocol/major mismatch with
//!    Void's exact message ([`assert_compatible_void_version`], a verbatim
//!    port of `apps/void-sandbox/src/protocol.ts`), ensure the fleet's
//!    admission name, and map the entry ([`map_entry`] — controller class,
//!    stable name, admission cap as `max_instances`) into a staging dir.
//! 3. The existing [`super::build_output::plan_containers`] plans the
//!    staged entry and [`super::container_image::prepare`] vets a
//!    Dockerfile exactly as for the app; a direct registry ref must be
//!    digest-pinned ([`check_registry_pin`]).
//! 4. [`StagedSandbox::render`]: the controller `wrangler.json` per the
//!    SPEC render contract (DO bindings + migrations, vars,
//!    `nodejs_compat`, the moved entry) with the image-build bundle as its
//!    `worker.js`, deployed controller-first via [`super::void_cohost`]
//!    (order [`SANDBOX_ORDER`], below the proxy's) and skipped when its
//!    content hash — bundle, config and image digest composite — matches
//!    the stored one.
//!
//! Detection is the entry plus the Void gate: non-Void apps keep the
//! unmanaged path (their own DO + `ctx.container`) untouched, and Void
//! apps without the entry deploy no controller. `NOITE_SANDBOX=0` refuses
//! the staged entry through the same gate as any other.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::db;
use crate::host::void_cohost::{CohostedScript, RenderedCohost, RuntimeSource};

/// The runner-owned sandbox controller script, one per Void fleet with a
/// managed sandbox. A tenant config using it as its script `name` would
/// alias the controller's named pointer, so it fails the deploy.
pub const SANDBOX_SCRIPT_NAME: &str = "noite-void-sandbox";

/// The service binding the runner-owned merge injects into sandbox apps.
/// Reserved now (a tenant entry fails the deploy), injected then.
pub const SANDBOX_BINDING: &str = "__VOID_SANDBOX";

/// The controller's Durable Object classes: the sandbox cells plus the
/// fleet-local admission counter (controller-internal, never app-visible).
pub const CONTROLLER_CLASS: &str = "SandboxController";
pub const ADMISSION_CLASS: &str = "NoiteSandboxAdmission";

/// The admission namespace's binding name in the controller config (the
/// namespace itself; [`ADMISSION_NAME_VAR`] is the var holding the secret
/// cell name within it).
pub const ADMISSION_BINDING: &str = "__VOID_SANDBOX_ADMISSION";

/// Controller vars (SPEC Env contract): the secret admission-cell name,
/// the admission cap, and the debug-only source record.
pub const ADMISSION_NAME_VAR: &str = "__VOID_SANDBOX_ADMISSION_NAME";
pub const MAX_CONCURRENT_VAR: &str = "__VOID_SANDBOX_MAX_CONCURRENT";
pub const SOURCE_VAR: &str = "__VOID_SANDBOX_SOURCE";

/// The moved entry's container name: stable per app, not per deploy —
/// celld re-resolves the image on every controller deploy, so stability is
/// safe and avoids orphan container applications.
pub const CONTAINER_NAME: &str = "noite-void-sandbox-v1";

/// Deploy order among cohosted scripts: the controller deploys before the
/// proxy ([`super::void_proxy::PROXY_ORDER`]) and the tenant app (which
/// always deploys last).
pub const SANDBOX_ORDER: u32 = 5;

/// Vars holding secrets: substituted by their hashes for the content hash,
/// so a rotation redeploys the controller.
const SECRET_VARS: &[&str] = &[ADMISSION_NAME_VAR];

/// The controller as a cohosted script. No compile-time sources: the
/// image-build bundle rides each render as a runtime-loaded source.
pub const SANDBOX_SCRIPT: CohostedScript = CohostedScript {
    name: SANDBOX_SCRIPT_NAME,
    main: "worker.js",
    sources: &[],
    order: SANDBOX_ORDER,
};

/// Void's exact protocol refusal (its deploy gate emits this string; the
/// runner ports the rule verbatim, message included).
pub const VOID_UPGRADE_MESSAGE: &str = "Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again.";

/// Leading major of a version or range (`1.5.0`, `^1.2.0`, `>=1.0.0
/// <2.0.0`, `v1.5.0`), or `None` when no major is readable. Verbatim port
/// of `parseVoidMajor`: strip one run of range syntax, then digits that end
/// or meet a dot. Anything unreadable refuses: fail closed, never guess.
pub fn parse_void_major(spec: &str) -> Option<u32> {
    let stripped = spec.trim().trim_start_matches(|c: char| {
        matches!(c, 'v' | '=' | '^' | '~' | '>' | '<') || c.is_whitespace()
    });
    let digits: String = stripped
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let rest = &stripped[digits.len()..];
    if !(rest.is_empty() || rest.starts_with('.')) {
        return None;
    }
    digits.parse().ok()
}

/// Refuse with [`VOID_UPGRADE_MESSAGE`] unless the app's `void` spec
/// resolves to the bundle's major. A missing or unreadable app spec
/// refuses. A bundle whose own version has no readable major is a platform
/// fault, not a tenant one, and fails loudly as such (the port of the
/// bundle self-check: here both values cannot drift apart, they come from
/// one `meta.json`, so only garbage is left to report).
pub fn assert_compatible_void_version(
    app_spec: Option<&str>,
    bundle_version: &str,
) -> anyhow::Result<()> {
    let Some(bundle_major) = parse_void_major(bundle_version) else {
        anyhow::bail!(
            "sandbox controller bundle reports void {:?}, which has no readable major (rebuild the controller bundle)",
            bundle_version
        );
    };
    let app_major = app_spec.and_then(parse_void_major);
    if app_major != Some(bundle_major) {
        anyhow::bail!(VOID_UPGRADE_MESSAGE);
    }
    Ok(())
}

/// The app's `void` spec from the worktree `package.json`
/// (`dependencies`, then `devDependencies`). `None` when the file is
/// missing, unparseable, or names no `void` — the protocol check refuses
/// all of those, before `celld deploy`.
pub fn app_void_spec(src_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(src_dir.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value
        .get("dependencies")
        .and_then(|deps| deps.get("void"))
        .or_else(|| {
            value
                .get("devDependencies")
                .and_then(|deps| deps.get("void"))
        })
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `dist/meta.json` beside the controller bundle: the `void` version the
/// bundle builds against, the controller protocol it speaks, and the
/// bundle's own SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleMeta {
    pub void: String,
    pub controller_protocol: u64,
    pub bundle_sha256: String,
}

/// The fixed controller bundle: `dist/worker.js` plus its meta. Read from
/// disk at deploy time (the image build compiles it; a dev checkout runs
/// `bun run build` in `apps/void-sandbox`), verified against its own
/// digest before anything deploys it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub worker_js: Vec<u8>,
    pub meta: BundleMeta,
}

/// Load and verify the controller bundle from `dir` (`worker.js` +
/// `meta.json`). A missing or inconsistent bundle fails the deploy before
/// anything moves: without the controller there is no managed sandbox.
pub fn load_bundle(dir: &Path) -> anyhow::Result<Bundle> {
    let worker = dir.join("worker.js");
    let meta_path = dir.join("meta.json");
    for path in [&worker, &meta_path] {
        if !path.is_file() {
            anyhow::bail!(
                "sandbox controller bundle incomplete at {}: {} is missing (the image ships the bundle at /opt/noite/void-sandbox; a dev checkout builds it with `bun run build` in apps/void-sandbox)",
                dir.display(),
                path.display()
            );
        }
    }
    let worker_js = std::fs::read(&worker).with_context(|| format!("read {}", worker.display()))?;
    let meta_text = std::fs::read_to_string(&meta_path)
        .with_context(|| format!("read {}", meta_path.display()))?;
    let meta_value: Value = serde_json::from_str(&meta_text)
        .with_context(|| format!("parse {}", meta_path.display()))?;
    let meta = BundleMeta {
        void: meta_value
            .get("void")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .with_context(|| format!("{} has no `void` version", meta_path.display()))?
            .to_string(),
        controller_protocol: meta_value
            .get("controllerProtocol")
            .and_then(Value::as_u64)
            .with_context(|| format!("{} has no `controllerProtocol`", meta_path.display()))?,
        bundle_sha256: meta_value
            .get("bundleSha256")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .with_context(|| format!("{} has no `bundleSha256`", meta_path.display()))?
            .to_string(),
    };
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&worker_js);
    let sha256: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    if sha256 != meta.bundle_sha256 {
        anyhow::bail!(
            "sandbox controller bundle at {} is inconsistent: worker.js does not match meta.json's bundleSha256 (rebuild the controller bundle)",
            dir.display()
        );
    }
    Ok(Bundle { worker_js, meta })
}

/// Index of the managed sandbox entry in a built config: the `containers[]`
/// entry with the `durable_object` scheduling policy. `None` when the
/// config declares no containers or none with the policy. More than one is
/// a refused deploy: Void emits exactly one, and the controller serves one
/// cell namespace — silently picking one would strand the other's image.
pub fn sandbox_entry_index(config: &Value) -> anyhow::Result<Option<usize>> {
    let Some(entries) = config.get("containers").and_then(Value::as_array) else {
        return Ok(None);
    };
    let mut found = None;
    for (index, entry) in entries.iter().enumerate() {
        if entry.get("scheduling_policy").and_then(Value::as_str) != Some("durable_object") {
            continue;
        }
        if let Some(first) = found {
            anyhow::bail!(
                "a Void app declares one managed sandbox, but the config has two `durable_object` containers entries (containers[{}] and containers[{}]); keep one",
                first,
                index
            );
        }
        found = Some(index);
    }
    Ok(found)
}

/// Strip the managed sandbox entry from the deploy root's
/// `wrangler.jsonc`/`wrangler.json` (`jsonc` first, as celld reads them),
/// parsed and written back like the other merges (never following links).
/// Returns the removed entry for the controller staging, or `None` when
/// the root has no JSON config or no managed entry. An emptied
/// `containers` key goes with the entry: the app must not carry a hollow
/// one (celld would read it as declaring nothing either way).
pub fn take_sandbox_entry(deploy_root: &Path) -> anyhow::Result<Option<Value>> {
    let mut found = None;
    for name in ["wrangler.jsonc", "wrangler.json"] {
        if let Ok(text) = std::fs::read_to_string(deploy_root.join(name)) {
            found = Some((name, text));
            break;
        }
    }
    let Some((label, text)) = found else {
        return Ok(None);
    };
    let mut value =
        crate::host::storage::parse_wrangler(&text).with_context(|| format!("parse {}", label))?;
    let Some(index) = sandbox_entry_index(&value)? else {
        return Ok(None);
    };
    let entry = value
        .get_mut("containers")
        .and_then(Value::as_array_mut)
        .map(|entries| entries.remove(index));
    if value
        .get("containers")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        value.as_object_mut().map(|obj| obj.remove("containers"));
    }
    crate::host::build_output::write_fresh(
        &deploy_root.join(label),
        &serde_json::to_string_pretty(&value)?,
    )?;
    Ok(entry)
}

/// Map the app's managed entry onto the controller config: the controller
/// class, the stable container name, and the admission cap as the
/// `max_instances` backstop. `instance_type` is dropped — ignored in v1
/// (celld default). Path-valued keys are absolutized against the app root
/// so the staging plan resolves exactly what an app-root plan would (Void
/// emits absolute paths; anything else is rebased, never reinterpreted):
/// `dockerfile`/`build_context` always, an `image` only when it names a
/// file under the app root (a registry ref passes through for the pin
/// check). Malformed shapes pass through untouched:
/// [`super::build_output::plan_containers`] refuses them with its own
/// errors.
pub fn map_entry(mut entry: Value, app_root: &Path, max_instances: u32) -> Value {
    let Some(obj) = entry.as_object_mut() else {
        return entry;
    };
    obj.insert(
        "class_name".to_string(),
        Value::String(CONTROLLER_CLASS.to_string()),
    );
    obj.insert(
        "name".to_string(),
        Value::String(CONTAINER_NAME.to_string()),
    );
    obj.remove("instance_type");
    obj.insert("max_instances".to_string(), Value::from(max_instances));
    let absolutize = |value: &mut Value| {
        if let Some(path) = value.as_str() {
            *value = Value::String(app_root.join(path).display().to_string());
        }
    };
    if let Some(default) = obj
        .get_mut("images")
        .and_then(|images| images.get_mut("default"))
        .and_then(Value::as_object_mut)
    {
        for key in ["dockerfile", "build_context"] {
            if let Some(value) = default.get_mut(key) {
                absolutize(value);
            }
        }
        if let Some(image) = default.get_mut("image") {
            let is_file = image
                .as_str()
                .is_some_and(|path| crate::host::build_output::is_dockerfile(app_root, path));
            if is_file {
                absolutize(image);
            }
        }
    }
    if let Some(image) = obj.get_mut("image") {
        let is_file = image
            .as_str()
            .is_some_and(|path| crate::host::build_output::is_dockerfile(app_root, path));
        if is_file {
            absolutize(image);
        }
    }
    entry
}

/// True when `image` is a digest-pinned registry ref: `@sha256:` plus 64
/// lowercase hex at the end (Void's own pin shape).
fn digest_pinned(image: &str) -> bool {
    image.rsplit_once("@sha256:").is_some_and(|(_, digest)| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// Refuse a staged controller entry whose image is a direct registry ref
/// without a digest pin. Dockerfile entries (a prepare request exists)
/// pass: the vet pins their bases. A missing or non-string `image` passes
/// too: celld refuses it at the controller deploy with its own error.
pub fn check_registry_pin(plan: &crate::host::build_output::ContainersPlan) -> anyhow::Result<()> {
    let entries = plan
        .value()
        .get("containers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, entry) in entries.iter().enumerate() {
        if plan.dockerfiles.iter().any(|(at, _)| *at == index) {
            continue;
        }
        let Some(image) = entry.get("image").and_then(Value::as_str) else {
            continue;
        };
        if !digest_pinned(image) {
            anyhow::bail!(
                "containers[{}].image {:?} must be digest-pinned (@sha256:<64 lowercase hex>) for a managed Void sandbox: publish the image with a digest, or build it from a Dockerfile",
                index,
                image
            );
        }
    }
    Ok(())
}

/// 32 random bytes, base64url (43 chars): the per-fleet admission name.
/// The controller accepts 32 at minimum; length is pinned by test.
pub fn mint_admission_name() -> String {
    use base64::Engine as _;
    use rand::TryRng as _;
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Ensure this fleet's `__VOID_SANDBOX_ADMISSION_NAME`: the app-level row
/// for production, the environment's own row for a preview (per-fleet,
/// never inherited). Minted once, reused on later deploys; a user row
/// under the name fails the deploy as reserved instead of being read or
/// overwritten (unreachable in the deploy flow — the settings merge
/// refuses it first — but the helper must not depend on that).
pub async fn ensure_admission_name(
    pool: &SqlitePool,
    app_id: &str,
    environment_id: Option<&str>,
) -> anyhow::Result<(String, bool)> {
    match environment_id {
        None => {
            if let Some(row) = db::get_env(pool, app_id, ADMISSION_NAME_VAR).await? {
                if row.source != db::SOURCE_VOID_SANDBOX_ADMISSION {
                    anyhow::bail!(
                        "settings variable `{}` is reserved for the platform and cannot become a Worker var (rename it or remove it from Settings → Environment)",
                        ADMISSION_NAME_VAR
                    );
                }
                return Ok((row.value, false));
            }
            let name = mint_admission_name();
            db::insert_provisioned(
                pool,
                app_id,
                ADMISSION_NAME_VAR,
                &name,
                db::SOURCE_VOID_SANDBOX_ADMISSION,
            )
            .await?;
            let row = db::get_env(pool, app_id, ADMISSION_NAME_VAR)
                .await?
                .context("provisioned admission name missing")?;
            let minted = row.value == name;
            Ok((row.value, minted))
        }
        Some(env_id) => {
            if let Some(row) = db::get_env_override(pool, env_id, ADMISSION_NAME_VAR).await? {
                if row.source != db::SOURCE_VOID_SANDBOX_ADMISSION {
                    anyhow::bail!(
                        "settings variable `{}` is reserved for the platform and cannot become a Worker var (rename it or remove it from this environment's Variable overrides)",
                        ADMISSION_NAME_VAR
                    );
                }
                return Ok((row.value, false));
            }
            let name = mint_admission_name();
            db::insert_env_override_provisioned(
                pool,
                env_id,
                ADMISSION_NAME_VAR,
                &name,
                db::SOURCE_VOID_SANDBOX_ADMISSION,
            )
            .await?;
            let row = db::get_env_override(pool, env_id, ADMISSION_NAME_VAR)
                .await?
                .context("provisioned admission name missing")?;
            let minted = row.value == name;
            Ok((row.value, minted))
        }
    }
}

/// The Dockerfile image's content-hash input: SHA-256 over the pinned
/// Dockerfile bytes plus the build-context digest. A registry image needs
/// no input — its digest rides the rendered config. Fed to the render as
/// the extra hash input, so any image change redeploys the controller.
pub fn dockerfile_image_digest(
    pinned: &Path,
    context_digest: &[u8; 32],
) -> anyhow::Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(pinned).with_context(|| format!("read {}", pinned.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hasher.update([0]);
    hasher.update(context_digest);
    Ok(hasher.finalize().into())
}

/// One fleet's staged controller: the verified bundle, the fleet's
/// admission name, and the mapped entry written to a staging dir for the
/// existing containers planning. Dropping the value removes the staging
/// dir (success and failure alike — it only ever holds the staged
/// `wrangler.json`).
#[derive(Debug)]
pub struct StagedSandbox {
    dir: PathBuf,
    bundle: Bundle,
    admission_name: String,
    source: String,
    app_void: String,
    protocol: u64,
    max_concurrent: u32,
}

impl Drop for StagedSandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// What one controller staging reads besides the fleet rows: the held
/// managed entry, the app root (path absolutization base), the worktree
/// root (the `void` spec), the bundle dir, and the operator's admission
/// cap.
pub struct StageInputs<'a> {
    pub entry: Value,
    pub app_root: &'a Path,
    pub src_dir: &'a Path,
    pub bundle_dir: &'a Path,
    pub max_concurrent: u32,
}

impl StagedSandbox {
    /// Stage the fleet's controller: load and verify the bundle, refuse a
    /// protocol/major mismatch with Void's exact message, ensure the
    /// fleet's admission name, and write the mapped entry to a fresh
    /// staging dir for [`super::build_output::plan_containers`]. All
    /// before any `celld deploy`: a failure here fails the deploy with the
    /// fleet untouched.
    pub async fn stage(
        pool: &SqlitePool,
        app_id: &str,
        environment_id: Option<&str>,
        inputs: &StageInputs<'_>,
    ) -> anyhow::Result<Self> {
        let bundle = load_bundle(inputs.bundle_dir)?;
        let app_spec = app_void_spec(inputs.src_dir);
        assert_compatible_void_version(app_spec.as_deref(), &bundle.meta.void)?;
        let (admission_name, _) = ensure_admission_name(pool, app_id, environment_id).await?;
        let mapped = map_entry(inputs.entry.clone(), inputs.app_root, inputs.max_concurrent);
        let dir: PathBuf =
            std::env::temp_dir().join(format!("noite-sandbox-stage-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir)?;
        let staged = serde_json::json!({
            "name": SANDBOX_SCRIPT_NAME,
            "containers": [mapped],
        });
        std::fs::write(
            dir.join("wrangler.json"),
            serde_json::to_string_pretty(&staged)?,
        )?;
        Ok(Self {
            dir,
            source: format!(
                "void {} / bundle sha256:{}",
                bundle.meta.void, bundle.meta.bundle_sha256
            ),
            app_void: app_spec.unwrap_or_default(),
            protocol: bundle.meta.controller_protocol,
            bundle,
            admission_name,
            max_concurrent: inputs.max_concurrent,
        })
    }

    /// The staging dir: plan the moved entry here with
    /// [`super::build_output::plan_containers`].
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The deploy-record line: the app `void` version, the bundle `void`
    /// version + sha256, and the protocol. Names and versions only — the
    /// admission name never reaches the log.
    pub fn log_line(&self) -> String {
        // The app spec is tenant text (package.json), so it is quoted: a
        // spec with a newline cannot forge a deploy-log line.
        format!(
            "void: managed sandbox: controller staged (app void {:?}, bundle {}; protocol {})\n",
            self.app_void, self.source, self.protocol
        )
    }

    /// Render the fleet's controller project from the planned staging
    /// value: the cohosted script plus its `wrangler.json` per the SPEC
    /// render contract (DO bindings + migrations, vars, `nodejs_compat`,
    /// the moved entry). The bundle rides as the `worker.js` runtime
    /// source; `image_digest` (Dockerfile images only) feeds the content
    /// hash beside bundle and config.
    pub fn render(
        &self,
        planned: &Value,
        image_digest: Option<[u8; 32]>,
    ) -> anyhow::Result<RenderedCohost> {
        let entry = planned
            .get("containers")
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .cloned()
            .context("staged sandbox controller has no containers entry")?;
        let mut vars = serde_json::Map::new();
        vars.insert(
            ADMISSION_NAME_VAR.to_string(),
            Value::String(self.admission_name.clone()),
        );
        vars.insert(
            MAX_CONCURRENT_VAR.to_string(),
            Value::String(self.max_concurrent.to_string()),
        );
        vars.insert(SOURCE_VAR.to_string(), Value::String(self.source.clone()));
        Ok(RenderedCohost {
            script: &SANDBOX_SCRIPT,
            secret_vars: SECRET_VARS,
            config: serde_json::json!({
                "name": SANDBOX_SCRIPT_NAME,
                "main": SANDBOX_SCRIPT.main,
                "compatibility_date": "2026-09-01",
                "compatibility_flags": ["nodejs_compat"],
                "durable_objects": {
                    "bindings": [
                        {"name": "SANDBOX", "class_name": CONTROLLER_CLASS},
                        {"name": ADMISSION_BINDING, "class_name": ADMISSION_CLASS},
                    ],
                },
                "migrations": [
                    {"tag": "v1", "new_sqlite_classes": [CONTROLLER_CLASS, ADMISSION_CLASS]},
                ],
                "vars": Value::Object(vars),
                "containers": [entry],
            }),
            extra_sources: vec![RuntimeSource {
                path: SANDBOX_SCRIPT.main.to_string(),
                contents: self.bundle.worker_js.clone(),
            }],
            extra_hash_input: image_digest
                .map(|digest| digest.to_vec())
                .unwrap_or_default(),
            declares_containers: true,
            read_root: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The protocol rule, case for case with `protocol.test.ts`: plain
    /// versions and v-prefixes, ranges resolving to their leading major,
    /// and unreadable specs refusing (null, never a guess).
    #[test]
    fn void_major_parses_versions_and_ranges() {
        for (spec, major) in [
            ("1.5.0", 1),
            ("v1.5.0", 1),
            ("2.0.0", 2),
            ("1", 1),
            ("^1.2.0", 1),
            ("~1.2.3", 1),
            (">=1.0.0 <2.0.0", 1),
            (">=2.0.0", 2),
        ] {
            assert_eq!(parse_void_major(spec), Some(major), "{}", spec);
        }
        for spec in ["", "latest", "*", "github:org/repo", "next", "1x", "v"] {
            assert_eq!(parse_void_major(spec), None, "{}", spec);
        }
    }

    /// The compatibility gate, message included: the same major (any minor
    /// or range) passes, another major refuses with Void's exact wording,
    /// and a missing or unreadable spec refuses. The refusal string is
    /// asserted literally: the port must stay verbatim.
    #[test]
    fn compatible_major_passes_mismatch_refuses_verbatim() {
        assert_eq!(
            VOID_UPGRADE_MESSAGE,
            "Managed Sandboxes require an updated Void runtime. Upgrade void, rebuild the app, and deploy again."
        );
        for spec in ["1.5.0", "1.0.0", "^1.2.0", ">=1.0.0 <2.0.0"] {
            assert_compatible_void_version(Some(spec), "1.5.0").unwrap();
        }
        for spec in ["2.0.0", "0.9.0", "^2.1.0"] {
            let err = format!(
                "{:#}",
                assert_compatible_void_version(Some(spec), "1.5.0").unwrap_err()
            );
            assert_eq!(err, VOID_UPGRADE_MESSAGE, "{}", spec);
        }
        for spec in [None, Some("latest"), Some("")] {
            let err = format!(
                "{:#}",
                assert_compatible_void_version(spec, "1.5.0").unwrap_err()
            );
            assert_eq!(err, VOID_UPGRADE_MESSAGE, "{:?}", spec);
        }
    }

    /// A bundle whose own version has no readable major fails loudly as a
    /// platform fault — never with the tenant-facing upgrade message.
    #[test]
    fn bundle_without_a_readable_major_fails_as_platform_fault() {
        let err = format!(
            "{:#}",
            assert_compatible_void_version(Some("1.5.0"), "garbage").unwrap_err()
        );
        assert!(err.contains("no readable major"), "{}", err);
        assert!(err.contains("rebuild the controller bundle"), "{}", err);
        assert!(!err.contains("Upgrade void"), "{}", err);
    }

    /// The app spec reads `dependencies`, then `devDependencies`; a
    /// missing file, unparseable JSON or no `void` key yields nothing (the
    /// gate refuses all of those).
    #[test]
    fn app_void_spec_reads_both_dependency_fields() {
        let dir = std::env::temp_dir().join(format!("noite-sb-spec-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(app_void_spec(&dir), None);
        std::fs::write(dir.join("package.json"), "not json").unwrap();
        assert_eq!(app_void_spec(&dir), None);
        std::fs::write(dir.join("package.json"), r#"{"dependencies": {}}"#).unwrap();
        assert_eq!(app_void_spec(&dir), None);
        std::fs::write(
            dir.join("package.json"),
            r#"{"dependencies": {"void": "^1.5.0"}, "devDependencies": {"void": "2.0.0"}}"#,
        )
        .unwrap();
        assert_eq!(app_void_spec(&dir).as_deref(), Some("^1.5.0"));
        std::fs::write(
            dir.join("package.json"),
            r#"{"devDependencies": {"void": "~1.2.3"}}"#,
        )
        .unwrap();
        assert_eq!(app_void_spec(&dir).as_deref(), Some("~1.2.3"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch(name: &str) -> crate::testutil::TempDir {
        crate::testutil::TempDir::new(&format!("noite-void-sandbox-{name}"))
    }

    /// Write a bundle dir with `worker.js` + a matching `meta.json`;
    /// returns the dir and the worker bytes.
    fn bundle_dir(name: &str, worker_js: &[u8]) -> (crate::testutil::TempDir, Vec<u8>) {
        use sha2::{Digest, Sha256};
        let guard = scratch(name);
        let dir = guard.path();
        std::fs::write(dir.join("worker.js"), worker_js).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(worker_js);
        let sha256: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        std::fs::write(
            dir.join("meta.json"),
            format!(
                "{{\n  \"void\": \"1.5.0\",\n  \"controllerProtocol\": 2,\n  \"bundleSha256\": \"{}\"\n}}\n",
                sha256
            ),
        )
        .unwrap();
        (guard, worker_js.to_vec())
    }

    /// Bundle loading round-trips `worker.js` + `meta.json` and verifies
    /// the digest; a missing, unparsable or inconsistent bundle fails
    /// before anything deploys, naming the rebuild.
    #[test]
    fn bundle_load_verifies_its_own_digest() {
        let (guard_bundle_ok, worker) = bundle_dir("bundle-ok", b"controller-bundle");
        let dir = guard_bundle_ok.path().canonicalize().unwrap();
        let bundle = load_bundle(&dir).unwrap();
        assert_eq!(bundle.worker_js, worker);
        assert_eq!(
            bundle.meta,
            BundleMeta {
                void: "1.5.0".to_string(),
                controller_protocol: 2,
                bundle_sha256: bundle.meta.bundle_sha256.clone(),
            }
        );
        assert_eq!(bundle.meta.bundle_sha256.len(), 64);

        std::fs::write(dir.join("worker.js"), b"controller-bundle-tampered").unwrap();
        let err = format!("{:#}", load_bundle(&dir).unwrap_err());
        assert!(err.contains("does not match"), "{}", err);
        assert!(err.contains("rebuild the controller bundle"), "{}", err);

        std::fs::remove_file(dir.join("worker.js")).unwrap();
        let err = format!("{:#}", load_bundle(&dir).unwrap_err());
        assert!(err.contains("is missing"), "{}", err);
        assert!(err.contains("bun run build"), "{}", err);

        let (guard_bundle_broken, _) = bundle_dir("bundle-broken", b"x");

        let broken = guard_bundle_broken.path().canonicalize().unwrap();
        std::fs::write(broken.join("meta.json"), "not json").unwrap();
        assert!(load_bundle(&broken).is_err());
        std::fs::write(broken.join("meta.json"), "{}").unwrap();
        let err = format!("{:#}", load_bundle(&broken).unwrap_err());
        assert!(err.contains("has no `void`"), "{}", err);
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&broken).unwrap();
    }

    /// The minted admission name: 32 random bytes base64url — 43 chars, at
    /// least the 32 the controller requires, decoding to 192 bits.
    #[test]
    fn minted_admission_names_have_their_shape() {
        use base64::Engine as _;
        let name = mint_admission_name();
        assert_eq!(name.len(), 43, "{}", name);
        assert!(
            name.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "{}",
            name
        );
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&name)
                .unwrap()
                .len(),
            32
        );
        assert_ne!(mint_admission_name(), name);
    }

    /// The take strips the `durable_object` entry and hands it back: the
    /// app keeps its other entries, its `SANDBOX` binding and its
    /// migration, while an emptied `containers` key goes with the entry.
    #[test]
    fn take_strips_the_managed_entry_and_hands_it_back() {
        let guard_take = scratch("take");
        let dir = guard_take.path().canonicalize().unwrap();
        std::fs::write(
            dir.join("wrangler.json"),
            r#"{
  "name": "blog",
  "durable_objects": {"bindings": [{"name": "SANDBOX", "class_name": "SandboxV1"}]},
  "migrations": [{"tag": "void-sandbox-v2", "new_sqlite_classes": ["SandboxV1"]}],
  "containers": [
    {"class_name": "Other", "image": "registry.example/o@sha256:00"},
    {"name": "void-sandbox-v1", "class_name": "SandboxV1", "scheduling_policy": "durable_object", "images": {"default": {"image": "registry.example/s@sha256:11"}}}
  ]
}"#,
        )
        .unwrap();
        let entry = take_sandbox_entry(&dir).unwrap().expect("managed entry");
        assert_eq!(entry["class_name"], "SandboxV1");
        assert_eq!(
            entry["images"]["default"]["image"],
            "registry.example/s@sha256:11"
        );
        let app: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.json")).unwrap())
                .unwrap();
        assert_eq!(
            app["containers"],
            json!([{"class_name": "Other", "image": "registry.example/o@sha256:00"}])
        );
        // Binding and migration stay: the managed runtime never
        // instantiates the local class, but stripping saves nothing.
        assert_eq!(app["durable_objects"]["bindings"][0]["name"], "SANDBOX");
        assert_eq!(app["migrations"][0]["tag"], "void-sandbox-v2");

        // The last entry out empties the key itself.
        std::fs::write(
            dir.join("wrangler.json"),
            r#"{"name": "blog", "containers": [{"class_name": "SandboxV1", "scheduling_policy": "durable_object", "images": {"default": {"image": "registry.example/s@sha256:11"}}}]}"#,
        )
        .unwrap();
        take_sandbox_entry(&dir).unwrap().expect("managed entry");
        let app: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("wrangler.json")).unwrap())
                .unwrap();
        assert!(app.get("containers").is_none(), "{}", app);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// No JSON config, no containers, or no managed entry: nothing to
    /// take, and the file is left byte-identical when there is one.
    #[test]
    fn take_is_none_without_a_managed_entry() {
        let guard_take_none = scratch("take-none");
        let dir = guard_take_none.path().canonicalize().unwrap();
        assert_eq!(take_sandbox_entry(&dir).unwrap(), None);
        std::fs::write(dir.join("wrangler.toml"), "name = \"a\"\n").unwrap();
        assert_eq!(take_sandbox_entry(&dir).unwrap(), None);

        for config in [
            r#"{"name": "a"}"#,
            r#"{"name": "a", "containers": []}"#,
            r#"{"name": "a", "containers": [{"class_name": "S", "image": "i"}]}"#,
            r#"{"name": "a", "containers": [{"class_name": "S", "scheduling_policy": "regional", "image": "i"}]}"#,
        ] {
            std::fs::write(dir.join("wrangler.json"), config).unwrap();
            assert_eq!(take_sandbox_entry(&dir).unwrap(), None, "{}", config);
            assert_eq!(
                std::fs::read_to_string(dir.join("wrangler.json")).unwrap(),
                config,
                "untouched file rewritten"
            );
        }
        // `jsonc` wins over `json`, as celld reads them.
        std::fs::write(
            dir.join("wrangler.jsonc"),
            r#"{"name": "a", /* c */ "containers": [{"class_name": "S", "scheduling_policy": "durable_object", "images": {"default": {"image": "i"}}}]}"#,
        )
        .unwrap();
        take_sandbox_entry(&dir).unwrap().expect("jsonc entry");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Two managed entries refuse: the controller serves one cell
    /// namespace, so picking one silently would strand the other's image.
    #[test]
    fn take_refuses_two_managed_entries() {
        let guard_take_two = scratch("take-two");
        let dir = guard_take_two.path().canonicalize().unwrap();
        std::fs::write(
            dir.join("wrangler.json"),
            r#"{"name": "a", "containers": [
              {"class_name": "A", "scheduling_policy": "durable_object", "images": {"default": {"image": "i"}}},
              {"class_name": "B", "scheduling_policy": "durable_object", "images": {"default": {"image": "j"}}}
            ]}"#,
        )
        .unwrap();
        let err = format!("{:#}", take_sandbox_entry(&dir).unwrap_err());
        assert!(err.contains("one managed sandbox"), "{}", err);
        assert!(err.contains("containers[0]"), "{}", err);
        assert!(err.contains("containers[1]"), "{}", err);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The map rewrites the entry onto the controller: its class, the
    /// stable container name, the cap as `max_instances` — with
    /// `instance_type` dropped (ignored in v1) and path keys absolutized
    /// against the app root. Registry refs pass through untouched.
    #[test]
    fn map_rewrites_the_entry_onto_the_controller() {
        let guard_map = scratch("map");
        let dir = guard_map.path().canonicalize().unwrap();
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("img/Dockerfile"), "FROM scratch\n").unwrap();
        let entry = json!({
            "name": "void-sandbox-v1",
            "class_name": "SandboxV1",
            "scheduling_policy": "durable_object",
            "instance_type": "standard-2",
            "images": {"default": {"dockerfile": "img/Dockerfile", "build_context": "img"}},
        });
        let mapped = map_entry(entry, &dir, 4);
        assert_eq!(mapped["class_name"], "SandboxController");
        assert_eq!(mapped["name"], "noite-void-sandbox-v1");
        assert_eq!(mapped["max_instances"], 4);
        assert!(mapped.get("instance_type").is_none());
        assert_eq!(mapped["scheduling_policy"], "durable_object");
        assert_eq!(
            mapped["images"]["default"]["dockerfile"],
            dir.join("img/Dockerfile").display().to_string()
        );
        assert_eq!(
            mapped["images"]["default"]["build_context"],
            dir.join("img").display().to_string()
        );

        // A file-named `image` absolutizes like a `dockerfile`; a registry
        // ref passes through for the pin check.
        std::fs::write(dir.join("Dockerfile"), "FROM scratch\n").unwrap();
        let mapped = map_entry(
            json!({"class_name": "S", "scheduling_policy": "durable_object", "images": {"default": {"image": "Dockerfile"}}}),
            &dir,
            2,
        );
        assert_eq!(
            mapped["images"]["default"]["image"],
            dir.join("Dockerfile").display().to_string()
        );
        assert_eq!(mapped["max_instances"], 2);
        let mapped = map_entry(
            json!({"class_name": "S", "scheduling_policy": "durable_object", "images": {"default": {"image": "registry.example/x@sha256:aa"}}}),
            &dir,
            2,
        );
        assert_eq!(
            mapped["images"]["default"]["image"],
            "registry.example/x@sha256:aa"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The pin rule mirrors Void's shape: `@sha256:` plus 64 lowercase
    /// hex at the end — tags, short digests and uppercase hex refuse.
    #[test]
    fn digest_pin_shape_is_voids() {
        let good = format!("registry.example/x@sha256:{}", "ab12".repeat(16));
        assert!(digest_pinned(&good));
        assert!(digest_pinned(&format!(
            "registry.example/x:tag@{}",
            &good[good.find('@').unwrap() + 1..]
        )));
        for bad in [
            "registry.example/x:latest".to_string(),
            "registry.example/x".to_string(),
            format!("registry.example/x@sha256:{}", "ab12".repeat(8)),
            format!("registry.example/x@sha256:{}X", "a".repeat(63)),
            format!("registry.example/x@sha256:{}", "A".repeat(64)),
            "registry.example/x@sha256:zzzz".to_string(),
        ] {
            assert!(!digest_pinned(&bad), "{}", bad);
        }
    }

    /// Write a staging dir holding one mapped entry, as `stage` does.
    fn staging_dir(name: &str, entry: &Value) -> crate::testutil::TempDir {
        let guard = scratch(name);
        let dir = guard.path();
        std::fs::write(
            dir.join("wrangler.json"),
            serde_json::to_string_pretty(&json!({
                "name": SANDBOX_SCRIPT_NAME,
                "containers": [entry],
            }))
            .unwrap(),
        )
        .unwrap();
        guard
    }

    /// The pin check runs on the planned staging value: a digest-pinned
    /// registry ref passes, an unpinned one refuses naming the rule, a
    /// Dockerfile entry passes (its bases pin at prepare), and a missing
    /// `image` defers to celld's own error at the controller deploy.
    #[test]
    fn registry_pin_checked_on_the_planned_value() {
        let pinned = format!("registry.example/x@sha256:{}", "c3".repeat(32));
        let guard_pin_ok = staging_dir(
            "pin-ok",
            &json!({"class_name": "SandboxController", "name": CONTAINER_NAME, "scheduling_policy": "durable_object", "images": {"default": {"image": pinned}}}),
        );
        let dir = guard_pin_ok.path().canonicalize().unwrap();
        let plan = crate::host::build_output::plan_containers(&dir, false)
            .unwrap()
            .expect("declares");
        check_registry_pin(&plan).unwrap();
        assert_eq!(plan.value()["containers"][0]["image"], pinned);
        std::fs::remove_dir_all(&dir).unwrap();

        let guard_pin_bad = staging_dir(
            "pin-bad",
            &json!({"class_name": "SandboxController", "name": CONTAINER_NAME, "scheduling_policy": "durable_object", "images": {"default": {"image": "registry.example/x:latest"}}}),
        );
        let dir = guard_pin_bad.path().canonicalize().unwrap();
        let plan = crate::host::build_output::plan_containers(&dir, false)
            .unwrap()
            .expect("declares");
        let err = format!("{:#}", check_registry_pin(&plan).unwrap_err());
        assert!(err.contains("must be digest-pinned"), "{}", err);
        assert!(err.contains("registry.example/x:latest"), "{}", err);
        std::fs::remove_dir_all(&dir).unwrap();

        let guard_pin_dockerfile = scratch("pin-dockerfile");

        let dir = guard_pin_dockerfile.path().canonicalize().unwrap();
        std::fs::write(dir.join("Dockerfile"), "FROM scratch\n").unwrap();
        let guard_pin_dockerfile_staging = staging_dir(
            "pin-dockerfile-staging",
            &json!({"class_name": "SandboxController", "name": CONTAINER_NAME, "scheduling_policy": "durable_object", "images": {"default": {"dockerfile": dir.join("Dockerfile").display().to_string()}}}),
        );
        let staging = guard_pin_dockerfile_staging.path().canonicalize().unwrap();
        let plan = crate::host::build_output::plan_containers(&staging, false)
            .unwrap()
            .expect("declares");
        assert_eq!(plan.dockerfiles.len(), 1);
        check_registry_pin(&plan).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&staging).unwrap();

        let guard_pin_missing = staging_dir(
            "pin-missing",
            &json!({"class_name": "SandboxController", "name": CONTAINER_NAME, "scheduling_policy": "durable_object"}),
        );
        let dir = guard_pin_missing.path().canonicalize().unwrap();
        let plan = crate::host::build_output::plan_containers(&dir, false)
            .unwrap()
            .expect("declares");
        check_registry_pin(&plan).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn stage_inputs<'a>(
        entry: Value,
        src: &'a Path,
        bundle: &'a Path,
        cap: u32,
    ) -> StageInputs<'a> {
        StageInputs {
            entry,
            app_root: src,
            src_dir: src,
            bundle_dir: bundle,
            max_concurrent: cap,
        }
    }

    async fn seed(pool: &SqlitePool) -> crate::models::App {
        let cfg = crate::config::config_for_tests();
        crate::db::create_app(
            pool,
            &cfg,
            crate::db::NewApp {
                name: "sandbox-app",
                slug: "sandbox-app",
                user_id: "local",
                subdomain: "sandbox-app.localhost",
                listen: 30000,
                internal: 30001,
            },
        )
        .await
        .expect("seed app")
    }

    async fn seed_env(pool: &SqlitePool, app_id: &str) -> crate::models::Environment {
        let cfg = crate::config::config_for_tests();
        crate::db::create_environment(
            pool,
            &cfg,
            crate::db::NewEnvironment {
                app_id,
                slug: "sandbox-app",
                label: "staging",
                kind: crate::models::EnvironmentKind::Branch,
                git_ref: "refs/heads/staging",
                created_by: "user_1",
                listen: 30010,
                internal: 30011,
            },
        )
        .await
        .expect("seed env")
    }

    /// One admission name per fleet: production's lives on the app row, a
    /// preview's on its own override; each is minted once and reused, and
    /// the two differ. The rows carry the marker, so the settings merges
    /// skip them.
    #[tokio::test]
    async fn admission_names_are_per_fleet_minted_once() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let env = seed_env(&pool, &app.id).await;

        let (prod, minted) = ensure_admission_name(&pool, &app.id, None).await.unwrap();
        assert!(minted);
        assert!(prod.len() >= 32, "{}", prod);
        let (again, minted) = ensure_admission_name(&pool, &app.id, None).await.unwrap();
        assert!(!minted);
        assert_eq!(again, prod);

        let (preview, minted) = ensure_admission_name(&pool, &app.id, Some(&env.id))
            .await
            .unwrap();
        assert!(minted);
        assert_ne!(preview, prod);
        let (again, minted) = ensure_admission_name(&pool, &app.id, Some(&env.id))
            .await
            .unwrap();
        assert!(!minted);
        assert_eq!(again, preview);

        assert_eq!(
            db::get_env(&pool, &app.id, ADMISSION_NAME_VAR)
                .await
                .unwrap()
                .unwrap()
                .source,
            db::SOURCE_VOID_SANDBOX_ADMISSION
        );
        assert_eq!(
            db::get_env_override(&pool, &env.id, ADMISSION_NAME_VAR)
                .await
                .unwrap()
                .unwrap()
                .source,
            db::SOURCE_VOID_SANDBOX_ADMISSION
        );
        // Neither row reaches the Worker-vars input: the controller render
        // injects the name alone.
        assert!(!db::worker_settings(&pool, &app.id)
            .await
            .unwrap()
            .iter()
            .any(|(name, _)| name == ADMISSION_NAME_VAR));
        assert!(!db::environment_worker_settings(&pool, &app.id, &env.id)
            .await
            .unwrap()
            .iter()
            .any(|(name, _)| name == ADMISSION_NAME_VAR));
    }

    /// A user row under the admission name is refused, never read: the
    /// value the controller gets must always be the runner's.
    #[tokio::test]
    async fn a_user_row_under_the_admission_name_is_refused() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        db::set_env(&pool, &app.id, ADMISSION_NAME_VAR, "spoof")
            .await
            .unwrap();
        let err = ensure_admission_name(&pool, &app.id, None)
            .await
            .unwrap_err();
        assert!(
            format!("{:#}", err).contains(ADMISSION_NAME_VAR),
            "{:#}",
            err
        );
        assert_eq!(
            db::get_env(&pool, &app.id, ADMISSION_NAME_VAR)
                .await
                .unwrap()
                .unwrap()
                .value,
            "spoof"
        );
    }

    /// Staging writes the mapped entry beside nothing else, and the
    /// record line carries the app void version, the bundle void version
    /// + sha256 and the protocol — never the admission name.
    #[tokio::test]
    async fn stage_maps_checks_and_records() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (guard_stage_bundle, _) = bundle_dir("stage-bundle", b"stage-bundle-bytes");
        let bundle_path = guard_stage_bundle.path().canonicalize().unwrap();
        let guard_stage_src = scratch("stage-src");
        let src = guard_stage_src.path().canonicalize().unwrap();
        // A spec the major-version check accepts, carrying a forged line.
        std::fs::write(
            src.join("package.json"),
            r#"{"dependencies": {"void": "^1.5.0\nERROR: build failed"}}"#,
        )
        .unwrap();
        let pinned = format!("registry.example/x@sha256:{}", "d4".repeat(32));
        let entry = json!({
            "name": "void-sandbox-v1",
            "class_name": "SandboxV1",
            "scheduling_policy": "durable_object",
            "images": {"default": {"image": pinned}},
        });
        let staged = StagedSandbox::stage(
            &pool,
            &app.id,
            None,
            &stage_inputs(entry, &src, &bundle_path, 4),
        )
        .await
        .unwrap();
        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(staged.dir().join("wrangler.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["name"], SANDBOX_SCRIPT_NAME);
        assert_eq!(written["containers"][0]["class_name"], "SandboxController");
        assert_eq!(written["containers"][0]["name"], CONTAINER_NAME);
        assert_eq!(
            written["containers"][0]["images"]["default"]["image"],
            pinned
        );
        assert_eq!(written["containers"][0]["max_instances"], 4);

        let line = staged.log_line();
        assert!(
            line.contains(r#"app void "^1.5.0\nERROR: build failed""#),
            "{}",
            line
        );
        assert_eq!(line.matches('\n').count(), 1, "{}", line);
        assert!(
            line.contains("bundle void 1.5.0 / bundle sha256:"),
            "{}",
            line
        );
        assert!(line.contains("protocol 2"), "{}", line);
        let (name, _) = ensure_admission_name(&pool, &app.id, None).await.unwrap();
        assert!(
            !line.contains(&name),
            "record line leaks the admission name"
        );
        assert!(!line.contains(ADMISSION_NAME_VAR), "{}", line);

        // Dropping the staged value removes the staging dir.
        let dir = staged.dir().to_path_buf();
        drop(staged);
        assert!(!dir.exists());
        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
    }

    /// Staging refuses before anything provisions: a protocol mismatch
    /// fails with Void's exact message (and mints no admission name), and
    /// a missing bundle fails naming the rebuild.
    #[tokio::test]
    async fn stage_refuses_before_anything_provisions() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (guard_stage_refuse, _) = bundle_dir("stage-refuse", b"bundle");
        let bundle_path = guard_stage_refuse.path().canonicalize().unwrap();
        let guard_stage_refuse_src = scratch("stage-refuse-src");
        let src = guard_stage_refuse_src.path().canonicalize().unwrap();
        std::fs::write(
            src.join("package.json"),
            r#"{"dependencies": {"void": "2.0.0"}}"#,
        )
        .unwrap();
        let entry = json!({"class_name": "S", "scheduling_policy": "durable_object"});
        let err = format!(
            "{:#}",
            StagedSandbox::stage(
                &pool,
                &app.id,
                None,
                &stage_inputs(entry.clone(), &src, &bundle_path, 4),
            )
            .await
            .unwrap_err()
        );
        assert_eq!(err, VOID_UPGRADE_MESSAGE, "{}", err);
        assert!(
            db::get_env(&pool, &app.id, ADMISSION_NAME_VAR)
                .await
                .unwrap()
                .is_none(),
            "a refused deploy must not provision"
        );

        std::fs::write(
            src.join("package.json"),
            r#"{"dependencies": {"void": "1.5.0"}}"#,
        )
        .unwrap();
        let err = format!(
            "{:#}",
            StagedSandbox::stage(
                &pool,
                &app.id,
                None,
                &stage_inputs(entry, &src, &src.join("no-bundle-here"), 4),
            )
            .await
            .unwrap_err()
        );
        assert!(err.contains("is missing"), "{}", err);
        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
    }

    /// Stage a controller over a fixture bundle for render tests: returns
    /// the staged value plus the bundle's worker bytes and source var.
    async fn staged_for_render(
        pool: &SqlitePool,
        app_id: &str,
        cap: u32,
    ) -> (
        StagedSandbox,
        Vec<u8>,
        String,
        crate::testutil::TempDir,
        crate::testutil::TempDir,
    ) {
        let (guard_render_bundle, worker) = bundle_dir("render-bundle", b"render-bundle-bytes");
        let bundle_path = guard_render_bundle.path().canonicalize().unwrap();
        let guard_render_src = scratch("render-src");
        let src = guard_render_src.path().canonicalize().unwrap();
        std::fs::write(
            src.join("package.json"),
            r#"{"dependencies": {"void": "1.5.0"}}"#,
        )
        .unwrap();
        let staged = StagedSandbox::stage(
            pool,
            app_id,
            None,
            &stage_inputs(
                json!({"class_name": "S", "scheduling_policy": "durable_object"}),
                &src,
                &bundle_path,
                cap,
            ),
        )
        .await
        .unwrap();
        let source = staged.source.clone();
        // The guards move out: the dirs must outlive the callers' paths.
        (
            staged,
            worker,
            source,
            guard_render_bundle,
            guard_render_src,
        )
    }

    /// The golden render for a registry-image sandbox: name, main, the
    /// `nodejs_compat` flag, both DO bindings with matching migrations,
    /// the three vars, and the moved entry — with the bundle as
    /// `worker.js` and the container timeout armed.
    #[tokio::test]
    async fn golden_render_carries_the_spec_contract() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (staged, worker, source, guard_bundle, guard_src) =
            staged_for_render(&pool, &app.id, 4).await;
        let bundle_path = guard_bundle.path().canonicalize().unwrap();
        let src = guard_src.path().canonicalize().unwrap();
        let (name, _) = ensure_admission_name(&pool, &app.id, None).await.unwrap();
        let pinned = format!("registry.example/x@sha256:{}", "e5".repeat(32));
        let planned = json!({
            "containers": [{
                "name": CONTAINER_NAME,
                "class_name": CONTROLLER_CLASS,
                "image": pinned,
                "max_instances": 4,
            }],
        });
        let rendered = staged.render(&planned, None).unwrap();
        assert_eq!(rendered.script.name, "noite-void-sandbox");
        assert_eq!(rendered.script.main, "worker.js");
        assert_eq!(rendered.secret_vars, &[ADMISSION_NAME_VAR]);
        assert!(rendered.declares_containers);
        assert_eq!(
            rendered.config,
            json!({
                "name": "noite-void-sandbox",
                "main": "worker.js",
                "compatibility_date": "2026-09-01",
                "compatibility_flags": ["nodejs_compat"],
                "durable_objects": {
                    "bindings": [
                        {"name": "SANDBOX", "class_name": "SandboxController"},
                        {"name": "__VOID_SANDBOX_ADMISSION", "class_name": "NoiteSandboxAdmission"},
                    ],
                },
                "migrations": [
                    {"tag": "v1", "new_sqlite_classes": ["SandboxController", "NoiteSandboxAdmission"]},
                ],
                "vars": {
                    "__VOID_SANDBOX_ADMISSION_NAME": name,
                    "__VOID_SANDBOX_MAX_CONCURRENT": "4",
                    "__VOID_SANDBOX_SOURCE": source,
                },
                "containers": [{
                    "name": "noite-void-sandbox-v1",
                    "class_name": "SandboxController",
                    "image": pinned,
                    "max_instances": 4,
                }],
            })
        );
        // The entry is the configured `main`, carried as a runtime source.
        assert_eq!(rendered.extra_sources.len(), 1);
        assert_eq!(rendered.extra_sources[0].path, "worker.js");
        assert_eq!(rendered.extra_sources[0].contents, worker);
        assert!(rendered.extra_hash_input.is_empty());
        // The source var records bundle identity verbatim.
        assert!(
            source.starts_with("void 1.5.0 / bundle sha256:"),
            "{}",
            source
        );
        assert_eq!(source.len(), "void 1.5.0 / bundle sha256:".len() + 64);
        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
    }

    /// The Dockerfile-image golden: the moved entry points at the prepared
    /// file by absolute path, the cap renders as both the var and the
    /// `max_instances` backstop, and the image digest feeds the hash.
    #[tokio::test]
    async fn golden_render_for_a_dockerfile_image() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (staged, _, _, guard_bundle, guard_src) = staged_for_render(&pool, &app.id, 2).await;
        let bundle_path = guard_bundle.path().canonicalize().unwrap();
        let src = guard_src.path().canonicalize().unwrap();
        let pinned = src.join("ctx/.noite-image-0.Dockerfile");
        let planned = json!({
            "containers": [{
                "name": CONTAINER_NAME,
                "class_name": CONTROLLER_CLASS,
                "image": pinned.display().to_string(),
                "max_instances": 2,
            }],
        });
        let digest = [7u8; 32];
        let rendered = staged.render(&planned, Some(digest)).unwrap();
        assert_eq!(
            rendered.config["containers"][0]["image"],
            pinned.display().to_string()
        );
        assert_eq!(rendered.config["containers"][0]["max_instances"], 2);
        assert_eq!(
            rendered.config["vars"]["__VOID_SANDBOX_MAX_CONCURRENT"],
            "2"
        );
        assert_eq!(rendered.extra_hash_input, digest.to_vec());
        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
    }

    /// The content hash is stable, and any bundle, config, admission-name,
    /// image-digest or cap change flips it — including a rotation, which
    /// is what redeploys the controller beside a rotated fleet.
    #[tokio::test]
    async fn content_hash_flips_on_any_render_input() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (staged, _, _, guard_bundle, guard_src) = staged_for_render(&pool, &app.id, 4).await;
        let bundle_path = guard_bundle.path().canonicalize().unwrap();
        let src = guard_src.path().canonicalize().unwrap();
        let planned = json!({
            "containers": [{
                "name": CONTAINER_NAME,
                "class_name": CONTROLLER_CLASS,
                "image": format!("registry.example/x@sha256:{}", "f6".repeat(32)),
                "max_instances": 4,
            }],
        });
        let base = staged.render(&planned, None).unwrap().content_hash();
        assert_eq!(base.len(), 64);
        assert_eq!(staged.render(&planned, None).unwrap().content_hash(), base);

        // A rotated admission name flips the hash through the secret-var
        // substitution (the stored row holds a digest only): another
        // fleet's name over the same bundle and config.
        let env = seed_env(&pool, &app.id).await;
        let (guard_render_rot, _) = bundle_dir("render-rot", b"render-bundle-bytes");
        let other_bundle = guard_render_rot.path().canonicalize().unwrap();
        let guard_render_rot_src = scratch("render-rot-src");
        let other_src = guard_render_rot_src.path().canonicalize().unwrap();
        std::fs::write(
            other_src.join("package.json"),
            r#"{"dependencies": {"void": "1.5.0"}}"#,
        )
        .unwrap();
        let staged_other = StagedSandbox::stage(
            &pool,
            &app.id,
            Some(&env.id),
            &stage_inputs(
                json!({"class_name": "S", "scheduling_policy": "durable_object"}),
                &other_src,
                &other_bundle,
                4,
            ),
        )
        .await
        .unwrap();
        assert_ne!(
            staged_other.render(&planned, None).unwrap().content_hash(),
            base
        );
        std::fs::remove_dir_all(&other_bundle).unwrap();
        std::fs::remove_dir_all(&other_src).unwrap();

        // A bundle change flips it.
        let (guard_render_bundle2, _) = bundle_dir("render-bundle2", b"render-bundle-bytes-2");
        let bundle2 = guard_render_bundle2.path().canonicalize().unwrap();
        let guard_render_src2 = scratch("render-src2");
        let src2 = guard_render_src2.path().canonicalize().unwrap();
        std::fs::write(
            src2.join("package.json"),
            r#"{"dependencies": {"void": "1.5.0"}}"#,
        )
        .unwrap();
        let staged2 = StagedSandbox::stage(
            &pool,
            &app.id,
            None,
            &stage_inputs(
                json!({"class_name": "S", "scheduling_policy": "durable_object"}),
                &src2,
                &bundle2,
                4,
            ),
        )
        .await
        .unwrap();
        assert_ne!(staged2.render(&planned, None).unwrap().content_hash(), base);

        // An image change flips it — through the config for a registry
        // ref, through the digest input for a Dockerfile.
        let mut registry_changed = planned.clone();
        registry_changed["containers"][0]["image"] =
            json!(format!("registry.example/x@sha256:{}", "00".repeat(32)));
        assert_ne!(
            staged
                .render(&registry_changed, None)
                .unwrap()
                .content_hash(),
            base
        );
        assert_ne!(
            staged
                .render(&planned, Some([1u8; 32]))
                .unwrap()
                .content_hash(),
            base
        );
        assert_eq!(
            staged
                .render(&planned, Some([1u8; 32]))
                .unwrap()
                .content_hash(),
            staged
                .render(&planned, Some([1u8; 32]))
                .unwrap()
                .content_hash()
        );

        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
        std::fs::remove_dir_all(&bundle2).unwrap();
        std::fs::remove_dir_all(&src2).unwrap();
    }

    /// The pinned Dockerfile path is per-deploy, not content: two renders
    /// of identical content in different build dirs hash equal, while an
    /// image-content change flips the hash. The deployed config still
    /// carries its own real path — celld builds from it.
    #[tokio::test]
    async fn dockerfile_path_is_not_a_hash_input() {
        let pool = crate::db::connect("sqlite::memory:").await.expect("boot");
        let app = seed(&pool).await;
        let (staged, _, _, guard_bundle, guard_src) = staged_for_render(&pool, &app.id, 4).await;
        let bundle_path = guard_bundle.path().canonicalize().unwrap();
        let src = guard_src.path().canonicalize().unwrap();
        let planned = |dir: &str| {
            json!({
                "containers": [{
                    "name": CONTAINER_NAME,
                    "class_name": CONTROLLER_CLASS,
                    "image": format!("{}/ctx/.noite-image-0.Dockerfile", dir),
                    "max_instances": 4,
                }],
            })
        };
        let digest = [9u8; 32];
        let first = staged
            .render(
                &planned("/data/runner/builds/blog/2026-11-03t120000z"),
                Some(digest),
            )
            .unwrap();
        let second = staged
            .render(
                &planned("/data/runner/builds/blog/2026-11-03t121500z"),
                Some(digest),
            )
            .unwrap();
        assert_eq!(first.content_hash(), second.content_hash());
        assert_ne!(
            first.config["containers"][0]["image"],
            second.config["containers"][0]["image"]
        );
        assert_ne!(
            staged
                .render(
                    &planned("/data/runner/builds/blog/2026-11-03t121500z"),
                    Some([10u8; 32])
                )
                .unwrap()
                .content_hash(),
            first.content_hash()
        );
        std::fs::remove_dir_all(&bundle_path).unwrap();
        std::fs::remove_dir_all(&src).unwrap();
    }

    /// The Dockerfile image digest is stable and flips on either input:
    /// the pinned Dockerfile bytes or the build-context digest.
    #[test]
    fn dockerfile_image_digest_pins_both_inputs() {
        let guard_img_digest = scratch("img-digest");
        let dir = guard_img_digest.path().canonicalize().unwrap();
        std::fs::write(dir.join("pinned.Dockerfile"), "FROM x@sha256:aaa\n").unwrap();
        let pinned = dir.join("pinned.Dockerfile");
        let first = dockerfile_image_digest(&pinned, &[1u8; 32]).unwrap();
        assert_eq!(dockerfile_image_digest(&pinned, &[1u8; 32]).unwrap(), first);
        assert_ne!(dockerfile_image_digest(&pinned, &[2u8; 32]).unwrap(), first);
        std::fs::write(dir.join("pinned.Dockerfile"), "FROM x@sha256:bbb\n").unwrap();
        assert_ne!(dockerfile_image_digest(&pinned, &[1u8; 32]).unwrap(), first);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Deploy order, constant-level: the controller sorts before the proxy
    /// (the cohost mechanism deploys lowest order first, covered there).
    /// A violation fails the build, not the test run.
    #[test]
    fn controller_sorts_before_the_proxy() {
        assert_eq!(SANDBOX_SCRIPT.name, "noite-void-sandbox");
        assert_eq!(SANDBOX_SCRIPT.main, "worker.js");
        assert_eq!(SANDBOX_SCRIPT.order, SANDBOX_ORDER);
        const {
            assert!(SANDBOX_ORDER < crate::host::void_proxy::PROXY_ORDER);
        }
    }
}
