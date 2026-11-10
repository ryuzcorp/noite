import { describe, expect, test } from "bun:test";

import { Comment, commentDraft, nextComment } from "./composer";

describe("comment editor", () => {
  test("edit seeds the draft from the current text", () => {
    const step = nextComment(Comment.Read(), {
      kind: "edit",
      original: "remote edit",
    });

    expect(step.state._tag).toBe("Editing");
    expect(commentDraft(step.state)).toBe("remote edit");
  });

  test("a blank submit posts nothing", () => {
    const step = nextComment(Comment.Editing({ draft: "   " }), {
      kind: "submit",
    });

    expect(step.state._tag).toBe("Editing");
    expect(step.effect.kind).toBe("none");
  });

  test("saving refuses edits and cancel; a failure keeps the draft", () => {
    const saving = nextComment(Comment.Editing({ draft: "hi" }), {
      kind: "submit",
    });

    expect(saving.effect).toEqual({ body: "hi", kind: "save" });
    expect(
      nextComment(saving.state, { draft: "changed", kind: "change" }).state
    ).toEqual(saving.state);
    expect(nextComment(saving.state, { kind: "cancel" }).state).toEqual(
      saving.state
    );

    const failed = nextComment(saving.state, {
      kind: "failed",
      message: "offline",
    });

    expect(failed.state._tag).toBe("Failed");
    expect(commentDraft(failed.state)).toBe("hi");
    expect(nextComment(failed.state, { kind: "cancel" }).state._tag).toBe(
      "Read"
    );
  });

  test("delete is a state, not an awaited browser dialog", () => {
    const armed = nextComment(Comment.Read(), { kind: "deleteRequest" });
    expect(armed.state._tag).toBe("DeleteConfirm");
    expect(armed.effect.kind).toBe("none");

    const confirming = nextComment(armed.state, { kind: "deleteConfirm" });
    expect(confirming.effect.kind).toBe("delete");
    expect(confirming.state._tag).toBe("Deleting");
    expect(nextComment(confirming.state, { kind: "deleted" }).state._tag).toBe(
      "Gone"
    );
  });
});
