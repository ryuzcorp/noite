### Added

- Memory-pressure parking: when the container is at or above `RUNNER_PRESSURE_PCT` (85%) of its detected limit, the runner parks the least-recently-active app idle for `RUNNER_PRESSURE_IDLE_S` (300 s), stopping 10 points below the trigger. The app wakes transparently on its next request and records a `fleet parked` event; an app with an in-flight deploy is never chosen. `0` disables it. `/ready` and `/v1/admin/stats` now report container `current_bytes`/`limit_bytes`/`used_percent`, and stats lists each fleet's cgroup charge under `fleet_memory`.

### Fixed

- A fleet that exits without an OOM kill no longer respawns every reconcile tick forever: it backs off 5, 10, 20, 40 s and caps at 60 s, resetting after five minutes of uptime. OOM kills keep their longer cgroup backoff, and a deliberate stop clears the chain.
- The per-fleet log ring is a `VecDeque`: appending no longer shifted the whole 500-line buffer per line. `/ready` reuses one HTTP client instead of building a new pool every 10 s probe.
