#!/usr/bin/env bun
// Version-pin drift guard: the celld version is pinned in several static
// formats (Dockerfile ARGs) that no tool reads jointly. This asserts they
// agree; run in CI (`check` job) and after any bump.
//
// rustfs + caddy are single-sourced now (compose `image:` refs), and
// esbuild/duckdb live only in docker/install-sidecars.sh — nothing to compare
// for any of them, so they have no group here.
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

const groups = {
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
if (failed) {
  process.exit(1);
}
