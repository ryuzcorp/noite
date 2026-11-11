import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import picomatch from "picomatch";

import { detectAreas, matchSensitive, parseSensitiveGlobs } from "./pr-ready";

const root = fileURLToPath(new URL("../", import.meta.url));

const readRepoFile = (rel: string): string =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

/** List items indented under `lines[start]`, stopping at the next sibling. */
const globsBelow = (lines: string[], start: number): string[] => {
  const baseIndent = indentOf(lines[start]);
  const globs: string[] = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      continue;
    }

    if (indentOf(line) <= baseIndent) {
      break;
    }

    const item = /^\s*-\s+(?<glob>.+?)\s*$/u.exec(line)?.groups?.glob;

    if (item) {
      globs.push(item.replaceAll(/^['"]|['"]$/gu, ""));
    }
  }

  return globs;
};

/** Glob list items directly under the first line matching `anchor`. */
const globsAfter = (yaml: string, anchor: RegExp): string[] => {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => anchor.test(line));

  if (start === -1) {
    throw new Error(`no line matches ${anchor}`);
  }

  return globsBelow(lines, start);
};

/** The `code:` globs inside the `filters: |` block of `ci.yml`. */
const codeFilterGlobs = (yaml: string): string[] => {
  const lines = yaml.split("\n");
  const filters = lines.findIndex((line) => /^\s*filters: \|\s*$/u.test(line));

  if (filters === -1) {
    throw new Error("ci.yml has no filters block");
  }

  const code = lines.findIndex(
    (line, index) => index > filters && /^\s+code:\s*$/u.test(line)
  );

  if (code === -1) {
    throw new Error("ci.yml has no code filter");
  }

  return globsBelow(lines, code);
};

/** Every build-context source `docker/Dockerfile` copies in, in order. */
const dockerfileCopySources = (dockerfile: string): string[] =>
  dockerfile.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u);

    // `COPY --from=<stage>` reads another stage, never the build context.
    if (
      fields[0] !== "COPY" ||
      fields.slice(1).some((f) => f.startsWith("--"))
    ) {
      return [];
    }

    // Last field is the destination; the rest are context sources.
    return fields.slice(1, -1);
  });

/** Git-tracked files under `source`, so a directory is checked as a whole. */
const trackedFiles = (source: string): string[] =>
  execFileSync("git", ["ls-files", "--", source], {
    cwd: root,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);

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

  test("the shipped list covers the trust-boundary files that decide auth and hostnames", () => {
    const yaml = readRepoFile(".github/security-paths.yml");
    const globs = parseSensitiveGlobs(yaml);

    const files = [
      "apps/runner/src/lifecycle.rs",
      "apps/runner/src/service/domains.rs",
      "apps/runner/src/dns.rs",
      "apps/runner/src/host/env_label.rs",
      "apps/runner/src/service/environments.rs",
      "apps/noite/src/lib/collaborators.ts",
      "apps/noite/src/lib/server/collaborators.server.ts",
      "apps/noite/src/lib/roles.ts",
      "apps/noite/src/lib/membership.ts",
      "apps/noite/src/lib/server/api-keys.server.ts",
      "apps/noite/src/lib/server/mcp-auth.server.ts",
      "apps/noite/src/http/routes/internal.ts",
      "apps/noite/src/lib/server/recovery.server.ts",
    ];

    // A renamed file must fail here instead of silently leaving the gate.
    for (const file of files) {
      expect(existsSync(path.join(root, file)), `${file} is missing`).toBe(
        true
      );
    }

    expect(matchSensitive(files, globs)).toEqual(files);
  });
});

describe("image build context coverage", () => {
  const dockerfile = readRepoFile("docker/Dockerfile");
  const sources = dockerfileCopySources(dockerfile);

  const imagePaths = globsAfter(
    readRepoFile(".github/workflows/images.yml"),
    /^\s*paths:\s*$/u
  );

  const codePaths = codeFilterGlobs(readRepoFile(".github/workflows/ci.yml"));

  test("parses the context sources of every build stage", () => {
    expect(sources).toContain("edge");
    expect(sources).toContain("apps/void-proxy/src");
    expect(sources).toContain("apps/void-sandbox/package.json");
    expect(sources).toContain("LICENSE");
    expect(sources).toContain("NOTICE");
    // `COPY --from=<stage>` sources are outputs, not build context.
    expect(sources).not.toContain("/out/caddy");
    expect(sources).not.toContain("/usr/local/bin/node");
  });

  test("every copied source is covered by both gate filters", () => {
    for (const source of sources) {
      const files = trackedFiles(source);
      expect(files.length, `${source} has no tracked files`).toBeGreaterThan(0);

      for (const [filter, globs] of [
        ["images.yml push paths", imagePaths],
        ["ci.yml code filter", codePaths],
      ] as const) {
        const matches = picomatch(globs, { dot: true });
        const uncovered = files.filter((file) => !matches(file));

        // A new COPY source (or a dropped filter glob) must fail here, not
        // silently ship an image or lane that no change triggers.
        expect(uncovered, `${filter} misses ${source}`).toEqual([]);
      }
    }
  });
});
