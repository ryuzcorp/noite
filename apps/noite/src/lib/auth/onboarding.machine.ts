//! The first-run tour as one value. It used to be `open` × `closed` × `step` ×
//! `spot`, with `finish()` setting `closed` **before** its POST and ignoring
//! the result: the modal vanished for the mount while the server still said
//! "not onboarded", so the tour came back on every reload with no error shown.
//!
//! | state              | the dialog shows                    | next |
//! | ------------------ | ----------------------------------- | ---- |
//! | `Hidden`           | nothing (server says onboarded)     | `Showing` |
//! | `Showing{index}`   | step `index`, optional save error   | `Saving`, `Hidden`, `Done` |
//! | `Saving{index}`    | step `index`, controls disabled     | `Done`, `Showing` |
//! | `Done`             | nothing (marked this mount)         | `Hidden` (a later session says onboarded) |
import { Data } from "effect";

export type TourState = Data.TaggedEnum<{
  /** Marked done: never reopen this mount, whatever the stale snapshot says. */
  Done: Record<never, never>;
  Hidden: Record<never, never>;
  Saving: { readonly index: number };
  Showing: { readonly error: string | null; readonly index: number };
}>;

export const Tour = Data.taggedEnum<TourState>();

export type TourEvent = Data.TaggedEnum<{
  /** Re-read the session: open the tour when it says "not onboarded". */
  Session: { readonly show: boolean };
  Next: Record<never, never>;
  Back: Record<never, never>;
  /** The user picked Finish/Skip: the write starts, the dialog stays up. */
  Dismiss: Record<never, never>;
  Saved: Record<never, never>;
  SaveFailed: { readonly message: string };
  /** Close without marking (the failure path's "Skip"). */
  CloseAnyway: Record<never, never>;
}>;

export const TourEvt = Data.taggedEnum<TourEvent>();

export const TOUR_STEPS = 3;

/** Reopening keeps the step the user reached. */
const openAt = (state: TourState): TourState =>
  state._tag === "Showing" || state._tag === "Saving"
    ? Tour.Showing({ error: null, index: state.index })
    : Tour.Showing({ error: null, index: 0 });

const clamp = (index: number): number =>
  Math.min(Math.max(index, 0), TOUR_STEPS - 1);

/** The one transition. */
export const tourTransition = (
  state: TourState,
  event: TourEvent
): TourState => {
  switch (event._tag) {
    case "Session": {
      if (state._tag === "Done") {
        return state;
      }

      return event.show ? openAt(state) : Tour.Hidden();
    }

    case "Next": {
      return state._tag === "Showing"
        ? Tour.Showing({ error: null, index: clamp(state.index + 1) })
        : state;
    }

    case "Back": {
      return state._tag === "Showing"
        ? Tour.Showing({ error: null, index: clamp(state.index - 1) })
        : state;
    }

    case "Dismiss": {
      return state._tag === "Showing"
        ? Tour.Saving({ index: state.index })
        : state;
    }

    case "Saved": {
      return Tour.Done();
    }

    case "SaveFailed": {
      return state._tag === "Saving"
        ? Tour.Showing({ error: event.message, index: state.index })
        : state;
    }

    default: {
      return Tour.Done();
    }
  }
};

/** The dialog is interactive unless the write is in flight. */
export const tourOpen = (state: TourState): boolean =>
  state._tag === "Showing" || state._tag === "Saving";

export const tourIndex = (state: TourState): number =>
  state._tag === "Showing" || state._tag === "Saving" ? state.index : 0;
