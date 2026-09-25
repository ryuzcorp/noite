#!/bin/sh
# Dev host plane: rebuild + restart on src / Cargo.toml / schema changes.
set -eu
cd /src
export PATH="${CARGO_HOME:-/usr/local/cargo}/bin:${PATH}"

if [ "${RUNNER_DEV_RELEASE:-0}" = "1" ]; then
  echo "runner dev — cargo watch (release: matches prod fleet behavior)"
  exec cargo watch \
    -q \
    -w src \
    -w Cargo.toml \
    -w Cargo.lock \
    -w schema.sql \
    -s "cargo run --release"
fi

echo "runner dev — cargo watch (debug)"
exec cargo watch \
  -q \
  -w src \
  -w Cargo.toml \
  -w Cargo.lock \
  -w schema.sql \
  -x run
