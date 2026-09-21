-- Noite runner schema, single migration (fresh DBs only; old multi-file
-- history was compacted, so pre-existing databases must be reset).
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
