#!/usr/bin/env bun
// Version-pin drift guard: the celld version is pinned in several static
// formats (Dockerfile ARGs) that no tool reads jointly. This asserts they
// agree; run in CI (`check` job) and after any bump.
//
// rustfs is single-sourced (a compose `image:` ref), and esbuild/duckdb live
// only in docker/install-sidecars.sh — nothing to compare for any of them, so
// they have no group here. Caddy is pinned in three places (both compose files
// and the single-container edge image, which installs the release tarball), and
// separately its access-log sink is fixed by the generator while the tailer
// follows CADDY_ACCESS_LOG, so both are asserted below.
import { readFileSync } from "node:fs";
import path from "node:path";

const root = new URL("../", import.meta.url).pathname;
const read = (rel: string): string =>
  readFileSync(path.join(root, rel), "utf-8");

interface Source {
  file: string;
  pattern: RegExp;
}

const celldArg = /ARG CELLD_VERSION=(?<version>\d+\.\d+\.\d+)/u;
const caddyArg = /ARG CADDY_VERSION=(?<version>\d+\.\d+\.\d+)/u;
// `docker.io/library/caddy:2.10.0-alpine` in both compose files.
const caddyImage = /caddy:(?<version>\d+\.\d+\.\d+)/u;

const groups = {
  caddy: [
    { file: "docker/compose.yaml", pattern: caddyImage },
    { file: "docker/compose.standalone.yaml", pattern: caddyImage },
    { file: "docker/Dockerfile.edge", pattern: caddyArg },
  ],
  celld: [
    { file: "docker/Dockerfile.runner", pattern: celldArg },
    { file: "docker/Dockerfile.ui", pattern: celldArg },
    { file: "docker/Dockerfile.runner-dev", pattern: celldArg },
    { file: "docker/Dockerfile.tools", pattern: celldArg },
  ],
} satisfies Record<string, Source[]>;

let failed = false;
for (const [name, sources] of Object.entries(groups)) {
  const found = new Map<string, string[]>();
  for (const source of sources) {
    const versions = [
      ...new Set(
        [
          ...read(source.file).matchAll(
            new RegExp(source.pattern.source, `${source.pattern.flags}g`)
          ),
        ].map((m) => m.groups?.version ?? "")
      ),
    ];
    const [first] = versions;
    if (versions.length !== 1 || first === "" || first === undefined) {
      console.error(
        `${name}: ${source.file} has ${versions.length === 0 ? "no" : "multiple"} pin(s) (${versions.join(", ")})`
      );
      failed = true;
      continue;
    }
    found.set(first, [...(found.get(first) ?? []), source.file]);
  }
  if (found.size > 1) {
    console.error(`${name} version skew:`);
    for (const [version, files] of found) {
      console.error(`  ${version}: ${files.join(", ")}`);
    }
    failed = true;
  } else if (found.size === 1) {
    console.log(`${name}: ${[...found.keys()][0]}`);
  }
}
// Caddy's access-log sink is hardcoded by the generator while the tailer
// follows CADDY_ACCESS_LOG. In the single-container edge image they must name
// one file, or caddy writes a file nobody reads and every analytics panel
// stays empty — no error, no log line, just no rows. Compose is deliberately
// exempt: there the shared caddy-config volume is mounted at /etc/caddy in
// caddy and at /caddy in the runner, so the two values legitimately differ.
const accessLogSources = [
  {
    file: "docker/Dockerfile.edge",
    pattern: /^\s*CADDY_ACCESS_LOG=(?<sink>\S+)/mu,
  },
  {
    file: "apps/runner/src/host/caddy.rs",
    pattern: /output file (?<sink>[^\s"]+)/u,
  },
];
const accessLogPaths = accessLogSources.map(({ file, pattern }) => ({
  file,
  sink: pattern.exec(read(file))?.groups?.sink ?? "",
}));
const sinks = new Set(accessLogPaths.map((entry) => entry.sink));
if (sinks.size !== 1 || sinks.has("")) {
  console.error("caddy access log path skew:");
  for (const { file, sink } of accessLogPaths) {
    console.error(`  ${file}: ${sink === "" ? "<not found>" : sink}`);
  }
  failed = true;
} else {
  console.log(`caddy access log: ${[...sinks][0]}`);
}
if (failed) {
  process.exit(1);
}
