#!/bin/sh
# `make dev` inside the one Noite container (docker/Dockerfile target `dev`):
#
#   control UI  `vite dev` on 127.0.0.1:8090 — where Caddy expects control, so
#               routing is the same as prod (the Oxide + Cloudflare plugin
#               pipeline: workerd, local D1, HMR). The dev image has no baked
#               bundle, so the runner does not start fleet #0.
#   runner      `cargo watch` on the bind-mounted source; the runner then
#               supervises Caddy and the tenant fleets exactly as in prod.
#
# `celld dev` cannot serve the control app: it bundles `main` with raw
# esbuild, which cannot resolve the Oxide plugin's `virtual:oxide/worker`
# entry. Only the Vite pipeline can (`vite build` for the image).
set -eu

UI_DIR=/app
RUNNER_DIR=/src

ui_install() {
  cd "$UI_DIR"
  # Skip when node_modules is newer than the lockfile: container restarts
  # should not pay for a no-op install.
  stamp=node_modules/.noite-install-stamp
  if [ ! -f "$stamp" ] || [ package.json -nt "$stamp" ] || [ bun.lock -nt "$stamp" ]; then
    echo "dev: bun install (control UI)"
    bun install
    touch "$stamp"
  fi
}

# Keep vite running: a crash (bad edit) restarts it after a pause instead of
# leaving the UI down until the container restarts.
ui_loop() {
  cd "$UI_DIR"
  if [ "${VITE_USE_POLLING:-0}" = 1 ]; then
    export CHOKIDAR_USEPOLLING=1
  fi
  while :; do
    echo "dev: vite dev on 127.0.0.1:8090"
    bunx vite --host 127.0.0.1 --port 8090 --strictPort || true
    echo "dev: vite exited; restarting in 2s"
    sleep 2
  done
}

ui_install
ui_loop &
UI_PID=$!

cd "$RUNNER_DIR"
if [ "${RUNNER_DEV_RELEASE:-0}" = 1 ]; then
  run="cargo run --release"
else
  run="cargo run"
fi
echo "dev: runner via cargo watch ($run)"
cargo watch -q -w src -w Cargo.toml -w Cargo.lock -w schema.sql -s "$run" &
RUNNER_PID=$!

# docker stop → SIGTERM to tini → this shell: stop both. The runner handles
# SIGTERM itself (fleets, Caddy, final state snapshot).
trap 'kill -TERM "$RUNNER_PID" "$UI_PID" 2>/dev/null || true' TERM INT
wait "$RUNNER_PID" || true
kill -TERM "$UI_PID" 2>/dev/null || true
wait "$UI_PID" 2>/dev/null || true
