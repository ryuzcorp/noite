#!/bin/sh
# Local pre-release lane (`make e2e`): boots the production image (the one
# `noite` container + bundled RustFS) under its own compose project, then
# runs doctor and the Playwright suite (passkey signup, invites, lifecycle,
# git push, deploy, tenant serve), then checks `noite-runner recover`.
#
# Topology: the control UI through Caddy on :8090, the runner API and Git on
# :8080, tenant fleets on their own ports (20000+). See docker/compose.e2e.yaml.
#
# Hermetic reruns: the lane's project (-p noite-e2e) owns its volumes and its
# bucket (`noite-e2e`), both wiped at the start of every run.
#
# Usage:
#   make e2e                       build the image from the tree, then test
#   TAG=<short-sha> make e2e       pull that release from GHCR instead
#   E2E_TENANCY=multi make e2e     isolation lane: multi-tenant mode and the
#                                  hostile-tenant spec (E2E_HOSTILE=1)
#   E2E_KEEP=1 make e2e            leave the stack running afterwards (debug)
set -eu
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
load_env
detect_engine

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is required (playwright + lockfile checks)"
  exit 1
}

TAG="${TAG:-}"
FILES="-f docker/compose.yaml -f docker/compose.e2e.yaml"
if [ -n "$TAG" ]; then
  export NOITE_IMAGE="ghcr.io/ryuzcorp/noite:${TAG}"
  UP_FLAGS="--pull always"
else
  FILES="$FILES -f docker/compose.build.yaml"
  UP_FLAGS="--build"
fi
# The lane owns these values whatever .env says: localhost, the lane's ports.
export BASE_DOMAIN=localhost HTTP_PORT=8090 HTTPS_PORT=8443
# The lane's own store port, so a dev stack on :9000 can keep running.
export RUSTFS_API_PORT="${E2E_RUSTFS_PORT:-19000}"
export E2E_TENANCY="${E2E_TENANCY:-single}"
export E2E_RUNNER_TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL=http://localhost:8090
export E2E_API_BASE=http://localhost:8080
export E2E_GIT_BASE=http://localhost:8080/v1/git
export E2E_RAW_PORTS=1
if [ "$E2E_TENANCY" = multi ]; then
  export E2E_HOSTILE=1
fi
CE2E="$COMPOSE -p noite-e2e $FILES"

echo "==> reset lane state (fresh volumes, fresh bucket, no session)"
# shellcheck disable=SC2086
$CE2E down -v --remove-orphans >/dev/null 2>&1 || true
# `down -v` is best-effort (podman-compose) — remove whatever it left behind.
remove_project noite-e2e
rm -rf apps/noite/e2e/.auth/user.json
for p in 8080 8090 "$RUSTFS_API_PORT"; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${p}/"; then
    echo "error: something already answers on :${p} (make down first?)"
    exit 1
  fi
done

echo "==> image: ${NOITE_IMAGE:-built from the tree}; tenancy: ${E2E_TENANCY}"
# shellcheck disable=SC2086
$CE2E up -d $UP_FLAGS

echo "==> wait for the stack to serve (5 min)"
attempt=0
# Same 5-minute budget, checked every 3 s: the stack is usually up within
# seconds of the first failed check.
while [ "$attempt" -lt 100 ]; do
  if sh docker/doctor.sh; then
    echo "==> playwright e2e"
    # `set -e` would abort on a failing suite and skip the teardown below,
    # leaving the stack holding the host ports; capture the status instead.
    if (cd apps/noite && npx playwright test); then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
      # The operator's way back in after a lost passkey, through the image's
      # own binary (the Playwright suite covers the sign-in the code opens).
      echo "==> noite-runner recover"
      # shellcheck disable=SC2086
      if out="$($CE2E exec -T noite noite-runner recover --email e2e@noite.local 2>&1)" &&
        printf '%s\n' "$out" | grep -Eq 'Recovery code for e2e@noite\.local: [0-9]{6}$'; then
        echo "ok"
      else
        printf '%s\n' "$out"
        echo "error: noite-runner recover did not mint a code"
        rc=1
      fi
    fi
    if [ "${E2E_KEEP:-0}" = 1 ]; then
      echo "==> E2E_KEEP=1: stack left running (project noite-e2e)"
    else
      # shellcheck disable=SC2086
      $CE2E down --remove-orphans >/dev/null 2>&1 || true
    fi
    exit "$rc"
  fi
  attempt=$((attempt + 1))
  sleep 3
done
echo "stack never became healthy — dumping logs"
# shellcheck disable=SC2086
$CE2E logs --tail=200
exit 1
