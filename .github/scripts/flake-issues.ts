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

interface ReportTest {
  results?: ReportResult[];
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
  console.error("usage: flake-issues.ts --reports DIR --run-url URL");

  process.exit(2);
};

const parseArgs = (argv: string[]) => {
  const out: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if ((arg === "--reports" || arg === "--run-url") && value !== undefined) {
      out[arg.slice(2).replace("-", "")] = value;
      index += 1;
    } else {
      usage();
    }
  }

  const { reports, runurl } = out;

  if (reports === undefined || runurl === undefined) {
    usage();
  }

  return { reports, runUrl: runurl };
};

const gh = (args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf-8" }).trim();

// Walk the JSON reporter's suite tree, carrying ancestor titles, and collect
// every spec with a failed/timedOut/interrupted result.
const collectFailures = (
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
      const first = (spec.tests ?? [])
        .flatMap((test) => test.results ?? [])
        .find(
          (result) =>
            result.status !== undefined &&
            Object.hasOwn(BAD_STATUSES, result.status)
        );

      if (first !== undefined) {
        out.push({
          error:
            first.error?.message ?? first.error?.stack ?? "(no error text)",
          file: spec.file ?? suiteFile,
          status: first.status ?? "failed",
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

const main = (): void => {
  const { reports, runUrl } = parseArgs(process.argv.slice(2));

  const dirs = readdirSync(reports, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  const bySpec = new Map<string, Occurrence[]>();
  let filesRead = 0;

  for (const dir of dirs) {
    const match = REPORT_DIR.exec(dir);

    if (match === null || match.groups === undefined) {
      continue;
    }

    const { lane, round, shard } = match.groups;
    const resultsPath = path.join(reports, dir, "e2e-results.json");

    if (!existsSync(resultsPath)) {
      console.log(
        `::warning::no e2e-results.json in ${dir} (lane never ran tests?)`
      );

      continue;
    }

    filesRead += 1;

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

  console.log(
    `read ${filesRead} result file(s), ${bySpec.size} failing spec(s)`
  );

  if (filesRead === 0) {
    console.error("no e2e-results.json found: the lanes never ran tests");

    process.exit(1);
  }

  if (bySpec.size === 0) {
    return;
  }

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

  // SAFETY: `gh issue list --json` always answers an array of issue objects;
  // a CLI or API change fails this job loudly instead of filing blindly.
  const open = JSON.parse(
    gh([
      "issue",
      "list",
      "--label",
      "flake",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "100",
    ])
  ) as OpenIssue[];

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

main();
