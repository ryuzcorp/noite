#!/bin/sh
# Fake `celld` for the runner's R2 seam tests (`host/storage/r2.rs`). One
# committed copy serves every test: each test symlinks it into its own
# fixture dir, so the executed file is never freshly written (exec'ing a
# freshly-written file under parallel load spuriously fails with ETXTBSY).
# `$2` is the verb; fixtures live next to the symlink, never here.
dir=$(dirname "$0")
printf '%s\n' "$*" >> "$dir/invocations.log"
if [ -f "$dir/fail-next" ]; then cat "$dir/fail-next" >&2; rm "$dir/fail-next"; exit 1; fi
case "$2" in
  list) cat "$dir/list.json";;
  head) cat "$dir/head.json";;
  get) cat "$dir/body.bin";;
  *) echo "unexpected: $*" >&2; exit 1;;
esac
