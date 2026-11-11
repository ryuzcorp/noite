import { describe, expect, test } from "bun:test";

import {
  newPaneMachine,
  paintedOf,
  PaneEvents,
  panePath,
  stepPane,
} from "./pane-view";
import type { PaneMachine, PanePainted } from "./pane-view";

const PAINT: PanePainted = {
  editable: true,
  path: "src/app.ts",
  placeholder: null,
  text: "let a = 1;",
};

const opened = (): PaneMachine => {
  const requested = stepPane(
    newPaneMachine(),
    PaneEvents.Requested({ path: "src/app.ts" })
  );

  if (requested.read === null) {
    throw new Error("no ticket");
  }

  return stepPane(
    requested.machine,
    PaneEvents.Resolved({ painted: PAINT, ticket: requested.read })
  ).machine;
};

describe("the pane machine's transition table", () => {
  test("Closed reads nothing until a file is asked for", () => {
    const machine = newPaneMachine();

    expect(panePath(machine.view)).toBeNull();
    expect(paintedOf(machine.view)).toBeNull();
  });

  test("Requested hands back the ticket the read resolves against", () => {
    const decision = stepPane(
      newPaneMachine(),
      PaneEvents.Requested({ path: "a.ts" })
    );

    expect(decision.read).toEqual({ path: "a.ts", token: 1 });
    expect(panePath(decision.machine.view)).toBe("a.ts");
    expect(paintedOf(decision.machine.view)).toBeNull();
  });

  test("Resolved paints the file it was asked for", () => {
    const machine = opened();

    expect(paintedOf(machine.view)).toEqual(PAINT);
  });

  test("a stale Resolved never paints over the newer read", () => {
    const first = stepPane(
      newPaneMachine(),
      PaneEvents.Requested({ path: "a.ts" })
    );

    const second = stepPane(
      first.machine,
      PaneEvents.Requested({ path: "b.ts" })
    );

    if (first.read === null) {
      throw new Error("no ticket");
    }

    const stale = stepPane(
      second.machine,
      PaneEvents.Resolved({ painted: PAINT, ticket: first.read })
    );

    expect(stale.refused).toBe(true);
    expect(paintedOf(stale.machine.view)).toBeNull();
    expect(panePath(stale.machine.view)).toBe("b.ts");
  });

  test("a Failed lands its message for the file that failed", () => {
    const requested = stepPane(
      newPaneMachine(),
      PaneEvents.Requested({ path: "a.ts" })
    );

    if (requested.read === null) {
      throw new Error("no ticket");
    }

    const decision = stepPane(
      requested.machine,
      PaneEvents.Failed({ message: "gone", ticket: requested.read })
    );

    expect(decision.machine.view).toEqual({
      _tag: "Failed",
      message: "gone",
      path: "a.ts",
    });
    expect(panePath(decision.machine.view)).toBe("a.ts");
  });

  test("Closed drops the paint and refuses a second close", () => {
    const closed = stepPane(opened(), PaneEvents.Closed());

    expect(paintedOf(closed.machine.view)).toBeNull();
    expect(stepPane(closed.machine, PaneEvents.Closed()).refused).toBe(true);
  });
});
