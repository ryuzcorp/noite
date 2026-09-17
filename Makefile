# Compose — run from repo root.

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
ifneq "$(wildcard /run/.containerenv)" ""
  DISTROBOX ?= 1
endif
ifdef DISTROBOX
  export LD_LIBRARY_PATH := /run/host/usr/lib:/run/host/usr/lib64$(or $(and $(LD_LIBRARY_PATH),:$(LD_LIBRARY_PATH)),)
  export XDG_DATA_HOME := /home/$(USER)/.local/share
  export XDG_CONFIG_HOME := /home/$(USER)/.config
  export PYTHONPATH := /run/host/usr/lib/python3.14/site-packages$(or $(and $(PYTHONPATH),:$(PYTHONPATH)),)
  export PATH := $(CURDIR)/docker/bin:$(PATH)
  export PODMAN_SOCK := /run/user/$(shell id -u)/podman/podman.sock
endif

.PHONY: help up up-byob down reset logs rebuild restart deploy-test dev dev-build dev-joint

COMPOSE_DEV := $(COMPOSE) -f docker/compose.dev.yaml
COMPOSE_DEV_JOINT := $(COMPOSE) -f docker/compose.dev-joint.yaml
COMPOSE_BYOB := $(COMPOSE) -f docker/compose.byob.yaml

help:
	@echo "  make up          start stack (release runner + Oxide UI)"
	@echo "  make up-byob     start stack against external S3 (no rustfs)"
	@echo "  make dev         hot reload, no rebuild (runner cargo-watch + Oxide Vite)"
	@echo "  make dev-build   rebuild dev images (Dockerfile/toolchain changes only)"
	@echo "  make dev-joint   prod joint topology with dev processes (catches joint-only bugs)"
	@echo "  make logs        follow runner + ui + rustfs + caddy"
	@echo "  make down        stop stack (keeps data volumes)"
	@echo "  make reset       stop + delete all volumes (data loss!)"
	@echo "  make rebuild     rebuild runner (+ tools) images"
	@echo "  make restart     recreate runner + ui (keeps volumes)"
	@echo "  make deploy-test push apps/noite/test via Git HTTP → deploy"
	@echo ""
	@echo "UI: http://localhost:9080  API: http://api.localhost:9080"
	@echo "apps: http://<slug>.localhost:9080"

up:
	$(COMPOSE) build runner ui
	$(COMPOSE) up -d rustfs runner ui caddy
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

# BYOB: external S3 (no bundled rustfs). Requires S3_ENDPOINT,
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_PUBLIC_ENDPOINT in env.
up-byob:
	$(COMPOSE_BYOB) build runner ui
	$(COMPOSE_BYOB) up -d runner ui caddy
	@echo "open http://localhost:$${HTTP_PORT:-9080}"

dev:
	# No build, no force-recreate: images change rarely, source is bind-
	# mounted and HMR/watch pick up edits. Use dev-build when Dockerfiles
	# or toolchains change.
	$(COMPOSE_DEV) up -d rustfs runner caddy ui
	@echo "dev — runner: cargo watch · ui: Vite HMR + passkeys"
	@echo "open http://localhost:$${HTTP_PORT:-9080}  (make logs)"

dev-build:
	$(COMPOSE_DEV) build runner ui
	$(COMPOSE_DEV) up -d --force-recreate runner ui

dev-joint:
	# Prod joint topology (runner :8080 + UI :8081, one container, joint
	# DB layout) with dev processes. RUNNER_DEV_RELEASE=1 for release-mode
	# runner, VITE_USE_POLLING=1 for flaky rootless inotify.
	$(COMPOSE_DEV_JOINT) up -d
	@echo "dev-joint — cargo watch + Vite HMR in prod topology"
	@echo "open http://localhost:$${HTTP_PORT:-9080}  (make logs)"

logs:
	$(COMPOSE) logs -f runner ui rustfs caddy

# Never destroy data on a plain stop — agent-data holds the runner SQLite,
# git mirrors and fleet state; ui-data holds the control DB.
down:
	-$(COMPOSE) down --remove-orphans

# Explicit nuke — use only when you mean to wipe every volume.
reset:
	-$(COMPOSE) down -v --remove-orphans

rebuild:
	# Serialized: podman-compose builds services in parallel and the
	# cargo-release + vite combination OOMs; each builds fine alone.
	$(COMPOSE) build --no-cache runner
	$(COMPOSE) build --no-cache ui
	$(COMPOSE) up -d --force-recreate runner ui
	$(COMPOSE) up -d caddy

restart:
	$(COMPOSE) up -d --force-recreate runner ui
	$(COMPOSE) up -d caddy

deploy-test:
	@chmod +x apps/noite/test/deploy.sh
	./apps/noite/test/deploy.sh