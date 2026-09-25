#!/bin/sh
# Local pre-release lane (`make e2e`): raw localhost:ports, no Caddy, no
# subdomains. Boots the SAME service set and images as a production install
# (rustfs + runner + control), then deploys the sample app and drives the UI.
#
# Topology: rustfs :9000, runner API/git :8080 + tenants on their 81xx listen
# ports, control UI :8090 (the UI image deploys its own bundle on boot — the
# lane runs no build or deploy step of its own).
#
# Hermetic reruns: the lane's project (-p noite-e2e) owns its volumes and its
# bucket (`noite-e2e`), both wiped at the start of every run.
#
# Validates: image bytes, UI self-deploy, passkey signup, git push, deploy,
# tenant serve.
#
# Usage:
#   make e2e                      # build both images from the tree, then test
#   TAG=<short-sha> make e2e      # pull that release from GHCR instead
set -eu
cd "$(dirname "$0")/.."

TAG="${TAG:-}"
if [ -n "$TAG" ]; then
  export NOITE_RUNNER_IMAGE="ghcr.io/ryuzcorp/noite:${TAG}"
  export NOITE_CONTROL_IMAGE="ghcr.io/ryuzcorp/noite-control:${TAG}"
  PULL_FLAG="--pull always"
else
  PULL_FLAG="--build"
fi
export E2E_RUNNER_TOKEN="${E2E_RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:8090}"
export E2E_API_BASE="${E2E_API_BASE:-http://localhost:8080}"
export E2E_GIT_BASE="${E2E_GIT_BASE:-http://localhost:8080/v1/git}"
export E2E_RAW_PORTS=1

if command -v docker >/dev/null 2>&1; then
  ENGINE="docker compose"
else
  ENGINE="podman compose"
fi
# `make` exports COMPOSE (engine + base compose file). Reuse only its engine
# part: this lane passes both files explicitly, and repeating `-f` on the same
# file makes compose MERGE it twice — which concatenates list values such as
# healthcheck.test and breaks the up.
case "${COMPOSE:-}" in
*"docker compose"*) ENGINE="docker compose" ;;
*"podman compose"*) ENGINE="podman compose" ;;
esac
case "$ENGINE" in
*"podman compose"*) EXEC=podman ;;
*) EXEC=docker ;;
esac
# Own project: never touch the dev/prod `noite` containers (same service names
# would collide). Everything below addresses $CE2E.
CE2E="$ENGINE -p noite-e2e -f docker/compose.yaml -f docker/compose.e2e.yaml"

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is required (playwright + lockfile checks)"
  exit 1
}
[ -f .env ] || {
  echo "error: .env missing — copy .env.example first"
  exit 1
}
# shellcheck disable=SC1091
set -a
. ./.env
set +a

echo "==> reset lane state (fresh volumes, fresh bucket, no session)"
$CE2E down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf apps/noite/e2e/.auth/user.json
# Dev/prod stacks hold the same host ports — fail fast with a clear message
# instead of a cryptic bind error mid-up.
for p in 8080 8090 9000; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${p}/"; then
    echo "error: something already answers on :${p} (make down first?)"
    exit 1
  fi
done

if [ -n "$TAG" ]; then
  echo "==> images: GHCR tag ${TAG}"
else
  echo "==> images: building from the tree"
fi
# shellcheck disable=SC2086
$CE2E up -d $PULL_FLAG rustfs runner control

echo "==> wait for the stack to serve (5 min; the UI deploys its own bundle)"
attempt=0
while [ "$attempt" -lt 30 ]; do
  if make doctor; then
    # Warm the worker isolate + D1 before the passkey ceremony: the first API
    # hit cold-starts both, and a slow first call fails registration (the
    # Playwright retry covers it, but warm is deterministic). Any HTTP answer
    # counts.
    for _ in $(seq 1 12); do
      if curl -s -o /dev/null --max-time 10 "http://localhost:8090/api/auth/get-session"; then
        break
      fi
      sleep 5
    done
    echo "==> playwright e2e"
    # `set -e` would abort here on a failing suite and skip the teardown below,
    # leaving the stack holding the host ports; capture the status instead.
    if (cd apps/noite && npx playwright test); then
      rc=0
    else
      rc=$?
    fi
    # Lane ends clean (containers down, volumes kept for forensics) so the
    # next `make dev` never fights e2e leftovers for host ports.
    $CE2E down --remove-orphans >/dev/null 2>&1 || true
    exit "$rc"
  fi
  attempt=$((attempt + 1))
  sleep 10
done
echo "stack never became healthy — dumping logs"
$CE2E logs --tail=200
exit 1
