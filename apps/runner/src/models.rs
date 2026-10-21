use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use uuid::Uuid;

use crate::host::git_identity::Actor;

/// Operator intent: only running|stopped. Removal is hard DELETE, not a state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DesiredState {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "stopped")]
    Stopped,
}

impl DesiredState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }
}

/// Observed app status written by deploy / reconcile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppStatus {
    #[serde(rename = "provisioned")]
    Provisioned,
    #[serde(rename = "building")]
    Building,
    #[serde(rename = "deploying")]
    Deploying,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "failed")]
    Failed,
    /// Deployed and desired running, but its fleet is stopped until the next
    /// request (SPEC, Scale to zero).
    #[serde(rename = "sleeping")]
    Sleeping,
    /// A background GitHub/template import is still running (A2); flips to
    /// `provisioned` (then the deploy pipeline takes over) or `error`.
    #[serde(rename = "importing")]
    Importing,
}

impl AppStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Provisioned => "provisioned",
            Self::Building => "building",
            Self::Deploying => "deploying",
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Sleeping => "sleeping",
            Self::Importing => "importing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeployStatus {
    #[serde(rename = "building")]
    Building,
    #[serde(rename = "deploying")]
    Deploying,
    #[serde(rename = "success")]
    Success,
    #[serde(rename = "failed")]
    Failed,
}

impl DeployStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Deploying => "deploying",
            Self::Success => "success",
            Self::Failed => "failed",
        }
    }

    pub fn is_in_flight(self) -> bool {
        matches!(self, Self::Building | Self::Deploying)
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "building" => Some(Self::Building),
            "deploying" => Some(Self::Deploying),
            "success" => Some(Self::Success),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct App {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub user_id: String,
    pub status: String,
    pub subdomain: String,
    pub git_prefix: String,
    pub fleet_bucket: String,
    pub listen_port: Option<i64>,
    pub internal_port: Option<i64>,
    pub last_deploy_sha: Option<String>,
    pub last_error: Option<String>,
    pub desired_state: String,
    pub created_at: String,
    pub updated_at: String,
    /// Set while the app is asleep (scale to zero); NULL when awake.
    pub asleep_since: Option<String>,
    /// Last wake (request-driven, manual start or deploy): the idle clock
    /// never runs from before it.
    pub woke_at: Option<String>,
    /// Wrangler config (JSON) of the last successful deploy; the source may
    /// have none (cloudflare.config.ts, built dist/wrangler.json).
    #[serde(skip)]
    pub deployed_config: Option<String>,
    /// The `source` this app was created from, as JSON (A2): lets Retry
    /// re-run a failed import. `None` for a blank app. Never served to the UI.
    #[serde(skip)]
    pub import_source: Option<String>,
    /// Whether the row carries a stored import source — the UI's Retry gate.
    /// Derived in SQL (`import_source IS NOT NULL`), never a column.
    pub imported: bool,
}

impl App {
    pub fn desired(&self) -> DesiredState {
        DesiredState::parse(&self.desired_state).unwrap_or(DesiredState::Running)
    }

    pub fn is_stopped(&self) -> bool {
        self.desired() == DesiredState::Stopped
    }

    /// Asleep: desired running, fleet stopped until the next request.
    pub fn is_asleep(&self) -> bool {
        self.asleep_since.is_some() && !self.is_stopped()
    }

    pub fn is_deployed(&self) -> bool {
        self.status == AppStatus::Running.as_str() || self.last_deploy_sha.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Deploy {
    pub id: String,
    pub app_id: String,
    /// The preview environment this deploy targets; `None` is production.
    pub environment_id: Option<String>,
    pub sha: Option<String>,
    pub status: String,
    pub log: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Deploy {
    pub fn status_enum(&self) -> Option<DeployStatus> {
        DeployStatus::parse(&self.status)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppEnv {
    pub app_id: String,
    pub name: String,
    pub value: String,
    pub updated_at: String,
}

/// What an environment was created from (ROADMAP): a pushed branch, or a
/// workspace preview of uncommitted Code mode changes (a hidden ref).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum EnvironmentKind {
    Branch,
    Workspace,
}

impl EnvironmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Branch => "branch",
            Self::Workspace => "workspace",
        }
    }
}

/// One preview environment: its own celld fleet at `<label>.<slug>.<base>`,
/// with its own bucket prefix (`envs/<slug>/<label>`) and its own storage.
/// `main` is the app itself, never an environment.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Environment {
    pub id: String,
    pub app_id: String,
    pub label: String,
    /// `EnvironmentKind` as stored: `branch` or `workspace`.
    pub kind: String,
    /// `refs/heads/<branch>` or `refs/previews/<userId>/<branch>`.
    pub git_ref: String,
    pub created_by: String,
    pub fleet_bucket: String,
    pub listen_port: Option<i64>,
    pub internal_port: Option<i64>,
    /// Observed status, as `AppStatus` strings.
    pub status: String,
    pub desired_state: String,
    pub asleep_since: Option<String>,
    pub woke_at: Option<String>,
    pub last_deploy_sha: Option<String>,
    pub last_deployed_at: Option<String>,
    /// Members-only by default; a public environment serves without the gate.
    pub public: bool,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// The owning app's slug: joined in, never a column (the edge and the
    /// host shape `<label>.<slug>.<base>` need it).
    pub app_slug: String,
}

/// One app's live state: its row and its preview environments, as the
/// control UI's status badges show them (`GET /v1/apps/{id}/state/stream`
/// re-sends it whenever either changes).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppStateFrame {
    pub app: App,
    pub environments: Vec<Environment>,
}

impl Environment {
    pub fn desired(&self) -> DesiredState {
        DesiredState::parse(&self.desired_state).unwrap_or(DesiredState::Running)
    }

    pub fn is_stopped(&self) -> bool {
        self.desired() == DesiredState::Stopped
    }

    /// Asleep: desired running, fleet stopped until the next request.
    pub fn is_asleep(&self) -> bool {
        self.asleep_since.is_some() && !self.is_stopped()
    }

    pub fn is_deployed(&self) -> bool {
        self.status == AppStatus::Running.as_str() || self.last_deploy_sha.is_some()
    }
}

/// A custom-domain claim's verification state (SPEC, Custom domains), stored
/// as text like every other status column (`Environment.kind`, `App.status`):
/// `pending` until its TXT proof resolves, `verified` once it does (or
/// immediately in `single` tenancy, where one trusted operator owns the DNS).
/// Only verified rows route, certify and resolve.
pub const DOMAIN_STATUS_PENDING: &str = "pending";
pub const DOMAIN_STATUS_VERIFIED: &str = "verified";

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppDomain {
    pub app_id: String,
    pub hostname: String,
    pub status: String,
    pub token: String,
    pub verified_at: Option<String>,
    pub created_at: String,
}

impl AppDomain {
    pub fn is_verified(&self) -> bool {
        self.status == DOMAIN_STATUS_VERIFIED
    }
}

/// An app's own edge rate limits (requests per minute). `None` takes the
/// platform default, `Some(0)` turns the limit off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppLimit {
    pub app_id: String,
    /// Per client IP, across the app's hostnames.
    pub client_rpm: Option<i64>,
    /// Across every client.
    pub app_rpm: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppMetric {
    pub app_id: String,
    pub bucket_ts: String,
    pub requests: i64,
    pub errors: i64,
    pub latency_ms: i64,
    pub cpu_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppDeviceStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub browser: String,
    pub os: String,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppPathStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub path: String,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppRefStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub source: String,
    pub requests: i64,
}

/// Aggregated span row served to the dashboard (spec T3.2). Same JSON shape
/// as the old DuckDB-backed `SpanStat` (`qwaitMs`), now read from the
/// ingested `app_span_stat` ring instead of scanning Parquet per viewer.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppSpanStat {
    pub name: String,
    pub kind: i64,
    pub n: i64,
    pub ms: i64,
    pub err: i64,
    pub qwait_ms: i64,
}

/// One grouped error (host/errors.rs): every occurrence with the same
/// fingerprint. `status` is `open`, `resolved` or `ignored`; `regressed`
/// marks a resolved issue that fired again.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ErrorIssue {
    pub fingerprint: String,
    pub kind: String,
    pub message: String,
    pub culprit: String,
    pub handler: String,
    pub source: String,
    pub count: i64,
    pub first_seen_us: i64,
    pub last_seen_us: i64,
    pub first_sha: Option<String>,
    pub last_sha: Option<String>,
    pub status: String,
    pub regressed: bool,
    pub status_at_us: Option<i64>,
}

/// One stored occurrence. `frames` and `logs` are JSON arrays as text;
/// the RPC layer inlines them.
#[derive(Debug, Clone, FromRow)]
pub struct ErrorEvent {
    pub ts_us: i64,
    pub trace_id: String,
    pub source: String,
    pub handler: String,
    pub cell: String,
    pub kind: String,
    pub message: String,
    pub context: String,
    pub frames: String,
    pub logs: String,
    pub method: String,
    pub path: String,
    pub http_status: i64,
    pub browser: String,
    pub os: String,
    pub sha: String,
    /// SDK extras (phase 2): the page URL with its query stripped, and the
    /// release/environment the SDK reported. Empty on telemetry occurrences.
    pub url: String,
    pub release: String,
    pub environment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppEvent {
    pub id: String,
    pub app_id: String,
    pub channel: String,
    pub event: String,
    pub description: String,
    pub icon: String,
    pub tags: String,
    pub user_id: String,
    pub ts: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppUserProps {
    pub app_id: String,
    pub user_id: String,
    pub properties: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInsight {
    pub app_id: String,
    pub title: String,
    pub value: String,
    pub num: Option<f64>,
    pub icon: String,
    pub updated_at: String,
}

/// A public GitHub repo cloned once into a new app (A2). `squash` collapses
/// the history into one root commit of the fetched tree (A3 templates); the
/// clone URL itself is validated by `host::import::github_url`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSource {
    pub url: String,
    /// Branch, tag or sha to clone; the upstream default branch when absent.
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub squash: bool,
    /// Repository subdirectory to import instead of the whole tree (a
    /// monorepo package). Its tree becomes the app's root as one squashed
    /// commit: the subdirectory has no history of its own to keep. Validated
    /// by `host::import::import_path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Who the squashed commit is authored as (the shared commit actor).
    pub actor: Actor,
}

/// Where a new app's initial content comes from (`apps.create`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppSource {
    Blank,
    Git(GitSource),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApp {
    pub name: String,
    pub slug: String,
    /// Owning account (the control UI passes the signed-in user). Absent on
    /// direct API calls, which fall back to the local-operator placeholder.
    pub user_id: Option<String>,
    /// Initial content (A2/A3); absent = the blank app of A1.
    #[serde(default)]
    pub source: Option<AppSource>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchApp {
    pub desired_state: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameApp {
    pub name: Option<String>,
    pub slug: Option<String>,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|n| DateTime::from_naive_utc_and_offset(n, Utc))
        })
}
