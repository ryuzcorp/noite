import { describe, expect, test } from "bun:test";

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
});
