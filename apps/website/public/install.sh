#!/usr/bin/env bash
# Noite installer: a fresh Linux VPS (Ubuntu or Debian first) to a running
# install in one command.
#
#   curl -fsSL https://noite.now/install.sh | sudo bash
#
# What it does: installs Docker + Compose when missing, writes
# /opt/noite/{compose.yaml,.env} with generated secrets, opens 80/443 in ufw
# when it is active, pulls the image, starts the stack and waits for /ready.
#
# Re-running it is the upgrade path: it refreshes compose.yaml, keeps .env
# (secrets, domain) as is, pulls and recreates.
#
# Environment (all optional):
#   NOITE_DOMAIN       base domain; app./api./git./*. must point at this host
#                      (default: asked, or <public-ip>.sslip.io non-interactively)
#   NOITE_ADMIN_EMAIL  promoted to admin at boot
#   NOITE_VERSION      image tag (default: latest; a short SHA holds back)
#   NOITE_REF          git ref compose.yaml is fetched from (default: main)
#   NOITE_DIR          install directory (default: /opt/noite)
#   NOITE_TENANCY      multi (default off localhost) or single
#   NOITE_SKIP_DNS_CHECK  1 = skip the DNS check (skipped anyway for a bare IP or *.sslip.io)
#   NOITE_SKIP_DOCKER  1 = never install Docker, fail if missing
#
# The whole script is one function called on the last line, so a truncated
# download never runs half an install.

set -euo pipefail

NOITE_REPO="ryuzcorp/noite"
NOITE_REF="${NOITE_REF:-main}"
NOITE_DIR="${NOITE_DIR:-/opt/noite}"
NOITE_VERSION="${NOITE_VERSION:-latest}"
NOITE_IMAGE_REPO="ghcr.io/ryuzcorp/noite"
COMPOSE_URL="https://raw.githubusercontent.com/${NOITE_REPO}/${NOITE_REF}/docker/compose.yaml"
READY_TIMEOUT_S=600
MIN_MEM_MB=1900
MIN_DISK_GB=10

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

# stdin is the script itself under `curl | bash`; questions go to the terminal.
has_tty() { [[ -r /dev/tty ]] && (: </dev/tty) 2>/dev/null; }

ask() {
  local prompt="$1" default="$2" answer=""
  if has_tty; then
    printf '%s %s[%s]%s: ' "$prompt" "$DIM" "$default" "$RESET" >/dev/tty
    read -r answer </dev/tty || true
  fi
  printf '%s' "${answer:-$default}"
}

check_system() {
  step "Checking the system"
  [[ "$(id -u)" -eq 0 ]] || die "run as root: curl -fsSL https://noite.now/install.sh | sudo bash"
  [[ "$(uname -s)" == "Linux" ]] || die "Noite installs on Linux only"

  case "$(uname -m)" in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "unsupported architecture $(uname -m): the image is built for amd64 and arm64" ;;
  esac

  OS_ID="unknown" OS_LIKE="" OS_NAME="unknown"
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-unknown}" OS_LIKE="${ID_LIKE:-}" OS_NAME="${PRETTY_NAME:-$OS_ID}"
  fi
  case "$OS_ID" in
    ubuntu | debian) info "$OS_NAME" ;;
    *)
      if [[ " $OS_LIKE " == *" debian "* || " $OS_LIKE " == *" ubuntu "* ]]; then
        warn "$OS_NAME is Debian-based but untested; continuing"
      elif have docker; then
        warn "$OS_NAME is not supported; continuing with the Docker already installed"
      else
        die "$OS_NAME is not supported: install Docker with Compose yourself, then re-run"
      fi
      ;;
  esac

  local mem_mb disk_gb
  mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  ((mem_mb >= MIN_MEM_MB)) || warn "${mem_mb} MB of memory; 2 GB or more is recommended"
  mkdir -p "$NOITE_DIR"
  disk_gb=$(df -Pk "$NOITE_DIR" | awk 'NR == 2 { print int($4 / 1048576) }')
  ((disk_gb >= MIN_DISK_GB)) || warn "${disk_gb} GB free disk; ${MIN_DISK_GB} GB or more is recommended"
}

apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "$@" >/dev/null
}

install_packages() {
  local missing=()
  have curl || missing+=(curl)
  have openssl || missing+=(openssl)
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  if ((${#missing[@]} == 0)); then
    return 0
  fi
  have apt-get || die "missing ${missing[*]} and no apt-get to install them"
  step "Installing ${missing[*]}"
  apt_install "${missing[@]}"
}

install_docker() {
  step "Checking Docker"
  if have docker && docker --version 2>/dev/null | grep -qi podman; then
    die "\`docker\` is Podman here; the installer needs Docker Engine (or use docker/compose.yaml by hand)"
  fi

  if ! have docker; then
    if [[ "${NOITE_SKIP_DOCKER:-0}" == "1" ]]; then
      die "Docker is not installed and NOITE_SKIP_DOCKER=1"
    fi
    info "installing Docker Engine from get.docker.com"
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi

  if ! docker compose version >/dev/null 2>&1; then
    if [[ "${NOITE_SKIP_DOCKER:-0}" == "1" ]]; then
      die "the Docker Compose plugin is missing"
    fi
    have apt-get || die "the Docker Compose plugin is missing; install docker-compose-plugin"
    info "installing the Docker Compose plugin"
    apt_install docker-compose-plugin
  fi

  if have systemctl; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker info >/dev/null 2>&1 || die "the Docker daemon is not running: systemctl start docker"
  info "$(docker --version)"
  info "$(docker compose version)"
}

public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
    [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] && break
    ip=""
  done
  [[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{ print $1 }') || true
  printf '%s' "$ip"
}

# .env next to compose.yaml is picked up because the project directory is
# the compose file's own.
compose() { docker compose -f "$NOITE_DIR/compose.yaml" "$@"; }

stack_running() {
  [[ -f "$NOITE_DIR/compose.yaml" ]] && [[ -n "$(compose ps -q noite 2>/dev/null)" ]]
}

check_ports() {
  stack_running && return
  have ss || return 0
  local port
  for port in 80 443; do
    if [[ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]]; then
      die "port $port is already in use; Noite's edge needs 80 and 443 (stop the web server holding it)"
    fi
  done
}

rand_hex() { openssl rand -hex "$1"; }

env_get() { grep -E "^$1=" "$NOITE_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2-; }

# Set KEY=VALUE in .env, replacing an existing line.
env_set() {
  local key="$1" value="$2" file="$NOITE_DIR/.env"
  if grep -qE "^$key=" "$file"; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

apply_overrides() {
  if [[ -n "${NOITE_ADMIN_EMAIL:-}" ]]; then
    env_set NOITE_ADMIN_EMAIL "$NOITE_ADMIN_EMAIL"
  fi
  if [[ -n "${NOITE_TENANCY:-}" ]]; then
    env_set NOITE_TENANCY "$NOITE_TENANCY"
  fi
}

choose_domain() {
  local ip default
  ip=$(public_ip)
  PUBLIC_IP="$ip"
  default="${ip:+$ip.sslip.io}"

  if [[ -n "${NOITE_DOMAIN:-}" ]]; then
    DOMAIN="$NOITE_DOMAIN"
  else
    info "Noite serves app.<domain>, api.<domain>, git.<domain> and *.<domain> (one per app)."
    info "Point a wildcard A record (*.<domain>) and app/api/git at ${ip:-this server},"
    info "or keep the sslip.io default to try it without DNS."
    DOMAIN=$(ask "    Base domain" "$default")
  fi

  DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')
  [[ -n "$DOMAIN" ]] || die "no domain: set NOITE_DOMAIN=example.com"
  [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    die "\"$DOMAIN\" is not a domain name"
  [[ "$DOMAIN" != "localhost" ]] || die "use make up from a checkout for a localhost install"
}

check_dns() {
  [[ -n "${PUBLIC_IP:-}" ]] || return 0
  # A bare IP or an sslip.io name (LAN/local trial) has no DNS records to check.
  [[ "${NOITE_SKIP_DNS_CHECK:-0}" != "1" ]] || return 0
  [[ ! "$DOMAIN" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || return 0
  [[ "$DOMAIN" != *.sslip.io && "$DOMAIN" != sslip.io ]] || return 0
  local host resolved
  for host in "app.$DOMAIN" "git.$DOMAIN" "noite-dns-check.$DOMAIN"; do
    resolved=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 { print $1 }') || true
    if [[ -z "$resolved" ]]; then
      warn "$host does not resolve yet; certificates issue once DNS points at $PUBLIC_IP"
    elif [[ "$resolved" != "$PUBLIC_IP" ]]; then
      warn "$host resolves to $resolved, not $PUBLIC_IP (fine behind a proxy, otherwise fix DNS)"
    fi
  done
}

write_config() {
  step "Writing $NOITE_DIR"
  mkdir -p "$NOITE_DIR"
  local tmp
  tmp=$(mktemp)
  curl -fsSL "$COMPOSE_URL" -o "$tmp" || die "could not download $COMPOSE_URL"
  grep -q '^services:' "$tmp" || die "$COMPOSE_URL is not a compose file"
  install -m 0644 "$tmp" "$NOITE_DIR/compose.yaml"
  rm -f "$tmp"
  info "compose.yaml from $NOITE_REPO@$NOITE_REF"

  if [[ -f "$NOITE_DIR/.env" ]]; then
    # Secrets and the domain are fixed at first install: passkeys bind to
    # BETTER_AUTH_URL and the bucket keys guard existing data.
    DOMAIN=$(env_get BASE_DOMAIN)
    [[ -n "$DOMAIN" ]] || die "$NOITE_DIR/.env has no BASE_DOMAIN; fix it or move it away to start over"
    if [[ -n "${NOITE_DOMAIN:-}" && "$NOITE_DOMAIN" != "$DOMAIN" ]]; then
      warn "keeping BASE_DOMAIN=$DOMAIN from .env; changing it breaks every registered passkey"
    fi
    info "keeping .env (BASE_DOMAIN=$DOMAIN)"
    # Every run lands on NOITE_VERSION (latest unless given), so a re-run
    # also moves an install that was held back on a SHA forward again.
    env_set NOITE_IMAGE "$NOITE_IMAGE_REPO:$NOITE_VERSION"
    apply_overrides
    return 0
  fi

  choose_domain
  check_dns

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
  apply_overrides
  chmod 600 "$NOITE_DIR/.env"
  info "generated .env with fresh secrets (BASE_DOMAIN=$DOMAIN)"
}

open_firewall() {
  have ufw || return 0
  ufw status 2>/dev/null | grep -q '^Status: active' || return 0
  step "Opening 80/tcp and 443/tcp in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
}

start_stack() {
  step "Pulling images"
  compose pull --quiet

  step "Starting Noite"
  compose up -d --remove-orphans

  info "waiting for /ready (the first boot deploys the control UI; this can take a few minutes)"
  local waited=0 body=""
  while ((waited < READY_TIMEOUT_S)); do
    if body=$(compose exec -T noite curl -fs -m 5 http://127.0.0.1:8080/ready 2>/dev/null); then
      info "ready"
      return
    fi
    sleep 5
    waited=$((waited + 5))
  done
  body=$(compose exec -T noite curl -s -m 5 http://127.0.0.1:8080/ready 2>/dev/null || true)
  warn "not ready after ${READY_TIMEOUT_S}s: ${body:-no answer from the runner}"
  warn "inspect with: cd $NOITE_DIR && docker compose logs -f noite"
  exit 1
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
  Upgrade      re-run this installer (tracks :latest)
  Docs         https://noite.now/self-hosting/install
EOF
}

main() {
  check_system
  install_packages
  install_docker
  check_ports
  write_config
  open_firewall
  start_stack
  summary
}

main "$@"
