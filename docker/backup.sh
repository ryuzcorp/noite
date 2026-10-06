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
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
load_env
detect_engine

PORT="${HTTP_PORT:-9080}"
TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
API_URL="${NOITE_API_URL:-http://127.0.0.1:${PORT}/v1}"
# Behind the edge the runner is reached by Host, not by port (raw-port lanes
# set NOITE_API_URL and skip this).
API_HOST_HEADER="${NOITE_API_HOST_HEADER:-api.localhost}"
PROJECT="${COMPOSE_PROJECT_NAME:-noite}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-backups/${STAMP}}"
VOLUMES="noite-data rustfs-data"

CE="$COMPOSE -f docker/compose.yaml"

# Any image with `tar` will do; prefer the Noite image already on this host.
pick_tar_image tar "run 'make up' first, or set NOITE_BACKUP_IMAGE=<image with tar>."

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
  echo "image: ${NOITE_IMAGE:-noite:local}"
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
