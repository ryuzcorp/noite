CREATE TABLE IF NOT EXISTS metrics.app_metric (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cpu_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_metric_app_bucket ON app_metric(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_device_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, browser, os)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_device_stat_app_bucket ON app_device_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_path_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  path TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, path)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_path_stat_app_bucket ON app_path_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.app_ref_stat (
  app_id TEXT NOT NULL,
  bucket_ts TEXT NOT NULL,
  source TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_ts, source)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_ref_stat_app_bucket ON app_ref_stat(app_id, bucket_ts);
CREATE TABLE IF NOT EXISTS metrics.metric_watermark (
  slug TEXT PRIMARY KEY NOT NULL,
  after_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics.app_span_stat (
  app_id TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  name TEXT NOT NULL,
  kind INTEGER NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  err INTEGER NOT NULL DEFAULT 0,
  qwait_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_hour, name, kind)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_span_stat_app_hour ON app_span_stat(app_id, bucket_hour);
CREATE TABLE IF NOT EXISTS metrics.app_log (
  app_id TEXT NOT NULL,
  ts_us INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_log_app_ts ON app_log(app_id, ts_us);
CREATE TABLE IF NOT EXISTS metrics.metric_compaction (
  slug TEXT NOT NULL,
  hour TEXT NOT NULL,
  compacted_at TEXT NOT NULL,
  PRIMARY KEY (slug, hour)
);
CREATE TABLE IF NOT EXISTS metrics.metric_version (
  app_id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS metrics.app_error_issue (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  culprit TEXT NOT NULL DEFAULT '',
  handler TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'uncaught',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_us INTEGER NOT NULL,
  last_seen_us INTEGER NOT NULL,
  first_sha TEXT,
  last_sha TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  regressed INTEGER NOT NULL DEFAULT 0,
  status_at_us INTEGER,
  PRIMARY KEY (app_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_issue_app_last ON app_error_issue(app_id, last_seen_us);
CREATE TABLE IF NOT EXISTS metrics.app_error_event (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  ts_us INTEGER NOT NULL,
  trace_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'uncaught',
  handler TEXT NOT NULL DEFAULT '',
  cell TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  frames TEXT NOT NULL DEFAULT '[]',
  logs TEXT NOT NULL DEFAULT '[]',
  method TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  http_status INTEGER NOT NULL DEFAULT 0,
  browser TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  sha TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_event_issue_ts ON app_error_event(app_id, fingerprint, ts_us);
CREATE TABLE IF NOT EXISTS metrics.app_error_hour (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  bucket_hour TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, fingerprint, bucket_hour)
);
CREATE INDEX IF NOT EXISTS metrics.idx_app_error_hour_app_hour ON app_error_hour(app_id, bucket_hour);
