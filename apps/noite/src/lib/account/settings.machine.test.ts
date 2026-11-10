import { describe, expect, test } from "bun:test";

import {
  Evt,
  Settings,
  stateFromStatus,
  syncStatus,
  transition,
} from "./settings.machine";
import type { SettingStatus } from "./settings.machine";

const status = (over: Partial<SettingStatus> = {}): SettingStatus => ({
  checkedAt: null,
  enabled: true,
  latest: null,
  lockReason: null,
  locked: false,
  setting: true,
  ...over,
});

describe("stateFromStatus", () => {
  test("a locked setting keeps the stored preference visible", () => {
    // It used to render `enabled = locked ? false : …`, so an operator could
    // not tell "stored on, ignored" from "stored off".
    expect(
      stateFromStatus(
        status({
          enabled: false,
          lockReason: "NOITE_X=0",
          locked: true,
          setting: true,
        })
      )
    ).toEqual(Settings.Locked({ reason: "NOITE_X=0", stored: true }));
  });

  test("a ready setting starts from the stored value", () => {
    const state = stateFromStatus(status({ setting: false }));

    expect(state._tag).toBe("Ready");
    expect(state._tag === "Ready" && state.draft).toBe(false);
  });
});

const ready = (over: Partial<SettingStatus> = {}) =>
  stateFromStatus(status(over));

describe("transition", () => {
  test("toggling edits the draft and clears a previous confirmation", () => {
    const saved = transition(
      transition(ready(), Evt.SaveStarted()),
      Evt.SaveSucceeded({
        checking: false,
        status: status(),
        value: true,
      })
    );

    const next = transition(saved, Evt.Toggled({ value: false }));

    expect(next._tag).toBe("Ready");
    expect(next._tag === "Ready" && next.save).toBe("idle");
    expect(next._tag === "Ready" && next.draft).toBe(false);
  });

  test("a toggle is ignored while the save is in flight", () => {
    const saving = transition(ready(), Evt.SaveStarted());

    expect(transition(saving, Evt.Toggled({ value: false }))).toBe(saving);
  });

  test("a failed save shows the error and keeps the draft", () => {
    const failed = transition(
      transition(ready({ setting: false }), Evt.SaveStarted()),
      Evt.SaveFailed({ message: "boom" })
    );

    expect(failed._tag).toBe("Ready");
    expect(failed._tag === "Ready" && failed.error).toBe("boom");
    expect(failed._tag === "Ready" && failed.draft).toBe(false);
  });

  test("a refetch that reports the same stored value keeps the confirmation", () => {
    const saved = transition(
      transition(ready(), Evt.SaveStarted()),
      Evt.SaveSucceeded({
        checking: false,
        status: status(),
        value: true,
      })
    );

    const reloaded = transition(saved, Evt.Loaded({ status: status() }));

    expect(reloaded._tag === "Ready" && reloaded.save).toBe("saved");
  });

  test("a refetch that reports a different stored value retires it (another tab changed it)", () => {
    const saved = transition(
      transition(ready(), Evt.SaveStarted()),
      Evt.SaveSucceeded({
        checking: false,
        status: status(),
        value: true,
      })
    );

    const reloaded = transition(
      saved,
      Evt.Loaded({ status: status({ setting: false }) })
    );

    expect(reloaded._tag === "Ready" && reloaded.save).toBe("idle");
    expect(reloaded._tag === "Ready" && reloaded.stored).toBe(false);
  });

  test("a background check ends when a load reports a newer check mark", () => {
    const running = transition(
      transition(ready(), Evt.SaveStarted()),
      Evt.SaveSucceeded({
        checking: true,
        status: status({ checkedAt: "2026-11-01T00:00:00.000Z" }),
        value: true,
      })
    );

    expect(running._tag === "Ready" && running.check).toBe("running");

    const settled = transition(
      running,
      Evt.Loaded({
        status: status({ checkedAt: "2026-11-10T00:00:00.000Z" }),
      })
    );

    expect(settled._tag === "Ready" && settled.check).toBe("idle");
  });

  test("syncStatus turns a cold failure into Failed, not an endless skeleton", () => {
    const failed = syncStatus(Settings.Loading(), undefined, new Error("nope"));

    expect(failed._tag).toBe("Failed");
  });

  test("syncStatus leaves the machine alone while the refetch has blanked the resource", () => {
    const readyState = ready();

    // SAFETY: both blanks are what a refetch in flight passes.
    expect(syncStatus(readyState, undefined, null)).toBe(readyState);
  });
});
