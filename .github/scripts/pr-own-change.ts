#!/usr/bin/env bun
// The `security-gate` review record: what was reviewed, and is this push still
// that change?
//
// `security-reviewed` is a human assertion about one diff. A rebase does not
// change the diff, so the label should survive it — but only when the gate can
// prove the diff is the one the reviewer read. `github.event.before` cannot
// prove that: a cancelled run (two quick pushes into `cancel-in-progress`)
// never strips the label, so "the previous head" can itself be an unreviewed
// head, and the next push would compare two unreviewed heads. The reviewed
// state is recorded instead:
//
//   - A run that establishes trust (`labeled`, or the first labelled run of a
//     PR that predates this gate) writes a marker comment: the reviewed head,
//     its merge base, and the sha256 of its own-change fingerprint list. Only
//     github-actions[bot] writes it, and only an unedited bot comment is
//     trusted — a same-repo agent shares a write token, so trust is anchored
//     on something only the workflow can produce.
//   - Every later push (`synchronize`), base retarget (`edited`), reopen or
//     ready-for-review recomputes the recorded list from the recorded head and
//     compares it with the current own change. Equal keeps the label; a longer
//     current list is accepted only when the extra leading prefix is already
//     in the base with the same modes and blobs (the stacked retarget a lower
//     layer's squash merge leaves behind). Anything else — or anything
//     unreadable — strips.
//   - The merge queue checks every queued PR's label against its marker
//     instead of passing blindly.
//
// Own change is the commits on top of `merge-base(head, base.sha)`,
// fingerprinted per commit as the sorted set of `(status, resulting mode,
// resulting blob, path)` from `diff-tree --raw -z`. Never patch text: `git
// patch-id` hashes hunk bodies, so it cannot see a file-mode change and cannot
// see a binary file's content at all. Blobs are content-addressed, so a
// rebase's line numbers and context cannot enter while an added, removed,
// renamed, re-moded or binary-changed path still does. NUL-separated records
// and `-z` trees keep a path exact: nothing is trimmed and no path is ever
// read as a pathspec.
//
// Threat model: same-repo agents share a write token, so this guards against
// an *accidental* bypass by an honest agent (a cancelled run, a failed label
// delete, a forgotten retarget) and against a silently changed diff. A
// same-repo workflow edit can still forge any of this — the pre-existing
// residual documented in the workflow header.
//
//   BASE_SHA=… HEAD_SHA=… EVENT_ACTION=synchronize GH_TOKEN=… \
//     bun .github/scripts/pr-own-change.ts
//   MERGE_GROUP_HEAD_REF=… MERGE_GROUP_PRS=… \
//     bun .github/scripts/pr-own-change.ts --merge-group
//
// Prints `keep: …` or `strip: …` (one line, for the step summary) and exits
// 0/1. Everything unreadable exits 1: the gate fails closed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const BOT_LOGIN = "github-actions[bot]";
const MARKER_PREFIX = "<!-- security-gate:reviewed ";
const MARKER_VERSION = 1;
const MAX_BUFFER = 64 * 1024 * 1024;

// One changed path, from `git diff-tree --raw -z`: its status letter, the mode
// the commit leaves behind, that mode's blob, and the path.
interface RawRecord {
  blob: string;
  mode: string;
  path: string;
  status: string;
}

// A commit's change, as one comparable string: its raw records, sorted, so the
// order of paths inside a commit is irrelevant and two identical changes are
// equal. Newline-joined, because a record's path cannot contain a NUL.
type Fingerprint = string;

// The recorded reviewed state, parsed out of a marker comment.
export interface Marker {
  base: string;
  digest: string;
  fork: string;
  head: string;
}

export interface OwnChange {
  // Non-empty commits of the range, aligned with `fingerprints`.
  commits: string[];
  fingerprints: Fingerprint[];
  fork: string;
}

export interface Verdict {
  keep: boolean;
  reason: string;
}

export interface Comment {
  body: string;
  created: string;
  id: number;
  login: string;
  updated: string;
}

export interface Trusted {
  marker: Marker | null;
  reason: string;
}

export type ComparisonVerdict = "different" | "equal" | "prefix";

export interface Comparison {
  prefix: number;
  reason: string;
  verdict: ComparisonVerdict;
}

export interface QueuedPull {
  head: string;
  number: number;
}

export interface QueuedCheck {
  head: string;
  labels: readonly string[];
  marker: Marker | null;
  number: number;
}

// `record` is the only way trust is established; `verify` compares a later
// event with the record; `none` keeps the label without touching the record.
export type Mode = "none" | "record" | "verify";

const isSha = (value: string | null): value is string =>
  value !== null && /^[0-9a-f]{40}$/u.test(value);

const isDigest = (value: string | null): value is string =>
  value !== null && /^[0-9a-f]{64}$/u.test(value);

const short = (sha: string): string => sha.slice(0, 7);

// --- the reviewed-state marker (pure) --------------------------------------

interface MarkerPayload {
  base?: string;
  digest?: string;
  fork?: string;
  head?: string;
  v?: number;
}

// The marker's JSON, or null when the body is not one. Every field is
// re-validated: a number, a short string, a missing field or a non-object all
// come back as null.
export const parseMarker = (body: string): Marker | null => {
  if (!body.startsWith(MARKER_PREFIX)) {
    return null;
  }

  const end = body.indexOf(" -->", MARKER_PREFIX.length);

  if (end === -1) {
    return null;
  }

  try {
    // SAFETY: `body` is a comment the workflow wrote; the sha and digest
    // regexes below re-validate every field it carries, and a payload that is
    // not an object throws into the catch.
    const parsed = JSON.parse(
      body.slice(MARKER_PREFIX.length, end)
    ) as MarkerPayload;

    const base = String(parsed.base ?? "");
    const digest = String(parsed.digest ?? "");
    const fork = String(parsed.fork ?? "");
    const head = String(parsed.head ?? "");

    if (parsed.v !== MARKER_VERSION) {
      return null;
    }

    if (!(isSha(base) && isDigest(digest) && isSha(fork) && isSha(head))) {
      return null;
    }

    return { base, digest, fork, head };
  } catch {
    return null;
  }
};

export const markerBody = (marker: Marker): string =>
  `${MARKER_PREFIX}${JSON.stringify({ ...marker, v: MARKER_VERSION })} -->\n\n` +
  `\`security-gate\`: the sensitive diff was reviewed at head \`${short(marker.head)}\` ` +
  `(own change \`${marker.digest.slice(0, 12)}\`). A push that replays exactly that ` +
  "change keeps `security-reviewed`; anything else strips it. The newest marker wins.";

// The newest marker is the only one that counts, and only if github-actions
// wrote it and never edited it: an edited or unreadable newest marker is a
// strip, never a fall back to an older one.
export const trustMarker = (comments: readonly Comment[]): Trusted => {
  const candidates = comments.filter(
    (entry) => entry.login === BOT_LOGIN && entry.body.startsWith(MARKER_PREFIX)
  );

  if (candidates.length === 0) {
    return {
      marker: null,
      reason: "no reviewed state was recorded for this PR",
    };
  }

  const newest = candidates.toSorted((a, b) => a.id - b.id).at(-1);

  if (newest === undefined) {
    return {
      marker: null,
      reason: "no reviewed state was recorded for this PR",
    };
  }

  if (newest.updated !== newest.created) {
    return {
      marker: null,
      reason:
        "the newest reviewed-state comment was edited after it was written",
    };
  }

  const marker = parseMarker(newest.body);

  if (marker === null) {
    return {
      marker: null,
      reason:
        "the newest reviewed-state comment is unreadable (an older gate, or not ours)",
    };
  }

  return { marker, reason: `reviewed head ${short(marker.head)}` };
};

// --- what a run should do (pure) -------------------------------------------

// Only a human `labeled` action establishes trust, plus the first labelled run
// of a PR that predates this gate (no marker yet). A push, a base retarget, a
// reopen and a ready-for-review all verify against the record: a closed PR can
// receive pushes no workflow consumes, so a reopen must not re-record.
export const chooseMode = (input: {
  action: string;
  baseChanged: boolean;
  head: string;
  marker: Marker | null;
}): Mode => {
  const { action, baseChanged, head, marker } = input;

  if (action === "labeled") {
    return marker?.head === head ? "none" : "record";
  }

  if (action === "synchronize") {
    return "verify";
  }

  if (action === "edited") {
    return baseChanged ? "verify" : "none";
  }

  if (marker === null) {
    return "record";
  }

  return marker.head === head ? "none" : "verify";
};

// Where the current own-change list stands against the recorded one: equal,
// the recorded list after a leading prefix (a retarget that exposed the old
// base's commits), or a different change.
export const compareLists = (
  recorded: readonly Fingerprint[],
  current: readonly Fingerprint[]
): Comparison => {
  const equal =
    recorded.length === current.length &&
    recorded.every((entry, index) => entry === current[index]);

  if (equal) {
    return {
      prefix: 0,
      reason: "the push replays exactly the reviewed change",
      verdict: "equal",
    };
  }

  const prefix = current.length - recorded.length;

  if (
    recorded.length > 0 &&
    prefix > 0 &&
    recorded.every((entry, index) => entry === current[prefix + index])
  ) {
    return {
      prefix,
      reason: `the change now starts with ${prefix} commit(s) the base gained`,
      verdict: "prefix",
    };
  }

  return {
    prefix: 0,
    reason: "the PR's own change differs from the reviewed one",
    verdict: "different",
  };
};

// --- the merge queue (pure) ------------------------------------------------

interface QueuedPayloadPull {
  head?: { sha?: string };
  number?: number;
}

const queuedFromPayload = (pullRequestsJson: string): QueuedPull[] => {
  try {
    // SAFETY: the workflow passes `toJSON(github.event.merge_group
    // .pull_requests)`; the number and head sha are re-validated below and a
    // payload that is not a list throws into the catch.
    const payload = JSON.parse(pullRequestsJson) as QueuedPayloadPull[];
    const pulls: QueuedPull[] = [];

    for (const entry of payload) {
      const number = Number(entry.number);
      const head = String(entry.head?.sha ?? "");

      if (Number.isSafeInteger(number) && isSha(head)) {
        pulls.push({ head, number });
      }
    }

    return pulls;
  } catch {
    return [];
  }
};

const queuedFromHeadRef = (headRef: string): QueuedPull[] => {
  const pulls: QueuedPull[] = [];

  for (const match of headRef.matchAll(
    /pr-(?<number>\d+)-(?<head>[0-9a-f]{40})/gu
  )) {
    const number = Number(match.groups?.number);
    const head = String(match.groups?.head ?? "");

    if (Number.isSafeInteger(number) && isSha(head)) {
      pulls.push({ head, number });
    }
  }

  return pulls;
};

// The queued PRs: the payload's list when it has one, else the head ref
// (`gh-readonly-queue/<base>/pr-<n>-<sha>`, whose sha is the PR's head).
export const queuedPulls = (
  pullRequestsJson: string,
  headRef: string
): QueuedPull[] => {
  const fromPayload = queuedFromPayload(pullRequestsJson);

  return fromPayload.length > 0 ? fromPayload : queuedFromHeadRef(headRef);
};

// What, if anything, blocks this queued PR: it must still carry the label it
// was reviewed with, and that label must cover exactly the queued head.
export const queuedProblem = (check: QueuedCheck): string | null => {
  // `security-sensitive` is the gate's own sticky record that this PR touched
  // sensitive paths; a label added by hand to an unrelated PR stays inert.
  if (!check.labels.includes("security-sensitive")) {
    return null;
  }

  const reviewed = check.labels.includes("security-reviewed");

  if (!reviewed) {
    return `#${check.number} is sensitive but no longer carries \`security-reviewed\``;
  }

  if (check.marker === null) {
    return `#${check.number} carries \`security-reviewed\` with no recorded reviewed change`;
  }

  if (check.marker.head !== check.head) {
    return `#${check.number} was reviewed at ${short(check.marker.head)}, not the queued ${short(check.head)}`;
  }

  return null;
};

// --- git plumbing ----------------------------------------------------------

const RAW_DIFF = [
  "diff-tree",
  "-r",
  "--raw",
  "-z",
  "--no-abbrev",
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
] as const;

// No trimming anywhere: a path may end in a space, and `-z` output needs none.
const run = (repo: string, args: readonly string[]): string =>
  execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: repo,
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });

// Records come in `:<meta>\0<path>\0` pairs with `-z`: no C-quoting, so a
// trailing space, a tab or a non-ASCII byte in a path survives intact.
const parseRecords = (output: string): RawRecord[] => {
  const records: RawRecord[] = [];
  let meta: string | null = null;

  for (const value of output.split("\0")) {
    if (meta === null) {
      meta = value;
      continue;
    }

    const path = value;

    if (meta === "") {
      if (path !== "") {
        throw new Error("unexpected raw diff record");
      }

      continue;
    }

    if (!meta.startsWith(":")) {
      throw new Error(`unexpected raw diff record: ${meta.slice(0, 80)}`);
    }

    const [, mode, , blob, status] = meta.slice(1).split(" ");

    records.push({ blob, mode, path, status: status.charAt(0) });
    meta = null;
  }

  if (meta !== null && meta !== "") {
    throw new Error("incomplete raw diff record");
  }

  return records;
};

const recordLine = (record: RawRecord): Fingerprint =>
  `${record.status} ${record.mode} ${record.blob} ${record.path}`;

const commitFingerprint = (repo: string, sha: string): Fingerprint =>
  parseRecords(run(repo, [...RAW_DIFF, "--no-commit-id", sha]))
    .map(recordLine)
    .toSorted()
    .join("\n");

const commitExists = (repo: string, rev: string): boolean => {
  if (!isSha(rev)) {
    return false;
  }

  try {
    run(repo, ["cat-file", "-e", `${rev}^{commit}`]);

    return true;
  } catch {
    return false;
  }
};

export const digestOf = (fingerprints: readonly Fingerprint[]): string =>
  createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex");

// The commits of `fork..head`, oldest first, with the ones that change no path
// (the conventional empty push) left out. A merge commit has no single parent
// to diff against, so a range holding one is unreadable.
const rangeCommits = (repo: string, fork: string, head: string): string[] => {
  const range = `${fork}..${head}`;

  if (run(repo, ["rev-list", "--merges", range]).trim() !== "") {
    throw new Error(`${range} contains a merge commit`);
  }

  return run(repo, ["rev-list", "--reverse", range])
    .split("\n")
    .filter((line) => line !== "");
};

// The PR's own change between a known fork point and a head.
export const ownChangeBetween = (
  repo: string,
  fork: string,
  head: string
): OwnChange => {
  const commits: string[] = [];
  const fingerprints: Fingerprint[] = [];

  for (const sha of rangeCommits(repo, fork, head)) {
    const fingerprint = commitFingerprint(repo, sha);

    if (fingerprint !== "") {
      commits.push(sha);
      fingerprints.push(fingerprint);
    }
  }

  return { commits, fingerprints, fork };
};

// The PR's own change as the gate sees it: the commits on top of its merge
// base with the base commit.
export const ownChange = (
  repo: string,
  base: string,
  head: string
): OwnChange => {
  // A shallow history stops at the checkout commit, so merge-base would answer
  // with the wrong fork point instead of failing: refuse. `ensureCommits`
  // deepens the checkout before any decision.
  if (isShallow(repo)) {
    throw new Error("the checkout is a shallow clone");
  }

  const [mergeBase] = run(repo, ["merge-base", base, head]).trim().split("\n");

  if (!isSha(mergeBase)) {
    throw new Error(`${base} and ${head} share no single merge base`);
  }

  return ownChangeBetween(repo, mergeBase, head);
};

// `ls-tree -r` as an exact path map: no pathspec (a path from a PR commit is a
// literal name, not a glob) and no C-quoting, so a lookup can neither match a
// different path nor miss the one that was changed.
const treeEntries = (
  repo: string,
  rev: string
): Map<string, { blob: string; mode: string }> => {
  const entries = new Map<string, { blob: string; mode: string }>();

  for (const entry of run(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    rev,
  ]).split("\0")) {
    if (entry === "") {
      continue;
    }

    const tab = entry.indexOf("\t");

    if (tab === -1) {
      throw new Error(`unexpected ls-tree record: ${entry.slice(0, 80)}`);
    }

    const [mode, , blob] = entry.slice(0, tab).split(" ");

    entries.set(entry.slice(tab + 1), { blob, mode });
  }

  return entries;
};

// Is every path the leading prefix commits changed already in `base` with the
// same mode and blob? That is what a lower layer's squash merge leaves behind.
export const prefixAbsorbed = (
  repo: string,
  base: string,
  prefix: readonly string[]
): boolean => {
  const [first] = prefix;
  const last = prefix.at(-1);

  if (first === undefined || last === undefined) {
    return false;
  }

  const boundary = run(repo, ["rev-parse", `${first}^`]).trim();
  const tree = treeEntries(repo, base);

  for (const record of parseRecords(run(repo, [...RAW_DIFF, boundary, last]))) {
    const entry = tree.get(record.path);

    if (record.status === "D") {
      if (entry !== undefined) {
        return false;
      }

      continue;
    }

    if (
      entry === undefined ||
      entry.mode !== record.mode ||
      entry.blob !== record.blob
    ) {
      return false;
    }
  }

  return true;
};

const isShallow = (repo: string): boolean =>
  run(repo, ["rev-parse", "--is-shallow-repository"]).trim() === "true";

// Fetch objects with the job token in the environment, never in argv. A
// missing object throws and the caller fails closed.
const fetchObjects = (repo: string, args: readonly string[]): void => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const authorization = process.env.GIT_AUTHORIZATION ?? "";

  if (authorization !== "") {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraheader";
    env.GIT_CONFIG_VALUE_0 = authorization;
  }

  execFileSync(
    "git",
    ["-c", "core.quotepath=false", "fetch", "--no-tags", ...args],
    {
      cwd: repo,
      env,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
};

// Make sure the commits a decision needs are readable locally: a depth-1
// checkout cannot answer merge-base, and the recorded head is usually not in
// it either.
const ensureCommits = (repo: string, shas: readonly string[]): void => {
  if (isShallow(repo)) {
    fetchObjects(repo, [
      "--unshallow",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  }

  const missing = shas.filter((sha) => isSha(sha) && !commitExists(repo, sha));

  if (missing.length > 0) {
    fetchObjects(repo, ["origin", ...missing]);
  }
};

// --- the two decisions -----------------------------------------------------

// The marker for a state a human just reviewed: its own change, hashed so a
// later run can prove the recorded head still produces it.
export const reviewedMarker = (
  repo: string,
  base: string,
  head: string
): Marker | null => {
  const own = ownChange(repo, base, head);

  if (own.commits.length === 0) {
    return null;
  }

  return {
    base,
    digest: digestOf(own.fingerprints),
    fork: own.fork,
    head,
  };
};

// What a later event must pass: the recorded head still reproduces its digest,
// and the current own change is that same list — exactly, or with a leading
// prefix the current base has absorbed.
export const verifyReviewed = (input: {
  absorbed: (prefix: readonly string[]) => boolean;
  current: OwnChange;
  marker: Marker;
  recorded: OwnChange;
}): Verdict => {
  const { absorbed, current, marker, recorded } = input;

  if (digestOf(recorded.fingerprints) !== marker.digest) {
    return {
      keep: false,
      reason: `the recorded head ${short(marker.head)} does not reproduce its recorded digest`,
    };
  }

  const comparison = compareLists(recorded.fingerprints, current.fingerprints);

  if (comparison.verdict === "different") {
    return {
      keep: false,
      reason: `${comparison.reason} (reviewed ${short(marker.head)})`,
    };
  }

  if (
    comparison.verdict === "prefix" &&
    !absorbed(current.commits.slice(0, comparison.prefix))
  ) {
    return {
      keep: false,
      reason: `the change gained ${comparison.prefix} commit(s) that are not in the base`,
    };
  }

  return { keep: true, reason: comparison.reason };
};

// --- the GitHub side (impure) ----------------------------------------------

const gh = (args: readonly string[], input?: string): string =>
  execFileSync("gh", args, {
    encoding: "utf-8",
    input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

interface CommentPayload {
  body?: string;
  created?: string;
  id?: number;
  login?: string;
  updated?: string;
}

const readComment = (line: string): Comment | null => {
  try {
    // SAFETY: the `--jq` projection in `readComments` emits exactly these
    // fields; anything else fails the id check or reads as "undefined".
    const parsed = JSON.parse(line) as CommentPayload;
    const id = Number(parsed.id);

    if (!Number.isSafeInteger(id)) {
      return null;
    }

    return {
      body: String(parsed.body),
      created: String(parsed.created),
      id,
      login: String(parsed.login),
      updated: String(parsed.updated),
    };
  } catch {
    return null;
  }
};

const readComments = (repo: string, pull: number): Comment[] => {
  const output = gh([
    "api",
    "--paginate",
    `repos/${repo}/issues/${pull}/comments`,
    "--jq",
    ".[] | {id, login: .user.login, created: .created_at, updated: .updated_at, body}",
  ]);

  const comments: Comment[] = [];

  for (const line of output.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const comment = readComment(line);

    if (comment === null) {
      throw new Error(`unreadable comment listing for #${pull}`);
    }

    comments.push(comment);
  }

  return comments;
};

const readLabels = (repo: string, pull: number): string[] =>
  gh(["api", `repos/${repo}/issues/${pull}/labels`, "--jq", ".[].name"])
    .split("\n")
    .filter((line) => line !== "");

const postMarker = (repo: string, pull: number, marker: Marker): void => {
  gh(
    [
      "api",
      `repos/${repo}/issues/${pull}/comments`,
      "-X",
      "POST",
      "--input",
      "-",
    ],
    JSON.stringify({ body: markerBody(marker) })
  );
};

// --- the two entry points --------------------------------------------------

const environment = (name: string): string => process.env[name] ?? "";

const messageOf = (error: Error | string): string =>
  error instanceof Error ? error.message : error;

const runPullRequest = (repo: string, checkout: string): Verdict => {
  const pull = Number(environment("PR_NUMBER"));
  const base = environment("BASE_SHA");
  const head = environment("HEAD_SHA");
  const action = environment("EVENT_ACTION");
  const baseChanged = environment("BASE_CHANGED") === "true";

  if (
    !(Number.isSafeInteger(pull) && pull > 0) ||
    !(isSha(base) && isSha(head))
  ) {
    return {
      keep: false,
      reason: "the event does not carry a pull request, base and head",
    };
  }

  const trusted = trustMarker(readComments(repo, pull));

  const mode = chooseMode({
    action,
    baseChanged,
    head,
    marker: trusted.marker,
  });

  if (mode === "none") {
    return { keep: true, reason: `no comparison needed (${trusted.reason})` };
  }

  if (mode === "record") {
    ensureCommits(checkout, [base, head]);
    const marker = reviewedMarker(checkout, base, head);

    if (marker === null) {
      return {
        keep: false,
        reason: "the PR adds no commit on top of its base",
      };
    }

    postMarker(repo, pull, marker);

    return {
      keep: true,
      reason: `recorded the reviewed change at ${short(head)}`,
    };
  }

  if (trusted.marker === null) {
    return { keep: false, reason: trusted.reason };
  }

  ensureCommits(checkout, [base, head, trusted.marker.head]);

  const current = ownChange(checkout, base, head);

  const verdict = verifyReviewed({
    absorbed: (prefix) => prefixAbsorbed(checkout, base, prefix),
    current,
    marker: trusted.marker,
    recorded: ownChangeBetween(
      checkout,
      trusted.marker.fork,
      trusted.marker.head
    ),
  });

  if (!verdict.keep) {
    return verdict;
  }

  postMarker(repo, pull, {
    base,
    digest: digestOf(current.fingerprints),
    fork: current.fork,
    head,
  });

  return {
    keep: true,
    reason: `${verdict.reason}; recorded at ${short(head)}`,
  };
};

const runMergeGroup = (repo: string): Verdict => {
  const queued = queuedPulls(
    environment("MERGE_GROUP_PRS"),
    environment("MERGE_GROUP_HEAD_REF")
  );

  if (queued.length === 0) {
    return {
      keep: false,
      reason: "cannot identify the pull request(s) in this queue entry",
    };
  }

  for (const pull of queued) {
    const problem = queuedProblem({
      head: pull.head,
      labels: readLabels(repo, pull.number),
      marker: trustMarker(readComments(repo, pull.number)).marker,
      number: pull.number,
    });

    if (problem !== null) {
      return { keep: false, reason: problem };
    }
  }

  return {
    keep: true,
    reason: `queued ${queued.map((pull) => `#${pull.number}`).join(", ")} still ${queued.length === 1 ? "carries" : "carry"} the reviewed state`,
  };
};

const main = (): number => {
  const repo = environment("GITHUB_REPOSITORY");
  const checkout = environment("GITHUB_WORKSPACE") || process.cwd();
  let verdict: Verdict;

  try {
    if (repo === "") {
      throw new Error("GITHUB_REPOSITORY is not set");
    }

    verdict = process.argv.includes("--merge-group")
      ? runMergeGroup(repo)
      : runPullRequest(repo, checkout);
  } catch (error) {
    verdict = {
      keep: false,
      reason: `the gate could not read the reviewed state: ${messageOf(
        error instanceof Error ? error : String(error)
      )}`,
    };
  }

  process.stdout.write(
    `${verdict.keep ? "keep" : "strip"}: ${verdict.reason}\n`
  );

  return verdict.keep ? 0 : 1;
};

if (import.meta.main) {
  process.exit(main());
}
