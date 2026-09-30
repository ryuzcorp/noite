#!/usr/bin/env bash
# Noite script runner: runs docker/<script>.sh from the repo.
#
#   curl -fsSL https://noite.now/run.sh | bash -s install
#   curl -fsSL https://noite.now/run.sh | bash -s uninstall
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
    echo "usage: curl -fsSL https://noite.now/run.sh | bash -s install|uninstall" >&2
    exit 1
    ;;
esac
ref="${NOITE_REF:-main}"
sha=$(curl -fsS --max-time 10 -H 'Accept: application/vnd.github.sha' \
  "https://api.github.com/repos/ryuzcorp/noite/commits/$ref") || sha="$ref"
script=$(curl -fsSL "https://raw.githubusercontent.com/ryuzcorp/noite/$sha/docker/$name.sh")

# NOITE_* settings pass through sudo, which would otherwise drop them.
vars=()
for v in "${!NOITE_@}"; do vars+=("$v=${!v}"); done
vars+=("NOITE_REF=$sha")

if [[ "$(id -u)" -ne 0 ]]; then
  # The script asks questions on the terminal, which only its foreground
  # process group may read. sudo hands the terminal on only when it leads its
  # own process group, and in `curl | bash` curl leads it: with use_pty (the
  # default since sudo 1.9.14) the script then runs in the background of
  # sudo's pty and cannot ask. Job control (set -m) starts sudo as its own
  # foreground group instead of exec'ing it into curl's.
  command -v sudo >/dev/null || { echo "run as root: sudo is not installed" >&2; exit 1; }
  (: </dev/tty) 2>/dev/null || { echo "no terminal for sudo: run as root" >&2; exit 1; }
  set -m
  sudo env "${vars[@]}" bash -c "$script" "$name.sh" "$@" </dev/tty
  exit
fi
exec env "${vars[@]}" bash -c "$script" "$name.sh" "$@"
