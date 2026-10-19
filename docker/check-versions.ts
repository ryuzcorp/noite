#!/usr/bin/env bun
/**
 * Pin guard for the one image (docker/Dockerfile) and its sidecars.
 *
 * - celld, Caddy (and its rate-limit module), Node and jup (with its tarball digest) are pinned exactly once (an ARG default); a second pin in
 *   the same file is how a stage silently builds against another version.
 * - The floating lines stay covered without freezing them: every oven/bun
 *   stage must agree on one line, and the rust line must appear exactly
 *   once — a split pin fails here instead of shipping mixed toolchains.
 * - The bundled store (rustfs) must match what platforms.mdx documents.
 * - Sidecar versions (esbuild, duckdb) live exactly once in
 *   docker/install-sidecars.sh; the Dockerfile only invokes the script.
 * - The access log path the image sets (CADDY_ACCESS_LOG) is the runner's own
 *   default, so the generator (which writes the Caddyfile `log` block from
 *   config) and the tailer read one file even when the ENV line is dropped.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), "utf-8");

const dockerfile = read("docker/Dockerfile");
const config = read("apps/runner/src/config.rs");

let failed = false;
const fail = (message: string): void => {
  console.error(message);
  failed = true;
};

for (const [name, pattern] of [
  ["celld", /ARG CELLD_VERSION=(?<version>\d+\.\d+\.\d+)/gu],
  ["caddy", /ARG CADDY_VERSION=(?<version>\d+\.\d+\.\d+)/gu],
  ["caddy-ratelimit", /ARG CADDY_RATELIMIT_VERSION=(?<version>[0-9a-f]{40})/gu],
  ["node", /ARG NODE_VERSION=(?<version>\d+\.\d+\.\d+)/gu],
  ["jup", /ARG JUP_VERSION=(?<version>\d+\.\d+\.\d+)/gu],
  ["jup digest", /ARG JUP_SHA512=(?<version>[0-9a-f]{128})/gu],
] as const) {
  const versions = [...dockerfile.matchAll(pattern)].map(
    (m) => m.groups?.version ?? ""
  );
  if (versions.length === 1) {
    console.log(`${name}: ${versions[0]}`);
  } else {
    fail(
      `${name}: docker/Dockerfile must pin exactly once (found ${versions.length}: ${versions.join(", ")})`
    );
  }
}

const imageLog = /CADDY_ACCESS_LOG=(?<sink>\S+)/u.exec(dockerfile)?.groups
  ?.sink;
const defaultLog =
  /"CADDY_ACCESS_LOG"\)\s*\.unwrap_or_else\(\|_\| "(?<sink>[^"]+)"/u.exec(
    config
  )?.groups?.sink;
if (!imageLog || !defaultLog) {
  fail(
    "access log: could not read CADDY_ACCESS_LOG from the Dockerfile or config.rs"
  );
} else if (imageLog === defaultLog) {
  console.log(`access log: ${imageLog}`);
} else {
  fail(
    `access log: image sets ${imageLog} but the runner defaults to ${defaultLog}`
  );
}

// The per-app build uid range lives in config.rs and is pre-created in the
// image's /etc/passwd (Node's os.userInfo() throws for a uid with no passwd
// entry). If the two drift, tenant Node tools fail on a perfectly valid uid.
const uidBase = /pub const BUILD_UID_BASE: u32 = (?<n>\d+)/u.exec(config)
  ?.groups?.n;
const uidRange = /pub const BUILD_UID_RANGE: u32 = (?<n>\d+)/u.exec(config)
  ?.groups?.n;
const uidSeq = /seq (?<lo>\d+) (?<hi>\d+)/u.exec(dockerfile)?.groups;
if (uidBase && uidRange && uidSeq) {
  const expectedHigh = Number(uidBase) + Number(uidRange) - 1;
  if (
    Number(uidSeq.lo) !== Number(uidBase) ||
    Number(uidSeq.hi) !== expectedHigh
  ) {
    fail(
      `build uid range: config.rs ${uidBase}..${expectedHigh} but the Dockerfile creates ${uidSeq.lo}..${uidSeq.hi}`
    );
  } else {
    console.log(`build uid range: ${uidBase}..${expectedHigh}`);
  }
} else {
  fail(
    "build uid range: could not read BUILD_UID_BASE/RANGE from config.rs or the seq from the Dockerfile"
  );
}
// Floating image lines: bun must agree across stages (ui-build on full
// debian, the runtime on slim), and the rust line must stay a single pin —
// neither may silently split into two versions.
const bunRefs = [
  ...dockerfile.matchAll(/oven\/bun:(?<version>[^-:\s]+)-/gu),
].map((m) => m.groups?.version ?? "");
if (bunRefs.length === 0) {
  fail("bun: no oven/bun image ref found in docker/Dockerfile");
} else if (bunRefs.every((v) => v === bunRefs[0])) {
  console.log(`bun: ${bunRefs[0]} (all stages)`);
} else {
  fail(`bun: stages disagree (${bunRefs.join(", ")}); pin one line everywhere`);
}
const rustRefs = [
  ...dockerfile.matchAll(/library\/rust:(?<version>[^-:\s]+)-bookworm/gu),
].map((m) => m.groups?.version ?? "");
if (rustRefs.length === 1) {
  console.log(`rust: ${rustRefs[0]}-bookworm`);
} else {
  fail(
    `rust: docker/Dockerfile must pin exactly once (found ${rustRefs.length}: ${rustRefs.join(", ")})`
  );
}
// The bundled store: compose.yaml must serve the version platforms.mdx
// documents, or installs and docs disagree about what runs.
const composeYaml = read("docker/compose.yaml");
const rustfsCompose = /rustfs\/rustfs:(?<version>[^\s"']+)/u.exec(composeYaml)
  ?.groups?.version;
const platformsDoc = read("apps/website/docs/self-hosting/platforms.mdx");
const rustfsDoc = /rustfs\/rustfs:(?<version>[0-9.]+)/u.exec(platformsDoc)
  ?.groups?.version;
if (!rustfsCompose || !rustfsDoc) {
  fail(
    "rustfs: could not read the image tag from compose.yaml or platforms.mdx"
  );
} else if (rustfsCompose === rustfsDoc) {
  console.log(`rustfs: ${rustfsCompose}`);
} else {
  fail(
    `rustfs: compose.yaml serves ${rustfsCompose} but platforms.mdx documents ${rustfsDoc}`
  );
}
// Sidecars (esbuild, duckdb): install-sidecars.sh is the single source of
// truth — each default must appear exactly once and be well-formed, and the
// Dockerfile must not carry its own version (it only invokes the script).
const sidecars = read("docker/install-sidecars.sh");
for (const name of ["ESBUILD_VERSION", "DUCKDB_VERSION"] as const) {
  const defaults = [
    ...sidecars.matchAll(
      new RegExp(`^${name}="\\$\\{${name}:-(?<v>[^}]+)\\}"`, "gmu")
    ),
  ].map((m) => m.groups?.v ?? "");
  if (defaults.length !== 1 || !/^\d+\.\d+\.\d+$/u.test(defaults[0] ?? "")) {
    fail(
      `${name}: install-sidecars.sh must default it exactly once to x.y.z (found: ${defaults.join(", ")})`
    );
  } else {
    console.log(`${name}: ${defaults[0]}`);
  }
  if (new RegExp(`\\b${name}=`, "u").test(dockerfile)) {
    fail(
      `${name}: docker/Dockerfile must not pin its own version (single source is install-sidecars.sh)`
    );
  }
}
if (!dockerfile.includes("install-sidecars.sh")) {
  fail("sidecars: docker/Dockerfile no longer invokes install-sidecars.sh");
}

if (failed) {
  process.exit(1);
}
