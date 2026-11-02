#!/usr/bin/env bash
# Check out upstream celld at the pinned commit and apply Noite's patches,
# in order, as commits. Usage: docker/celld/prepare.sh <dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/celld/upstream.env
. "$here/upstream.env"
dir=${1:?usage: prepare.sh <dir>}
# Callers interpolate these into tags and build args: refuse anything but
# the shapes they are.
[[ $CELLD_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad CELLD_VERSION" >&2; exit 1; }
[[ $CELLD_COMMIT =~ ^[0-9a-f]{40}$ ]] || { echo "bad CELLD_COMMIT" >&2; exit 1; }
[[ $CELLD_PATCH_LEVEL =~ ^[1-9][0-9]*$ ]] || { echo "bad CELLD_PATCH_LEVEL" >&2; exit 1; }
git -c advice.detachedHead=false clone --quiet --branch "v$CELLD_VERSION" --depth 1 \
  https://github.com/denoland/celld "$dir"
actual=$(git -C "$dir" rev-parse HEAD)
if [ "$actual" != "$CELLD_COMMIT" ]; then
  echo "v$CELLD_VERSION is $actual, expected $CELLD_COMMIT" >&2
  exit 1
fi
# Committer = author date and a fixed committer: the same pin and patches
# always give the same commit ids, so the image's revision label names a
# tree anyone can rebuild with this script.
git -C "$dir" -c user.name=Noite -c user.email=noite@noite.now \
  am --quiet --keep-cr --committer-date-is-author-date "$here"/patches/*.patch
git -C "$dir" log --oneline "$CELLD_COMMIT"..HEAD
