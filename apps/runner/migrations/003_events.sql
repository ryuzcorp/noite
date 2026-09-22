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
