//! The D1 toolbar's search box: what is typed versus what is applied.
//!
//! The URL's `q` is the applied search; `Typing` is the user's draft, which
//! wins only until the debounce commits it. The box shows `searchDisplay`,
//! so after a commit (or any programmatic URL change) it shows the applied
//! value again — the old component seeded a `typed` atom once and then showed
//! text that was no longer the query.
//!
//! ```text
//! Synced ──type──▶ Typing ──commit──▶ Synced
//!                       └──cancel (unmount / next keystroke)──▶ Synced
//! ```
//!
//! The timer is armed by the component and cleared by its unmount cleanup:
//! a draft that is 300 ms old must never commit onto the next table's URL.

import { Data } from "effect";

export type SearchState = Data.TaggedEnum<{
  /** The box shows the applied search. */
  Synced: Record<never, never>;
  /** The user typed; the debounce has not committed yet. */
  Typing: { readonly text: string };
}>;

export const Search = Data.taggedEnum<SearchState>();

/** What moves a {@link SearchState}. */
export type SearchEvent =
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "commit" }
  | { readonly kind: "cancel" };

/** The text the box shows. */
export const searchDisplay = (state: SearchState, applied: string): string =>
  state._tag === "Typing" ? state.text : applied;

/** The draft waiting to commit, or null when synced. */
export const searchDraft = (state: SearchState): string | null =>
  state._tag === "Typing" ? state.text : null;

/** The one transition function. */
export const nextSearch = (
  state: SearchState,
  event: SearchEvent
): SearchState => {
  switch (event.kind) {
    case "type": {
      return Search.Typing({ text: event.text });
    }

    case "commit":
    case "cancel": {
      return Search.Synced();
    }

    default: {
      return state;
    }
  }
};
