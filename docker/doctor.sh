#!/bin/sh
# Noite doctor: codified tribal checks. Exit 0 when the stack looks healthy,
# nonzero with the failing check named. Reads .env for ports/token/credentials.
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
HOST_HEADER=""
if [ "${E2E_RAW_PORTS:-}" = 1 ]; then
  # Raw-port lane (`make e2e`): no Caddy — runner API direct on :8080,
  # control UI direct on :8090, own compose project.
  RUNNER_URL="http://localhost:8080"
  UI_URL="http://localhost:8090"
  COMPOSE_ARGS="-p noite-e2e -f docker/compose.yaml -f docker/compose.e2e.yaml"
else
  # Production shape: one edge on :9080 dispatching by Host — the control UI
  # on the bare domain, the runner API on api.<domain>.
  RUNNER_URL="http://127.0.0.1:${PORT}"
  UI_URL="http://127.0.0.1:${PORT}"
  HOST_HEADER="api.localhost"
  COMPOSE_ARGS="-f docker/compose.yaml"
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

# Behind the edge the runner is reached by Host, not by port. Built as
# functions (never a string that gets word-split: `-H Host: x` split over three
# words turns the hostname into a URL and fails every check).
runner_get() {
  if [ -n "$HOST_HEADER" ]; then
    curl -fs -H "Host: ${HOST_HEADER}" "$1"
  else
    curl -fs "$1"
  fi
}

runner_api_get() {
  if [ -n "$HOST_HEADER" ]; then
    curl -fs -H "Authorization: Bearer ${TOKEN}" -H "Host: ${HOST_HEADER}" "$1"
  else
    curl -fs -H "Authorization: Bearer ${TOKEN}" "$1"
  fi
}

# shellcheck disable=SC2086
check "compose stack running" sh -c "docker compose ${COMPOSE_ARGS} ps --format json 2>/dev/null | grep -q control || podman compose ${COMPOSE_ARGS} ps 2>/dev/null | grep -q control"
check "runner /health" runner_get "${RUNNER_URL}/health"
check "runner /ready (reconcile passed)" runner_get "${RUNNER_URL}/ready"
check "runner API auth" runner_api_get "${RUNNER_URL}/v1/apps"
check "rustfs reachable" curl -fs "http://127.0.0.1:${RUSTFS_API_PORT:-9000}/minio/health/live"
# The UI image deploys its own bundle on boot; serving HTML proves the deploy
# landed and the node adopted it.
export UI_URL
check "control UI serves" sh -c 'curl -fs "$UI_URL/" | grep -qi "<html"'

# --- celld's own operator surfaces (the documented ones) --------------------
# The node's public health endpoint is a boolean on the Worker listener.
# Which surfaces apply depends on the lane, so detect it from the running
# container rather than from the host environment.
# `celld diagnose --read-only` reads the node leases in the bucket and probes
# peers without taking a lease. It runs inside the control container: that is
# where the celld binary and the fleet credentials live.
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  ENGINE=podman
fi
case "${COMPOSE:-}" in
*"docker compose"*) ENGINE=docker ;;
*"podman compose"*) ENGINE=podman ;;
esac
CTL_ID="$("$ENGINE" ps --filter "name=control" --format "{{.ID}}" 2>/dev/null | head -1 || true)"
if [ -n "$CTL_ID" ]; then
  # Take the fleet coordinates from the node itself: the host `.env` and the
  # container's environment legitimately differ (the e2e lane runs its own
  # bucket, BYOB repoints the endpoint), and a diagnose aimed at the wrong
  # bucket just reports no leases.
  node_env() {
    "$ENGINE" exec "$CTL_ID" printenv "$1" 2>/dev/null || true
  }
  CTL_DEV="$(node_env NOITE_DEV)"
  CTL_BUCKET="$(node_env NOITE_S3_BUCKET)"
  CTL_ENDPOINT="$(node_env S3_ENDPOINT)"
  CTL_REGION="$(node_env AWS_REGION)"
  if [ "$CTL_DEV" = 1 ]; then
    echo "n/a  celld node health (dev lane: vite dev serves the UI, no celld node)"
  else
    check "celld node health" curl -fs "${UI_URL}/.well-known/celld/health"
  fi
  check "celld fleet diagnose" "$ENGINE" exec "$CTL_ID" celld diagnose --read-only \
    --bucket "s3://${CTL_BUCKET:-${NOITE_S3_BUCKET:-noite}}/control" \
    --endpoint "${CTL_ENDPOINT:-${S3_ENDPOINT:-http://rustfs:9000}}" \
    --region "${CTL_REGION:-${AWS_REGION:-us-east-1}}"
fi

exit "$fail"
