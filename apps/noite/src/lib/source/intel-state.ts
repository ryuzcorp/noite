//! The TypeScript intelligence layer's readiness: whether the worker was ever
//! started, whether pierre's session is attached, and which file the markers
//! and caret belong to. One value and one epoch, so "ready" means "bound to
//! this file under this epoch" instead of "no call has thrown yet".
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Off
//!   Off --> Booted: ensure        (the worker starts)
//!   Booted --> Bound: attach{path}
//!   Bound --> Detached: beginPreview{path} (another file) / reset
//!   Detached --> Bound: attach{path}
//!   Bound --> Detached: markerLost          (the session threw)
//!   Bound --> Off: reset                     (a push moved the repo)
//!   Detached --> Off: reset
//! ```

import { Data } from "effect";

/** The intel layer's session state. */
export type IntelState = Data.TaggedEnum<{
  /** The worker was never started (or was reset): nothing to paint. */
  Off: Record<never, never>;
  /** The worker runs; no pierre session is attached yet. */
  Booted: { epoch: number };
  /** `path`'s session is attached and takes markers and carets. */
  Bound: { epoch: number; path: string };
  /** A file was opened but its session is not attached (yet): any markers or
   * caret a check produces wait for the next attach. */
  Detached: { epoch: number; path: string | null };
}>;

export const IntelStates = Data.taggedEnum<IntelState>();

/** The state and the epoch every in-flight run is stamped with. */
export interface IntelMachine {
  readonly epoch: number;
  readonly state: IntelState;
}

export const newIntelMachine = (): IntelMachine => ({
  epoch: 0,
  state: IntelStates.Off(),
});

/** Whether the worker was started (the browser reads this to decide whether a
 * push/reset has anything to reset). */
export const intelStarted = (state: IntelState): boolean =>
  state._tag !== "Off";

/** The path whose session is bound, when one is. */
export const boundPath = (state: IntelState): string | null =>
  state._tag === "Bound" ? state.path : null;

/** The worker was started (the first script file opened). */
export const bootIntel = (machine: IntelMachine): IntelMachine =>
  machine.state._tag === "Off"
    ? {
        epoch: machine.epoch + 1,
        state: IntelStates.Booted({ epoch: machine.epoch + 1 }),
      }
    : machine;

/** pierre attached the session of `path`. */
export const bindIntel = (
  machine: IntelMachine,
  path: string
): IntelMachine => ({
  epoch: machine.epoch,
  state: IntelStates.Bound({ epoch: machine.epoch, path }),
});

/** A new file took the pane: its session is not attached yet, and the old
 * epoch's markers are stale. */
export const detachIntel = (
  machine: IntelMachine,
  path: string | null
): IntelMachine => ({
  epoch: machine.epoch + 1,
  state: IntelStates.Detached({ epoch: machine.epoch + 1, path }),
});

/** The session threw (it went away between the check and the write): the next
 * attach settles it. Leaves the epoch alone — the run that threw is not a new
 * generation of the program. */
export const loseIntelSession = (machine: IntelMachine): IntelMachine =>
  machine.state._tag === "Bound"
    ? {
        epoch: machine.epoch,
        state: IntelStates.Detached({
          epoch: machine.epoch,
          path: machine.state.path,
        }),
      }
    : machine;

/** A push or a ref switch re-reads the program: everything goes, the latch
 * with it. */
export const resetIntel = (machine: IntelMachine): IntelMachine => ({
  epoch: machine.epoch + 1,
  state: IntelStates.Off(),
});
