-- Telemetry watermark: slug -> last consumed span start (unix micros).
-- Written after bucket persist each metrics tick; rides the SQLite snapshot
-- the R2 relay carries, so restarts resume aggregation instead of resetting.
CREATE TABLE IF NOT EXISTS metric_watermark (
  slug TEXT PRIMARY KEY NOT NULL,
  after_us INTEGER NOT NULL
);
