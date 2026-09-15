# syntax=docker/dockerfile:1
ARG CELLD_VERSION=0.4.1
ARG ESBUILD_VERSION=0.25.12

FROM ghcr.io/denoland/celld:${CELLD_VERSION} AS celld

FROM docker.io/library/rust:1-bookworm AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release && strip target/release/noite-runner

FROM docker.io/oven/bun:1.3-debian
ARG TARGETARCH
ARG ESBUILD_VERSION=0.25.12
ARG DUCKDB_VERSION=1.5.5
ARG DUCKDB_VERSION_AARCH64=1.2.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git awscli unzip \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH}" in \
       amd64) ESBUILD_PKG=linux-x64; DUCKDB_ZIP=duckdb_cli-linux-amd64.zip; DUCKDB_VER=${DUCKDB_VERSION} ;; \
       arm64) ESBUILD_PKG=linux-arm64; DUCKDB_ZIP=duckdb_cli-linux-aarch64.zip; DUCKDB_VER=${DUCKDB_VERSION_AARCH64} ;; \
       *) echo "unsupported arch: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://registry.npmjs.org/@esbuild/${ESBUILD_PKG}/-/${ESBUILD_PKG}-${ESBUILD_VERSION}.tgz" \
    | tar -xz -C /tmp \
  && install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild \
  && rm -rf /tmp/package \
  && curl -fsSL "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VER}/${DUCKDB_ZIP}" -o /tmp/duckdb.zip \
  && unzip -qo /tmp/duckdb.zip -d /usr/local/bin \
  && rm -f /tmp/duckdb.zip
COPY --from=celld /usr/local/bin/celld /usr/local/bin/celld
COPY --from=build /src/target/release/noite-runner /usr/local/bin/noite-runner
WORKDIR /data
ENV RUNNER_BIND=0.0.0.0:8080 \
    PATH="/usr/local/bin:${PATH}" \
    CELLD_ESBUILD=/usr/local/bin/esbuild
EXPOSE 8080
CMD ["noite-runner"]
