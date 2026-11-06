### Changed

- A small host now sizes the resident set from its own memory: per-fleet celld caches are capped (`RUNNER_FLEET_LOCAL_CACHE_MB`, a sixteenth of the box clamped 64–512 MiB; celld's own default was 2 GiB per node), the control fleet gets its own capped cgroup leaf (`RUNNER_CONTROL_MEMORY_MB`, a quarter of the box) instead of running uncapped, and fleets without cgroup leaves get a derived container-wide shed threshold (75% of the box) so celld answers 503 before the kernel OOM-kills the container.
- Cold boots ramp instead of stacking: `RUNNER_FLEET_SPAWN_BATCH` starts at most one cold fleet per reconcile pass on two cores or fewer, and `RUNNER_BUILD_CONCURRENCY` serializes tenant deploys. Restarts of an already-running fleet are never delayed by either.
