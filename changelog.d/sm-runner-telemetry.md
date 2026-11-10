### Fixed

- Telemetry compaction no longer skips an hour whose fold failed: a transient S3/DuckDB error used to advance the per-fleet watermark past that hour, so its spans and logs were never folded and dashboards silently lost the hour. Each hour is now tracked and retried independently.
- `noite-runner telemetry reingest` is no longer silently dropped when a second replay is queued while the runner is already rewinding: the replay row is cleared only for the request that was actually applied.
- Access-log stats are no longer double counted after a mid-loop database error: a line's device/path/referrer counters and its error-request backfill now commit together, and the log offset advances only after they commit.
- Live streams now reach a terminal state: a topic that never delivers a first frame, or stops delivering frames for a minute after its first one, ends with an error instead of staying open and silently stale.

### Changed

- The telemetry ingest/compaction, replay, access-log tail, SSE stream, opt-out update check and heartbeat, instance readiness, and git mirror/ref-move lifecycles are now explicit state machines with one transition function and a state table in their module docs. Wire payloads (`UpdateStatus`, `TelemetryStatus`, `/ready`, SSE frames, CLI output) are unchanged.
