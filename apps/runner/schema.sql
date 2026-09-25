-- Noite runner schema — ONE idempotent file, applied at every boot
-- (`db::connect`), with no migration ledger: every statement is
-- CREATE ... IF NOT EXISTS, so a fresh database is built and an existing one
-- is upgraded in place. Nothing to order, nothing to checksum, nothing to
-- rewrite when a table changes shape. The old four-file `migrations/` history
-- (and its `_sqlx_migrations` ledger) is retired below.
--
-- Retired tables are DROPPED here rather than versioned away: this file is the
-- single source of truth for the runner's shape, and the runner is the only
-- copy of deploy metadata, so leaving orphan tables around would only invite
-- accidental reads.

-- Apps: one row per tenant app. Hard DELETE is the only remove path (legacy
-- soft-delete rows are reclaimed at boot; see `reclaim_legacy_soft_deletes`).
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

-- Per-app fleet credentials (`kind = 'fleet'`): legacy scoped S3 keys for a
-- tenant's celld fleet, minted by the retired Bun host plane. The supervisor
-- still honours an existing row (host/supervisor.rs) and otherwise uses the
-- root keys; nothing mints new ones.
CREATE TABLE IF NOT EXISTS app_secret (
  id TEXT PRIMARY KEY NOT NULL,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  access_key TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  revealed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_secret_app ON app_secret(app_id);

-- Retired `kind = 'git_push'` rows (Git auth is profile API keys + collaborator
-- checks via the control UI). No-op once cleared.
DELETE FROM app_secret WHERE kind = 'git_push';

-- Ledger of the retired multi-file migrator.
DROP TABLE IF EXISTS _sqlx_migrations;

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

-- Per-app usage metrics (requests from celld OTel spans, CPU time sampled
-- from the fleet process). Minute-bucketed, UTC text keys sortable.
CREATE TABLE IF NOT EXISTS app_metric (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  bucket_ts TEXT NOT NULL,          -- start-of-minute ISO-8601 UTC
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts)
);

CREATE INDEX IF NOT EXISTS idx_app_metric_app_bucket ON app_metric(app_id, bucket_ts);

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

-- Edge analytics from the Caddy access log (see host/accesslog): device
-- browsers + OS, visited paths, referrer sources. Only aggregates are
-- stored — never raw user-agents, client IPs, query strings, or full
-- referrer URLs. Hour-bucketed UTC text keys, like app_metric.
CREATE TABLE IF NOT EXISTS app_device_stat (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  bucket_ts TEXT NOT NULL,          -- start-of-hour ISO-8601 UTC
  browser TEXT NOT NULL,
  os TEXT NOT NULL,                 -- '' when undetected, shown as Unknown
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, browser, os)
);

CREATE INDEX IF NOT EXISTS idx_app_device_stat_app_bucket ON app_device_stat(app_id, bucket_ts);

CREATE TABLE IF NOT EXISTS app_path_stat (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  bucket_ts TEXT NOT NULL,          -- start-of-hour ISO-8601 UTC
  path TEXT NOT NULL,               -- request path, query stripped
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, path)
);

CREATE INDEX IF NOT EXISTS idx_app_path_stat_app_bucket ON app_path_stat(app_id, bucket_ts);

CREATE TABLE IF NOT EXISTS app_ref_stat (
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  bucket_ts TEXT NOT NULL,          -- start-of-hour ISO-8601 UTC
  source TEXT NOT NULL,             -- 'Direct', network/engine name, or host
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, source)
);

CREATE INDEX IF NOT EXISTS idx_app_ref_stat_app_bucket ON app_ref_stat(app_id, bucket_ts);

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

-- Telemetry watermark: slug -> last consumed span start (unix micros).
-- Written after bucket persist each metrics tick, so a restart resumes
-- aggregation instead of double-counting.
CREATE TABLE IF NOT EXISTS metric_watermark (
  slug TEXT PRIMARY KEY NOT NULL,
  after_us INTEGER NOT NULL
);
