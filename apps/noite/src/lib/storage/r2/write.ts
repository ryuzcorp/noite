//! The R2 page's write lifecycle: upload, folder creation and delete share
//! one closed state, and its scope says which control is busy.
//!
//! The page used to have one `busy` flag and one `failure` string for all
//! three writes, with partial upload success encoded as newline-joined text
//! in the error slot (`null` was success, any text an error — including the
//! "N files exceed the cap" note, which was not an error at all). One slow
//! upload disabled "Delete this file" in the detail panel, and the banner
//! outlived the condition it described.
//!
//! ```text
//! Idle ──start{scope}──▶ Running{scope} ──settled{}──────────▶ Idle
//!                                       └─settled{problems}──▶ Partial ──start──▶ Running
//!                                       └─failed{message}────▶ Failed  ──dismiss──▶ Idle
//! Running refuses `start` (one write per page) and every other event.
//! ```

import { Data } from "effect";

/** Which control started the write. */
export type R2WriteScope = "delete" | "mkdir" | "upload";

export type R2Write = Data.TaggedEnum<{
  /** Nothing in flight, no banner. */
  Idle: Record<never, never>;
  /** A write is in flight for `scope`; `count` objects it touches. */
  Running: { readonly count: number; readonly scope: R2WriteScope };
  /** The write failed as a whole (network or a refused request). */
  Failed: { readonly message: string; readonly scope: R2WriteScope };
  /** Some objects failed; the rest were written. */
  Partial: {
    readonly problems: readonly string[];
    readonly scope: R2WriteScope;
  };
}>;

export const R2WriteState = Data.taggedEnum<R2Write>();

export type R2WriteEvent =
  | {
      readonly count: number;
      readonly kind: "start";
      readonly scope: R2WriteScope;
    }
  | { readonly kind: "settled"; readonly problems: readonly string[] }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "dismiss" };

/** Whether a write is in flight at all (uploads and folder creation). */
export const writeRunning = (state: R2Write): boolean =>
  state._tag === "Running";

/** Whether the *delete* control is busy; other writes do not disable it. */
export const deleting = (state: R2Write): boolean =>
  state._tag === "Running" && state.scope === "delete";

/** The banner text, if any. */
export const writeProblem = (state: R2Write): string | null => {
  if (state._tag === "Failed") {
    return state.message;
  }

  return state._tag === "Partial" ? state.problems.join("\n") : null;
};

/** The one transition function for the R2 write lifecycle. */
export const nextWrite = (state: R2Write, event: R2WriteEvent): R2Write => {
  if (state._tag === "Running") {
    if (event.kind === "settled") {
      return event.problems.length === 0
        ? R2WriteState.Idle()
        : R2WriteState.Partial({
            problems: event.problems,
            scope: state.scope,
          });
    }

    if (event.kind === "failed") {
      return R2WriteState.Failed({
        message: event.message,
        scope: state.scope,
      });
    }

    return state;
  }

  switch (event.kind) {
    case "start": {
      return R2WriteState.Running({ count: event.count, scope: event.scope });
    }

    case "dismiss": {
      return R2WriteState.Idle();
    }

    default: {
      return state;
    }
  }
};
