#!/usr/bin/env bash
# Noite installer: a fresh Ubuntu or Debian server to a running install.
#
#   curl -fsSL https://noite.now/run.sh | sudo bash -s install
#
# noite.now/run.sh resolves NOITE_REF to a commit and runs this file from it
# (apps/website/public/run.sh), so every run is the latest.
#
# Installs Docker when missing, writes /opt/noite/{compose.yaml,.env} with
# generated secrets, opens 80/443 in ufw when it is active, starts the stack
# and waits for /ready. Re-running it is the upgrade: compose.yaml and the
# image are refreshed, .env (domain, secrets) is kept.
#
# Environment (all optional; with sudo, put them after it):
#   NOITE_DOMAIN       base domain; app./api./git./*. must point at this host
#                      (default: asked, <public-ip>.sslip.io after 45 s)
#   NOITE_ADMIN_EMAIL  promoted to admin at boot
#   NOITE_VERSION      image tag (default: latest; a short SHA holds back)
#   NOITE_REF          git ref the installer and compose.yaml come from (default: main)
#   NOITE_DIR          install directory (default: /opt/noite)
#
# Nothing runs before main on the last line, so a truncated download never
# runs half an install.

set -euo pipefail

NOITE_REPO="ryuzcorp/noite"
NOITE_REF="${NOITE_REF:-main}"
NOITE_DIR="${NOITE_DIR:-/opt/noite}"
NOITE_VERSION="${NOITE_VERSION:-latest}"
NOITE_IMAGE_REPO="ghcr.io/ryuzcorp/noite"
READY_TIMEOUT_S=600
ASK_TIMEOUT_S=45
MIN_MEM_MB=1900

if [[ -t 1 ]]; then
  BOLD=$'\e[1m' DIM=$'\e[2m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m' RESET=$'\e[0m'
else
  BOLD="" DIM="" RED="" GREEN="" YELLOW="" RESET=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$RESET" "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() {
  printf '%serror%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# stdin is the script itself under `curl | bash`, so questions go to the
# terminal. Some sudo versions hand the script a terminal that never gets the
# keyboard, hence the deadline: no answer means the default.
ask() {
  local prompt="$1" default="$2" answer=""
  if [[ -r /dev/tty ]] && (: </dev/tty) 2>/dev/null; then
    printf '%s %s[%s]%s: ' "$prompt" "$DIM" "$default" "$RESET" >/dev/tty
    if ! read -r -t "$ASK_TIMEOUT_S" answer </dev/tty; then
      printf '\n    no answer in %ss, using %s\n' "$ASK_TIMEOUT_S" "$default" >/dev/tty
      answer=""
    fi
  fi
  printf '%s' "${answer:-$default}"
}

check_system() {
  step "Checking the system"
  info "installer ${NOITE_REF:0:12}"
  [[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL https://noite.now/run.sh | sudo bash -s install"
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
  local ip
  ip=$(public_ip)
  if [[ -n "${NOITE_DOMAIN:-}" ]]; then
    DOMAIN="$NOITE_DOMAIN"
  else
    info "Noite serves app.<domain>, api.<domain>, git.<domain> and *.<domain> (one per app)."
    info "Point them at ${ip:-this server}, or keep the sslip.io default to try it without DNS."
    DOMAIN=$(ask "    Base domain" "${ip:+$ip.sslip.io}")
  fi

  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  [[ -n "$DOMAIN" ]] || die "no domain: set NOITE_DOMAIN=example.com"
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
# a real domain refuses the recovery flow.
# NOITE_EMAIL_WEBHOOK_URL=https://hooks.example.com/noite-otp
# NOITE_SMTP_FROM=Noite <no-reply@$DOMAIN>
EOF
    info "generated .env with fresh secrets (BASE_DOMAIN=$DOMAIN)"
  fi

  if [[ -n "${NOITE_ADMIN_EMAIL:-}" ]]; then
    env_set NOITE_ADMIN_EMAIL "$NOITE_ADMIN_EMAIL"
  fi
}

open_firewall() {
  have ufw || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  step "Opening 80/tcp and 443/tcp in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
}

start_stack() {
  step "Starting Noite"
  compose pull --quiet
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

summary() {
  cat <<EOF

${GREEN}${BOLD}Noite is running.${RESET}

  Control UI   https://app.$DOMAIN
  Git          https://git.$DOMAIN/<slug>
  Apps         https://<slug>.$DOMAIN

${YELLOW}${BOLD}Register now.${RESET} The first account to sign up becomes the admin and needs
no invite code: open https://app.$DOMAIN before anyone else can.

  Config       $NOITE_DIR/.env (keep it: it holds the secrets)
  Logs         cd $NOITE_DIR && docker compose logs -f
  Upgrade      re-run this installer
  Docs         https://noite.now/self-hosting/install
EOF
}

main() {
  check_system
  install_docker
  check_ports
  write_config
  open_firewall
  start_stack
  summary
}

main "$@"
