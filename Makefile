# Noite — two modes: prod runs 3 services (rustfs, control, caddy; the
# runner is a container cell of the control worker), dev keeps 4
# (bind-mounted cargo-watch runner; see docker/compose.dev.yaml):

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
 .PHONY: help up up-prod dev dev-host logs doctor down nuke

 COMPOSE_DEV := $(COMPOSE) -f docker/compose.dev.yaml

 # LAN IP for `dev-host`: source IP of the default route (the interface LAN
 # peers reach). Override when detection fails (no `ip` route, VPN, multi-NIC):
 # `make dev-host HOST_IP=192.168.1.50`.
 HOST_IP ?= $(shell ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($$i == "src") {print $$(i+1); exit}}')

help:
	@echo "  make up    production stack (release images)"
	@echo "  make up-prod  production stack from GHCR (no build; any cloud VM)"
	@echo "  make dev   dev processes (cargo-watch runner + vite dev control)"
	@echo "  make dev-host  dev + control UI reachable from LAN (Host: <lan-ip>)"
	@echo "  make logs  follow control + rustfs + caddy"
	@echo "  make down  stop stack (keeps data volumes)"
	@echo "  make nuke  stop stack + delete volumes + local D1/SQLite state"
	@echo ""
	@echo "UI: http://localhost:9080  API: http://api.localhost:9080"
	@echo "apps: http://<slug>.localhost:9080"

# --build runs on every up: cached layers make it a no-op when nothing
# changed, and it ends the entire stale-image bug class (no separate
# build/rebuild/restart targets to remember).
up:
	$(COMPOSE) up -d --build rustfs control caddy
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

# CI e2e (Playwright): prod stack plus the engine socket + repo mounts the
# runner container cell needs (celld builds Dockerfile.runner-container
# through the mounted daemon at `celld deploy` time). CI-only — local prod
# installs use `up` / `up-prod` (+ standalone.ts for the socket mount).
up-e2e:
	$(COMPOSE) -f docker/compose.e2e.yaml up -d --build rustfs control caddy
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

# Release deploy (any cloud VM): pull the GHCR image, never build. Pin with
# NOITE_RUNNER_IMAGE=ghcr.io/ryuzcorp/noite:<sha> for reproducibility
# (:stable does not exist yet — first v* tag/release creates it).
up-prod:
	NOITE_RUNNER_IMAGE=$${NOITE_RUNNER_IMAGE:-ghcr.io/ryuzcorp/noite:latest} $(COMPOSE) up -d --pull always rustfs control caddy

dev:
	$(COMPOSE_DEV) up -d --build rustfs runner control caddy
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
	CONTROL_EXTRA_HOSTS="$${CONTROL_EXTRA_HOSTS:+$$CONTROL_EXTRA_HOSTS,}$(HOST_IP)" $(COMPOSE_DEV) up -d --build rustfs runner control caddy
	@echo "dev-host — control UI on LAN at http://$(HOST_IP):$${HTTP_PORT:-9080}"
logs:
	# Caddy per-request lines live in the shared access.log (device stats),
	# not stdout: `podman exec noite_caddy_1 tail -f /etc/caddy/access.log`.
	$(COMPOSE) logs -f control rustfs caddy

# Codified tribal checks: stack up, runner healthy + reconciled, API auth,
# rustfs live, control UI serving. Exit nonzero naming the failing check.
doctor:
	sh docker/doctor.sh
# Never destroy data on a plain stop — volumes hold all state (dev
# agent-data: runner SQLite, git mirrors, builds; control-state, rustfs-data,
# caddy-data in both stacks).
down:
	-$(COMPOSE) down --remove-orphans

# Explicit nuke — use only when you mean to wipe everything: all volumes
# (runner SQLite, git mirrors, fleet state, caddy) plus local miniflare
# state (.wrangler holds the dev D1/SQLite outside any volume).
nuke:
	-$(COMPOSE_DEV) down -v --remove-orphans
	-$(COMPOSE) down -v --remove-orphans
	rm -rf apps/noite/.wrangler
