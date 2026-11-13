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

import { comparePush } from "./pr-own-change";

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
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...gitEnv(),
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    },
  }).trim();
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

  return git(repo, ["rev-parse", "HEAD"]);
};

// The same commit again on a new history: `git commit --amend` is the
// fixture's stand-in for whatever a rebase did to the commit it replayed.
const amend = (repo: string, files: Record<string, string | Uint8Array>) => {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repo, file), content);
  }

  git(repo, ["add", "--all"]);
  git(repo, ["commit", "-q", "--amend", "--no-edit"]);

  return git(repo, ["rev-parse", "HEAD"]);
};

const head = (repo: string): string => git(repo, ["rev-parse", "HEAD"]);

const checkout = (repo: string, ref: string) => {
  git(repo, ["switch", "-q", "-c", ref]);
};

afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { force: true, recursive: true });
  }
});

// main: base.txt, then a second commit that only adds other.txt. The PR
// branch forks before that second commit and adds pr.txt.
const rebasedFixture = () => {
  const repo = newRepo();
  commit(repo, { "base.txt": "base\n" });
  checkout(repo, "pr");
  const before = commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
  git(repo, ["switch", "-q", "main"]);

  const base = commit(
    repo,
    { "other.txt": "unrelated\n" },
    "main: add other.txt"
  );

  git(repo, ["switch", "-q", "pr"]);

  return { after: before, base, before, repo };
};

const rebasedOnto = (repo: string, base: string): string => {
  git(repo, ["rebase", "-q", base]);

  return head(repo);
};

// A stacked PR: `lower` is the layer below, `upper` the PR. The lower layer
// squash-merges into main (same tree, new commit), and GitHub rebases the
// upper PR onto main and retargets it. Its own change is unchanged.
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

  const before = commit(
    repo,
    { "upper.txt": "one\ntwo\n" },
    "upper: extend upper.txt"
  );

  git(repo, ["switch", "-q", "main"]);
  git(repo, ["merge", "-q", "--squash", lower]);
  const base = commit(repo, {}, "lower (#1)");

  return { after: before, base, before, repo };
};

describe("comparePush", () => {
  test("a rebase onto a base that moved elsewhere keeps the review", () => {
    const { repo, before, base } = rebasedFixture();
    const after = rebasedOnto(repo, base);
    expect(after).not.toBe(before);
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push replays the same 1 commit(s) onto its base",
      same: true,
    });
  });

  test("an empty commit on top of the same change keeps the review", () => {
    const { repo, before, base } = rebasedFixture();
    const after = commit(repo, {}, "empty: re-trigger CI");
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push replays the same 1 commit(s) onto its base",
      same: true,
    });
  });

  test("an edited commit strips the review", () => {
    const { repo, before, base } = rebasedFixture();
    const rebased = rebasedOnto(repo, base);
    const after = amend(repo, { "pr.txt": "v2\n" });
    expect(after).not.toBe(rebased);
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("a conflict resolution that folds base content in strips the review", () => {
    const repo = newRepo();
    commit(repo, { "app.txt": "one\n" });
    checkout(repo, "pr");
    const before = commit(repo, { "app.txt": "one\npr\n" }, "pr: append pr");
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "app.txt": "one\nbase\n" },
      "main: append base"
    );

    git(repo, ["switch", "-q", "pr"]);
    expect(() => git(repo, ["rebase", "-q", "main"])).toThrow();
    // The resolution keeps both sides: a diff that was never reviewed.
    writeFileSync(path.join(repo, "app.txt"), "one\nbase\npr\n");
    git(repo, ["add", "--all"]);
    git(repo, ["rebase", "--continue"]);
    const after = head(repo);
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("a file mode change strips the review", () => {
    const { repo, before, base } = rebasedFixture();
    rebasedOnto(repo, base);
    chmodSync(path.join(repo, "pr.txt"), 0o755);
    const after = amend(repo, {});
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("a binary file's new content strips the review", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");

    const before = commit(
      repo,
      { "blob.bin": new Uint8Array([1, 2, 3]) },
      "pr: add blob"
    );

    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other.txt"
    );

    git(repo, ["switch", "-q", "pr"]);
    rebasedOnto(repo, base);
    const after = amend(repo, { "blob.bin": new Uint8Array([1, 2, 4]) });
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("an added file strips the review", () => {
    const { repo, before, base } = rebasedFixture();
    rebasedOnto(repo, base);

    const after = commit(
      repo,
      { "extra.txt": "sneaked in\n" },
      "pr: add extra"
    );

    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("dropping a commit strips the review", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");
    commit(repo, { "first.txt": "first\n" }, "pr: add first");
    const second = commit(repo, { "second.txt": "second\n" }, "pr: add second");
    const before = second;
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other.txt"
    );

    // Replay only the second commit: a rebase that silently lost the first.
    git(repo, ["switch", "-q", "pr"]);
    git(repo, ["reset", "-q", "--hard", "main~1"]);
    git(repo, ["cherry-pick", second]);
    const after = head(repo);
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push drops 1 commit(s) that are not in the base",
      same: false,
    });
  });

  test("a stacked retarget after the lower layer merges keeps the review", () => {
    const { repo, before, base } = stackedFixture();
    git(repo, ["switch", "-q", "upper"]);
    const after = rebasedOnto(repo, base);
    expect(after).not.toBe(before);
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason:
        "the push drops 1 commit(s) whose change is already in the base (stacked retarget) and replays the remaining 2 unchanged",
      same: true,
    });
  });

  test("a stacked retarget whose upper commit changed strips the review", () => {
    const { repo, before, base } = stackedFixture();
    git(repo, ["switch", "-q", "upper"]);
    rebasedOnto(repo, base);
    const after = amend(repo, { "upper.txt": "one\nthree\n" });
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: "the push changes the PR's own commits",
      same: false,
    });
  });

  test("a merge commit in the PR's own range strips the review", () => {
    const repo = newRepo();
    commit(repo, { "base.txt": "base\n" });
    checkout(repo, "pr");
    commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
    git(repo, ["switch", "-q", "main"]);

    const base = commit(
      repo,
      { "other.txt": "unrelated\n" },
      "main: add other.txt"
    );

    git(repo, ["switch", "-q", "pr"]);
    git(repo, ["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
    const before = head(repo);
    git(repo, ["switch", "-q", "-c", "replayed", base]);
    const after = commit(repo, { "pr.txt": "v1\n" }, "pr: add pr.txt");
    expect(comparePush(repo, { after, base, before })).toEqual({
      reason: expect.stringContaining("contains a merge commit"),
      same: false,
    });
  });

  test("a shallow checkout strips the review instead of guessing", () => {
    const source = newRepo();
    commit(source, { "base.txt": "base\n" });
    checkout(source, "pr");
    commit(source, { "pr.txt": "one\n" }, "pr: add pr.txt");
    commit(source, { "pr.txt": "two\n" }, "pr: extend pr.txt");
    const clone = mkdtempSync(path.join(tmpdir(), "pr-own-change-shallow-"));
    repos.push(clone);
    execFileSync(
      "git",
      ["clone", "-q", "--depth", "2", `file://${source}`, clone],
      {
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    // Two commits are here and nothing older: the guard must answer before
    // merge-base turns the missing history into a wrong fork point.
    const rev = (ref: string): string =>
      execFileSync("git", ["rev-parse", ref], {
        cwd: clone,
        encoding: "utf-8",
        env: gitEnv(),
      }).trim();

    expect(
      comparePush(clone, {
        after: rev("HEAD~1"),
        base: rev("HEAD~1"),
        before: rev("HEAD"),
      })
    ).toEqual({
      reason:
        "the checkout is a shallow clone, so the two heads cannot be compared",
      same: false,
    });
  });

  test("a head missing from the fetched history strips the review", () => {
    const { repo, base } = rebasedFixture();
    const missing = "0123456789abcdef0123456789abcdef01234567";
    expect(comparePush(repo, { after: missing, base, before: base })).toEqual({
      reason: `the after commit (${missing}) is not in the fetched history`,
      same: false,
    });
  });
});
