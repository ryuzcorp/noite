#!/bin/sh
# Install one workspace's dependencies so a registry stall names itself.
#
# `bun install` prints nothing until the final summary, so a wedged fetch
# looks exactly like this step doing nothing until the step timeout kills it
# (the 2026-11-17 merge group hung 3 e2e shards this way with zero output
# after the version line). This wrapper runs the real install verbose into a
# log file, prints a heartbeat with the latest fetcher progress while it
# runs, and dumps the verbose tail on failure — the next stall's log names
# the package or request it wedged on instead of dying silent.
#
# Resilience, not retries (retry wrappers are banned): `--prefer-offline`
# resolves everything the shared bun cache already holds without touching
# the network, so only genuinely missing tarballs fetch; `--frozen-lockfile`
# keeps resolution pinned to the committed lockfile. The caller restores
# `~/.bun/install/cache` with actions/cache before running this.
#
# Usage: sh .github/scripts/bun-install.sh [--cwd DIR]

set -eu

dir="."

while [ $# -gt 0 ]; do
  case "$1" in
    --cwd)
      dir="$2"
      shift 2
      ;;
    --cwd=*)
      dir="${1#--cwd=}"
      shift
      ;;
    -h | --help)
      echo "usage: sh .github/scripts/bun-install.sh [--cwd DIR]"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: sh .github/scripts/bun-install.sh [--cwd DIR]" >&2
      exit 2
      ;;
  esac
done

# `--cwd` is relative to the caller's working directory, like every other
# relative path in a `run:` step.
cd "$dir"

log="$(mktemp /tmp/bun-install.XXXXXX.log)"

bun install --frozen-lockfile --prefer-offline --verbose >"$log" 2>&1 &
pid=$!
elapsed=0

while kill -0 "$pid" 2>/dev/null; do
  # Poll in small slices so a finished install exits promptly; the
  # heartbeat itself stays at 30 s so passing runs log nothing extra.
  sleep 5

  if kill -0 "$pid" 2>/dev/null; then
    elapsed=$((elapsed + 5))

    if [ $((elapsed % 30)) -eq 0 ]; then
      echo "bun install in ${dir} still running after ${elapsed}s; latest progress:"
      tail -n 5 "$log" | sed 's/^/[bun-install] /'
    fi
  fi
done

if wait "$pid"; then
  echo "bun install in ${dir} finished:"
  tail -n 8 "$log" | sed 's/^/[bun-install] /'
else
  code=$?
  echo "::error::bun install in ${dir} failed (exit ${code}); verbose tail:" >&2
  tail -n 40 "$log" | sed 's/^/[bun-install] /' >&2
  exit "$code"
fi

rm -f "$log"
