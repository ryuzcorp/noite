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
#   E2E_SLOT=<n> make e2e          parallel lane <n> (default 0): its own
#                                  compose project, container/volume/network
#                                  names, bucket and a non-overlapping port
#                                  block (API/Caddy/store/fleet range all shift
#                                  with the slot). Unset or 0 is exactly
#                                  today's lane, so CI is unaffected.
#                                  `E2E_SLOT=auto` takes the first free slot
#                                  lock (1-8). Pick a free slot, or let the
#                                  script: concurrent lanes must use different
#                                  slots. `E2E_SLOT=<n> sh docker/e2e-local.sh
#                                  down` (or `E2E_SLOT=<n> make e2e-down`)
#                                  stops that slot's stack and frees a kept
#                                  session.
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
# Parallel lanes: E2E_SLOT picks the lane. Unset or 0 is exactly today's lane
# (project noite-e2e, ports 8080/8090/8443/19000 and fleet range
# 20000-20099 published), so CI is unaffected. Each n > 0 gets its own
# compose project (noite-e2e-<n>), container/volume/network names, bucket and
# a non-overlapping port block. The lock lives in this script now: it takes
# `flock -o` on the slot's own lock file, so a lane can never run unlocked.
# `-o` (close-on-exec) is mandatory: podman's `aardvark-dns` once inherited
# the fd and wedged the lane for 13 h. Callers that still wrap the whole
# command in `flock -o /tmp/noite-e2e-lane.lock` keep working on slot 0 (a
# different file, so no deadlock with the inner lock); that outer wrapper no
# longer excludes other slot-0 runs — pass E2E_SLOT instead.
E2E_SLOT_EXPLICIT="${E2E_SLOT:-}"
E2E_SLOT="${E2E_SLOT_EXPLICIT:-0}"
DOWN=0
if [ "${1:-}" = "down" ]; then
  DOWN=1
fi
case "$E2E_SLOT" in
  ""|0) SLOT=0 ;;
  auto) SLOT=auto ;;
  *[!0-9]*)
    echo "error: E2E_SLOT must be 0, a positive integer, or auto, not '${E2E_SLOT}'"
    exit 1
    ;;
  *) SLOT="$E2E_SLOT" ;;
esac
if [ "$DOWN" = 1 ]; then
  case "$E2E_SLOT_EXPLICIT" in
    ""|auto|*[!0-9]*)
      echo "error: stopping a lane needs an explicit slot: E2E_SLOT=<n> sh docker/e2e-local.sh down (E2E_SLOT=<n> make e2e-down). Refusing to touch a slot you did not name — another agent may own that stack."
      exit 1
      ;;
  esac
fi
# `auto` takes the first free slot lock (1-8), each attempt a real
# acquisition, never a probe: `--conflict-exit-code 99` tells a busy lock
# apart from a lane that ran and failed, so only 99 advances to the next
# slot and the lane's own status propagates untouched.
if [ "$SLOT" = auto ]; then
  for n in 1 2 3 4 5 6 7 8; do
    # `|| rc=$?`, never a bare call: under `set -e` a busy slot's 99 would
    # exit the script before the next slot is tried.
    rc=0
    flock -o -n -E 99 "/tmp/noite-e2e-lane-${n}.lock" env E2E_LOCK_HELD="$n" E2E_SLOT="$n" "$0" "$@" || rc=$?
    if [ "$rc" -ne 99 ]; then
      exit "$rc"
    fi
  done
  echo "error: no free E2E slot (1-8 all hold a lane); wait, or pass E2E_SLOT=<n> with E2E_LOCK_WAIT=<s> to queue"
  exit 1
fi
LOCK="/tmp/noite-e2e-lane-${SLOT}.lock"
KEEP_FILE="${LOCK}.keep"
E2E_LOCK_WAIT="${E2E_LOCK_WAIT:-300}"
if [ "${E2E_LOCK_HELD:-}" != "$SLOT" ]; then
  echo "==> waiting up to ${E2E_LOCK_WAIT}s for E2E slot ${SLOT} (${LOCK}; E2E_SLOT=auto picks a free slot)"
  # A lock timeout exits 99 (`-E`), apart from the lane's own status: only
  # a timeout is "busy"; a red lane reports its own failure.
  rc=0
  flock -o -w "$E2E_LOCK_WAIT" -E 99 "$LOCK" env E2E_LOCK_HELD="$SLOT" E2E_SLOT="$SLOT" "$0" "$@" || rc=$?
  if [ "$rc" -eq 99 ]; then
    echo "error: E2E slot ${SLOT} is busy (another lane holds ${LOCK}); E2E_SLOT=auto picks a free slot, E2E_LOCK_WAIT=<s> waits longer"
  fi
  exit "$rc"
fi
# Every slot value below is derived from SLOT; slot 0 keeps today's literals.
if [ "$SLOT" = 0 ]; then
  API_PORT=8080
  LANE_HTTP_PORT=8090
  LANE_HTTPS_PORT=8443
  STORE_PORT=19000
  FLEET_RANGE="20000-20099:20000-20099"
  FLEET_PORTS=""
  PROJECT=noite-e2e
  BUCKET=noite-e2e
  AUTH_DIR="$PWD/apps/noite/e2e/.auth"
  REPORT_DIR="$PWD/apps/noite/playwright-report"
  TEST_OUT_DIR="$PWD/apps/noite/test-results"
else
  API_PORT=$((8080 + 100 * SLOT))
  LANE_HTTP_PORT=$((8090 + 100 * SLOT))
  LANE_HTTPS_PORT=$((8443 + 100 * SLOT))
  STORE_PORT=$((19000 + 100 * SLOT))
  FLEET_MIN=$((20000 + 1000 * SLOT))
  FLEET_RANGE="${FLEET_MIN}-$((FLEET_MIN + 99)):${FLEET_MIN}-$((FLEET_MIN + 99))"
  FLEET_PORTS="${FLEET_MIN}-$((FLEET_MIN + 99))"
  PROJECT="noite-e2e-${SLOT}"
  BUCKET="noite-e2e-${SLOT}"
  AUTH_DIR="$PWD/apps/noite/e2e/.auth-${SLOT}"
  REPORT_DIR="$PWD/apps/noite/playwright-report-${SLOT}"
  TEST_OUT_DIR="$PWD/apps/noite/test-results-${SLOT}"
fi
# The lane owns these values whatever .env says: its own `*.localhost` base
# (the browser resolves it to loopback, so the control UI and every preview
# host stay same-site) and the slot's ports. All slots share the
# `noite.localhost` base: origins still differ by port, so cookies,
# passkeys and storage never cross between concurrent lanes.
export BASE_DOMAIN=noite.localhost HTTP_PORT="$LANE_HTTP_PORT" HTTPS_PORT="$LANE_HTTPS_PORT"
# The lane's own store port, so a dev stack on :9000 can keep running.
export RUSTFS_API_PORT="${E2E_RUSTFS_PORT:-$STORE_PORT}"
export E2E_API_PORT="$API_PORT" E2E_HTTP_PORT="$LANE_HTTP_PORT"
export E2E_SLOT="$SLOT" E2E_PROJECT="$PROJECT"
export E2E_TENANCY="${E2E_TENANCY:-}"
export E2E_SUITE="${E2E_SUITE:-release}"
export E2E_RUNNER_TOKEN="${RUNNER_TOKEN:-dev-runner-token}"
export E2E_BASE_URL="http://noite.localhost:${LANE_HTTP_PORT}"
export E2E_API_BASE="http://localhost:${API_PORT}"
export E2E_GIT_BASE="http://localhost:${API_PORT}/v1/git"
export E2E_RAW_PORTS=1
# Slot-scoped Playwright state: two lanes in one checkout must not share a
# cookie jar (cookies ignore ports, so one .auth dir would cross logins), a
# report dir or a test-results dir. Slot 0 keeps today's paths.
export E2E_AUTH_DIR="${E2E_AUTH_DIR:-$AUTH_DIR}"
export E2E_REPORT_DIR="${E2E_REPORT_DIR:-$REPORT_DIR}"
export E2E_TEST_DIR="${E2E_TEST_DIR:-$TEST_OUT_DIR}"
export E2E_FLEET_RANGE="$FLEET_RANGE" E2E_FLEET_PORTS="$FLEET_PORTS"
export E2E_BUCKET="$BUCKET"
if [ -z "$E2E_TENANCY" ]; then
  # No explicit lane tenancy: follow the runner's own default
  # (is_multi_tenancy mirrors parse_tenancy), so the overlay decision can
  # never disagree with the runner about multi.
  if is_multi_tenancy; then
    E2E_TENANCY=multi
  else
    E2E_TENANCY=single
  fi
fi
export E2E_TENANCY
if [ "$E2E_TENANCY" = multi ]; then
  export E2E_HOSTILE=1
  # The isolation lane is a multi install: it gets the multi cgroup grant,
  # the same file production multi installs apply.
  FILES="$FILES -f docker/compose.multi.yaml"
fi
if [ "$SLOT" != 0 ]; then
  # Slots above 0 narrow the runner's fleet allocation to the slot's own
  # published block. Slot 0 never applies this file, so its rendered config
  # stays byte-identical to the unparameterized lane.
  FILES="$FILES -f docker/compose.slot.yaml"
fi
CE2E="$COMPOSE -p $PROJECT $FILES"

if [ "$DOWN" = 1 ]; then
  echo "==> E2E slot ${SLOT}: stopping the stack and freeing the session"
  # shellcheck disable=SC2086
  $CE2E down -v --remove-orphans >/dev/null 2>&1 || true
  remove_project "$PROJECT"
  if [ -f "$KEEP_FILE" ]; then
    kept_pid="$(cat "$KEEP_FILE" 2>/dev/null || true)"
    if [ -n "$kept_pid" ] && kill -0 "$kept_pid" 2>/dev/null; then
      kill "$kept_pid" 2>/dev/null || true
    fi
    rm -f "$KEEP_FILE"
  fi
  rm -rf "$E2E_AUTH_DIR/user.json" "$E2E_AUTH_DIR/invite.lock"
  echo "==> E2E slot ${SLOT} is down"
  exit 0
fi
# A kept session (E2E_KEEP=1) holds the slot until this script's `down` frees
# it. The sentinel is written and cleared under this slot's lock, so a stale
# pid (reboot, kill -9) is reaped here, never wedging the slot.
if [ -f "$KEEP_FILE" ]; then
  kept_pid="$(cat "$KEEP_FILE" 2>/dev/null || true)"
  if [ -n "$kept_pid" ] && kill -0 "$kept_pid" 2>/dev/null; then
    echo "error: E2E slot ${SLOT} is kept by pid ${kept_pid} (E2E_KEEP=1 stack still up); free it with E2E_SLOT=${SLOT} sh docker/e2e-local.sh down (E2E_SLOT=${SLOT} make e2e-down)"
    exit 1
  fi
  echo "==> removing stale keep sentinel for E2E slot ${SLOT} (pid ${kept_pid:-unknown} is gone)"
  rm -f "$KEEP_FILE"
fi

echo "==> E2E slot ${SLOT}: project ${PROJECT}, api :${API_PORT}, caddy :${LANE_HTTP_PORT}/:${LANE_HTTPS_PORT}, store :${RUSTFS_API_PORT}, fleets ${FLEET_RANGE:-default}"
echo "==> reset lane state (fresh volumes, fresh bucket, no session)"
# shellcheck disable=SC2086
$CE2E down -v --remove-orphans >/dev/null 2>&1 || true
# `down -v` is best-effort (podman-compose) — remove whatever it left behind.
remove_project "$PROJECT"
# A worker killed mid-run (cancel, timeout) leaves the invite lock behind,
# which would stall the next run's invite specs for 120 s.
rm -rf "$E2E_AUTH_DIR/user.json" "$E2E_AUTH_DIR/invite.lock"
for p in "$API_PORT" "$LANE_HTTP_PORT" "$LANE_HTTPS_PORT" "$RUSTFS_API_PORT"; do
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
# Every boot-gate doctor run, passing or not, for the snapshot-parser check
# below: on a fresh boot no snapshot has uploaded yet (`last_upload_secs_ago`
# is JSON null), which is exactly the body the old parser rendered as
# "last upload nulls ago".
doctor_poll_log="$(mktemp)"
# Same 5-minute budget, checked every 3 s: the stack is usually up within
# seconds of the first failed check.
while [ "$attempt" -lt 100 ]; do
  if doctor_out="$(sh docker/doctor.sh 2>&1)"; then
    printf '%s\n' "$doctor_out"
    printf '%s\n' "$doctor_out" >>"$doctor_poll_log"
    # The snapshot parser must render a null age as "no upload yet": the
    # literal "null" in the /ready body used to print "last upload nulls
    # ago". Checked over every attempt so a fresh boot (no upload yet)
    # fails before the doctor fix and passes after it.
    if grep -q "nulls ago" "$doctor_poll_log"; then
      echo "error: doctor printed an unparsed snapshot age"
      # shellcheck disable=SC2086
      $CE2E down --remove-orphans >/dev/null 2>&1 || true
      rm -f "$doctor_poll_log"
      exit 1
    fi
    echo "==> playwright e2e"
    # `set -e` would abort on a failing suite and skip the teardown below,
    # leaving the stack holding the host ports; capture the status instead.
    # E2E_SPECS is a word list of spec paths, split on purpose.
    # shellcheck disable=SC2086
    if (cd apps/noite && npx playwright test ${E2E_SPECS:-}); then
      rc=0
    else
      rc=$?
    fi
    # Lane logs land in the report dir on every run, green or red, so green
    # runs can be compared with red ones (the e2e workflow uploads the dir
    # as an artifact). Runs before the teardown below, while the
    # containers (and the Caddy log inside the volume) still exist. Bounds:
    # the container log is tail-limited (100 lines on success, 1000 on
    # failure), the Caddy access log is capped at 2 MB; the stats snapshot
    # is small.
    if [ "$rc" -eq 0 ]; then
      echo "==> lane green — capturing bounded container logs, Caddy access log and stats"
      CONTAINER_TAIL=100
    else
      # A red lane without container logs is undiagnosable (the CI log holds
      # only the Playwright output): capture the runner + store logs, the
      # Caddy access log (per-request status and upstream latency — the
      # 504s live here) and a stats snapshot.
      echo "==> lane failed — capturing container logs, Caddy access log and stats"
      CONTAINER_TAIL=1000
      # A hung Playwright worker (a blocked event loop — a wedged `git`
      # child held the multi lane open for 35 silent minutes in merge-queue
      # run 39785255412) leaves no trace in the Playwright output either:
      # the host process tree (parents included) names the stuck command
      # and its arguments, the way the orphan `git` + `git-remote-http`
      # pair did there. Host-side, so it also covers children the lane's
      # containers never see.
      mkdir -p "$E2E_REPORT_DIR"
      ps -ef > "$E2E_REPORT_DIR/lane-host-procs.txt" 2>&1 || true
      echo "==> see lane-containers.log, lane-host-procs.txt and lane-stats.txt in the playwright-report artifact"
    fi
    mkdir -p "$E2E_REPORT_DIR"
    # shellcheck disable=SC2086
    $CE2E logs --tail="$CONTAINER_TAIL" > "$E2E_REPORT_DIR/lane-containers.log" 2>&1 || true
    # shellcheck disable=SC2086
    $CE2E exec -T noite tail -c 2000000 /data/caddy/access.log > "$E2E_REPORT_DIR/lane-caddy-access.log" 2>&1 || true
    $CLI stats --no-stream > "$E2E_REPORT_DIR/lane-stats.txt" 2>&1 || true
    # A container that OOM-looped (or otherwise restarted) mid-lane leaves
    # no trace in the Playwright output: restart counts plus the OOM-killed
    # flag name the next stall's victim the way logs alone cannot.
    for id in $($CE2E ps -q 2>/dev/null); do
      # shellcheck disable=SC2086
      $CLI inspect --format '{{.Name}} restarts={{.RestartCount}} oom_killed={{.State.OOMKilled}}' $id >> "$E2E_REPORT_DIR/lane-stats.txt" 2>&1 || true
    done
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

    if [ "$rc" -eq 0 ] && [ "$E2E_TENANCY" = multi ]; then
      # The multi lane proves containment end to end, so doctor must name
      # the live cgroups — a parser that never matches the /ready body
      # would pass the boot gate while printing the inactive warning.
      if sh docker/doctor.sh 2>&1 | grep -q '^ok   per-fleet cgroups'; then
        echo "ok   lane doctor names the live per-fleet cgroups"
      else
        echo "error: multi lane doctor names no live per-fleet cgroups"
        rc=1
      fi
    fi
    if [ "$rc" -eq 0 ]; then
      # The snapshot parser must stay in sync with /ready: a parser that
      # never matches would print no snapshot line while the boot gate
      # passes (mirrors the cgroups check above; the null-age shape is
      # covered by the boot-gate check).
      if sh docker/doctor.sh 2>&1 | grep -qE '^(ok|WARN) +state snapshot'; then
        echo "ok   lane doctor names the snapshot status"
      else
        echo "error: lane doctor names no snapshot status"
        rc=1
      fi
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
    # Fleet peak aggregation (D3 sizing basis in SPEC, Limits): every stopped
    # fleet logs `fleet=… peak_bytes=…` at info before its cgroup leaf is
    # removed, and the live leaves are read here at suite end. The merged
    # per-fleet maxima land in the always-uploaded report as
    # fleet-peaks.json, next to the human-readable lane-stats.txt lines.
    # Only tenant fleets count: the `runner` leaf holds the platform itself
    # (runner, Caddy, the control fleet), not a tenant footprint.
    # Best-effort: never fails the lane.
    {
      echo "==> fleet peaks at suite end"
      # shellcheck disable=SC2016
      $CE2E exec -T noite sh -c 'for d in /sys/fs/cgroup/noite/*/; do n=$(basename "$d"); if [ "$n" = runner ] || [ ! -f "$d/memory.peak" ]; then continue; fi; echo "fleet-peak $n peak=$(cat "$d/memory.peak") max=$(cat "$d/memory.max" 2>/dev/null || echo ?)"; done; echo "container-peak $(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unknown)"' 2>/dev/null || echo "peak dump unavailable"
    } >> "$E2E_REPORT_DIR/lane-stats.txt" 2>&1 || true
    peak_log="$(mktemp)"
    peak_stripped="$(mktemp)"
    # shellcheck disable=SC2086
    $CE2E logs noite >"$peak_log" 2>&1 || true
    # The runner log carries ANSI escapes around field names and values
    # (but never inside the message text, which is why the lane's message
    # greps kept working): strip them before parsing `fleet=`/`peak_bytes=`.
    sed -e 's/\x1b\[[0-9;]*m//g' "$peak_log" 2>/dev/null >"$peak_stripped" || true
    grep -a "peak_bytes=" "$peak_stripped" 2>/dev/null | sed -n 's/.*fleet="\{0,1\}\([^" ]*\)"\{0,1\} peak_bytes=\([0-9][0-9]*\).*/\1 \2/p' > "$E2E_REPORT_DIR/fleet-peak-lines.txt" || true
    grep -a "stopped celld" "$peak_stripped" 2>/dev/null > "$E2E_REPORT_DIR/fleet-stop-lines.txt" || true
    {
      cat "$E2E_REPORT_DIR/fleet-peak-lines.txt" 2>/dev/null || true
      # shellcheck disable=SC2016
      $CE2E exec -T noite sh -c 'for d in /sys/fs/cgroup/noite/*/; do n=$(basename "$d"); if [ "$n" = runner ] || [ ! -f "$d/memory.peak" ]; then continue; fi; echo "$n $(cat "$d/memory.peak")"; done' 2>/dev/null || true
    } | awk '$2 ~ /^[0-9]+$/ { if ($2 + 0 > peak[$1]) peak[$1] = $2 + 0 } END { printf "{\n  \"fleet_peaks\": {"; sep = "\n"; for (f in peak) { printf "%s    \"%s\": %d", sep, f, peak[f]; sep = ",\n" } printf "\n  }\n}\n" }' > "$E2E_REPORT_DIR/fleet-peaks.json" || true
    echo "fleet stops: $(grep -ac "stopped celld" "$peak_stripped" 2>/dev/null || echo 0) stop lines, $(wc -l < "$E2E_REPORT_DIR/fleet-peak-lines.txt" 2>/dev/null || echo 0) with peaks in the container log"
    rm -f "$peak_log" "$peak_stripped"
    if [ "${E2E_KEEP:-0}" = 1 ]; then
      # A kept session holds the slot until `down` frees it: the stack stays
      # up and this sentinel (written under the slot's lock) makes any later
      # run on the slot fail fast instead of wiping the kept stack. The
      # sleeper keeps a live pid so the sentinel can tell a kept slot from a
      # stale one after a reboot; `down` kills it. Free with:
      # E2E_SLOT=<n> sh docker/e2e-local.sh down (E2E_SLOT=<n> make e2e-down).
      sleep infinity >/dev/null 2>&1 < /dev/null &
      printf '%s\n' "$!" > "$KEEP_FILE"
      echo "==> E2E_KEEP=1: stack left running (project ${PROJECT}); slot ${SLOT} held by pid $! — free it with E2E_SLOT=${SLOT} sh docker/e2e-local.sh down"
    else
      # shellcheck disable=SC2086
      $CE2E down --remove-orphans >/dev/null 2>&1 || true
    fi
    rm -f "$doctor_poll_log"
    exit "$rc"
  else
    printf '%s\n' "$doctor_out"
    printf '%s\n' "$doctor_out" >>"$doctor_poll_log"
  fi
  attempt=$((attempt + 1))
  sleep 3
done
echo "stack never became healthy — dumping logs"
# shellcheck disable=SC2086
$CE2E logs --tail=200
exit 1
