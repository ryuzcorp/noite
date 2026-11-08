### Fixed

- A create whose runner call outlives the control plane's bound now adopts the row the detached runner task lands and grants it; the app list also heals an app left with no grant at all by an earlier timeout. A slow create can no longer leave an app that no one can see or delete.
- A build pinned at its cgroup `memory.max` under sustained memory pressure now fails after ~30 s with the budget error (raise `RUNNER_BUILD_MEMORY_MB` or deploy a prebuilt dist) instead of reclaiming until the step timeout, which starved the whole install.
