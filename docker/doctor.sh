#!/bin/sh
# Noite doctor: codified tribal checks. Exit 0 when the stack looks healthy,
# nonzero with the failing check named. Reads .env for ports/token.
set -eu
cd "$(dirname "$0")/.."

PORT="${HTTP_PORT:-9080}"
TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
# Raw-port lane (`make e2e`, E2E_RAW_PORTS=1): no Caddy — runner API direct
# on :8080, control UI direct on :8090. Caddy lanes keep edge routing below.
if [ "${E2E_RAW_PORTS:-}" = 1 ]; then
  RUNNER_URL="http://localhost:8080"
  UI_URL="http://localhost:8090"
  API_HOST_ARGS=""
else
  RUNNER_URL="http://127.0.0.1:${PORT}"
  UI_URL="http://127.0.0.1:${PORT}"
  # Runner API lives behind the worker edge (static Caddy -> control:8090
  # -> Host dispatch -> runner cell :8080): apex has no /ready or /v1/*.
  API_HOST_ARGS="-H Host: api.localhost"
fi
fail=0
check() {
  desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "ok   $desc"
  else
    echo "FAIL $desc"
    fail=1
  fi
}

if [ "${E2E_RAW_PORTS:-}" = 1 ]; then
  # e2e project name differs (-p noite-e2e); match engine-wide instead.
  check "e2e containers running" sh -c 'docker ps --format "{{.Names}}" 2>/dev/null | grep -q control || podman ps --format "{{.Names}}" 2>/dev/null | grep -q control'
else
  check "compose stack running" sh -c 'docker compose -f docker/compose.yaml ps --format json 2>/dev/null | grep -q control || podman compose -f docker/compose.yaml ps 2>/dev/null | grep -q control'
fi
check "runner /health" curl -fs "${RUNNER_URL}/health"
check "runner /ready (reconcile passed)" curl -fs ${API_HOST_ARGS} "${RUNNER_URL}/ready"
check "runner API auth" curl -fs -H "Authorization: Bearer ${TOKEN}" ${API_HOST_ARGS} "${RUNNER_URL}/v1/apps"
check "rustfs reachable" curl -fs "http://127.0.0.1:${RUSTFS_API_PORT:-9000}/minio/health/live"
export UI_URL
check "control UI serves" sh -c 'curl -fs "$UI_URL/" | grep -qi "<html"'

exit "$fail"
