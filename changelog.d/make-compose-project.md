### Fixed

- `PROJECT=<name>` now actually selects the compose project: the Makefile passes `-p $(PROJECT)` on every compose invocation (default stays `noite`), so `make dev PROJECT=x` no longer recreates the default `noite` stack. Before, `docker/compose.yaml`'s hard-coded `name: noite` won over `PROJECT` (and over `COMPOSE_PROJECT_NAME`), so a second-stack run silently recreated the first one. The file's `name:` is `${COMPOSE_PROJECT_NAME:-noite}` now — still `noite` when unset — and the name is validated once (lowercase `a-z`, `0-9`, `-`, `_`), so a stray value fails before it becomes an engine flag. `COMPOSE` is no longer overridable (an operator sets `COMPOSE_CMD`), `make doctor`/`make backup`/`make restore` follow the same project (a backup snapshots that project's own runner, and refuses rather than guess when it cannot find it), and `docker/uninstall.sh` honours `PROJECT`/`COMPOSE_PROJECT_NAME` and prints the project it will remove (refusing when that project has no stack), with `run.sh` forwarding both through `sudo`.

### Operator action required

- None.
