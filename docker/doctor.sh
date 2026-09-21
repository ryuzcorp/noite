#!/bin/sh
# Noite doctor: codified tribal checks. Exit 0 when the stack looks healthy,
# nonzero with the failing check named. Reads .env for ports/token.
set -eu
cd "$(dirname "$0")/.."

PORT="${HTTP_PORT:-9080}"
TOKEN="${RUNNER_TOKEN:-dev-agent-token}"
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

check "compose stack running" sh -c 'docker compose -f docker/compose.yaml ps --format json 2>/dev/null | grep -q runner || podman compose -f docker/compose.yaml ps 2>/dev/null | grep -q runner'
check "runner /health" curl -fs "http://127.0.0.1:${PORT}/health"
check "runner /ready (reconcile passed)" curl -fs "http://127.0.0.1:${PORT}/ready"
check "runner API auth" curl -fs -H "Authorization: Bearer ${TOKEN}" -H "Host: api.localhost" "http://127.0.0.1:${PORT}/v1/apps"
check "rustfs reachable" curl -fs "http://127.0.0.1:${RUSTFS_API_PORT:-9000}/minio/health/live"
export PORT
check "control UI serves" sh -c 'curl -fs "http://127.0.0.1:$PORT/" | grep -qi "<html"'

exit "$fail"
