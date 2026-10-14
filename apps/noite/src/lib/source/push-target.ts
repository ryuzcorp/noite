//! Where a Code mode commit may go: whether the browsed ref opens editable,
//! and whether branch protection keeps the caller off it. Both rules read data
//! the page has already loaded — the app's refs (`GitRefs.branches`) and its
//! branch rule (`app_branch_rule`) — and live here rather than inside the
//! browser or the Changes panel so the two agree and a unit test can pin them.

import { roleAtLeast } from "../roles";
import type { AppRole } from "../roles";
import type { BranchRules, GitRefs } from "../runner";

/** Whether the viewer may edit `ref`: it names a branch in the refs list, and
 * the role may push (a `view` collaborator's checkout stays read-only — the
 * commit route refuses them either way). The refs list is the only place the
 * UI learns a name is a branch: `?ref=` also takes a tag or a raw commit sha,
 * and a commit carries a branch name, so an unconfirmed ref must never open
 * editable — the runner would create a branch under a name that is not one.
 * A protected branch still opens editable: protection gates what the Changes
 * panel commits to, never whether the editor works (see `protectedRef`). */
export const editableRef = (
  refs: GitRefs | undefined,
  role: AppRole | undefined,
  ref: string
): boolean =>
  role !== undefined &&
  roleAtLeast(role, "push") &&
  refs?.branches.some((branch) => branch.name === ref) === true;

/** Whether branch protection covers `ref`: `require_pr` is on, the caller is
 * below admin, and the browsed branch is the default one — the single branch
 * the runner refuses a direct commit to (`app_branch_rule`, see
 * `host/git_policy.rs` and `service::source::commit`), which the Settings
 * panel's rule is app-wide. The Changes panel then offers only a new branch;
 * every other branch takes a direct commit. */
export const protectedRef = (
  rules: BranchRules | undefined,
  role: AppRole | undefined,
  ref: string,
  defaultBranch: string
): boolean =>
  rules?.requirePr === true && role !== "admin" && ref === defaultBranch;
