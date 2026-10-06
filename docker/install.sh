#!/usr/bin/env bash
# Noite installer: a fresh Ubuntu or Debian server to a running install.
#
#   curl -fsSL https://noite.now/run.sh | bash -s install
#
# noite.now/run.sh resolves NOITE_REF to a commit and runs this file from it
# (apps/website/public/run.sh), so every run uses the current installer.
#
# Installs Docker when missing, writes /opt/noite/{compose.yaml,.env} with
# generated secrets, opens 80/443 in ufw when it is active, starts the stack
# and waits for /ready. Re-running it is the upgrade: compose.yaml and the
# image are refreshed to the channel's newest release, .env (domain, secrets)
# is kept.
#
# Environment (all optional; `curl … | NOITE_DOMAIN=example.com bash -s install`):
#   NOITE_DOMAIN       base domain; app./api./git./*. must point at this host
#                      (default: asked, <public-ip>.sslip.io on Enter or without a terminal)
#   NOITE_ADMIN_EMAIL  promoted to admin at boot
#   NOITE_EMAIL_WEBHOOK_URL
#                      receives lost-passkey sign-in codes as JSON; without it,
#                      recover with `noite-runner recover` (printed at the end)
#   NOITE_TELEMETRY=0  turn off the anonymous daily heartbeat (on by default);
#                      also DO_NOT_TRACK=1. https://noite.now/self-hosting/telemetry
#   NOITE_VERSION      release channel or version (default: alpha; `stable`
#                      follows final releases only, `0.1.0-alpha.1` or a short
#                      SHA holds an install in place; `run.sh … install --pre`
#                      pins the newest release, pre-releases included)
#   NOITE_REF          git ref the installer and compose.yaml come from (default: main)
#   NOITE_DIR          install directory (default: /opt/noite)
#   NOITE_YES=1        skip the upgrade confirmation (`bash -s install --yes`
#                      does the same; NOITE_CONFIRM=1 is accepted too)
#
# An upgrade whose image differs from the running container restarts the
# runner and every tenant fleet: the installer says so and asks once (when it
# has a terminal) before it recreates anything.
#
# Nothing runs before main on the last line, so a truncated download never
# runs half an install.

set -euo pipefail

NOITE_REPO="ryuzcorp/noite"
NOITE_REF="${NOITE_REF:-main}"
NOITE_DIR="${NOITE_DIR:-/opt/noite}"
NOITE_VERSION="${NOITE_VERSION:-alpha}"
NOITE_IMAGE_REPO="ghcr.io/ryuzcorp/noite"
READY_TIMEOUT_S=600
MIN_MEM_MB=1900
# 1 = skip the upgrade confirmation: --yes / -y, NOITE_YES=1, or
# NOITE_CONFIRM=1 (the flag uninstall.sh uses for its own prompt).
CONFIRM_SKIP=0
if [[ "${NOITE_YES:-0}" = "1" || "${NOITE_CONFIRM:-0}" = "1" ]]; then
  CONFIRM_SKIP=1
fi

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
  BOLD="" RED="" GREEN="" YELLOW="" RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# stdin is this script under `curl | bash`, so questions go to /dev/tty. Only
# the terminal's foreground process group may read it: a background process
# (what `curl | sudo bash` makes of the script) is stopped by SIGTTIN for good.
can_ask() {
  (: </dev/tty) 2>/dev/null || return 1
  local stat pgrp tpgid
  stat=$(</proc/$$/stat)
  read -r _ _ pgrp _ _ tpgid _ <<<"${stat##*) }"
  [[ "$pgrp" == "$tpgid" ]]
}

check_system() {
  step "Checking the system"
  info "installer ${NOITE_REF:0:12}"
  [[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL https://noite.now/run.sh | bash -s install"
  [[ "$(uname -s)" == "Linux" ]] || die "Noite installs on Linux only"
  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "unsupported architecture $(uname -m): the image is built for amd64 and arm64" ;;
  esac

  local mem_mb
  mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  ((mem_mb >= MIN_MEM_MB)) || warn "${mem_mb} MB of memory; 2 GB or more is recommended"
}

install_docker() {
  step "Checking Docker"
  if ! have docker; then
    info "installing Docker Engine from get.docker.com"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
  if have systemctl; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing: apt-get install docker-compose-plugin"
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running: systemctl start docker"
  info "$(docker --version)"
}

# .env next to compose.yaml is picked up: the project directory is the
# compose file's own.
compose() { docker compose -f "$NOITE_DIR/compose.yaml" "$@"; }

check_ports() {
  if [[ -f "$NOITE_DIR/compose.yaml" && -n "$(compose ps -q noite 2>/dev/null)" ]]; then
    return 0
  fi
  have ss || return 0
  local port
  for port in 80 443; do
    if [[ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]]; then
      die "port $port is already in use; Noite's edge needs 80 and 443"
    fi
  done
}

public_ip() {
  local ip url
  for url in https://api.ipify.org https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    if [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
      printf '%s' "$ip"
      return 0
    fi
  done
  hostname -I 2>/dev/null | awk '{ print $1 }'
}

rand_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }

env_get() { grep -E "^$1=" "$NOITE_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2-; }

# Set KEY=VALUE in .env, replacing an existing line.
env_set() {
  local key="$1" value="$2" file="$NOITE_DIR/.env" tmp
  if grep -qE "^$key=" "$file"; then
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

choose_domain() {
  local ip default answer=""
  ip=$(public_ip)
  default="${ip:+$ip.sslip.io}"
  if [[ -n "${NOITE_DOMAIN:-}" ]]; then
    answer="$NOITE_DOMAIN"
  elif can_ask; then
    info "Noite serves app.<domain>, api.<domain>, git.<domain> and *.<domain> (one per app)."
    info "Point them at ${ip:-this server}, or press Enter for sslip.io to try it without DNS."
    printf '    Base domain [%s]: ' "$default" >/dev/tty
    read -r answer </dev/tty || true
  else
    warn "no terminal to ask on (\`curl | sudo bash\` runs this in the background); set NOITE_DOMAIN to choose"
  fi
  DOMAIN="${answer:-$default}"

  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  [[ -n "$DOMAIN" ]] || die "no public IP found: set NOITE_DOMAIN (curl … | NOITE_DOMAIN=example.com bash -s install)"
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    die "\"$DOMAIN\" is not a domain name"

  # sslip.io and nip.io resolve to the IP inside the name: nothing to check.
  case "$DOMAIN" in
    *sslip.io | *nip.io) return 0 ;;
  esac
  local resolved
  resolved=$(timeout 5 getent ahostsv4 "app.$DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }') || true
  if [[ -n "$ip" && "$resolved" != "$ip" ]]; then
    warn "app.$DOMAIN resolves to ${resolved:-nothing}, not $ip; certificates issue once DNS points here"
  fi
}

write_config() {
  step "Writing $NOITE_DIR"
  mkdir -p "$NOITE_DIR"
  local url="https://raw.githubusercontent.com/$NOITE_REPO/$NOITE_REF/docker/compose.yaml" tmp
  tmp=$(mktemp)
  curl -fsSL "$url" -o "$tmp" || die "could not download $url"
  grep -q '^services:' "$tmp" || die "$url is not a compose file"
  install -m 0644 "$tmp" "$NOITE_DIR/compose.yaml"
  rm -f "$tmp"

  if [[ -f "$NOITE_DIR/.env" ]]; then
    # The domain and secrets are fixed at first install: passkeys bind to
    # BETTER_AUTH_URL and the bucket keys guard existing data.
    DOMAIN=$(env_get BASE_DOMAIN)
    [[ -n "$DOMAIN" ]] || die "$NOITE_DIR/.env has no BASE_DOMAIN; fix it or move it away to start over"
    if [[ -n "${NOITE_DOMAIN:-}" && "$NOITE_DOMAIN" != "$DOMAIN" ]]; then
      warn "keeping BASE_DOMAIN=$DOMAIN: changing it breaks every registered passkey (uninstall to start over)"
    fi
    info "keeping .env (BASE_DOMAIN=$DOMAIN)"
    env_set NOITE_IMAGE "$NOITE_IMAGE_REPO:$NOITE_VERSION"
  else
    choose_domain
    umask 077
    cat >"$NOITE_DIR/.env" <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Every variable is
# documented in docker/compose.yaml and .env.example; apply changes with
#   cd $NOITE_DIR && docker compose up -d
#
# BASE_DOMAIN and BETTER_AUTH_URL are fixed once someone registers: passkeys
# bind to that origin. The RustFS keys guard the bundled bucket's data.

BASE_DOMAIN=$DOMAIN
CONTROL_SUBDOMAIN=app
BETTER_AUTH_URL=https://app.$DOMAIN
GIT_PUBLIC_BASE=https://git.$DOMAIN
HTTP_PORT=80
HTTPS_PORT=443

NOITE_IMAGE=$NOITE_IMAGE_REPO:$NOITE_VERSION

RUNNER_TOKEN=$(rand_hex 32)
BETTER_AUTH_SECRET=$(rand_hex 32)
RUSTFS_ACCESS_KEY=noite$(rand_hex 8)
RUSTFS_SECRET_KEY=$(rand_hex 24)

# Lost-passkey sign-in codes are POSTed to this webhook as JSON; without it
# nothing is emailed, and the operator recovers from the server with
#   cd $NOITE_DIR && docker compose exec noite noite-runner recover
# NOITE_EMAIL_WEBHOOK_URL=https://hooks.example.com/noite-otp
# NOITE_SMTP_FROM=Noite <no-reply@$DOMAIN>
EOF
    info "generated .env with fresh secrets (BASE_DOMAIN=$DOMAIN)"
  fi

  if [[ -n "${NOITE_ADMIN_EMAIL:-}" ]]; then
    env_set NOITE_ADMIN_EMAIL "$NOITE_ADMIN_EMAIL"
  fi
  if [[ -n "${NOITE_EMAIL_WEBHOOK_URL:-}" ]]; then
    env_set NOITE_EMAIL_WEBHOOK_URL "$NOITE_EMAIL_WEBHOOK_URL"
  fi
  if [[ -n "${NOITE_TELEMETRY:-}" ]]; then
    env_set NOITE_TELEMETRY "$NOITE_TELEMETRY"
  fi
}

open_firewall() {
  have ufw || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  step "Opening 80/tcp and 443/tcp in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
}

# An upgrade recreates the container only when the pulled image differs from
# the one that is running: a re-run against the same tag changes nothing and
# must not ask for anything.
will_restart() {
  local cid running target
  cid=$(compose ps -q noite 2>/dev/null | head -n 1)
  [[ -n "$cid" ]] || return 1
  running=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)
  target=$(docker image inspect --format '{{.Id}}' "$(env_get NOITE_IMAGE)" 2>/dev/null || true)
  [[ -n "$running" && -n "$target" && "$running" != "$target" ]]
}

# One container runs the runner and every fleet, so replacing it restarts the
# tenants with it. They cold-boot behind the edge (a request in that window is
# held and served once the fleet is up — measured ~2-5 s for 5-15 apps on a
# 32-core host; past the edge's 20 s hold a short "starting" page answers), and
# the control UI is back within a few seconds. Say so before recreating, and
# ask once when there is a terminal to ask on (`--yes` / `NOITE_YES=1` skips).
confirm_upgrade() {
  will_restart || return 0
  local channel
  channel="${NOITE_VERSION:-$(env_get NOITE_IMAGE)}"
  if [[ "$CONFIRM_SKIP" -eq 1 ]]; then
    warn "upgrade: the runner and every tenant fleet restart (target $channel)"
    return 0
  fi
  if can_ask; then
    warn "this upgrade recreates the container: the runner and every tenant fleet restart"
    info "Tenant requests are held at the edge and served as each fleet cold-boots (a few seconds for"
    info "most installs; past 20 s the app answers a short \"starting\" page that reloads itself)."
    printf '    Upgrade to %s now? [y/N] ' "$channel" >/dev/tty
    local answer=""
    read -r answer </dev/tty || true
    case "$answer" in
      y | Y | yes | YES) return 0 ;;
      *)
        die "upgrade cancelled: nothing was recreated (the new image is pulled; re-run with --yes or NOITE_YES=1 to skip this prompt)"
        ;;
    esac
  fi
  warn "upgrade: the runner and every tenant fleet restart (target $channel); no terminal to confirm on (NOITE_YES=1 skips this warning)"
}

start_stack() {
  step "Starting Noite"
  compose pull --quiet
  confirm_upgrade
  compose up -d --remove-orphans

  info "waiting for /ready (the first boot deploys the control UI; this can take a few minutes)"
  local waited=0 body
  while ((waited < READY_TIMEOUT_S)); do
    if compose exec -T noite curl -fs -m 5 http://127.0.0.1:8080/ready >/dev/null 2>&1; then
      info "ready"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  body=$(compose exec -T noite curl -s -m 5 http://127.0.0.1:8080/ready 2>/dev/null || true)
  warn "not ready after ${READY_TIMEOUT_S}s: ${body:-no answer from the runner}"
  die "inspect with: cd $NOITE_DIR && docker compose logs -f noite"
}

# How an operator gets back in after losing the passkey: the webhook when one is
# set, the server-side command always.
recovery_note() {
  if [[ -n "$(env_get NOITE_EMAIL_WEBHOOK_URL)" ]]; then
    printf '%s' "Lost passkey   codes go to your NOITE_EMAIL_WEBHOOK_URL"
  else
    printf '%s' "Lost passkey   no email webhook is set: NOITE_EMAIL_WEBHOOK_URL in .env sends codes"
  fi
}

summary() {
  cat <<EOF

${GREEN}${BOLD}Noite is running.${RESET}

  Control UI   https://app.$DOMAIN
  Git          https://git.$DOMAIN/<slug>
  Apps         https://<slug>.$DOMAIN

${YELLOW}${BOLD}Register now.${RESET} The first account to sign up becomes the admin and needs
no invite code: open https://app.$DOMAIN before anyone else can.

${YELLOW}${BOLD}Telemetry.${RESET} On by default: once a day this install sends Noite's maintainers
an anonymous, count-only summary (version, platform, apps, deploys, users) — no
domains, names, emails or IPs. Turn it off under Admin on
https://app.$DOMAIN/account, or set NOITE_TELEMETRY=0 in $NOITE_DIR/.env and run
  cd $NOITE_DIR && docker compose up -d

  Config       $NOITE_DIR/.env (keep it: it holds the secrets)
  Logs         cd $NOITE_DIR && docker compose logs -f
  $(recovery_note)
               either way, from this server: cd $NOITE_DIR && docker compose exec noite noite-runner recover
  Upgrade      re-run this installer: a new image restarts the runner and every
               app (it warns and asks first); read CHANGELOG.md's
               "Operator action required" before you do
  Docs         https://noite.now/self-hosting/install
EOF
}

# `run.sh` passes through whatever follows `install` (it consumes --pre
# itself, as NOITE_REF + NOITE_VERSION); only --yes is defined here.
parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) CONFIRM_SKIP=1 ;;
      "") ;;
      *) warn "ignoring unknown argument \"$arg\" (only --yes is understood)" ;;
    esac
  done
}

main() {
  parse_args "$@"
  check_system
  install_docker
  check_ports
  write_config
  open_firewall
  start_stack
  summary
}

main "$@"
