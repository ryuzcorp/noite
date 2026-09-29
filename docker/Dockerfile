# syntax=docker/dockerfile:1
# THE Noite image (SPEC, Image): `ghcr.io/<owner>/noite`, the whole
# install in one container. The runner is PID 1 (under tini) and owns every
# other process:
#
#   runner (uid 0, tini)  deploy pipeline, API, git, reconcile, telemetry
#   ├── caddy             edge: TLS, routing (admin 127.0.0.1:2019)
#   ├── celld             control UI, fleet #0 (127.0.0.1:8090)
#   ├── celld × N         tenant fleets (uid 10020)
#   └── bun / node / sh   tenant builds and release commands (uid 10010)
#
# Targets:
#   noite (default)  the published image
#   dev              `make dev`: same runtime plus the Rust toolchain,
#                    cargo-watch; sources are bind-mounted and
#                    docker/dev.sh runs the runner (cargo watch) and the
#                    control UI (vite dev) side by side.
#
# One celld, one Caddy, one Node and one bun pin; docker/check-versions.ts
# asserts they appear exactly once. Sidecar versions (esbuild, duckdb) live in
# docker/install-sidecars.sh.
ARG CELLD_VERSION=0.6.0
ARG CADDY_VERSION=2.10.0
ARG NODE_VERSION=24.21.0

FROM ghcr.io/denoland/celld:${CELLD_VERSION} AS celld

# --- runner binary ----------------------------------------------------------
FROM docker.io/library/rust:1-bookworm AS runner-build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
COPY apps/runner/Cargo.toml apps/runner/Cargo.lock ./
COPY apps/runner/src ./src
# schema.sql is `include_str!`-embedded: needed to build, never shipped.
COPY apps/runner/schema.sql ./schema.sql
RUN cargo build --release && strip target/release/noite-runner

# --- control UI bundle ------------------------------------------------------
# bun install runs inside the image, so the lockfile is the only input that
# pins UI deps. The ignore file keeps .dev.vars out of the context: a
# build-time secret would otherwise be baked into the deployed worker vars.
FROM docker.io/oven/bun:1.3-debian AS ui-build
WORKDIR /app
COPY apps/noite/package.json apps/noite/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/noite/ ./
RUN bun run build \
  && rm -f dist/.dev.vars dist/.dev.vars.* dist/ssr/.dev.vars dist/ssr/.dev.vars.* \
  && find dist -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1 >dist/REVISION

 # --- runtime shared by `noite` and `dev` -----------------------------------
 # Runtime base is the slim variant (T6.3): ui-build stays on full debian
 # (build tools); the runtime only needs bun + apt-installed bins.
FROM docker.io/oven/bun:1.3-slim AS base
LABEL org.opencontainers.image.licenses="Apache-2.0"
ARG TARGETARCH
ARG CADDY_VERSION
ARG NODE_VERSION
# bun: tenant `bun install` / builds. node: real Node (not bun's shim) for
# tenant steps that need it, e.g. loading `cloudflare.config.ts` (the `cf`
# CLI config needs Node's module hooks); only the binary, no npm.
# nftables: the tenant egress policy (SPEC, Egress policy). git: the Git
# smart-HTTP adapter and deploy worktrees. S3 goes through the runner's
# native client (no awscli, no Python).
COPY docker/install-sidecars.sh /tmp/install-sidecars.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl git nftables unzip xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && sh /tmp/install-sidecars.sh && rm /tmp/install-sidecars.sh \
  && arch="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy \
  && caddy version \
  && case "${arch}" in \
       amd64) NODE_PKG=linux-x64 ;; \
       arm64) NODE_PKG=linux-arm64 ;; \
       *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_PKG}.tar.xz" \
    | tar -xJ --no-same-owner -C /usr/local --strip-components=1 "node-v${NODE_VERSION}-${NODE_PKG}/bin/node" \
  && node --version | grep -q "^v${NODE_VERSION%%.*}"
# Sandbox users (SPEC, Tenant isolation): builds and release commands run as `build`,
# tenant fleets as `fleet`; the nft policy keys on these uids.
RUN useradd -u 10010 -m -s /bin/sh build \
  && useradd -u 10020 -m -s /bin/sh fleet \
  && mkdir -p /data /opt/noite/control
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
# Apache-2.0 §4(a): a distributed image carries a copy of the License.
COPY LICENSE /licenses/
WORKDIR /data
# Everything the edge proxies to lives in this container (tenant fleets,
# control on 127.0.0.1:8090, the runner API on 127.0.0.1:8080); the runner
# hardcodes those upstreams. These are the paths it reads and writes.
ENV RUNNER_BIND=0.0.0.0:8080 \
    PATH="/usr/local/bin:${PATH}" \
    CELLD_ESBUILD=/usr/local/bin/esbuild \
    NOITE_DB=/data/noite.sqlite \
    RUNNER_WORK_DIR=/data/runner \
    CONTROL_BUNDLE_DIR=/opt/noite/control/dist \
    CADDYFILE_PATH=/data/caddy/Caddyfile \
    CADDY_ACCESS_LOG=/data/caddy/access.log \
    CADDY_ADMIN_URL=http://127.0.0.1:2019 \
    NOITE_FLEET_PORTS=20000-29999
VOLUME /data
EXPOSE 80 443

# --- dev --------------------------------------------------------------------
FROM base AS dev
# The Rust toolchain + cargo-watch for the runner (vite dev runs on base's
# Node). No baked runner or bundle: the sources are bind-mounted
# (docker/compose.dev.yaml).
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev gcc libc6-dev inotify-tools \
  && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH="/usr/local/cargo/bin:/usr/local/bin:${PATH}" \
    CARGO_TERM_COLOR=always
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path \
  && cargo install cargo-watch --locked
# No control bundle in dev: the runner skips fleet #0 and vite dev serves the
# UI on the same 127.0.0.1:8090.
ENV CONTROL_BUNDLE_DIR=/nonexistent
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bin/sh", "/opt/noite/dev.sh"]

# --- the published image (default target: last stage) ----------------------
FROM base AS noite
COPY --from=runner-build /src/target/release/noite-runner /usr/local/bin/noite-runner
COPY --from=ui-build /app/dist /opt/noite/control/dist
ENTRYPOINT ["/usr/bin/tini", "--", "noite-runner"]
