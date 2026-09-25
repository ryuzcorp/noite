#!/bin/sh
# Shared sidecar installer: esbuild + duckdb CLI at pinned versions.
# Single source of truth — consumed by Dockerfile.runner-container,
# docker/Dockerfile.runner-dev, docker/Dockerfile.tools and
# docker/Dockerfile.ui. Bump versions here, not in each image.
#
# Usage: sh install-sidecars.sh [esbuild] [duckdb]   (no args = both)
#
# Env overrides (all optional): ESBUILD_VERSION, DUCKDB_VERSION,
# DUCKDB_VERSION_AARCH64. Arch comes from $TARGETARCH (docker builds) or
# uname -m (native builds). Needs curl + unzip + tar present.
set -eu

ESBUILD_VERSION="${ESBUILD_VERSION:-0.25.12}"
DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.5}"
DUCKDB_VERSION_AARCH64="${DUCKDB_VERSION_AARCH64:-1.2.1}"

wanted_esbuild=0
wanted_duckdb=0
if [ "$#" -eq 0 ]; then
  wanted_esbuild=1
  wanted_duckdb=1
fi
for want in "$@"; do
  case "$want" in
  esbuild) wanted_esbuild=1 ;;
  duckdb) wanted_duckdb=1 ;;
  *)
    echo "unknown component: $want (expected esbuild or duckdb)" >&2
    exit 1
    ;;
  esac
done

arch="${TARGETARCH:-$(uname -m)}"
case "$arch" in
amd64 | x86_64)
  ESBUILD_PKG=linux-x64
  DUCKDB_ZIP=duckdb_cli-linux-amd64.zip
  DUCKDB_VER="$DUCKDB_VERSION"
  ;;
arm64 | aarch64)
  ESBUILD_PKG=linux-arm64
  DUCKDB_ZIP=duckdb_cli-linux-aarch64.zip
  DUCKDB_VER="$DUCKDB_VERSION_AARCH64"
  ;;
*)
  echo "unsupported arch: $arch" >&2
  exit 1
  ;;
esac

# esbuild: celld shells out to it for every deploy (worker projects).
if [ "$wanted_esbuild" = 1 ]; then
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 "https://registry.npmjs.org/@esbuild/${ESBUILD_PKG}/-/${ESBUILD_PKG}-${ESBUILD_VERSION}.tgz" |
    tar -xz -C /tmp
  install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild
  rm -rf /tmp/package
fi

# duckdb CLI: the runner's telemetry aggregation reads Parquet spans with it.
if [ "$wanted_duckdb" = 1 ]; then
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VER}/${DUCKDB_ZIP}" -o /tmp/duckdb.zip
  unzip -qo /tmp/duckdb.zip -d /usr/local/bin
  rm -f /tmp/duckdb.zip
fi
