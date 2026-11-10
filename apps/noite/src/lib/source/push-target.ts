//! Where a Code mode commit may go and whether the pane may edit at all: both
//! answers are one derivation over the refs the page already holds, so the
//! browser, the page's banner and the Changes form cannot disagree.
//!
//! `readOnly` is why the editor refuses to edit (the closed `ReadOnlyRef`
//! union). `commit` is the orthogonal question — whether branch protection
//! keeps this ref to pull requests. A checkout can be editable and
//! commit-via-PR at once, which the old split (a positive `editableRef` plus a
//! separate `protectedRef` predicate) made invisible.

import { roleAtLeast } from "../roles";
import type { AppRole } from "../roles";
import type { BranchRules, GitRefs } from "../runner";
import type { ReadOnlyRef } from "./drafts";

/** Whether the commit goes straight to the branch, or only through a pull
 * request (`require_pr` on, the caller below admin, the default branch — the
 * single branch the runner refuses a direct commit to, see
 * `host/git_policy.rs` and `service::source::commit`). */
export type CommitAccess = "direct" | "pr-only";

/** The two answers one ref needs. */
export interface RefAccess {
  readonly commit: CommitAccess;
  /** Why the ref opens read-only ("" = editable). */
  readonly readOnly: ReadOnlyRef;
}

/** The refs a sha (`?ref=` mid-commit, a commit link) looks like: the runner's
 * own `is_hex_sha` (7..=40 hex digits). */
const SHA_REF = /^[0-9a-f]{7,40}$/iu;

/** Why `ref` opens read-only, and whether a commit to it must go through a
 * pull request.
 *
 * The refs list is the only place the UI learns a name is a branch: `?ref=`
 * also takes a tag or a raw commit sha, and a commit carries a branch name, so
 * an unconfirmed ref must never open editable — the runner would create a
 * branch under a name that is not one. A protected branch still opens
 * editable: protection gates where the Changes form commits, never whether the
 * editor works. */
export const refAccess = (
  refs: GitRefs | undefined,
  rules: BranchRules | undefined,
  role: AppRole | undefined,
  ref: string,
  defaultBranch: string
): RefAccess => {
  const isBranch =
    refs?.branches.some((branch) => branch.name === ref) === true;

  const mayPush = role !== undefined && roleAtLeast(role, "push");
  let readOnly: ReadOnlyRef = SHA_REF.test(ref) ? "commit" : "tag";

  if (isBranch) {
    readOnly = mayPush ? "" : "role";
  }

  const commit: CommitAccess =
    rules?.requirePr === true && role !== "admin" && ref === defaultBranch
      ? "pr-only"
      : "direct";

  return { commit, readOnly };
};
