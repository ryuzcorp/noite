#!/usr/bin/env bash
# Noite script runner: runs docker/<script>.sh from the repo.
#
#   curl -fsSL https://noite.now/run.sh | sudo bash -s install
#   curl -fsSL https://noite.now/run.sh | sudo bash -s uninstall
#
# (bash -s reads this from stdin and passes the rest as arguments.) This
# site's CDN and raw.githubusercontent.com's /main both serve cached copies,
# so NOITE_REF (default main) is resolved to a commit first: a file at a
# commit is never stale, and install's compose.yaml comes from the same one.
set -euo pipefail
[[ "${1:-}" != "-s" ]] || shift
name="${1:-}"
case "$name" in
  install | uninstall) shift ;;
  *)
    echo "usage: curl -fsSL https://noite.now/run.sh | sudo bash -s install|uninstall" >&2
    exit 1
    ;;
esac
ref="${NOITE_REF:-main}"
sha=$(curl -fsS --max-time 10 -H 'Accept: application/vnd.github.sha' \
  "https://api.github.com/repos/ryuzcorp/noite/commits/$ref") || sha="$ref"
script=$(curl -fsSL "https://raw.githubusercontent.com/ryuzcorp/noite/$sha/docker/$name.sh")
NOITE_REF="$sha" exec bash -c "$script" "$name.sh" "$@"
