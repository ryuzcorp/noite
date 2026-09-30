use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Deploy {
    pub id: String,
    pub app_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppEnv {
    pub app_id: String,
    pub name: String,
    pub value: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppDomain {
    pub app_id: String,
    pub hostname: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppMetric {
    pub app_id: String,
    pub bucket_ts: String,
    pub requests: i64,
    pub errors: i64,
    pub latency_ms: i64,
    pub cpu_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppDeviceStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub browser: String,
    pub os: String,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppPathStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub path: String,
    pub requests: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppRefStat {
    pub app_id: String,
    pub bucket_ts: String,
    pub source: String,
    pub requests: i64,
}

/// Aggregated span row served to the dashboard (spec T3.2). Same JSON shape
/// as the old DuckDB-backed `SpanStat` (`qwaitMs`), now read from the
/// ingested `app_span_stat` ring instead of scanning Parquet per viewer.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
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
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppUserProps {
    pub app_id: String,
    pub user_id: String,
    pub properties: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppInsight {
    pub app_id: String,
    pub title: String,
    pub value: String,
    pub num: Option<f64>,
    pub icon: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApp {
    pub name: String,
    pub slug: String,
    /// Owning account (the control UI passes the signed-in user). Absent on
    /// direct API calls, which fall back to the local-operator placeholder.
    pub user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
