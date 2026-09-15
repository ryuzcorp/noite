#!/bin/sh
# Dev host plane: rebuild + restart on src / Cargo.toml / migrations changes.
set -eu
cd /src
export PATH="${CARGO_HOME:-/usr/local/cargo}/bin:${PATH}"

echo "runner dev — cargo watch (debug)"
exec cargo watch \
  -q \
  -w src \
  -w Cargo.toml \
  -w Cargo.lock \
  -w migrations \
  -x run
