#!/bin/sh
# Noite control-UI node entrypoint (baked at /usr/local/bin/noite-entrypoint.sh
# in the UI image). Brings a fresh box to a serving control plane with no host
# steps: wait until the bucket actually serves, patch the worker's runtime vars
# from this container's environment (secrets never bake into the image), deploy
# the baked bundle when its revision differs from the deployed one, then exec
# celld as PID 1 (signals + the `kill -0 1` healthcheck).
set -eu

BKT="${NOITE_S3_BUCKET:-noite}"
EP="${S3_ENDPOINT:-http://rustfs:9000}"
DIST="${UI_DIST:-/ui/dist}"
MARKER_KEY="ui/revision"
DEPLOY_BUCKET="s3://${BKT}/control"
# Revision of the baked bundle. Present in the image; a missing file means a
# hand-built image without the build stage, which must not silently skip.
BUNDLE_REV="$(cat "${DIST}/REVISION" 2>/dev/null || echo unknown)"

# 1. Wait until S3 serves the deploy prefix. RustFS accepts connections and
# answers HTTP before its object layer is up: `GET /` is 503 while it
# (re)initializes a volume and 403 once ready, a bucket LIST can still be 503
# while it re-indexes one, and `head-bucket` already answers 200 throughout.
# So a status-agnostic `curl` gate — curl exits 0 on a 503 — walks straight
# into celld's boot validate, which lists this prefix, fails, and exits
# non-zero; the platform then restarts the container, which re-deploys the
# bundle every couple of seconds, forever. Probe what celld validates with
# (the runner's `ensure_buckets` waits the same way), creating the bucket
# first: on a fresh box nothing else has, and neither side may assume the
# other won the race. ~5 min cap, then say what is wrong instead of looping.
PREFIX="${DEPLOY_BUCKET#s3://${BKT}/}"
# Why S3 is refusing, in the endpoint's own words. RustFS's readiness probe
# names the unmet dependency (`storage`/`iam`/`lock` plus `degradedReasons`,
# e.g. storage_quorum_unavailable) while its liveness probe stays 200 — which
# is why "the rustfs service is up" and its 503s are both true. Endpoints
# without that probe fall back to their response headers (`x-rustfs-readiness-
# pending` during startup, a plain 403 on / once serving).
s3_status() {
  ready="$(curl -s --max-time 5 "${EP}/health/ready" 2>/dev/null || true)"
  if summary="$(printf '%s' "$ready" | jq -r '"ready=\(.ready) degradedReasons=\((.degradedReasons // []) | join(","))"' 2>/dev/null)"; then
    printf '%s' "$summary"
    return 0
  fi
  curl -s -o /dev/null -D - --max-time 5 "$EP/" 2>/dev/null |
    tr -d '\r' |
    grep -iE "^HTTP/|^retry-after:|^x-rustfs-readiness-pending:" |
    tr '\n' ' '
}
s3_serves() {
  # Bounded per attempt: awscli retries a 503 five times by default, which would
  # stretch the 150 × 2s window to tens of minutes while looking like a hang.
  AWS_MAX_ATTEMPTS=1 aws --cli-connect-timeout 5 --cli-read-timeout 5 \
    --endpoint-url "$EP" s3api create-bucket --bucket "$BKT" >/dev/null 2>&1 || true
  # No --max-keys: celld validates by listing this prefix in one request, and a
  # bounded listing can succeed where that one does not — which is how a
  # container gets past this gate only to die in celld's own validate.
  AWS_MAX_ATTEMPTS=1 aws --cli-connect-timeout 5 --cli-read-timeout 5 \
    --endpoint-url "$EP" s3api list-objects-v2 --bucket "$BKT" --prefix "$PREFIX" >/dev/null 2>&1
}
ready=0
tries=0
while [ "$tries" -lt 150 ]; do
  if s3_serves; then
    ready=1
    break
  fi
  tries=$((tries + 1))
  if [ $((tries % 15)) -eq 0 ]; then
    echo "noite-ui: waiting for ${EP} to serve s3://${BKT}/${PREFIX} (${tries}/150) — ${EP} says: $(s3_status)"
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "noite-ui: ${EP} does not serve s3://${BKT}/${PREFIX} after 5 min — ${EP} says: $(s3_status); check the rustfs service (503 + x-rustfs-readiness-pending = still starting; 403 = credentials on this side; 500 'Disk full' = its volume is full)" >&2
  exit 1
fi

# 2. Runtime vars: the image ships the bundle only — every value comes from
# the environment, so one image serves any domain/secret set. The baked
# `vars` block is replaced wholesale (never merged), so a stale build-time
# value cannot shadow the container's. Absent/empty keys are dropped and the
# worker keeps its own defaults.
vars="$(jq -cn '{
  AWS_ACCESS_KEY_ID: $ENV.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: $ENV.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: $ENV.AWS_REGION,
  BASE_DOMAIN: $ENV.BASE_DOMAIN,
  BETTER_AUTH_SECRET: $ENV.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: $ENV.BETTER_AUTH_URL,
  CONTROL_EXTRA_HOSTS: $ENV.CONTROL_EXTRA_HOSTS,
  CONTROL_SUBDOMAIN: $ENV.CONTROL_SUBDOMAIN,
  GIT_PUBLIC_BASE: $ENV.GIT_PUBLIC_BASE,
  NOITE_ADMIN_EMAIL: $ENV.NOITE_ADMIN_EMAIL,
  NOITE_EMAIL_WEBHOOK_URL: $ENV.NOITE_EMAIL_WEBHOOK_URL,
  NOITE_S3_BUCKET: $ENV.NOITE_S3_BUCKET,
  NOITE_SMTP_FROM: $ENV.NOITE_SMTP_FROM,
  RUNNER_TOKEN: $ENV.RUNNER_TOKEN,
  RUNNER_URL: $ENV.RUNNER_URL,
  S3_ENDPOINT: $ENV.S3_ENDPOINT,
  S3_PUBLIC_ENDPOINT: $ENV.S3_PUBLIC_ENDPOINT,
  UI_URL: $ENV.UI_URL
} | with_entries(select(.value != null and .value != ""))')"
tmp="$(mktemp)"
jq --argjson vars "$vars" '.vars = $vars' "${DIST}/wrangler.json" >"$tmp"
mv "$tmp" "${DIST}/wrangler.json"

# 3. Deploy only when bundle OR vars changed: the revision folds in the vars
# payload, so a config change (domain, secret, runner URL) redeploys while a
# plain container restart does not. celld adopts the new version in place
# within seconds; nothing else restarts. S3 can flip back to 503 mid-deploy
# (rustfs restarting, or a volume it is still indexing), so retry here rather
# than exit into a platform restart loop that re-deploys every couple of
# seconds; give up loudly so the platform re-schedules with a logged reason.
REV="${BUNDLE_REV}-$(printf '%s' "$vars" | sha256sum | cut -c1-16)"
deployed="$(aws --endpoint-url "$EP" s3 cp "s3://${BKT}/${MARKER_KEY}" - 2>/dev/null || true)"
if [ "$deployed" = "$REV" ]; then
  echo "noite-ui: revision ${REV} already deployed, skipping"
else
  echo "noite-ui: deploying revision ${REV}"
  attempt=0
  while ! celld deploy "$DIST" --bucket "$DEPLOY_BUCKET" --endpoint "$EP" --region "${AWS_REGION:-us-east-1}" --json; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 5 ]; then
      echo "noite-ui: celld deploy failed against ${EP} on ${attempt} attempts — ${EP} says: $(s3_status); check the rustfs service" >&2
      exit 1
    fi
    backoff=$((attempt * 10))
    echo "noite-ui: celld deploy failed (attempt ${attempt}/5), retrying in ${backoff}s — ${EP} says: $(s3_status)"
    sleep "$backoff"
  done
  printf '%s' "$REV" >/tmp/revision
  # The bundle is live either way; a marker that cannot be written only costs
  # one redundant deploy on the next boot.
  aws --endpoint-url "$EP" s3 cp /tmp/revision "s3://${BKT}/${MARKER_KEY}" >/dev/null ||
    echo "noite-ui: could not write ${MARKER_KEY}; the next boot redeploys" >&2
fi

# 4. Run the node. Explicit flags (not env-only) so the topology is readable
# here: worker listener on the compose network, operator listener internal.
# `--advertise` is how *peers* reach this node (node-to-node RPC, and
# `celld diagnose --peer`), so it has to be an address another node can dial —
# 127.0.0.1 is only correct for a one-node fleet, and celld's own advice for
# more capacity is "start another node against the same bucket", which a
# loopback advertise silently forbids. Prefer an explicit CELLD_ADVERTISE, then
# the platform's private DNS name (Railway sets RAILWAY_PRIVATE_DOMAIN), then
# the hostname (compose names a container after its service, which peers
# resolve).
advertise="${CELLD_ADVERTISE:-${RAILWAY_PRIVATE_DOMAIN:-$(hostname)}}:8091"
exec celld \
  --bucket "$DEPLOY_BUCKET" \
  --endpoint "$EP" \
  --region "${AWS_REGION:-us-east-1}" \
  --listen 0.0.0.0:8090 \
  --internal-listen 0.0.0.0:8091 \
  --advertise "$advertise"
