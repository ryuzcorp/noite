#!/bin/sh
# Noite control-UI node entrypoint (baked at /usr/local/bin/noite-entrypoint.sh
# in the UI image). Brings a fresh box to a serving control plane with no host
# steps: ensure the fleet bucket, patch the worker's runtime vars from this
# container's environment (secrets never bake into the image), deploy the baked
# bundle when its revision differs from the deployed one, then exec celld as
# PID 1 (signals + the `kill -0 1` healthcheck).
set -eu

BKT="${NOITE_S3_BUCKET:-noite}"
EP="${S3_ENDPOINT:-http://rustfs:9000}"
DIST="${UI_DIST:-/ui/dist}"
MARKER_KEY="ui/revision"
DEPLOY_BUCKET="s3://${BKT}/control"
# Revision of the baked bundle. Present in the image; a missing file means a
# hand-built image without the build stage, which must not silently skip.
BUNDLE_REV="$(cat "${DIST}/REVISION" 2>/dev/null || echo unknown)"

# 1. Wait for S3 to answer. Root GET / answers 403 without credentials —
# connection (not auth) is the signal, and the wait loop (not compose
# ordering) is what makes BYOB overlays and odd platforms work. ~2 min cap.
tries=0
while [ "$tries" -lt 60 ]; do
  if curl -s -o /dev/null "$EP"; then
    break
  fi
  tries=$((tries + 1))
  sleep 2
done

# 2. The celld node validates the bucket at boot and exits non-zero when it is
# missing — on a fresh box nothing else creates it (the runner ensures it too,
# but neither may assume the other won the race).
aws --endpoint-url "$EP" s3api head-bucket --bucket "$BKT" 2>/dev/null || aws --endpoint-url "$EP" s3 mb "s3://${BKT}"

# 3. Runtime vars: the image ships the bundle only — every value comes from
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

# 4. Deploy only when bundle OR vars changed: the revision folds in the vars
# payload, so a config change (domain, secret, runner URL) redeploys while a
# plain container restart does not. celld adopts the new version in place
# within seconds; nothing else restarts.
REV="${BUNDLE_REV}-$(printf '%s' "$vars" | sha256sum | cut -c1-16)"
deployed="$(aws --endpoint-url "$EP" s3 cp "s3://${BKT}/${MARKER_KEY}" - 2>/dev/null || true)"
if [ "$deployed" = "$REV" ]; then
  echo "noite-ui: revision ${REV} already deployed, skipping"
else
  echo "noite-ui: deploying revision ${REV}"
  celld deploy "$DIST" --bucket "$DEPLOY_BUCKET" --endpoint "$EP" --region "${AWS_REGION:-us-east-1}" --json
  printf '%s' "$REV" >/tmp/revision
  aws --endpoint-url "$EP" s3 cp /tmp/revision "s3://${BKT}/${MARKER_KEY}" >/dev/null
fi

# 5. Run the node. Explicit flags (not env-only) so the topology is readable
# here: worker listener on the compose network, operator listener internal.
exec celld \
  --bucket "$DEPLOY_BUCKET" \
  --endpoint "$EP" \
  --region "${AWS_REGION:-us-east-1}" \
  --listen 0.0.0.0:8090 \
  --internal-listen 0.0.0.0:8091 \
  --advertise 127.0.0.1:8091
