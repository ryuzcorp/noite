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
# The host the edge answers on: the configured base, else the shipped dev
# default. Both dev and the e2e lane serve the control UI on the bare base.
BASE_HOST="${BASE_DOMAIN:-noite.localhost}"
if [ "${E2E_RAW_PORTS:-}" = 1 ]; then
  EDGE="http://127.0.0.1:8090"
  API="http://127.0.0.1:8080"
  API_HOST=""
  PROJECT=noite-e2e
else
  EDGE="http://127.0.0.1:${HTTP_PORT:-9080}"
  API="$EDGE"
  API_HOST="api.${BASE_HOST}"
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
# What tenant fleets hold (SPEC, Scoped credentials): `scoped (...)` is the
# goal; `root (...)` is explicit and loud, especially with multi tenancy.
credentials="$(printf '%s' "$ready" | sed -n 's/.*"credentials":"\([^"]*\)".*/\1/p')"
if [ -n "$credentials" ]; then
  case "$credentials" in
    scoped*)
      echo "ok   tenant bucket credentials: $credentials"
      ;;
    *)
      echo "WARN tenant bucket credentials: $credentials"
      ;;
  esac
fi
# Orphan scoped-key sweep (SPEC, Scoped credentials): a listing failure
# revokes nothing, so surface it loudly; otherwise report the count.
sweep_err="$(printf '%s' "$ready" | sed -n 's/.*"credential_sweep":{[^}]*"last_error":"\([^"]*\)".*/\1/p')"
sweep_revoked="$(printf '%s' "$ready" | sed -n 's/.*"credential_sweep":{[^}]*"revoked_total":\([^,}]*\).*/\1/p')"
sweep_tag="$(printf '%s' "$ready" | sed -n 's/.*"credential_sweep":{[^}]*"install_tag":"\([^"]*\)".*/\1/p')"
if [ -n "$sweep_tag" ]; then
  echo "ok   install tag: $sweep_tag"
fi
if [ -n "$sweep_err" ] && [ "$sweep_err" != "null" ]; then
  echo "WARN orphan credential sweep: last listing failed ($sweep_err)"
elif [ -n "$sweep_revoked" ] && [ "$sweep_revoked" != "0" ]; then
  echo "ok   orphan credential sweep (revoked total $sweep_revoked)"
fi
# State-snapshot health (`/ready` `snapshot`: still the bucket owner, how long
# ago the last upload finished, the last upload error).
snapshot_owner="$(printf '%s' "$ready" | sed -n 's/.*"snapshot":{[^}]*"owner":\([^,}]*\).*/\1/p')"
snapshot_age="$(printf '%s' "$ready" | sed -n 's/.*"snapshot":{[^}]*"last_upload_secs_ago":\([^,}]*\).*/\1/p')"
snapshot_err="$(printf '%s' "$ready" | sed -n 's/.*"snapshot":{[^}]*"last_error":"\([^"]*\)".*/\1/p')"
if [ -n "$snapshot_owner" ]; then
  if [ "$snapshot_owner" = "true" ] && [ -z "$snapshot_err" ]; then
    echo "ok   state snapshot (owner, last upload ${snapshot_age:-?}s ago)"
  else
    echo "WARN state snapshot (owner=${snapshot_owner}, last upload ${snapshot_age:-?}s ago, error=${snapshot_err:-none})"
  fi
fi
# Per-fleet cgroups (SPEC, Tenant isolation): live means every tenant fleet
# runs in its own group with its own `memory.max`. Inactive shares the
# container cgroup, and a multi install stays at 503 on /ready above until
# the operator applies the multi grant — so the failure names the fix.
cgroups_active="$(printf '%s' "$ready" | sed -n 's/.*"cgroups":{"active":\([^,}]*\).*/\1/p')"
cgroups_detail="$(printf '%s' "$ready" | sed -n 's/.*"cgroups":{[^}]*"detail":"\([^"]*\)".*/\1/p')"
if [ "$cgroups_active" = "true" ]; then
  echo "ok   per-fleet cgroups (${cgroups_detail:-no detail})"
else
  echo "WARN per-fleet cgroups inactive (fleets share the container cgroup)"
  echo "     fix for multi installs: layer the cgroup grant and recreate:"
  echo "       docker compose -f docker/compose.yaml -f docker/compose.multi.yaml up -d"
  echo "     single installs need nothing (this stays a warning)."
fi

check "runner API auth" api -H "Authorization: Bearer ${TOKEN}" "${API}/v1/apps"
# Opt-out release check (SPEC, update check): on/off plus the newest release
# the runner has seen. Informational only — an unanswered endpoint must not
# fail the health check.
update_body="$(api -H "Authorization: Bearer ${TOKEN}" "${API}/v1/admin/update" 2>/dev/null || true)"
if [ -n "$update_body" ]; then
  update_enabled="$(printf '%s' "$update_body" | sed -n 's/.*"enabled":\([^,}]*\).*/\1/p')"
  update_latest="$(printf '%s' "$update_body" | sed -n 's/.*"latest":\("[^"]*"\|null\).*/\1/p' | tr -d '"')"
  echo "ok   update check ${update_enabled} (latest seen: ${update_latest:-none})"
else
  echo "WARN update check: no answer from /v1/admin/update"
fi

# Ask for HTML like a browser: the control worker's page router answers a
# bare `Accept: */*` with 404 (API routes and assets are unaffected).
check "edge serves the control UI" sh -c "curl -fs -H 'Host: ${BASE_HOST}' -H 'Accept: text/html' '${EDGE}/' | grep -qi '<html'"
check "control auth routes" sh -c "curl -fs -H 'Host: ${BASE_HOST}' '${EDGE}/api/auth/ok' | grep -q ok"

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
