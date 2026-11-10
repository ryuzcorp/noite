import { expect, test } from "bun:test";

import {
  deployErrorCopy,
  pushErrorCopy,
  READ_ONLY_DEPLOY,
} from "./failure-copy";

test("a read-only push is classified by the workspace code", () => {
  // The message says nothing about read-only: the code alone decides.
  const failure = {
    code: "read-only" as const,
    message: "workspace: no writes",
  };

  expect(pushErrorCopy(failure, "tag")).toBe(
    "Read-only: this is a tag, not a branch. Switch to a branch to edit files."
  );
  expect(pushErrorCopy(failure, "")).toBe(
    "This checkout is read-only, so nothing was pushed."
  );
});

test("a protected branch is the runner's code-free refusal", () => {
  expect(
    pushErrorCopy(
      {
        code: null,
        message:
          "commit failed: 409 refs/heads/main is protected; commit to a new branch and open a pull request",
      },
      ""
    )
  ).toBe(
    "That branch is protected. Push to a new branch and open a pull request instead."
  );
});

test("a read-only deploy preview is classified by the workspace code", () => {
  expect(
    deployErrorCopy(
      { code: "read-only", message: "workspace: no writes" },
      "role"
    )
  ).toBe(READ_ONLY_DEPLOY.role);
});

test("a remote message is not re-read as a workspace refusal", () => {
  // No code: the runner's own words stay, even when they mention read-only.
  expect(
    deployErrorCopy(
      { code: null, message: "deploy failed: the release is read-only" },
      "tag"
    )
  ).toBe("deploy failed: the release is read-only");
});
