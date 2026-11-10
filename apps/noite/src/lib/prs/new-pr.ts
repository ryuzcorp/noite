//! New-pull-request validation: one rule set decides both what the form
//! lists and whether Create may submit.
//!
//! The form had two rule lists — `newPrBlockers` (what it showed) and
//! `newPrProblem` (what the submit guard checked). They disagreed: a
//! duplicate base/head pair disabled the button but the guard returned null,
//! so any submit that got past the button created a second pull request for
//! the same pair (the runner only checks duplicates on reopen). Here
//! {@link validateNewPr} computes one closed reason set, and
//! {@link createInputOf} returns the request body only when that set is
//! empty — a submit cannot be formed while a reason exists.
//!
//! ```text
//! RefsLoading ──refs──▶ (validate)
//! reasons = [] ⇔ Create is enabled ⇔ createInputOf() ≠ null
//! ```

import { Data } from "effect";

/** Why Create is off, one variant per rule. */
export type NewPrReason = Data.TaggedEnum<{
  NoBranches: Record<never, never>;
  PickBranches: Record<never, never>;
  SameBranch: { readonly head: string };
  Duplicate: { readonly number: number };
  ComparePending: Record<never, never>;
  CompareFailed: Record<never, never>;
  NoCommits: { readonly base: string; readonly head: string };
  TitleMissing: Record<never, never>;
}>;

export const Reason = Data.taggedEnum<NewPrReason>();

/** The `base..head` compare the form needs before it may submit. */
export type CompareStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly ahead: number; readonly kind: "ready" };

/** The form's inputs, trimmed. */
export interface NewPrInput {
  /** The compare for the picked pair; null when the pair is not pickable
   * yet (the branch rules cover that). */
  readonly compare: CompareStatus | null;
  readonly base: string;
  readonly head: string;
  /** The open pull request already targeting this pair, if any. */
  readonly existingNumber: number | undefined;
  /** The branch list, `undefined` until it loads. */
  readonly branchNames: readonly string[] | undefined;
  readonly title: string;
}

/** Every reason Create is off, in the order the form reads them. */
export const validateNewPr = (input: NewPrInput): readonly NewPrReason[] => {
  const reasons: NewPrReason[] = [];

  if (input.branchNames !== undefined) {
    if (input.branchNames.every((name) => name === input.base)) {
      reasons.push(Reason.NoBranches());
    }

    if (input.base === "" || input.head === "") {
      reasons.push(Reason.PickBranches());
    } else if (input.base === input.head) {
      reasons.push(Reason.SameBranch({ head: input.head }));
    }

    if (input.existingNumber !== undefined) {
      reasons.push(Reason.Duplicate({ number: input.existingNumber }));
    }

    // Picking two distinct branches needs a compare: until it lands there is
    // no "does this pair have commits" answer, and the old form let that
    // through.
    if (input.compare !== null) {
      if (input.compare.kind === "loading") {
        reasons.push(Reason.ComparePending());
      } else if (input.compare.kind === "failed") {
        reasons.push(Reason.CompareFailed());
      } else if (input.compare.ahead === 0) {
        reasons.push(Reason.NoCommits({ base: input.base, head: input.head }));
      }
    }
  }

  if (input.title === "") {
    reasons.push(Reason.TitleMissing());
  }

  return reasons;
};

/** The sentence the form shows for one reason. */
export const reasonText = (reason: NewPrReason): string => {
  switch (reason._tag) {
    case "NoBranches": {
      return "Create a branch first";
    }

    case "PickBranches": {
      return "Pick both a base and a head branch";
    }

    case "SameBranch": {
      return "Head must differ from base";
    }

    case "Duplicate": {
      return `A pull request for this pair is already open (#${reason.number})`;
    }

    case "ComparePending": {
      return "Comparing the branches…";
    }

    case "CompareFailed": {
      return "Could not compare these branches";
    }

    case "NoCommits": {
      return `No commits on ${reason.head} over ${reason.base}`;
    }

    default: {
      return "Add a title";
    }
  }
};

/** The request body Create sends, or null while any reason stands. */
export interface NewPrRequest {
  readonly base: string;
  readonly body?: string;
  readonly head: string;
  readonly title: string;
}

export const createInputOf = (
  input: NewPrInput & { readonly body: string }
): NewPrRequest | null => {
  if (validateNewPr(input).length > 0) {
    return null;
  }

  const body = input.body.trim();

  const request: NewPrRequest = {
    base: input.base,
    head: input.head,
    title: input.title,
  };

  return body === "" ? request : { ...request, body };
};
