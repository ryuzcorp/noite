import { expect, test } from "bun:test";

import {
  choiceOf,
  CommitChoices,
  NEW_BRANCH,
  planNotice,
  planTarget,
  selectValue,
} from "./commit-target";

const unprotected = () => false;
const protectedMain = (branch: string) => branch === "main";

test("the three choices map to and from the select's values", () => {
  expect(selectValue(CommitChoices.Browsed())).toBe("");
  expect(selectValue(CommitChoices.Branch({ name: "release" }))).toBe(
    "release"
  );
  expect(selectValue(CommitChoices.New({ name: "" }))).toBe(NEW_BRANCH);

  expect(choiceOf("", "main")).toEqual(CommitChoices.Browsed());
  expect(choiceOf("main", "main")).toEqual(CommitChoices.Browsed());
  expect(choiceOf("release", "main")).toEqual(
    CommitChoices.Branch({ name: "release" })
  );
  expect(choiceOf(NEW_BRANCH, "main")).toEqual(CommitChoices.New({ name: "" }));
});

test("a protected browsed branch is re-targeted, and says so", () => {
  const chosen = CommitChoices.Browsed();
  const plan = planTarget(chosen, "main", protectedMain, true);

  expect(plan.choice._tag).toBe("New");
  expect(plan.blocked).toBe(true);
  expect(planNotice(chosen, plan)).toContain("pull request");
});

test("an unprotected browsed branch commits directly", () => {
  const plan = planTarget(CommitChoices.Browsed(), "main", unprotected, true);

  expect(plan.branch).toBeUndefined();
  expect(plan.blocked).toBe(false);
  expect(planNotice(CommitChoices.Browsed(), plan)).toBe("");
});

test("a new branch needs a legal name, and its error clears on a new target", () => {
  const empty = planTarget(
    CommitChoices.New({ name: "  " }),
    "main",
    unprotected,
    true
  );

  expect(empty.blocked).toBe(true);
  expect(empty.reason).toBe("");

  const invalid = planTarget(
    CommitChoices.New({ name: "bad name" }),
    "main",
    unprotected,
    true
  );

  expect(invalid.blocked).toBe(true);
  expect(invalid.reason).not.toBe("");

  // Picking another target drops the name and its error entirely.
  const switched = planTarget(
    CommitChoices.Branch({ name: "release" }),
    "main",
    unprotected,
    true
  );

  expect(switched.blocked).toBe(false);
  expect(switched.reason).toBe("");
  expect(switched.branch).toBe("release");
});

test("no changes blocks every target", () => {
  expect(
    planTarget(CommitChoices.Browsed(), "main", unprotected, false).blocked
  ).toBe(true);
});
