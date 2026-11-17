#!/bin/sh
# Restore a Noite install from a `make backup` directory.
#
#   make restore FROM=backups/20260924T101500Z
#
# This REPLACES the current volumes: the stack is stopped, every volume in the
# backup is removed, re-created empty, unpacked, and the stack starts again.
# Anything written since the backup is gone, which is the point — but check
# twice before running it on a live install.
set -eu
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
# `.env` must not override the caller's choice: `make restore PROJECT=x`
# exports x, and load_env would set PROJECT from the file over it.
_PROJECT_ARG="${PROJECT:-}"
# Same for the tenancy inputs below: the multi overlay must follow the
# install the operator addressed.
_TENANCY_ARG="${NOITE_TENANCY:-}"
_BASE_ARG="${BASE_DOMAIN:-}"
load_env
detect_engine

FROM="${1:-}"
# A relative path is resolved against the repo (the default destination); an
# absolute one is used as given. Always quoted at every use: a spaced FROM
# must not word-split (the Makefile quotes "$(FROM)" too), and the value
# never reaches a shell except as a single quoted word.
case "$FROM" in
"" | /*) FROM_DIR="$FROM" ;;
*) FROM_DIR="$(pwd)/${FROM}" ;;
esac
if [ -z "$FROM" ] || [ ! -d "$FROM_DIR" ]; then
  echo "usage: make restore FROM=<backup directory>"
  echo "  e.g. make restore FROM=backups/20260924T101500Z"
  exit 1
fi
if [ ! -f "${FROM_DIR}/MANIFEST" ]; then
  echo "error: ${FROM_DIR} has no MANIFEST — is it a 'make backup' directory?"
  exit 1
fi

# Same project the Makefile drives (`make restore PROJECT=x`); a direct run
# follows COMPOSE_PROJECT_NAME, else the default install. Always `-p`: the
# target volumes below are named `<project>_<volume>`, so the stack that is
# stopped must be the one the volumes belong to. The caller wins over `.env`
# here, mirroring backup.sh.
PROJECT="${_PROJECT_ARG:-${PROJECT:-${COMPOSE_PROJECT_NAME:-noite}}}"
NOITE_TENANCY="${_TENANCY_ARG:-${NOITE_TENANCY:-}}"
BASE_DOMAIN="${_BASE_ARG:-${BASE_DOMAIN:-}}"

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
# (Duplicated from backup.sh on purpose: sharing it via lib.sh would mean
# editing backup.sh, and its restart path is covered by its own tests.)
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

# The stack is up only when the edge (`noite`) runs and every container of
# this project is `running`: a live dependency alone (rustfs) is not a stack,
# and only `running` counts as up because engines name the down states
# differently (podman also reports `initialized`, `stopped`, `configured`).
# Raw engine `ps`, once per engine's compose labels (`compose ps` output
# differs between them).
# (Duplicated from backup.sh on purpose, same as run_with_timeout above.)
project_running() {
  states=""
  edge=""
  for label in com.docker.compose io.podman.compose; do
    states="$states $("$CLI" ps -a --filter "label=${label}.project=${PROJECT}" --format '{{.State}}' 2>/dev/null || true)"
    edge="$edge $("$CLI" ps -a --filter "label=${label}.project=${PROJECT}" --filter "label=${label}.service=noite" --format '{{.State}}' 2>/dev/null || true)"
  done
  states="$(printf '%s' "$states" | tr ' ' '\n' | grep -v '^$' || true)"
  [ -n "$states" ] || return 1
  printf '%s' "$edge" | tr ' ' '\n' | grep -qx 'running' || return 1
  ! printf '%s\n' "$states" | grep -qvx 'running'
}

# Set to 1 just before the stop: the trap below restarts only a stack this
# script may have stopped, never a project it never touched. Setting it before
# the stop (not after) leaves no window where a signal lands on a stopped
# stack with the flag still 0; a restart of a stack that never stopped is a
# no-op `up -d`.
STOPPED=0
# Set to 1 when the restart was attempted but the stack is still down: the
# trap turns the run red instead of printing a success line over a dead edge.
UP_FAILED=0

# The stack is restarted by trap, never inline: anything after the stop
# (a bad archive, a tar error, a missing volume) aborts the script under
# `set -e`, and the edge must come back regardless of which step failed.
# Restarting is still right when the volumes were already partially
# overwritten: the alternative is a stopped stack AND a half-restored one,
# while a restarted stack at least serves the restored rows (and the
# operator can re-run the restore once the archive is fixed).
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
# runs first, then a failed restore (or a failed restart) exits nonzero, and
# only a clean restore that restarted prints the success lines.
trap 'status=$?; restart_stack; if [ "$UP_FAILED" = 1 ]; then exit 1; fi; [ "$status" = 0 ] || exit "$status"; echo; echo "restored. Verify with make doctor, then check an app in the UI."' EXIT
# Neither dash nor bash runs the EXIT trap on an uncaught fatal signal, so
# Ctrl-C or a CI/orchestrator timeout after the stop would leave the stack
# down silently. Route both through `exit`, which runs the trap above with
# the conventional signal status.
trap 'exit 130' INT
trap 'exit 143' TERM

pick_tar_image untar "set NOITE_BACKUP_IMAGE=<image with tar>."

echo "==> restoring ${FROM}"
cat "${FROM_DIR}/MANIFEST"
echo
echo "==> stop the stack"
echo "    project ${PROJECT}"
# From here on the EXIT trap owns the restart: it runs even when a later
# step aborts the script under `set -e` or a signal ends it.
STOPPED=1
ce down --remove-orphans

for tar in "${FROM_DIR}"/*.tar; do
  [ -f "$tar" ] || continue
  vol="$(basename "$tar" .tar)"
  # The name is interpolated into the helper's `sh -c`: only plain volume
  # characters may pass, so a hostile or stray filename cannot inject a
  # second command (or wipe an unrelated volume). Fail loud rather than
  # print "restored" over a skipped volume.
  case "$vol" in
  *[!A-Za-z0-9_.-]* | "" | .* | *..*)
    echo "error: refusing to restore '${tar}': volume names are [A-Za-z0-9_.-]" >&2
    exit 1
    ;;
  esac
  name="${PROJECT}_${vol}"
  echo "==> ${vol}"
  "$ENGINE" volume rm -f "$name" >/dev/null 2>&1 || true
  "$ENGINE" volume create "$name" >/dev/null
  "$ENGINE" run --rm --entrypoint sh \
    -v "${name}:/vol" \
    -v "${FROM_DIR}:/in:ro" \
    "$HELPER" -c "tar -xf /in/${vol}.tar -C /vol"
done

# The restart and the success lines run in the EXIT trap above, after this
# last step: a tar or volume failure still restarts the stack, and a
# failed run never prints "restored" over a dead edge.
