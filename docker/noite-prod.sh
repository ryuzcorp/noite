#!/bin/sh
# Production entrypoint for the immutable control-UI image
# (docker/Dockerfile.control — deps + `vite build` baked at image build time).
set -eu

# Same default-secret gate as docker/noite.sh, so the baked image can never
# silently serve with the repo-shipped dev credentials on a real domain.
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

cd /app
echo "noite: start dist/server.js on :${PORT:-8080}"
export PORT="${PORT:-8080}"
exec bun run start
