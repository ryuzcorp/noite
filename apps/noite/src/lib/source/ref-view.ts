//! The source browser's ref lifecycle: which commit the panes are showing,
//! which one is opening, and why a browse failed. One value, so the banner, the
//! switch spinner, the failure card and the panes cannot disagree; the request
//! generation stays private to the browser, and a stale answer is refused by
//! the ref it names.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Booting
//!   Booting --> Opening: Requested{ref}
//!   Opening --> Ready: Opened{ref, tree}
//!   Opening --> Failed: Failed{ref}
//!   Opening --> Opening: Requested{other ref}
//!   Ready --> Opening: Requested{ref}      (the shown checkout stays on screen)
//!   Failed --> Opening: Requested{ref}     (Retry, or another ref)
//! ```
//!
//! A `Requested` is refused only when it names the state's own target — the ref
//! that is opening, or the one that is ready. It is never refused for naming
//! the ref the panes still *show* while another one opens: that request is how
//! the user goes back, and refusing it would leave the machine spinning on a
//! ref no request is running for any more. `Opened` and `Failed` are refused
//! for a ref the machine is not opening, which is what keeps an answer to a
//! superseded request from painting over the checkout that replaced it.

import { Data } from "effect";

import type { RunnerTree } from "../runner";
import type { ReadOnlyRef } from "./drafts";

/** A ref whose files the panes have installed: what the banners read. */
export interface ReadyCheckout {
  /** Why the checkout cannot be edited (see `ReadOnlyRef`). */
  readOnly: ReadOnlyRef;
  /** The ref as the caller asked for it (a branch, a tag or a sha). */
  ref: string;
  /** The commit it resolved to, and the files it holds. */
  tree: RunnerTree;
}

/** The browse's own state. */
export type RefView = Data.TaggedEnum<{
  Booting: Record<never, never>;
  /** A ref's files are being read; `previous` is what the panes still hold. */
  Opening: { previous: ReadyCheckout | null; ref: string };
  Ready: { checkout: ReadyCheckout };
  Failed: { message: string; previous: ReadyCheckout | null; ref: string };
}>;

export const RefViews = Data.taggedEnum<RefView>();

/** What the browser reports to the machine. */
export type RefEvent = Data.TaggedEnum<{
  Opened: { checkout: ReadyCheckout };
  Failed: { message: string; ref: string };
  /** `force` re-reads the ref the panes already show (a commit moved its tip);
   * a plain request for it is refused. */
  Requested: { force: boolean; ref: string };
}>;

export const RefEvents = Data.taggedEnum<RefEvent>();

/** What the browser must do besides storing the new state: the ref to read,
 * when the event asks for one. */
export interface RefDecision {
  /** The ref whose files to read now, or "" when the event asked for none (a
   * duplicate request, or an answer). */
  read: string;
  refused: boolean;
  state: RefView;
}

/** The checkout the panes are showing, when there is one. */
export const shownCheckout = (state: RefView): ReadyCheckout | null => {
  if (state._tag === "Ready") {
    return state.checkout;
  }

  return state._tag === "Opening" || state._tag === "Failed"
    ? state.previous
    : null;
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

/** The ref an open would target: what a duplicate request is refused for. */
const target = (state: RefView): string => {
  if (state._tag === "Opening") {
    return state.ref;
  }

  if (state._tag === "Ready") {
    return state.checkout.ref;
  }

  return "";
};

const unchanged = (state: RefView): RefDecision => ({
  read: "",
  refused: true,
  state,
});

/** One transition. Every event goes through here: the browser stores the
 * returned state and starts the returned read. */
export const stepRef = (state: RefView, event: RefEvent): RefDecision => {
  if (event._tag === "Requested") {
    if (event.ref === "" || (!event.force && event.ref === target(state))) {
      return unchanged(state);
    }

    return {
      read: event.ref,
      refused: false,
      state: RefViews.Opening({
        previous: shownCheckout(state),
        ref: event.ref,
      }),
    };
  }

  if (event._tag === "Opened") {
    const { checkout } = event;

    if (state._tag !== "Opening" || state.ref !== checkout.ref) {
      return unchanged(state);
    }

    return { read: "", refused: false, state: RefViews.Ready({ checkout }) };
  }

  if (state._tag !== "Opening" || state.ref !== event.ref) {
    return unchanged(state);
  }

  return {
    read: "",
    refused: false,
    state: RefViews.Failed({
      message: event.message,
      previous: state.previous,
      ref: event.ref,
    }),
  };
};

/** The retry the failure card offers: open the failed ref again. */
export const retryRef = (state: RefView): RefDecision =>
  state._tag === "Failed"
    ? stepRef(state, RefEvents.Requested({ force: true, ref: state.ref }))
    : unchanged(state);
