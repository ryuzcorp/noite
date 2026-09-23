#!/bin/sh
# Noite dual-role entrypoint (baked at /usr/local/bin/noite-entrypoint.sh).
#
# - `cell` (the image default CMD, used by the celld container cell) runs
#   the runner directly — no bucket setup, the worker owns durability.
# - Anything else is the compose control plane: ensure the fleet bucket
#   exists (idempotent head-or-make via the baked-in awscli; the celld
#   node validates it at boot and exits non-zero when missing) and exec
#   celld — default topology flags from env, or the given flags verbatim.
#   `exec` keeps celld as PID 1 (signals + the `kill -0 1` healthcheck).
set -eu
if [ "${1:-}" = "cell" ]; then
  shift
  exec noite-runner "$@"
fi
# Fleet bucket must exist before celld validates it (fresh boxes have
# nothing else to create it): idempotent head-or-make via awscli.
BKT="s3://${NOITE_S3_BUCKET:-noite}"
EP="${S3_ENDPOINT:-http://rustfs:9000}"
aws --endpoint-url "$EP" s3api head-bucket --bucket "${NOITE_S3_BUCKET:-noite}" 2>/dev/null || aws --endpoint-url "$EP" s3 mb "$BKT"
# No args = the celld node with topology flags from env. Explicit args
# (compose `command:`, manual runs) pass straight through to celld.
if [ $# -eq 0 ]; then
  set -- --bucket "s3://${NOITE_S3_BUCKET:-noite}/control" --endpoint "${S3_ENDPOINT:-http://rustfs:9000}" --region "${AWS_REGION:-us-east-1}" --listen 0.0.0.0:8090 --internal-listen 0.0.0.0:8091 --advertise 127.0.0.1:8091
fi
exec celld "$@"
