### Fixed

- The memory-pressure parking sweep now measures what the kernel OOM killer does on an unbounded install: the host's used memory (`MemTotal - MemAvailable`) instead of this container's own `memory.current`. The bundled RustFS runs in its own container and the runner's cgroup is unbounded on the default compose, so the old check read ~20% while the box sat near 75%; the last guard before the OOM killer never fired and idle apps were never parked. Bounded installs (a container `mem_limit`) keep measuring their own cgroup. `/ready` and `/v1/admin/stats` now carry `memory.scope` (`container` or `host`) alongside the existing bytes and percent.

### Operator action required

- None.
