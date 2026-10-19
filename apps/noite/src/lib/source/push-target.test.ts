import { expect, test } from "bun:test";

import type { BranchRules, GitRefs } from "../runner";
import { editableRef, protectedRef } from "./push-target";

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

test("only a name in the refs list opens editable", () => {
  const known = refs(["main", "staging"]);

  for (const role of ["push", "admin"] as const) {
    expect(editableRef(known, role, "main")).toBe(true);
    expect(editableRef(known, role, "staging")).toBe(true);
    // A tag and a raw commit sha are refs too, but not branches: read-only,
    // whatever the role (and before the refs list has landed).
    expect(editableRef(known, role, "v1.0.0")).toBe(false);
    expect(editableRef(known, role, SHA)).toBe(false);
    expect(editableRef(undefined, role, "main")).toBe(false);
  }

  // A view-only collaborator and an unresolved role stay read-only.
  expect(editableRef(known, "view", "main")).toBe(false);
  expect(editableRef(known, undefined, "main")).toBe(false);
});

test("protection covers the default branch, and admins bypass it", () => {
  const on = rules(true);
  expect(protectedRef(on, "push", "main", "main")).toBe(true);
  // The browsed branch is not the protected one.
  expect(protectedRef(on, "push", "staging", "main")).toBe(false);
  // Admins push to main anyway.
  expect(protectedRef(on, "admin", "main", "main")).toBe(false);
  // Off by default, and a rule the page has not loaded protects nothing.
  expect(protectedRef(rules(false), "push", "main", "main")).toBe(false);
  expect(protectedRef(undefined, "push", "main", "main")).toBe(false);
  // A role still loading is not an admin: offer the new branch.
  expect(protectedRef(on, undefined, "main", "main")).toBe(true);
});
