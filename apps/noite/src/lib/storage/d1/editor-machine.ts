//! The D1 row editor's lifecycle: one closed state, one transition function
//! returning the next state plus the effect to run, and a dirty/discard guard
//! that is a state instead of a re-opened dialog.
//!
//! The editor used to carry five independent atoms (`open`, `busy`,
//! `confirmingDelete`, `failure`, `pending`) plus a `dirty` derived from the
//! drafts. That allowed states like "saving while the close guard is armed",
//! made Esc mid-save silently lose the guard, and let a second guard request
//! overwrite the first one's target. Here the drafts live in the state, every
//! message goes through {@link nextEditor}, and the effects the component
//! must perform are values it switches on.
//!
//! ```text
//! Editing ──save (dirty, canUpdate)──▶ Saving ──saved──▶ Closed
//!    │                                   └──saveFailed──▶ Failed ──save──▶ Saving
//!    ├──deleteRequest──▶ DeleteConfirm ──deleteConfirm──▶ Deleting ──deleted──▶ Closed
//!    │                        └──deleteCancel──▶ Editing         └──deleteFailed──▶ Failed
//!    ├──closeRequest (dirty)──▶ Guarded{action} ──guardDiscard──▶ Closed | navigate
//!    │                              └──guardCancel──▶ Editing
//!    ├──closeRequest (clean)──▶ Closed
//!    └──closeRequest (DeleteConfirm)──▶ Editing
//! Saving and Deleting refuse every other message: the request in flight
//! always matches what the user confirmed, and the guard cannot be discarded
//! from under a write.
//! ```

import { Data } from "effect";

import type {
  D1Cell,
  D1Column,
  D1Key,
  D1TableSchema,
  D1WriteBody,
} from "../../runner";
import type { FieldDraft, FieldDrafts } from "../d1-values";
import { keyFor, writeValues } from "../d1-values";

/** What the user asked for while the drafts were dirty. */
export type PendingAction =
  | { readonly kind: "close" }
  | {
      readonly column: string;
      readonly kind: "fk";
      readonly table: string;
      readonly value: D1Cell;
    };

export type EditorPhase = Data.TaggedEnum<{
  /** Drafts are editable (the only state that accepts edits). */
  Editing: { readonly drafts: FieldDrafts };
  /** A save is in flight; edits and close requests are refused. */
  Saving: { readonly drafts: FieldDrafts };
  /** The row's delete is armed. */
  DeleteConfirm: { readonly drafts: FieldDrafts };
  /** A delete is in flight. */
  Deleting: { readonly drafts: FieldDrafts };
  /** A dirty close/FK jump waits on the discard decision. */
  Guarded: { readonly action: PendingAction; readonly drafts: FieldDrafts };
  /** The last save/delete failed; drafts stay editable again. */
  Failed: {
    readonly drafts: FieldDrafts;
    readonly message: string;
  };
  /** The editor is done; the component unmounts. */
  Closed: Record<never, never>;
}>;

export const Phase = Data.taggedEnum<EditorPhase>();

/** The effect the component must perform for one step. */
export type EditorEffect =
  | { readonly kind: "none" }
  | { readonly kind: "close" }
  | {
      readonly kind: "navigate";
      readonly target: PendingAction & { readonly kind: "fk" };
    }
  | { readonly body: D1WriteBody; readonly kind: "save" }
  | { readonly key: D1Key; readonly kind: "delete" };

export interface EditorStep {
  readonly effect: EditorEffect;
  readonly state: EditorPhase;
}

/** Everything the machine reads besides the state. */
export interface EditorContext {
  readonly columns: readonly D1Column[];
  readonly isEdit: boolean;
  /** Columns the editor must never write back (locked + redacted). */
  readonly locked: readonly string[];
  /** The row the editor opened on ({} for INSERT). */
  readonly original: Record<string, D1Cell>;
  readonly schema: D1TableSchema;
}

export type EditorEvent =
  | {
      readonly draft: FieldDraft;
      readonly kind: "patch";
      readonly name: string;
    }
  | { readonly kind: "save" }
  | { readonly kind: "saved" }
  | { readonly message: string; readonly kind: "failed" }
  | { readonly kind: "deleteRequest" }
  | { readonly kind: "deleteConfirm" }
  | { readonly kind: "deleteCancel" }
  | { readonly kind: "deleted" }
  | { readonly kind: "closeRequest" }
  | {
      readonly kind: "fkRequest";
      readonly target: PendingAction & { readonly kind: "fk" };
    }
  | { readonly kind: "guardDiscard" }
  | { readonly kind: "guardCancel" };

/** The drafts a phase carries (`null` once closed). */
export const draftsOf = (state: EditorPhase): FieldDrafts | null =>
  state._tag === "Closed" ? null : state.drafts;

/** Whether the current drafts would write anything (the footer's count). */
export const changesOf = (
  state: EditorPhase,
  context: EditorContext
): string[] => {
  const drafts = draftsOf(state);

  return drafts === null
    ? []
    : Object.keys(
        writeValues({
          columns: context.columns,
          drafts,
          isEdit: context.isEdit,
          locked: context.locked,
          original: context.original,
        })
      );
};

const withDrafts = (state: EditorPhase, drafts: FieldDrafts): EditorPhase => {
  switch (state._tag) {
    case "Editing": {
      return Phase.Editing({ drafts });
    }

    case "Saving": {
      return Phase.Saving({ drafts });
    }

    case "DeleteConfirm": {
      return Phase.DeleteConfirm({ drafts });
    }

    case "Deleting": {
      return Phase.Deleting({ drafts });
    }

    case "Guarded": {
      return Phase.Guarded({ action: state.action, drafts });
    }

    case "Failed": {
      return Phase.Failed({ drafts, message: state.message });
    }

    default: {
      return state;
    }
  }
};

const closedStep: EditorStep = {
  effect: { kind: "none" },
  state: Phase.Closed(),
};

const stay = (state: EditorPhase): EditorStep => ({
  effect: { kind: "none" },
  state,
});

/** The refusal step for a write in flight. */
const inFlightEditorStep = (
  state: EditorPhase,
  event: EditorEvent
): EditorStep | null => {
  if (state._tag === "Saving") {
    if (event.kind === "saved") {
      return closedStep;
    }

    if (event.kind === "failed") {
      return {
        effect: { kind: "none" },
        state: Phase.Failed({ drafts: state.drafts, message: event.message }),
      };
    }

    return stay(state);
  }

  if (state._tag === "Deleting") {
    if (event.kind === "deleted") {
      return closedStep;
    }

    if (event.kind === "failed") {
      return {
        effect: { kind: "none" },
        state: Phase.Failed({ drafts: state.drafts, message: event.message }),
      };
    }

    return stay(state);
  }

  return null;
};

/** The step a close/FK request takes when the drafts are dirty. */
const guardStep = (
  state: EditorPhase,
  action: PendingAction,
  drafts: FieldDrafts
): EditorStep =>
  state._tag === "Guarded"
    ? stay(state)
    : stay(Phase.Guarded({ action, drafts }));

/** The save step: builds the wire body once, and only for a legal save. */
const saveStep = (
  state: EditorPhase,
  drafts: FieldDrafts,
  context: EditorContext
): EditorStep => {
  const body: D1WriteBody = {
    op: context.isEdit ? "update" : "insert",
    table: context.schema.table,
    values: writeValues({
      columns: context.columns,
      drafts,
      isEdit: context.isEdit,
      locked: context.locked,
      original: context.original,
    }),
  };

  if (context.isEdit) {
    body.key = keyFor(context.columns, context.original);
  }

  return {
    effect: { body, kind: "save" },
    state: Phase.Saving({ drafts }),
  };
};

/** The editing events: field edits, save, and the delete arm. */
const editStep = (
  state: EditorPhase,
  event: EditorEvent,
  context: EditorContext,
  drafts: FieldDrafts
): EditorStep => {
  const canUpdate = context.schema.caps.update || !context.isEdit;
  const changed = changesOf(state, context).length > 0;

  switch (event.kind) {
    case "patch": {
      if (state._tag !== "Editing" && state._tag !== "Failed") {
        return stay(state);
      }

      return stay(withDrafts(state, { ...drafts, [event.name]: event.draft }));
    }

    case "save": {
      return changed && canUpdate
        ? saveStep(state, drafts, context)
        : stay(state);
    }

    case "failed": {
      return stay(Phase.Failed({ drafts, message: event.message }));
    }

    case "saved":
    case "deleted": {
      return closedStep;
    }

    case "deleteRequest": {
      return context.isEdit && context.schema.caps.delete
        ? stay(Phase.DeleteConfirm({ drafts }))
        : stay(state);
    }

    case "deleteConfirm": {
      return state._tag === "DeleteConfirm"
        ? {
            effect: {
              key: keyFor(context.columns, context.original),
              kind: "delete",
            },
            state: Phase.Deleting({ drafts }),
          }
        : stay(state);
    }

    case "deleteCancel": {
      return state._tag === "DeleteConfirm"
        ? stay(Phase.Editing({ drafts }))
        : stay(state);
    }

    default: {
      return stay(state);
    }
  }
};

/** The leaving events: close, FK jump, and the discard decision. */
const leaveStep = (
  state: EditorPhase,
  event: EditorEvent,
  context: EditorContext,
  drafts: FieldDrafts
): EditorStep => {
  const changed = changesOf(state, context).length > 0;

  if (event.kind === "closeRequest") {
    if (state._tag === "DeleteConfirm") {
      // Esc over the delete arm drops the arm, not the editor.
      return stay(Phase.Editing({ drafts }));
    }

    if (changed) {
      return guardStep(state, { kind: "close" }, drafts);
    }

    return { effect: { kind: "close" }, state: Phase.Closed() };
  }

  if (event.kind === "fkRequest") {
    if (changed) {
      return guardStep(state, event.target, drafts);
    }

    return {
      effect: { kind: "navigate", target: event.target },
      state: Phase.Closed(),
    };
  }

  if (event.kind === "guardDiscard") {
    if (state._tag !== "Guarded") {
      return stay(state);
    }

    return state.action.kind === "close"
      ? { effect: { kind: "close" }, state: Phase.Closed() }
      : {
          effect: { kind: "navigate", target: state.action },
          state: Phase.Closed(),
        };
  }

  if (event.kind === "guardCancel") {
    return state._tag === "Guarded"
      ? stay(Phase.Editing({ drafts }))
      : stay(state);
  }

  return stay(state);
};

/** The one transition function for the row editor. Illegal events return the
 * state unchanged (a refusal, not a silent flag flip). */
export const nextEditor = (
  state: EditorPhase,
  event: EditorEvent,
  context: EditorContext
): EditorStep => {
  // A write in flight owns the editor: edits, closes and guards wait.
  const inFlight = inFlightEditorStep(state, event);

  if (inFlight !== null) {
    return inFlight;
  }

  const drafts = draftsOf(state) ?? {};

  switch (event.kind) {
    case "closeRequest":
    case "fkRequest":
    case "guardDiscard":
    case "guardCancel": {
      return leaveStep(state, event, context, drafts);
    }

    default: {
      return editStep(state, event, context, drafts);
    }
  }
};

/** The row the editor opened on, as a `keyFor` value (footer label). */
export const keyLabel = (
  columns: readonly D1Column[],
  row: Record<string, D1Cell>
): string => {
  const key = keyFor(columns, row);

  return Object.entries(key)
    .map(([name, value]) => `${name} = ${value === null ? "NULL" : value}`)
    .join(", ");
};
