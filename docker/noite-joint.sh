#!/bin/sh
# Supervisor entrypoint for the joint control image (railpack.json):
# Rust runner (:8080, owns fleets + Caddyfile) and Bun control UI (:8081)
# in one container. Either process exiting stops the container so Compose
# restarts a known-good unit instead of half-serving.
set -eu

# Same default-secret gate as docker/noite-prod.sh, so the baked image can
# never silently serve with the repo-shipped dev credentials on a real domain.
if [ "${BASE_DOMAIN:-localhost}" != "localhost" ]; then
  case "${BETTER_AUTH_SECRET:-}" in
  "" | dev-*)
    echo "noite: refusing default BETTER_AUTH_SECRET on ${BASE_DOMAIN}" >&2
    exit 1
    ;;
  esac
  if [ "${RUNNER_TOKEN:-dev-runner-token}" = "dev-runner-token" ]; then
    echo "noite: refusing default RUNNER_TOKEN on ${BASE_DOMAIN}" >&2
    exit 1
  fi
fi

# Apex is the control plane — normalize any legacy `noite.*` auth URL.
case "${BETTER_AUTH_URL:-}" in
*://noite.*)
  BETTER_AUTH_URL=$(printf '%s' "$BETTER_AUTH_URL" | sed 's|://noite\.|://|')
  export BETTER_AUTH_URL
  ;;
"")
  export BETTER_AUTH_URL="http://localhost:9080"
  ;;
esac

cleanup() {
  kill "$runner_pid" "$ui_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup TERM INT

echo "noite: start runner on :8080"
# Runner and UI both read NOITE_DB — map the joint volume layout per
# process (control-data holds both: runner.sqlite + ui.sqlite).
NOITE_DB="${NOITE_RUNNER_DB:-/data/runner.sqlite}" /usr/local/bin/noite-runner &
runner_pid=$!

echo "noite: start control UI on :${PORT:-8081}"
cd /app/noite
(
  export NOITE_DB="${NOITE_UI_DB:-/data/ui.sqlite}"
  export PORT="${PORT:-8081}"
  exec bunx --bun srvx --prod ./dist/server.js
) &
ui_pid=$!
cd /

# POSIX sh has no `wait -n`: poll both supervisors instead. Either process
# dying stops the container so Compose restarts a known-good unit.
while kill -0 "$runner_pid" 2>/dev/null && kill -0 "$ui_pid" 2>/dev/null; do
  sleep 1
done
echo "noite: a control process exited — stopping" >&2
cleanup
exit 1
