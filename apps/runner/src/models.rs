use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use ts_rs::TS;
use uuid::Uuid;

use crate::host::git_identity::Actor;

/// Operator intent: only running|stopped. Removal is hard DELETE, not a state.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Running: app created
///   Running --> Stopped: PATCH desiredState=stopped
///   Stopped --> Running: PATCH desiredState=running
/// ```
///
/// Intent is the *only* thing an operator writes; the observed status
/// ([`AppStatus`]) follows it a tick later, and every observed write made on
/// behalf of a deploy/wake/confirm requires `desired_state='running'`, so a
/// stop always wins the race.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum DesiredState {
    Running,
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

/// Observed status of one app — or one preview environment — as deploy,
/// import, sleep and the reconcile loop record it (`app.status`,
/// `environment.status`).
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Pending: row inserted without a status (schema default)
///   [*] --> Provisioned: app/environment created
///   Pending --> Provisioned: first deploy prepares it
///   Provisioned --> Importing: source create / retry
///   Importing --> Provisioned: import finished
///   Importing --> Error: import failed
///   Error --> Importing: retry
///   Importing --> Building: a push raced the import
///   Provisioned --> Building: deploy starts
///   Running --> Building: redeploy starts
///   Sleeping --> Building: redeploy wakes it
///   Stopped --> Building: a deploy runs while stopped (status kept by the guard)
///   Failed --> Building: retry deploy
///   Building --> Deploying: stage/activate
///   Deploying --> Running: health gate confirmed / deploy live
///   Building --> Running: confirmed without a stage
///   Running --> Sleeping: scale to zero
///   Sleeping --> Running: woken + confirmed
///   Running --> Stopped: operator stop (next reconcile tick)
///   Sleeping --> Stopped: operator stop
///   Building --> Failed: deploy failed / stalled
///   Deploying --> Failed: deploy failed / stalled
///   Running --> Failed: deploy failed over a serving app
///   Failed --> Running: later deploy succeeded
/// ```
///
/// Every write goes through `db::write_app_status` (or
/// `db::write_environment_status`), which refuses a transition the table
/// below does not allow and reports it; nothing writes the column directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum AppStatus {
    /// The schema default (`app.status DEFAULT 'pending'`): a row that was
    /// inserted without an observed status. A preview environment is created
    /// this way and stays `pending` until its first deploy.
    Pending,
    /// Created, never deployed (and never imported).
    Provisioned,
    /// A background GitHub/template import is running (A2); flips to
    /// `provisioned` (then the deploy pipeline takes over) or `error`.
    Importing,
    /// The import failed; `last_error` says why. Retry moves it back to
    /// `importing`.
    Error,
    Building,
    Deploying,
    Running,
    /// Deployed and desired running, but its fleet is stopped until the next
    /// request (SPEC, Scale to zero).
    Sleeping,
    Stopped,
    Failed,
}

/// Every status, for the transition tables whose target accepts any
/// predecessor (`stopped` and `failed` are reachable from any observed state).
const EVERY_APP_STATUS: &[AppStatus] = &[
    AppStatus::Pending,
    AppStatus::Provisioned,
    AppStatus::Importing,
    AppStatus::Error,
    AppStatus::Building,
    AppStatus::Deploying,
    AppStatus::Running,
    AppStatus::Sleeping,
    AppStatus::Stopped,
    AppStatus::Failed,
];

impl AppStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Provisioned => "provisioned",
            Self::Importing => "importing",
            Self::Error => "error",
            Self::Building => "building",
            Self::Deploying => "deploying",
            Self::Running => "running",
            Self::Sleeping => "sleeping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }

    /// The states a row may hold immediately before it is written as `self`:
    /// the one transition table for the app/environment machine. A state is
    /// always its own predecessor, because a writer that re-states the
    /// current status (a log line, a repeated summary) must apply.
    pub fn predecessors(self) -> &'static [AppStatus] {
        match self {
            Self::Pending => &[Self::Pending],
            Self::Provisioned => &[Self::Pending, Self::Provisioned, Self::Importing],
            Self::Importing => &[
                Self::Pending,
                Self::Provisioned,
                Self::Importing,
                Self::Error,
                Self::Stopped,
                Self::Failed,
            ],
            Self::Error => &[Self::Importing, Self::Error],
            // `Error` is here (and on `Running`): a push can deploy an app
            // whose import failed, and the deploy must be able to show the
            // badge of what it just did.
            Self::Building => &[
                Self::Pending,
                Self::Error,
                Self::Provisioned,
                Self::Importing,
                Self::Building,
                Self::Deploying,
                Self::Running,
                Self::Sleeping,
                Self::Stopped,
                Self::Failed,
            ],
            Self::Deploying => &[Self::Pending, Self::Building, Self::Deploying],
            Self::Running => &[
                Self::Pending,
                Self::Provisioned,
                Self::Importing,
                Self::Error,
                Self::Building,
                Self::Deploying,
                Self::Running,
                Self::Sleeping,
                Self::Stopped,
                Self::Failed,
            ],
            Self::Sleeping => &[Self::Running, Self::Sleeping],
            Self::Stopped => EVERY_APP_STATUS,
            Self::Failed => EVERY_APP_STATUS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum DeployStatus {
    /// Obliged to run and waiting for the app's in-flight deploy to release
    /// the claim (`claim_wait`); the pipeline's first step moves it on.
    Queued,
    Building,
    Deploying,
    Success,
    Failed,
    /// The operator stopped the run before it activated (`host/cancel.rs`).
    /// Distinct from [`Self::Failed`] so the history says who ended it.
    Cancelled,
    /// The stall sweep closed a row whose run stopped reporting
    /// (`db::deploys::fail_stuck_deploys`): the host was interrupted or the
    /// step timed out. Distinct from [`Self::Failed`] so a timeout is not
    /// read as a build error.
    Stalled,
}

impl DeployStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Building => "building",
            Self::Deploying => "deploying",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Stalled => "stalled",
        }
    }

    pub fn is_in_flight(self) -> bool {
        matches!(self, Self::Queued | Self::Building | Self::Deploying)
    }

    /// The states a row may hold immediately before it is written as `self`:
    /// the one transition table for `db::deploys::upsert_deploy`. A terminal
    /// row (`success`, `failed`, `cancelled`, `stalled`) is its own
    /// predecessor only, so a stopped, failed or succeeded deploy can never be
    /// moved again — the late writer is refused instead of rewriting history.
    pub fn predecessors(self) -> &'static [DeployStatus] {
        match self {
            Self::Queued => &[Self::Queued],
            Self::Building => &[Self::Queued, Self::Building],
            Self::Deploying => &[Self::Queued, Self::Building, Self::Deploying],
            Self::Success => &[Self::Building, Self::Deploying, Self::Success],
            Self::Failed => &[Self::Queued, Self::Building, Self::Deploying, Self::Failed],
            // Both terminal closers act on any in-flight row, exactly as the
            // failure path does: the stop endpoint and the stall sweep close
            // a queued wait as readily as a running step. Each is its own
            // predecessor only, so neither can overwrite the other's story.
            Self::Cancelled => &[
                Self::Queued,
                Self::Building,
                Self::Deploying,
                Self::Cancelled,
            ],
            Self::Stalled => &[Self::Queued, Self::Building, Self::Deploying, Self::Stalled],
        }
    }
}

/// What a status write is allowed to apply to, on top of the transition
/// table ([`AppStatus::predecessors`]). The single extra condition per write
/// site, made a value instead of a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteGuard {
    /// Only the table constrains the write.
    Table,
    /// The table, and only from these states: `finish_app_import` may only
    /// move a row that still reads `importing`.
    From(&'static [AppStatus]),
    /// The table, and only while the target still wants to run
    /// (`desired_state = 'running'`): a stop (or delete) racing a deploy, a
    /// wake or a confirm always wins the write.
    Wanted,
}

/// A persisted status vocabulary: what the SQL writers need to render a
/// `status IN (…)` list from a transition table without a `String` in sight.
pub trait PersistedStatus: Copy {
    fn as_str(self) -> &'static str;
}

impl PersistedStatus for AppStatus {
    fn as_str(self) -> &'static str {
        AppStatus::as_str(self)
    }
}

impl PersistedStatus for DeployStatus {
    fn as_str(self) -> &'static str {
        DeployStatus::as_str(self)
    }
}

/// What one guarded write of `app.status` / `environment.status` did.
/// `Refused` carries the row's status at read-back, so a caller can tell
/// "another writer closed the row" from "the stop guard held".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusWrite {
    Applied,
    Refused { current: AppStatus },
}

impl StatusWrite {
    pub fn is_applied(self) -> bool {
        matches!(self, Self::Applied)
    }
}

/// What one guarded write of a `deploy.status` row did (see
/// [`DeployStatus::predecessors`]): a terminal row refuses every later write,
/// so a stopped, failed or succeeded deploy can never be moved again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployWrite {
    Applied,
    Refused { current: DeployStatus },
}

impl DeployWrite {
    pub fn is_applied(self) -> bool {
        matches!(self, Self::Applied)
    }
}

/// Why a fleet is being retried while its row still says `running`: the
/// supervisor's crash or OOM backoff. Its own type because it is process
/// state — never a column, and never folded into [`AppStatus`], which is
/// about what the app is doing, not about why the runner is waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FleetHold {
    /// The child exited on its own; the next spawn backs off 5 s … 60 s.
    Crash,
    /// The kernel OOM-killed the child at its memory cap.
    Oom,
}

/// A held fleet as the API serves it: the reason plus the instant the next
/// spawn attempt is due. Carried by [`App::fleet_hold`] only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FleetHoldInfo {
    pub hold: FleetHold,
    /// RFC 3339 instant the next spawn attempt is due.
    pub retry_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct App {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub user_id: String,
    pub status: AppStatus,
    pub subdomain: String,
    pub git_prefix: String,
    pub fleet_bucket: String,
    pub listen_port: Option<i64>,
    pub internal_port: Option<i64>,
    pub last_deploy_sha: Option<String>,
    pub last_error: Option<String>,
    pub desired_state: DesiredState,
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
    /// Why the supervisor is holding this app's next spawn (a crash or an OOM
    /// backoff), `None` when it is not held. Filled by the service layer from
    /// the supervisor's [`crate::host::supervisor::FleetState`] — process
    /// state, never a column, and it never changes [`AppStatus`].
    #[sqlx(skip)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fleet_hold: Option<FleetHoldInfo>,
    /// Whether the runner may still deploy the git tip on its own
    /// ([`AutoDeploy`]). Derived from the deploy rows on every read, so it is
    /// never a column and survives a restart.
    #[sqlx(skip)]
    pub auto_deploy: AutoDeploy,
}

impl App {
    pub fn desired(&self) -> DesiredState {
        self.desired_state
    }

    pub fn is_stopped(&self) -> bool {
        self.desired() == DesiredState::Stopped
    }

    /// Asleep: desired running, fleet stopped until the next request.
    pub fn is_asleep(&self) -> bool {
        self.asleep_since.is_some() && !self.is_stopped()
    }

    pub fn is_deployed(&self) -> bool {
        self.status == AppStatus::Running || self.last_deploy_sha.is_some()
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
    pub status: DeployStatus,
    /// Why the run exists ([`DeployIntent`]); settled when the row is created
    /// and never rewritten.
    pub intent: DeployIntent,
    /// Who asked for the run, when the caller could say: a profile API key's
    /// attributable label ("Ada via key ci") for a redeploy it triggered.
    /// `None` is the automatic push/tip pipeline, which has no request.
    pub actor: Option<String>,
    pub log: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Why one deploy row exists: its trigger, not its outcome. Stored as TEXT
/// with a `'deploy'` default (schema version 101), so a row written before the
/// column existed reads as a plain deploy.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Deploy: a push, a web commit or the tip sweep
///   [*] --> Rollback: an operator re-runs an old successful sha
///   [*] --> Redeploy: an environment deploy at its ref's head
/// ```
///
/// The intent is set once, when the row is created, and never changes: it
/// describes the request that started the run, so a rollback whose pipeline
/// then fails is still a rollback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum DeployIntent {
    /// A push to the app's branch, a web commit, or the reconcile sweep
    /// catching up with the tip.
    Deploy,
    /// The operator re-ran a past successful sha (`POST /v1/apps/{id}/rollback`,
    /// `deploys.rollback`).
    Rollback,
    /// An environment deployed at its ref's current head
    /// (`environments.deploy`, the UI's Redeploy).
    Redeploy,
}

impl DeployIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deploy => "deploy",
            Self::Rollback => "rollback",
            Self::Redeploy => "redeploy",
        }
    }

    /// Whether the row was started by an operator action (rollback, redeploy)
    /// rather than by a push or the automatic tip sweep. An explicit row is
    /// what resets the automatic-deploy budget.
    pub fn is_explicit(self) -> bool {
        !matches!(self, Self::Deploy)
    }
}

/// Whether the runner may still deploy a target's git tip on its own.
///
/// Owner rule (2026-11-10): after **two consecutive failed deploys of the same
/// target at the same sha**, automatic deploys of that sha stop until a new
/// sha arrives or an explicit deploy (Deploy/Redeploy/Rollback from the UI,
/// the CLI or MCP) runs — the same action that applies a build-affecting
/// settings or env-var change. A `cancelled` run is an operator stop: it never
/// counts as a failure, but it also never lets the sweep retry that sha on its
/// own.
///
/// The state is derived from the persisted `deploy` rows on every read
/// (`host::auto_deploy`), so it survives a restart; nothing here is a column.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> Eligible
///   Eligible --> Failing: automatic failure (failures = 1)
///   Failing --> Failing: automatic failure, other sha (failures = 1)
///   Failing --> Exhausted: automatic failure, same sha (failures = 2)
///   Exhausted --> Exhausted: automatic failure, same sha (failures + 1)
///   Failing --> Eligible: success
///   Exhausted --> Eligible: success
///   Failing --> Eligible: explicit row (rollback / redeploy)
///   Exhausted --> Eligible: explicit row
///   Eligible --> Stopped: cancel
///   Failing --> Stopped: cancel
///   Exhausted --> Stopped: cancel
///   Stopped --> Eligible: success or explicit row
///   Eligible --> Eligible: in-flight row (new attempt)
///   Failing --> Eligible: in-flight row (new attempt)
///   Exhausted --> Eligible: in-flight row (new attempt)
///   Stopped --> Eligible: in-flight row (explicit redeploy)
/// ```
///
/// `Eligible` and `Failing` allow an automatic deploy; `Exhausted` and
/// `Stopped` block one **for the sha they name** — a new sha is a new start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, Default)]
#[serde(rename_all = "camelCase", tag = "state")]
#[ts(export)]
pub enum AutoDeploy {
    /// No blocking history: the tip may deploy.
    #[default]
    Eligible,
    /// One automatic failure at `sha`; the next automatic attempt is allowed.
    Failing { sha: String, failures: u32 },
    /// The automatic budget is spent: `failures` (>= 2) consecutive automatic
    /// deploys of `sha` failed.
    Exhausted { sha: String, failures: u32 },
    /// An operator stopped a deploy of `sha`; automatic retries of it are off.
    Stopped { sha: String },
}

impl AutoDeploy {
    /// The failure cap: the second consecutive failure closes the budget.
    pub const FAILURE_CAP: u32 = 2;

    /// Whether an automatic deploy of `sha` must be refused.
    pub fn blocks(&self, sha: &str) -> bool {
        match self {
            Self::Eligible | Self::Failing { .. } => false,
            Self::Exhausted { sha: blocked, .. } | Self::Stopped { sha: blocked } => {
                crate::lifecycle::sha_same(blocked, sha)
            }
        }
    }
}

/// Who wrote one `app_env` / `environment_env` row: the operator, or one of
/// the runner's provisioning paths. Stored as today's strings — `''` for a
/// user row, else the marker — so nothing on the wire or in the database
/// changes.
///
/// ```mermaid
/// stateDiagram-v2
///   [*] --> User: operator saves a variable
///   [*] --> AuthDefault: deploy mints BETTER_AUTH_SECRET
///   [*] --> VoidProxyToken: deploy mints __VOID_PROXY_TOKEN
///   [*] --> VoidSandboxAdmission: deploy mints the admission name
///   AuthDefault --> User: operator saves the same name
///   VoidProxyToken --> User: operator saves the same name
///   VoidSandboxAdmission --> User: operator saves the same name
///   User --> AuthDefault: a provisioner overwrites (rotation)
/// ```
///
/// A value outside this set cannot be decoded: a hand-edited marker fails
/// loudly at read instead of silently routing a secret through the wrong
/// merge (the bug this type closes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[sqlx(rename_all = "kebab-case")]
#[ts(export)]
pub enum EnvSource {
    /// Operator-written (`''`).
    #[serde(rename = "")]
    #[sqlx(rename = "")]
    User,
    /// The auto-provisioned `BETTER_AUTH_SECRET`.
    #[serde(rename = "auth-default")]
    AuthDefault,
    /// The per-fleet `__VOID_PROXY_TOKEN` (runner-owned merge only).
    #[serde(rename = "void-proxy-token")]
    VoidProxyToken,
    /// The per-fleet `__VOID_SANDBOX_ADMISSION_NAME` (controller render only).
    #[serde(rename = "void-sandbox-admission")]
    VoidSandboxAdmission,
}

impl EnvSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "",
            Self::AuthDefault => "auth-default",
            Self::VoidProxyToken => "void-proxy-token",
            Self::VoidSandboxAdmission => "void-sandbox-admission",
        }
    }

    /// Written by the runner, not by the operator: no settings merge may
    /// hand it to a tenant.
    pub fn is_provisioned(self) -> bool {
        self != Self::User
    }

    /// Consumed by one runner-owned merge (the proxy token and the sandbox
    /// admission name), never by the ordinary settings merges: their names
    /// are reserved there. The auth secret is *not* in this set — it is an
    /// ordinary Worker var under an allowed name.
    pub fn is_runner_owned(self) -> bool {
        matches!(self, Self::VoidProxyToken | Self::VoidSandboxAdmission)
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
    /// Who wrote the row ([`EnvSource`]). Served like the rest of the row;
    /// the deploy merges read it, the UI ignores it.
    pub source: EnvSource,
}

/// What an environment was created from (ROADMAP): a pushed branch, or a
/// workspace preview of uncommitted Code mode changes (a hidden ref).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
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
    pub kind: EnvironmentKind,
    /// `refs/heads/<branch>` or `refs/previews/<userId>/<branch>`.
    pub git_ref: String,
    pub created_by: String,
    pub fleet_bucket: String,
    pub listen_port: Option<i64>,
    pub internal_port: Option<i64>,
    /// Observed status, the same machine as an app's ([`AppStatus`]); a new
    /// environment starts `pending` until its first deploy.
    pub status: AppStatus,
    pub desired_state: DesiredState,
    pub asleep_since: Option<String>,
    pub woke_at: Option<String>,
    pub last_deploy_sha: Option<String>,
    pub last_deployed_at: Option<String>,
    /// Members-only by default; a public environment serves without the gate.
    pub public: bool,
    pub last_error: Option<String>,
    /// Whether the runner may still deploy this environment's ref head on its
    /// own ([`AutoDeploy`], derived from its own deploy rows).
    #[sqlx(skip)]
    pub auto_deploy: AutoDeploy,
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
        self.desired_state
    }

    pub fn is_stopped(&self) -> bool {
        self.desired() == DesiredState::Stopped
    }

    /// Asleep: desired running, fleet stopped until the next request.
    pub fn is_asleep(&self) -> bool {
        self.asleep_since.is_some() && !self.is_stopped()
    }

    pub fn is_deployed(&self) -> bool {
        self.status == AppStatus::Running || self.last_deploy_sha.is_some()
    }
}

/// A PR's lifecycle (F4). Two terminal outcomes and one live state; every
/// transition is a compare-and-swap in `db::prs` (`close_pr`, `reopen_pr`,
/// `merge_pr`), so a write that raced another transition is refused instead
/// of overwriting it.
///
/// ```text
/// open -> closed -> open     (reopen needs a live head branch, no open rival)
/// open -> merged             (terminal; merge_sha/merged_by/merged_at set)
/// ```
///
/// `merged` and `closed` are both terminal for the merge box; only `merged`
/// carries the commit fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

impl PrState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
            Self::Merged => "merged",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "closed" => Some(Self::Closed),
            "merged" => Some(Self::Merged),
            _ => None,
        }
    }
}

/// A reviewer's verdict, recorded at the head sha it was written against.
/// `dismissed_at` marks a verdict that no longer counts (the head moved).
/// Superseding a verdict is an insert of a newer one, not an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
#[ts(export)]
pub enum ReviewState {
    Approved,
    ChangesRequested,
}

impl ReviewState {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "approved" => Some(Self::Approved),
            "changes_requested" => Some(Self::ChangesRequested),
            _ => None,
        }
    }
}

/// A custom-domain claim's verification state (SPEC, Custom domains):
/// `pending` until its TXT proof resolves, `verified` once it does (or
/// immediately in `single` tenancy, where one trusted operator owns the DNS).
/// Only verified rows route, certify and resolve.
///
/// ```text
/// pending -> verified   (TXT proof, or add under single tenancy)
/// pending -> absent     (rival verified first; its verify drops our row)
/// any     -> absent     (explicit remove)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum DomainStatus {
    Pending,
    Verified,
}

impl DomainStatus {
    pub fn is_verified(self) -> bool {
        self == Self::Verified
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppDomain {
    pub app_id: String,
    pub hostname: String,
    pub status: DomainStatus,
    pub token: String,
    pub verified_at: Option<String>,
    pub created_at: String,
}

impl AppDomain {
    pub fn is_verified(&self) -> bool {
        self.status.is_verified()
    }
}

/// An app's own edge rate limits (requests per minute), fleet memory cap,
/// and idle-sleep threshold. `None` takes the platform default, `Some(0)`
/// turns the rate limit off — and means "never sleep" for the sleep
/// threshold.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AppLimit {
    pub app_id: String,
    /// Per client IP, across the app's hostnames.
    pub client_rpm: Option<i64>,
    /// Across every client.
    pub app_rpm: Option<i64>,
    /// Fleet `memory.max` in MiB (`None` = `RUNNER_FLEET_MEMORY_MB`).
    pub memory_mb: Option<i64>,
    /// Idle seconds before the sweep parks this app (`None` = the install
    /// threshold; `Some(0)` = never).
    pub sleep_after_s: Option<i64>,
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

/// Triage state of a grouped error (ROTH-6). `open` is the only state in
/// which `regressed` is meaningful: a resolved (or ignored) issue that fires
/// again goes back to `open` with `regressed = true` in one write, and the
/// explicit resolve/ignore writer clears the flag. The wire keeps the same
/// three strings and the same `regressed` boolean.
///
/// ```text
/// open -> resolved -> open   (an occurrence after resolution: regressed)
/// open -> ignored   -> open  (an occurrence after ignore: regressed)
/// resolved <-> ignored       (explicit triage)
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type, TS)]
#[serde(rename_all = "lowercase")]
#[sqlx(rename_all = "lowercase")]
#[ts(export)]
pub enum IssueStatus {
    Open,
    Resolved,
    Ignored,
}

impl IssueStatus {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "open" => Some(Self::Open),
            "resolved" => Some(Self::Resolved),
            "ignored" => Some(Self::Ignored),
            _ => None,
        }
    }
}

/// One grouped error (host/errors.rs): every occurrence with the same
/// fingerprint. `regressed` marks a resolved issue that fired again.
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
    pub status: IssueStatus,
    /// Meaningful only for `status == open`; every explicit triage write
    /// clears it and the ingest sets it only when it reopens a resolved row.
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
