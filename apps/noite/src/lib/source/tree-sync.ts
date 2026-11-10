//! The tree's row resync queue: one listing at a time, and every ask that
//! arrives mid-run is answered by exactly one run after it. The old shape was a
//! `syncing` promise plus an `again` boolean, which read `again` twice (once to
//! clear it, once to test it) and could drop an ask.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Running: asked
//!   Running --> Running: asked{queued: true}
//!   Running --> Running: finished{queued} (runs again)
//!   Running --> Idle: finished{!queued}
//! ```

import { Data } from "effect";

/** Whether a resync is running, and whether another one is owed. */
export type ResyncState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  Running: { queued: boolean };
}>;

export const ResyncStates = Data.taggedEnum<ResyncState>();

/** What the caller must do: start the run it is waiting on, or not. */
export interface ResyncDecision {
  /** Start (or restart) `syncRows` now. */
  readonly run: boolean;
  readonly state: ResyncState;
}

/** A gesture, the pod's watcher or a `.gitignore` write asked for a resync. */
export const askResync = (state: ResyncState): ResyncDecision =>
  state._tag === "Idle"
    ? { run: true, state: ResyncStates.Running({ queued: false }) }
    : { run: false, state: ResyncStates.Running({ queued: true }) };

/** One listing landed: the next queued ask runs, or the queue drains. */
export const finishResync = (state: ResyncState): ResyncDecision =>
  state._tag === "Running" && state.queued
    ? { run: true, state: ResyncStates.Running({ queued: false }) }
    : { run: false, state: ResyncStates.Idle() };
