# Local stack

How the local stack is built and driven. Read before running or debugging it.

## Stack targets

The stack runs via **rootless podman**:

- `make up` — the `noite` service built from the tree (`compose.build.yaml`) + `rustfs`; `make up-prod` — the base `compose.yaml`, pulls the release image; `make dev` — the same service from the Dockerfile's `dev` target with the sources bind-mounted (`docker/dev.sh`: cargo-watch runner + `vite dev` on `127.0.0.1:8090`, where the control fleet would be).
- `make logs`, `make doctor` (`/ready` and its failing gates, API auth, edge, control auth, Cello control node), `make down` (keeps volumes), `make nuke` (every local database: the project's volumes + local `.wrangler`/`.void` D1/SQLite). `nuke` removes containers by project label and volumes by name as well as via `down -v` because podman-compose's `down -v` aborts on the first missing container and then never removes named volumes — which left the runner's SQLite (every app row) in place and the next `apps.create` answered `409 slug already taken`. BYO S3 installs (`--scale rustfs=0`) keep their objects outside compose: delete them at the provider.
  - `make up`/`make dev` pass `--force-recreate` on purpose: podman-compose does **not** recreate a container whose image changed (`docker compose` does), so an image rebuild would otherwise silently keep the old bytes running.
  - `PROJECT=<name>` (default `noite`) selects the compose project of every target that touches one (`up`, `up-prod`, `dev`, `dev-host`, `logs`, `down`, `nuke`, `doctor`, `backup`, `restore`) and the Makefile always passes `-p $(PROJECT)` — a compose file's `name:` beats `COMPOSE_PROJECT_NAME`, so without the flag `PROJECT` was silently ignored and `make dev PROJECT=x` recreated the default stack. The name is validated once (`^[a-z0-9][a-z0-9_-]*$`, `$(error)` otherwise) because it becomes an engine argv, and `COMPOSE` cannot be overridden (`COMPOSE_CMD` picks the engine) so no override can drop `-p`. `docker/compose.yaml`'s `name:` is `${COMPOSE_PROJECT_NAME:-noite}` (the default for direct `docker compose -f …` use); `docker/backup.sh`/`docker/restore.sh`/`docker/doctor.sh` follow `PROJECT`, and the e2e lanes keep their own `-p noite-e2e[-<slot>]` in `docker/e2e-local.sh`.
- `up`/`dev` build with cache every run, so no separate build targets.

## Rebuild semantics

`make dev` rebuild: image changes need `make dev` again (`--force-recreate`); source changes reload by themselves (cargo-watch, vite), except **mount path** changes, which need the container recreated.

## Probing the live stack

**The live stack is reachable from this machine**: probe the runner via `curl -H "Host: api.noite.localhost" -H "Authorization: Bearer $RUNNER_TOKEN" http://127.0.0.1:9080/...` (token from `.env`). Fleet telemetry Parquet can be read in place (`apps/runner/src/host/metrics/plan.rs` owns the prefix mapping).
