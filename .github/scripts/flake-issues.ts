#!/usr/bin/env bun
// Nightly flake hunt: read every lane's Playwright JSON results and file one
// `flake`-labelled issue per failing spec title, or comment on the
// already-open one. Green runs file nothing and exit 0.
//
//   bun .github/scripts/flake-issues.ts --reports /tmp/e2e-reports \
//     --run-url https://github.com/OWNER/REPO/actions/runs/ID
//
// `--reports` holds one directory per uploaded artifact, named
// `playwright-report-<lane>-r<round>-s<shard>`, each with `e2e-results.json`
// (the `json` reporter in apps/noite/playwright.config.ts). Auth through
// GH_TOKEN, like every other `gh` call on the runners.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_TITLE = 200;
const MAX_ERROR_LINES = 30;
const MAX_ERROR_CHARS = 3000;

const REPORT_DIR =
  /^playwright-report-(?<lane>.+)-r(?<round>\d+)-s(?<shard>\d+)$/u;

const BAD_STATUSES = {
  failed: true,
  interrupted: true,
  timedOut: true,
} satisfies Record<string, true>;

// The Playwright `json` reporter shape, narrowed to the fields this script
// reads. Unknown report internals stay out: every access below defaults.
interface ReportResult {
  error?: { message?: string; stack?: string } | null;
  status?: string;
}

// `status` is Playwright's per-test outcome: `expected` (including a
// `test.fail()` that failed as declared), `unexpected`, `flaky` or `skipped`.
interface ReportTest {
  results?: ReportResult[];
  status?: string;
}

interface ReportSpec {
  file?: string;
  tests?: ReportTest[];
  title?: string;
}

interface ReportSuite {
  file?: string;
  specs?: ReportSpec[];
  suites?: ReportSuite[];
  title?: string;
}

interface PlaywrightReport {
  suites?: ReportSuite[];
}

interface Failure {
  error: string;
  file: string;
  status: string;
  title: string;
}

type Occurrence = Failure & {
  lane: string;
  round: string;
  shard: string;
};

interface OpenIssue {
  number: number;
  title: string;
}

const usage = (): never => {
  console.error(
    "usage: flake-issues.ts --reports DIR --run-url URL --lanes a,b --rounds '[1,2]' --shards N"
  );

  process.exit(2);
};

const FLAGS = {
  "--lanes": "lanes",
  "--reports": "reports",
  "--rounds": "rounds",
  "--run-url": "runUrl",
  "--shards": "shards",
} satisfies Record<string, string>;

const parseArgs = (argv: string[]) => {
  const out: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg !== undefined && Object.hasOwn(FLAGS, arg) && value !== undefined) {
      // SAFETY: `Object.hasOwn` just proved `arg` is a FLAGS key.
      out[FLAGS[arg as keyof typeof FLAGS]] = value;
      index += 1;
    } else {
      usage();
    }
  }

  const { lanes, reports, rounds, runUrl, shards } = out;

  if (
    lanes === undefined ||
    reports === undefined ||
    rounds === undefined ||
    runUrl === undefined ||
    shards === undefined
  ) {
    return usage();
  }

  // SAFETY: the plan job emits `rounds` as a JSON array of round numbers;
  // anything else fails the check below instead of shrinking the matrix.
  const roundList = JSON.parse(rounds) as unknown;
  const shardCount = Number(shards);

  if (
    !Array.isArray(roundList) ||
    !roundList.every((round) => Number.isInteger(round)) ||
    !Number.isInteger(shardCount) ||
    shardCount < 1
  ) {
    return usage();
  }

  return {
    lanes: lanes.split(",").filter((lane) => lane !== ""),
    reports,
    // SAFETY: the check above proved an array of integers.
    rounds: roundList as number[],
    runUrl,
    shards: shardCount,
  };
};

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf-8" }).trim();

// What a filed test reports: its first failing result's error and status,
// `flaky` when a retry passed, or an unexpected pass when a `test.fail()`
// passed (no failing result at all).
const outcomeOf = (failing: ReportTest): Pick<Failure, "error" | "status"> => {
  const bad = (failing.results ?? []).find(
    (result) =>
      result.status !== undefined && Object.hasOwn(BAD_STATUSES, result.status)
  );

  if (bad === undefined) {
    return {
      error: "(passed, but the test is declared to fail)",
      status: failing.status === "flaky" ? "flaky" : "unexpected pass",
    };
  }

  return {
    error: bad.error?.message ?? bad.error?.stack ?? "(no error text)",
    status: failing.status === "flaky" ? "flaky" : (bad.status ?? "failed"),
  };
};

// Walk the JSON reporter's suite tree, carrying ancestor titles, and collect
// every spec whose test outcome is `unexpected` or `flaky`. The outcome, not
// a result status, decides: a `test.fail()` that failed as declared is
// `expected` (green, never filed), and one that passed is `unexpected` with
// no failing result (filed as an unexpected pass).
export const collectFailures = (
  suites: ReportSuite[] | undefined,
  ancestors: string[],
  file: string | undefined,
  out: Failure[]
): Failure[] => {
  for (const suite of suites ?? []) {
    const titles = [...ancestors, suite.title ?? ""].filter(
      (part) => part !== ""
    );

    const suiteFile = suite.file ?? file ?? "unknown";

    for (const spec of suite.specs ?? []) {
      const failing = (spec.tests ?? []).find(
        (test) => test.status === "unexpected" || test.status === "flaky"
      );

      if (failing !== undefined) {
        out.push({
          ...outcomeOf(failing),
          file: spec.file ?? suiteFile,
          title: [...titles, spec.title ?? ""]
            .filter((part) => part !== "")
            .join(" › "),
        });
      }
    }

    collectFailures(suite.suites, titles, suiteFile, out);
  }

  return out;
};

// Every planned (lane, round, shard) cell must have uploaded its results: a
// shard that died before Playwright wrote them (a lane that never booted, a
// cancelled job) would otherwise shrink the hunt silently.
export const missingReports = (
  present: ReadonlySet<string>,
  lanes: readonly string[],
  rounds: readonly number[],
  shards: number
): string[] =>
  lanes.flatMap((lane) =>
    rounds.flatMap((round) =>
      Array.from({ length: shards }, (_, index) => {
        const cell = `${lane}-r${round}-s${index + 1}`;

        return present.has(cell) ? [] : [cell];
      }).flat()
    )
  );

const errorSnippet = (error: string): string => {
  const lines = error.split("\n").slice(0, MAX_ERROR_LINES).join("\n");

  return lines.length > MAX_ERROR_CHARS
    ? `${lines.slice(0, MAX_ERROR_CHARS)}\n…(truncated)`
    : lines;
};

const issueBody = (
  key: string,
  first: Occurrence,
  occurrences: Occurrence[],
  runUrl: string
): string => {
  const rows = occurrences
    .map((o) => `| ${o.lane} | ${o.round} | ${o.shard} | ${o.status} |`)
    .join("\n");

  return [
    "A scheduled e2e round failed this spec. No retries anywhere: a failure is a finding.",
    "",
    `Run: ${runUrl}`,
    "",
    "| lane | round | shard | status |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    `<details><summary>First error (${first.file}, lane ${first.lane} round ${first.round} shard ${first.shard})</summary>`,
    "",
    "```",
    errorSnippet(first.error),
    "```",
    "</details>",
    "",
    `Spec key: \`${key}\``,
  ].join("\n");
};

const fileIssues = (
  bySpec: ReadonlyMap<string, Occurrence[]>,
  runUrl: string
): void => {
  try {
    gh([
      "label",
      "create",
      "flake",
      "--description",
      "Found by the nightly e2e flake hunt",
      "--color",
      "F4667C",
    ]);
  } catch {
    // Already exists (or otherwise uncreateable — the create/comment below
    // will fail loudly if the label is really missing).
  }

  // Every open `flake` issue, paginated (a capped list could miss one and
  // file a duplicate); titles are matched exactly in memory below. The
  // issues endpoint also lists pull requests, which never match a title.
  // SAFETY: `gh api --paginate --slurp` answers an array of pages, each an
  // array of issue objects; a CLI or API change fails this job loudly.
  const open = (
    JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        "repos/{owner}/{repo}/issues?state=open&labels=flake&per_page=100",
      ])
    ) as OpenIssue[][]
  ).flat();

  const tmp = mkdtempSync(path.join(tmpdir(), "flake-"));

  for (const [key, occurrences] of bySpec) {
    // Keys are only set beside a push above, so a first occurrence exists.
    const [first] = occurrences;

    if (first === undefined) {
      continue;
    }

    const title = `[flake] ${key}`;

    const bodyFile = path.join(
      tmp,
      `body-${occurrences.length}-${Date.now()}.md`
    );

    writeFileSync(bodyFile, issueBody(key, first, occurrences, runUrl));

    const existing = open.find((issue) => issue.title === title);

    if (existing === undefined) {
      const url = gh([
        "issue",
        "create",
        "--label",
        "flake",
        "--title",
        title,
        "--body-file",
        bodyFile,
      ]);

      console.log(`opened ${url} for ${key}`);
    } else {
      gh([
        "issue",
        "comment",
        String(existing.number),
        "--body-file",
        bodyFile,
      ]);

      console.log(`commented on #${existing.number} for ${key}`);
    }
  }
};

const main = (): void => {
  const { lanes, reports, rounds, runUrl, shards } = parseArgs(
    process.argv.slice(2)
  );

  const dirs = readdirSync(reports, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const bySpec = new Map<string, Occurrence[]>();
  const present = new Set<string>();

  for (const dir of dirs) {
    const match = REPORT_DIR.exec(dir);

    if (match === null || match.groups === undefined) {
      continue;
    }

    const { lane, round, shard } = match.groups;
    const resultsPath = path.join(reports, dir, "e2e-results.json");

    if (!existsSync(resultsPath)) {
      continue;
    }

    present.add(`${lane}-r${round}-s${shard}`);

    // SAFETY: the file is the Playwright `json` reporter output the lane just
    // wrote; every field this script reads is optional and defaulted above,
    // so an older or newer reporter shape collects fewer failures instead of
    // crashing (and zero files still fails the job below).
    const report = JSON.parse(
      readFileSync(resultsPath, "utf-8")
    ) as PlaywrightReport;

    for (const failure of collectFailures(report.suites, [], undefined, [])) {
      // The file suite's own title is the file path, which the key already
      // carries: `e2e/a.spec.ts › admin › does x`, not the doubled form.
      const shortTitle = failure.title.startsWith(`${failure.file} › `)
        ? failure.title.slice(failure.file.length + 3)
        : failure.title;

      const key = `${failure.file} › ${shortTitle}`.slice(0, MAX_TITLE);

      if (!bySpec.has(key)) {
        bySpec.set(key, []);
      }

      const occurrences = bySpec.get(key);

      occurrences?.push({ ...failure, lane, round, shard });
    }
  }

  const missing = missingReports(present, lanes, rounds, shards);

  console.log(
    `read ${present.size} result file(s), ${bySpec.size} failing spec(s), ${missing.length} missing`
  );

  if (bySpec.size > 0) {
    fileIssues(bySpec, runUrl);
  }

  // Checked after filing, so the failures that did report still land: a
  // missing cell (a lane that never booted, a shard that died before its
  // report) fails the hunt loudly instead of passing on partial coverage.
  if (missing.length > 0) {
    console.error(
      `::error::no e2e-results.json for ${missing.join(", ")}: the hunt did not cover the planned matrix`
    );

    process.exit(1);
  }
};

if (import.meta.main) {
  main();
}
