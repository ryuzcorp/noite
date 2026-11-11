//! How a failed push reads. The runner's refusals are HTTP text only (no code
//! field), so this module reads exactly these message shapes and nothing else:
//! `protected` (the branch policy), `tip moved` (a lost compare-and-swap),
//! `invalid branch`, a branch that `exists`, and the browser's own
//! `failed to fetch`/`network` for an unreachable server. Anything else keeps
//! the runner's words.

import type { OperationFailure, ReadOnlyRef } from "./drafts";

/** Why the checkout cannot be edited, and what to do about it. */
export const READ_ONLY_PUSH: Record<Exclude<ReadOnlyRef, "">, string> = {
  commit:
    "Read-only: this is a single commit, not a branch. Switch to a branch to edit files.",
  role: "Read-only: your role on this app can't push. Ask an admin for the push role to edit files.",
  tag: "Read-only: this is a tag, not a branch. Switch to a branch to edit files.",
};

/** A push error as the user reads it: the runner's refusals (and the browser's
 * transport failure) carry only prose, so the shapes listed in the module
 * header are read. Anything else keeps its own words. */
export const pushErrorCopy = (failure: OperationFailure): string => {
  const lower = failure.message.toLowerCase();

  if (lower.includes("protected")) {
    return "That branch is protected. Push to a new branch and open a pull request instead.";
  }

  if (lower.includes("tip moved")) {
    return "The branch moved while you were editing. Reload the files, then push again.";
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
