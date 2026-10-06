#!/bin/sh
# `make doctor`: codified health checks for the one-service install.
#
# /ready is the summary (reconcile, bucket, tenant isolation in multi, the
# control fleet, Caddy's config); when it fails its body names the failing
# gates, and this script prints it. The rest checks what /ready cannot see
# from inside: the edge from the host, API auth, and celld's own fleet view.
#
# E2E_RAW_PORTS=1 (the e2e lane): the lane publishes the runner on :8080 and
# serves the UI through Caddy on :8090 under its own compose project.
set -eu
cd "$(dirname "$0")/.."
# shellcheck source=docker/lib.sh
. "$(dirname "$0")/lib.sh"
load_env

TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
if [ "${E2E_RAW_PORTS:-}" = 1 ]; then
  EDGE="http://127.0.0.1:8090"
  API="http://127.0.0.1:8080"
  API_HOST=""
  PROJECT=noite-e2e
else
  EDGE="http://127.0.0.1:${HTTP_PORT:-9080}"
  API="$EDGE"
  API_HOST="api.localhost"
  PROJECT=noite
fi

detect_engine

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

api() {
  if [ -n "$API_HOST" ]; then
    curl -fs -H "Host: ${API_HOST}" "$@"
  else
    curl -fs "$@"
  fi
}

# The noite container of this project (compose names it <project>_noite_1 or
# <project>-noite-1 depending on the engine).
CID="$("$ENGINE" ps --format '{{.ID}} {{.Names}}' 2>/dev/null |
  awk -v p="$PROJECT" '$2 ~ "^"p"[-_]noite[-_]" {print $1; exit}')"

if [ -z "$CID" ]; then
  echo "FAIL noite container running (project ${PROJECT})"
  exit 1
fi
echo "ok   noite container running"

ready="$("$ENGINE" exec "$CID" curl -s -m 10 http://127.0.0.1:8080/ready 2>/dev/null || true)"
if printf '%s' "$ready" | grep -q '"ok":true'; then
  echo "ok   runner /ready (reconcile, bucket, isolation, control, caddy)"
else
  echo "FAIL runner /ready: ${ready:-no answer}"
  fail=1
fi

check "runner API auth" api -H "Authorization: Bearer ${TOKEN}" "${API}/v1/apps"
# Ask for HTML like a browser: the control worker's page router answers a
# bare `Accept: */*` with 404 (API routes and assets are unaffected).
check "edge serves the control UI" sh -c "curl -fs -H 'Host: localhost' -H 'Accept: text/html' '${EDGE}/' | grep -qi '<html'"
check "control auth routes" sh -c "curl -fs -H 'Host: localhost' '${EDGE}/api/auth/ok' | grep -q ok"

# celld's own view of the control fleet: leases, peers, advertised addresses.
# Skipped in the dev image (vite dev serves the UI; there is no control node).
if "$ENGINE" exec "$CID" test -d /opt/noite/control/dist 2>/dev/null; then
  bucket="$("$ENGINE" exec "$CID" printenv NOITE_S3_BUCKET 2>/dev/null || echo noite)"
  endpoint="$("$ENGINE" exec "$CID" printenv S3_ENDPOINT 2>/dev/null || echo http://rustfs:9000)"
  region="$("$ENGINE" exec "$CID" printenv AWS_REGION 2>/dev/null || echo us-east-1)"
  check "celld control node health" "$ENGINE" exec "$CID" curl -fs http://127.0.0.1:8090/.well-known/celld/health
  # `diagnose` bind-checks a listener of its own; its default (:8080) is the
  # runner's port in this container, so give it an ephemeral one.
  check "celld control fleet diagnose" "$ENGINE" exec "$CID" celld diagnose --read-only \
    --listen 127.0.0.1:0 \
    --bucket "s3://${bucket}/control" --endpoint "$endpoint" --region "$region"
else
  echo "n/a  celld control node (dev image: vite dev serves the UI)"
fi

exit "$fail"
