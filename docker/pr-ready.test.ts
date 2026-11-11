import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import picomatch from "picomatch";

import { detectAreas, matchSensitive, parseSensitiveGlobs } from "./pr-ready";

const root = fileURLToPath(new URL("../", import.meta.url));

interface WorkflowInstallStep {
  bounded: boolean;
  name: string;
}

interface WorkflowJob {
  installSteps: WorkflowInstallStep[];
  name: string;
  timeoutMinutes: number | null;
  uses: string | null;
}

const JOB_HEADER = /^ {2}(?<name>[\w-]+):\s*(?:#.*)?$/u;
const JOB_KEY = /^ {4}(?<key>[\w-]+):\s*(?<value>[^#]*?)\s*(?:#.*)?$/u;
const STEP_HEADER = /^ {6}-\s/u;

/** The first `key: value` of a step block, dash line or nested key. */
const stepValue = (block: string[], key: string): string | null => {
  for (const line of block) {
    const match =
      /^(?: {6}-\s+| {8})(?<key>[\w-]+):\s*(?<value>[^#]*?)\s*(?:#.*)?$/u.exec(
        line
      );

    if (match?.groups?.key === key) {
      return (match.groups.value ?? "").trim();
    }
  }

  return null;
};

/**
 * The jobs of a workflow, with only what the timeout rules read: whether the
 * job bounds itself, whether it forwards to a reusable workflow, and which of
 * its steps install from the network (respectively, whether they bound
 * themselves). Line-based on purpose: no YAML dependency at the repo root, and
 * the same shape the other workflow guards in this file read.
 */
const workflowJobs = (yaml: string): WorkflowJob[] => {
  const lines = yaml.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/u.test(line));

  if (jobsAt === -1) {
    throw new Error("workflow has no jobs");
  }

  const body = lines.slice(jobsAt + 1);

  const starts = body.flatMap((line, index) =>
    JOB_HEADER.test(line) ? [index] : []
  );

  if (starts.length === 0) {
    throw new Error("workflow has no jobs");
  }

  return starts.map((start, at) => {
    const end = starts[at + 1] ?? body.length;
    const block = body.slice(start, end);
    const name = JOB_HEADER.exec(body[start] ?? "")?.groups?.name ?? "";
    const firstStep = block.findIndex((line) => STEP_HEADER.test(line));
    const head = firstStep === -1 ? block : block.slice(0, firstStep);

    const jobKeys = new Map(
      head.flatMap((line) => {
        const groups = JOB_KEY.exec(line)?.groups;

        return groups ? [[groups.key, (groups.value ?? "").trim()]] : [];
      })
    );

    const timeout = jobKeys.get("timeout-minutes");
    const uses = jobKeys.get("uses");

    const stepStarts = block.flatMap((line, index) =>
      STEP_HEADER.test(line) ? [index] : []
    );

    const installSteps = stepStarts.flatMap((from, index) => {
      const step = block.slice(from, stepStarts[index + 1] ?? block.length);
      const stepUses = stepValue(step, "uses") ?? "";
      const run = stepValue(step, "run") ?? "";

      const installs =
        stepUses.startsWith("oven-sh/setup-bun@") ||
        /\bbun install\b/u.test(run);

      if (!installs) {
        return [];
      }

      return [
        {
          bounded:
            Math.trunc(Number(stepValue(step, "timeout-minutes") ?? "")) > 0,
          name:
            stepValue(step, "name") ||
            stepUses ||
            run.split("\n")[0] ||
            step[0]?.trim() ||
            "install step",
        },
      ];
    });

    return {
      installSteps,
      name,
      timeoutMinutes:
        timeout === undefined ? null : Math.trunc(Number(timeout)),
      uses: uses && uses.length > 0 ? uses : null,
    };
  });
};

/**
 * Every job bounds its own wall clock, and every step that installs from the
 * network bounds itself too. A `uses:` job forwards to another workflow and
 * GitHub rejects `timeout-minutes` there, so the exemption is the `uses:` key
 * itself; the called workflow's jobs are checked on their own file.
 *
 * Returns `<job>: <problem>` lines, empty when the workflow is sound.
 */
const timeoutProblems = (yaml: string): string[] =>
  workflowJobs(yaml).flatMap((job) => {
    const problems: string[] = [];

    if (job.uses) {
      if (job.timeoutMinutes !== null) {
        problems.push(
          `${job.name}: a reusable-workflow call cannot set timeout-minutes`
        );
      }

      return problems;
    }

    if (!job.timeoutMinutes || job.timeoutMinutes <= 0) {
      problems.push(`${job.name}: job has no positive timeout-minutes`);
    }

    for (const step of job.installSteps) {
      if (!step.bounded) {
        problems.push(
          `${job.name}: network install step "${step.name}" has no positive timeout-minutes`
        );
      }
    }

    return problems;
  });

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

/** The `paths:` globs of `images.yml`'s `push` trigger, not another block. */
const imagePushPaths = (yaml: string): string[] => {
  const lines = yaml.split("\n");
  const push = lines.findIndex((line) => /^\s*push:\s*$/u.test(line));

  if (push === -1) {
    throw new Error("images.yml has no push trigger");
  }

  const paths = lines.findIndex(
    (line, index) => index > push && /^\s*paths:\s*$/u.test(line)
  );

  if (paths === -1) {
    throw new Error("images.yml has no push paths block");
  }

  return globsBelow(lines, paths);
};

/**
 * The `code:` globs of the `changes` job's dorny/paths-filter step, not any
 * other `filters:` block in `ci.yml`.
 */
const codeFilterGlobs = (yaml: string): string[] => {
  const lines = yaml.split("\n");

  const step = lines.findIndex((line) =>
    /^\s*(?:-\s*)?uses:\s*dorny\/paths-filter@/u.test(line)
  );

  if (step === -1) {
    throw new Error("ci.yml has no paths-filter step");
  }

  const filters = lines.findIndex(
    (line, index) => index > step && /^\s*filters: \|\s*$/u.test(line)
  );

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

/**
 * Every build-context source `docker/Dockerfile` copies in, in order. `ADD`
 * counts too; JSON-array and line-continued forms are unsupported here, so
 * they throw instead of silently dropping a source.
 */
const dockerfileCopySources = (dockerfile: string): string[] =>
  dockerfile.split("\n").flatMap((rawLine) => {
    const line = rawLine.trim();

    if (!/^(?:ADD|COPY)\s/iu.test(line)) {
      return [];
    }

    if (line.endsWith("\\") || line.includes("[")) {
      throw new Error(`unsupported build-context instruction: ${line}`);
    }

    const fields = line.split(/\s+/u);

    // `--from=<stage>` reads another stage's output, never the context.
    if (fields.slice(1).some((f) => /^--from(?:=|$)/u.test(f))) {
      return [];
    }

    // Last field is the destination; the rest (minus flags) are sources.
    return fields.slice(1, -1).filter((f) => !f.startsWith("--"));
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
      "apps/runner/src/host/git_http.rs",
      "apps/runner/src/host/container_image.rs",
      "apps/noite/src/lib/collaborators.ts",
      "apps/noite/src/lib/server/collaborators.server.ts",
      "apps/noite/src/lib/roles.ts",
      "apps/noite/src/lib/membership.ts",
      "apps/noite/src/lib/authority.ts",
      "apps/noite/src/lib/server/admin.server.tsx",
      "apps/noite/src/lib/server/api-keys.server.ts",
      "apps/noite/src/lib/server/mcp-auth.server.ts",
      "apps/noite/src/http/routes/internal.ts",
      "apps/noite/src/lib/server/recovery.server.ts",
      "apps/noite/src/http/config.ts",
      "apps/noite/src/http/routes/mcp.ts",
      "apps/noite/src/http/origin.ts",
      "docker/Dockerfile.dockerignore",
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

  const imagePaths = imagePushPaths(
    readRepoFile(".github/workflows/images.yml")
  );

  const codePaths = codeFilterGlobs(readRepoFile(".github/workflows/ci.yml"));

  test("keeps context sources on a flagged COPY, dropping only --from", () => {
    expect(
      dockerfileCopySources(
        [
          "COPY --chown=0:0 new-source /app",
          "ADD --chmod=0755 helper /usr/local/bin/helper",
          "COPY --from=runner-build /out/noite-runner /usr/local/bin/",
          "copy edge /edge",
        ].join("\n")
      )
    ).toEqual(["new-source", "helper", "edge"]);

    expect(() => dockerfileCopySources('COPY ["a", "b"]')).toThrow();
    expect(() => dockerfileCopySources("COPY a \\\n b /x")).toThrow();
  });

  test("parses the context sources of every build stage", () => {
    expect(sources).toContain("edge");
    expect(sources).toContain("apps/void-proxy/src");
    expect(sources).toContain("apps/void-sandbox/package.json");
    expect(sources).toContain("LICENSE");
    expect(sources).toContain("NOTICE");
    // `COPY --from=<stage>` sources are outputs, not build context.
    expect(sources).not.toContain("/out/caddy");
    expect(sources).not.toContain("/usr/local/bin/node");
    // The push block parsed is the real one, not another `paths:` list.
    expect(imagePaths).toContain("docker/Dockerfile");
    expect(imagePaths).toContain("edge/**");
    // So is the code filter: the changes job's step, not another block.
    expect(codePaths).toContain("apps/noite/**");
    expect(codePaths).toContain("docker/**");
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

describe("workflow job timeouts", () => {
  const workflowFiles = readdirSync(
    new URL("../.github/workflows/", import.meta.url)
  )
    .filter((name) => name.endsWith(".yml"))
    .toSorted();

  test("the rule rejects an unbounded job, a bounded call and an unbounded install", () => {
    expect(
      timeoutProblems(
        [
          "jobs:",
          "  plain:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
          "      - run: bun install",
          "  call:",
          "    uses: ./.github/workflows/check.yml",
          "    timeout-minutes: 10",
        ].join("\n")
      )
    ).toEqual([
      "plain: job has no positive timeout-minutes",
      'plain: network install step "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" has no positive timeout-minutes',
      'plain: network install step "bun install" has no positive timeout-minutes',
      "call: a reusable-workflow call cannot set timeout-minutes",
    ]);

    expect(
      timeoutProblems(
        [
          "jobs:",
          "  plain:",
          "    runs-on: ubuntu-latest",
          "    timeout-minutes: 10",
          "    steps:",
          "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
          "        timeout-minutes: 3",
          "      - run: bun install",
          "        timeout-minutes: 5",
          "  call:",
          "    uses: ./.github/workflows/check.yml",
        ].join("\n")
      )
    ).toEqual([]);
  });

  test("reusable-workflow calls point at a workflow this repo ships", () => {
    for (const file of workflowFiles) {
      for (const job of workflowJobs(
        readRepoFile(`.github/workflows/${file}`)
      )) {
        if (!job.uses?.startsWith("./")) {
          continue;
        }

        expect(
          existsSync(path.join(root, job.uses.replace(/^\.\//u, ""))),
          `${file}: ${job.name} calls ${job.uses}`
        ).toBe(true);
      }
    }
  });

  test("every job bounds itself with a timeout, so a hang fails fast", () => {
    const problems: string[] = [];
    let installSteps = 0;

    for (const file of workflowFiles) {
      const yaml = readRepoFile(`.github/workflows/${file}`);
      installSteps += workflowJobs(yaml).reduce(
        (count, job) => count + job.installSteps.length,
        0
      );
      problems.push(
        ...timeoutProblems(yaml).map((problem) => `${file}: ${problem}`)
      );
    }

    // Guard the parser itself: if job or step detection broke, every list
    // above would be empty and the drift check would pass vacuously.
    expect(installSteps).toBeGreaterThan(10);

    // An unbounded job waits GitHub's 360-minute default: the 2026-11-11
    // merge-group `check` hung in `bun install` for 40+ minutes, outlived
    // `gh run cancel --force`, and held the merge queue until the PR was
    // dequeued. Each timeout is ~3x that job's p95 (50 runs, 2026-11-11).
    expect(problems).toEqual([]);
  });
});
