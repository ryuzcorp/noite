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
#   E2E_IMAGE=<tag> make e2e       test a prebuilt local image, no build
#                                  (CI builds each lane's image with buildx
#                                  and hands it to compose this way)
#   E2E_TENANCY=multi make e2e     isolation lane: multi-tenant mode and the
#                                  hostile-tenant spec (E2E_HOSTILE=1)
#   E2E_KEEP=1 make e2e            leave the stack running afterwards (debug)
#   E2E_SUITE=fast make e2e       only the pull-request gate: the tagged
#                                  critical paths (@fast single, @isolation
#                                  multi); `release` (the default) runs
#                                  every spec
#   E2E_SPECS="e2e/forge.spec.ts e2e/prs.spec.ts" make e2e
#                                  run only those spec files (the setup project
#                                  still runs first); quick to check one fix
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
E2E_IMAGE="${E2E_IMAGE:-}"
FILES="-f docker/compose.yaml -f docker/compose.e2e.yaml"
if [ -n "$E2E_IMAGE" ]; then
  export NOITE_IMAGE="$E2E_IMAGE"
  UP_FLAGS=""
elif [ -n "$TAG" ]; then
  export NOITE_IMAGE="ghcr.io/ryuzcorp/noite:${TAG}"
  UP_FLAGS="--pull always"
else
  FILES="$FILES -f docker/compose.build.yaml"
  UP_FLAGS="--build"
fi
# The lane owns these values whatever .env says: its own `*.localhost` base
# (the browser resolves it to loopback, so the control UI and every preview
# host stay same-site) and the lane's ports.
export BASE_DOMAIN=noite.localhost HTTP_PORT=8090 HTTPS_PORT=8443
# The lane's own store port, so a dev stack on :9000 can keep running.
export RUSTFS_API_PORT="${E2E_RUSTFS_PORT:-19000}"
export E2E_TENANCY="${E2E_TENANCY:-single}"
export E2E_SUITE="${E2E_SUITE:-release}"
export E2E_RUNNER_TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL=http://noite.localhost:8090
export E2E_API_BASE=http://localhost:8080
export E2E_GIT_BASE=http://localhost:8080/v1/git
export E2E_RAW_PORTS=1
if [ "$E2E_TENANCY" = multi ]; then
  export E2E_HOSTILE=1
  # The isolation lane is a multi install: it gets the multi cgroup grant,
  # the same file production multi installs apply.
  FILES="$FILES -f docker/compose.multi.yaml"
fi
CE2E="$COMPOSE -p noite-e2e $FILES"

echo "==> reset lane state (fresh volumes, fresh bucket, no session)"
# shellcheck disable=SC2086
$CE2E down -v --remove-orphans >/dev/null 2>&1 || true
# `down -v` is best-effort (podman-compose) — remove whatever it left behind.
remove_project noite-e2e
# A worker killed mid-run (cancel, timeout) leaves the invite lock behind,
# which would stall the next run's invite specs for 120 s.
rm -rf apps/noite/e2e/.auth/user.json apps/noite/e2e/.auth/invite.lock
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
    # E2E_SPECS is a word list of spec paths, split on purpose.
    # shellcheck disable=SC2086
    if (cd apps/noite && npx playwright test ${E2E_SPECS:-}); then
      rc=0
    else
      rc=$?
      # A red lane without container logs is undiagnosable (the CI log holds
      # only the Playwright output): capture the runner + store logs, the
      # Caddy access log (per-request status and upstream latency — the 504s
      # live here) and a stats snapshot into the report dir, which the e2e
      # workflow uploads as an artifact. Runs before the teardown below, while
      # the containers (and the Caddy log inside the volume) still exist.
      echo "==> lane failed — capturing container logs, Caddy access log and stats"
      mkdir -p apps/noite/playwright-report
      # shellcheck disable=SC2086
      $CE2E logs --tail=1000 > apps/noite/playwright-report/lane-containers.log 2>&1 || true
      # shellcheck disable=SC2086
      $CE2E exec -T noite tail -c 2000000 /data/caddy/access.log > apps/noite/playwright-report/lane-caddy-access.log 2>&1 || true
      $CLI stats --no-stream > apps/noite/playwright-report/lane-stats.txt 2>&1 || true
      # A container that OOM-looped (or otherwise restarted) mid-lane leaves
      # no trace in the Playwright output: restart counts plus the OOM-killed
      # flag name the next stall's victim the way logs alone cannot.
      for id in $($CE2E ps -q 2>/dev/null); do
        # shellcheck disable=SC2086
        $CLI inspect --format '{{.Name}} restarts={{.RestartCount}} oom_killed={{.State.OOMKilled}}' $id >> apps/noite/playwright-report/lane-stats.txt 2>&1 || true
      done
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
    if [ "$rc" -eq 0 ]; then
      # The edge static config is written once at boot; app events only push
      # the route table through Caddy's admin API, never reloading. Any
      # Caddy reload after boot (a second static write, "servers shutting
      # down" in the log, or a container restart) fails the lane — and the
      # lane must also prove pushes actually happened (a lane with no pushes
      # would pass vacuously), via the module's per-generation push lines.
      # shellcheck disable=SC2086
      edge_log="$($CE2E logs --tail=20000 noite 2>&1 || true)"
      static_writes="$(printf '%s\n' "$edge_log" | grep -c "edge static config written" || true)"
      if [ "$static_writes" != "1" ]; then
        echo "error: expected exactly one static edge config write, found $static_writes"
        rc=1
      fi
      if printf '%s\n' "$edge_log" | grep -Eq "servers shutting down"; then
        echo "error: caddy reloaded after boot"
        rc=1
      fi
      # shellcheck disable=SC2086
      restarts="$($CE2E ps -q 2>/dev/null | xargs $CLI inspect --format '{{.RestartCount}}' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
      if [ "$restarts" != "0" ]; then
        echo "error: $restarts container restarts during the lane"
        rc=1
      fi
      pushes="$(printf '%s\n' "$edge_log" | grep -c "edge_routes: table pushed" || true)"
      if [ "$pushes" -lt 5 ]; then
        echo "error: expected at least 5 route-table pushes, found $pushes (pushes never ran?)"
        rc=1
      fi
      # The module logs through Caddy's zap logger: "generation":N (JSON),
      # not generation=N.
      maxgen="$(printf '%s\n' "$edge_log" | grep -o '"generation":[0-9]*' | grep -o "[0-9]*" | sort -n | tail -1)"
      if [ -z "$maxgen" ] || [ "$maxgen" -lt 5 ]; then
        echo "error: route-table generation never advanced (max ${maxgen:-none})"
        rc=1
      fi
      if [ "$rc" -eq 0 ]; then
        echo "==> edge did not reload after boot ($pushes pushes, generation $maxgen)"
      fi
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
