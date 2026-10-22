# syntax=docker/dockerfile:1
# THE Noite image (SPEC, Image): `ghcr.io/<owner>/noite`, the whole
# install in one container. The runner is PID 1 (under tini) and owns every
# other process:
#
#   runner (uid 0, tini)  deploy pipeline, API, git, reconcile, telemetry
#   ├── caddy             edge: TLS, routing (admin 127.0.0.1:2019)
#   ├── celld             control UI, fleet #0 (127.0.0.1:8090)
#   ├── celld × N         tenant fleets (uid 10020)
#   └── bun / node / sh   tenant builds and release commands (uid 10030+, one per app)
#
# Targets:
#   noite (default)  the published image
#   dev              `make dev`: same runtime plus the Rust toolchain,
#                    cargo-watch; sources are bind-mounted and
#                    docker/dev.sh runs the runner (cargo watch) and the
#                    control UI (vite dev) side by side.
#
# One celld, one Caddy, one Node, one jup, one npm, one pnpm and one bun pin;
# docker/check-versions.ts asserts they appear exactly once. Sidecar versions
# (esbuild, duckdb) live in docker/install-sidecars.sh.
ARG CELLD_VERSION=0.6.2
# Noite's own release version, reported by the instance heartbeat
# (`NOITE_BUILD_VERSION` ENV in the runtime stages): the tag without `v` on a
# release build (images.yml passes it), `dev` otherwise.
ARG NOITE_BUILD_VERSION=dev
ARG CADDY_VERSION=2.11.7
# The edge route-table module (edge/, handler `http.handlers.edge_routes`):
# a local path, so no version pin — but its go.mod must require exactly
# CADDY_VERSION above (docker/check-versions.ts asserts it), or Go's
# minimum version selection would silently raise the Caddy xcaddy builds.
ARG NODE_VERSION=24.22.0
# jup (https://github.com/unjs/jup) runs the tenant's npm, pnpm or Yarn at
# the version the project pins. The npm tarball's sha512, as hex.
ARG JUP_VERSION=0.6.5
ARG JUP_SHA512=85297de2f655be9f7a98fdc3b59182eb5fe7d9b3315bc1e5858d91b5047a9e74ecbaaddc9b446714e37c3d7c40abb65ef9e63ab1eb7ae1a688dfa5f3f28fb2cf
# npm and pnpm bundled for unpinned tenant projects (SPEC, Package managers):
# exact releases, with the registry tarballs' sha512 as hex. Bumping is an
# image release: the runner's BUNDLED_*_VERSION consts must name the same
# releases (docker/check-versions.ts asserts it).
ARG NPM_VERSION=12.2.1
ARG NPM_SHA512=6ca0a6151553fc107e60f1186d9c10d57508dcde6de31292a54d4cc4e8e8ef3de25b3281274657442d7115d10df930bb3794ddcb0681cdfd9d317189abf7b63d
ARG PNPM_VERSION=12.15.0
ARG PNPM_SHA512=b3951d6d6ff4a9f13dc7cf56cd28d2b8eb37dbcc9c68e52e1e1191873ea9f82a017287ab50baadc5ccc494f036c67c0e47eb13608c2fa36f47711b61ea128e61

FROM ghcr.io/denoland/celld:${CELLD_VERSION} AS celld

 # --- Caddy with the edge route-table module ----------------------------------
 # Built on the build host's platform and cross-compiled for the target, so an
 # arm64 image does not run the Go toolchain under emulation.
 # The builder image's own CADDY_VERSION env (v-prefixed, from the tag above)
 # is the version xcaddy builds.
 FROM --platform=$BUILDPLATFORM docker.io/library/caddy:${CADDY_VERSION}-builder AS caddy-build
 ARG TARGETOS
 ARG TARGETARCH
 # The builder image is golang-based, so the module's own tests run here and
 # the image job covers them (`go vet`, formatting, `go test -race`). The
 # race detector needs a C compiler the builder image does not carry.
 COPY edge /edge
 RUN apk add --no-cache gcc musl-dev \
     && cd /edge && go vet ./... && test -z "$(gofmt -l .)" && CGO_ENABLED=1 go test -race ./...
 RUN GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" CGO_ENABLED=0 xcaddy build \
       --with "github.com/ryuzcorp/noite/edge=/edge" \
       --output /out/caddy

# The pinned Node's binary, for the ui-build stage below (`COPY --from` cannot
# expand variables, so the pin lives in a stage of its own).
FROM docker.io/library/node:${NODE_VERSION}-slim AS node

# --- runner binary ----------------------------------------------------------
FROM docker.io/library/rust:1-bookworm AS runner-build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
COPY apps/runner/Cargo.toml apps/runner/Cargo.lock ./
COPY apps/runner/src ./src
# The schemas are `include_str!`-embedded: needed to build, never shipped.
COPY apps/runner/schema.sql apps/runner/schema.metrics.sql ./
# Cache mounts keep the crate registry and target/ between builds, so a source
# change recompiles the runner crate only, not every dependency. They never
# reach the image: the binary is copied out of the mount, and `--locked`
# still builds exactly what Cargo.lock pins.
RUN --mount=type=cache,id=noite-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=noite-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=noite-runner-target,target=/src/target,sharing=locked \
    cargo build --release --locked \
  && install -D -m 0755 target/release/noite-runner /out/noite-runner \
  && strip /out/noite-runner

# --- control UI bundle ------------------------------------------------------
# bun install runs inside the image, so the lockfile is the only input that
# pins UI deps. The ignore file keeps .dev.vars out of the context: a
# build-time secret would otherwise be baked into the deployed worker vars.
# vite runs under real Node (bun run honours the `node` shebang when a node is
# on PATH): vite.config.ts loads cloudflare.config.ts through @cloudflare/config,
# which refuses Bun. Only the binary is copied, from the pinned Node version.
FROM docker.io/oven/bun:1.4-debian AS ui-build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY apps/noite/package.json apps/noite/bun.lock ./
COPY apps/noite/patches/ ./patches/
# The package cache only saves downloads; `--frozen-lockfile` still checks
# every package against the lockfile's integrity hashes.
RUN --mount=type=cache,id=noite-bun-cache,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile
COPY apps/noite/ ./
RUN bun run build \
  && rm -f dist/.dev.vars dist/.dev.vars.* dist/ssr/.dev.vars dist/ssr/.dev.vars.* \
  && find dist -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1 >dist/REVISION

 # --- runtime shared by `noite` and `dev` -----------------------------------
 # Runtime base is the slim variant (T6.3): ui-build stays on full debian
 # (build tools); the runtime only needs bun + apt-installed bins.
FROM docker.io/oven/bun:1.4-slim AS base
LABEL org.opencontainers.image.licenses="Apache-2.0"
ARG TARGETARCH
ARG NODE_VERSION
ARG JUP_VERSION
ARG JUP_SHA512
ARG NPM_VERSION
ARG NPM_SHA512
ARG PNPM_VERSION
ARG PNPM_SHA512
# Re-declared so they can be read after FROM: the global defaults (or the
# --build-arg values) are what the ENV block below bakes in.
ARG CELLD_VERSION
ARG NOITE_BUILD_VERSION
# bun: tenant `bun install` / builds. node: real Node (not bun's shim) for
# tenant steps that need it, e.g. loading `cloudflare.config.ts` (the `cf`
# CLI config needs Node's module hooks); only the binary, no npm. jup:
# npm, pnpm and Yarn for tenants that use them: Yarn downloads per app, but
# npm and pnpm ship in `/opt/jup-bundled` at the pinned releases and the
# runner seeds each app's JUP_HOME from it, so unpinned projects never touch
# the registry for the manager itself (SPEC, Package managers); plain JS on
# that Node.
# nftables: the tenant egress policy (SPEC, Egress policy). git: the Git
# smart-HTTP adapter and deploy worktrees. S3 goes through the runner's
# native client (no awscli, no Python).
COPY docker/install-sidecars.sh /tmp/install-sidecars.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl git nftables unzip xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && sh /tmp/install-sidecars.sh && rm /tmp/install-sidecars.sh \
  && arch="$(dpkg --print-architecture)" \
  && case "${arch}" in \
       amd64) NODE_PKG=linux-x64 ;; \
       arm64) NODE_PKG=linux-arm64 ;; \
       *) echo "unsupported arch: ${arch}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_PKG}.tar.xz" \
    | tar -xJ --no-same-owner -C /usr/local --strip-components=1 "node-v${NODE_VERSION}-${NODE_PKG}/bin/node" \
  && node --version | grep -q "^v${NODE_VERSION%%.*}" \
  && curl -fsSL -o /tmp/jup.tgz "https://registry.npmjs.org/jup/-/jup-${JUP_VERSION}.tgz" \
  && echo "${JUP_SHA512}  /tmp/jup.tgz" | sha512sum -c - \
  && mkdir -p /opt/jup && tar -xzf /tmp/jup.tgz --no-same-owner -C /opt/jup --strip-components=1 \
  && rm /tmp/jup.tgz \
  && ln -s /opt/jup/bin/jup.mjs /usr/local/bin/jup \
  && jup --version \
  && JUP_HOME=/tmp/jup-home jup enable --install-directory /usr/local/bin npm pnpm yarn \
  && rm -rf /tmp/jup-home \
  && curl -fsSL -o /tmp/npm.tgz "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" \
  && echo "${NPM_SHA512}  /tmp/npm.tgz" | sha512sum -c - \
  && curl -fsSL -o /tmp/pnpm.tgz "https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz" \
  && echo "${PNPM_SHA512}  /tmp/pnpm.tgz" | sha512sum -c - \
  && rm /tmp/npm.tgz /tmp/pnpm.tgz \
  && JUP_HOME=/opt/jup-bundled jup cache install -g --cache-only "npm@${NPM_VERSION}" "pnpm@${PNPM_VERSION}" \
  && chmod -R a+rX /opt/jup-bundled
# The bundled-manager guarantee, checked at build time: a fresh JUP_HOME
# seeded the way the runner seeds each app, with every network path dead,
# runs the bundled releases. If jup ever lays out its store differently or
# needs the registry for an installed exact version, the build fails here.
RUN set -eu; \
    mkdir -p /tmp/bundled-check/work; \
    printf '{"name":"check"}\n' > /tmp/bundled-check/work/package.json; \
    for spec in "pnpm:${PNPM_VERSION}" "npm:${NPM_VERSION}"; do \
      name="${spec%%:*}"; version="${spec##*:}"; \
      printf '{"devEngines":{"packageManager":{"name":"%s","version":"%s"}}}\n' "$name" "$version" > "/tmp/bundled-check/spec-$name.json"; \
      rm -rf "/tmp/bundled-check/home-$name"; \
      mkdir -p "/tmp/bundled-check/home-$name/jup/v1/$name"; \
      cp -r "/opt/jup-bundled/v1/$name/$version" "/tmp/bundled-check/home-$name/jup/v1/$name/"; \
      (cd /tmp/bundled-check/work && \
        HOME="/tmp/bundled-check/home-$name" JUP_HOME="/tmp/bundled-check/home-$name/jup" \
        JUP_SPEC_FILE="/tmp/bundled-check/spec-$name.json" \
        JUP_ENABLE_AUTO_PIN=0 JUP_QUIET_ADVISORIES=1 \
        HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 \
        ALL_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 \
        "$name" --version | grep -qx "$version"); \
    done; \
    rm -rf /tmp/bundled-check
# Sandbox users (SPEC, Tenant isolation): tenant fleets run as `fleet`; each
# app's builds and release commands run as their own uid from the reserved
# per-app range (RUNNER_BUILD_UID_BASE=10030, RUNNER_BUILD_UID_RANGE=1024 in
# apps/runner/src/config.rs), which the nft policy closes off as one range.
# The runner assigns those uids numerically — setuid/setgid needs no passwd
# entry — but the range is pre-created here because Node's os.userInfo()
# throws for a uid with no /etc/passwd entry, which would break npm/pnpm/Yarn
# and any Node-based tenant step. Keep the range in step with config.rs.
RUN useradd -u 10020 -m -s /bin/sh fleet \
  && for uid in $(seq 10030 11053); do \
       echo "noite-build-${uid}:x:${uid}:${uid}::/data/runner:/bin/sh" >> /etc/passwd; \
       echo "noite-build-${uid}:x:${uid}:" >> /etc/group; \
     done \
  && mkdir -p /data /opt/noite/control
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=caddy-build /out/caddy /usr/local/bin/caddy
RUN caddy version && caddy list-modules | grep -qx 'http.handlers.edge_routes'
# Apache-2.0 §4(a): a distributed image carries a copy of the License, and
# §4(d) its NOTICE (third-party attributions, e.g. the bundled Nodepod).
COPY LICENSE NOTICE /licenses/
WORKDIR /data
# Everything the edge proxies to lives in this container (tenant fleets,
# control on 127.0.0.1:8090, the runner API on 127.0.0.1:8080); the runner
# hardcodes those upstreams. These are the paths it reads and writes.
ENV RUNNER_BIND=0.0.0.0:8080 \
    PATH="/usr/local/bin:${PATH}" \
    CELLD_ESBUILD=/usr/local/bin/esbuild \
    NOITE_BUILD_VERSION="${NOITE_BUILD_VERSION}" \
    CELLD_VERSION="${CELLD_VERSION}" \
    NOITE_DB=/data/noite.sqlite \
    RUNNER_WORK_DIR=/data/runner \
    CONTROL_BUNDLE_DIR=/opt/noite/control/dist \
    CADDYFILE_PATH=/data/caddy/Caddyfile \
    CADDY_ROUTES_PATH=/data/caddy/routes.json \
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
COPY --from=runner-build /out/noite-runner /usr/local/bin/noite-runner
COPY --from=ui-build /app/dist /opt/noite/control/dist
ENTRYPOINT ["/usr/bin/tini", "--", "noite-runner"]
