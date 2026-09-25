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

FROM="${1:-}"
# A relative path is resolved against the repo (the default destination); an
# absolute one is used as given.
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

PROJECT="${COMPOSE_PROJECT_NAME:-noite}"
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  ENGINE=podman
fi
case "${COMPOSE:-}" in
*"docker compose"*) ENGINE=docker ;;
*"podman compose"*) ENGINE=podman ;;
esac
CE="$ENGINE compose -f docker/compose.yaml"

img_ok() { "$ENGINE" image inspect "$1" >/dev/null 2>&1; }
if [ -n "${NOITE_BACKUP_IMAGE:-}" ]; then
  HELPER="$NOITE_BACKUP_IMAGE"
elif img_ok "${NOITE_RUNNER_IMAGE:-ghcr.io/ryuzcorp/noite:latest}"; then
  HELPER="${NOITE_RUNNER_IMAGE:-ghcr.io/ryuzcorp/noite:latest}"
elif img_ok noite-runner:local; then
  HELPER=noite-runner:local
elif img_ok docker.io/library/caddy:2.10.0-alpine; then
  HELPER=docker.io/library/caddy:2.10.0-alpine
else
  echo "error: no image available to untar the volumes with."
  exit 1
fi

echo "==> restoring ${FROM}"
cat "${FROM_DIR}/MANIFEST"
echo
echo "==> stop the stack"
$CE down --remove-orphans

for tar in "${FROM_DIR}"/*.tar; do
  [ -f "$tar" ] || continue
  vol="$(basename "$tar" .tar)"
  name="${PROJECT}_${vol}"
  echo "==> ${vol}"
  "$ENGINE" volume rm -f "$name" >/dev/null 2>&1 || true
  "$ENGINE" volume create "$name" >/dev/null
  "$ENGINE" run --rm --entrypoint sh \
    -v "${name}:/vol" \
    -v "${FROM_DIR}:/in:ro" \
    "$HELPER" -c "tar -xf /in/${vol}.tar -C /vol"
done

echo "==> start the stack"
timeout 300 $CE up -d || echo "note: restart did not return cleanly — check 'make up' and 'make doctor'"
echo
echo "restored. Verify with 'make doctor', then check an app in the UI."
