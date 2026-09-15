#!/usr/bin/env bash
# Push this sample app to Noite prod via Git smart-HTTP (stock git only).
# Tip lands at s3://noite/git/{slug}/refs/heads/main/{sha}.bundle → deploy.
# Always re-inits .git so each run is a fresh commit + push (new deploy).
# Auth: profile API key (Profile → API keys) as HTTPS password; username=git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Repo-root .env is convenience only: an explicitly exported GIT_PUBLIC_BASE
# wins (local .env files usually point at localhost, which the guard below
# refuses).
if [[ -z "${GIT_PUBLIC_BASE:-}" ]]; then
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
fi

SLUG="${NOITE_GIT_SLUG:-test}"
GIT_BASE="${GIT_PUBLIC_BASE:-https://git.noite.now}"
GIT_BASE="${GIT_BASE%/}"

# Never push to a local/dev git host from the prod script: a repo-root .env
# usually points GIT_PUBLIC_BASE at localhost. Use NOITE_GIT_REMOTE if a
# non-prod target is really intended.
if [[ -z "${NOITE_GIT_REMOTE:-}" ]]; then
  case "$GIT_BASE" in
  *localhost* | *127.0.0.1*)
    echo "refusing local git base ${GIT_BASE} in deploy.prod.sh" >&2
    echo "set GIT_PUBLIC_BASE=https://git.noite.now or NOITE_GIT_REMOTE explicitly" >&2
    exit 1
    ;;
  esac
fi

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
  # https://git.noite.now → https://git:TOKEN@git.noite.now/slug
  if [[ "$GIT_BASE" == *"://"* ]]; then
    scheme="${GIT_BASE%%://*}"
    rest="${GIT_BASE#*://}"
    REMOTE_URL="${scheme}://git:${TOKEN}@${rest}/${SLUG}"
  else
    REMOTE_URL="git:${TOKEN}@${GIT_BASE}/${SLUG}"
  fi
fi

# App URL follows the git host when it looks like git.<domain>.
APP_URL="https://${SLUG}.noite.now"
case "$GIT_BASE" in
https://git.*)
  APP_URL="https://${SLUG}.${GIT_BASE#https://git.}"
  ;;
esac

MSG="${1:-deploy $(date -Iseconds)}"

rm -rf .git
git init -b main
git remote add origin "$REMOTE_URL"
git add -A
git commit -m "$MSG"
SHA="$(git rev-parse HEAD)"

echo "pushing → ${GIT_BASE}/${SLUG}"
git push -uf origin main

echo "done — tip ${SHA:0:12} · ${APP_URL}"
