import { describe, expect, test } from "bun:test";

import { actionDesiredState, nextAction, runtimeOf } from "./runtime";

describe("runtimeOf", () => {
  test("a running app offers only Stop", () => {
    const runtime = runtimeOf({ desiredState: "running", status: "running" });

    expect(runtime._tag).toBe("Running");
    expect(nextAction(runtime)).toBe("stop");
  });

  test("an asleep app is running (scale to zero), not transitional", () => {
    expect(
      runtimeOf({ desiredState: "running", status: "sleeping" })._tag
    ).toBe("Running");
  });

  test("an app the runner omitted desiredState for offers no action", () => {
    // The old label `desiredState === "running" ? "Stop" : "Start"` showed a
    // Start button for an app that was already running, and the click was a
    // no-op that reported success.
    const runtime = runtimeOf({ desiredState: "", status: "running" });

    expect(runtime._tag).toBe("Unknown");
    expect(nextAction(runtime)).toBeNull();
  });

  test("a settled stopped app offers Start", () => {
    const runtime = runtimeOf({ desiredState: "stopped", status: "stopped" });

    expect(nextAction(runtime)).toBe("start");
    expect(actionDesiredState("start")).toBe("running");
  });

  test("a transitional row still offers the action that changes desiredState", () => {
    // While it settles towards stopped the button reads Start (and vice
    // versa), so a moving row never turns into a dead "—".
    expect(
      runtimeOf({ desiredState: "running", status: "deploying" })._tag
    ).toBe("Transitioning");
    expect(
      nextAction(runtimeOf({ desiredState: "running", status: "deploying" }))
    ).toBe("stop");
    expect(
      nextAction(runtimeOf({ desiredState: "stopped", status: "running" }))
    ).toBe("start");
  });

  test("a failed or not-yet-deployed app is settled-unknown, not transitional", () => {
    // Polling a `failed` row forever would be pointless and the row offers no
    // action until a deploy fixes it.
    expect(runtimeOf({ desiredState: "running", status: "failed" })._tag).toBe(
      "Unknown"
    );
    expect(
      runtimeOf({ desiredState: "running", status: "provisioned" })._tag
    ).toBe("Unknown");
  });

  test("an import in progress offers no Start/Stop, like the app header", () => {
    // The old table called `importing` transitional and offered Stop; the
    // header shows the import (and a retry, never a toggle).
    expect(
      runtimeOf({ desiredState: "running", status: "importing" })._tag
    ).toBe("Unknown");
    expect(runtimeOf({ desiredState: "running", status: "error" })._tag).toBe(
      "Unknown"
    );
    expect(
      nextAction(runtimeOf({ desiredState: "running", status: "error" }))
    ).toBeNull();
  });

  test("a crash-held fleet is running: Stop is the action that settles it", () => {
    const runtime = runtimeOf({
      desiredState: "running",
      fleetHold: { hold: "crash", retryAt: "2026-11-10T16:40:05.000Z" },
      status: "running",
    });

    expect(runtime._tag).toBe("Running");
    expect(nextAction(runtime)).toBe("stop");
  });
});
