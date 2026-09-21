#!/bin/sh
# Dev control plane: `vite dev` (real Oxide + Cloudflare plugin pipeline:
# actions, middleware, workerd, local D1) with file watching. Same
# 4-service topology as prod; the only difference is this process versus
# the prod fleet node (`celld --bucket`, bucket-backed, deployed versions).
#
# NOTE: `celld dev` cannot serve this app — it bundles `main` with raw
# esbuild, which cannot resolve the Oxide plugin's `virtual:oxide/worker`
# entry. Only the Vite pipeline (dev here, `vite build` for deploys) can.
set -eu
cd /app

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

if [ "${VITE_USE_POLLING:-0}" = "1" ]; then
  export CHOKIDAR_USEPOLLING=1
fi
echo "noite: vite dev on 0.0.0.0:${PORT:-8090} (auth ${BETTER_AUTH_URL:-http://localhost:9080})"
export PORT="${PORT:-8090}"
exec bunx vite --host 0.0.0.0 --port "${PORT}" --strictPort
