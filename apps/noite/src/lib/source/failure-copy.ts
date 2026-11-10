//! How a failed push or deploy preview reads. The workspace's read-only
//! refusal names itself by its `code`, which crosses the pod port; the
//! runner's protected-branch refusal is an HTTP text answer with no code, so
//! that one message is the only string read here.

import type { OperationFailure, ReadOnlyRef } from "./drafts";

/** Why the checkout cannot be edited, and what to do about it. */
export const READ_ONLY_PUSH: Record<Exclude<ReadOnlyRef, "">, string> = {
  commit:
    "Read-only: this is a single commit, not a branch. Switch to a branch to edit files.",
  role: "Read-only: your role on this app can't push. Ask an admin for the push role to edit files.",
  tag: "Read-only: this is a tag, not a branch. Switch to a branch to edit files.",
};

/** Why Deploy preview is off for a read-only checkout. */
export const READ_ONLY_DEPLOY: Record<Exclude<ReadOnlyRef, "">, string> = {
  commit: "Read-only — a commit checkout can't be deployed.",
  role: "Read-only — you need push access to deploy a preview.",
  tag: "Read-only — a tag checkout can't be deployed.",
};

/** A push error as the user reads it: known runner and workspace refusals get
 * copy that says what to do; anything else keeps its own words. */
export const pushErrorCopy = (
  failure: OperationFailure,
  readOnly: ReadOnlyRef
): string => {
  if (failure.code === "read-only") {
    return readOnly === ""
      ? "This checkout is read-only, so nothing was pushed."
      : READ_ONLY_PUSH[readOnly];
  }

  // The runner answers a protected branch with text, not a code
  // (`service/source.rs`): the one message this module still reads.
  const lower = failure.message.toLowerCase();

  if (lower.includes("protected")) {
    return "That branch is protected. Push to a new branch and open a pull request instead.";
  }

  if (lower.includes("tip moved")) {
    return "The branch moved while you were editing. Refresh the page to see the new commits, then push again.";
  }

  if (lower.includes("invalid branch")) {
    return "That branch name is not valid.";
  }

  if (lower.includes("branch") && lower.includes("exists")) {
    return "A branch with that name already exists.";
  }

  if (lower.includes("failed to fetch") || lower.includes("network")) {
    return "Could not reach the server. Check your connection and try again.";
  }

  return failure.message;
};

/** A failed deploy as the user reads it: the workspace's own read-only refusal
 * gets copy that names the reason, anything else keeps its words. */
export const deployErrorCopy = (
  failure: OperationFailure,
  readOnly: ReadOnlyRef
): string =>
  readOnly !== "" && failure.code === "read-only"
    ? READ_ONLY_DEPLOY[readOnly]
    : failure.message;
