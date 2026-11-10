import { describe, expect, test } from "bun:test";

import { actionDesiredState, nextAction, runtimeOf } from "./runtime";

describe("runtimeOf", () => {
  test("a running app offers only Stop", () => {
    const runtime = runtimeOf("running", "running");

    expect(runtime._tag).toBe("Running");
    expect(nextAction(runtime)).toBe("stop");
  });

  test("an asleep app is running (scale to zero), not transitional", () => {
    expect(runtimeOf("sleeping", "running")._tag).toBe("Running");
  });

  test("an app the runner omitted desiredState for offers no action", () => {
    // The old label `desiredState === "running" ? "Stop" : "Start"` showed a
    // Start button for an app that was already running, and the click was a
    // no-op that reported success.
    const runtime = runtimeOf("running", "");

    expect(runtime._tag).toBe("Unknown");
    expect(nextAction(runtime)).toBeNull();
  });

  test("a settled stopped app offers Start", () => {
    const runtime = runtimeOf("stopped", "stopped");

    expect(nextAction(runtime)).toBe("start");
    expect(actionDesiredState("start")).toBe("running");
  });

  test("a transitional app offers nothing", () => {
    expect(runtimeOf("deploying", "running")._tag).toBe("Transitioning");
    expect(nextAction(runtimeOf("deploying", "running"))).toBeNull();
    expect(nextAction(runtimeOf("running", "stopped"))).toBeNull();
  });

  test("a failed or not-yet-deployed app is settled-unknown, not transitional", () => {
    // Polling a `failed` row forever would be pointless and the row offers no
    // action until a deploy fixes it.
    expect(runtimeOf("failed", "running")._tag).toBe("Unknown");
    expect(runtimeOf("provisioned", "running")._tag).toBe("Unknown");
  });
});
