#!/bin/sh
# Consistent backup of a Noite install.
#
#   make backup                 # → backups/<UTC stamp>/
#   make backup DEST=/srv/noite-backups/latest
#
# What lives where, and therefore what is irreplaceable:
#   runner-data    the runner SQLite (apps, deploys, env, domains, metrics) and
#                  the git mirrors — the only copy of deploy metadata
#   rustfs-data    the fleet bucket: `git/` bundles, `fleets/` tenant celld,
#                  `control/` UI worker + its D1
#   control-state  celld's local working dir for the UI node (cache; cheap)
#   caddy-data     certificates (re-issuable, but avoids a re-issuance storm)
#   caddy-config   the runner-written Caddyfile + access log
#
# How: ask the runner for a `VACUUM INTO` snapshot, then stop the stack (a
# quiesced copy is the only honest one — rustfs and the runner both write
# continuously), tar each volume into the destination, and start the stack
# again. Downtime is the tar time.
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a
  . ./.env
  set +a
fi

PORT="${HTTP_PORT:-9080}"
TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
API_URL="${NOITE_API_URL:-http://127.0.0.1:${PORT}/v1}"
# Behind the edge the runner is reached by Host, not by port (raw-port lanes
# set NOITE_API_URL and skip this).
API_HOST_HEADER="${NOITE_API_HOST_HEADER:-api.localhost}"
PROJECT="${COMPOSE_PROJECT_NAME:-noite}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-backups/${STAMP}}"
VOLUMES="rustfs-data runner-data control-state caddy-config caddy-data"

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
  echo "error: no image available to tar the volumes with."
  echo "  build one with 'make up', or set NOITE_BACKUP_IMAGE=<image with tar>."
  exit 1
fi

# A relative destination lands under the repo (the default); an absolute one is
# used as given. Prefixing `pwd` onto an absolute path would mount a directory
# that does not exist, and the engine would silently create an empty one there
# while the tarballs went somewhere else entirely.
case "$DEST" in
/*) DEST_DIR="$DEST" ;;
*) DEST_DIR="$(pwd)/${DEST}" ;;
esac
mkdir -p "$DEST_DIR"

echo "==> snapshot the runner database"
if [ -n "$API_HOST_HEADER" ]; then
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" -H "Host: ${API_HOST_HEADER}" \
    "${API_URL}/admin/snapshot"
else
  curl -fsS -X POST -H "Authorization: Bearer ${TOKEN}" "${API_URL}/admin/snapshot"
fi
echo

echo "==> stop the stack for a consistent copy (downtime = the tar)"
$CE stop

echo "==> tar volumes into ${DEST}"
for vol in $VOLUMES; do
  name="${PROJECT}_${vol}"
  if ! "$ENGINE" volume inspect "$name" >/dev/null 2>&1; then
    echo "    ${vol}: volume ${name} does not exist, skipped"
    continue
  fi
  "$ENGINE" run --rm --entrypoint sh \
    -v "${name}:/vol:ro" \
    -v "${DEST_DIR}:/out:z" \
    "$HELPER" -c "tar -cf /out/${vol}.tar -C /vol ."
  echo "    ${vol}.tar"
done

{
  echo "noite backup"
  echo "created: ${STAMP}"
  echo "project: ${PROJECT}"
  echo "images:"
  echo "  runner: ${NOITE_RUNNER_IMAGE:-noite-runner:local}"
  echo "  control: ${NOITE_CONTROL_IMAGE:-noite-control:local}"
  echo "volumes: ${VOLUMES}"
  echo "git: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "restore: make restore FROM=${DEST}"
} >"${DEST_DIR}/MANIFEST"

echo "==> start the stack again"
# podman-compose occasionally wedges after the containers are already up; a
# backup that succeeded must not report failure because of that.
timeout 300 $CE up -d || echo "note: restart did not return cleanly — check 'make up' and 'make doctor'"
echo
echo "backup complete: ${DEST}"
echo "  restore it with: make restore FROM=${DEST}"
echo "  (verify the copy first: 'make doctor' should be green)"
