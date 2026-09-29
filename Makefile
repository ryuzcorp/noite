# Noite: one image, one service (`noite`: runner + Caddy + control UI +
# tenant fleets) plus the bundled RustFS store. Dev runs the same service from
# the Dockerfile's `dev` target with the sources bind-mounted.

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

.PHONY: help up up-prod e2e e2e-isolation dev dev-host logs doctor backup restore down nuke usage

COMPOSE_BUILD := $(COMPOSE) -f docker/compose.build.yaml
COMPOSE_DEV := $(COMPOSE) -f docker/compose.dev.yaml
ENGINE ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)
PROJECT ?= noite
HOST_IP ?= $(shell ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($$i == "src") {print $$(i+1); exit}}')

help:
	@echo "  make up        build the image from the tree and start"
	@echo "  make up-prod   start from the GHCR release image (no build)"
	@echo "  make dev       dev: cargo watch runner + vite dev control UI, same service"
	@echo "  make dev-host  dev + control UI reachable from LAN (Host: <lan-ip>)"
	@echo "  make logs      follow the noite service + rustfs"
	@echo "  make usage     cost harness: stats delta over WINDOW s (default 600)"
	@echo "  make e2e       pre-release lane: image + doctor + Playwright (TAG=<sha> pulls GHCR)"
	@echo "  make e2e-isolation  the same lane in multi-tenant mode + hostile-tenant spec"
	@echo "  make backup    consistent backup of both volumes (brief downtime)"
	@echo "  make restore   restore a backup directory (FROM=<dir>; replaces volumes)"
	@echo "  make down      stop (keeps volumes)"
	@echo "  make nuke      stop + delete volumes + local D1/SQLite state"
	@echo ""
	@echo "UI: http://localhost:$${HTTP_PORT:-9080}  API: http://api.localhost:$${HTTP_PORT:-9080}"
	@echo "apps: http://<slug>.localhost:$${HTTP_PORT:-9080}"

# `--force-recreate`: podman-compose does not recreate a container whose image
# changed (docker compose does), so a rebuild would otherwise keep the old
# bytes running.
up:
	$(COMPOSE_BUILD) up -d --build --force-recreate
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

# Release deploy (any host): pull the image, never build. Pin NOITE_IMAGE to a
# SHA tag for reproducibility.
up-prod:
	$(COMPOSE) up -d --pull always --force-recreate

e2e:
	sh docker/e2e-local.sh

e2e-isolation:
	E2E_TENANCY=multi sh docker/e2e-local.sh

dev:
	$(COMPOSE_DEV) up -d --build --force-recreate
	@echo "dev — runner: cargo watch · control: vite dev (first boot compiles: minutes)"
	@echo "open http://localhost:$${HTTP_PORT:-9080}  (make logs)"

dev-host:
	@if [ -z "$(HOST_IP)" ]; then echo "error: could not detect LAN IP; retry as \`make dev-host HOST_IP=192.168.x.x\`"; exit 1; fi
	CONTROL_EXTRA_HOSTS="$${CONTROL_EXTRA_HOSTS:+$$CONTROL_EXTRA_HOSTS,}$(HOST_IP)" $(COMPOSE_DEV) up -d --build --force-recreate
	@echo "dev-host — control UI on LAN at http://$(HOST_IP):$${HTTP_PORT:-9080}"

logs:
	$(COMPOSE) logs -f noite rustfs

backup:
	sh docker/backup.sh $(DEST)

restore:
	@if [ -z "$(FROM)" ]; then echo "usage: make restore FROM=backups/<stamp>"; exit 1; fi
	sh docker/restore.sh $(FROM)

doctor:
	sh docker/doctor.sh

# Cost harness (spec T0.2): samples /v1/admin/stats, container stats and /data
# over WINDOW seconds (default 600) and prints one table for baselines.
usage:
	sh docker/usage.sh "$${WINDOW:-600}"

# Never destroy data on a plain stop.
down:
	-$(COMPOSE) down --remove-orphans

# Explicit nuke: every volume of this project and the e2e lane, plus local
# vite/wrangler state. `nuke` also removes the volumes by name because
# podman-compose's `down -v` aborts on the first missing container and then
# never removes named volumes.
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
