#!/usr/bin/env bun
// Fast-gate plan: every spec file a pull request rewrites runs in full on the
// PR, not just its `@fast`/`@isolation` tests.
//
// The fast suite runs the tagged PR gate only, so a rewritten spec first ran
// in the merge queue's release suite — and failed there (Candidate 10,
// #347's rewritten `admin.spec.ts`). `e2e.yml`'s `plan` job runs this on
// `pull_request` and hands the result to both tenancy lanes as
// `E2E_CHANGED_SPECS`; `playwright.config.ts` runs those files' untagged
// tests in an `e2e-changed` project beside the tagged `e2e` project.
//
// A changed shared helper (`e2e/helpers.ts`, `e2e/fixtures/**`,
// `e2e/auth.setup.ts`, `playwright.config.ts`, or any other non-spec file
// under `e2e/`) escalates the gate to the release suite instead: its blast
// radius is every spec, so selecting files would be false precision. Lane
// infrastructure (`docker/e2e-local.sh`, compose files, the image) does not
// escalate — the fast suite still boots the lane and runs the tagged paths,
// which is what catches a broken lane.
//
// Usage:
//   bun .github/scripts/e2e-plan.ts --base <sha> [--head HEAD] [--suite fast]
// Prints `suite=` and `extra-specs=` lines (GITHUB_OUTPUT-compatible) plus a
// human summary on stderr. Deleted specs are never selected
// (`--diff-filter=AMR`: added, modified, renamed — renames list the new path).
import { execFileSync } from "node:child_process";

// Changed paths are PR-controlled input whose values flow into GITHUB_OUTPUT
// and the lane, so anything outside this allowlist throws: no whitespace,
// control characters, quotes, `$`, backticks or shell metacharacters.
// Brackets stay — file-routed pages (`apps/noite/src/pages/apps/[id].tsx`)
// are legitimate tracked paths. Parsing stays NUL-separated (`-z`), so an
// embedded newline can never split one entry into two output lines either.
const SAFE_PATH = /^[A-Za-z0-9./@_+[\]-]+$/u;

const E2E_DIR = "apps/noite/e2e/";
const CONFIG_PATH = "apps/noite/playwright.config.ts";

// Always fully run, untagged, in both suites: the `setup` project runs the
// ceremony and the `policy` project runs this spec with no grep. Selecting it
// as an extra would run it twice.
const ALWAYS_FULL_SPECS = {
  "a-invite.spec.ts": true,
} satisfies Record<string, true>;

export interface E2EPlan {
  extraSpecs: string[];
  runRelease: boolean;
  suite: "fast" | "release";
}

const specName = (path: string): string | null => {
  if (!path.startsWith(E2E_DIR) || !path.endsWith(".spec.ts")) {
    return null;
  }

  const name = path.slice(E2E_DIR.length);

  return name.length > 0 && !Object.hasOwn(ALWAYS_FULL_SPECS, name)
    ? name
    : null;
};

export const planE2E = (
  changedFiles: string[],
  requestedSuite: string
): E2EPlan => {
  if (requestedSuite !== "fast" && requestedSuite !== "release") {
    throw new Error(`suite must be fast or release, not ${requestedSuite}`);
  }

  if (requestedSuite === "release") {
    return { extraSpecs: [], runRelease: false, suite: "release" };
  }

  const extra = new Set<string>();
  let runRelease = false;

  for (const raw of changedFiles) {
    // The trailing NUL of `-z` output splits into one empty entry; anything
    // else outside the allowlist fails the plan instead of shaping it.
    if (raw.length === 0) {
      continue;
    }

    if (!SAFE_PATH.test(raw)) {
      throw new Error(`refusing unsafe path from diff: ${JSON.stringify(raw)}`);
    }

    const path = raw;

    // A non-spec file under e2e/ (helpers, fixtures, setup, page objects) is
    // shared by every spec, so it escalates instead of selecting. Specs the
    // shared projects already run fully (a-invite) select nothing.
    if (!path.endsWith(".spec.ts")) {
      if (path === CONFIG_PATH || path.startsWith(E2E_DIR)) {
        runRelease = true;
      }

      continue;
    }

    const spec = specName(path);

    if (spec !== null) {
      extra.add(spec);
    }
  }

  const extraSpecs = [...extra].toSorted();

  return { extraSpecs, runRelease, suite: runRelease ? "release" : "fast" };
};

export interface LaneShardCounts {
  lane: string;
  shard1: number;
  shard2: number;
  target: string;
}

export interface PlanCell {
  lane: string;
  round: number;
  shard: number;
  target: string;
  total: number;
}

// Which (lane, shard) cells the e2e matrix runs. Playwright assigns whole
// file-groups by start position, so one large changed file can swallow a
// shard's entire share and leave the other shard with zero tests (#359:
// a 10-test file took all of shard 1, shard 2 ran nothing, and the lane's
// account-dependent post-checks failed). A shard the `--list` probe shows
// as empty collapses to one unsharded cell instead of a meaningless empty
// one; a lane with no tests at all fails the plan instead of passing
// vacuously. File discovery is readdir-sorted, so the probe matches the
// lane's actual distribution.
export const planCells = (
  lanes: LaneShardCounts[],
  rounds: number[]
): PlanCell[] => {
  if (!rounds.every((round) => Number.isInteger(round))) {
    throw new Error(`rounds must be integers, not ${JSON.stringify(rounds)}`);
  }

  return lanes.flatMap((lane) => {
    const listed = lane.shard1 + lane.shard2;

    if (listed === 0) {
      throw new Error(
        `lane ${lane.lane} lists no tests: refusing an empty plan`
      );
    }

    const shards =
      lane.shard1 > 0 && lane.shard2 > 0
        ? [
            { shard: 1, total: 2 },
            { shard: 2, total: 2 },
          ]
        : [{ shard: 1, total: 1 }];

    return shards.flatMap(({ shard, total }) =>
      rounds.map((round) => ({
        lane: lane.lane,
        round,
        shard,
        target: lane.target,
        total,
      }))
    );
  });
};

const flag = (name: string, fallback: string): string => {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));

  if (inline !== undefined) {
    return inline.slice(name.length + 1);
  }

  const at = process.argv.indexOf(name);

  if (at !== -1 && at + 1 < process.argv.length) {
    const next = process.argv[at + 1];

    if (next !== undefined && !next.startsWith("--")) {
      return next;
    }
  }

  return fallback;
};

const LANE_TARGETS = {
  multi: "e2e-isolation",
  single: "e2e",
} satisfies Record<string, string>;

const listShardCount = (
  tenancy: string,
  suite: string,
  extras: string,
  shard: number
): number => {
  const out = execFileSync(
    "bunx",
    ["playwright", "test", "--list", `--shard=${shard}/2`],
    {
      cwd: new URL("../../apps/noite", import.meta.url),
      encoding: "utf-8",
      env: {
        ...process.env,
        E2E_CHANGED_SPECS: extras,
        E2E_SUITE: suite,
        E2E_TENANCY: tenancy,
      },
    }
  );

  const match = /Total:\s*(?<count>\d+)\s*tests?\s*in\s*\d+\s*files?/u.exec(
    out
  );

  const count = match?.groups?.count;

  if (count === undefined) {
    throw new Error(
      `could not count --list tests for ${tenancy} shard ${shard}`
    );
  }

  return Number(count);
};

const main = (): void => {
  const base = flag("--base", "");
  const head = flag("--head", "HEAD");
  const requestedSuite = flag("--suite", "fast");
  const roundsRaw = flag("--rounds", "[1]");

  // SAFETY: rounds cross the matrix cells below; anything else fails here
  // instead of silently planning the wrong rounds.
  const rounds = JSON.parse(roundsRaw) as unknown;

  if (
    !Array.isArray(rounds) ||
    !rounds.every((round) => Number.isInteger(round))
  ) {
    console.error("refusing unsafe --rounds (want a JSON array of integers)");
    process.exit(1);
  }

  // No base outside pull requests (merge queue, schedule, dispatch): no PR
  // diff to plan from, so the requested suite runs unchanged with no extras.
  const root = new URL("../..", import.meta.url);
  let changed: string[] = [];
  let plan = planE2E([], requestedSuite);

  if (base !== "") {
    if (!/^[0-9a-fA-F]+$/u.test(base)) {
      console.error("refusing unsafe --base (want a sha)");
      process.exit(1);
    }

    if (head !== "HEAD" && !/^[0-9a-fA-F]+$/u.test(head)) {
      console.error("refusing unsafe --head (want a sha or HEAD)");
      process.exit(1);
    }

    // Three-dot diffs against the merge base, so a branch that merged main
    // mid-review only reports what the PR itself changed. Runs from the repo
    // root, never the caller's cwd.
    const raw = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AMR", "-z", `${base}...${head}`],
      { cwd: root, encoding: "utf-8" }
    );

    changed = raw.split("\0").filter((entry) => entry.length > 0);
    plan = planE2E(changed, requestedSuite);
  }

  // The allowlist above admits no newlines, but these lines become
  // GITHUB_OUTPUT entries: assert single-line output instead of assuming it.
  for (const [label, value] of [
    ["suite", plan.suite],
    ["extra-specs", plan.extraSpecs.join(" ")],
  ]) {
    if (/[\r\n]/u.test(value)) {
      throw new Error(`refusing multi-line ${label} output`);
    }
  }

  // Probe the real distribution per lane: Playwright assigns whole
  // file-groups by start position, so one large changed file can swallow a
  // shard's share and strand the other shard empty (#359). A lane whose
  // split leaves a shard empty runs one unsharded cell instead; a lane with
  // no tests at all fails here (planCells throws) instead of passing
  // vacuously downstream.
  const extras = plan.extraSpecs.join(" ");

  const lanes = ["single", "multi"].map((tenancy) => ({
    lane: tenancy,
    shard1: listShardCount(tenancy, plan.suite, extras, 1),
    shard2: listShardCount(tenancy, plan.suite, extras, 2),
    target: LANE_TARGETS[tenancy] ?? "e2e",
  }));

  // SAFETY: the guard above proved an array of integers.
  const cells = planCells(lanes, rounds as number[]);

  console.log(`suite=${plan.suite}`);
  console.log(`extra-specs=${extras}`);
  console.log(`cells=${JSON.stringify(cells)}`);
  console.error(
    `e2e plan: ${changed.length} changed file(s) -> suite ${plan.suite}${
      plan.extraSpecs.length > 0
        ? `, extra specs ${plan.extraSpecs.join(" ")}`
        : ""
    }${plan.runRelease ? " (shared helper changed)" : ""} -> ${JSON.stringify(cells)}`
  );
};

if (import.meta.main) {
  main();
}
