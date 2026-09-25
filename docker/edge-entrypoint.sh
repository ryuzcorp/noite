#!/bin/sh
# Railway edge entrypoint: Caddy + the runner in one container (see
# docker/Dockerfile.edge for why they share a filesystem).
#
# Ordering mirrors docker/compose.yaml's caddy service: a bootstrap Caddyfile
# covers the window before the runner's first reconcile, then the runner
# rewrites the real file and caddy `--watch` picks it up within a tick.
set -eu

CADDYFILE="${CADDYFILE_PATH:-/caddy/Caddyfile}"
mkdir -p "$(dirname "$CADDYFILE")"
if [ ! -f "$CADDYFILE" ]; then
  printf '%s\n' ':80 {' '  respond "noite edge starting" 200' '}' > "$CADDYFILE"
fi

caddy run --config "$CADDYFILE" --adapter caddyfile --watch &
CADDY_PID=$!
# Railway sends SIGTERM on redeploy: forward it to both children so the runner
# stops its fleets instead of losing them to SIGKILL. (celld fleets are
# bucket-durable, so an ungraceful stop is recoverable either way.)
trap 'kill -TERM "$CADDY_PID" "$RUNNER_PID" 2>/dev/null || true' TERM INT

noite-runner &
RUNNER_PID=$!

# Keep the shell as PID 1 so both children are supervised here.
status=0
wait "$RUNNER_PID" || status=$?
kill -TERM "$CADDY_PID" 2>/dev/null || true
wait "$CADDY_PID" 2>/dev/null || true
exit "$status"
