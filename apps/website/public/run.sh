#!/usr/bin/env bash
# Noite script runner: runs docker/<script>.sh from the repo.
#
#   curl -fsSL https://noite.now/run.sh | bash -s install
#   curl -fsSL https://noite.now/run.sh | bash -s install --pre
#   curl -fsSL https://noite.now/run.sh | bash -s uninstall
#
# (bash -s reads this from stdin and passes the rest as arguments.) This
# site's CDN and raw.githubusercontent.com's /main both serve cached copies,
# so NOITE_REF (default main) is resolved to a commit first: a file at a
# commit is never stale, and install's compose.yaml comes from the same one.
#
# `install --pre` installs the newest GitHub release, pre-releases included,
# pinned: the installer and compose.yaml from its tag, the image by its
# version (NOITE_VERSION). That is how a release is tried before it is
# promoted to the `alpha` channel; a plain `install` afterwards goes back to
# the channel. NOITE_REF / NOITE_VERSION, when set, win over the release's.
set -euo pipefail
[[ "${1:-}" != "-s" ]] || shift
name="${1:-}"
case "$name" in
  install | uninstall) shift ;;
  *)
    echo "usage: curl -fsSL https://noite.now/run.sh | bash -s install [--pre] [--yes] | uninstall" >&2
    exit 1
    ;;
esac
args=()
pre=0
for arg in "$@"; do
  if [[ "$name" == install && "$arg" == --pre ]]; then pre=1; else args+=("$arg"); fi
done
if ((pre)); then
  # Newest first, drafts excluded; GitHub lists pre-releases with the rest.
  tag=$(curl -fsS --max-time 10 "https://api.github.com/repos/ryuzcorp/noite/releases?per_page=1" |
    grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4) || tag=""
  [[ "$tag" == v* ]] || { echo "--pre: could not find the newest release on GitHub" >&2; exit 1; }
  echo "--pre: installing ${tag} (image ${NOITE_VERSION:-${tag#v}})" >&2
  NOITE_REF="${NOITE_REF:-$tag}"
  NOITE_VERSION="${NOITE_VERSION:-${tag#v}}"
fi
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
  sudo env "${vars[@]}" bash -c "$script" "$name.sh" ${args[@]+"${args[@]}"} </dev/tty
  exit
fi
exec env "${vars[@]}" bash -c "$script" "$name.sh" ${args[@]+"${args[@]}"}
