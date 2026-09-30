#!/usr/bin/env bun
/**
 * Pin guard for the one image (docker/Dockerfile).
 *
 * - celld, Caddy, Node and jup (with its tarball digest) are pinned exactly once (an ARG default); a second pin in
 *   the same file is how a stage silently builds against another version.
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

if (failed) {
  process.exit(1);
}
