//! The browser's two commit operations — push and deploy preview — as one
//! union each, so a failure can never surface under the other operation's
//! copy and neither one's state leaks into the other's form.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Pushing: start (refused while Pushing)
//!   Pushing --> Done: succeeded{to}
//!   Pushing --> Failed: rejected{failure}
//!   Idle --> Running: start (refused while Running)
//!   Running --> Done: succeeded{snapshot}
//!   Running --> Failed: rejected{failure}
//!   Done --> Idle: reset (a change landed)
//!   Failed --> Idle: reset / start
//! ```
//!
//! The two slots are independent: a push may run while a preview does, and a
//! preview's failure is reported as `previewError`, never as `pushError`.

import { Data } from "effect";

import { errorMessage } from "../errors";
import type { OperationFailure, PreviewedSnapshot, PushedTo } from "./drafts";
import { workspaceErrorCodeOf } from "./workspace/types";

/** One push, from the button to the outcome line. */
export type PushOperation = Data.TaggedEnum<{
  Done: { to: PushedTo };
  Failed: { failure: OperationFailure };
  Idle: Record<never, never>;
  Pushing: Record<never, never>;
}>;

export const PushOps = Data.taggedEnum<PushOperation>();

/** One deploy preview, from the button to the panel's notice. */
export type PreviewOperation = Data.TaggedEnum<{
  Done: { snapshot: PreviewedSnapshot };
  Failed: { failure: OperationFailure };
  Idle: Record<never, never>;
  Running: Record<never, never>;
}>;

export const PreviewOps = Data.taggedEnum<PreviewOperation>();

/** One operation's outcome: what it produced, or why it failed. */
export type PushOutcome =
  | { readonly failure: OperationFailure; readonly ok: false }
  | { readonly ok: true; readonly to: PushedTo };

/** One preview's outcome. */
export type PreviewOutcome =
  | { readonly failure: OperationFailure; readonly ok: false }
  | { readonly ok: true; readonly snapshot: PreviewedSnapshot };

/** A caught push/preview error as the state reports it: the pod's refusal
 * code when it threw one, and the message either way. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch value is unknown by construction; this is the one place it becomes a failure.
export const operationFailure = (error: unknown): OperationFailure => ({
  code: workspaceErrorCodeOf(error),
  message: errorMessage(error),
});

/** Start a push; null when one is already in flight. */
export const startPush = (state: PushOperation): PushOperation | null => {
  if (state._tag === "Pushing") {
    return null;
  }

  return PushOps.Pushing();
};

/** Land a push: where it went, or why it failed. */
export const settlePush = (
  state: PushOperation,
  outcome: PushOutcome
): PushOperation => {
  if (state._tag !== "Pushing") {
    return state;
  }

  if (outcome.ok) {
    return PushOps.Done({ to: outcome.to });
  }

  return PushOps.Failed({ failure: outcome.failure });
};

/** Start a deploy preview; null when one is already running. */
export const startPreview = (
  state: PreviewOperation
): PreviewOperation | null => {
  if (state._tag === "Running") {
    return null;
  }

  return PreviewOps.Running();
};

/** Land a preview: what it snapshotted, or why it failed. */
export const settlePreview = (
  state: PreviewOperation,
  outcome: PreviewOutcome
): PreviewOperation => {
  if (state._tag !== "Running") {
    return state;
  }

  if (outcome.ok) {
    return PreviewOps.Done({ snapshot: outcome.snapshot });
  }

  return PreviewOps.Failed({ failure: outcome.failure });
};

/** A change landed: whichever push outcome the Changes form is showing is
 * superseded. */
export const resetOperations = () => ({
  preview: PreviewOps.Idle(),
  push: PushOps.Idle(),
});

/** What the Changes panel reads of the push slot. */
export const pushView = (state: PushOperation) => ({
  pushError: state._tag === "Failed" ? state.failure : null,
  pushed: state._tag === "Done" ? state.to : null,
  pushing: state._tag === "Pushing",
});

/** What the Preview panel reads of the preview slot. */
export const previewView = (state: PreviewOperation) => ({
  previewError: state._tag === "Failed" ? state.failure : null,
  previewed: state._tag === "Done" ? state.snapshot : null,
});
