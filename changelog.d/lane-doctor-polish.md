### Added

- **Per-fleet peak RSS is logged on every fleet stop.** When the runner removes a fleet's cgroup leaf (stop, delete, teardown) it first reads that leaf's `memory.peak` and logs it at info (`fleet=… peak_bytes=…`), so per-fleet high-waters survive the leaf's deletion. The e2e lane merges those lines with the live leaves at suite end into the always-uploaded `fleet-peaks.json` (beside the human-readable `lane-stats.txt` lines) on every run — the D3 sizing basis for the default per-fleet cap.

### Fixed

- **`make doctor` no longer says "nulls ago".** Before the first state-snapshot upload `/ready` reports the upload age as JSON `null`, which the doctor line printed literally (`state snapshot (owner, last upload nulls ago)`). It now prints `no upload yet` and stays `ok` — the snapshot signal is additive and never fails `/ready`, so a fresh boot with nothing uploaded yet is normal, not degraded.
