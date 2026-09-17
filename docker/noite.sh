#!/bin/sh
# Default: production Oxide fetch (`vite build` → `bun run dist/server.js`).
# Dev HMR: NOITE_MODE=dev (make dev).
set -eu
cd /app
mkdir -p /data /var/lib/noite

# Refuse known default secrets when serving a real domain. The repo ships
# these defaults so `cp .env.example .env` works locally — but a publicly
# reachable control plane must set its own.
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

# Apex is the control plane (`localhost` / `$BASE_DOMAIN`), not `noite.*`.
case "${BETTER_AUTH_URL:-}" in
*://noite.*)
  BETTER_AUTH_URL=$(printf '%s' "$BETTER_AUTH_URL" | sed 's|://noite\.|://|')
  export BETTER_AUTH_URL
  ;;
"")
  export BETTER_AUTH_URL="http://localhost:9080"
  ;;
esac

echo "noite: bun install"
# Skip when node_modules is newer than the lockfile — container restarts
# shouldn't pay for a no-op install (first boot and lockfile bumps still
# install via the stamp below).
install_needed=0
if [ ! -d node_modules ]; then
  install_needed=1
elif [ ! -f node_modules/.noite-install-stamp ]; then
  install_needed=1
elif [ package.json -nt node_modules/.noite-install-stamp ]; then
  install_needed=1
elif [ -f bun.lock ] && [ bun.lock -nt node_modules/.noite-install-stamp ]; then
  install_needed=1
fi
if [ "$install_needed" = 1 ]; then
  bun install
  touch node_modules/.noite-install-stamp
else
  echo "noite: node_modules fresh, skipping install"
fi

# Pin `rustfs` in hosts — aardvark DNS can flake and hang AWS SDK forever.
# Keep hostname in S3_ENDPOINT (path-style); do not rewrite to a raw IP
# (aws CLI virtual-host style then tries git.<ip> and hangs).
resolve_rustfs() {
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 rustfs 2>/dev/null | awk '{print $1; exit}'
  fi
}
rustfs_ip=$(resolve_rustfs || true)
if [ -z "${rustfs_ip:-}" ] && command -v dig >/dev/null 2>&1; then
  rustfs_ip=$(dig +short +time=1 +tries=1 @10.89.0.1 rustfs A 2>/dev/null | head -1 || true)
fi
if [ -n "${rustfs_ip:-}" ]; then
  if ! grep -qE '^[^#]*[[:space:]]rustfs([[:space:]]|$)' /etc/hosts 2>/dev/null; then
    echo "${rustfs_ip} rustfs" >>/etc/hosts
  fi
  echo "noite: pinned rustfs → ${rustfs_ip} (S3_ENDPOINT=${S3_ENDPOINT:-http://rustfs:9000})"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 3 -o /dev/null "http://rustfs:9000/minio/health/live" ||
      curl -fsS -m 3 -o /dev/null "http://rustfs:9000/"; then
      echo "noite: rustfs reachable"
    else
      echo "noite: WARNING rustfs not reachable on :9000" >&2
    fi
  fi
fi

if [ "${NOITE_MODE:-prod}" = "dev" ]; then
  if [ "${VITE_USE_POLLING:-0}" = "1" ]; then
    export CHOKIDAR_USEPOLLING=1
  fi
  echo "noite: vite dev on 0.0.0.0:${PORT:-8080} (auth ${BETTER_AUTH_URL})"
  exec bunx vite --host 0.0.0.0 --port "${PORT:-8080}" --strictPort
fi

echo "noite: vite build (oxide fetch)"
bun run build
echo "noite: start dist/server.js on :${PORT:-8080} (auth ${BETTER_AUTH_URL})"
export PORT="${PORT:-8080}"
exec bun run start
