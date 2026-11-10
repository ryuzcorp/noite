//! The pull request's lifecycle, as one closed vocabulary: the persisted
//! `state`, the derived `merge_state`, the review verdict and the actions
//! each one permits.
//!
//! The runner owns these values (PR #219 turns them into ts-rs literal
//! unions in `lib/runner-types/{PrState,MergeState,ReviewState}`). Until that
//! lands the wire fields are still `string`, so this module declares the same
//! unions locally and decodes at the boundary; when the bindings arrive, the
//! local aliases are deleted and the decoders keep working unchanged (a union
//! is assignable to `string`).
//!
//! The UI used to re-implement the runner's policy in three places — the
//! header's `canClose`/`canMerge`, the dropdown's `mergeState === "mergeable"`
//! and the review box's four booleans — so the same PR could offer Merge in
//! one control and not another, and an unknown wire state rendered as a
//! closable, mergeable PR. Every consumer now reads one facts table and one
//! capabilities value.
//!
//! ```text
//! open ──close──▶ closed ──reopen (head alive, no rival)──▶ open
//! open ──merge──▶ merged (terminal)
//! review: none ──approve──▶ approved ──push──▶ approved{dismissed}
//!         none ──request──▶ changes_requested ──push──▶ dismissed
//! ```

import { Data } from "effect";

import type { AppRole } from "../roles";
import type { PrDetail, PrReview } from "../runner";

/** The persisted lifecycle state (`PrSummary.state`). */
export type PrState = "closed" | "merged" | "open";

/** The derived merge-box state (`PrDetail.mergeState`). */
export type MergeState =
  | "blocked_approvals"
  | "closed"
  | "conflicts"
  | "head_missing"
  | "mergeable"
  | "merged";

/** A reviewer's verdict (`PrReview.state`). */
export type ReviewState = "approved" | "changes_requested";

/** Decode the wire string. An unrecognized value reads as `closed`: it never
 * enables Merge and its only offered action is Reopen, which the runner
 * refuses if the transition is impossible. (Unreachable once #219's union
 * ships — the field is then already a {@link PrState}.) */
export const toPrState = (raw: string): PrState => {
  if (raw === "open" || raw === "merged") {
    return raw;
  }

  return "closed";
};

/** Decode `mergeState`; an unrecognized value reads as `conflicts` (the
 * state that permits nothing destructive). */
export const toMergeState = (raw: string): MergeState => {
  if (
    raw === "merged" ||
    raw === "closed" ||
    raw === "head_missing" ||
    raw === "mergeable" ||
    raw === "blocked_approvals"
  ) {
    return raw;
  }

  return "conflicts";
};

/** Decode a review verdict; null for a value this UI does not know. */
export const toReviewState = (raw: string): ReviewState | null => {
  if (raw === "approved" || raw === "changes_requested") {
    return raw;
  }

  return null;
};

/** What a state looks like: the badge, the label, and the two facts every
 * consumer needs. `terminal` means no further lifecycle action. */
interface PrStateFacts {
  readonly badge: string;
  readonly label: string;
  readonly terminal: boolean;
}

const PR_STATE_FACTS = {
  closed: { badge: "badge-ghost", label: "Closed", terminal: true },
  merged: { badge: "badge-info", label: "Merged", terminal: true },
  open: { badge: "badge-success", label: "Open", terminal: false },
} satisfies Record<PrState, PrStateFacts>;

interface MergeStateFacts {
  readonly badge: string;
  readonly gated: boolean;
  readonly label: string;
}

const MERGE_STATE_FACTS = {
  blocked_approvals: {
    badge: "badge-warning",
    gated: true,
    label: "Waiting for approvals",
  },
  closed: { badge: "badge-ghost", gated: false, label: "Closed" },
  conflicts: { badge: "badge-error", gated: false, label: "Merge conflicts" },
  head_missing: {
    badge: "badge-error",
    gated: false,
    label: "Head branch is gone",
  },
  mergeable: { badge: "badge-success", gated: true, label: "Ready to merge" },
  merged: { badge: "badge-info", gated: false, label: "Merged" },
} satisfies Record<MergeState, MergeStateFacts>;

interface ReviewStateFacts {
  readonly badge: string;
  readonly label: string;
}

const REVIEW_STATE_FACTS = {
  approved: { badge: "badge-success", label: "Approved" },
  changes_requested: { badge: "badge-error", label: "Changes requested" },
} satisfies Record<ReviewState, ReviewStateFacts>;

/** The badge/label for a persisted state (list rows, detail header). */
export const prStateFacts = (state: PrState): PrStateFacts =>
  PR_STATE_FACTS[state];

/** The badge/label for the merge box. */
export const mergeStateFacts = (state: MergeState): MergeStateFacts =>
  MERGE_STATE_FACTS[state];

/** The badge/label for a review verdict; null for an unknown wire value. */
export const reviewStateFacts = (state: string): ReviewStateFacts | null => {
  const known = toReviewState(state);

  return known === null ? null : REVIEW_STATE_FACTS[known];
};

/** What this viewer may do with this pull request. Every control reads this
 * value, so a button can never be enabled for a transition the runner will
 * refuse. */
export interface PrCapabilities {
  readonly canClose: boolean;
  readonly canMerge: boolean;
  readonly canReopen: boolean;
  readonly canReview: boolean;
}

export const prCapabilities = ({
  detail,
  role,
  viewerId,
}: {
  detail: PrDetail;
  role: AppRole | undefined;
  viewerId: string;
}): PrCapabilities => {
  const { pullRequest } = detail;
  const state = toPrState(pullRequest.state);
  const mergeState = toMergeState(detail.mergeState);
  const canPush = role === "push" || role === "admin";
  const signedIn = viewerId !== "";
  const isAuthor = signedIn && pullRequest.authorId === viewerId;
  const owns = canPush && (isAuthor || role === "admin");
  const open = state === "open";

  return {
    canClose: owns && open,
    // Merge needs the merge state to say yes: the dropdown already gated on
    // it, and the header must not offer a merge the runner would 409.
    canMerge: canPush && open && mergeState === "mergeable",
    // Reopen needs a live head branch: the runner refuses it otherwise, and
    // `compare === null` is exactly "the head branch is gone".
    canReopen: owns && state === "closed" && detail.compare !== null,
    canReview: canPush && signedIn && !isAuthor && open,
  };
};

/** The lifecycle action the header's one button performs. */
export type SwitchStateAction = "closed" | "open";

/** `closed` to close an open pull request, `open` to reopen a closed one,
 * null when neither is allowed (no button). */
export const switchStateAction = (
  state: PrState,
  capabilities: PrCapabilities
): SwitchStateAction | null => {
  if (capabilities.canClose) {
    return "closed";
  }

  if (capabilities.canReopen) {
    return "open";
  }

  return null;
};

/** This viewer's verdict on a pull request, with whether it still counts.
 * A verdict counts only at the current head and while undismissed — the
 * runner's own rule — so a stale cached detail cannot leave the buttons
 * disabled for a review the runner no longer counts. */
export type MyVerdict = Data.TaggedEnum<{
  None: Record<never, never>;
  Approved: { readonly current: boolean };
  ChangesRequested: { readonly current: boolean };
}>;

export const Verdict = Data.taggedEnum<MyVerdict>();

/** The latest review per reviewer (ties broken by id). */
const latestBy = (reviews: readonly PrReview[]): Map<string, PrReview> => {
  const latest = new Map<string, PrReview>();

  for (const review of reviews) {
    const prev = latest.get(review.reviewerId);

    const newer =
      prev === undefined ||
      review.createdAt > prev.createdAt ||
      (review.createdAt === prev.createdAt && review.id >= prev.id);

    if (newer) {
      latest.set(review.reviewerId, review);
    }
  }

  return latest;
};

/** This viewer's verdict, if any, and whether it counts at `headSha`. */
export const myVerdict = (detail: PrDetail, viewerId: string): MyVerdict => {
  if (viewerId === "") {
    return Verdict.None();
  }

  const mine = latestBy(detail.reviews).get(viewerId);

  if (mine === undefined) {
    return Verdict.None();
  }

  const current =
    mine.dismissedAt === null && mine.commitSha === detail.pullRequest.headSha;

  const state = toReviewState(mine.state);

  if (state === "approved") {
    return Verdict.Approved({ current });
  }

  if (state === "changes_requested") {
    return Verdict.ChangesRequested({ current });
  }

  return Verdict.None();
};
