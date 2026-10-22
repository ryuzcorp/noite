#!/usr/bin/env bun
/**
 * Local pre-push gate: every check an agent must pass before pushing.
 *
 * Each gate spawns its process directly (no shell, no pipes) and its exit
 * code is read straight from the child; the run ends with a summary table.
 * Non-zero exit when any gate fails; warnings (missing fragment, sensitive
 * paths) never fail the run by themselves.
 *
 *   bun docker/pr-ready.ts [--skip-build]   skip apps/noite `bun run build`
 *
 * Changed areas come from `git merge-base origin/main HEAD`. The Rust
 * toolchain is unpinned on purpose: CI uses dtolnay/rust-toolchain@stable
 * and there is no rust-version in apps/runner/Cargo.toml, so this script
 * uses ~/.cargo/bin/cargo (cargo is not on PATH).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import picomatch from "picomatch";

const root = new URL("../", import.meta.url).pathname;

export type Area = "runner" | "ui" | "cli" | "docs" | "workflows" | "other";

export interface AreaMap {
  cli: string[];
  docs: string[];
  other: string[];
  runner: string[];
  ui: string[];
  workflows: string[];
}

const AREA_PREFIXES: { area: Area; prefix: string }[] = [
  { area: "runner", prefix: "apps/runner/" },
  { area: "ui", prefix: "apps/noite/" },
  { area: "cli", prefix: "packages/cli/" },
  { area: "workflows", prefix: ".github/" },
  { area: "workflows", prefix: "docker/" },
  { area: "docs", prefix: "apps/website/" },
];

/** Map changed files to areas. Exported for tests. */
export const detectAreas = (files: readonly string[]): AreaMap => {
  const areas: AreaMap = {
    cli: [],
    docs: [],
    other: [],
    runner: [],
    ui: [],
    workflows: [],
  };

  for (const file of files) {
    const hit = AREA_PREFIXES.find(({ prefix }) => file.startsWith(prefix));

    if (hit) {
      areas[hit.area].push(file);
    } else if (file.endsWith(".md") || file.endsWith(".mdx")) {
      areas.docs.push(file);
    } else {
      areas.other.push(file);
    }
  }

  return areas;
};

const SENSITIVE_KEY = /^sensitive:\s*(?:#.*)?$/u;
const LIST_ITEM = /^\s*-\s+(?<rest>.+)$/u;
const TOP_LEVEL = /^\S/u;
const YAML_COMMENT = /\s+#.*$/u;
const QUOTES = /^['"]|['"]$/gu;

/**
 * Read the `sensitive:` glob list from .github/security-paths.yml
 * (dorny/paths-filter filter format, one filter key). Missing file or key
 * means no list yet, never an error. Exported for tests.
 */
export const parseSensitiveGlobs = (yaml: string): string[] => {
  const lines = yaml.split("\n");
  const key = lines.findIndex((line) => SENSITIVE_KEY.test(line));

  if (key === -1) {
    return [];
  }

  return lines.slice(key + 1).flatMap((line) => {
    if (TOP_LEVEL.test(line)) {
      return [];
    }

    const item = LIST_ITEM.exec(line)?.groups?.rest;

    if (!item) {
      return [];
    }

    const glob = item.replace(YAML_COMMENT, "").trim().replaceAll(QUOTES, "");

    return glob === "" ? [] : [glob];
  });
};

/** Match files against globs with picomatch semantics (`!` negates). */
export const matchSensitive = (
  files: readonly string[],
  patterns: readonly string[]
): string[] => {
  const positive = patterns.filter((p) => !p.startsWith("!"));

  const negative = patterns.flatMap((p) =>
    p.startsWith("!") ? [p.slice(1)] : []
  );

  if (positive.length === 0) {
    return [];
  }

  const isPositive = picomatch(positive, { dot: true });
  const isNegative = picomatch(negative, { dot: true });

  return files.filter((file) => isPositive(file) && !isNegative(file));
};

interface GateResult {
  detail: string;
  name: string;
  status: "fail" | "pass" | "skip";
}

const tail = (out: string): string => out.split("\n").slice(-20).join("\n");

const runCommand = async (
  command: string[],
  cwd: string
): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });

  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, out: `${out}${err}`.trimEnd() };
};

const runGate = async (
  name: string,
  run: () => Promise<string>
): Promise<GateResult> => {
  try {
    return { detail: await run(), name, status: "pass" };
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      name,
      status: "fail",
    };
  }
};

const exec = async (
  command: string[],
  cwd: string,
  label: string
): Promise<string> => {
  const { code, out } = await runCommand(command, cwd);

  if (code !== 0) {
    throw new Error(`${label} exited ${code}\n${tail(out)}`);
  }

  return "ok";
};

const listChanged = async (): Promise<string[]> => {
  const fetch = await runCommand(["git", "fetch", "origin", "main"], root);

  if (fetch.code !== 0) {
    throw new Error(
      `git fetch origin main failed; cannot prove mergeability\n${tail(fetch.out)}`
    );
  }

  const base = await runCommand(
    ["git", "merge-base", "origin/main", "HEAD"],
    root
  );

  if (base.code !== 0) {
    throw new Error("git merge-base origin/main HEAD failed");
  }

  const diff = await runCommand(
    ["git", "diff", "--name-only", base.out.trim(), "HEAD"],
    root
  );

  const untracked = await runCommand(
    ["git", "ls-files", "--others", "--exclude-standard"],
    root
  );

  if (diff.code !== 0 || untracked.code !== 0) {
    throw new Error("could not list changed files");
  }

  return [diff.out, untracked.out]
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();

      return trimmed === "" ? [] : [trimmed];
    });
};

if (import.meta.main) {
  const skipBuild = process.argv.includes("--skip-build");

  if (process.argv.includes("--help")) {
    console.log(
      "usage: bun docker/pr-ready.ts [--skip-build]\n\n--skip-build  skip apps/noite `bun run build`; everything else still runs"
    );
    process.exit(0);
  }

  const results: GateResult[] = [];

  const fail = (name: string, detail: string): void => {
    results.push({ detail, name, status: "fail" });
  };

  const cargo = path.join(process.env.HOME ?? "~", ".cargo/bin/cargo");

  let changed: string[] = [];

  try {
    changed = await listChanged();
  } catch (error) {
    fail(
      "changed areas",
      error instanceof Error ? error.message : String(error)
    );
  }

  const areas = detectAreas(changed);

  const runtimeChanged =
    areas.runner.length + areas.ui.length + areas.cli.length > 0;

  results.push(
    await runGate("bun run check", () =>
      exec(["bun", "run", "check"], root, "check")
    )
  );

  if (areas.runner.length > 0) {
    const cwd = path.join(root, "apps/runner");
    results.push(
      await runGate("cargo fmt --check", () =>
        exec([cargo, "fmt", "--check"], cwd, "fmt")
      ),
      await runGate("cargo clippy", () =>
        exec(
          [
            cargo,
            "clippy",
            "--locked",
            "--all-targets",
            "--",
            "-D",
            "warnings",
          ],
          cwd,
          "clippy"
        )
      ),
      await runGate("cargo test", () =>
        exec([cargo, "test", "--locked"], cwd, "cargo test")
      )
    );
  }

  if (areas.ui.length > 0) {
    const cwd = path.join(root, "apps/noite");
    results.push(
      await runGate("tsc --noEmit", () =>
        exec(["bunx", "tsc", "--noEmit"], cwd, "tsc")
      ),
      await runGate("ui test", () => exec(["bun", "run", "test"], cwd, "test"))
    );

    if (skipBuild) {
      results.push({
        detail: "skipped (--skip-build)",
        name: "ui build",
        status: "skip",
      });
    } else {
      results.push(
        await runGate("ui build", () =>
          exec(["bun", "run", "build"], cwd, "build")
        )
      );
    }
  }

  results.push(
    await runGate("check-changelog", () =>
      exec(["bun", "docker/check-changelog.ts"], root, "check-changelog")
    ),
    await runGate("check-versions", () =>
      exec(["bun", "docker/check-versions.ts"], root, "check-versions")
    )
  );

  if (existsSync(path.join(root, "docker/check-tests.ts"))) {
    results.push(
      await runGate("check-tests", () =>
        exec(["bun", "docker/check-tests.ts"], root, "check-tests")
      )
    );
  } else {
    results.push({
      detail: "docker/check-tests.ts not present yet (slice C)",
      name: "check-tests",
      status: "skip",
    });
  }

  const tree = await runCommand(
    ["git", "merge-tree", "--write-tree", "origin/main", "HEAD"],
    root
  );

  if (tree.code === 0) {
    results.push({ detail: "clean", name: "merge-tree", status: "pass" });
  } else {
    fail(
      "merge-tree",
      "merge conflicts with origin/main; conflicting PRs get no CI — rebase first"
    );
  }

  const summaryChanged = Object.entries(areas)
    .flatMap(([area, files]) => (files.length > 0 ? [area] : []))
    .join(", ");

  const fragmentAdded = changed.some((file) => file.startsWith("changelog.d/"));

  const warnings: string[] = [];

  if (runtimeChanged && !fragmentAdded) {
    warnings.push(
      "runtime code changed with no changelog.d/ file added (warning only)"
    );
  }

  const sensitivePath = path.join(root, ".github/security-paths.yml");
  let sensitiveNote: string;

  if (existsSync(sensitivePath)) {
    const matched = matchSensitive(
      changed,
      parseSensitiveGlobs(readFileSync(sensitivePath, "utf-8"))
    );

    sensitiveNote =
      matched.length > 0
        ? `touches sensitive paths (${matched.join(", ")}): needs an independent security review and the security-reviewed label`
        : "no changed file matches the sensitive list";
  } else {
    sensitiveNote =
      "no sensitive list yet (.github/security-paths.yml missing)";
  }

  const width = Math.max(...results.map(({ name }) => name.length));
  console.log(`\npr-ready: areas [${summaryChanged || "none"}]`);

  for (const { detail, name, status } of results) {
    console.log(
      `${name.padEnd(width)}  ${status.toUpperCase().padEnd(4)}  ${detail.split("\n")[0]}`
    );
  }

  for (const warning of warnings) {
    console.log(`fragment  WARN  ${warning}`);
  }

  console.log(`sensitive  INFO  ${sensitiveNote}`);

  const failed = results.some(({ status }) => status === "fail");
  process.exit(failed ? 1 : 0);
}
