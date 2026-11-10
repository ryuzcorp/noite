//! One change as the Changes panel reads it: a closed union that says what the
//! row is, whether it has a diff, and whether there is an edit to throw away —
//! so an upload, a staged deletion, a pure move and a row whose committed text
//! is still being read cannot be confused with one another.
//!
//! ``Loading`` is a real state, not "text with empty fields": a row whose
//! committed copy is still being read is a change the user made, so it keeps
//! its Discard action (it used to hide both buttons and its diff, because its
//! `before` and `after` were both the empty string).

import { Data } from "effect";

import type { ChangeKind, WorkspaceChange } from "./workspace/types";

/** What a change row is. */
export type RowView = Data.TaggedEnum<{
  /** The committed copy is being read: nothing to diff yet. */
  Loading: { path: string };
  /** An upload: bytes, not text. */
  Binary: { bytes: number; kind: ChangeKind; path: string };
  /** A staged deletion: the row undoes it, there is nothing to discard. */
  Deleted: { path: string };
  /** A move: `edited` when the bytes changed on the way too. */
  Move: { edited: boolean; from: string | undefined; path: string };
  /** A text change: a real diff against the commit. */
  Text: { kind: ChangeKind; path: string };
}>;

export const RowViews = Data.taggedEnum<RowView>();

/** Derive the row from the workspace's change. */
export const rowView = (change: WorkspaceChange): RowView => {
  if (change.loading) {
    return RowViews.Loading({ path: change.path });
  }

  if (change.binary !== undefined) {
    return RowViews.Binary({
      bytes: change.binary,
      kind: change.kind,
      path: change.path,
    });
  }

  if (change.kind === "deleted") {
    return RowViews.Deleted({ path: change.path });
  }

  if (change.kind === "moved") {
    return RowViews.Move({
      edited: change.after !== change.before,
      from: change.movedFrom,
      path: change.path,
    });
  }

  return RowViews.Text({ kind: change.kind, path: change.path });
};

/** Whether the row carries a text diff. */
export const rowDiffed = (row: RowView): boolean =>
  row._tag === "Text" || (row._tag === "Move" && row.edited);

/** Whether there is an edit to throw away. A loading row still stands for one:
 * the change exists, only its committed copy has not arrived. */
export const rowDiscardable = (row: RowView): boolean =>
  row._tag !== "Deleted" && !(row._tag === "Move" && !row.edited);

/** Whether the row's action is Restore (undo the deletion or the move). */
export const rowUndoable = (row: RowView): boolean =>
  row._tag === "Deleted" || row._tag === "Move";

/** The row's badge: what it is, and the daisyUI tone it wears. */
export const rowBadge = (row: RowView) => {
  if (row._tag === "Binary") {
    return { class: "badge-neutral", label: "binary" };
  }

  if (row._tag === "Deleted") {
    return { class: "badge-error", label: "deleted" };
  }

  if (row._tag === "Move") {
    return { class: "badge-warning", label: "moved" };
  }

  if (row._tag === "Text") {
    return { class: "badge-neutral", label: row.kind };
  }

  return { class: "badge-neutral", label: "change" };
};

/** What a row reads as: a move shows both paths. */
export const rowLabel = (row: RowView): string =>
  row._tag === "Move" && row.from !== undefined
    ? `${row.from} → ${row.path}`
    : row.path;

/** The bytes an upload row shows beside its path, when it is one. */
export const rowBytes = (row: RowView): number | null =>
  row._tag === "Binary" ? row.bytes : null;
