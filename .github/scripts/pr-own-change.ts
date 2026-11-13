#!/usr/bin/env bun
// Does a push change the pull request's own change?
//
// `security-gate` strips `security-reviewed` on `synchronize` because a new
// diff needs a fresh read. A rebase that replays the same commits onto a
// moved base does not change what the PR does, and neither does the retarget
// GitHub performs when a stacked PR's lower layer squash-merges: the label
// survives those, and only a real change to the PR's own diff strips it.
//
// "Own change" is the sequence of commits the PR adds on top of its merge
// base with its base branch, fingerprinted per commit. A fingerprint is the
// raw record of every path the commit changes — status, resulting mode and
// resulting blob — never patch text: `git patch-id` hashes hunk bodies, so it
// cannot see a file-mode change and cannot see a binary file's content at
// all. Blobs are content-addressed, so a rebase's line-number and context
// shifts cannot enter the comparison while an added, removed, renamed,
// retyped or re-moded path still does.
//
// The second head is the only new information a push carries, and a stacked
// retarget makes its own-change commit list a strict *suffix* of the old one
// (the lower layer's commits become part of the base). Accepting that suffix
// in general would also accept a push that drops a commit, so it is accepted
// only when the dropped prefix is verifiably part of the new base: every path
// it changed has, in the base, exactly the mode and blob it produced.
//
// Everything here is git plumbing over objects the workflow fetched as data.
// Nothing from a PR commit is checked out, and `--no-ext-diff --no-textconv`
// plus the raw format keep a repository's diff drivers out of the run.
//
//   BASE_SHA=… BEFORE_SHA=… AFTER_SHA=… bun .github/scripts/pr-own-change.ts
//
// Writes `same=` and `reason=` to `$GITHUB_OUTPUT` (stdout without it) and
// always exits 0: the gate decides, and it fails closed on anything it cannot
// read.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// One changed path, from `git diff-tree --raw`: its status letter, the mode
// the commit leaves behind, that mode's blob, and the path.
interface RawRecord {
  blob: string;
  mode: string;
  path: string;
  status: string;
}

// A commit's change, as one comparable string. Sorted lines make the order of
// paths inside a commit irrelevant and keep two identical changes equal.
type Fingerprint = string;

// One side of the comparison: the commits the PR adds on top of its merge
// base, fingerprinted in order. `commits` holds the same order with the
// commits that change no path (the conventional empty push) dropped, and
// `mergeBase` is where the PR's own change starts on this side.
interface OwnChange {
  commits: string[];
  fingerprints: Fingerprint[];
  mergeBase: string;
}

export interface Verdict {
  reason: string;
  same: boolean;
}

export interface PushHeads {
  after: string;
  base: string;
  before: string;
}

// Raw records only: no patch text, and no diff driver or textconv from the
// checked-out commit can run.
const RAW_DIFF = [
  "diff-tree",
  "-r",
  "--raw",
  "--no-abbrev",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
] as const;

const run = (repo: string, args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repo,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const commitExists = (repo: string, rev: string): boolean => {
  if (rev === "") {
    return false;
  }

  try {
    run(repo, ["cat-file", "-e", `${rev}^{commit}`]);

    return true;
  } catch {
    return false;
  }
};

const parseRecords = (output: string): RawRecord[] => {
  const records: RawRecord[] = [];

  for (const line of output.split("\n")) {
    if (line === "") {
      continue;
    }

    const tab = line.indexOf("\t");

    if (!line.startsWith(":") || tab === -1) {
      throw new Error(`unexpected raw diff line: ${line}`);
    }

    const [, mode, , blob, status] = line.slice(1, tab).split(" ");
    records.push({
      blob,
      mode,
      path: line.slice(tab + 1),
      status: status.charAt(0),
    });
  }

  return records;
};

const ownChange = (repo: string, base: string, head: string): OwnChange => {
  const mergeBase = run(repo, ["merge-base", base, head]);

  if (mergeBase === "") {
    throw new Error(`${base} and ${head} share no history`);
  }

  const range = `${mergeBase}..${head}`;

  // A merge commit inside the range has no single parent to diff against, so
  // it cannot be compared commit by commit: report it as unreadable.
  if (run(repo, ["rev-list", "--merges", range]) !== "") {
    throw new Error(`${range} contains a merge commit`);
  }

  const commits: string[] = [];
  const fingerprints: Fingerprint[] = [];

  for (const sha of run(repo, ["rev-list", "--reverse", range])
    .split("\n")
    .filter((line) => line !== "")) {
    const fingerprint = parseRecords(
      run(repo, [...RAW_DIFF, "--no-commit-id", sha])
    )
      .map(
        (record) =>
          `${record.status} ${record.mode} ${record.blob} ${record.path}`
      )
      .toSorted()
      .join("\n");

    if (fingerprint !== "") {
      commits.push(sha);
      fingerprints.push(fingerprint);
    }
  }

  return { commits, fingerprints, mergeBase };
};

const treeEntry = (
  repo: string,
  rev: string,
  file: string
): { blob: string; mode: string } | null => {
  const output = run(repo, ["ls-tree", rev, "--", file]);

  if (output === "") {
    return null;
  }

  const [meta] = output.split("\t");
  const [mode, , blob] = meta.split(" ");

  return { blob, mode };
};

// Is everything the dropped prefix commits changed already in the new base,
// with the same content? That is what a stacked PR's lower layer merging
// leaves behind: the squash commit carries the layer's tree.
const prefixAbsorbed = (
  repo: string,
  base: string,
  boundary: string,
  prefixTip: string
): boolean => {
  for (const record of parseRecords(
    run(repo, [...RAW_DIFF, boundary, prefixTip])
  )) {
    const entry = treeEntry(repo, base, record.path);

    if (record.status === "D") {
      if (entry !== null) {
        return false;
      }

      continue;
    }

    if (
      entry === null ||
      entry.mode !== record.mode ||
      entry.blob !== record.blob
    ) {
      return false;
    }
  }

  return true;
};

const equalLists = (
  a: readonly Fingerprint[],
  b: readonly Fingerprint[]
): boolean =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

// Compare the PR's own change before and after the push.
export const comparePush = (repo: string, heads: PushHeads): Verdict => {
  const { base, before, after } = heads;

  const sides = [
    ["base", base],
    ["before", before],
    ["after", after],
  ] as const;

  for (const [name, sha] of sides) {
    if (!commitExists(repo, sha)) {
      return {
        reason: `the ${name} commit (${sha || "none"}) is not in the fetched history`,
        same: false,
      };
    }
  }

  if (before === after) {
    return { reason: "the push left the head at the same commit", same: true };
  }

  // A shallow history stops at the checkout commit, so merge-base would
  // answer with the wrong fork point instead of failing: refuse.
  if (run(repo, ["rev-parse", "--is-shallow-repository"]) === "true") {
    return {
      reason:
        "the checkout is a shallow clone, so the two heads cannot be compared",
      same: false,
    };
  }

  let afterSide: OwnChange;
  let beforeSide: OwnChange;

  try {
    afterSide = ownChange(repo, base, after);
    beforeSide = ownChange(repo, base, before);
  } catch (error) {
    return {
      reason: `cannot compare the two heads: ${error instanceof Error ? error.message : String(error)}`,
      same: false,
    };
  }

  if (afterSide.fingerprints.length === 0) {
    return { reason: "the PR adds no commit on top of its base", same: false };
  }

  if (equalLists(beforeSide.fingerprints, afterSide.fingerprints)) {
    return {
      reason: `the push replays the same ${afterSide.fingerprints.length} commit(s) onto its base`,
      same: true,
    };
  }

  const dropped =
    beforeSide.fingerprints.length - afterSide.fingerprints.length;

  const replaysTail =
    dropped > 0 &&
    equalLists(beforeSide.fingerprints.slice(dropped), afterSide.fingerprints);

  if (replaysTail) {
    const prefixTip = beforeSide.commits[dropped - 1];

    if (
      prefixTip !== undefined &&
      prefixAbsorbed(repo, base, beforeSide.mergeBase, prefixTip)
    ) {
      return {
        reason: `the push drops ${dropped} commit(s) whose change is already in the base (stacked retarget) and replays the remaining ${afterSide.fingerprints.length} unchanged`,
        same: true,
      };
    }

    return {
      reason: `the push drops ${dropped} commit(s) that are not in the base`,
      same: false,
    };
  }

  return {
    reason: "the push changes the PR's own commits",
    same: false,
  };
};

const main = (): void => {
  const repo = process.env.GITHUB_WORKSPACE ?? process.cwd();
  let verdict: Verdict;

  try {
    verdict = comparePush(repo, {
      after: process.env.AFTER_SHA ?? "",
      base: process.env.BASE_SHA ?? "",
      before: process.env.BEFORE_SHA ?? "",
    });
  } catch (error) {
    verdict = {
      reason: `comparison failed: ${error instanceof Error ? error.message : String(error)}`,
      same: false,
    };
  }

  const output = `same=${verdict.same}\nreason=${verdict.reason.replaceAll("\n", " ")}\n`;
  const target = process.env.GITHUB_OUTPUT;

  if (target) {
    appendFileSync(target, output);
  } else {
    process.stdout.write(output);
  }

  process.stdout.write(
    `pr-own-change: ${verdict.reason} (same=${verdict.same})\n`
  );
};

if (import.meta.main) {
  main();
}
