//! Where a Code mode commit goes: the browsed ref, an existing branch, or a
//! new branch — and the one place that turns that choice into a push target.
//! The Changes form keeps the *choice*; protection and the name rules are
//! resolved here, so a protected branch shows why it needs a new branch
//! instead of quietly rewriting the pick.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Browsed
//!   Browsed --> Branch: pick{name}
//!   Branch --> New: pick{New}
//!   New --> Browsed: pick{Browsed}
//!   New --> New: name{text}      (invalid → blocked with a reason)
//! ```
//!
//! `Browsed` is the only choice protection can re-target: it resolves to
//! `New` with the reason `protected`, and `Browsed` itself stays what the user
//! picked.

import { Data } from "effect";

import { branchNameError } from "../forge/branch-name";

/** The target select's entry for a new branch. A space is illegal in a git
 * branch name, so the sentinel can never collide with one — as the option's
 * value or as its key (an unkeyed option is matched by position, and a repaint
 * that inserts a branch above it would leave the branch's `<option>` with this
 * one's value). */
export const NEW_BRANCH = " new";

/** The commit target the user picked. */
export type CommitChoice = Data.TaggedEnum<{
  /** The branch being browsed (or, when it is not a branch, its tip). */
  Browsed: Record<never, never>;
  /** An existing branch, grown from its own tip. */
  Branch: { name: string };
  /** A new branch started at the browsed ref's tip. */
  New: { name: string };
}>;

export const CommitChoices = Data.taggedEnum<CommitChoice>();

/** The select's value for a choice. */
export const selectValue = (choice: CommitChoice): string => {
  if (choice._tag === "Browsed") {
    return "";
  }

  if (choice._tag === "Branch") {
    return choice.name;
  }

  return NEW_BRANCH;
};

/** The choice a select value stands for. `browsed` is the branch the select
 * lists first; `""` (a select nothing has picked yet) is that same choice. */
export const choiceOf = (value: string, browsed: string): CommitChoice => {
  if (value === NEW_BRANCH) {
    return CommitChoices.New({ name: "" });
  }

  if (value === "" || value === browsed) {
    return CommitChoices.Browsed();
  }

  return CommitChoices.Branch({ name: value });
};

/** Why the push cannot go to the browsed branch: branch protection (`require_pr`
 * on, the caller below admin, the default branch) leaves only a new branch. */
const PROTECTED_REASON =
  "Protected branch: commit to a new branch and open a pull request.";

/** What the form's Push button does with one choice. */
export interface TargetPlan {
  /** Whether Push is disabled. */
  readonly blocked: boolean;
  /** The branch the commit names, or undefined when it goes to the browsed
   * ref (the runner's default). */
  readonly branch: string | undefined;
  /** The choice the form acts on: `Browsed` on a protected branch resolves to
   * `New`, and `notice` says why. */
  readonly choice: CommitChoice;
  /** Why the plan blocks the push ("" when it does not). */
  readonly reason: string;
}

/** Resolve one choice against the browsed ref and the branch rules. */
export const planTarget = (
  chosen: CommitChoice,
  browsed: string,
  isProtected: (branch: string) => boolean,
  hasChanges: boolean
): TargetPlan => {
  const choice =
    chosen._tag === "Browsed" && isProtected(browsed)
      ? CommitChoices.New({ name: "" })
      : chosen;

  if (!hasChanges) {
    return { blocked: true, branch: undefined, choice, reason: "" };
  }

  if (choice._tag === "Browsed") {
    return { blocked: false, branch: undefined, choice, reason: "" };
  }

  if (choice._tag === "Branch") {
    return { blocked: false, branch: choice.name, choice, reason: "" };
  }

  const name = choice.name.trim();

  if (name === "") {
    return { blocked: true, branch: undefined, choice, reason: "" };
  }

  const error = branchNameError(name);

  if (error === null) {
    return { blocked: false, branch: name, choice, reason: "" };
  }

  return { blocked: true, branch: undefined, choice, reason: error };
};

/** The note the form shows when protection re-targeted the browsed branch. */
export const planNotice = (chosen: CommitChoice, plan: TargetPlan): string =>
  chosen._tag === "Browsed" && plan.choice._tag === "New"
    ? PROTECTED_REASON
    : "";
