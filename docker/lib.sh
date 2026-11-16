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
# volumes. Needed because podman-compose's `down -v` aborts on the first
# missing container and then leaves containers and volumes behind (a stale
# bucket still holds the last run's accounts). Volumes are matched in-shell:
# the engine `name=` filter is a substring match on docker (so `^noite_`
# matches nothing there) and a regex on podman — anchoring with grep behaves
# the same on both.
remove_project() {
  for p in "$@"; do
    for k in com.docker.compose.project io.podman.compose.project; do
      ids="$("$CLI" ps -aq --filter "label=$k=$p" 2>/dev/null || true)"
      # shellcheck disable=SC2086
      [ -z "$ids" ] || "$CLI" rm -f $ids >/dev/null
    done
    vols="$("$CLI" volume ls -q 2>/dev/null | grep "^${p}_" || true)"
    # shellcheck disable=SC2086
    [ -z "$vols" ] || "$CLI" volume rm -f $vols >/dev/null
  done
}

# require_private_dir <dir>: ensure <dir> exists with mode 0700. Backup
# destinations hold plaintext secrets (the runner SQLite with env values,
# every tenant's objects), so they must never land in a shared directory by
# accident. A directory this creates is chmod'd 0700 outright (independent
# of the caller's umask); an existing directory that is group- or
# world-accessible is refused instead of silently re-permissioned — like
# ssh, fail loud: it may be shared with a backup agent on purpose, and that
# is the operator's call. Under `set -e` a refusal aborts the caller.
require_private_dir() {
  if [ -e "$1" ]; then
    # Numeric test (mode & 077 == 0): string-slicing `ls -ld` misses the
    # group-read bit (a 0740 dir reads as private). The operator scripts
    # run on Linux (install.sh refuses anything else, and backup.sh needs
    # GNU `timeout`), so GNU stat is the rule; the BSD form is a fallback.
    _rpd_mode="$(stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || true)"
    case "$_rpd_mode" in
      "" | *[!0-7]*)
        echo "error: cannot read mode of $1" >&2
        return 1
        ;;
    esac
    if [ "$(( 0${_rpd_mode} & 077 ))" -ne 0 ]; then
      echo "error: $1 is group- or world-accessible (mode ${_rpd_mode}); backups hold plaintext secrets." >&2
      echo "  chmod 700 $1 (or pick another directory) and run again." >&2
      return 1
    fi
    return 0
  fi
  mkdir -p "$1"
  chmod 700 "$1"
}

# is_multi_tenancy: mirror the runner's parse_tenancy (apps/runner/src/config.rs).
# Explicit NOITE_TENANCY wins (blank counts as unset); otherwise a
# localhost-family BASE_DOMAIN means single, anything else means multi.
# e2e-local.sh sources this file; install.sh and the Makefile carry the same
# rule inline (install.sh is fetched standalone via curl, make cannot source
# shell) — keep all three in sync with parse_tenancy.
is_multi_tenancy() {
  _tenancy="$(printf '%s' "${NOITE_TENANCY:-}" | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$_tenancy" in
    single) return 1 ;;
    multi) return 0 ;;
  esac
  _base="$(printf '%s' "${BASE_DOMAIN:-localhost}" | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/\.*$//')"
  case "$_base" in
    localhost | *.localhost) return 1 ;;
    *) return 0 ;;
  esac
}
