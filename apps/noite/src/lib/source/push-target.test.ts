import { expect, test } from "bun:test";

import type { BranchRules, GitRefs } from "../runner";
import { refAccess } from "./push-target";

const SHA = "a".repeat(40);

const refs = (names: readonly string[]): GitRefs => ({
  branches: names.map((name) => ({
    ahead: 0,
    authorName: "Ryuz",
    behind: 0,
    committedAt: 0,
    name,
    sha: SHA,
    subject: "init",
  })),
  defaultBranch: "main",
  deployedSha: null,
});

const rules = (requirePr: boolean): BranchRules => ({
  requirePr,
  requiredApprovals: 0,
});

const readOnly = (
  known: GitRefs | undefined,
  rule: BranchRules | undefined,
  role: "view" | "push" | "admin" | undefined,
  ref: string
) => refAccess(known, rule, role, ref, "main").readOnly;

test("only a name in the refs list opens editable", () => {
  const known = refs(["main", "staging"]);

  for (const role of ["push", "admin"] as const) {
    expect(readOnly(known, undefined, role, "main")).toBe("");
    expect(readOnly(known, undefined, role, "staging")).toBe("");
    // A tag and a raw commit sha are refs too, but not branches: read-only,
    // whatever the role (and before the refs list has landed).
    expect(readOnly(known, undefined, role, "v1.0.0")).toBe("tag");
    expect(readOnly(known, undefined, role, SHA)).toBe("commit");
  }

  // A view-only collaborator, and an unresolved role, stay read-only.
  expect(readOnly(known, undefined, "view", "main")).toBe("role");
  expect(readOnly(known, undefined, undefined, "main")).toBe("role");
  // A ref the refs list does not hold cannot be a branch, whoever asks.
  expect(readOnly(undefined, undefined, "admin", "main")).toBe("tag");
});

test("protection covers the default branch, and admins bypass it", () => {
  const on = rules(true);
  const known = refs(["main", "staging"]);

  const commit = (
    rule: BranchRules | undefined,
    role: "view" | "push" | "admin" | undefined,
    ref: string
  ) => refAccess(known, rule, role, ref, "main").commit;

  expect(commit(on, "push", "main")).toBe("pr-only");
  // The browsed branch is not the protected one.
  expect(commit(on, "push", "staging")).toBe("direct");
  // Admins push to main anyway.
  expect(commit(on, "admin", "main")).toBe("direct");
  // Off by default, and a rule the page has not loaded protects nothing.
  expect(commit(rules(false), "push", "main")).toBe("direct");
  expect(commit(undefined, "push", "main")).toBe("direct");
  // A role still loading is not an admin: offer the new branch.
  expect(commit(on, undefined, "main")).toBe("pr-only");
});

test("editable and protected are two answers, not one", () => {
  // Editing works on a branch protection covers: protection only decides where
  // the commit goes.
  const access = refAccess(refs(["main"]), rules(true), "push", "main", "main");

  expect(access.readOnly).toBe("");
  expect(access.commit).toBe("pr-only");
});
