#!/bin/sh
# `make usage` — spec T0.1/T0.2 cost harness. Samples the runner's
# `/v1/admin/stats` counters, container stats, /data size and bucket prefix
# sizes over a fixed window (default 600 s, `make usage WINDOW=60`) and prints
# one table. Record the table as the baseline / per-phase before-after.
set -eu

WINDOW="${1:-600}"
cd "$(dirname "$0")/.."

ENGINE="$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)"
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
HTTP_PORT="${HTTP_PORT:-9080}"
RUNNER_TOKEN="${RUNNER_TOKEN:-dev-runner-token}"

stats() {
  curl -s -m 10 -H "Host: api.localhost" \
    -H "Authorization: Bearer ${RUNNER_TOKEN}" \
    "http://127.0.0.1:${HTTP_PORT}/v1/admin/stats" || true
}

BEFORE="$(stats)"
if [ -z "${BEFORE}" ] || [ "${BEFORE}" = "Unauthorized" ]; then
  echo "usage: runner not reachable at 127.0.0.1:${HTTP_PORT} (wrong RUNNER_TOKEN?) — start the stack first (make up / make dev)" >&2
  exit 1
fi
echo "${BEFORE}" > "/tmp/noite-usage-before.json"

CONTAINER="$(${ENGINE} ps --format '{{.Names}}' 2>/dev/null | grep -E 'noite' | head -1 || true)"
if [ -n "${CONTAINER}" ]; then
  echo "--- container stats (start) ---"
  ${ENGINE} stats --no-stream "${CONTAINER}" 2>/dev/null || true
  DATA_BEFORE="$(${ENGINE} exec "${CONTAINER}" du -sb /data 2>/dev/null | cut -f1 || echo 0)"
else
  echo "--- no noite container running; container + /data stats skipped ---"
  DATA_BEFORE=0
fi

echo "sampling ${WINDOW}s ..."
sleep "${WINDOW}"

AFTER="$(stats)"
echo "${AFTER}" > "/tmp/noite-usage-after.json"
if [ -n "${CONTAINER}" ]; then
  echo "--- container stats (end) ---"
  ${ENGINE} stats --no-stream "${CONTAINER}" 2>/dev/null || true
  DATA_AFTER="$(${ENGINE} exec "${CONTAINER}" du -sb /data 2>/dev/null | cut -f1 || echo 0)"
else
  DATA_AFTER=0
fi

export NOITE_USAGE_BEFORE="/tmp/noite-usage-before.json"
export NOITE_USAGE_AFTER="/tmp/noite-usage-after.json"
export NOITE_DATA_BEFORE="${DATA_BEFORE}"
export NOITE_DATA_AFTER="${DATA_AFTER}"
export NOITE_WINDOW="${WINDOW}"
python3 - <<'EOF'
import json, os
before = json.load(open(os.environ["NOITE_USAGE_BEFORE"]))
after = json.load(open(os.environ["NOITE_USAGE_AFTER"]))
window = int(os.environ["NOITE_WINDOW"])
print(f"\n== noite usage over {window}s ==")
print(f"RSS: {before.get('rss_bytes',0)/1e6:.1f} -> {after.get('rss_bytes',0)/1e6:.1f} MB   "
      f"CPU: {before.get('cpu_seconds',0):.1f} -> {after.get('cpu_seconds',0):.1f} s")
print(f"/data bytes: {os.environ['NOITE_DATA_BEFORE']} -> {os.environ['NOITE_DATA_AFTER']}")
def delta(section, key):
    b = (before.get(section) or {}).get(key, 0)
    a = (after.get(section) or {}).get(key, 0)
    return a - b
for section in ("spawns", "s3_ops", "duckdb"):
    keys = sorted(set((before.get(section) or {})) | set((after.get(section) or {})))
    if keys:
        print(f"[{section}] " + "  ".join(f"{k}=+{delta(section,k)}" for k in keys))
up_b = sum((before.get("s3_bytes_up") or {}).values())
up_a = sum((after.get("s3_bytes_up") or {}).values())
dn_b = sum((before.get("s3_bytes_down") or {}).values())
dn_a = sum((after.get("s3_bytes_down") or {}).values())
print(f"S3 bytes up=+{up_a-up_b} down=+{dn_a-dn_b}")
sn = after.get("snapshots") or {}
sn0 = before.get("snapshots") or {}
print(f"snapshots: uploads {sn0.get('uploads',0)}->{sn.get('uploads',0)} bytes {sn0.get('bytes',0)}->{sn.get('bytes',0)}")
print(f"SSE live: {json.dumps(after.get('sse'))}")
print("bucket prefix sizes: see the RustFS console (bundled store has no du endpoint); record git/, fleets/, control/, runner/state/ there")
EOF
