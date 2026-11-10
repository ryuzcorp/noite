//! The branch picker's action state: which mutation is running (create,
//! delete, delete-confirm, environment), the ref it names, and the last
//! failure. One value, so a stale error cannot survive a reopen and a confirm
//! cannot be opened twice.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Idle
//!   Idle --> Busy: start{create|delete-confirm|environment}
//!   Busy --> Failed: failed{message}
//!   Busy --> Idle: settled
//!   Failed --> Idle: reopened (the dropdown was reopened)
//!   Failed --> Busy: start{…}
//! ```
//!
//! `delete` has two steps on purpose: the confirm dialog is `delete-confirm`,
//! and the request is `delete`. The delete button is disabled in both, so a
//! second click cannot stack a second dialog.

import { Data } from "effect";

/** What a picker mutation is. `delete-confirm` is the dialog a delete opens. */
export type PickerAction =
  | "create"
  | "delete"
  | "delete-confirm"
  | "environment";

/** The picker's action slot. */
export type PickerState = Data.TaggedEnum<{
  Busy: { action: PickerAction; ref: string };
  Failed: { message: string };
  Idle: Record<never, never>;
}>;

export const PickerStates = Data.taggedEnum<PickerState>();

/** Ask for a mutation: refused while another one (or its confirm) is running. */
export const startAction = (
  state: PickerState,
  action: PickerAction,
  ref: string
): PickerState =>
  state._tag === "Busy" ? state : PickerStates.Busy({ action, ref });

/** The mutation landed. */
export const settleAction = (state: PickerState): PickerState =>
  state._tag === "Busy" ? PickerStates.Idle() : state;

/** The mutation was refused: report why, and free the button. */
export const failAction = (state: PickerState, message: string): PickerState =>
  state._tag === "Busy" ? PickerStates.Failed({ message }) : state;

/** The dropdown was opened (or a ref was picked): the last failure is about a
 * gesture the user has left behind. */
export const reopenPicker = (state: PickerState): PickerState =>
  state._tag === "Failed" ? PickerStates.Idle() : state;

/** Whether a mutation is running (the row actions and the create button). */
export const pickerBusy = (state: PickerState): boolean =>
  state._tag === "Busy";

/** The failure to show under the list, or "". */
export const pickerError = (state: PickerState): string =>
  state._tag === "Failed" ? state.message : "";
