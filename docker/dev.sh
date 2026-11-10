#!/bin/sh
# `make dev` inside the one Noite container (docker/Dockerfile target `dev`):
#
#   control UI  `vite dev` on 127.0.0.1:8090 — where Caddy expects control, so
#               routing is the same as prod (the Void pipeline: workerd,
#               local D1, HMR). The dev image has no baked
#               bundle, so the runner does not start fleet #0.
#   runner      `cargo watch` on the bind-mounted source; the runner then
#               supervises Caddy and the tenant fleets exactly as in prod.
#   sandbox     `dev-sandbox.sh` compiles the Void sandbox controller bundle
#               before the runner starts and again on every change to the
#               mounted `apps/void-sandbox`, so a sandbox app deploys with no
#               manual `bun run build`.
#
# `celld dev` cannot serve the control app: it bundles `main` with raw
# esbuild, which cannot resolve the Void plugin's `virtual:void-routes`
# entry. Only the Vite pipeline can (`vite build` for the image).
set -eu

UI_DIR=/app
RUNNER_DIR=/src
# The sandbox controller bundle: the package mount is read-only, so the build
# tree and the published bundle live in the container (compose.dev.yaml sets
# VOID_SANDBOX_BUNDLE_DIR to SANDBOX_BUNDLE). dev-sandbox.sh owns both.
SANDBOX_SRC=/opt/noite/void-sandbox-src
SANDBOX_WORK=/opt/noite/void-sandbox-build
SANDBOX_BUNDLE=/opt/noite/void-sandbox

# The runner reads the bundle on every deploy and the dev image bakes none:
# build it before the runner starts so the first sandbox app deploy works, and
# keep it current while the session runs (a mid-session edit of
# apps/void-sandbox reaches the next deploy). A failed build must not take the
# dev stack down: it is logged here, and the runner's "bundle incomplete" error
# names the same fix.
sandbox_build() {
  sh /opt/noite/dev-sandbox.sh \
    --source "$SANDBOX_SRC" --work "$SANDBOX_WORK" --bundle "$SANDBOX_BUNDLE" "$@"
}

# Keep the watcher running: if it dies, the bundle silently stops tracking
# `apps/void-sandbox` and the session keeps deploying the controller it last
# published. Restart it after a pause, like `ui_loop`.
sandbox_loop() {
  while :; do
    sandbox_build --watch
    echo "dev: sandbox bundle watcher exited; restarting in 2s"
    sleep 2
  done
}

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

sandbox_build --once ||
  echo "dev: sandbox controller bundle not built; a sandbox app deploy fails until it builds" >&2
sandbox_loop &
SANDBOX_PID=$!

cd "$RUNNER_DIR"
if [ "${RUNNER_DEV_RELEASE:-0}" = 1 ]; then
  run="cargo run --release"
else
  run="cargo run"
fi
echo "dev: runner via cargo watch ($run)"
cargo watch -q -w src -w Cargo.toml -w Cargo.lock -w schema.sql -w /void-proxy -s "$run" &
RUNNER_PID=$!

# docker stop → SIGTERM to tini → this shell: stop all three. The runner
# handles SIGTERM itself (fleets, Caddy, final state snapshot).
trap 'kill -TERM "$RUNNER_PID" "$UI_PID" "$SANDBOX_PID" 2>/dev/null || true' TERM INT
wait "$RUNNER_PID" || true
kill -TERM "$UI_PID" "$SANDBOX_PID" 2>/dev/null || true
wait "$UI_PID" 2>/dev/null || true
