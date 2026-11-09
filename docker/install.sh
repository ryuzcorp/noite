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
# and waits for /ready. It installs a FRESH server only: alpha builds do not
# upgrade between versions (the runner and the control D1 refuse a database
# from another alpha). To move to a new alpha, uninstall (this wipes the
# volumes) and run the installer again.
#
# On a host under 4 GB the installer also creates a 1-2 GB /noite.swap
# swapfile (swappiness 10) as a safety net for a transient peak: the build
# keeps zero swap, so a build that outgrows its budget still dies in its own
# cgroup instead of thrashing this disk. Skip it with NOITE_SWAP=0.
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
#   NOITE_UPDATE_CHECK=0  turn off the daily release check (on by default).
#                      https://noite.now/self-hosting/operations#updating
#   NOITE_VERSION      release channel or version (default: alpha; `stable`
#                      follows final releases only, `0.1.0-alpha.5` or a short
#                      SHA holds an install in place; `run.sh … install --pre`
#                      pins the newest release, pre-releases included)
#   NOITE_REF          git ref the installer and compose.yaml come from (default: main)
#   NOITE_DIR          install directory (default: /opt/noite)
#   NOITE_SWAP=0       do not create the small-host swapfile (default: on for
#                      hosts under 4 GB with no swap)
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
NOITE_SWAP="${NOITE_SWAP:-1}"
MIN_MEM_MB=1900
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

# A host under 4 GB builds while serving; one transient peak (a build step or
# a RustFS burst) can OOM-kill RustFS or Caddy and take the control UI with it.
# A small swapfile is that safety net, not a build budget: the build cgroups
# keep memory.swap.max=0, so a build that outgrows RUNNER_BUILD_MEMORY_MB
# still dies alone instead of swapping the disk to death. Idempotent; a host
# where swapon is not permitted (a container, OpenVZ) warns and continues.
ensure_swap() {
  step "Checking swap"
  if [[ "$NOITE_SWAP" != "1" ]]; then
    info "NOITE_SWAP=0: leaving the host's swap alone"
    return 0
  fi
  if [[ -f /.dockerenv || -f /run/.containerenv ]]; then
    info "inside a container: swap belongs to the host"
    return 0
  fi
  local mem_mb
  mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  if ((mem_mb >= 4096)); then
    info "${mem_mb} MB of memory; swap is optional"
    return 0
  fi
  if swapon --show --noheadings 2>/dev/null | grep -q .; then
    info "swap already active"
    return 0
  fi
  local size_mb=$((mem_mb / 2))
  ((size_mb < 1024)) && size_mb=1024
  ((size_mb > 2048)) && size_mb=2048
  local avail_kb
  avail_kb=$(df -Pk / | awk 'NR == 2 { print $4 }')
  if ((avail_kb < (size_mb + 3072) * 1024)); then
    warn "skipping ${size_mb} MB swap: $((avail_kb / 1024)) MB free on /, ${size_mb} MB plus 3 GB headroom needed"
    return 0
  fi
  if [[ -L /noite.swap ]]; then
    die "refusing to follow a symlink at /noite.swap"
  fi
  if [[ ! -f /noite.swap ]]; then
    if ! fallocate -l "${size_mb}M" /noite.swap 2>/dev/null; then
      rm -f /noite.swap
      if ! dd if=/dev/zero of=/noite.swap bs=1M count="$size_mb" status=none; then
        warn "could not create /noite.swap; continuing without swap"
        rm -f /noite.swap
        return 0
      fi
    fi
  fi
  chmod 600 /noite.swap
  if ! mkswap /noite.swap >/dev/null 2>&1; then
    warn "mkswap /noite.swap failed; continuing without swap"
    return 0
  fi
  if ! swapon /noite.swap 2>/dev/null; then
    warn "swapon is not permitted on this host (OpenVZ or an unusual filesystem); continuing without swap"
    rm -f /noite.swap
    return 0
  fi
  grep -qE '^[[:space:]]*/noite\.swap[[:space:]]' /etc/fstab ||
    echo '/noite.swap none swap sw 0 0' >>/etc/fstab
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-noite-swap.conf
  sysctl -q -p /etc/sysctl.d/99-noite-swap.conf 2>/dev/null || true
  info "${size_mb} MB swapfile at /noite.swap (swappiness 10)"
}

compose() {
  if is_multi_tenancy && [ -f "$NOITE_DIR/compose.multi.yaml" ]; then
    docker compose -f "$NOITE_DIR/compose.yaml" -f "$NOITE_DIR/compose.multi.yaml" "$@"
  else
    docker compose -f "$NOITE_DIR/compose.yaml" "$@"
  fi
}

# Mirror the runner's parse_tenancy (and docker/lib.sh is_multi_tenancy):
# explicit NOITE_TENANCY wins (blank = unset); otherwise a localhost-family
# BASE_DOMAIN means single, anything else means multi. install.sh is fetched
# standalone via curl, so this duplicates lib.sh instead of sourcing it.
is_multi_tenancy() {
  local tenancy base
  tenancy="$(printf '%s' "$(env_get NOITE_TENANCY)" | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$tenancy" in
    single) return 1 ;;
    multi) return 0 ;;
  esac
  base="$(env_get BASE_DOMAIN)"
  base="$(printf '%s' "${base:-localhost}" | tr 'A-Z' 'a-z' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/\.*$//')"
  case "$base" in
    localhost | *.localhost) return 1 ;;
    *) return 0 ;;
  esac
}

# The `-f` flags an operator must pass to reproduce `compose` above outside
# the installer (empty on single installs, which get nothing new).
compose_hint() {
  if is_multi_tenancy; then
    printf '%s' "-f compose.yaml -f compose.multi.yaml"
  fi
}

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

# Last value of KEY in .env, empty when absent (never fails: callers assign
# it under `set -e`, and grep's no-match status would abort the script).
env_get() { { grep -E "^$1=" "$NOITE_DIR/.env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2-; }

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

# Set KEY to VALUE when .env has no value for it (absent or empty).
# `--allow-empty` keeps a present-but-empty line: CONTROL_SUBDOMAIN= is a
# real choice (the control UI on the bare domain).
env_default() {
  local allow_empty=0
  if [[ "$1" == "--allow-empty" ]]; then
    allow_empty=1
    shift
  fi
  local key="$1" value="$2"
  if [[ -n "$(env_get "$key")" ]]; then
    return 0
  fi
  if [[ "$allow_empty" -eq 1 ]] && grep -qE "^$key=" "$NOITE_DIR/.env"; then
    return 0
  fi
  env_set "$key" "$value"
  ENV_ADDED+=("$key")
}

# Like env_default, but a value matching compose.yaml's dev default (the glob
# in $3) counts as missing too: with it the runner refuses to boot on a real
# domain, so that install never served and nothing depends on the value.
env_secret() {
  local key="$1" value="$2" dev_glob="$3" current
  current=$(env_get "$key")
  # shellcheck disable=SC2053 # $dev_glob is a glob on purpose
  if [[ -n "$current" && "$current" == $dev_glob ]]; then
    env_set "$key" "$value"
    ENV_ADDED+=("$key")
    return 0
  fi
  env_default "$key" "$value"
}

# Everything the runner needs to boot on a real domain, with the defaults a
# fresh install writes; a value that is set is never touched. (No installer
# re-run exists: alpha builds are fresh-install only.) A localhost .env is a
# dev setup that compose.yaml's defaults already serve, so it is left alone.
ensure_env_defaults() {
  ENV_ADDED=()
  # A `localhost`-family .env is a dev setup that compose.yaml's defaults
  # already serve, so it is left alone.
  case "$DOMAIN" in
  localhost | *.localhost) return 0 ;;
  esac
  env_default BASE_DOMAIN "$DOMAIN"
  env_default --allow-empty CONTROL_SUBDOMAIN app
  local sub
  sub=$(env_get CONTROL_SUBDOMAIN)
  env_default BETTER_AUTH_URL "https://${sub:+$sub.}$DOMAIN"
  env_default GIT_PUBLIC_BASE "https://git.$DOMAIN"
  env_default HTTP_PORT 80
  env_default HTTPS_PORT 443
  env_secret RUNNER_TOKEN "$(rand_hex 32)" "dev-runner-token"
  env_secret BETTER_AUTH_SECRET "$(rand_hex 32)" "dev-*"
  env_secret RUSTFS_ACCESS_KEY "noite$(rand_hex 8)" "noiteaccess"
  env_secret RUSTFS_SECRET_KEY "$(rand_hex 24)" "noitesecretnoitesecretnoite12"
}
write_config() {
  step "Writing $NOITE_DIR"
  if [[ -f "$NOITE_DIR/.env" ]]; then
    die "Noite is already installed at $NOITE_DIR. Alpha builds do not upgrade between versions: uninstall it (this wipes its volumes) and run the installer again for a fresh install."
  fi
  mkdir -p "$NOITE_DIR"
  local url="https://raw.githubusercontent.com/$NOITE_REPO/$NOITE_REF/docker/compose.yaml" tmp
  tmp=$(mktemp)
  curl -fsSL "$url" -o "$tmp" || die "could not download $url"
  grep -q '^services:' "$tmp" || die "$url is not a compose file"
  install -m 0644 "$tmp" "$NOITE_DIR/compose.yaml"
  # The multi-tenant cgroup grant: referenced only when .env says
  # NOITE_TENANCY=multi (see compose()). Downloaded always; single installs
  # never reference it.
  url="https://raw.githubusercontent.com/$NOITE_REPO/$NOITE_REF/docker/compose.multi.yaml"
  curl -fsSL "$url" -o "$tmp" || die "could not download $url"
  grep -q 'apparmor' "$tmp" || die "$url is not the multi override"
  install -m 0644 "$tmp" "$NOITE_DIR/compose.multi.yaml"
  rm -f "$tmp"

  choose_domain
  umask 077
    cat >"$NOITE_DIR/.env" <<EOF
# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Every variable is
# documented in docker/compose.yaml and .env.example; apply changes with
#   cd $NOITE_DIR && docker compose up -d
# (multi installs add -f compose.yaml -f compose.multi.yaml to every
# recreating command)
#
# BASE_DOMAIN and BETTER_AUTH_URL are fixed once someone registers: passkeys
# bind to that origin. The RustFS keys guard the bundled bucket's data.
#
# Multi-tenant installs (letting other people push code) need
# NOITE_TENANCY=multi plus the cgroup grant: set it in the environment before
# the first install and the installer layers compose.multi.yaml on (single
# installs need nothing). Without the grant a multi install stays at 503 on
# /ready.
#NOITE_TENANCY=single
# Lost-passkey sign-in codes are POSTed to this webhook as JSON; without it
# nothing is emailed, and the operator recovers from the server with
#   cd $NOITE_DIR && docker compose exec noite noite-runner recover
# NOITE_EMAIL_WEBHOOK_URL=https://hooks.example.com/noite-otp
# NOITE_SMTP_FROM=Noite <no-reply@$DOMAIN>

EOF
  info "generating .env with fresh secrets (BASE_DOMAIN=$DOMAIN)"
  ensure_env_defaults
  env_set NOITE_IMAGE "$NOITE_IMAGE_REPO:$NOITE_VERSION"

  if [[ -n "${NOITE_ADMIN_EMAIL:-}" ]]; then
    env_set NOITE_ADMIN_EMAIL "$NOITE_ADMIN_EMAIL"
  fi
  if [[ -n "${NOITE_EMAIL_WEBHOOK_URL:-}" ]]; then
    env_set NOITE_EMAIL_WEBHOOK_URL "$NOITE_EMAIL_WEBHOOK_URL"
  fi
  if [[ -n "${NOITE_TELEMETRY:-}" ]]; then
    env_set NOITE_TELEMETRY "$NOITE_TELEMETRY"
  fi
  if [[ -n "${NOITE_UPDATE_CHECK:-}" ]]; then
    env_set NOITE_UPDATE_CHECK "$NOITE_UPDATE_CHECK"
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
  die "inspect with: cd $NOITE_DIR && docker compose $(compose_hint) logs -f noite"
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
  # Multi installs manage two compose files; every operator-run command below
  # must name both (empty on single installs).
  local files=""
  files=$(compose_hint)
  files=${files:+ $files}
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
  cd $NOITE_DIR && docker compose$files up -d

  Config       $NOITE_DIR/.env (keep it: it holds the secrets)
  Logs         cd $NOITE_DIR && docker compose$files logs -f
  $(recovery_note)
               either way, from this server: cd $NOITE_DIR && docker compose$files exec noite noite-runner recover
  Upgrade      none in place: alpha builds do not migrate data. Uninstall
               (this wipes the volumes), then run the installer again
  Docs         https://noite.now/self-hosting/install
EOF
}

# `run.sh` passes through whatever follows `install` (it consumes --pre
# itself, as NOITE_REF + NOITE_VERSION). The installer takes no flags.
parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      "") ;;
      *) warn "ignoring unknown argument \"$arg\" (the installer takes no flags)" ;;
    esac
  done
}

main() {
  parse_args "$@"
  check_system
  install_docker
  ensure_swap
  check_ports
  write_config
  open_firewall
  start_stack
  summary
}

main "$@"
