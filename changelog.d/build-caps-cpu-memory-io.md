### Fixed

- A tenant build can no longer make the host unresponsive. The build cgroup leaf now gets a hard `cpu.max` quota of one core less than the box, split across concurrent build slots (a 2 vCPU VPS keeps a core for the runner, RustFS, Caddy, the fleets and SSH) and a low `io.weight`, alongside the existing memory cap. The derived memory budget now leaves a 1 GiB resident floor (RustFS, runner, fleets): a 2 GB box gives one build ~933 MiB, enough for the measured ~610-650 MB Void debug build, instead of half the box with no headroom. The RustFS scanner and healer are slowed to daily/one-at-a-time so they do not compete with a build for CPU and disk, and the per-step timeout is 1800 s (was 300) so a build on one core can finish in the background, and the telemetry tick is skipped while a deploy is building (spans stay in the bucket; the next tick catches up) so DuckDB does not compete for the build's CPU and disk. A 1.3 GiB template build still dies in its leaf with the named budget; that is the prebuilt/CI path.

### Operator action required

- A 2 GB install builds the ~610-650 MB Void debug app; the ~1.3 GiB Void/Ilha template still needs a bigger box or a prebuilt dist.
