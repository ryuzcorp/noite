### Fixed

- A tenant build can no longer make the host unresponsive. The build cgroup leaf now gets a hard `cpu.max` quota of one core less than the box, split across concurrent build slots (a 2 vCPU VPS keeps a core for the runner, RustFS, Caddy, the fleets and SSH) and a low `io.weight`, alongside the existing memory cap. The derived memory budget also leaves a real resident floor: previously half the box (~955 MiB on 2 GB, where RustFS alone measured ~575 MB and the runner plus fleets another ~400 MB), so the build pushed the host into reclaim and SSH stopped answering; now a 2 GB box derives 512 MiB and a build that needs more dies in its own leaf with the deploy-log message naming `RUNNER_BUILD_MEMORY_MB`. The default per-step timeout is 600 s (was 300) for builds that fit the cap on a single core. A build that cannot fit a small box is the CI/prebuilt-dist path.

### Operator action required

- A 2 GB install can no longer build the ~1.3 GiB Void/Ilha template while serving; raise `RUNNER_BUILD_MEMORY_MB` on a box with the RAM or deploy a prebuilt dist.
