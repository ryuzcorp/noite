import { describe, expect, test } from "bun:test";

import {
  DraftStatusTypes,
  draftForm,
  editDraft,
  failedDraft,
  formBusy,
  formCanSave,
  rebaseDraft,
  savedDraft,
  savingDraft,
} from "./draft";

describe("draft form", () => {
  test("an edit back to the saved value is clean again", () => {
    const edited = editDraft(draftForm("a"), "b");

    expect(edited.status._tag).toBe("Dirty");
    expect(editDraft(edited, "a").status._tag).toBe("Clean");
  });

  test("a failure keeps the draft and allows a retry", () => {
    const saving = savingDraft(editDraft(draftForm("a"), "b"));
    const failed = failedDraft(saving, "nope");

    expect(failed.draft).toBe("b");
    expect(formBusy(failed)).toBe(false);
    expect(formCanSave(failed)).toBe(true);
    expect(failed.status).toEqual(DraftStatusTypes.Failed({ error: "nope" }));
  });

  test("a refetch never overwrites a dirty draft", () => {
    const edited = editDraft(draftForm("a"), "b");

    expect(rebaseDraft(edited, "c").draft).toBe("b");
    expect(rebaseDraft(edited, "c").saved).toBe("c");
  });

  test("a saved form is clean and not saveable", () => {
    const saved = savedDraft(draftForm("a"), "b");

    expect(saved.status._tag).toBe("Saved");
    expect(formCanSave(saved)).toBe(false);
  });
});
