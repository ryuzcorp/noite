#!/bin/sh
# Dev-joint supervisor: mirrors the prod joint topology (runner :8080 +
# control UI :8081 in one container, /data/{runner,ui}.sqlite) with dev
# processes — cargo-watch rebuilds + Vite HMR — so joint-only wiring
# (NOITE_DB split, ports, supervisor restarts) breaks here, not in prod.
set -eu

cleanup() {
  kill "$runner_pid" "$ui_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT

echo "noite dev-joint: bun install"
cd /app && bun install && cd /

if [ "${RUNNER_DEV_RELEASE:-0}" = "1" ]; then
  runner_cmd="run --release"
else
  runner_cmd="run"
fi

echo "noite dev-joint: runner cargo-watch on :8080 (${runner_cmd})"
cd /src
export PATH="${CARGO_HOME:-/usr/local/cargo}/bin:${PATH}"
# Runner and UI both read NOITE_DB — map the joint volume layout per
# process, exactly like the prod supervisor (docker/noite-joint.sh).
# shellcheck disable=SC2086
NOITE_DB="${NOITE_RUNNER_DB:-/data/runner.sqlite}" cargo watch -q -w src -w Cargo.toml -w Cargo.lock -w migrations -s "cargo $runner_cmd" &
runner_pid=$!
cd /

echo "noite dev-joint: vite HMR on :${PORT:-8081}"
cd /app
export PORT="${PORT:-8081}"
export NOITE_DB="${NOITE_UI_DB:-/data/ui.sqlite}"
if [ "${VITE_USE_POLLING:-0}" = "1" ]; then
  export CHOKIDAR_USEPOLLING=1
fi
bun x vite --host 0.0.0.0 --port "$PORT" --strictPort &
ui_pid=$!
cd /

# POSIX sh has no `wait -n`: poll both children instead. Either process
# dying stops the container so the failure is loud, not half-serving.
while kill -0 "$runner_pid" 2>/dev/null && kill -0 "$ui_pid" 2>/dev/null; do
  sleep 1
done
echo "noite dev-joint: a dev process exited — stopping" >&2
cleanup
exit 1
