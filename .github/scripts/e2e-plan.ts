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
    const path = raw.trim();

    if (path.length === 0) {
      continue;
    }

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

const main = (): void => {
  const base = flag("--base", "");

  if (base.length === 0) {
    console.error(
      "usage: e2e-plan.ts --base <sha> [--head HEAD] [--suite fast]"
    );
    process.exit(1);
  }

  const head = flag("--head", "HEAD");
  const suite = flag("--suite", "fast");

  // Three-dot diffs against the merge base, so a branch that merged main
  // mid-review only reports what the PR itself changed. Runs from the repo
  // root (two levels above this script), never the caller's cwd.
  const root = new URL("../..", import.meta.url);

  const raw = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=AMR", "-z", `${base}...${head}`],
    { cwd: root, encoding: "utf-8" }
  );

  const changed = raw.split("\0").filter((entry) => entry.length > 0);

  const plan = planE2E(changed, suite);

  console.log(`suite=${plan.suite}`);
  console.log(`extra-specs=${plan.extraSpecs.join(" ")}`);
  console.error(
    `e2e plan: ${changed.length} changed file(s) -> suite ${plan.suite}${
      plan.extraSpecs.length > 0
        ? `, extra specs ${plan.extraSpecs.join(" ")}`
        : ""
    }${plan.runRelease ? " (shared helper changed)" : ""}`
  );
};

if (import.meta.main) {
  main();
}
