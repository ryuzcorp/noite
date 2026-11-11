import { expect, test } from "bun:test";

import { pushErrorCopy, READ_ONLY_PUSH } from "./failure-copy";

test("a protected branch is the runner's code-free refusal", () => {
  expect(
    pushErrorCopy({
      message:
        "commit failed: 409 refs/heads/main is protected; commit to a new branch and open a pull request",
    })
  ).toBe(
    "That branch is protected. Push to a new branch and open a pull request instead."
  );
});

test("a lost compare-and-swap says to reload", () => {
  expect(pushErrorCopy({ message: "409 tip moved" })).toBe(
    "The branch moved while you were editing. Reload the files, then push again."
  );
});

test("a bad branch name is named as such", () => {
  expect(pushErrorCopy({ message: '400 invalid branch "a..b"' })).toBe(
    "That branch name is not valid."
  );
});

test("an existing branch is reported as taken", () => {
  expect(
    pushErrorCopy({ message: '400 branch "feature" already exists' })
  ).toBe("A branch with that name already exists.");
});

test("an unreachable server is a connection problem", () => {
  expect(pushErrorCopy({ message: "Failed to fetch" })).toBe(
    "Could not reach the server. Check your connection and try again."
  );
});

test("anything else keeps the runner's words", () => {
  expect(pushErrorCopy({ message: "500 repo mirror is missing" })).toBe(
    "500 repo mirror is missing"
  );
});

test("every read-only reason has copy", () => {
  expect(READ_ONLY_PUSH.tag).toContain("tag");
  expect(READ_ONLY_PUSH.commit).toContain("commit");
  expect(READ_ONLY_PUSH.role).toContain("role");
});
