import { describe, expect, test } from "bun:test";

import {
  rowBadge,
  rowBytes,
  rowDiffed,
  rowDiscardable,
  rowLabel,
  rowUndoable,
  rowView,
} from "./row-view";
import type { SourceChange } from "./session";

const change = (patch: Partial<SourceChange>): SourceChange => ({
  after: "",
  before: "",
  kind: "modified",
  path: "src/app.ts",
  ...patch,
});

describe("change rows", () => {
  test("a text change has a diff and a discard", () => {
    const row = rowView(change({ after: "b", before: "a" }));

    expect(row._tag).toBe("Text");
    expect(rowDiffed(row)).toBe(true);
    expect(rowDiscardable(row)).toBe(true);
    expect(rowUndoable(row)).toBe(false);
    expect(rowBadge(row)).toEqual({
      class: "badge-neutral",
      label: "modified",
    });
    expect(rowLabel(row)).toBe("src/app.ts");
  });

  test("an upload shows its size instead of a diff", () => {
    const row = rowView(change({ bytes: 12, kind: "added", path: "logo.png" }));

    expect(row._tag).toBe("Upload");
    expect(rowDiffed(row)).toBe(false);
    expect(rowDiscardable(row)).toBe(true);
    expect(rowBytes(row)).toBe(12);
  });

  test("a staged deletion can only be undone", () => {
    const row = rowView(
      change({ before: null, kind: "deleted", path: "src/lib.ts" })
    );

    expect(row._tag).toBe("Deleted");
    expect(rowDiffed(row)).toBe(false);
    expect(rowDiscardable(row)).toBe(false);
    expect(rowUndoable(row)).toBe(true);
  });

  test("a pure move has no discard, only a restore", () => {
    const row = rowView(
      change({ after: "a", before: "a", kind: "moved", movedFrom: "a.ts" })
    );

    expect(row._tag).toBe("Move");
    expect(rowDiffed(row)).toBe(false);
    expect(rowDiscardable(row)).toBe(false);
    expect(rowUndoable(row)).toBe(true);
    expect(rowLabel(row)).toBe("a.ts → src/app.ts");
  });

  test("a moved file whose text changed also has a diff", () => {
    const row = rowView(
      change({
        after: "b",
        before: "a",
        kind: "moved",
        movedFrom: "a.ts",
      })
    );

    expect(rowDiffed(row)).toBe(true);
    expect(rowDiscardable(row)).toBe(true);
  });

  test("a move the page never read is not an edit", () => {
    const row = rowView(change({ before: null, kind: "moved" }));

    expect(row._tag === "Move" && row.edited).toBe(false);
    expect(rowUndoable(row)).toBe(true);
  });
});
