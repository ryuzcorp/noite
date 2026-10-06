#!/bin/sh
# Shared helpers for the standalone docker/*.sh scripts (doctor, backup,
# restore, usage, e2e-local). Sourced, never executed: each script cd's to the
# repo root and then `. "$(dirname "$0")/lib.sh"`.
#
# install.sh and uninstall.sh deliberately do not use this file: run.sh fetches
# each of them from a raw URL (`curl … | bash`), so they must stay
# self-contained.

# Export ./.env into the environment. install.sh never writes COMPOSE, so this
# only carries HTTP_PORT/RUNNER_TOKEN and the S3 settings to curl and the
# engine CLI.
load_env() {
  if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
  fi
}

# Engine detection: prefer docker, then let an explicit COMPOSE win (the
# Makefile exports COMPOSE, and it is the operator's engine choice). Sets
# ENGINE (docker|podman), COMPOSE ("docker compose"|"podman compose") and CLI
# (the engine binary, for run/ps/volume).
detect_engine() {
  if command -v docker >/dev/null 2>&1; then
    ENGINE=docker
  else
    ENGINE=podman
  fi
  case "${COMPOSE:-}" in
  *"docker compose"*) ENGINE=docker ;;
  *"podman compose"*) ENGINE=podman ;;
  esac
  COMPOSE="$ENGINE compose"
  CLI="$ENGINE"
}

# pick_tar_image <verb> <hint>: set HELPER to the first available image that
# carries tar, trying NOITE_BACKUP_IMAGE, NOITE_IMAGE and the usual local tags.
# `verb` names the operation in the error (tar/untar); `hint` is the line below.
pick_tar_image() {
  helper_verb="$1"
  helper_hint="$2"
  HELPER=""
  for candidate in "${NOITE_BACKUP_IMAGE:-}" "${NOITE_IMAGE:-}" noite:local noite-dev:local ghcr.io/ryuzcorp/noite:alpha; do
    if [ -n "$candidate" ] && "$ENGINE" image inspect "$candidate" >/dev/null 2>&1; then
      HELPER="$candidate"
      break
    fi
  done
  if [ -z "$HELPER" ]; then
    echo "error: no image available to ${helper_verb} the volumes with." >&2
    echo "  ${helper_hint}" >&2
    exit 1
  fi
}

# remove_project <project>...: remove a compose project's containers and named
# volumes by filter. Needed because podman-compose's `down -v` aborts on the
# first missing container and then leaves containers and volumes behind (a
# stale bucket still holds the last run's accounts).
remove_project() {
  for p in "$@"; do
    for k in com.docker.compose.project io.podman.compose.project; do
      ids="$("$CLI" ps -aq --filter "label=$k=$p" 2>/dev/null || true)"
      # shellcheck disable=SC2086
      [ -z "$ids" ] || "$CLI" rm -f $ids >/dev/null
    done
    vols="$("$CLI" volume ls -q --filter "name=^${p}_" 2>/dev/null || true)"
    # shellcheck disable=SC2086
    [ -z "$vols" ] || "$CLI" volume rm -f $vols >/dev/null
  done
}
