//! The tree's inline add naming: the placeholder row an add parks while
//! pierre's own inline input names it. One machine, so a callback that lands
//! after the placeholder was taken back (Esc, a refusal, a tree rebuild, a
//! second add) is recognised and refused instead of being mistaken for a
//! rename of a row the checkout already had — that mistake sent a
//! `workspace().rename()` for a path the pod never held.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Naming: start{add}         (refused while Naming)
//!   Naming --> Landed: settled{held} / renamed{own placeholder}
//!   Naming --> Refused: refused{message}
//!   Naming --> Idle: cleared            (a tree rebuild took the row)
//!   Landed --> Naming: start{add}
//!   Refused --> Naming: start{add}
//! ```
//!
//! `Refused` and `Idle` keep the last placeholder, so a late `renamed` for it
//! is refused by identity (the token) rather than forwarded as a move.

import { Data } from "effect";

/** The placeholder row an add parked in the tree while pierre's inline input
 * names it. An untouched name is no rename to pierre, so the row keeps this
 * path — and `isFolder` says which draft it becomes. */
export interface PendingAdd {
  readonly isFolder: boolean;
  readonly path: string;
}

/** A pierre rename, as the naming flow reads it. */
export interface RenameEvent {
  readonly destinationPath: string;
  readonly isFolder: boolean;
  readonly sourcePath: string;
}

/** What the naming flow holds. */
export type NamingState = Data.TaggedEnum<{
  /** Nothing is being named; `owned` remembers the last placeholder. */
  Idle: Record<never, never>;
  Naming: { add: PendingAdd; token: number };
  /** pierre refused the name: the row was dropped, waiting for the next add. */
  Refused: { add: PendingAdd };
  /** The add landed as a file or folder. */
  Landed: { add: PendingAdd };
}>;

export const NamingStates = Data.taggedEnum<NamingState>();

/** The machine: its state, the token each add gets, and the last placeholder
 * this pane parked (so a late callback for it is recognised). */
export interface NamingMachine {
  readonly owned: PendingAdd | null;
  readonly seq: number;
  readonly state: NamingState;
}

export const newNamingMachine = (): NamingMachine => ({
  owned: null,
  seq: 0,
  state: NamingStates.Idle(),
});

/** What the caller must do. */
export interface NamingDecision {
  /** Drop this row (a refused name, or a stale placeholder pierre left). */
  readonly drop: string | null;
  /** Land this add as a file/folder write. */
  readonly land: PendingAdd | null;
  /** Report this message. */
  readonly notify: string | null;
  /** The event was refused (nothing may happen). */
  readonly refused: boolean;
  /** A rename of a row the checkout already had: mirror it into the pod. */
  readonly rename: RenameEvent | null;
  readonly machine: NamingMachine;
}

const sameAdd = (a: PendingAdd, b: PendingAdd): boolean =>
  a.isFolder === b.isFolder && a.path === b.path;

/** A New File / New Folder pick. Refused while another name is being typed:
 * a second placeholder would orphan the first one's inline input. */
export const startNaming = (
  machine: NamingMachine,
  add: PendingAdd
): { readonly accepted: boolean; readonly machine: NamingMachine } =>
  machine.state._tag === "Naming"
    ? { accepted: false, machine }
    : {
        accepted: true,
        machine: {
          owned: add,
          seq: machine.seq + 1,
          state: NamingStates.Naming({ add, token: machine.seq + 1 }),
        },
      };

/** The inline input closed without a rename (an untouched name): land the
 * placeholder when pierre still holds it. */
export const settleNaming = (
  machine: NamingMachine,
  add: PendingAdd,
  held: boolean
): NamingDecision => {
  const { state } = machine;

  if (state._tag !== "Naming" || !sameAdd(state.add, add)) {
    return {
      drop: null,
      land: null,
      machine,
      notify: null,
      refused: true,
      rename: null,
    };
  }

  return {
    drop: null,
    land: held ? add : null,
    machine: { ...machine, state: NamingStates.Landed({ add }) },
    notify: null,
    refused: false,
    rename: null,
  };
};

/** pierre refused the name itself: the placeholder row goes, and the report
 * explains why. */
export const refuseNaming = (
  machine: NamingMachine,
  message: string
): NamingDecision => {
  const add = machine.owned;

  if (machine.state._tag !== "Naming" || add === null) {
    return {
      drop: null,
      land: null,
      machine,
      notify: null,
      refused: true,
      rename: null,
    };
  }

  return {
    drop: add.isFolder ? `${add.path}/` : add.path,
    land: null,
    machine: { ...machine, state: NamingStates.Refused({ add }) },
    notify: message,
    refused: false,
    rename: null,
  };
};

/** A pierre rename landed. Only the placeholder that is *currently* being
 * named may become a new file: a rename for a placeholder this pane already
 * dropped is stale and is swallowed, and anything else is a move. */
export const finishNaming = (
  machine: NamingMachine,
  event: RenameEvent
): NamingDecision => {
  const { state } = machine;
  const { owned } = machine;

  if (state._tag === "Naming" && event.sourcePath === state.add.path) {
    const add: PendingAdd = {
      isFolder: event.isFolder,
      path: event.destinationPath,
    };

    return {
      drop: null,
      land: add,
      machine: {
        ...machine,
        owned: add,
        state: NamingStates.Landed({ add }),
      },
      notify: null,
      refused: false,
      rename: null,
    };
  }

  if (owned !== null && event.sourcePath === owned.path) {
    // The placeholder is gone (Esc, a refusal, a rebuild), but pierre still
    // reported its rename: never mirror that into the pod as a move of a path
    // that never existed.
    return {
      drop: null,
      land: null,
      machine,
      notify: null,
      refused: true,
      rename: null,
    };
  }

  return {
    drop: null,
    land: null,
    machine,
    notify: null,
    refused: false,
    rename: event,
  };
};

/** Forget the placeholder being named: a tree rebuild dropped its row, so a
 * callback still in flight for it must not land. */
export const clearNaming = (machine: NamingMachine): NamingMachine =>
  machine.state._tag === "Idle"
    ? machine
    : { ...machine, state: NamingStates.Idle() };
