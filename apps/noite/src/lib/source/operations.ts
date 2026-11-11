//! The browser's commit operation, as one union: what the Changes form shows
//! from the button to the outcome line. A failure can never surface as
//! anything but a failure of this one operation, and a second push is refused
//! while the first is in flight.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Pushing: start (refused while Pushing)
//!   Pushing --> Done: succeeded{to}
//!   Pushing --> Failed: rejected{failure}
//!   Done --> Idle: reset (a change landed)
//!   Failed --> Idle: reset / start
//! ```

import { Data } from "effect";

import type { OperationFailure, PushedTo } from "./drafts";

/** One push, from the button to the outcome line. */
export type PushOperation = Data.TaggedEnum<{
  Done: { readonly to: PushedTo };
  Failed: { readonly failure: OperationFailure };
  Idle: Record<never, never>;
  Pushing: { readonly branch: string };
}>;

export const PushOps = Data.taggedEnum<PushOperation>();

/** One push's outcome: where it landed, or why it failed. */
export type PushOutcome =
  | { readonly failure: OperationFailure; readonly ok: false }
  | { readonly ok: true; readonly to: PushedTo };

/** A caught push error as the state reports it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch value is unknown by construction; this is the one place it becomes a failure.
export const operationFailure = (error: unknown): OperationFailure => ({
  message: error instanceof Error ? error.message : String(error),
});

/** Start a push; null when one is already in flight. */
export const startPush = (
  state: PushOperation,
  branch: string
): PushOperation | null =>
  state._tag === "Pushing" ? null : PushOps.Pushing({ branch });

/** Land a push: where it went, or why it failed. */
export const settlePush = (
  state: PushOperation,
  outcome: PushOutcome
): PushOperation => {
  if (state._tag !== "Pushing") {
    return state;
  }

  return outcome.ok
    ? PushOps.Done({ to: outcome.to })
    : PushOps.Failed({ failure: outcome.failure });
};

/** A change landed: whatever outcome the form is showing is superseded. */
export const resetOperations = (): PushOperation => PushOps.Idle();
