#!/usr/bin/env bun
// Version-pin drift guard: celld/rustfs versions are pinned in several
// static formats (Dockerfile ARGs, railpack image refs, compose image refs)
// that no tool reads jointly. This asserts they agree; run in CI (`check`
// job) and after any bump.
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
const celldImage = /celld:(?<version>\d+\.\d+\.\d+)/u;
const rustfsImage = /rustfs\/rustfs:(?<version>[\d.]+(?:-rc\.\d+)?)/u;

const groups = {
  celld: [
    { file: "Dockerfile.runner-container", pattern: celldArg },
    { file: "docker/Dockerfile.runner-dev", pattern: celldArg },
    { file: "docker/Dockerfile.tools", pattern: celldArg },
    { file: "railpack.json", pattern: celldImage },
  ],
  rustfs: [
    { file: "Dockerfile.runner-container", pattern: rustfsImage },
    { file: "docker/compose.yaml", pattern: rustfsImage },
    { file: "railpack.json", pattern: rustfsImage },
  ],
  // NOTE: caddy/esbuild/duckdb are single-sourced (Dockerfile.caddy FROM,
  // install-sidecars.sh) — nothing to compare, so no group here.
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
if (failed) {
  process.exit(1);
}
