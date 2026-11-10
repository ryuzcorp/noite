// Stream bridges: the one-shot close and the writable latch.
import { describe, expect, test } from "bun:test";

import { closeWrite, StreamBridge } from "./src/bridge.ts";
import { Deferred } from "./test-helpers.ts";

describe("StreamBridge", () => {
  test("close runs the finish exactly once, whatever reason wins", async () => {
    let finishes = 0;

    const bridge = new StreamBridge(() => {
      finishes += 1;

      return Promise.resolve();
    });

    expect(bridge.state).toEqual({ _tag: "Open" });
    await bridge.close("done");
    expect(finishes).toBe(1);
    expect(bridge.state).toEqual({ _tag: "Closed", reason: "done" });
    await bridge.close("cancel");
    expect(finishes).toBe(1);
    expect(bridge.state).toEqual({ _tag: "Closed", reason: "done" });
  });

  test("concurrent closes join the first", async () => {
    let finishes = 0;
    const gate = new Deferred<void>();

    const bridge = new StreamBridge(async () => {
      finishes += 1;
      await gate.promise;
    });

    const first = bridge.close("error");
    const second = bridge.close("cancel");

    expect(bridge.state).toEqual({ _tag: "Closing" });
    gate.resolve();
    await Promise.all([first, second]);
    expect(finishes).toBe(1);
    expect(bridge.state).toEqual({ _tag: "Closed", reason: "error" });
  });

  test("a throwing finish still settles the state", async () => {
    const bridge = new StreamBridge(() => Promise.reject(new Error("boom")));

    await expect(bridge.close("error")).rejects.toThrow("boom");
    expect(bridge.state).toEqual({ _tag: "Closed", reason: "error" });
  });
});

describe("closeWrite", () => {
  test("Open closes once and stays closed", () => {
    const closed = closeWrite({ _tag: "Open" });

    expect(closed).toEqual({ _tag: "Closed" });
    expect(closeWrite(closed)).toEqual({ _tag: "Closed" });
  });
});
