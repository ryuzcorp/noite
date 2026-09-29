-- Noite runner schema — ONE idempotent file, applied at every boot
-- (`db::connect`), with no migration ledger: every statement is
-- CREATE ... IF NOT EXISTS, so a fresh database is built and an existing one
-- is upgraded in place. Nothing to order, nothing to checksum, nothing to
-- rewrite when a table changes shape.
--
-- A table that goes away is DROPPED here (DROP TABLE IF EXISTS) rather than
-- versioned away: this file is the single source of truth for the runner's
-- shape, and leaving orphan tables around would only invite accidental reads.

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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_user ON app(user_id);

-- Deploy attempts: status + capped build/deploy log tail per push.
CREATE TABLE IF NOT EXISTS deploy (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  sha TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_app ON deploy(app_id);

-- Per-app usage metrics, edge analytics, span stats, log ring, watermarks and
-- compaction state live in metrics.sqlite (db::METRICS_SCHEMA), ATTACHed as
-- `metrics` — never in this snapshotted file (spec T4.1). Dropped here so an
-- existing database migrates its rows once (db::connect) and stops
-- dirtying `data_version` on every telemetry tick.
DROP TABLE IF EXISTS app_metric;
DROP TABLE IF EXISTS app_device_stat;
DROP TABLE IF EXISTS app_path_stat;
DROP TABLE IF EXISTS app_ref_stat;
DROP TABLE IF EXISTS metric_watermark;

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

-- Edge analytics tables (device/path/ref) also live in metrics.sqlite now;
-- see the note above. Their DDL moved to db::METRICS_SCHEMA.

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

-- Custom hostnames an app serves on. The edge (Caddyfile) and the on-demand
-- TLS gate both read this table, so a hostname is live only while its row
-- exists and its app is deployed and running. `hostname` is the primary key:
-- one app per hostname, globally.
CREATE TABLE IF NOT EXISTS app_domain (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  hostname TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_domain_app ON app_domain(app_id);

-- Telemetry watermark also lives in metrics.sqlite now (see above).

-- Scoped per-app credentials (SPEC, Scoped credentials): one encrypted row per
-- app. Nonce + AES-GCM ciphertext over JSON {access_key, secret_key}; the KEK
-- derives from RUNNER_TOKEN via HKDF, so the bucket snapshot is not a key dump.
CREATE TABLE IF NOT EXISTS app_credential (
  app_id TEXT PRIMARY KEY NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
