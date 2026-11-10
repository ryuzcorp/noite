//! The hover tip's lifecycle: one epoch shared by the pane's token hooks and
//! the floating container, so a tip whose answer arrived after the pointer
//! left (or after the file changed) can never open, and the caller learns
//! whether it did.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Waiting: enter{token}
//!   Waiting --> Painting: rest{token}
//!   Waiting --> Lingering: leave
//!   Painting --> Shown: painted{epoch}
//!   Painting --> Idle: painted{stale epoch}
//!   Shown --> Lingering: leave
//!   Lingering --> Idle: expired / hide
//!   Shown --> Idle: hide
//! ```

import { Data } from "effect";

/** Where the tip is in its life for one token. */
export type HoverState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  /** The pointer is on `token`; the delay is running. */
  Waiting: { epoch: number; token: string };
  /** The answer is in and the highlighter is running. */
  Painting: { epoch: number; token: string };
  /** The tip is open on `token`. */
  Shown: { epoch: number; token: string };
  /** The pointer left: the tip closes when the grace period ends. */
  Lingering: { epoch: number; token: string };
}>;

export const HoverStates = Data.taggedEnum<HoverState>();

/** The machine: one epoch, bumped by every event that must invalidate an
 * answer in flight. */
export interface HoverMachine {
  readonly epoch: number;
  readonly state: HoverState;
}

export const newHoverMachine = (): HoverMachine => ({
  epoch: 0,
  state: HoverStates.Idle(),
});

/** The pointer entered `token`: the delay starts, and any earlier answer is
 * invalidated. */
export const hoverEnter = (
  machine: HoverMachine,
  token: string
): HoverMachine => ({
  epoch: machine.epoch + 1,
  state: HoverStates.Waiting({ epoch: machine.epoch + 1, token }),
});

/** The pointer rested on `token`: the epoch to paint under, or null when the
 * pointer already left it. */
export const hoverRest = (machine: HoverMachine, token: string) => {
  const { state } = machine;

  if (state._tag !== "Waiting" || state.token !== token) {
    return { epoch: null, machine };
  }

  return {
    epoch: state.epoch,
    machine: { epoch: state.epoch, state: HoverStates.Painting(state) },
  };
};

/** The answer was highlighted: open only if the epoch is still the one the
 * paint started under (the pointer may have left, or the file changed). */
export const hoverPainted = (machine: HoverMachine, epoch: number) => {
  const { state } = machine;

  if (
    state._tag !== "Painting" ||
    state.epoch !== epoch ||
    machine.epoch !== epoch
  ) {
    return { machine, open: false };
  }

  return {
    machine: { epoch, state: HoverStates.Shown({ epoch, token: state.token }) },
    open: true,
  };
};

/** The pointer left: arm the grace period, or close now when nothing is
 * waiting or shown. */
export const hoverLeave = (machine: HoverMachine) => {
  const { state } = machine;

  if (state._tag === "Idle" || state._tag === "Lingering") {
    return {
      linger: false,
      machine: { epoch: machine.epoch + 1, state: HoverStates.Idle() },
    };
  }

  return {
    linger: true,
    machine: {
      epoch: machine.epoch + 1,
      state: HoverStates.Lingering({
        epoch: machine.epoch + 1,
        token: state.token,
      }),
    },
  };
};

/** The grace period ended for the tip that armed it. */
export const hoverExpired = (machine: HoverMachine, epoch: number) =>
  machine.state._tag === "Lingering" && machine.state.epoch === epoch
    ? { close: true, machine: { epoch, state: HoverStates.Idle() } }
    : { close: false, machine };

/** Close now (the file changed, the pane went) and invalidate every answer in
 * flight. */
export const hoverHide = (machine: HoverMachine): HoverMachine => ({
  epoch: machine.epoch + 1,
  state: HoverStates.Idle(),
});

/** Whether the tip is open. */
export const hoverOpen = (state: HoverState): boolean => state._tag === "Shown";
