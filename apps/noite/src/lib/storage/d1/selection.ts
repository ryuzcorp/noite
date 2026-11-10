//! The D1 grid's bulk-selection machine: one closed state, one transition
//! function, and keys that never depend on the row order the server sent.
//!
//! A row's identity is its `keyFor` key (primary keys, or every column when
//! the table has none), serialized by {@link rowKey}. The grid used to key
//! its selection by array index, so any refresh that reordered or filtered
//! the rows remapped the selection onto different records and a bulk delete
//! removed rows nobody picked. Keying by the record's own key makes that
//! state unrepresentable: a key that is no longer on the page is simply not
//! visible, and only visible keys can be deleted.
//!
//! ```text
//! Idle ──toggle/toggleAll──▶ Selecting ──arm──▶ Confirm ──confirm──▶ Deleting
//!   ▲                          ▲   │              │                     │
//!   │                          │   └──cancel──────┘                     │
//!   │                          │                                        ├─deleted──▶ Idle
//!   │                          └──────────────toggle/toggleAll──────────┘
//!   └────────clear───────────────────────────────────────────────────────┤
//!                                                                       └─failed──▶ Failed
//! Failed ──arm──▶ Confirm        Failed ──toggle/toggleAll/clear──▶ Selecting/Idle
//! ```
//!
//! The armed confirmation carries the key set it was armed for: changing the
//! selection drops the arm (a confirm can never point at a different set),
//! and closing the bar clears the arm with the selection. `Deleting` refuses
//! every selection change, so the payload a request in flight deletes is the
//! payload the user confirmed.

import { Data } from "effect";

import type { D1Cell, D1Column, D1Key } from "../../runner";
import { keyFor } from "../d1-values";

/** A row's stable identity string: its `keyFor` key in column order. */
export const rowKey = (
  columns: readonly D1Column[],
  row: Record<string, D1Cell>
): string => JSON.stringify(keyFor(columns, row));

/** The key object a selection key stands for. */
export const keyFromRowKey = (value: string): D1Key =>
  // SAFETY: only `rowKey` produces a selection key, and it stringifies a
  // `Record<string, D1Cell>`; this parses that same shape.
  JSON.parse(value) as D1Key;

export type GridSelection = Data.TaggedEnum<{
  /** Nothing selected; the bulk bar is hidden. */
  Idle: Record<never, never>;
  /** Some rows selected, no confirmation armed. */
  Selecting: { readonly keys: readonly string[] };
  /** A delete is armed for exactly `keys`. */
  Confirm: { readonly keys: readonly string[] };
  /** The delete request is in flight for exactly `keys`. */
  Deleting: { readonly keys: readonly string[] };
  /** The last delete failed; `keys` stay selected so it can be retried. */
  Failed: { readonly error: string; readonly keys: readonly string[] };
}>;

/** The constructors (`Selection.Idle()`, `Selection.Confirm({ keys })`, …). */
export const Selection = Data.taggedEnum<GridSelection>();

/** The keys a state has selected (empty for `Idle`). */
export const selectedKeys = (state: GridSelection): readonly string[] =>
  state._tag === "Idle" ? [] : state.keys;

/** The selected keys that are actually on the page right now. Only these can
 * be deleted, so a record that vanished from the listing (another writer, a
 * filter) is never part of the payload. */
export const visibleSelection = (
  state: GridSelection,
  visibleKeys: readonly string[]
): readonly string[] => {
  const visible = new Set(visibleKeys);

  return selectedKeys(state).filter((key) => visible.has(key));
};

/** What moves a {@link GridSelection}. */
export type GridEvent =
  | { readonly key: string; readonly kind: "toggle" }
  | { readonly keys: readonly string[]; readonly kind: "toggleAll" }
  | { readonly kind: "clear" }
  | { readonly kind: "arm" }
  | { readonly kind: "cancel" }
  | { readonly kind: "confirm" }
  | { readonly kind: "deleted" }
  | { readonly error: string; readonly kind: "failed" };

const selectionOf = (keys: readonly string[]): GridSelection =>
  keys.length === 0 ? Selection.Idle() : Selection.Selecting({ keys });

const toggleKey = (keys: readonly string[], key: string): readonly string[] =>
  keys.includes(key)
    ? keys.filter((candidate) => candidate !== key)
    : [...keys, key];

/** The one transition function for the grid's selection. A refused event
 * returns the state unchanged; `Deleting` refuses every change so the request
 * in flight always matches the confirmation. */
export const nextSelection = (
  state: GridSelection,
  event: GridEvent
): GridSelection => {
  if (state._tag === "Deleting") {
    if (event.kind === "deleted") {
      return Selection.Idle();
    }

    if (event.kind === "failed") {
      return Selection.Failed({ error: event.error, keys: state.keys });
    }

    return state;
  }

  switch (event.kind) {
    case "toggle": {
      // Changing the selection drops an armed confirmation: it was armed for
      // the previous key set.
      const keys = toggleKey(selectedKeys(state), event.key);

      return selectionOf(keys);
    }

    case "toggleAll": {
      const all =
        state._tag !== "Idle" &&
        selectedKeys(state).length === event.keys.length;

      return selectionOf(all ? [] : event.keys);
    }

    case "clear": {
      return Selection.Idle();
    }

    case "arm": {
      if (state._tag === "Selecting" || state._tag === "Failed") {
        return state.keys.length === 0
          ? Selection.Idle()
          : Selection.Confirm({ keys: state.keys });
      }

      return state;
    }

    case "cancel": {
      return state._tag === "Confirm"
        ? Selection.Selecting({ keys: state.keys })
        : state;
    }

    case "confirm": {
      return state._tag === "Confirm"
        ? Selection.Deleting({ keys: state.keys })
        : state;
    }

    case "deleted": {
      return Selection.Idle();
    }

    case "failed": {
      return state._tag === "Confirm"
        ? Selection.Failed({ error: event.error, keys: state.keys })
        : state;
    }

    default: {
      return state;
    }
  }
};
