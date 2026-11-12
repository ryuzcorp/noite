#!/bin/sh
# Shared sidecar installer: esbuild + duckdb CLI at pinned versions.
# Single source of truth for these pins, consumed by docker/Dockerfile
# (both targets). Bump versions here, not in the Dockerfile.
#
# Usage: sh install-sidecars.sh [esbuild] [duckdb]   (no args = both)
#
# Env overrides (all optional): ESBUILD_VERSION, DUCKDB_VERSION.
# Arch comes from $TARGETARCH (docker builds) or
# uname -m (native builds). Needs curl + tar present (no unzip since DuckDB
# 2.0: both sidecars ship tarballs, and its CLI assets renamed from
# `duckdb_cli-linux-<arch>.zip` to `duckdb-cli-linux-<arch>.tar.gz`).
set -eu

ESBUILD_VERSION="${ESBUILD_VERSION:-0.28.2}"
DUCKDB_VERSION="${DUCKDB_VERSION:-2.0.0}"

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
  DUCKDB_PKG=duckdb-cli-linux-amd64
  ;;
arm64 | aarch64)
  ESBUILD_PKG=linux-arm64
  DUCKDB_PKG=duckdb-cli-linux-arm64
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
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${DUCKDB_PKG}.tar.gz" -o /tmp/duckdb.tar.gz
  tar -xzf /tmp/duckdb.tar.gz -C /tmp duckdb
  install -m 755 /tmp/duckdb /usr/local/bin/duckdb
  rm -f /tmp/duckdb /tmp/duckdb.tar.gz
fi
