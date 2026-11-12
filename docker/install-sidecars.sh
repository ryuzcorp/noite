#!/bin/sh
# Shared sidecar installer: esbuild + duckdb CLI at pinned versions.
# Single source of truth for these pins, consumed by docker/Dockerfile
# (both targets). Bump versions here, not in the Dockerfile.
#
# Every tarball is verified before it is unpacked: esbuild against the npm
# registry's sha512 (each per-arch package's `dist.integrity`), DuckDB against
# the sha256 GitHub publishes for the release asset (`digest` in the release
# API). A bump needs the version and its per-arch digest together;
# docker/check-versions.ts fails a version whose digest is missing, and the
# online leg of that check compares both against the publisher's own files.
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
# sha512, hex, of the `@esbuild/linux-<arch>@${ESBUILD_VERSION}` tarball.
ESBUILD_SHA512_X64=e314d9af5154992a105b85c85a68addedcd0ad44d933e3773f45d5f3144e298179d177c8ef178ef74fb56d9bcdc3122e7d0f610d0551247e588603d517c03f1d
ESBUILD_SHA512_ARM64=a56e000b43f78adf1cedda3d315338a79d45cc7cdd33f4d9adeaeeae045c1c9d964dad55435088ab5f319dc7e9049c38a23922659aca5b6c8805604ff768fa52
DUCKDB_VERSION="${DUCKDB_VERSION:-2.0.0}"
# sha256, hex, of the `duckdb-cli-linux-<arch>.tar.gz` release asset.
DUCKDB_SHA256_X64=c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc
DUCKDB_SHA256_ARM64=859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe

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
  ESBUILD_SHA512="${ESBUILD_SHA512_X64}"
  DUCKDB_PKG=duckdb-cli-linux-amd64
  DUCKDB_SHA256="${DUCKDB_SHA256_X64}"
  ;;
arm64 | aarch64)
  ESBUILD_PKG=linux-arm64
  ESBUILD_SHA512="${ESBUILD_SHA512_ARM64}"
  DUCKDB_PKG=duckdb-cli-linux-arm64
  DUCKDB_SHA256="${DUCKDB_SHA256_ARM64}"
  ;;
*)
  echo "unsupported arch: $arch" >&2
  exit 1
  ;;
esac

# esbuild: celld shells out to it for every deploy (worker projects).
if [ "$wanted_esbuild" = 1 ]; then
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 -o /tmp/esbuild.tgz "https://registry.npmjs.org/@esbuild/${ESBUILD_PKG}/-/${ESBUILD_PKG}-${ESBUILD_VERSION}.tgz"
  echo "${ESBUILD_SHA512}  /tmp/esbuild.tgz" | sha512sum -c -
  tar -xzf /tmp/esbuild.tgz -C /tmp package/bin/esbuild
  install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild
  rm -rf /tmp/package /tmp/esbuild.tgz
fi

# duckdb CLI: the runner's telemetry aggregation reads Parquet spans with it.
if [ "$wanted_duckdb" = 1 ]; then
  curl -fsSL --retry 5 --retry-all-errors --connect-timeout 15 -o /tmp/duckdb.tar.gz "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${DUCKDB_PKG}.tar.gz"
  echo "${DUCKDB_SHA256}  /tmp/duckdb.tar.gz" | sha256sum -c -
  tar -xzf /tmp/duckdb.tar.gz -C /tmp duckdb
  install -m 755 /tmp/duckdb /usr/local/bin/duckdb
  rm -f /tmp/duckdb /tmp/duckdb.tar.gz
fi
