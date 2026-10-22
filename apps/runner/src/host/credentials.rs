//! Scoped fleet credentials (SPEC, Scoped credentials).
//!
//! Model: every tenant scope gets keys that can read, write and list only
//! its own prefix — `fleets/{slug}/` for an app, `envs/{slug}/{label}/` for
//! a preview environment — so an environment's keys never reach
//! production's and no fleet reaches another app's. The runner keeps the root
//! keys for its own work (deploys, purges, renames, telemetry, snapshots).
//!
//! Where the keys come from is [`Credentials`], resolved once at boot from
//! `NOITE_CREDENTIAL_PROVIDER`:
//!
//! - **scoped**: a [`CredentialProvider`] mints one key per scope through
//!   the store's own IAM ([`MinioAdmin`] for MinIO and RustFS, [`AwsIam`]
//!   for AWS).
//! - **root**: no provider. Fleets keep the root keys exactly as before and
//!   release commands run only in `single` tenancy. Explicit, surfaced in
//!   the boot log, `/ready`, the isolation status and `make doctor`.
//!
//! Lifecycle: a key is minted lazily by [`ensure`] the first time a scope
//! needs one (app create, its first fleet spawn or deploy — an install that
//! predates this gets its keys with no manual step) and superseded when the
//! scope's prefix moves (rename), the store changes, or the row no longer
//! decrypts. A key is never deleted in place: it is marked `revoking` and
//! [`sweep`] deletes it at the store, retrying until the store accepts. A
//! scope whose prefix still has an unrevoked key refuses to mint, so a
//! recreated slug never shares a prefix with a key that outlived its app.
//!
//! Two consumers, two rules:
//! - **Tenant processes** (release scripts run tenant code with the key in
//!   their env): scoped keys; root keys only with `NOITE_TENANCY=single`.
//!   See [`tenant_process_credentials`].
//! - **Fleets** (celld holds the key in its own process; Worker code cannot
//!   read the process env): the scope's own key, else root in `root` mode.
//!   See [`fleet_credentials`].
//!
//! Rows are AES-256-GCM under a key derived from `RUNNER_TOKEN` (HKDF) with
//! the scope as associated data, so the bucket snapshot is not a key dump
//! and a row copied onto another scope does not decrypt.

#[path = "credentials_aws.rs"]
mod aws;
#[path = "credentials_minio.rs"]
mod minio;

use std::sync::Arc;

use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use futures::future::BoxFuture;
use hkdf::Hkdf;
use sha2::Sha256;

use crate::config::{Config, Tenancy};
use crate::db;
use crate::models::{App, Environment};

pub use aws::AwsIam;
pub use minio::MinioAdmin;

/// One key pair handed to a fleet or a release command.
#[derive(Clone, PartialEq, Eq)]
pub struct AppCredentials {
    pub access_key: String,
    pub secret_key: String,
}

/// Secrets never reach logs: a `Debug` that printed the secret would leak it
/// through any `{:?}` on a fleet spec, deploy error or test failure.
impl std::fmt::Debug for AppCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppCredentials")
            .field("access_key", &self.access_key)
            .field("secret_key", &"[redacted]")
            .finish()
    }
}

/// A key a provider just created. `handle` is what
/// [`CredentialProvider::revoke`] needs to delete it (the IAM user name, the
/// service account's access key).
#[derive(Clone)]
pub struct MintedKey {
    pub handle: String,
    pub access_key: String,
    pub secret_key: String,
}

impl std::fmt::Debug for MintedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MintedKey")
            .field("handle", &self.handle)
            .field("access_key", &self.access_key)
            .field("secret_key", &"[redacted]")
            .finish()
    }
}

/// The store's own IAM: creates and deletes keys limited to one prefix,
/// lists the principals this runner manages for the orphan sweep, and
/// carries the install tag that keeps two installs sharing a store (or an
/// AWS account) from revoking each other's live keys.
pub trait CredentialProvider: Send + Sync {
    /// Short name for status lines and the stored row (`rustfs`, `minio`, `aws`).
    fn name(&self) -> &'static str;
    /// This install's tag ([`install_tag`]): minting stamps it into every
    /// principal (the IAM path and user name on AWS, the canned-policy name
    /// on MinIO/RustFS) and listing requires it back, so a principal minted
    /// by another install — or by this install before tags existed — never
    /// matches. It is not secret.
    fn install_tag(&self) -> &str;
    /// A new key that can read, write and list only `prefix` (it ends with
    /// `/`) in `bucket`: see [`prefix_policy`].
    fn mint<'a>(
        &'a self,
        bucket: &'a str,
        prefix: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<MintedKey>>;
    /// Delete the key `handle` names. A key that is already gone is success.
    /// Takes the handle as minted (old-format handles included): revoke,
    /// rename and delete paths work by handle for keys minted before tags.
    fn revoke<'a>(&'a self, handle: &'a str) -> BoxFuture<'a, anyhow::Result<()>>;
    /// Whether `handle` names a principal this runner could have minted
    /// (name/shape check only — the install binding lives where the listing
    /// returns it: the IAM path on AWS, the attached policy on MinIO).
    /// The orphan sweep revokes only these — never foreign users or the
    /// operator's own keys, even when the listing returns them.
    fn manages(&self, handle: &str) -> bool;
    /// Every managed principal currently at the store, each already
    /// install-bound (path on AWS, attached policy on MinIO): anything else
    /// the store returns is excluded here, not revoked. A listing failure
    /// surfaces as `Err` so the sweep revokes nothing (fail-safe).
    fn list_managed<'a>(&'a self) -> BoxFuture<'a, anyhow::Result<Vec<String>>>;
}

/// The IAM policy every provider attaches: objects under `prefix` (including
/// multipart completion on them), listings only with a `prefix` condition
/// inside them (including in-progress multipart uploads), and the bucket's
/// location (SDKs ask for it). No bucket-wide listing and no HEAD on the
/// bucket: both would reveal other apps' key names.
pub fn prefix_policy(bucket: &str, prefix: &str) -> String {
    serde_json::json!({
        "Version": "2012-10-17",
        "Statement": [
            {
                "Action": [
                    "s3:GetObject",
                    "s3:PutObject",
                    "s3:DeleteObject",
                    "s3:AbortMultipartUpload",
                    "s3:ListMultipartUploadParts",
                    "s3:CompleteMultipartUpload",
                ],
                "Effect": "Allow",
                "Resource": [format!("arn:aws:s3:::{bucket}/{prefix}*")],
                "Sid": "PrefixObjects",
            },
            {
                "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
                "Condition": {"StringLike": {"s3:prefix": [format!("{prefix}*")]}},
                "Effect": "Allow",
                "Resource": [format!("arn:aws:s3:::{bucket}")],
                "Sid": "PrefixList",
            },
            {
                "Action": ["s3:GetBucketLocation"],
                "Effect": "Allow",
                "Resource": [format!("arn:aws:s3:::{bucket}")],
                "Sid": "BucketLocation",
            },
        ],
    })
    .to_string()
}

/// `NOITE_CREDENTIAL_PROVIDER`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderSetting {
    /// The bundled RustFS is scoped; any other store is probed at boot for
    /// the MinIO admin API (MinIO, RustFS); AWS and R2 stay on root keys.
    Auto,
    Root,
    Minio,
    Aws,
}

impl ProviderSetting {
    /// Unset or blank is `auto`; anything unknown is a boot problem.
    pub fn parse(raw: Option<&str>, problems: &mut Vec<String>) -> Self {
        match raw.map(str::trim).filter(|v| !v.is_empty()) {
            None | Some("auto") => Self::Auto,
            Some("root") => Self::Root,
            Some("minio") => Self::Minio,
            Some("aws") => Self::Aws,
            Some(other) => {
                problems.push(format!(
                    "NOITE_CREDENTIAL_PROVIDER must be auto, minio, aws or root, got {other:?}"
                ));
                Self::Auto
            }
        }
    }
}

/// The image's own store: its root keys are the bundled RustFS admin.
pub const BUNDLED_ENDPOINT: &str = "http://rustfs:9000";

/// Root S3 access the providers act with.
#[derive(Clone)]
pub struct StoreAccess {
    pub endpoint: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
}

impl StoreAccess {
    pub fn from_config(cfg: &Config) -> Self {
        Self {
            endpoint: cfg.s3_endpoint.clone(),
            region: cfg.aws_region.clone(),
            access_key: cfg.aws_access_key_id.clone(),
            secret_key: cfg.aws_secret_access_key.clone(),
        }
    }
}

/// Where tenant keys come from, resolved from [`ProviderSetting`].
#[derive(Clone)]
pub enum Credentials {
    /// Fleets and (`single` only) release commands hold the root keys.
    Root { reason: String },
    /// One key per scope from the store's IAM.
    Scoped(Arc<dyn CredentialProvider>),
    /// `auto` against an unknown store: boot probes it with [`detect`] once
    /// the bucket answers, before any fleet spawns.
    Detect,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary())
    }
}

fn endpoint_host(endpoint: &str) -> String {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default()
}

impl Credentials {
    /// Resolve the setting from configuration alone; only `auto` against an
    /// unknown store is left to [`detect`]. `bucket` feeds the install tag:
    /// the tag must survive DB loss, so it derives from the configured
    /// store, never from a row.
    pub fn configure(setting: ProviderSetting, store: &StoreAccess, bucket: &str) -> Self {
        let host = endpoint_host(&store.endpoint);
        match setting {
            ProviderSetting::Root => Self::Root {
                reason: "NOITE_CREDENTIAL_PROVIDER=root".into(),
            },
            ProviderSetting::Minio => {
                Self::Scoped(Arc::new(MinioAdmin::minio(store.clone(), bucket)))
            }
            ProviderSetting::Aws => Self::Scoped(Arc::new(AwsIam::new(store.clone(), bucket))),
            ProviderSetting::Auto if store.endpoint.trim_end_matches('/') == BUNDLED_ENDPOINT => {
                Self::Scoped(Arc::new(MinioAdmin::rustfs(store.clone(), bucket)))
            }
            ProviderSetting::Auto if host.ends_with(".r2.cloudflarestorage.com") => Self::Root {
                reason: "Cloudflare R2 has no long-lived prefix-scoped keys; \
                    see the operator docs for the bucket-per-app alternative"
                    .into(),
            },
            ProviderSetting::Auto
                if host.ends_with(".amazonaws.com") || host == "amazonaws.com" =>
            {
                Self::Root {
                    reason: "AWS S3 needs NOITE_CREDENTIAL_PROVIDER=aws and an IAM-capable key"
                        .into(),
                }
            }
            ProviderSetting::Auto => Self::Detect,
        }
    }

    pub fn is_scoped(&self) -> bool {
        matches!(self, Self::Scoped(_))
    }

    /// One line for logs, `/ready` and doctor: `scoped (rustfs)` or
    /// `root (<why>)`.
    pub fn summary(&self) -> String {
        match self {
            Self::Root { reason } => format!("root ({reason})"),
            Self::Scoped(provider) => format!("scoped ({})", provider.name()),
            Self::Detect => "undetected".into(),
        }
    }
}

/// `auto` against an unknown store: does it speak the MinIO admin API with
/// these keys? Yes → scoped through it; a definite no → root with the
/// reason. Keys the store refuses fail the boot instead of silently
/// downgrading every fleet to root, because the answer decides what every
/// fleet holds.
pub async fn detect(store: &StoreAccess, bucket: &str) -> anyhow::Result<Credentials> {
    let admin = MinioAdmin::minio(store.clone(), bucket);
    match admin.probe().await? {
        Ok(()) => Ok(Credentials::Scoped(Arc::new(admin))),
        Err(why) => Ok(Credentials::Root {
            reason: format!("{} answers no MinIO admin API ({why})", store.endpoint),
        }),
    }
}

/// One tenant scope: what a key is minted for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    App {
        app_id: String,
        slug: String,
    },
    Environment {
        env_id: String,
        app_id: String,
        slug: String,
        label: String,
    },
}

impl Scope {
    pub fn app(app: &App) -> Self {
        Self::App {
            app_id: app.id.clone(),
            slug: app.slug.clone(),
        }
    }

    pub fn environment(env: &Environment) -> Self {
        Self::Environment {
            env_id: env.id.clone(),
            app_id: env.app_id.clone(),
            slug: env.app_slug.clone(),
            label: env.label.clone(),
        }
    }

    /// Row key and the ciphertext's associated data.
    pub fn key(&self) -> String {
        match self {
            Self::App { app_id, .. } => format!("app:{app_id}"),
            Self::Environment { env_id, .. } => format!("env:{env_id}"),
        }
    }

    pub fn app_id(&self) -> &str {
        match self {
            Self::App { app_id, .. } | Self::Environment { app_id, .. } => app_id,
        }
    }

    /// The bucket prefix the key reaches, matching `Config::fleets_uri` and
    /// `Config::envs_uri`. The trailing `/` keeps `fleets/a/` off
    /// `fleets/ab/`.
    pub fn prefix(&self) -> String {
        match self {
            Self::App { slug, .. } => format!("fleets/{slug}/"),
            Self::Environment { slug, label, .. } => format!("envs/{slug}/{label}/"),
        }
    }
}

fn kek(runner_token: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, runner_token.as_bytes())
        .expand(b"noite-app-credential-v1", &mut out)
        .expect("hkdf expand");
    out
}

fn encrypt(runner_token: &str, aad: &str, plaintext: &str) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new_from_slice(&kek(runner_token))?;
    // Random 96-bit nonce per row: GCM breaks outright on a repeated
    // (key, nonce) pair, and every row shares one key.
    let mut nonce_bytes = [0u8; 12];
    use rand::TryRng;
    rand::rngs::SysRng
        .try_fill_bytes(&mut nonce_bytes)
        .map_err(|e| anyhow::anyhow!("os randomness: {e}"))?;
    let ct = cipher
        .encrypt(
            &Nonce::from(nonce_bytes),
            Payload {
                aad: aad.as_bytes(),
                msg: plaintext.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("credential encrypt failed"))?;
    Ok((nonce_bytes.to_vec(), ct))
}

fn decrypt(runner_token: &str, aad: &str, nonce: &[u8], ct: &[u8]) -> anyhow::Result<String> {
    let key = kek(runner_token);
    let cipher = Aes256Gcm::new_from_slice(&key)?;
    let nonce =
        Nonce::try_from(nonce).map_err(|_| anyhow::anyhow!("credential nonce is not 96-bit"))?;
    let pt = cipher
        .decrypt(
            &nonce,
            Payload {
                aad: aad.as_bytes(),
                msg: ct,
            },
        )
        .map_err(|_| anyhow::anyhow!("credential decrypt failed"))?;
    Ok(String::from_utf8(pt)?)
}

/// This install's tag: a short, stable hash of the configured store (the S3
/// endpoint identity plus the bucket name; for AWS the bucket and region,
/// which the endpoint already carries). Computed at boot from configuration
/// alone so it survives DB loss — the sweep exists because the DB can be
/// lost, so the tag must never live in a row. It is not secret: it appears
/// in IAM paths and user names, policy names, `/ready` and doctor output.
///
/// Minting stamps the tag into every principal and listing requires it back,
/// so two installs sharing a store (or an AWS account) never match each
/// other's live keys. Keys minted before tags (alpha.8) carry no tag and
/// never match: the safe direction — the sweep never revokes them, while
/// revoke/rename/delete by handle keep working for them.
///
/// Spelling never re-tags one store: surrounding whitespace, case, a
/// trailing slash and the scheme's default port (`:80`, `:443`) are
/// normalized away. A real endpoint, bucket or region change does change
/// the tag. Old keys then read as foreign (never revoked by the sweep);
/// point the install back or delete them at the store by hand.
pub fn install_tag(endpoint: &str, bucket: &str, region: &str) -> String {
    use sha2::Digest;
    let lowered = endpoint.trim().trim_end_matches('/').to_ascii_lowercase();
    let normalized = if let Some(host) = lowered.strip_prefix("http://") {
        format!("http://{}", host.strip_suffix(":80").unwrap_or(host))
    } else if let Some(host) = lowered.strip_prefix("https://") {
        format!("https://{}", host.strip_suffix(":443").unwrap_or(host))
    } else {
        lowered
    };
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hasher.update(b"|");
    hasher.update(bucket.trim().as_bytes());
    hasher.update(b"|");
    hasher.update(region.trim().to_ascii_lowercase().as_bytes());
    let digest = hasher.finalize();
    hex_encode(&digest)[..8].to_string()
}

/// Which store a key lives in: a key minted against another provider,
/// endpoint or bucket is not one this runner can use or revoke.
fn store_id(cfg: &Config, provider: &dyn CredentialProvider) -> String {
    format!(
        "{}|{}|{}",
        provider.name(),
        cfg.s3_endpoint.trim_end_matches('/'),
        cfg.s3_bucket
    )
}

fn root_keys(cfg: &Config) -> AppCredentials {
    AppCredentials {
        access_key: cfg.aws_access_key_id.clone(),
        secret_key: cfg.aws_secret_access_key.clone(),
    }
}

/// Serializes every mint and revoke: two callers ensuring one scope at once
/// (a fleet spawn racing a deploy) would otherwise mint two keys for it.
/// The orphan sweep relies on this too: an in-flight mint holds `MUTATE`
/// until its row commits, so waiting for the lock is the fence that keeps a
/// half-minted key from reading as orphaned.
///
/// `MUTATE` is per-process: the sweep assumes a single runner owns the DB
/// (the `owner.json` fence in SPEC, Runner state). Two runners sharing one
/// SQLite file would break the in-flight guarantee.
static MUTATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn unresolved() -> anyhow::Error {
    anyhow::anyhow!(
        "credential provider not resolved (NOITE_CREDENTIAL_PROVIDER=auto needs the boot probe)"
    )
}

/// Keys for a tenant fleet's celld: the scope's own key, or the root keys
/// when the install runs the `root` provider.
pub async fn fleet_credentials(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    scope: &Scope,
) -> anyhow::Result<AppCredentials> {
    match &cfg.credentials {
        Credentials::Scoped(provider) => ensure(pool, cfg, provider.as_ref(), scope).await,
        Credentials::Root { .. } => Ok(root_keys(cfg)),
        Credentials::Detect => Err(unresolved()),
    }
}

/// Keys for a process that runs tenant code (the release command): the
/// scope's own key; root keys only in `single` tenancy. `None` = no safe key
/// exists and the caller must not run the tenant process with bucket access.
pub async fn tenant_process_credentials(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    scope: &Scope,
) -> anyhow::Result<Option<AppCredentials>> {
    match &cfg.credentials {
        Credentials::Scoped(provider) => {
            ensure(pool, cfg, provider.as_ref(), scope).await.map(Some)
        }
        Credentials::Root { .. } if cfg.tenancy == Tenancy::Single => Ok(Some(root_keys(cfg))),
        Credentials::Root { .. } => Ok(None),
        Credentials::Detect => Err(unresolved()),
    }
}

/// The scope's live key, minting one when it has none that fits.
async fn ensure(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    provider: &dyn CredentialProvider,
    scope: &Scope,
) -> anyhow::Result<AppCredentials> {
    let scope_key = scope.key();
    let prefix = scope.prefix();
    let store = store_id(cfg, provider);
    let _guard = MUTATE.lock().await;
    if let Some(row) = db::live_scoped_credential(pool, &scope_key).await? {
        if row.prefix == prefix && row.store == store {
            match decrypt(&cfg.runner_token, &scope_key, &row.nonce, &row.ciphertext)
                .and_then(|json| Ok(serde_json::from_str::<StoredKey>(&json)?))
            {
                Ok(key) => {
                    return Ok(AppCredentials {
                        access_key: key.access_key,
                        secret_key: key.secret_key,
                    });
                }
                // RUNNER_TOKEN rotated: the handle is plaintext, so the old
                // key is still revocable even though its secret is lost.
                Err(e) => tracing::warn!(
                    scope = %scope_key,
                    error = %format!("{e:#}"),
                    "stored scoped key does not decrypt; minting a new one"
                ),
            }
        }
        // Moved prefix (rename), another store, or unreadable: supersede.
        db::mark_scoped_credential_revoking(pool, &row.handle).await?;
    }
    // A key that still reaches this prefix must be gone before a new owner
    // gets the prefix: a slug or label reused after a delete would otherwise
    // share its data with whoever kept the old key.
    for pending in db::revoking_scoped_credentials(pool).await? {
        if pending.prefix == prefix && pending.store == store {
            revoke_row(pool, provider, &pending).await.map_err(|e| {
                anyhow::anyhow!(
                    "a previous key for {prefix} is not revoked yet, so no new key is minted: {e:#}"
                )
            })?;
        }
    }
    let minted = provider
        .mint(&cfg.s3_bucket, &prefix)
        .await
        .map_err(|e| anyhow::anyhow!("mint scoped bucket key for {prefix}: {e:#}"))?;
    // The write path never stores root keys: a provider that handed them back
    // would silently undo the isolation this exists for.
    if minted.access_key == cfg.aws_access_key_id {
        let _ = provider.revoke(&minted.handle).await;
        anyhow::bail!(
            "{} returned the root access key for {prefix}",
            provider.name()
        );
    }
    let json = serde_json::to_string(&StoredKey {
        access_key: minted.access_key.clone(),
        secret_key: minted.secret_key.clone(),
    })?;
    let (nonce, ciphertext) = encrypt(&cfg.runner_token, &scope_key, &json)?;
    let row = db::NewScopedCredential {
        app_id: scope.app_id(),
        ciphertext: &ciphertext,
        handle: &minted.handle,
        nonce: &nonce,
        prefix: &prefix,
        scope: &scope_key,
        store: &store,
    };
    if let Err(e) = db::insert_scoped_credential(pool, &row).await {
        // Unrecorded, the key could never be revoked: delete it now.
        if let Err(revoke) = provider.revoke(&minted.handle).await {
            tracing::error!(
                handle = %minted.handle,
                prefix = %prefix,
                error = %format!("{revoke:#}"),
                "minted a scoped key that could not be stored or revoked; delete it at the store"
            );
        }
        return Err(e.into());
    }
    tracing::info!(scope = %scope_key, prefix = %prefix, provider = provider.name(), "minted scoped bucket key");
    Ok(AppCredentials {
        access_key: minted.access_key,
        secret_key: minted.secret_key,
    })
}

#[derive(serde::Deserialize, serde::Serialize)]
struct StoredKey {
    access_key: String,
    secret_key: String,
}

async fn revoke_row(
    pool: &sqlx::SqlitePool,
    provider: &dyn CredentialProvider,
    row: &db::ScopedCredential,
) -> anyhow::Result<()> {
    provider.revoke(&row.handle).await?;
    db::delete_scoped_credential(pool, &row.handle).await?;
    tracing::info!(scope = %row.scope, app_id = %row.app_id, prefix = %row.prefix, "revoked scoped bucket key");
    Ok(())
}

/// Revoke every key of one app: its own and its environments'. Delete and
/// rename (whose prefixes moved) call it; the next spawn mints fresh keys.
/// The rows are marked first, so nothing hands the keys out again even when
/// the store refuses the delete; [`sweep`] retries those.
pub async fn revoke_app(pool: &sqlx::SqlitePool, cfg: &Config, app_id: &str) -> anyhow::Result<()> {
    db::mark_app_scoped_credentials_revoking(pool, app_id).await?;
    sweep(pool, cfg).await;
    Ok(())
}

/// Revoke one environment's key (its teardown).
pub async fn revoke_environment(
    pool: &sqlx::SqlitePool,
    cfg: &Config,
    env_id: &str,
) -> anyhow::Result<()> {
    if let Some(row) = db::live_scoped_credential(pool, &format!("env:{env_id}")).await? {
        db::mark_scoped_credential_revoking(pool, &row.handle).await?;
    }
    sweep(pool, cfg).await;
    Ok(())
}

/// Delete every key marked `revoking` at the store. A failure stays marked
/// and is retried on the next pass. Returns how many are still pending.
pub async fn sweep(pool: &sqlx::SqlitePool, cfg: &Config) -> usize {
    let pending = match db::revoking_scoped_credentials(pool).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!(error = %e, "list pending key revocations");
            return 0;
        }
    };
    if pending.is_empty() {
        return 0;
    }
    let Credentials::Scoped(provider) = &cfg.credentials else {
        tracing::warn!(
            pending = pending.len(),
            mode = %cfg.credentials.summary(),
            "scoped keys are awaiting revocation but no provider is configured to delete them"
        );
        return pending.len();
    };
    let store = store_id(cfg, provider.as_ref());
    let _guard = MUTATE.lock().await;
    let mut left = 0;
    for row in pending {
        if row.store != store {
            // Minted in a store this runner no longer administers: nothing
            // here can delete it, and keeping the row would retry forever.
            tracing::warn!(
                handle = %row.handle,
                store = %row.store,
                "dropping a scoped key minted in another store; delete it there by hand"
            );
            if let Err(e) = db::delete_scoped_credential(pool, &row.handle).await {
                tracing::warn!(error = %e, "drop foreign scoped key row");
            }
            continue;
        }
        if let Err(e) = revoke_row(pool, provider.as_ref(), &row).await {
            left += 1;
            tracing::warn!(
                scope = %row.scope,
                prefix = %row.prefix,
                error = %format!("{e:#}"),
                "scoped key revocation failed; retrying on the next sweep"
            );
        }
    }
    left
}

/// What one orphan pass found. Returned (not just logged) so tests assert
/// the outcome without reading process-global status.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OrphanSweepReport {
    /// Principals the store listed as managed by this runner.
    pub listed: usize,
    /// Of those, revoked because no `scoped_credential` row names them.
    pub revoked: usize,
    /// The listing (or DB read) failure, when the store could not be read.
    /// Set means nothing was revoked.
    pub error: Option<String>,
}

/// Last orphan-pass outcome for `/ready` and `make doctor`.
#[derive(Clone, Debug)]
struct OrphanSweepStatus {
    last_run: Option<std::time::SystemTime>,
    revoked_total: u64,
    last_error: Option<String>,
    install_tag: Option<String>,
}

static ORPHAN_SWEEP_STATUS: std::sync::Mutex<OrphanSweepStatus> =
    std::sync::Mutex::new(OrphanSweepStatus {
        last_run: None,
        revoked_total: 0,
        last_error: None,
        install_tag: None,
    });

/// `/ready` shows the error, which echoes store status text: bound its
/// length so one hostile or verbose store reply cannot bloat the status.
const MAX_SWEEP_ERROR_LEN: usize = 300;

fn truncate_sweep_error(raw: &str) -> String {
    if raw.len() <= MAX_SWEEP_ERROR_LEN {
        return raw.to_string();
    }
    let mut end = MAX_SWEEP_ERROR_LEN;
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &raw[..end])
}

fn note_orphan_sweep(report: &OrphanSweepReport, install_tag: Option<&str>) {
    if let Ok(mut status) = ORPHAN_SWEEP_STATUS.lock() {
        status.last_run = Some(std::time::SystemTime::now());
        status.revoked_total += report.revoked as u64;
        status.last_error = report.error.clone().map(|e| truncate_sweep_error(&e));
        if let Some(tag) = install_tag {
            status.install_tag = Some(tag.to_string());
        }
    }
}

/// Additive `/ready` surface for the orphan pass: the install tag (absent
/// before the first scoped pass), seconds since the last run (absent before
/// the first), total orphans revoked, and the last listing error, if any.
pub fn orphan_sweep_status() -> serde_json::Value {
    let (ago, total, error, tag) = match ORPHAN_SWEEP_STATUS.lock() {
        Ok(status) => (
            status
                .last_run
                .and_then(|at| at.elapsed().ok())
                .map(|age| age.as_secs()),
            status.revoked_total,
            status.last_error.clone(),
            status.install_tag.clone(),
        ),
        Err(_) => (None, 0, None, None),
    };
    serde_json::json!({
        "install_tag": tag,
        "last_secs_ago": ago,
        "revoked_total": total,
        "last_error": error,
    })
}

/// The orphan pass runs at boot (no pass yet) and then every `interval`.
/// `now` is a parameter so tests inject the clock instead of sleeping.
pub fn orphan_sweep_due(
    last: Option<std::time::Instant>,
    now: std::time::Instant,
    interval: std::time::Duration,
) -> bool {
    last.is_none_or(|at| now.saturating_duration_since(at) >= interval)
}

/// Reconcile the store against the DB: revoke every managed principal with
/// no `scoped_credential` row (live or revoking) — the orphans a crash in
/// the snapshot loss window (or any DB loss) leaves behind, which [`sweep`]
/// can never see because it only acts on rows.
///
/// Safety, in order:
/// - the store listing runs without `MUTATE`: holding the mint lock across
///   network I/O would stall every fleet spawn and deploy for the whole
///   pass. Each candidate is fenced instead — take `MUTATE`, re-check that
///   no row names it, revoke that one key, release — so a key being minted
///   (no row committed yet) can never be judged orphaned: an in-flight mint
///   holds `MUTATE` until its row commits, so waiting for the lock is the
///   fence;
/// - revokes only install-bound principals the listing returns (tag in the
///   IAM path and name on AWS, in the attached policy on MinIO/RustFS),
///   never foreign principals or the operator's keys;
/// - a listing or bulk DB failure revokes nothing and records the error for
///   `/ready` and `make doctor` (fail-safe); a per-key row re-check failure
///   skips that key for this pass (leak, retried next pass — never a
///   wrong revoke).
///
/// Rows minted in another store keep [`sweep`]'s handling: any row, in any
/// store, protects its handle.
///
/// Assumes one runner owns the DB (see `MUTATE`): `MUTATE` is per-process.
pub async fn orphan_sweep(pool: &sqlx::SqlitePool, cfg: &Config) -> OrphanSweepReport {
    let Credentials::Scoped(provider) = &cfg.credentials else {
        static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            tracing::info!(
                mode = %cfg.credentials.summary(),
                "no orphan credential sweep: only scoped stores list their principals"
            );
        }
        let report = OrphanSweepReport::default();
        note_orphan_sweep(&report, None);
        return report;
    };
    let install_tag = provider.install_tag().to_string();
    let listed = match provider.list_managed().await {
        Ok(handles) => handles,
        Err(e) => {
            let report = OrphanSweepReport {
                listed: 0,
                revoked: 0,
                error: Some(format!("{e:#}")),
            };
            tracing::warn!(
                error = %format!("{e:#}"),
                "orphan credential listing failed; revoking nothing"
            );
            note_orphan_sweep(&report, Some(&install_tag));
            return report;
        }
    };
    let known = match db::all_scoped_credential_handles(pool).await {
        Ok(handles) => handles,
        Err(e) => {
            let report = OrphanSweepReport {
                listed: listed.len(),
                revoked: 0,
                error: Some(format!("{e:#}")),
            };
            tracing::warn!(
                error = %format!("{e:#}"),
                "orphan credential sweep could not read its rows; revoking nothing"
            );
            note_orphan_sweep(&report, Some(&install_tag));
            return report;
        }
    };
    let known: std::collections::HashSet<&str> = known.iter().map(String::as_str).collect();
    let mut revoked = 0;
    for handle in &listed {
        if !provider.manages(handle) || known.contains(handle.as_str()) {
            continue;
        }
        let _guard = MUTATE.lock().await;
        match db::scoped_credential_handle_exists(pool, handle).await {
            Ok(true) => continue,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(
                    handle = %handle,
                    error = %e,
                    "orphan sweep could not re-check the row; skipping this key"
                );
                continue;
            }
        }
        match provider.revoke(handle).await {
            Ok(()) => {
                revoked += 1;
                tracing::info!(handle = %handle, "revoked orphan scoped bucket key");
            }
            Err(e) => {
                tracing::warn!(
                    handle = %handle,
                    error = %format!("{e:#}"),
                    "orphan key revocation failed; retrying on the next sweep"
                );
            }
        }
    }
    let report = OrphanSweepReport {
        listed: listed.len(),
        revoked,
        error: None,
    };
    note_orphan_sweep(&report, Some(&install_tag));
    report
}

/// SigV4-sign one store request, as one struct instead of eleven
/// parameters. Shared by the MinIO admin API (service `s3`) and the AWS IAM
/// API (service `iam`): both take the canonical
/// `METHOD\nuri\nsorted-query\nheaders\nsigned-headers\npayload-hash` form
/// over the same HMAC chain.
pub struct SigV4<'a> {
    pub method: &'a str,
    pub uri: &'a str,
    pub query: &'a str,
    pub host: &'a str,
    pub region: &'a str,
    pub service: &'a str,
    pub access_key: &'a str,
    pub secret_key: &'a str,
    pub payload_hash: &'a str,
    pub amz_date: &'a str,
    pub date_stamp: &'a str,
}

impl SigV4<'_> {
    pub fn authorization(&self) -> String {
        use hmac::{Hmac, KeyInit, Mac};
        use sha2::{Digest, Sha256};
        let mut parts: Vec<&str> = self.query.split('&').filter(|p| !p.is_empty()).collect();
        parts.sort_unstable();
        let canonical = format!(
            "{}\n{}\n{}\nhost:{}\nx-amz-date:{}\n\nhost;x-amz-date\n{}",
            self.method,
            self.uri,
            parts.join("&"),
            self.host,
            self.amz_date,
            self.payload_hash
        );
        let scope = format!(
            "{}/{}/{}/aws4_request",
            self.date_stamp, self.region, self.service
        );
        let to_sign = format!(
            "AWS4-HMAC-SHA256\n{}\n{}\n{}",
            self.amz_date,
            scope,
            hex_encode(Sha256::digest(canonical.as_bytes()).as_slice())
        );
        let mac = |key: &[u8], msg: &str| {
            let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("hmac key");
            Mac::update(&mut m, msg.as_bytes());
            Mac::finalize(m).into_bytes().to_vec()
        };
        let mut key = mac(
            format!("AWS4{}", self.secret_key).as_bytes(),
            self.date_stamp,
        );
        for s in [self.region, self.service, "aws4_request"] {
            key = mac(&key, s);
        }
        let signature = hex_encode(&mac(&key, &to_sign));
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders=host;x-amz-date, Signature={signature}",
            self.access_key, scope
        )
    }
}

/// Hex digests without a new dependency.
pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// Current UTC time formatted for SigV4 (`amz_date`, `date_stamp`).
pub fn sigv4_now() -> (String, String) {
    let now = chrono::Utc::now();
    (
        now.format("%Y%m%dT%H%M%SZ").to_string(),
        now.format("%Y%m%d").to_string(),
    )
}

/// Random alphanumeric string for generated access/secret keys (MinIO wants
/// 8–40 chars; keys start with a letter so no store mistakes one for a
/// number).
pub fn random_key(len: usize) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut bytes = vec![0u8; len];
    use rand::TryRng;
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("os randomness");
    let mut out = String::with_capacity(len);
    out.push((b'a' + bytes[0] % 26) as char);
    for b in &bytes[1..] {
        out.push(CHARSET[(b % 62) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests;
