import { expect, test } from "bun:test";

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
