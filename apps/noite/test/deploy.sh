#!/usr/bin/env bash
# Push this sample app to Noite via Git smart-HTTP (stock git only).
# Tip lands at s3://noite/git/test/refs/heads/main/{sha}.bundle → deploy.
# Always re-inits .git so each run is a fresh commit + push (new deploy).
# Auth: profile API key (Profile → API keys) as HTTPS password; username=git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Prefer repo-root .env; allow overrides.
if [[ -f "$ROOT/../../../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/../../../.env"
  set +a
elif [[ -f "$ROOT/../.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/../.env"
  set +a
fi

PORT_UI="${HTTP_PORT:-9080}"
SLUG="${NOITE_GIT_SLUG:-test}"
GIT_BASE="${GIT_PUBLIC_BASE:-http://git.localhost:${PORT_UI}}"
GIT_BASE="${GIT_BASE%/}"

if [[ -n "${NOITE_GIT_REMOTE:-}" ]]; then
  REMOTE_URL="$NOITE_GIT_REMOTE"
else
  if [[ -n "${NOITE_GIT_TOKEN:-}" ]]; then
    TOKEN="$NOITE_GIT_TOKEN"
  else
    # -s: hide token; works when stdin is a TTY.
    read -r -s -p "API key for '${SLUG}' (from Profile → API keys): " TOKEN
    echo
  fi
  if [[ -z "${TOKEN}" ]]; then
    echo "empty key — create one under Profile → API keys" >&2
    exit 1
  fi
  # http://git.localhost:9080 → http://git:TOKEN@git.localhost:9080/slug
  if [[ "$GIT_BASE" == *"://"* ]]; then
    scheme="${GIT_BASE%%://*}"
    rest="${GIT_BASE#*://}"
    REMOTE_URL="${scheme}://git:${TOKEN}@${rest}/${SLUG}"
  else
    REMOTE_URL="git:${TOKEN}@${GIT_BASE}/${SLUG}"
  fi
fi

MSG="${1:-deploy $(date -Iseconds)}"

rm -rf .git
git init -b main
git remote add origin "$REMOTE_URL"
git add -A
git commit -m "$MSG"
SHA="$(git rev-parse HEAD)"

echo "pushing → ${GIT_BASE}/${SLUG}"
git push -uf origin main

echo "done — tip ${SHA:0:12} · http://${SLUG}.localhost:${PORT_UI}"
