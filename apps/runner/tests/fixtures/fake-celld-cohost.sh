#!/bin/sh
# Fake `celld` for the runner's Void cohost seam tests (`host/void_cohost.rs`).
# One committed copy serves every test: each test symlinks it into its own
# fixture dir, so the executed file is never freshly written (exec'ing a
# freshly-written file under parallel load spuriously fails with ETXTBSY).
n=0
if [ -f "$FAKE_CELLD_LOG" ]; then n=$(wc -l < "$FAKE_CELLD_LOG"); fi
printf '%s\n' "$*" >> "$FAKE_CELLD_LOG"
fail="$FAKE_CELLD_DIR/fail-$n"
if [ -f "$fail" ]; then cat "$fail" >&2; exit 1; fi
if [ "$1" = "deploy" ]; then
  name=$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$2/wrangler.json" 2>/dev/null | head -n 1)
  name=${name:-test-app}
  version=$(printf '%016x' "$((n + 1))")
  printf '{"worker": "%s", "version": "%s", "location": "s3://fake/%s", "dry_run": false, "staged": true}\n' "$name" "$version" "$version"
else
  echo "Activated generation: $2 (primary test-app)"
fi
