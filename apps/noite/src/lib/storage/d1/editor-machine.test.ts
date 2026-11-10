import { describe, expect, test } from "bun:test";

import type { D1Column, D1TableSchema } from "../../runner";
import { draftFromCell, typedText } from "../d1-values";
import { Phase, nextEditor } from "./editor-machine";
import type { EditorContext, EditorEvent, EditorPhase } from "./editor-machine";

const col = (name: string, extra: Partial<D1Column> = {}): D1Column => ({
  defaultValue: null,
  name,
  notNull: false,
  pk: 0,
  type: "TEXT",
  ...extra,
});

const COLUMNS: D1Column[] = [col("id", { pk: 1 }), col("name")];

const CAPS = {
  delete: true,
  insert: true,
  update: true,
} satisfies D1TableSchema["caps"];

const schema = (caps: D1TableSchema["caps"]): D1TableSchema => ({
  caps,
  columns: COLUMNS,
  foreignKeys: [],
  indexes: [],
  locked: {},
  redacted: [],
  rowAction: null,
  sql: "",
  table: "users",
});

const EDIT_CONTEXT: EditorContext = {
  columns: COLUMNS,
  isEdit: true,
  locked: [],
  original: { id: "u1", name: "Ada" },
  schema: schema(CAPS),
};

const drafts = () => ({
  id: draftFromCell("u1"),
  name: draftFromCell("Ada"),
});

const editing = (): EditorPhase => Phase.Editing({ drafts: drafts() });

/** Apply a sequence of events, returning the final state. */
const run = (events: EditorEvent[], start: EditorPhase = editing()) => {
  let state = start;

  for (const event of events) {
    ({ state } = nextEditor(state, event, EDIT_CONTEXT));
  }

  return state;
};

const dirtyEditing = (): EditorPhase =>
  run([{ draft: typedText("Ada Lovelace"), kind: "patch", name: "name" }]);

describe("row editor machine", () => {
  test("save from a clean editor is refused", () => {
    const step = nextEditor(editing(), { kind: "save" }, EDIT_CONTEXT);

    expect(step.state._tag).toBe("Editing");
    expect(step.effect.kind).toBe("none");
  });

  test("a dirty save builds the update body once", () => {
    const step = nextEditor(dirtyEditing(), { kind: "save" }, EDIT_CONTEXT);

    expect(step.state._tag).toBe("Saving");
    expect(step.effect).toEqual({
      body: {
        key: { id: "u1" },
        op: "update",
        table: "users",
        values: { name: "Ada Lovelace" },
      },
      kind: "save",
    });
    expect(
      nextEditor(step.state, { kind: "saved" }, EDIT_CONTEXT).state._tag
    ).toBe("Closed");
  });

  test("edits are refused while a save is in flight", () => {
    // P2 fail-before: inputs were not disabled by `busy`, so an edit during
    // the await could be committed or silently dropped.
    const saving = nextEditor(
      dirtyEditing(),
      { kind: "save" },
      EDIT_CONTEXT
    ).state;

    const edited = nextEditor(
      saving,
      { draft: typedText("Grace"), kind: "patch", name: "name" },
      EDIT_CONTEXT
    );

    expect(edited.state).toEqual(saving);
  });

  test("Esc cannot close the editor mid-save", () => {
    // P2 fail-before: the native dialog closed, the guard was set on a
    // component that unmounted when the save resolved, and the write landed
    // silently.
    const saving = nextEditor(
      dirtyEditing(),
      { kind: "save" },
      EDIT_CONTEXT
    ).state;

    const step = nextEditor(saving, { kind: "closeRequest" }, EDIT_CONTEXT);

    expect(step.state._tag).toBe("Saving");
    expect(step.effect.kind).toBe("none");
  });

  test("a failed save keeps the drafts and can be retried", () => {
    const saving = nextEditor(
      dirtyEditing(),
      { kind: "save" },
      EDIT_CONTEXT
    ).state;

    const failed = nextEditor(
      saving,
      { kind: "failed", message: "disk full" },
      EDIT_CONTEXT
    ).state;

    expect(failed._tag).toBe("Failed");
    expect(nextEditor(failed, { kind: "save" }, EDIT_CONTEXT).state._tag).toBe(
      "Saving"
    );
  });

  test("a dirty close arms the guard instead of closing", () => {
    const step = nextEditor(
      dirtyEditing(),
      { kind: "closeRequest" },
      EDIT_CONTEXT
    );

    expect(step.state._tag).toBe("Guarded");
    expect(step.effect.kind).toBe("none");
  });

  test("a second guard request keeps the first target", () => {
    // P2 fail-before: a second `pending.set(...)` overwrote the first, so the
    // unsaved-changes prompt vanished while the drafts were still dirty.
    const guarded = nextEditor(
      dirtyEditing(),
      { kind: "closeRequest" },
      EDIT_CONTEXT
    ).state;

    const target = {
      column: "id",
      kind: "fk" as const,
      table: "teams",
      value: "t1",
    };

    const after = nextEditor(
      guarded,
      { kind: "fkRequest", target },
      EDIT_CONTEXT
    ).state;

    expect(after).toEqual(guarded);
  });

  test("discarding a close guard closes; discarding an FK guard navigates", () => {
    const target = {
      column: "id",
      kind: "fk" as const,
      table: "teams",
      value: "t1",
    };

    const dirty = dirtyEditing();

    const fkGuarded = nextEditor(
      dirty,
      { kind: "fkRequest", target },
      EDIT_CONTEXT
    );

    expect(fkGuarded.state._tag).toBe("Guarded");
    expect(fkGuarded.effect.kind).toBe("none");

    const discarded = nextEditor(
      fkGuarded.state,
      { kind: "guardDiscard" },
      EDIT_CONTEXT
    );

    expect(discarded.state._tag).toBe("Closed");
    expect(discarded.effect).toEqual({ kind: "navigate", target });
  });

  test("keep editing returns to the drafts", () => {
    const guarded = nextEditor(
      dirtyEditing(),
      { kind: "closeRequest" },
      EDIT_CONTEXT
    ).state;

    const back = nextEditor(
      guarded,
      { kind: "guardCancel" },
      EDIT_CONTEXT
    ).state;

    expect(back._tag).toBe("Editing");
    expect(nextEditor(back, { kind: "save" }, EDIT_CONTEXT).state._tag).toBe(
      "Saving"
    );
  });

  test("Esc over the delete arm drops the arm, not the editor", () => {
    const armed = run([{ kind: "deleteRequest" }]);
    expect(armed._tag).toBe("DeleteConfirm");

    const escaped = nextEditor(
      armed,
      { kind: "closeRequest" },
      EDIT_CONTEXT
    ).state;

    expect(escaped._tag).toBe("Editing");
  });

  test("delete is refused for a read-only table", () => {
    const context: EditorContext = {
      ...EDIT_CONTEXT,
      schema: schema({ ...CAPS, delete: false }),
    };

    const step = nextEditor(editing(), { kind: "deleteRequest" }, context);

    expect(step.state._tag).toBe("Editing");
  });

  test("the delete effect carries the row key", () => {
    const step = nextEditor(
      Phase.DeleteConfirm({ drafts: drafts() }),
      { kind: "deleteConfirm" },
      EDIT_CONTEXT
    );

    expect(step.state._tag).toBe("Deleting");
    expect(step.effect).toEqual({ key: { id: "u1" }, kind: "delete" });
  });
});
