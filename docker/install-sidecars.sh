#!/bin/sh
# Shared sidecar installer: esbuild + duckdb CLI at pinned versions.
# Single source of truth — consumed by docker/Dockerfile.runner,
# docker/Dockerfile.runner-dev, docker/Dockerfile.tools, and the railpack
# `sidecars` step. Bump versions here, not in each image.
#
# Env overrides (all optional): ESBUILD_VERSION, DUCKDB_VERSION,
# DUCKDB_VERSION_AARCH64. Arch comes from $TARGETARCH (docker builds) or
# uname -m (native/railpack builds). Needs curl + unzip + tar present.
set -eu

ESBUILD_VERSION="${ESBUILD_VERSION:-0.25.12}"
DUCKDB_VERSION="${DUCKDB_VERSION:-1.5.5}"
DUCKDB_VERSION_AARCH64="${DUCKDB_VERSION_AARCH64:-1.2.1}"

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

curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 "https://registry.npmjs.org/@esbuild/${ESBUILD_PKG}/-/${ESBUILD_PKG}-${ESBUILD_VERSION}.tgz" |
  tar -xz -C /tmp
install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild
rm -rf /tmp/package

curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VER}/${DUCKDB_ZIP}" -o /tmp/duckdb.zip
unzip -qo /tmp/duckdb.zip -d /usr/local/bin
rm -f /tmp/duckdb.zip
