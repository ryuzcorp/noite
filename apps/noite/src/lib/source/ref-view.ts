//! The source browser's ref/checkout lifecycle: which ref the panes are
//! looking at, which one is opening, and why the browse failed. One value, so
//! the banner, the switch spinner, the failure card and the panes cannot
//! disagree; the warm-checkout cache, the request generation and the pod
//! frames stay private to the browser.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Booting
//!   Booting --> Opening: Requested{ref}
//!   Opening --> Ready: Opened{ref,readOnly}
//!   Opening --> Failed: Failed{ref} / PodDied{ref}
//!   Ready --> Opening: Requested{ref}          (previous stays on screen)
//!   Ready --> Failed: PodDied{ref}             (nothing stays on screen)
//!   Failed --> Opening: Retry{ref} / Requested{ref}
//!   Opening --> Opening: PodDied{ref}          (late Opened is refused)
//! ```
//!
//! The refusals are the point: an `Opened` for a ref that already failed (its
//! pod died between the listing and the install) never becomes `Ready`, and a
//! `Ready` cannot be produced without a checkout that is alive.

import { Data } from "effect";

import type { ReadOnlyRef } from "./drafts";

/** A ref whose checkout the panes have installed: what the banner reads. */
export interface ReadyCheckout {
  readonly readOnly: ReadOnlyRef;
  readonly ref: string;
}

/** The browse's own state. */
export type RefView = Data.TaggedEnum<{
  /** Mounted, nothing opened yet: the panes hold their opening note. */
  Booting: Record<never, never>;
  /** `ref` is opening; `previous` (when there is one) is what the panes still
   * show, and the banner describes. */
  Opening: { previous: ReadyCheckout | null; ref: string };
  /** `ref` is installed: the panes drive its checkout. */
  Ready: ReadyCheckout;
  /** `ref` could not be opened (or its pod died): `previous` is what the panes
   * still show, null when nothing does. */
  Failed: {
    message: string;
    previous: ReadyCheckout | null;
    ref: string;
  };
}>;

export const RefViews = Data.taggedEnum<RefView>();

/** What the browser reports to the machine. */
export type RefEvent = Data.TaggedEnum<{
  /** A checkout is in and the panes drove it. */
  Opened: { readOnly: ReadOnlyRef; ref: string };
  /** The checkout could not be opened. */
  Failed: { message: string; ref: string };
  /** The frame behind `ref` reported its pod gone. */
  PodDied: { message: string; ref: string };
  /** The view (or the retry card) asked for a ref. `force` drops whatever the
   * warm cache held for it and opens it again. */
  Requested: { force: boolean; ref: string };
}>;

export const RefEvents = Data.taggedEnum<RefEvent>();

/** What the browser must do besides storing the new state. */
export interface RefDecision {
  /** Refs whose warm checkout must be closed now. */
  readonly drop: readonly string[];
  /** The event was refused: the state is unchanged. */
  readonly refused: boolean;
  readonly state: RefView;
  /** Nothing on screen describes a live checkout any more: wipe the panes. */
  readonly wipe: boolean;
}

/** The checkout the panes are showing, when there is one. */
export const shownCheckout = (state: RefView): ReadyCheckout | null => {
  if (state._tag === "Ready") {
    return state;
  }

  if (state._tag === "Booting") {
    return null;
  }

  return state.previous;
};

/** Why the banners describe what the panes show — `""` for an editable
 * checkout, and for a failed open that left nothing on screen. */
export const readOnlyOf = (state: RefView): ReadOnlyRef =>
  shownCheckout(state)?.readOnly ?? "";

/** The ref a switch spinner names, or `""` when no switch is in flight. */
export const switchingTo = (state: RefView): string =>
  state._tag === "Opening" ? state.ref : "";

/** The failure card's content, or null when there is nothing to report. It
 * names the ref that failed, not the one the URL names now. */
export const failureOf = (
  state: RefView
): { readonly message: string; readonly ref: string } | null =>
  state._tag === "Failed" ? { message: state.message, ref: state.ref } : null;

const unchanged = (state: RefView): RefDecision => ({
  drop: [],
  refused: true,
  state,
  wipe: false,
});

/** One transition. Every event goes through here: the browser stores the
 * returned state and performs the returned `drop`/`wipe`. */
export const stepRef = (state: RefView, event: RefEvent): RefDecision => {
  switch (event._tag) {
    case "Requested": {
      const { force, ref } = event;

      if (!force && shownCheckout(state)?.ref === ref) {
        // Already the ref the panes are on (or opening): a repaint is not a
        // second open.
        return unchanged(state);
      }

      if (!force && state._tag === "Opening" && state.ref === ref) {
        return unchanged(state);
      }

      return {
        drop: force ? [ref] : [],
        refused: false,
        state: RefViews.Opening({ previous: shownCheckout(state), ref }),
        wipe: false,
      };
    }

    case "Opened": {
      if (state._tag !== "Opening" || state.ref !== event.ref) {
        // A stale open: its ref failed (or another request superseded it)
        // while the checkout was coming up.
        return unchanged(state);
      }

      return {
        drop: [],
        refused: false,
        state: RefViews.Ready({ readOnly: event.readOnly, ref: event.ref }),
        wipe: false,
      };
    }

    case "Failed":
    case "PodDied": {
      let failure: { previous: ReadyCheckout | null; ref: string } | null =
        null;

      if (state._tag === "Opening" && state.ref === event.ref) {
        failure = { previous: state.previous, ref: state.ref };
      }

      if (state._tag === "Ready" && state.ref === event.ref) {
        failure = { previous: null, ref: state.ref };
      }

      if (failure === null) {
        return unchanged(state);
      }

      return {
        drop: [event.ref],
        refused: false,
        state: RefViews.Failed({
          message: event.message,
          previous: failure.previous,
          ref: failure.ref,
        }),
        // A failed open the panes had something to keep keeps it; a pod that
        // died on the installed checkout leaves nothing to show.
        wipe: failure.previous === null,
      };
    }

    default: {
      // The `Retry` the card offers is a forced `Requested`; there is no
      // other event.
      return unchanged(state);
    }
  }
};

/** The retry the failure card offers: open the failed ref again, dropping
 * what that attempt left in the warm cache. */
export const retryRef = (state: RefView): RefDecision =>
  state._tag === "Failed"
    ? stepRef(state, RefEvents.Requested({ force: true, ref: state.ref }))
    : unchanged(state);
