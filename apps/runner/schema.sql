-- Noite runner schema: the shape of a FRESH database, applied at every boot
-- (`db::connect`) and idempotent: every statement is CREATE ... IF NOT EXISTS.
--
-- A database that already holds data is upgraded first by the numbered steps
-- in `schema_version.rs` (version in `PRAGMA user_version`), and one written
-- by a newer build is refused. A shape change therefore does BOTH: edits the
-- CREATE below, and appends a migration that takes an existing table there.
-- Nothing in this file ALTERs or DROPs (a bare `DROP` would resolve into the
-- ATTACHed metrics.sqlite); migrations qualify tables as `main.<name>`.

-- Apps: one row per tenant app. Hard DELETE is the only remove path.
CREATE TABLE IF NOT EXISTS app (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'pending',
  subdomain TEXT NOT NULL,
  git_prefix TEXT NOT NULL,
  fleet_bucket TEXT NOT NULL,
  listen_port INTEGER,
  internal_port INTEGER,
  last_deploy_sha TEXT,
  last_error TEXT,
  desired_state TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Scale to zero (SPEC, Scale to zero): parked since / last woken.
  asleep_since TEXT,
  woke_at TEXT,
  -- The Wrangler config (JSON) the last successful deploy uploaded.
  deployed_config TEXT,
  -- Per-app build/release sandbox uid (host::netisolation, config.rs
  -- BUILD_UID_BASE): NULL until allocated on the app's first build.
  build_uid INTEGER,
  -- The `apps.create` source (JSON) this app was imported from: NULL for a
  -- blank app; lets a failed GitHub/template import be retried (A2).
  import_source TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_build_uid ON app(build_uid);

CREATE INDEX IF NOT EXISTS idx_app_user ON app(user_id);

-- Preview environments (ROADMAP, Preview environments): one row per branch or
-- workspace preview. An environment is its own celld fleet with its own bucket
-- prefix (`envs/<slug>/<label>`), so it can neither read nor wipe production's
-- bucket, ports or `last_deploy_sha`; `main` is the app itself, never an
-- environment. Hard DELETE is the only remove path, like `app`.
CREATE TABLE IF NOT EXISTS environment (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  -- DNS label: unique per app, the host is `<label>.<slug>.<base>`.
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('branch','workspace')),
  -- `refs/heads/<branch>` for a branch environment,
  -- `refs/previews/<userId>/<branch>` for a workspace preview.
  git_ref TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  fleet_bucket TEXT NOT NULL,
  listen_port INTEGER,
  internal_port INTEGER,
  -- Observed status (AppStatus strings) written by deploy / reconcile.
  status TEXT NOT NULL DEFAULT 'pending',
  desired_state TEXT NOT NULL DEFAULT 'running',
  asleep_since TEXT,
  woke_at TEXT,
  last_deploy_sha TEXT,
  last_deployed_at TEXT,
  -- Members-only by default (ROADMAP): 1 serves the environment publicly.
  public INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (app_id, label)
);

CREATE INDEX IF NOT EXISTS idx_environment_app ON environment(app_id);
CREATE INDEX IF NOT EXISTS idx_environment_ref ON environment(app_id, git_ref);
CREATE INDEX IF NOT EXISTS idx_environment_deployed ON environment(last_deployed_at);

-- Deploy attempts: status + capped build/deploy log tail per push.
CREATE TABLE IF NOT EXISTS deploy (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  -- NULL = production. Set for a preview environment's deploy, which never
  -- touches `app.last_deploy_sha` or the app's own status.
  environment_id TEXT REFERENCES environment(id) ON DELETE CASCADE,
  sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_app ON deploy(app_id);
CREATE INDEX IF NOT EXISTS idx_deploy_environment ON deploy(environment_id);

-- Per-app usage metrics, edge analytics, span stats, log ring, errors,
-- watermarks and compaction state live in metrics.sqlite
-- (apps/runner/schema.metrics.sql), ATTACHed as `metrics` — never in this snapshotted
-- file (spec T4.1).

-- Tenant env vars (CF `.dev.vars` model). Names starting with `FLAG_`
-- are feature flags: the settings UI renders them as on/off toggles
-- writing `1`/`0`, and they inject like any other var.
CREATE TABLE IF NOT EXISTS app_env (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, name)
);

-- Per-environment overrides on top of the app's variables (ROADMAP: an
-- environment inherits the app's variables, with optional per-environment
-- overrides). Same reserved-name filtering as `app_env` at inject time.
CREATE TABLE IF NOT EXISTS environment_env (
  environment_id TEXT NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, name)
);

-- Tenant app events (LogSnag-style): channel-grouped event log, user
-- property profiles, and latest-value insight widgets. Ingest comes through
-- the control UI (API-key + role gate); the runner only stores and serves.
CREATE TABLE IF NOT EXISTS app_event (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  event TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '{}',   -- JSON object, string|number|boolean values
  user_id TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL                   -- event time, ISO-8601 UTC, sortable
);

CREATE INDEX IF NOT EXISTS idx_app_event_app_ts ON app_event(app_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_event_app_channel_ts ON app_event(app_id, channel, ts DESC);

-- Per-user property profiles, shallow-merged on identify (last write wins).
CREATE TABLE IF NOT EXISTS app_user_prop (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

-- Latest-value insight widgets (KPIs). num carries $inc arithmetic;
-- value is always the display string.
CREATE TABLE IF NOT EXISTS app_insight (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  num REAL,
  icon TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, title)
);

-- Custom hostnames an app serves on. A claim starts `pending` with a random
-- per-claim token and becomes `verified` once the TXT record at
-- `_noite-challenge.<hostname>` proves ownership (or immediately in `single`
-- tenancy). The edge (Caddyfile), the on-demand TLS gate and the fallback
-- page only honor `verified` rows, and only for apps that are deployed and
-- running. Several apps may hold a `pending` claim for one hostname, but
-- the first to verify wins: at most one row per hostname may be `verified`,
-- enforced by the partial unique index below.
CREATE TABLE IF NOT EXISTS app_domain (
  hostname TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified')),
  token TEXT NOT NULL DEFAULT '',
  verified_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hostname, app_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_domain_verified ON app_domain(hostname) WHERE status = 'verified';

CREATE INDEX IF NOT EXISTS idx_app_domain_app ON app_domain(app_id);

-- Sentry-compatible error ingest (ROADMAP, Error tracking phase 2): one row
-- per app holding its public ingest key and its stable numeric project id.
-- `project_id` is AUTOINCREMENT, so a deleted app's number is never reused;
-- rotating the key keeps the number. The row cascades with the app, and a
-- fresh database gets it from here while existing installs gain it in
-- migration 9.
CREATE TABLE IF NOT EXISTS app_ingest_key (
  project_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  app_id TEXT NOT NULL UNIQUE REFERENCES app(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-app edge rate limits (SPEC, Edge limits), requests per minute. NULL
-- takes the platform default (NOITE_EDGE_RPM / NOITE_EDGE_APP_RPM), 0 turns
-- the limit off. `memory_mb` overrides the platform fleet memory cap
-- (RUNNER_FLEET_MEMORY_MB) for this app; NULL takes the default. No row
-- means all defaults. A table of its own rather than columns on `app`, so
-- an existing install gains it at boot.
CREATE TABLE IF NOT EXISTS app_limit (
  app_id TEXT PRIMARY KEY NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  client_rpm INTEGER,
  app_rpm INTEGER,
  memory_mb INTEGER,
  updated_at TEXT NOT NULL
);

-- Pull requests (F4): same-repo branches only, squash-merged. `number` is
-- unique per app; at most one open PR exists per (app, base, head), which the
-- partial index enforces. `head_sha` is the head branch tip a merge would use;
-- it moves with the branch and dismisses reviews recorded at an older sha.
CREATE TABLE IF NOT EXISTS pull_request (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL,
  base TEXT NOT NULL DEFAULT 'main',
  head TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','closed','merged')),
  head_sha TEXT NOT NULL,
  merge_sha TEXT,
  merged_by TEXT,
  closed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  merged_at TEXT,
  UNIQUE (app_id, number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_request_open
  ON pull_request(app_id, base, head) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_pull_request_app ON pull_request(app_id, number DESC);

-- PR conversation. A line comment carries path/line/side and the commit_sha it
-- was written against; once that line changed in the current diff the comment
-- is shown as outdated but stays in the conversation.
CREATE TABLE IF NOT EXISTS pr_comment (
  id TEXT PRIMARY KEY NOT NULL,
  pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  side TEXT CHECK (side IN ('old','new')),
  commit_sha TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_comment_pr ON pr_comment(pr_id, created_at);

-- One review per submission; the latest per reviewer that is `approved`, not
-- dismissed and recorded at the current head counts toward the threshold.
CREATE TABLE IF NOT EXISTS pr_review (
  id TEXT PRIMARY KEY NOT NULL,
  pr_id TEXT NOT NULL REFERENCES pull_request(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved','changes_requested')),
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_review_pr ON pr_review(pr_id, created_at);

-- Per-app branch protection (off by default): with `require_pr` the push role
-- cannot move `main` directly, and a merge needs `required_approvals`.
CREATE TABLE IF NOT EXISTS app_branch_rule (
  app_id TEXT PRIMARY KEY NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  require_pr INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 0
    CHECK (required_approvals BETWEEN 0 AND 2)
);

-- Scoped bucket keys per tenant scope (SPEC, Scoped credentials): one row per
-- scope (`app:<app_id>`, `env:<env_id>`). Nonce + AES-GCM ciphertext over
-- JSON {access_key, secret_key}; the KEK derives from RUNNER_TOKEN via HKDF,
-- so the bucket snapshot is not a key dump. The plaintext columns are what
-- the runner needs without decrypting: the store handle for revocation, the
-- prefix the key reaches, which store minted it, live vs revoking.
CREATE TABLE IF NOT EXISTS scoped_credential (
  scope TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  prefix TEXT NOT NULL,
  store TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'revoking')),
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scoped_credential_app ON scoped_credential(app_id);

-- One-time telemetry replay request (SPEC, Observability). Written by
-- `noite-runner telemetry reingest` and by the migration that ships the
-- idempotent ingest; the metrics tick reads it, rewinds the in-memory
-- watermarks to `floor_us` (0 = the retention floor) for `slug` (NULL = every
-- fleet), and deletes the row once it has caught up. A row therefore survives
-- a restart mid-replay. `ingest` replaces a window's aggregates instead of
-- adding to them, so replaying an already-read window is exact.
CREATE TABLE IF NOT EXISTS telemetry_replay (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  floor_us INTEGER NOT NULL,
  slug TEXT,
  requested_at TEXT NOT NULL
);

-- Instance-level settings: key/value rows the runner owns about this install
-- (not about a tenant). `install_id` (random UUIDv4) and `installed_at` are
-- written on first boot and live in this snapshotted database, so the identity
-- survives container recreation; `telemetry_enabled` (absent = on) and
-- `telemetry_last_sent_at` back the opt-out instance heartbeat
-- (host::telemetry_report).
CREATE TABLE IF NOT EXISTS instance_setting (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
