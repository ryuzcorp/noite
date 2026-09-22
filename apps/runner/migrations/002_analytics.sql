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
