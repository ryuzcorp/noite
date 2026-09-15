-- Drillo agent schema (control plane; no Better Auth in v1)
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
