import { expect, test } from "bun:test";

import {
  newPaneMachine,
  ownedPainted,
  paintedOf,
  PaneEvents,
  panePath,
  PaneViews,
  stepPane,
} from "./pane-view";

const show = (path: string, text: string) => ({
  committedOnly: false,
  editable: true,
  path,
  placeholder: null,
  text,
});

/** Paint `path` the way `openFile` does. */
const opened = (path: string, text: string) => {
  const started = stepPane(newPaneMachine(), PaneEvents.Requested({ path }));
  const token = started.read?.token ?? -1;

  const resolved = stepPane(
    started.machine,
    PaneEvents.Resolved({ show: show(path, text), token })
  );

  return { machine: resolved.machine, token };
};

test("a painted file owns the pane and the deep link", () => {
  const { machine } = opened("a.ts", "one");

  expect(machine.view._tag).toBe("Painted");
  expect(panePath(machine.view)).toBe("a.ts");
  expect(paintedOf(machine.view)?.text).toBe("one");
});

test("a stale read never paints over a newer open", () => {
  const first = stepPane(
    newPaneMachine(),
    PaneEvents.Requested({ path: "a.ts" })
  );

  const second = stepPane(
    first.machine,
    PaneEvents.Requested({ path: "b.ts" })
  );

  const late = stepPane(
    second.machine,
    PaneEvents.Resolved({
      show: show("a.ts", "old"),
      token: first.read?.token ?? -1,
    })
  );

  expect(late.refused).toBe(true);
  expect(late.machine).toEqual(second.machine);
});

test("a sync does not cancel the open it would then abandon", () => {
  // The pod reports a change while `a.ts` is still opening: the open owns the
  // surface, so the sync is refused instead of bumping the token and leaving
  // `?file=` naming a file nothing ever paints.
  const opening = stepPane(
    newPaneMachine(),
    PaneEvents.Requested({ path: "a.ts" })
  );

  const sync = stepPane(
    opening.machine,
    PaneEvents.SyncStarted({ path: "a.ts", writing: false })
  );

  expect(sync.refused).toBe(false);
  expect(sync.read).toBeNull();
  expect(sync.machine).toEqual(opening.machine);

  // The original open still lands.
  const landed = stepPane(
    opening.machine,
    PaneEvents.Resolved({
      show: show("a.ts", "text"),
      token: opening.read?.token ?? -1,
    })
  );

  expect(landed.machine.view._tag).toBe("Painted");
});

test("a keystroke spends the token of the read in flight", () => {
  // A sync read is out when the user keeps typing: the bytes it answers with
  // are older than the editor, so it must not settle the surface (painting
  // them undoes the keystroke, and pierre drops the typing after the repaint).
  const painted = opened("a.ts", "one");

  const syncing = stepPane(
    painted.machine,
    PaneEvents.SyncStarted({ path: "a.ts", writing: false })
  );

  const token = syncing.read?.token ?? -1;

  expect(syncing.machine.view._tag).toBe("Opening");

  const typed = stepPane(
    syncing.machine,
    PaneEvents.TextChanged({ path: "a.ts", text: "one, typed" })
  );

  expect(typed.refused).toBe(false);
  expect(typed.machine.view._tag).toBe("Painted");
  expect(paintedOf(typed.machine.view)?.text).toBe("one, typed");
  // The surface moved on: the read still to land is spent.
  expect(typed.machine.seq).not.toBe(token);

  const late = stepPane(
    typed.machine,
    PaneEvents.Resolved({ show: show("a.ts", "one"), token })
  );

  expect(late.refused).toBe(true);
  expect(late.machine).toEqual(typed.machine);
  expect(paintedOf(late.machine.view)?.text).toBe("one, typed");
});

test("a keystroke re-keys the paint it types over", () => {
  const { machine } = opened("a.ts", "one");

  const typed = stepPane(
    machine,
    PaneEvents.TextChanged({ path: "a.ts", text: "two" })
  );

  expect(typed.machine.view._tag).toBe("Painted");
  expect(panePath(typed.machine.view)).toBe("a.ts");
  // The write's own derive compares against the typed text, not the paint's.
  expect(ownedPainted(typed.machine.view)?.text).toBe("two");

  // A keystroke for another file is not this surface's.
  const other = stepPane(
    typed.machine,
    PaneEvents.TextChanged({ path: "b.ts", text: "three" })
  );

  expect(other.refused).toBe(true);
  expect(other.machine).toEqual(typed.machine);
});

test("a sync during the pane's own write reads nothing", () => {
  const { machine } = opened("a.ts", "one");

  const sync = stepPane(
    machine,
    PaneEvents.SyncStarted({ path: "a.ts", writing: true })
  );

  expect(sync.read).toBeNull();
  expect(sync.recheck).toBe(true);
  // No new token: the write's own derive will be the one to repaint.
  expect(sync.machine.seq).toBe(machine.seq);
});

test("a stale surface is not reopened as already painted", () => {
  const { machine } = opened("a.ts", "one");
  const rebased = stepPane(machine, PaneEvents.Rebased()).machine;
  const reopening = stepPane(rebased, PaneEvents.Requested({ path: "a.ts" }));

  // `from` would let the open dedupe against the old checkout's text and skip
  // the paint (and its edit session).
  expect(reopening.machine.view._tag).toBe("Opening");
  expect(ownedPainted(reopening.machine.view)).toBeNull();
});

test("a rebase keeps the text but gives up the path", () => {
  const { machine } = opened("a.ts", "one");
  const rebased = stepPane(machine, PaneEvents.Rebased());

  expect(rebased.machine.view._tag).toBe("Stale");
  expect(paintedOf(rebased.machine.view)?.text).toBe("one");
  // A stale surface is not "already painted": the same path must repaint (and
  // re-attach the edit session) when the new checkout opens it.
  expect(ownedPainted(rebased.machine.view)).toBeNull();
  // `?file=` may not name a file the new checkout has not painted.
  expect(panePath(rebased.machine.view)).toBeNull();
});

test("a move re-keys the open path and its text", () => {
  const { machine } = opened("src/a.ts", "one");
  const moved = stepPane(machine, PaneEvents.Moved({ from: "src", to: "lib" }));

  expect(panePath(moved.machine.view)).toBe("lib/a.ts");
  expect(paintedOf(moved.machine.view)?.text).toBe("one");
});

test("a read that found nothing puts the surface back", () => {
  const { machine } = opened("a.ts", "one");

  const reopening = stepPane(
    machine,
    PaneEvents.Requested({ path: "gone.ts" })
  );

  const abandoned = stepPane(reopening.machine, PaneEvents.Abandoned());

  const painted = paintedOf(machine.view);

  if (painted === null) {
    throw new Error("the pane painted nothing to restore");
  }

  expect(abandoned.machine.view).toEqual(PaneViews.Painted(painted));
});

test("dropping closes the surface", () => {
  const { machine } = opened("a.ts", "one");
  const dropped = stepPane(machine, PaneEvents.Dropped());

  expect(dropped.close).toBe(true);
  expect(panePath(dropped.machine.view)).toBeNull();
});
