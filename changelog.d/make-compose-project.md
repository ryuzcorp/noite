### Fixed

- `PROJECT=<name>` now actually selects the compose project: the Makefile passes `-p $(PROJECT)` on every compose invocation (default stays `noite`), so `make dev PROJECT=x` no longer recreates the default `noite` stack. Before, `docker/compose.yaml`'s hard-coded `name: noite` won over `PROJECT` (and over `COMPOSE_PROJECT_NAME`), so a second-stack run silently recreated the first one. The file's `name:` is `${COMPOSE_PROJECT_NAME:-noite}` now — still `noite` when unset — and `make doctor`/`make backup`/`make restore` follow the same project.

### Operator action required

- None.
