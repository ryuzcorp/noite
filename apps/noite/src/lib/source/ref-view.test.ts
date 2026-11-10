import { expect, test } from "bun:test";

import {
  failureOf,
  OPEN_DEADLINE_MS,
  readOnlyOf,
  RefEvents,
  RefViews,
  retryRef,
  shownCheckout,
  stepRef,
  switchingTo,
} from "./ref-view";

const ready = () => RefViews.Ready({ readOnly: "", ref: "main" });

const opening = (ref: string) =>
  stepRef(RefViews.Booting(), RefEvents.Requested({ force: false, ref }));

test("a first open becomes Ready only through this ref's Opened", () => {
  const { state } = opening("main");

  expect(switchingTo(state)).toBe("main");
  expect(readOnlyOf(state)).toBe("");

  const opened = stepRef(
    state,
    RefEvents.Opened({ readOnly: "", ref: "main" })
  );

  expect(opened.refused).toBe(false);
  expect(opened.state._tag).toBe("Ready");
  expect(opened.wipe).toBe(false);
});

test("a pod that died during the open can never become Ready", () => {
  // The listing resolved, then the frame reported the pod gone: the failure
  // card is up, and the install that resolves afterwards must be refused.
  const died = stepRef(
    opening("main").state,
    RefEvents.PodDied({ message: "pod stopped", ref: "main" })
  );

  expect(died.state._tag).toBe("Failed");
  expect(died.drop).toEqual(["main"]);
  // Nothing was on screen, so the panes are wiped and the failure card says
  // why: no banner may claim a read-only checkout that is not there.
  expect(died.wipe).toBe(true);
  expect(readOnlyOf(died.state)).toBe("");

  const late = stepRef(
    died.state,
    RefEvents.Opened({ readOnly: "tag", ref: "main" })
  );

  expect(late.refused).toBe(true);
  expect(late.state._tag).toBe("Failed");
});

test("a failed switch keeps the checkout on screen, and its readOnly", () => {
  const readyState = ready();

  const switching = stepRef(
    readyState,
    RefEvents.Requested({ force: false, ref: "release" })
  ).state;

  expect(shownCheckout(switching)?.ref).toBe("main");

  const failed = stepRef(
    switching,
    RefEvents.Failed({ message: "404", ref: "release" })
  );

  expect(failed.refused).toBe(false);
  expect(failed.wipe).toBe(false);
  expect(shownCheckout(failed.state)?.ref).toBe("main");
  // The banner describes the checkout the panes really show.
  expect(readOnlyOf(failed.state)).toBe("");
  // And the card names the ref that failed, not the browsed one.
  expect(failureOf(failed.state)).toEqual({
    message: "404",
    ref: "release",
  });
});

test("a pod that dies on the installed checkout leaves nothing claimed", () => {
  const died = stepRef(
    RefViews.Ready({ readOnly: "role", ref: "staging" }),
    RefEvents.PodDied({ message: "gone", ref: "staging" })
  );

  expect(died.wipe).toBe(true);
  expect(readOnlyOf(died.state)).toBe("");
  expect(shownCheckout(died.state)).toBeNull();
});

test("a request for the ref the panes are on is not a second open", () => {
  const same = stepRef(
    ready(),
    RefEvents.Requested({ force: false, ref: "main" })
  );

  expect(same.refused).toBe(true);
});

test("the retry drops what the failed attempt left and opens it again", () => {
  const failed = stepRef(
    opening("main").state,
    RefEvents.Failed({ message: "boom", ref: "main" })
  ).state;

  const retried = retryRef(failed);

  expect(retried.state._tag).toBe("Opening");
  expect(retried.drop).toEqual(["main"]);
  // Retrying a ref that is not the failed one is not a retry.
  expect(retryRef(ready()).refused).toBe(true);
});

test("switching back to the ref the panes still show is not refused", () => {
  // The bug: while `release` opens, the panes still show `main`, and the user
  // clicks back to it. Refusing that request left the machine `Opening`
  // `release` with no request running for it — a spinner that never cleared.
  const switching = stepRef(
    ready(),
    RefEvents.Requested({ force: false, ref: "release" })
  ).state;

  const back = stepRef(
    switching,
    RefEvents.Requested({ force: false, ref: "main" })
  );

  expect(back.refused).toBe(false);
  expect(back.state._tag).toBe("Opening");
  expect(switchingTo(back.state)).toBe("main");
  // What is on screen is still what the banner describes.
  expect(shownCheckout(back.state)?.ref).toBe("main");
});

test("a request for the ref that is opening is not a second open", () => {
  const same = stepRef(
    opening("main").state,
    RefEvents.Requested({ force: false, ref: "main" })
  );

  expect(same.refused).toBe(true);
  expect(switchingTo(same.state)).toBe("main");
});

test("the ref a failed switch left on screen opens again", () => {
  // Going back to it after a failed switch is a new open, not a repaint of the
  // failure: otherwise the card outlives the failure it describes.
  const failed = stepRef(
    stepRef(ready(), RefEvents.Requested({ force: false, ref: "release" }))
      .state,
    RefEvents.Failed({ message: "404", ref: "release" })
  ).state;

  const again = stepRef(
    failed,
    RefEvents.Requested({ force: false, ref: "main" })
  );

  expect(again.refused).toBe(false);
  expect(again.state._tag).toBe("Opening");
  expect(failureOf(again.state)).toBeNull();
});

test("an answer the frame never gives ends in the card the retry reopens", () => {
  const switching = opening("main").state;

  const lost = stepRef(switching, RefEvents.TimedOut({ ref: "main" }));

  expect(lost.refused).toBe(false);
  expect(switchingTo(lost.state)).toBe("");
  expect(failureOf(lost.state)).toEqual({
    message: `the checkout did not answer within ${OPEN_DEADLINE_MS / 1000}s`,
    ref: "main",
  });
  // A first open had nothing on screen: the panes go with it.
  expect(lost.wipe).toBe(true);
  expect(lost.drop).toEqual(["main"]);

  // The retry opens it again, and a late answer to the abandoned open cannot
  // turn that attempt into a `Ready`.
  const retried = retryRef(lost.state);

  expect(switchingTo(retried.state)).toBe("main");

  const late = stepRef(
    retried.state,
    RefEvents.Opened({ readOnly: "", ref: "other" })
  );

  expect(late.refused).toBe(true);
});

test("a timeout for a ref the machine is not opening is refused", () => {
  const superseded = stepRef(
    stepRef(ready(), RefEvents.Requested({ force: false, ref: "release" }))
      .state,
    RefEvents.Requested({ force: false, ref: "topic" })
  ).state;

  const late = stepRef(superseded, RefEvents.TimedOut({ ref: "release" }));

  expect(late.refused).toBe(true);
  expect(switchingTo(late.state)).toBe("topic");
});
