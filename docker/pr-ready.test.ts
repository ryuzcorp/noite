import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectAreas, matchSensitive, parseSensitiveGlobs } from "./pr-ready";

describe("detectAreas", () => {
  test("maps paths to runner, ui, cli, docs and workflows areas", () => {
    const areas = detectAreas([
      "apps/runner/src/main.rs",
      "apps/noite/src/pages/index.tsx",
      "packages/cli/src/index.ts",
      "apps/website/docs/self-hosting/telemetry.mdx",
      "docker/check-changelog.ts",
      ".github/workflows/check.yml",
      "SPEC.md",
    ]);

    expect(areas.runner).toEqual(["apps/runner/src/main.rs"]);
    expect(areas.ui).toEqual(["apps/noite/src/pages/index.tsx"]);
    expect(areas.cli).toEqual(["packages/cli/src/index.ts"]);
    expect(areas.docs).toEqual([
      "apps/website/docs/self-hosting/telemetry.mdx",
      "SPEC.md",
    ]);
    expect(areas.workflows).toEqual([
      "docker/check-changelog.ts",
      ".github/workflows/check.yml",
    ]);
    expect(areas.other).toEqual([]);
  });

  test("sends unknown paths to other", () => {
    expect(detectAreas(["scripts/scratch.sh"]).other).toEqual([
      "scripts/scratch.sh",
    ]);
  });

  test("treats changelog entries as docs, not runtime code", () => {
    const areas = detectAreas(["CHANGELOG.md", "changelog.d/topic.md"]);
    expect(areas.docs).toEqual(["CHANGELOG.md", "changelog.d/topic.md"]);
    expect(areas.runner).toEqual([]);
    expect(areas.ui).toEqual([]);
    expect(areas.cli).toEqual([]);
  });
});

describe("parseSensitiveGlobs", () => {
  test("reads the top-level sensitive list, stripping quotes and comments", () => {
    const globs = parseSensitiveGlobs(
      `# comment\nsensitive:\n  - 'apps/runner/src/host/**' # keep\n  - "edge/**"\n  - docker/Dockerfile\n`
    );

    expect(globs).toEqual([
      "apps/runner/src/host/**",
      "edge/**",
      "docker/Dockerfile",
    ]);
  });

  test("returns an empty list when the key is absent", () => {
    expect(parseSensitiveGlobs("other:\n  - x\n")).toEqual([]);
    expect(parseSensitiveGlobs("")).toEqual([]);
  });
});

describe("matchSensitive", () => {
  const patterns = ["apps/runner/src/host/**", "edge/**"];

  test("matches globbed paths, including dotfiles", () => {
    expect(
      matchSensitive(
        ["apps/runner/src/host/exec.rs", "apps/noite/src/x.ts"],
        patterns
      )
    ).toEqual(["apps/runner/src/host/exec.rs"]);
  });

  test("supports `!` negations", () => {
    expect(
      matchSensitive(
        ["apps/runner/src/host/exec.rs", "edge/foo.go"],
        ["apps/**", "!apps/noite/**", "!edge/**"]
      )
    ).toEqual(["apps/runner/src/host/exec.rs"]);
  });

  test("empty pattern list matches nothing", () => {
    expect(matchSensitive(["apps/runner/src/host/exec.rs"], [])).toEqual([]);
  });

  test("the shipped list covers every file in the edge module", () => {
    const yaml = readFileSync(
      new URL("../.github/security-paths.yml", import.meta.url),
      "utf-8"
    );

    const globs = parseSensitiveGlobs(yaml);
    const edgeRoot = fileURLToPath(new URL("../edge/", import.meta.url));

    // Enumerate the real module: a renamed or split-out file must fail here,
    // not silently drop out of the gate.
    const files = readdirSync(edgeRoot, { recursive: true })
      .map((name) => `edge/${name.toString().replaceAll(path.sep, "/")}`)
      .filter((file) => statSync(path.join(edgeRoot, "..", file)).isFile());

    expect(files.length).toBeGreaterThan(0);
    expect(matchSensitive(files, globs)).toEqual(files);
    expect(
      matchSensitive(["apps/runner/src/host/edge_table.rs"], globs)
    ).toEqual(["apps/runner/src/host/edge_table.rs"]);
    expect(matchSensitive(["apps/runner/src/host/caddy.rs"], globs)).toEqual([
      "apps/runner/src/host/caddy.rs",
    ]);
  });
});
