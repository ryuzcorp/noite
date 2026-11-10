import { describe, expect, test } from "bun:test";

import { createInputOf, validateNewPr } from "./new-pr";
import type { NewPrInput } from "./new-pr";

const input = (over: Partial<NewPrInput> = {}): NewPrInput => ({
  base: "main",
  branchNames: ["main", "feat"],
  compare: { ahead: 2, kind: "ready" },
  existingNumber: undefined,
  head: "feat",
  title: "Add a thing",
  ...over,
});

describe("new pull request validation", () => {
  test("a ready form has no reasons and builds one body", () => {
    expect(validateNewPr(input())).toEqual([]);
    expect(createInputOf({ ...input(), body: " why " })).toEqual({
      base: "main",
      body: "why",
      head: "feat",
      title: "Add a thing",
    });
  });

  test("an open pull for the pair blocks the submit itself", () => {
    // P1 fail-before: the duplicate pair disabled Create but the submit guard
    // returned null, so a submit that bypassed the button created a second
    // pull request for the same branches.
    const duplicate = input({ existingNumber: 4 });

    expect(validateNewPr(duplicate)).toEqual([
      { _tag: "Duplicate", number: 4 },
    ]);
    expect(createInputOf({ ...duplicate, body: "" })).toBeNull();
  });

  test("a pending or failed compare blocks the submit", () => {
    // Fail-before: `ahead === undefined` passed every rule, so the user could
    // submit before the compare landed.
    expect(validateNewPr(input({ compare: { kind: "loading" } }))).toEqual([
      { _tag: "ComparePending" },
    ]);
    expect(validateNewPr(input({ compare: { kind: "failed" } }))).toEqual([
      { _tag: "CompareFailed" },
    ]);
    expect(
      createInputOf({ ...input({ compare: { kind: "loading" } }), body: "" })
    ).toBeNull();
  });

  test("branch, commit and title rules are one list", () => {
    expect(
      validateNewPr(input({ base: "main", branchNames: ["main"], title: "" }))
    ).toEqual([{ _tag: "NoBranches" }, { _tag: "TitleMissing" }]);
    expect(validateNewPr(input({ compare: null, head: "" }))).toEqual([
      { _tag: "PickBranches" },
    ]);
    expect(
      validateNewPr(input({ compare: { ahead: 0, kind: "ready" } }))
    ).toEqual([{ _tag: "NoCommits", base: "main", head: "feat" }]);
  });

  test("identical picks never need a compare", () => {
    expect(validateNewPr(input({ compare: null, head: "main" }))).toEqual([
      { _tag: "SameBranch", head: "main" },
    ]);
  });
});
