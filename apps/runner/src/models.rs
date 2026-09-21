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
}

impl App {
    pub fn desired(&self) -> DesiredState {
        DesiredState::parse(&self.desired_state).unwrap_or(DesiredState::Running)
    }

    pub fn is_stopped(&self) -> bool {
        self.desired() == DesiredState::Stopped
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
pub struct AppSecret {
    pub id: String,
    pub app_id: String,
    pub kind: String,
    pub access_key: String,
    pub secret_key: String,
    pub revealed: i64,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApp {
    pub name: String,
    pub slug: String,
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
