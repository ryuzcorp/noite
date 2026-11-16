#!/bin/sh
# Upgrade lane (`make e2e-upgrade`): prove the tree upgrades the previous
# release's data in place. Boots the previous release's published image,
# seeds it through the public surface (app + env var, deploy, custom domain
# claim, collaborator, worker-written D1/R2 state), stops it, restarts the
# tree image on the SAME volumes and bucket, and verifies the seed reads
# back and the app still serves.
#
# Previous tag: the newest `v*` reachable before HEAD (a HEAD tag's
# predecessor on a tag build), else `gh release list`. Override with
# PREV_TAG=<tag> (the image is `ghcr.io/ryuzcorp/noite:<tag without v>`)
# or PREV_IMAGE=<ref> outright. The new side builds from the tree by
# default; E2E_IMAGE=<tag> tests a prebuilt image instead (CI hands over
# its one shared build this way).
#
# Knobs (mirroring docker/e2e-local.sh, own project/bucket/ports):
#   E2E_SLOT=<n>          parallel lane <n> (default 0 = today's ports);
#                         `auto` takes the first free slot (1-8).
#   E2E_KEEP=1            leave the upgraded stack up afterwards (debug).
#   PREV_TAG / PREV_IMAGE pick the old side; E2E_IMAGE picks the new side.
#   sh docker/e2e-upgrade.sh down (with an explicit E2E_SLOT) stops the lane.
set -eu
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
load_env
detect_engine

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is required (playwright)"
  exit 1
}

resolve_prev_tag() {
  if [ -n "${PREV_TAG:-}" ]; then
    printf '%s\n' "$PREV_TAG"
    return 0
  fi
  current="$(git describe --tags --match 'v*' --exact-match HEAD 2>/dev/null || true)"
  if [ -n "$current" ]; then
    git describe --tags --match 'v*' --abbrev=0 "${current}^" 2>/dev/null || true
  else
    git describe --tags --match 'v*' --abbrev=0 HEAD 2>/dev/null || true
  fi
}

PREV_TAG_RESOLVED="$(resolve_prev_tag || true)"
if [ -z "$PREV_TAG_RESOLVED" ] && command -v gh >/dev/null 2>&1; then
  PREV_TAG_RESOLVED="$(gh release list --limit 5 --json tagName -q '.[1].tagName' 2>/dev/null || true)"
fi
if [ -z "$PREV_TAG_RESOLVED" ]; then
  echo "error: no previous v* tag reachable; pass PREV_TAG=<tag>"
  exit 1
fi
case "$PREV_TAG_RESOLVED" in
  v*) PREV_VERSION="$(printf '%s\n' "$PREV_TAG_RESOLVED" | sed 's/^v//')" ;;
  *) PREV_VERSION="$PREV_TAG_RESOLVED" ;;
esac
PREV_IMAGE="${PREV_IMAGE:-ghcr.io/ryuzcorp/noite:${PREV_VERSION}}"

E2E_IMAGE="${E2E_IMAGE:-}"
NEW_IMAGE="$E2E_IMAGE"

# Parallel lanes: same port/project arithmetic as docker/e2e-local.sh, own
# names. Slot 0 is today's e2e ports (project noite-upg, bucket noite-upg).
E2E_SLOT_EXPLICIT="${E2E_SLOT:-}"
E2E_SLOT="${E2E_SLOT:-0}"
DOWN=0
if [ "${1:-}" = "down" ]; then
  DOWN=1
fi
case "$E2E_SLOT" in
  ""|0) SLOT=0 ;;
  auto) SLOT=auto ;;
  *[!0-9]*)
    echo "error: E2E_SLOT must be 0, a positive integer, or auto, not '${E2E_SLOT}'"
    exit 1
    ;;
  *) SLOT="$E2E_SLOT" ;;
esac
if [ "$DOWN" = 1 ]; then
  case "$E2E_SLOT_EXPLICIT" in
    ""|auto|*[!0-9]*)
      echo "error: stopping a lane needs an explicit slot: E2E_SLOT=<n> sh docker/e2e-upgrade.sh down"
      exit 1
      ;;
  esac
fi
if [ "$SLOT" = auto ]; then
  for n in 1 2 3 4 5 6 7 8; do
    rc=0
    flock -o -n -E 99 "/tmp/noite-upg-lane-${n}.lock" env E2E_LOCK_HELD="$n" E2E_SLOT="$n" "$0" "$@" || rc=$?
    if [ "$rc" -ne 99 ]; then
      exit "$rc"
    fi
  done
  echo "error: no free upgrade slot (1-8 all hold a lane)"
  exit 1
fi
LOCK="/tmp/noite-upg-lane-${SLOT}.lock"
KEEP_FILE="${LOCK}.keep"
E2E_LOCK_WAIT="${E2E_LOCK_WAIT:-300}"
if [ "${E2E_LOCK_HELD:-}" != "$SLOT" ]; then
  echo "==> waiting up to ${E2E_LOCK_WAIT}s for upgrade slot ${SLOT}"
  rc=0
  flock -o -w "$E2E_LOCK_WAIT" -E 99 "$LOCK" env E2E_LOCK_HELD="$SLOT" E2E_SLOT="$SLOT" "$0" "$@" || rc=$?
  if [ "$rc" -eq 99 ]; then
    echo "error: upgrade slot ${SLOT} is busy (another lane holds ${LOCK})"
  fi
  exit "$rc"
fi
if [ "$SLOT" = 0 ]; then
  API_PORT=8080
  LANE_HTTP_PORT=8090
  LANE_HTTPS_PORT=8443
  STORE_PORT=19000
  FLEET_RANGE="20000-20099:20000-20099"
  PROJECT=noite-upg
  BUCKET=noite-upg
  AUTH_DIR="$PWD/apps/noite/upgrade/.auth"
  REPORT_DIR="$PWD/apps/noite/upgrade-report"
  TEST_OUT_DIR="$PWD/apps/noite/upgrade-results"
else
  API_PORT=$((8080 + 100 * SLOT))
  LANE_HTTP_PORT=$((8090 + 100 * SLOT))
  LANE_HTTPS_PORT=$((8443 + 100 * SLOT))
  STORE_PORT=$((19000 + 100 * SLOT))
  FLEET_MIN=$((20000 + 1000 * SLOT))
  FLEET_RANGE="${FLEET_MIN}-$((FLEET_MIN + 99)):${FLEET_MIN}-$((FLEET_MIN + 99))"
  FLEET_PORTS="${FLEET_MIN}-$((FLEET_MIN + 99))"
  PROJECT="noite-upg-${SLOT}"
  BUCKET="noite-upg-${SLOT}"
  AUTH_DIR="$PWD/apps/noite/upgrade/.auth-${SLOT}"
  REPORT_DIR="$PWD/apps/noite/upgrade-report-${SLOT}"
  TEST_OUT_DIR="$PWD/apps/noite/upgrade-results-${SLOT}"
fi
FILES="-f docker/compose.yaml -f docker/compose.e2e.yaml"
if [ "$SLOT" != 0 ]; then
  FILES="$FILES -f docker/compose.slot.yaml"
fi

export BASE_DOMAIN=noite.localhost HTTP_PORT="$LANE_HTTP_PORT" HTTPS_PORT="$LANE_HTTPS_PORT"
export RUSTFS_API_PORT="$STORE_PORT"
export E2E_API_PORT="$API_PORT" E2E_HTTP_PORT="$LANE_HTTP_PORT"
export E2E_SLOT="$SLOT" E2E_PROJECT="$PROJECT" E2E_RAW_PORTS=1
export E2E_TENANCY="${E2E_TENANCY:-single}"
export E2E_RUNNER_TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL="http://noite.localhost:${LANE_HTTP_PORT}"
export E2E_API_BASE="http://localhost:${API_PORT}"
export E2E_GIT_BASE="http://localhost:${API_PORT}/v1/git"
export E2E_AUTH_DIR="$AUTH_DIR"
export E2E_REPORT_DIR="$REPORT_DIR"
export E2E_TEST_DIR="$TEST_OUT_DIR"
export E2E_FLEET_RANGE="$FLEET_RANGE" E2E_BUCKET="$BUCKET"
export UPGRADE_STATE="${UPGRADE_STATE:-${E2E_AUTH_DIR}/upgrade-state.json}"
export E2E_FLEET_PORTS="${FLEET_PORTS:-}"
CE2E="$COMPOSE -p $PROJECT $FILES"

if [ "$DOWN" = 1 ]; then
  echo "==> upgrade slot ${SLOT}: stopping the stack and freeing the session"
  # shellcheck disable=SC2086
  $CE2E down -v --remove-orphans >/dev/null 2>&1 || true
  remove_project "$PROJECT"
  if [ -f "$KEEP_FILE" ]; then
    kept_pid="$(cat "$KEEP_FILE" 2>/dev/null || true)"
    if [ -n "$kept_pid" ] && kill -0 "$kept_pid" 2>/dev/null; then
      kill "$kept_pid" 2>/dev/null || true
    fi
    rm -f "$KEEP_FILE"
  fi
  rm -rf "$E2E_AUTH_DIR/user.json" "$E2E_AUTH_DIR/invite.lock"
  echo "==> upgrade slot ${SLOT} is down"
  exit 0
fi
if [ -f "$KEEP_FILE" ]; then
  kept_pid="$(cat "$KEEP_FILE" 2>/dev/null || true)"
  if [ -n "$kept_pid" ] && kill -0 "$kept_pid" 2>/dev/null; then
    echo "error: upgrade slot ${SLOT} is kept by pid ${kept_pid}; free it with E2E_SLOT=${SLOT} sh docker/e2e-upgrade.sh down"
    exit 1
  fi
  echo "==> removing stale keep sentinel for upgrade slot ${SLOT}"
  rm -f "$KEEP_FILE"
fi

wait_ready() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if sh docker/doctor.sh >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
  return 1
}

fail_down() {
  echo "error: $1"
  # shellcheck disable=SC2086
  $CE2E down --remove-orphans >/dev/null 2>&1 || true
  exit 1
}

LANE_START="$(date +%s)"
echo "==> upgrade slot ${SLOT}: project ${PROJECT}, api :${API_PORT}, caddy :${LANE_HTTP_PORT}, store :${STORE_PORT}"
echo "==> old side: ${PREV_IMAGE} (tag ${PREV_TAG_RESOLVED})"
rm -rf "$E2E_AUTH_DIR/user.json" "$E2E_AUTH_DIR/invite.lock" "$UPGRADE_STATE"
# shellcheck disable=SC2086
$CE2E down -v --remove-orphans >/dev/null 2>&1 || true
remove_project "$PROJECT"
for p in "$API_PORT" "$LANE_HTTP_PORT" "$LANE_HTTPS_PORT" "$STORE_PORT"; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${p}/"; then
    echo "error: something already answers on :${p}"
    exit 1
  fi
done
export NOITE_IMAGE="$PREV_IMAGE"
# The seed starts on a fresh bucket and fresh volumes.
# shellcheck disable=SC2086
$CE2E up -d --pull always || fail_down "old image failed to start"
echo "==> wait for the old stack (5 min)"
wait_ready || fail_down "old stack never became ready"
echo "==> seed through the old image"
(
  cd apps/noite && UPGRADE_PHASE=seed npx playwright test -c upgrade.config.ts
) || fail_down "seed phase failed"
if [ ! -f "$UPGRADE_STATE" ]; then
  fail_down "seed phase wrote no state file ($UPGRADE_STATE)"
fi
ls -la "$UPGRADE_STATE" && cat "$UPGRADE_STATE"

echo "==> stop the old stack (volumes and bucket stay)"
# shellcheck disable=SC2086
$CE2E down --remove-orphans >/dev/null 2>&1 || true

if [ -n "$NEW_IMAGE" ]; then
  echo "==> new side: ${NEW_IMAGE}"
  export NOITE_IMAGE="$NEW_IMAGE"
  # shellcheck disable=SC2086
  $CE2E up -d || fail_down "new image failed to start"
else
  echo "==> new side: build from the tree"
  unset NOITE_IMAGE
  # shellcheck disable=SC2086
  $CE2E -f docker/compose.build.yaml up -d --build || fail_down "tree image failed to start"
fi
echo "==> wait for the upgraded stack (5 min)"
if ! wait_ready; then
  # shellcheck disable=SC2086
  $CE2E logs --tail=200 noite 2>&1 | grep -i "refusing to start" || true
  fail_down "upgraded stack never became ready"
fi
# A schema refusal fails the wait above; name it outright so the lane's
# verdict says what the tree refused, not just that doctor stayed red.
if $CE2E logs --tail=5000 noite 2>&1 | grep -qi "refusing to start"; then
  $CE2E logs --tail=200 noite 2>&1 | grep -i "refusing to start" || true
  fail_down "tree image refused the previous release's data"
fi
echo "==> verify the seed reads back on the tree image"
(
  cd apps/noite && UPGRADE_PHASE=verify npx playwright test -c upgrade.config.ts
) || fail_down "verify phase failed"

LANE_END="$(date +%s)"
echo "==> upgrade lane green in $((LANE_END - LANE_START))s: ${PREV_TAG_RESOLVED} -> tree serves the seed back"
if [ "${E2E_KEEP:-0}" = 1 ]; then
  echo "$$" > "$KEEP_FILE"
  echo "==> kept: E2E_SLOT=${SLOT} sh docker/e2e-upgrade.sh down frees it"
else
  echo "==> teardown"
  # shellcheck disable=SC2086
  $CE2E down -v --remove-orphans >/dev/null 2>&1 || true
  remove_project "$PROJECT"
fi
