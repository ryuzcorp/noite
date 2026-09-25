# Noite — two modes. Installs run the same 4 services either way: rustfs,
# runner, control (Oxide UI on a celld node), caddy. Dev only swaps the two
# control-plane processes for bind-mounted dev servers (docker/compose.dev.yaml).

# Both docker compose and podman-compose resolve host paths in these files
# relative to the first -f file's directory (docker/), so no
# --project-directory flag (which podman-compose rejects outright).
COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo 'docker compose' || echo 'podman compose') -f docker/compose.yaml

-include .env
export

# NOTE: keep conditionals in quoted form and avoid `$(if …)` — the repo linter
# runs shellcheck in bash mode on Makefiles, where `$(if …)` parses as an if-
# expression inside command substitution and aborts all later checks. Quoted
# conditionals and `$(or $(and …))` exports are equally valid GNU make syntax
# and stay parseable.
# pi-lens-ignore: shellcheck-14-1073
# pi-lens-ignore: shellcheck-14-1050
# pi-lens-ignore: shellcheck-14-1072
 .PHONY: help up up-prod e2e dev dev-host logs doctor backup restore down nuke

 COMPOSE_DEV := $(COMPOSE) -f docker/compose.dev.yaml

 # `COMPOSE` may resolve to either CLI, and `nuke` has to remove volumes with
 # the same engine the stack ran on.
 ENGINE ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)

 # Compose project name. Volumes are `<PROJECT>_<name>`; the e2e lane runs the
 # same files under `noite-e2e`, so both prefixes get cleaned.
 PROJECT ?= noite

 # LAN IP for `dev-host`: source IP of the default route (the interface LAN
 # peers reach). Override when detection fails (no `ip` route, VPN, multi-NIC):
 # `make dev-host HOST_IP=192.168.1.50`.
 HOST_IP ?= $(shell ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($$i == "src") {print $$(i+1); exit}}')

help:
	@echo "  make up    production stack (builds both images from the tree)"
	@echo "  make up-prod  production stack from GHCR release images (no build)"
	@echo "  make dev   dev processes (cargo-watch runner + vite dev control)"
	@echo "  make dev-host  dev + control UI reachable from LAN (Host: <lan-ip>)"
	@echo "  make logs  follow runner + control + rustfs + caddy"
	@echo "  make e2e   pre-release check: full stack + deploy + doctor + Playwright (TAG=<sha> to pull GHCR)"
	@echo "  make backup    consistent backup of every data volume (brief downtime)"
	@echo "  make restore   restore a backup directory (FROM=<dir>; replaces volumes)"
	@echo "  make down  stop stack (keeps data volumes)"
	@echo "  make nuke  stop stack + delete volumes + local D1/SQLite state"
	@echo ""
	@echo "UI: http://localhost:9080  API: http://api.localhost:9080"
	@echo "apps: http://<slug>.localhost:9080"

# --build runs on every up: cached layers make it a no-op when nothing
# changed, and it ends the entire stale-image bug class (no separate
# build/rebuild/restart targets to remember). --force-recreate is part of the
# same guarantee: podman-compose does NOT recreate a container whose image
# changed (`docker compose` does), so `make up` after an image rebuild would
# silently keep the old bytes running.
up:
	$(COMPOSE) up -d --build --force-recreate rustfs runner control caddy
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

# Release deploy (any cloud VM/host): pull the release images, never build.
# Pin with NOITE_RUNNER_IMAGE / NOITE_CONTROL_IMAGE at a SHA for
# reproducibility (`:stable` once the first v* tag exists).
up-prod:
	NOITE_RUNNER_IMAGE=$${NOITE_RUNNER_IMAGE:-ghcr.io/ryuzcorp/noite:latest} NOITE_CONTROL_IMAGE=$${NOITE_CONTROL_IMAGE:-ghcr.io/ryuzcorp/noite-control:latest} $(COMPOSE) up -d --pull always --force-recreate rustfs runner control caddy

# Pre-release check (manual — no CI e2e): boot the stack, doctor, deploy the
# sample app, Playwright. TAG=<short-sha> pins the release images.
e2e:
	sh docker/e2e-local.sh

dev:
	$(COMPOSE_DEV) up -d --build --force-recreate rustfs runner control caddy
	@echo "dev — runner: cargo watch · control: vite dev + watch"
	@echo "open http://localhost:$${HTTP_PORT:-9080}  (make logs)"

 # Same as dev, plus the host LAN IP joins the control site so phones/other
 # machines on the network get the UI at http://<lan-ip>:9080. Caddy matches
 # the Host header, so `localhost` sites alone 404 a LAN peer — the runner
 # rewrites the Caddyfile on its next reconcile (<= RUNNER_POLL_MS).
 # NOTE: `make dev --host` is not valid make syntax (`--host` parses as a make
 # option); this target is the equivalent.
 # For passkeys over the LAN you need https://noite.local (portless) — the
 # full runbook is README.md `LAN access (dev)`.
dev-host:
	@if [ -z "$(HOST_IP)" ]; then echo "error: could not detect LAN IP; retry as \`make dev-host HOST_IP=192.168.x.x\`"; exit 1; fi
	CONTROL_EXTRA_HOSTS="$${CONTROL_EXTRA_HOSTS:+$$CONTROL_EXTRA_HOSTS,}$(HOST_IP)" $(COMPOSE_DEV) up -d --build --force-recreate rustfs runner control caddy
	@echo "dev-host — control UI on LAN at http://$(HOST_IP):$${HTTP_PORT:-9080}"
logs:
	# Caddy per-request lines live in the shared access.log (device stats),
	# not stdout: `podman exec noite_caddy_1 tail -f /etc/caddy/access.log`.
	$(COMPOSE) logs -f runner control rustfs caddy

# Consistent backup: VACUUM the runner database, stop the stack for a quiesced
# volume copy, tar every data volume, start again. See docker/backup.sh.
backup:
	sh docker/backup.sh $(DEST)

# Destructive: replaces the current volumes with the backup's. See
# docker/restore.sh.
restore:
	@if [ -z "$(FROM)" ]; then echo "usage: make restore FROM=backups/<stamp>"; exit 1; fi
	sh docker/restore.sh $(FROM)

# Codified tribal checks: stack up, runner healthy + reconciled, API auth,
# rustfs live, control UI serving, celld node health + fleet diagnose. Exit
# nonzero naming the failing check.
doctor:
	sh docker/doctor.sh
# Never destroy data on a plain stop — volumes hold all state (runner-data:
# SQLite + git mirrors + builds; rustfs-data; control-state; caddy-data;
# caddy-config).
down:
	-$(COMPOSE) down --remove-orphans

# Explicit nuke — use only when you mean to wipe everything: all volumes
# (runner SQLite, git mirrors, fleet bucket, celld state, caddy) plus local
# miniflare state (.wrangler holds the dev D1/SQLite outside any volume).
#
# `compose down -v` alone is not enough here. podman-compose aborts on the first
# container it cannot find ("no container with name or ID …") and never reaches
# its volume loop, so a stack that was already stopped keeps `runner-data`
# (every app row — the 409 "slug already taken" on the next deploy) and
# `rustfs-data` (the fleet bucket, git mirrors and the control D1 with its user
# accounts). The explicit removal below is the part that must not be skipped.
#
# With the external-S3 overlay (`compose.byob.yaml`) the bucket lives outside
# compose: nuke still clears the local volumes, but the remote objects — and the
# control D1 in them — have to be deleted at the S3 provider.
nuke:
	-$(COMPOSE_DEV) down -v --remove-orphans
	-$(COMPOSE) down -v --remove-orphans
	-$(COMPOSE) -p noite-e2e -f docker/compose.e2e.yaml down -v --remove-orphans
	@for p in $(PROJECT) noite-e2e; do \
	  for k in com.docker.compose.project io.podman.compose.project; do \
	    ids=$$($(ENGINE) ps -aq --filter label=$$k=$$p); [ -z "$$ids" ] || $(ENGINE) rm -f $$ids; \
	  done; \
	  vols=$$($(ENGINE) volume ls -q --filter name=^$${p}_); [ -z "$$vols" ] || $(ENGINE) volume rm -f $$vols; \
	done
	rm -rf apps/noite/.wrangler
