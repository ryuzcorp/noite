#!/usr/bin/env bash
# Repair rootless podman pause/conmon without reboot.
# Safe to run from distrobox — host work goes through systemd-run --user.
set -euo pipefail

uid="$(id -u)"
runtime="${XDG_RUNTIME_DIR:-/run/user/$uid}"
# Prefer the real host runtime even when a fake XDG is set.
if [ -d /run/user/"$uid"/libpod ]; then
  runtime=/run/user/"$uid"
fi

host() {
  if [ -f /run/.containerenv ]; then
    local script
    script=$(mktemp /tmp/podman-fix-XXXXXX.sh)
    cat >"$script"
    systemd-run --user --wait --collect /bin/bash "$script"
    local st=$?
    rm -f "$script"
    return $st
  fi
  /bin/bash
}

echo "== ensure podman.socket =="
host <<EOF
systemctl --user enable --now podman.socket
ls -la /run/user/$uid/podman/podman.sock
EOF

echo "== restore pause.pid + conmon.pid =="
host <<EOF
set -euo pipefail
runtime=/run/user/$uid
# Real rootless pause has _PODMAN_PAUSE=1 in environ (readable on host only).
pause=""
for p in \$(pgrep -f 'catatonit -P' || true); do
  if tr '\\0' '\\n' < /proc/\$p/environ 2>/dev/null | grep -qx '_PODMAN_PAUSE=1'; then
    pause=\$p
    break
  fi
done
if [ -n "\$pause" ]; then
  echo -n "\$pause" > "\$runtime/libpod/tmp/pause.pid"
  echo "pause.pid=\$pause"
else
  echo "WARNING: no catatonit pause found" >&2
fi

for d in "\$runtime"/containers/overlay-containers/*/userdata; do
  [ -d "\$d" ] || continue
  id=\$(basename "\$(dirname "\$d")")
  # Primary conmon: -c <id> -u <id> (skip --exec helpers).
  cpid=\$(ps -eo pid=,args= | awk -v id="\$id" '
    \$0 ~ /\\/usr\\/bin\\/conmon/ && \$0 ~ ("-c " id " ") && \$0 ~ ("-u " id " ") && \$0 !~ /--exec/ { print \$1; exit }
  ')
  if [ -n "\$cpid" ]; then
    echo -n "\$cpid" > "\$d/conmon.pid"
    echo "conmon \$id -> \$cpid"
  fi
done

/usr/bin/podman ps -a --format '{{.Names}} {{.Status}}' | head -30
EOF

echo "== remove stale exited noite clones =="
host <<'EOF'
for c in noite_noite_1; do
  /usr/bin/podman rm -f "$c" 2>/dev/null || true
done
EOF

echo "ok — from distrobox use: make dev"
echo "wrapper talks to podman.socket and will not delete pause.pid"
