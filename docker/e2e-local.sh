#!/bin/sh
# Local pre-release lane (`make e2e`): raw localhost:ports, no Caddy, no
# subdomains, no cells.
#
# Topology: rustfs :9000, runner (plain GHCR container) :8080 + tenants on
# their 81xx listen ports, control UI :8090. The runner cell needs a fenced
# engine this machine doesn't have, so e2e runs the same image as a plain
# container with the worker in RUNNER_TARGET=compose. No Caddyfile rewrites,
# no Host dispatch, no /etc/hosts.
#
# Hermetic reruns: the runner /data bind (docker/.e2e-data) is wiped and
# s3://noite-e2e emptied at lane start, so fixed slugs never collide.
#
# Validates: GHCR bytes, signup/passkey, git push, deploy, tenant serve.
# NOT covered: cell boot, DO dispatch, fence (needs a rootful engine).
#
# Usage: TAG=<short-sha> make e2e   (default TAG=latest, follows main)
set -eu
cd "$(dirname "$0")/.."

TAG="${TAG:-latest}"
export NOITE_RUNNER_IMAGE="ghcr.io/ryuzcorp/noite:${TAG}"
export E2E_RUNNER_TOKEN="${E2E_RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:8090}"
export E2E_API_BASE="${E2E_API_BASE:-http://localhost:8080}"
export E2E_GIT_BASE="${E2E_GIT_BASE:-http://localhost:8080/v1/git}"
export E2E_RAW_PORTS=1
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  ENGINE=podman
fi
CPL_COMPOSE="${COMPOSE:-$ENGINE compose}"
case "$CPL_COMPOSE" in
*"-f"*) CPL="$CPL_COMPOSE" ;;
*) CPL="$CPL_COMPOSE -f docker/compose.yaml" ;;
esac
EXEC="${CPL%% *}"
[ "$EXEC" = podman-compose ] && EXEC=podman
# Own project: never touch the dev/prod `noite` containers (same service
# names would collide). Everything below addresses $CE2E.
CE2E="$CPL -p noite-e2e -f docker/compose.e2e.yaml"
# Socket for `celld deploy` image pulls from inside control (pulls work
# rootless — only the fence needs rootful). Override DOCKER_SOCK=<path>.
if [ -z "${DOCKER_SOCK:-}" ] && [ "$EXEC" = podman ]; then
  for sock in /run/podman/podman.sock "/run/user/$(id -u)/podman/podman.sock"; do
    if [ -S "$sock" ] && [ -r "$sock" ] && [ -w "$sock" ]; then
      DOCKER_SOCK="$sock"
      break
    fi
  done
fi
export DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
[ -S "$DOCKER_SOCK" ] || {
  echo "error: no engine socket at $DOCKER_SOCK."
  echo "  docker: start the daemon; podman: systemctl --user start podman.socket;"
  echo "  or pass DOCKER_SOCK=<socket>."
  exit 1
}

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is not installed"
  exit 1
}
[ -f .env ] || {
  echo "==> writing .env from example"
  cp .env.example .env
}
# shellcheck disable=SC1091
set -a
. ./.env
set +a

echo "==> reset lane state (fresh bind dir, empty bucket, no session)"
$CE2E down --remove-orphans >/dev/null 2>&1 || true
rm -rf docker/.e2e-data apps/noite/e2e/.auth/user.json
mkdir -p docker/.e2e-data
# Dev stack on the same host ports blocks the lane — fail fast with a
# clear message instead of a cryptic bind error mid-up.
for p in 8080 8090 9000; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${p}/" 2>/dev/null; then
    echo "error: host port ${p} already answers — stop the dev stack first"
    exit 1
  fi
done
$CE2E up -d rustfs
# Cold rustfs takes seconds to answer; retry the wipe, then fail loud.
wiped=0
for _ in $(seq 1 12); do
  if E2E_WIPE_BUCKET=noite-e2e E2E_S3_ENDPOINT=http://127.0.0.1:9000 bun apps/noite/scripts/e2e-wipe-bucket.mjs; then
    wiped=1
    break
  fi
  sleep 5
done
[ "$wiped" = 1 ] || exit 1

echo "==> boot stack (${NOITE_RUNNER_IMAGE})"
$CE2E up -d --pull always control runner

echo "==> build control worker"
(cd apps/noite && bun run build)

# Point the (unused here) runner cell at the tested tag and flip the worker
# to compose target with raw-port URLs.
echo "==> point worker at compose runner"
python3 -c "
import json
p = 'apps/noite/dist/wrangler.json'
d = json.load(open(p))
d['containers'][0]['image'] = 'ghcr.io/ryuzcorp/noite:${TAG}'
d['vars']['RUNNER_TARGET'] = 'compose'
d['vars']['RUNNER_URL'] = 'http://runner:8080'
d['vars']['BETTER_AUTH_URL'] = 'http://localhost:8090'
json.dump(d, open(p, 'w'), indent=2)
"

# The node has no published API port, so deploy from inside the control
# container with CWD at the /repo mount: `celld deploy` re-bundles with
# esbuild, which resolves node_modules above the CWD.
echo "==> deploy control worker"
CID="$($EXEC ps -q --filter 'name=control' | head -1)"
[ -n "$CID" ] || {
  echo "error: control container not found after up"
  exit 1
}
$EXEC exec -w /repo/apps/noite "$CID" celld deploy dist \
  --bucket "s3://noite-e2e/control" \
  --endpoint http://rustfs:9000 \
  --region us-east-1

# Version convergence: nodes adopt at the next pointer poll (~5s). Doctor
# goes green on static assets from either version, but an adoption swap
# mid-passkey-ceremony kills it — wait it out before any test runs.
echo "==> wait for version adoption"
sleep 30

echo "==> wait for healthy stack (5 min)"
for _ in $(seq 1 30); do
  if make doctor; then
    # Warm the worker isolate + D1 before the passkey ceremony: the first
    # API hit cold-starts both, and a slow first call fails registration
    # (retry covers it, but warm is deterministic). Any HTTP answer counts.
    for _ in $(seq 1 12); do
      if curl -s -o /dev/null --max-time 10 "http://localhost:8090/api/auth/get-session"; then
        break
      fi
      sleep 5
    done
    echo "==> playwright e2e"
    (cd apps/noite && npx playwright test)
    rc=$?
    # Lane ends clean (containers down, data kept for forensics) so the
    # next `make dev` never fights e2e leftovers for host ports.
    $CE2E down --remove-orphans >/dev/null 2>&1 || true
    exit "$rc"
  fi
  sleep 10
done
echo "stack never became healthy — dumping logs"
$CE2E logs --tail=200
exit 1
