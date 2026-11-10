//! One upload run at a time: the folder it is for, whether it is reading,
//! asking about a replace, or writing. The old shape kept the target folder in
//! one cell read at `change` time (so a second pick retargeted the first
//! pick's files) and had no busy flag at all (two drops interleaved confirms
//! and writes).
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Picking: picked{dir}       (refused while busy)
//!   Picking --> Reading: changed{token,dir}
//!   Idle --> Reading: dropped{dir}
//!   Reading --> Writing: readsDone
//!   Writing --> Idle: finished
//! ```
//!
//! The target folder is captured at `picked`, and the `changed` event carries
//! the token so it can only answer that pick.

import { Data } from "effect";

/** The upload run in flight. */
export type UploadState = Data.TaggedEnum<{
  Idle: Record<never, never>;
  /** The picker is open (or about to be) for `dir`. */
  Picking: { dir: string; token: number };
  /** The picked/dropped files are being read for `dir`. */
  Reading: { dir: string };
  /** The reads are in and their writes (confirms included) are running. */
  Writing: { dir: string };
}>;

export const UploadStates = Data.taggedEnum<UploadState>();

/** The run's state plus the token each pick gets. */
export interface UploadMachine {
  readonly seq: number;
  readonly state: UploadState;
}

export const newUploadMachine = (): UploadMachine => ({
  seq: 0,
  state: UploadStates.Idle(),
});

/** Whether a run is in flight: a second pick or drop is refused, never
 * interleaved. */
export const uploadBusy = (state: UploadState): boolean =>
  state._tag !== "Idle";

/** The "Upload files…" pick: capture `dir` now, so nothing else can retarget
 * the files the picker will answer with. */
export const startPick = (machine: UploadMachine, dir: string) =>
  machine.state._tag === "Idle"
    ? {
        machine: {
          seq: machine.seq + 1,
          state: UploadStates.Picking({ dir, token: machine.seq + 1 }),
        },
        picked: true,
      }
    : { machine, picked: false };

/** The input's `change` for the pick `token`: accepted only for that pick. */
export const pickChanged = (machine: UploadMachine, token: number) => {
  const { state } = machine;

  if (state._tag !== "Picking" || state.token !== token) {
    return { dir: null, machine };
  }

  return {
    dir: state.dir,
    machine: {
      seq: machine.seq,
      state: UploadStates.Reading({ dir: state.dir }),
    },
  };
};

/** An OS drop names its folder directly; refused while a run is in flight. */
export const startDrop = (machine: UploadMachine, dir: string) =>
  machine.state._tag === "Idle"
    ? {
        machine: { seq: machine.seq, state: UploadStates.Reading({ dir }) },
        started: true,
      }
    : { machine, started: false };

/** The reads are in: the writes (and their confirms) run one by one. */
export const startWriting = (machine: UploadMachine): UploadMachine =>
  machine.state._tag === "Reading"
    ? {
        seq: machine.seq,
        state: UploadStates.Writing({ dir: machine.state.dir }),
      }
    : machine;

/** Every write landed (or was refused): the run is over. */
export const finishUpload = (machine: UploadMachine): UploadMachine =>
  machine.state._tag === "Idle"
    ? machine
    : { seq: machine.seq, state: UploadStates.Idle() };
