//! The R2 folder pager's cursor stack and the page's selection, as explicit
//! values.
//!
//! The pager used to be `cursors: string[]` plus a `pageIndex` narrowed by
//! `Math.min(pageIndex, cursors.length - 1)`: a hidden normalization that
//! silently rendered a different page than the index said, and a stack that
//! was never reset when the listing changed under it (a delete, a refresh).
//! Walking forward from a mid-stack page truncates the forward tokens, and an
//! explicit `reset` returns to the first page.
//!
//! ```text
//! start ──next(token)──▶ pages[…page, token] (index + 1, forward tokens dropped)
//!       ──prev────────▶ index - 1 (at 0 stays)
//!       ──reset───────▶ start
//! ```
//!
//! The selection keeps the focused object (the detail panel) and the checked
//! set (the delete payload) in one value. `toggleAll` and `sync` only ever
//! consider the *visible* listing, so a check can never survive on a row the
//! search filtered away — the bug that let a bulk delete remove objects the
//! user could not see.

import { Data } from "effect";

// ---- Cursor stack --------------------------------------------------------

export interface FolderCursors {
  /** One continuation token per page, first page first. */
  readonly cursors: readonly string[];
  /** Which entry of `cursors` the page shows. */
  readonly index: number;
}

/** A folder, before its first listing. */
export const startFolder = (): FolderCursors => ({ cursors: [""], index: 0 });

/** The continuation token the current page was fetched with. */
export const cursorAt = (state: FolderCursors): string =>
  state.cursors[Math.min(state.index, state.cursors.length - 1)] ?? "";

/** The token to walk forward from the current page. */
export const nextFolder = (
  state: FolderCursors,
  token: string
): FolderCursors => ({
  cursors: [...state.cursors.slice(0, state.index + 1), token],
  index: state.index + 1,
});

/** Walk back one page; the first page stays put. */
export const prevFolder = (state: FolderCursors): FolderCursors => ({
  cursors: state.cursors,
  index: Math.max(state.index - 1, 0),
});

// ---- Selection -----------------------------------------------------------

export interface R2Selection {
  /** The object the detail panel shows. */
  readonly focused: string | null;
  /** The objects a bulk delete would remove. */
  readonly checked: readonly string[];
}

export type R2SelectionEvent = Data.TaggedEnum<{
  /** Open one object in the detail panel. */
  Focus: { readonly key: string | null };
  /** Tick or untick one object. */
  Toggle: { readonly key: string; readonly on: boolean };
  /** Tick every visible object, or clear when all are already ticked. */
  ToggleAll: { readonly visible: readonly string[] };
  /** Drop checks that are no longer visible (a new listing, a new search). */
  Sync: { readonly visible: readonly string[] };
  /** Clear the checks (the bulk bar's Clear, or a finished delete). */
  Clear: Record<never, never>;
}>;

export const R2Sel = Data.taggedEnum<R2SelectionEvent>();

export const emptySelection = (): R2Selection => ({
  checked: [],
  focused: null,
});

/** The checked keys that are visible right now: exactly what a delete may
 * remove. */
export const checkedVisible = (
  selection: R2Selection,
  visible: readonly string[]
): readonly string[] => {
  const shown = new Set(visible);

  return selection.checked.filter((key) => shown.has(key));
};

const toggleKey = (
  keys: readonly string[],
  key: string,
  on: boolean
): readonly string[] => {
  if (on) {
    return keys.includes(key) ? keys : [...keys, key];
  }

  return keys.filter((candidate) => candidate !== key);
};

/** The one transition function for the R2 selection. */
export const nextSelection = (
  selection: R2Selection,
  event: R2SelectionEvent
): R2Selection => {
  switch (event._tag) {
    case "Focus": {
      return { ...selection, focused: event.key };
    }

    case "Toggle": {
      return {
        ...selection,
        checked: toggleKey(selection.checked, event.key, event.on),
      };
    }

    case "ToggleAll": {
      const all =
        event.visible.length > 0 &&
        event.visible.every((key) => selection.checked.includes(key));

      return { ...selection, checked: all ? [] : [...event.visible] };
    }

    case "Sync": {
      return {
        ...selection,
        checked: checkedVisible(selection, event.visible),
      };
    }

    case "Clear": {
      return { ...selection, checked: [] };
    }

    default: {
      return selection;
    }
  }
};
