import { describe, expect, test } from "bun:test";

import type { RunnerTree } from "../runner";
import {
  failureOf,
  readOnlyOf,
  RefEvents,
  RefViews,
  retryRef,
  shownCheckout,
  stepRef,
  switchingTo,
} from "./ref-view";
import type { ReadyCheckout, RefView } from "./ref-view";

const TREE: RunnerTree = { files: [], sha: "a".repeat(40), truncated: false };

const checkout = (
  ref: string,
  readOnly: ReadyCheckout["readOnly"] = ""
): ReadyCheckout => ({ readOnly, ref, tree: TREE });

const boot = (): RefView => RefViews.Booting();

const request = (state: RefView, ref: string, force = false) =>
  stepRef(state, RefEvents.Requested({ force, ref }));

const opened = (state: RefView, at: ReadyCheckout) =>
  stepRef(state, RefEvents.Opened({ checkout: at }));

const failed = (state: RefView, ref: string) =>
  stepRef(state, RefEvents.Failed({ message: "boom", ref }));

/** A machine that has opened `main`. */
const ready = (): RefView => {
  const decision = opened(request(boot(), "main").state, checkout("main"));
  expect(decision.refused).toBe(false);

  return decision.state;
};

describe("the ref machine's transition table", () => {
  test("Booting opens on the first request", () => {
    const decision = request(boot(), "main");

    expect(decision.refused).toBe(false);
    expect(decision.read).toBe("main");
    expect(decision.state).toEqual(
      RefViews.Opening({ previous: null, ref: "main" })
    );
  });

  test("an empty ref is refused", () => {
    expect(request(boot(), "").refused).toBe(true);
  });

  test("Opening lands on Ready for the ref it is opening", () => {
    const opening = request(boot(), "main").state;
    const decision = opened(opening, checkout("main"));

    expect(decision.refused).toBe(false);
    expect(shownCheckout(decision.state)).toEqual(checkout("main"));
    expect(switchingTo(decision.state)).toBe("");
  });

  test("Opening fails on its own ref, keeping what the panes show", () => {
    const loading = request(boot(), "main").state;
    const shown = opened(loading, checkout("main")).state;
    const next = request(shown, "feature").state;
    const decision = failed(next, "feature");

    expect(decision.state._tag).toBe("Failed");
    expect(failureOf(decision.state)).toEqual({
      message: "boom",
      ref: "feature",
    });
    // The previous checkout stays on screen: the panes still show `main`.
    expect(shownCheckout(decision.state)?.ref).toBe("main");
    expect(readOnlyOf(decision.state)).toBe("");
  });

  test("a second request for the target is refused", () => {
    const opening = request(boot(), "main").state;

    expect(request(opening, "main").refused).toBe(true);
    expect(request(ready(), "main").refused).toBe(true);
  });

  test("a forced request re-reads the ref the panes show", () => {
    const decision = request(ready(), "main", true);

    expect(decision.refused).toBe(false);
    expect(decision.read).toBe("main");
    expect(shownCheckout(decision.state)?.ref).toBe("main");
  });

  test("a request for another ref opens it over the shown one", () => {
    const decision = request(ready(), "feature");

    expect(decision.state._tag).toBe("Opening");
    expect(shownCheckout(decision.state)?.ref).toBe("main");
    expect(switchingTo(decision.state)).toBe("feature");
  });

  test("the shown ref can be asked for again while another opens", () => {
    const opening = request(ready(), "feature").state;

    // Going back to the ref the panes show is how the user cancels a switch:
    // it must not be refused, or the spinner would never clear.
    expect(request(opening, "main").refused).toBe(false);
  });

  test("an Opened for a superseded ref is refused", () => {
    const opening = request(ready(), "feature").state;
    const back = request(opening, "main").state;
    const stale = opened(back, checkout("feature"));

    expect(stale.refused).toBe(true);
    expect(shownCheckout(stale.state)?.ref).toBe("main");
  });

  test("a Failed for another ref is refused", () => {
    const opening = request(ready(), "feature").state;

    expect(failed(opening, "main").refused).toBe(true);
  });

  test("Retry reopens the ref that failed", () => {
    const failing = failed(request(ready(), "feature").state, "feature");
    const decision = retryRef(failing.state);

    expect(decision.refused).toBe(false);
    expect(decision.read).toBe("feature");
    expect(decision.state._tag).toBe("Opening");
  });

  test("a read-only checkout reports its reason to the banners", () => {
    const decision = opened(
      request(boot(), "v1.0.0").state,
      checkout("v1.0.0", "tag")
    );

    expect(readOnlyOf(decision.state)).toBe("tag");
  });
});
