import { describe, expect, test } from "bun:test";

import {
  Tour,
  TourEvt,
  tourIndex,
  tourOpen,
  tourTransition,
} from "./onboarding.machine";

describe("tourTransition", () => {
  test("the session opens the tour at the first step", () => {
    const state = tourTransition(
      Tour.Hidden(),
      TourEvt.Session({ show: true })
    );

    expect(state).toEqual(Tour.Showing({ error: null, index: 0 }));
    expect(tourOpen(state)).toBe(true);
  });

  test("a failed save keeps the dialog up with the error and the same step", () => {
    // The bug: finish() set `closed` before the POST and ignored the failure,
    // so the modal vanished while the server still said "not onboarded" and
    // came back on every reload with no error shown.
    const saving = tourTransition(
      Tour.Showing({ error: null, index: 2 }),
      TourEvt.Dismiss()
    );

    expect(saving).toEqual(Tour.Saving({ index: 2 }));
    expect(tourOpen(saving)).toBe(true);

    const failed = tourTransition(
      saving,
      TourEvt.SaveFailed({ message: "offline" })
    );

    expect(failed).toEqual(Tour.Showing({ error: "offline", index: 2 }));
    expect(tourIndex(failed)).toBe(2);
  });

  test("a saved tour is Done and a stale session can never reopen it", () => {
    const done = tourTransition(Tour.Saving({ index: 1 }), TourEvt.Saved());

    expect(done._tag).toBe("Done");
    expect(tourOpen(done)).toBe(false);
    expect(tourTransition(done, TourEvt.Session({ show: true }))._tag).toBe(
      "Done"
    );
  });

  test("steps clamp at both ends", () => {
    const last = tourTransition(
      Tour.Showing({ error: null, index: 2 }),
      TourEvt.Next()
    );

    expect(tourIndex(last)).toBe(2);
    expect(
      tourIndex(
        tourTransition(Tour.Showing({ error: null, index: 0 }), TourEvt.Back())
      )
    ).toBe(0);
  });

  test("Skip-anyway closes locally without marking", () => {
    const closed = tourTransition(
      Tour.Showing({ error: "offline", index: 1 }),
      TourEvt.CloseAnyway()
    );

    expect(closed._tag).toBe("Done");
    expect(tourOpen(closed)).toBe(false);
  });
});
