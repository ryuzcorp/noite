#!/bin/sh
# Consistent backup of a Noite install.
#
#   make backup                 # → backups/<UTC stamp>/
#   make backup DEST=/srv/noite-backups/latest
#
# What lives where:
#   noite-data   the runner SQLite (apps, deploys, env, domains, metrics; also
#                snapshotted into the bucket every minute), git mirrors,
#                builds, fleet working dirs, Caddy config + certificates
#   rustfs-data  the bundled bucket: `git/` bundles, `fleets/` tenant celld,
#                `control/` UI worker + its D1, `runner/state/` snapshots
#
# With BYO S3 the bucket is not here: back it up at the provider (versioning)
# and this script covers `noite-data` only.
#
# How: ask the runner for a fresh snapshot (local + bucket), stop the stack
# (a quiesced copy is the only honest one), tar each volume, start again.
# Downtime is the tar time.
set -eu
umask 077
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
# `.env` must not override the caller's choice: `make backup PROJECT=x`
# exports x, and load_env would set PROJECT from the file over it.
_PROJECT_ARG="${PROJECT:-}"
# Same for the tenancy inputs below: the snapshot Host header and the
# multi overlay must follow the install the operator addressed.
_TENANCY_ARG="${NOITE_TENANCY:-}"
_BASE_ARG="${BASE_DOMAIN:-}"
load_env
detect_engine

PORT="${HTTP_PORT:-9080}"
# The caller wins over `.env` here too, mirroring PROJECT: the snapshot
# Host header below and the multi overlay must follow the install the
# operator addressed, not the file.
NOITE_TENANCY="${_TENANCY_ARG:-${NOITE_TENANCY:-}}"
BASE_DOMAIN="${_BASE_ARG:-${BASE_DOMAIN:-}}"
TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
# Behind the edge the runner is reached by Host, not by port (raw-port lanes
# set NOITE_API_URL and skip this).
API_HOST_HEADER="${NOITE_API_HOST_HEADER:-api.${BASE_DOMAIN:-noite.localhost}}"
# Same project the Makefile drives: `make backup PROJECT=x` sets PROJECT,
# a direct run follows `PROJECT`/`COMPOSE_PROJECT_NAME` from .env
# (compose.yaml's `name:` default interpolates the same variable), else the
# default install.
PROJECT="${_PROJECT_ARG:-${PROJECT:-${COMPOSE_PROJECT_NAME:-noite}}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-backups/${STAMP}}"
VOLUMES="noite-data rustfs-data"

# The file set the Makefile drives, so the restart converges the SAME stack
# that was stopped: under `make` it arrives in the environment (the Makefile
# already applied its multi rule); a direct run computes it with the same
# rule from lib.sh. Restarting a multi install with only the base file would
# recreate the edge without its multi mounts.
if [ -z "${COMPOSE_FILES:-}" ]; then
  COMPOSE_FILES="-f docker/compose.yaml"
  if is_multi_tenancy; then
    COMPOSE_FILES="$COMPOSE_FILES -f docker/compose.multi.yaml"
  fi
fi

# This project's compose, always with -p: compose.yaml's `name:` is only a
# default and must never decide which stack gets stopped.
ce() {
  # shellcheck disable=SC2086
  $COMPOSE -p "$PROJECT" $COMPOSE_FILES "$@"
}

# `timeout` can only exec a program, never the `ce` function (it would exit
# 127 and leave the stack down), so the restart spells the command out. A
# host without coreutils `timeout` still restarts — without a time limit —
# instead of skipping the restart with a 127.
run_with_timeout() {
  secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    echo "note: 'timeout' is not installed — restarting without a time limit" >&2
    "$@"
  fi
}

# Every container of this project up: raw engine `ps` (both engines label
# their containers; `compose ps` output differs between them).
project_running() {
  states="$("$CLI" ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.State}}' 2>/dev/null || true)"
  states="$states $("$CLI" ps -a --filter "label=io.podman.compose.project=${PROJECT}" --format '{{.State}}' 2>/dev/null || true)"
  states="$(printf '%s' "$states" | tr ' ' '\n' | grep -v '^$' || true)"
  [ -n "$states" ] || return 1
  ! printf '%s\n' "$states" | grep -qiE '^(exited|dead|paused|removing|restarting|created)$'
}

# Set to 1 once `ce stop` has run: the trap below restarts only a stack this
# script actually stopped, never a project it never touched.
STOPPED=0
# Set to 1 when the restart was attempted but the stack is still down: the
# trap turns the run red instead of printing a success line over a dead edge.
UP_FAILED=0

# The stack is restarted by trap, never inline: anything after `ce stop`
# (a tar error, a full disk, a daemon hiccup) aborts the script under
# `set -e`, and the edge must come back regardless of which step failed.
restart_stack() {
  [ "$STOPPED" = 1 ] || return 0
  echo "==> start the stack again"
  # shellcheck disable=SC2086
  if run_with_timeout 300 $COMPOSE -p "$PROJECT" $COMPOSE_FILES up -d; then
    return 0
  fi
  # `up` sometimes reports failure (or wedges past the timeout) after the
  # containers are already up: only fail when the stack is actually down.
  if project_running; then
    echo "note: the restart reported failure, but every container is running — run 'make doctor' to verify"
    return 0
  fi
  echo "error: the automatic restart failed — start the stack with 'make up PROJECT=${PROJECT}', then run 'make doctor'" >&2
  UP_FAILED=1
}

# EXIT covers every `set -e` abort as well as the clean path: the restart
# runs first, then a failed backup (or a failed restart) exits nonzero, and
# only a clean backup that restarted prints the success lines.
trap 'status=$?; restart_stack; if [ "$UP_FAILED" = 1 ]; then exit 1; fi; [ "$status" = 0 ] || exit "$status"; echo; echo "backup complete: ${DEST}"; echo "  restore it with: make restore FROM=${DEST}"; echo "  (verify the copy first: run make doctor)"' EXIT

# The published HTTP port of this project's edge (the `noite` service publishes
# container port 80), so a backup of `PROJECT=x` snapshots x's runner and not
# whichever stack happens to sit on the default port.
project_http_port() {
  cid="$("$CLI" ps --format '{{.Names}} {{.ID}}' 2>/dev/null |
    awk -v p="$PROJECT" '$1 ~ "^"p"[-_]noite[-_]" {print $2; exit}')"
  [ -n "$cid" ] || return 0
  "$CLI" port "$cid" 80/tcp 2>/dev/null | head -n 1 | sed 's/.*://'
}

API_URL="${NOITE_API_URL:-}"
if [ -z "$API_URL" ]; then
  api_port="$(project_http_port || true)"
  if [ -z "$api_port" ] && [ "$PROJECT" = noite ]; then
    api_port="$PORT"
  fi
  if [ -z "$api_port" ]; then
    echo "error: project ${PROJECT} has no running noite container (and NOITE_API_URL is unset), so there is no runner to snapshot" >&2
    echo "  start it with 'make up PROJECT=${PROJECT}', or pass NOITE_API_URL=http://127.0.0.1:<port>/v1" >&2
    exit 1
  fi
  API_URL="http://127.0.0.1:${api_port}/v1"
fi

# Any image with `tar` will do; prefer the Noite image already on this host.
pick_tar_image tar "run 'make up' first, or set NOITE_BACKUP_IMAGE=<image with tar>."

case "$DEST" in
/*) DEST_DIR="$DEST" ;;
*) DEST_DIR="$(pwd)/${DEST}" ;;
esac
# Secrets land here (runner SQLite with plaintext env values, every tenant's
# objects): 0700 fresh, or refuse a shared directory rather than filling it.
require_private_dir "$DEST_DIR"

echo "==> snapshot the runner database"
if [ -n "$API_HOST_HEADER" ]; then
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" -H "Host: ${API_HOST_HEADER}" \
    "${API_URL}/admin/snapshot"
else
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" "${API_URL}/admin/snapshot"
fi
echo

echo "==> stop the stack for a consistent copy (downtime = the tar)"
echo "    project ${PROJECT}, api ${API_URL}"
ce stop
# From here on the EXIT trap owns the restart: it runs even when a later
# step aborts the script under `set -e`.
STOPPED=1

echo "==> tar volumes into ${DEST}"
for vol in $VOLUMES; do
  name="${PROJECT}_${vol}"
  if ! "$ENGINE" volume inspect "$name" >/dev/null 2>&1; then
    echo "    ${vol}: volume ${name} does not exist, skipped"
    continue
  fi
  # The control operator token file is derived state (rewritten on every
  # control spawn from the encrypted DB row) and a plaintext secret: leave it
  # out. The pattern matches nothing in the other volumes.
  # The helper runs as root with a default umask, so the tar is root-owned:
  # force 0600 inside the helper (umask for creation, chmod for a pre-
  # existing archive, which tar truncates in place without touching its
  # mode). No host-side chmod: the invoking user may not own the file, and
  # an EPERM there would abort after the stack is already stopped.
  "$ENGINE" run --rm --entrypoint sh \
    -v "${name}:/vol:ro" \
    -v "${DEST_DIR}:/out:z" \
    "$HELPER" -c "umask 077; tar -cf /out/${vol}.tar --exclude=./runner/control-operator-token -C /vol . && chmod 600 /out/${vol}.tar"
  echo "    ${vol}.tar"
done

{
  echo "noite backup"
  echo "created: ${STAMP}"
  echo "project: ${PROJECT}"
  echo "api: ${API_URL}"
  echo "image: ${NOITE_IMAGE:-noite:local}"
  echo "volumes: ${VOLUMES}"
  echo "git: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "restore: make restore FROM=${DEST}"
} >"${DEST_DIR}/MANIFEST"

# The restart and the success lines run in the EXIT trap above, after this
# last step: a tar or MANIFEST failure still restarts the stack, and a
# failed run never prints "backup complete" over a dead edge.
