-- Per-app usage metrics (requests from the Caddy access log, CPU time
-- sampled from the fleet process). Minute-bucketed, UTC text keys sortable.
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