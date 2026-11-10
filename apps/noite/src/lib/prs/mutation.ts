//! The pull request's in-flight mutation: one value for the whole PR, so the
//! header's Close, the dropdown's Merge and the review box's Approve cannot
//! run at once and every control has one answer for "what is happening".
//!
//! Each control group used to own a `busy` + `notice` pair, which allowed
//! Close and Merge to be in flight together (the runner turned that into one
//! 409 shown as an unrelated error), let an error outlive the condition it
//! described, and made "which action is running?" unanswerable.
//!
//! ```text
//! Idle ──start{kind}──▶ Running{kind} ──done──▶ Idle
//!                                     └─failed{message}──▶ Failed{kind} ──start──▶ Running
//! Running refuses every other `start`; `failed`/`done` only apply to the
//! running kind.
//! ```

import { Data } from "effect";

/** Which control started the mutation. */
export type PrMutationKind = "close" | "merge" | "reopen" | "review";

export type PrMutation = Data.TaggedEnum<{
  /** Nothing in flight, no error. */
  Idle: Record<never, never>;
  /** `kind` is running; every control is disabled. */
  Running: { readonly kind: PrMutationKind };
  /** `kind` failed; the message shows beside that control only. */
  Failed: {
    readonly kind: PrMutationKind;
    readonly message: string;
  };
}>;

export const Mutation = Data.taggedEnum<PrMutation>();

export type PrMutationEvent =
  | { readonly kind: "start"; readonly mutation: PrMutationKind }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "dismiss" };

/** The one transition function for the PR mutation. */
export const nextMutation = (
  state: PrMutation,
  event: PrMutationEvent
): PrMutation => {
  if (state._tag === "Running") {
    if (event.kind === "done") {
      return Mutation.Idle();
    }

    if (event.kind === "failed") {
      return Mutation.Failed({ kind: state.kind, message: event.message });
    }

    return state;
  }

  switch (event.kind) {
    case "start": {
      return Mutation.Running({ kind: event.mutation });
    }

    case "dismiss": {
      return Mutation.Idle();
    }

    default: {
      return state;
    }
  }
};

/** Whether anything is running (every control disables). */
export const mutationRunning = (state: PrMutation): boolean =>
  state._tag === "Running";

/** The error to show beside one control group: a failure of one of `kinds`,
 * and only while it is the latest outcome. */
export const mutationProblem = (
  state: PrMutation,
  kinds: readonly PrMutationKind[]
): string | null =>
  state._tag === "Failed" && kinds.includes(state.kind) ? state.message : null;
