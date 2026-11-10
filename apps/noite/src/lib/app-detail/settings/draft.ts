//! The settings panels' draft-over-saved form. Every section edits one value
//! while the server's copy stays the truth: the draft survives an edit, a
//! save resets it to what was written, a failure keeps it and says why.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Clean
//!   Clean --> Dirty: Edited
//!   Dirty --> Dirty: Edited
//!   Dirty --> Saving: Saving
//!   Saving --> Clean: Saved
//!   Saving --> Failed: Failed
//!   Failed --> Dirty: Edited
//!   Failed --> Saving: Saving
//! ```
//!
//! `saved` is the last value the runner confirmed (or the loaded one); the
//! form is clean exactly while `draft` equals it, so a Save button can be
//! disabled from state instead of a separate flag.

import { Data } from "effect";

export type DraftStatus = Data.TaggedEnum<{
  Clean: Record<never, never>;
  Dirty: Record<never, never>;
  Saving: Record<never, never>;
  Saved: Record<never, never>;
  Failed: { readonly error: string };
}>;

export const DraftStatusTypes = Data.taggedEnum<DraftStatus>();

export interface DraftForm<Value> {
  readonly draft: Value;
  readonly saved: Value;
  readonly status: DraftStatus;
}

export const draftForm = <Value>(saved: Value): DraftForm<Value> => ({
  draft: saved,
  saved,
  status: DraftStatusTypes.Clean(),
});

/** A value that changed in the form: dirty unless it reads back as saved. */
export const editDraft = <Value>(
  form: DraftForm<Value>,
  draft: Value,
  equal: (a: Value, b: Value) => boolean = (a, b) => a === b
): DraftForm<Value> => ({
  ...form,
  draft,
  status:
    equal(draft, form.saved) && form.status._tag !== "Failed"
      ? DraftStatusTypes.Clean()
      : DraftStatusTypes.Dirty(),
});

export const savingDraft = <Value>(
  form: DraftForm<Value>
): DraftForm<Value> => ({
  ...form,
  status: DraftStatusTypes.Saving(),
});

/** The runner answered: the draft becomes the saved value, so a later error
 * (a failed refetch) can never leave a form with nothing to show. */
export const savedDraft = <Value>(
  form: DraftForm<Value>,
  value: Value
): DraftForm<Value> => ({
  draft: value,
  saved: value,
  status: DraftStatusTypes.Saved(),
});

/** The save failed: keep the draft (the user's input is never lost) and
 * paint the reason. */
export const failedDraft = <Value>(
  form: DraftForm<Value>,
  error: string
): DraftForm<Value> => ({
  ...form,
  status: DraftStatusTypes.Failed({ error }),
});

/** A server refetch that disagrees with a clean form updates the baseline;
 * a dirty form keeps its edits. */
export const rebaseDraft = <Value>(
  form: DraftForm<Value>,
  saved: Value
): DraftForm<Value> => {
  if (form.status._tag === "Saving") {
    return form;
  }

  if (form.status._tag === "Dirty" || form.status._tag === "Failed") {
    return { ...form, saved };
  }

  // A form that just saved keeps its "Saved" note while the refetch moves the
  // baseline; a clean form stays clean.
  return form.status._tag === "Saved"
    ? savedDraft(form, saved)
    : draftForm(saved);
};

export const formCanSave = (form: DraftForm<unknown>): boolean =>
  form.status._tag === "Dirty" || form.status._tag === "Failed";

export const formBusy = (form: DraftForm<unknown>): boolean =>
  form.status._tag === "Saving";
