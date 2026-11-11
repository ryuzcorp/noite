### Fixed

- **Telemetry compaction no longer silently loses an hour.** A failed fold is tracked and retried independently instead of advancing the per-fleet watermark past it; a second `noite-runner telemetry reingest` is no longer dropped, because the replay row is cleared only for the request that was applied; and a line's access-log counters commit with its error-request backfill, advancing the offset only after they commit, so stats are not double counted after a mid-loop database error.
- **A live stream now reaches a terminal state.** A topic that never delivers a first frame, or stops delivering frames for a minute after its first, ends with an error instead of staying open and silently stale.
