import { expect, test } from "bun:test";

import {
  rowBadge,
  rowBytes,
  rowDiffed,
  rowDiscardable,
  RowViews,
  rowLabel,
  rowUndoable,
  rowView,
} from "./row-view";
import type { WorkspaceChange } from "./workspace/types";

const change = (over: Partial<WorkspaceChange>): WorkspaceChange => ({
  after: "",
  before: "",
  kind: "modified",
  path: "a.ts",
  ...over,
});

test("a row whose committed text is still being read keeps its actions", () => {
  // The bug: `after` and `before` were both "" while loading, so `hasEdit`
  // said false and the row hid both its Discard and its diff.
  const loading = rowView(change({ loading: true }));

  expect(loading._tag).toBe("Loading");
  expect(rowDiscardable(loading)).toBe(true);
  expect(rowDiffed(loading)).toBe(false);
  expect(rowUndoable(loading)).toBe(false);
});

test("an upload carries its bytes and no diff", () => {
  const uploaded = rowView(
    change({ binary: 2048, kind: "added", path: "logo.png" })
  );

  expect(uploaded._tag).toBe("Binary");
  expect(rowBytes(uploaded)).toBe(2048);
  expect(rowDiffed(uploaded)).toBe(false);
  expect(rowBadge(uploaded).label).toBe("binary");
});

test("a staged deletion offers Restore, not Discard", () => {
  const deleted = rowView(change({ kind: "deleted" }));

  expect(rowDiscardable(deleted)).toBe(false);
  expect(rowUndoable(deleted)).toBe(true);
  expect(rowBadge(deleted).class).toBe("badge-error");
});

test("a move distinguishes a pure rename from one with edits", () => {
  const pure = rowView(
    change({ after: "same", before: "same", kind: "moved", movedFrom: "b.ts" })
  );

  expect(pure._tag).toBe("Move");
  expect(rowDiffed(pure)).toBe(false);
  expect(rowDiscardable(pure)).toBe(false);
  expect(rowLabel(pure)).toBe("b.ts → a.ts");

  const edited = rowView(
    change({ after: "two", before: "one", kind: "moved", movedFrom: "b.ts" })
  );

  expect(rowDiffed(edited)).toBe(true);
  expect(rowDiscardable(edited)).toBe(true);
});

test("a text change is a diff", () => {
  const text = rowView(change({ after: "two", before: "one" }));

  expect(text._tag).toBe("Text");
  expect(rowDiffed(text)).toBe(true);
  expect(rowView(change({}))).toEqual(
    RowViews.Text({ kind: "modified", path: "a.ts" })
  );
});
