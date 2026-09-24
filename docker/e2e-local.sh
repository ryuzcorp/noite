#!/bin/sh
# Local pre-release e2e: boot the prod stack from GHCR tags, deploy the
# control worker, wait for a healthy stack, run Playwright.
#
# Usage: TAG=<short-sha> make e2e   (default TAG=latest, follows main)
#
# Tests the exact bytes the images workflow baked (control service + runner
# cell both pull the SHA tags — nothing builds here). Needs docker (or
# podman), bun, node, and playwright browsers installed; /etc/hosts must
# resolve the subdomain hosts (checked below).
set -eu
cd "$(dirname "$0")/.."

TAG="${TAG:-latest}"
export NOITE_RUNNER_IMAGE="ghcr.io/ryuzcorp/noite:${TAG}"
export NOITE_CADDY_IMAGE="ghcr.io/ryuzcorp/noite-caddy:${TAG}"
export E2E_RUNNER_TOKEN="${E2E_RUNNER_TOKEN:-dev-runner-token}"

if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  ENGINE=podman
fi
PS_COMPOSE="$ENGINE compose -f docker/compose.yaml"

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is not installed"
  exit 1
}
[ -f .env ] || {
  echo "==> writing .env from example"
  cp .env.example .env
}
for host in api.localhost git.localhost e2e.localhost; do
  getent hosts "$host" >/dev/null 2>&1 || {
    echo "error: missing /etc/hosts entry for $host — add:"
    echo "  127.0.0.1 api.localhost git.localhost e2e.localhost"
    exit 1
  }
done

echo "==> boot stack (${NOITE_RUNNER_IMAGE})"
make up-e2e

echo "==> build control worker"
(cd apps/noite && bun run build)

# The runner cell pulls (never builds): point dist/wrangler.json at the
# same GHCR tag the control service runs.
echo "==> point runner cell at ${NOITE_RUNNER_IMAGE}"
python3 -c "import json,os; p='apps/noite/dist/wrangler.json'; d=json.load(open(p)); d['containers'][0]['image']=os.environ['NOITE_RUNNER_IMAGE']; json.dump(d, open(p,'w'), indent=2)"

# The node has no published API port, so deploy from inside the control
# container with CWD at the /repo mount: `celld deploy` re-bundles with
# esbuild, which resolves node_modules above the CWD.
echo "==> deploy control worker"
CID="$($PS_COMPOSE ps -q control)"
$ENGINE exec -w /repo/apps/noite "$CID" celld deploy dist \
  --bucket "s3://noite/control" \
  --endpoint http://rustfs:9000 \
  --region us-east-1

echo "==> wait for healthy stack (5 min)"
for _ in $(seq 1 30); do
  if make doctor; then
    echo "==> playwright e2e"
    (cd apps/noite && npx playwright test)
    exit 0
  fi
  sleep 10
done
echo "stack never became healthy — dumping logs"
$PS_COMPOSE logs --tail=200
exit 1
