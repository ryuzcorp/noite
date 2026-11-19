#!/bin/sh
# Fake `cello` for the runner's tenant D1 migrate tests (`host/deploy.rs`
# tenant-D1 sequencing). One committed copy serves every test: each test
# symlinks it into its own fixture dir, so the executed file is never freshly
# written (exec'ing a freshly-written file under parallel load spuriously
# fails with ETXTBSY).
#
# - `d1 execute ...`: prints canned `--json` rows. The first `execute` call
#   in the log prints `$FAKE_CELLO_DIR/execute-before`, later calls print
#   `execute-after` — the bookkeeping-table diff the deploy logs.
# - `d1 migrations apply ...`: succeeds, unless
#   `$FAKE_CELLO_DIR/apply.fail` exists, in which case its content goes to
#   stderr and the call fails — a bad migration failing the deploy.
n=0
if [ -f "$FAKE_CELLO_LOG" ]; then n=$(wc -l < "$FAKE_CELLO_LOG"); fi
printf '%s\n' "$*" >> "$FAKE_CELLO_LOG"
if [ "$1" = "d1" ] && [ "$2" = "execute" ]; then
  count=$(grep -c "d1 execute" "$FAKE_CELLO_LOG" 2>/dev/null || echo 1)
  if [ "$count" -le 1 ]; then
    cat "$FAKE_CELLO_DIR/execute-before" 2>/dev/null || true
  else
    cat "$FAKE_CELLO_DIR/execute-after" 2>/dev/null || true
  fi
  exit 0
fi
if [ "$1" = "d1" ] && [ "$2" = "migrations" ] && [ "$3" = "apply" ]; then
  if [ -f "$FAKE_CELLO_DIR/apply.fail" ]; then cat "$FAKE_CELLO_DIR/apply.fail" >&2; exit 1; fi
  exit 0
fi
echo "unexpected cello call: $*" >&2
exit 1
