# Compose — run from repo root.

COMPOSE ?= $(shell command -v docker >/dev/null 2>&1 && echo 'docker compose' || echo 'podman compose')

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

.PHONY: help up down reset logs rebuild restart deploy-test dev

COMPOSE_DEV := $(COMPOSE) -f compose.yaml -f compose.dev.yaml

help:
	@echo "  make up          start stack (release runner + Oxide UI)"
	@echo "  make dev         hot reload (runner cargo-watch + Oxide Vite)"
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

dev:
	$(COMPOSE_DEV) build runner ui
	$(COMPOSE_DEV) up -d rustfs runner caddy
	# The ui container bind-mounts ./apps/noite: compose skips a recreate
	# when the image id is unchanged, so the UI would keep running stale
	# source. Force it here so every `make dev` starts with fresh code.
	$(COMPOSE_DEV) up -d --no-deps --force-recreate ui
	@echo "dev — runner: cargo watch · ui: Vite HMR + passkeys"
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
	$(COMPOSE) build --no-cache runner ui
	$(COMPOSE) up -d --force-recreate runner ui
	$(COMPOSE) up -d caddy

restart:
	$(COMPOSE) up -d --force-recreate runner ui
	$(COMPOSE) up -d caddy

deploy-test:
	@chmod +x apps/noite/test/deploy.sh
	./apps/noite/test/deploy.sh