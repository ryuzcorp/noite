//! One change as the Changes panel reads it: a closed union that says what the
//! row is, whether it has a diff, and whether there is an edit to throw away —
//! so an upload, a staged deletion, a pure move and a text change cannot be
//! confused with one another.

import { Data } from "effect";

import type { ChangeKind, SourceChange } from "./session";

/** What a change row is. */
export type RowView = Data.TaggedEnum<{
  /** An upload: bytes, not text. */
  Upload: { bytes: number; path: string };
  /** A staged deletion: the row undoes it, there is nothing to discard. */
  Deleted: { path: string };
  /** A move: `edited` when the bytes changed on the way too. */
  Move: { edited: boolean; from: string | undefined; path: string };
  /** A text change: a real diff against the commit. */
  Text: { kind: ChangeKind; path: string };
}>;

export const RowViews = Data.taggedEnum<RowView>();

/** Derive the row from the session's change. */
export const rowView = (change: SourceChange): RowView => {
  if (change.bytes !== undefined) {
    return RowViews.Upload({ bytes: change.bytes, path: change.path });
  }

  if (change.kind === "deleted") {
    return RowViews.Deleted({ path: change.path });
  }

  if (change.kind === "moved") {
    return RowViews.Move({
      // A move whose committed text this page never read (no buffer) has
      // nothing to compare: only a known, different base counts as edited.
      edited: change.before !== null && change.before !== change.after,
      from: change.movedFrom,
      path: change.path,
    });
  }

  return RowViews.Text({ kind: change.kind, path: change.path });
};

/** Whether the row carries a text diff: a change whose committed side this
 * page never read (a deletion staged from the tree) has nothing to compare. */
export const rowDiffed = (row: RowView): boolean =>
  row._tag === "Text" || (row._tag === "Move" && row.edited);

/** Whether there is an edit to throw away. A pure move has none: the bytes are
 * the commit's, only the path changed, so it can only be undone. */
export const rowDiscardable = (row: RowView): boolean =>
  row._tag !== "Deleted" && !(row._tag === "Move" && !row.edited);

/** Whether the row's action is Restore (undo the deletion or the move). */
export const rowUndoable = (row: RowView): boolean =>
  row._tag === "Deleted" || row._tag === "Move";

/** The row's badge: what it is, and the daisyUI tone it wears. */
export const rowBadge = (row: RowView) => {
  if (row._tag === "Upload") {
    return { class: "badge-neutral", label: "binary" };
  }

  if (row._tag === "Deleted") {
    return { class: "badge-error", label: "deleted" };
  }

  if (row._tag === "Move") {
    return { class: "badge-warning", label: "moved" };
  }

  return { class: "badge-neutral", label: row.kind };
};

/** What a row reads as: a move shows both paths. */
export const rowLabel = (row: RowView): string =>
  row._tag === "Move" && row.from !== undefined
    ? `${row.from} → ${row.path}`
    : row.path;

/** The bytes an upload row shows beside its path, when it is one. */
export const rowBytes = (row: RowView): number | null =>
  row._tag === "Upload" ? row.bytes : null;
