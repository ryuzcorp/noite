#!/usr/bin/env bash
# Noite uninstaller: removes what install.sh set up, so the host is clean for
# a fresh install.
#
#   curl -fsSL https://noite.now/run.sh | bash -s uninstall
#
# noite.now/run.sh resolves main to a commit and runs this file from it
# (apps/website/public/run.sh), so every run is the latest.
#
# What it removes: the stack's containers and network, its volumes (runner
# database, git mirrors, Caddy certificates, the bundled bucket), the Noite
# and RustFS images, and the install directory with its .env (the secrets).
# Docker itself and the ufw rules for 80/443 stay: other things may use them.
#
# Everything is gone afterwards; back up first if any of it matters
# (https://noite.now/self-hosting/operations#backups).
#
# Environment (all optional):
#   NOITE_DIR        install directory (default: /opt/noite)
#   NOITE_KEEP_DATA  1 = remove the containers only; volumes, images and .env
#                    stay, and re-running install brings the same install back
#   NOITE_CONFIRM    1 = do not ask (required without a terminal)
#
# A bucket of your own (S3_ENDPOINT in .env) is never touched: a reinstall
# pointed at it restores the old state from its snapshot.
#
# Nothing runs before main on the last line, so a truncated download never
# runs half an uninstall.

set -euo pipefail

NOITE_DIR="${NOITE_DIR:-/opt/noite}"
NOITE_KEEP_DATA="${NOITE_KEEP_DATA:-0}"
NOITE_CONFIRM="${NOITE_CONFIRM:-0}"
# `name:` in compose.yaml; Compose labels everything it creates with it, so
# the stack is found even when compose.yaml is gone.
PROJECT="noite"
PROJECT_LABEL="com.docker.compose.project=$PROJECT"
IMAGE_REPOS=("ghcr.io/ryuzcorp/noite" "rustfs/rustfs" "docker.io/rustfs/rustfs")

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# Questions go to /dev/tty, readable only from its foreground process group
# (see can_ask in install.sh).
can_ask() {
  (: </dev/tty) 2>/dev/null || return 1
  local stat pgrp tpgid
  stat=$(</proc/$$/stat)
  read -r _ _ pgrp _ _ tpgid _ <<<"${stat##*) }"
  [[ "$pgrp" == "$tpgid" ]]
}

env_get() { grep -E "^$1=" "$NOITE_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2-; }

check_system() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL https://noite.now/run.sh | bash -s uninstall"
  have docker || die "docker is not installed; nothing of Noite can be running"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running: systemctl start docker"
}

# Everything below lists by the Compose project label, not by compose.yaml,
# so a half-deleted install directory still uninstalls cleanly.
containers() { docker ps -aq --filter "label=$PROJECT_LABEL"; }
volumes() { docker volume ls -q --filter "label=$PROJECT_LABEL"; }
networks() { docker network ls -q --filter "label=$PROJECT_LABEL"; }

images() {
  local repo
  for repo in "${IMAGE_REPOS[@]}"; do
    docker images -q "$repo" 2>/dev/null
  done | sort -u
}

survey() {
  step "Looking for Noite"
  DOMAIN=$(env_get BASE_DOMAIN || true)
  S3_OWN=$(env_get S3_ENDPOINT || true)
  local n_containers n_volumes
  n_containers=$(containers | wc -l)
  n_volumes=$(volumes | wc -l)
  if [[ -d "$NOITE_DIR" ]]; then
    info "install directory  $NOITE_DIR${DOMAIN:+ (BASE_DOMAIN=$DOMAIN)}"
  fi
  info "containers         $n_containers"
  if [[ "$NOITE_KEEP_DATA" != "1" ]]; then
    info "volumes            $n_volumes $(volumes | tr '\n' ' ')"
  fi
  if [[ ! -d "$NOITE_DIR" ]] && ((n_containers == 0 && n_volumes == 0)); then
    info "nothing to remove"
    exit 0
  fi
}

confirm() {
  [[ "$NOITE_CONFIRM" != "1" ]] || return 0
  can_ask || die "no terminal to confirm on: run curl -fsSL https://noite.now/run.sh | bash -s uninstall (no sudo), or set NOITE_CONFIRM=1"

  local expected="${DOMAIN:-noite}" answer=""
  if [[ "$NOITE_KEEP_DATA" == "1" ]]; then
    printf '\n%sStops and removes the Noite containers; data and .env stay.%s\n' "$BOLD" "$RESET" >/dev/tty
  else
    printf '\n%s%sDeletes every app, account, git repository, certificate and secret of this install.%s\n' \
      "$RED" "$BOLD" "$RESET" >/dev/tty
    printf '%sBack up first if you need any of it: https://noite.now/self-hosting/operations#backups%s\n' \
      "$DIM" "$RESET" >/dev/tty
  fi
  printf 'Type %s%s%s to continue: ' "$BOLD" "$expected" "$RESET" >/dev/tty
  read -r answer </dev/tty || true
  [[ "$answer" == "$expected" ]] || die "not confirmed; nothing was removed"
}

stop_stack() {
  step "Stopping Noite"
  local ids
  ids=$(containers)
  if [[ -z "$ids" ]]; then
    info "no containers"
    return 0
  fi
  # The runner stops every fleet and writes its final snapshot inside the
  # 35 s grace compose.yaml gives it.
  # shellcheck disable=SC2086
  docker stop --time 35 $ids >/dev/null
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null
  info "removed $(wc -w <<<"$ids") containers"
  local net
  for net in $(networks); do
    docker network rm "$net" >/dev/null 2>&1 || warn "could not remove network $net"
  done
}

remove_data() {
  step "Removing volumes"
  local vol
  for vol in $(volumes); do
    docker volume rm "$vol" >/dev/null
    info "$vol"
  done

  step "Removing images"
  local ids
  ids=$(images)
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker rmi -f $ids >/dev/null 2>&1 || warn "some images are in use elsewhere and stay"
    info "removed $(wc -w <<<"$ids") images"
  else
    info "no images"
  fi

  step "Removing $NOITE_DIR"
  if [[ -d "$NOITE_DIR" ]]; then
    rm -rf -- "$NOITE_DIR"
    info "removed (with .env and its secrets)"
  else
    info "not present"
  fi
}

summary() {
  if [[ "$NOITE_KEEP_DATA" == "1" ]]; then
    cat <<EOF

${GREEN}${BOLD}Noite is stopped.${RESET} Volumes, images and $NOITE_DIR/.env are kept.

  Start again   curl -fsSL https://noite.now/run.sh | bash -s install
  Remove all    curl -fsSL https://noite.now/run.sh | bash -s uninstall
EOF
    return 0
  fi

  cat <<EOF

${GREEN}${BOLD}Noite is removed.${RESET} Docker and the ufw rules for 80/443 are left in place.

  Reinstall     curl -fsSL https://noite.now/run.sh | bash -s install
EOF
  if [[ -n "${S3_OWN:-}" && "$S3_OWN" != "http://rustfs:9000" ]]; then
    warn "your bucket at $S3_OWN was not touched: a reinstall pointed at it restores"
    warn "the old state; empty it or pick a new NOITE_S3_BUCKET to start fresh"
  fi
}

main() {
  check_system
  survey
  confirm
  stop_stack
  if [[ "$NOITE_KEEP_DATA" != "1" ]]; then
    remove_data
  fi
  summary
}

main "$@"
