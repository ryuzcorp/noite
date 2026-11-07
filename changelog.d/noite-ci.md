### Added

- Noite CI: a repo-root `noite.ci.yaml` (a light GitHub-Actions subset: `jobs`, `steps`, `run`, `env`, `working-directory`, `timeout-minutes`, optional `image`) runs in a container per job instead of the built-in install/build. The workflow's `dist/` is the deploy root; a failure fails the deploy before release/activate, so the live version keeps serving. Containers are cap-dropped, no-new-privileges, memory/CPU/pids-capped, no host binds, no Docker socket inside, and the checkout is copied in/out with `docker cp`; `HOME` and package caches persist in a per-app named volume. Images are an exact allowlist (`RUNNER_CI_IMAGE`, `RUNNER_CI_IMAGES`), network `bridge` or `none`, kill switch `RUNNER_CI=0`. Bounded: 64 KiB config, 32 jobs/steps, 32 KiB scripts, 120 min/step.

### Operator action required

- Apps with a `noite.ci.yaml` now run it instead of the built-in install/build. Standard installs need nothing: the runner already has the Docker socket and pulls the default image on first use. CI containers consume the host's memory and CPU like the built-in build, so a 2 GB box still cannot build the 1.3 GiB template; use a bigger box or a prebuilt dist.
