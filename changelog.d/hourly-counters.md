### Added

- Hourly per-fleet counters in `metrics.sqlite`, the DuckDB-free replacement for the minute buckets: `app_hour` keeps one row per `(app, environment, hour)` with requests, 5xx errors, p50/p95 latency, peak and mean memory, CPU time and the newest request stamp, and `app_hour_lat` keeps the fixed log-scale latency histogram the percentiles are derived from. Requests, errors and latency come from the Caddy access log (`duration`/`status` on the line the error index already tails), memory from each fleet's cgroup charge sampled every tick (peak and mean, `_control` included), CPU from the existing `/proc` sampler. Writes replace the fleet's open hour instead of incrementing it, the access-log offset still advances only after a line's rows commit, and the rows are pruned with `RUNNER_TELEMETRY_RETENTION_DAYS`. Write-only for now: no route or UI reads these tables yet.

### Operator action required

- None.
