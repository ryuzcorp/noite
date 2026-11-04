#!/bin/sh
# Fake `celld` for the runner's Void cohost seam tests (`host/void_cohost.rs`,
# `host/deploy.rs` staged-migrate sequencing, `host/void_migrate.rs` staged
# transport). One committed copy serves every test: each test symlinks it
# into its own fixture dir, so the executed file is never freshly written
# (exec'ing a freshly-written file under parallel load spuriously fails with
# ETXTBSY).
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
elif [ "$1" = "invoke" ]; then
  # A staged `celld invoke --json` answer: the request's `--path` selects
  # the fixture file holding the full result envelope
  # (`{"status":N,"headers":{...},"body":"base64..."}`), and a sibling
  # `<name>.fail` file fails the call with its content on stderr and no
  # envelope — the unknown-outcome case. Routing every migrate endpoint
  # through a fixture keeps the sequencing observable without sleeps:
  # migrate failure runs no activate.
  path=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--path" ]; then path="$arg"; fi
    prev="$arg"
  done
  case "$path" in
    /__void/migrate/capabilities) name="invoke-capabilities";;
    /__void/migrate/auth) name="invoke-auth";;
    /__void/migrate/app) name="invoke-app";;
    /__void/migrate/app/attempt/*) name="invoke-attempt";;
    /__void/migrate) name="invoke-legacy";;
    *) echo "unexpected invoke path: $path" >&2; exit 1;;
  esac
  if [ -f "$FAKE_CELLD_DIR/$name.fail" ]; then cat "$FAKE_CELLD_DIR/$name.fail" >&2; exit 1; fi
  cat "$FAKE_CELLD_DIR/$name"
else
  echo "Activated generation: $2 (primary test-app)"
fi
