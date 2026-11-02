#!/usr/bin/env bash
# Check out upstream celld at the pinned commit and apply Noite's patches,
# in order, as commits. Usage: docker/celld/prepare.sh <dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/celld/upstream.env
. "$here/upstream.env"
dir=${1:?usage: prepare.sh <dir>}
git -c advice.detachedHead=false clone --quiet --branch "v$CELLD_VERSION" --depth 1 \
  https://github.com/denoland/celld "$dir"
actual=$(git -C "$dir" rev-parse HEAD)
if [ "$actual" != "$CELLD_COMMIT" ]; then
  echo "v$CELLD_VERSION is $actual, expected $CELLD_COMMIT" >&2
  exit 1
fi
git -C "$dir" -c user.name=noite -c user.email=noite@localhost \
  am --quiet --keep-cr "$here"/patches/*.patch
git -C "$dir" log --oneline "$CELLD_COMMIT"..HEAD
