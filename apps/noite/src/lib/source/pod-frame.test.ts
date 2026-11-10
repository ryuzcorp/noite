import { describe, expect, test } from "bun:test";

import { readPodBound, readPodReady } from "./pod-client";
import { Frame, frameFailureMessage, frameTransition } from "./pod-frame";
import type { FrameState } from "./pod-frame";
import type { PodReady } from "./pod-protocol";

const READY: PodReady = {
  isolated: true,
  nonce: "n",
  sharedArrayBuffer: true,
  t: "ready",
  v: 1,
};

const mounted = (): FrameState => frameTransition(Frame.Idle(), { t: "mount" });

const answered = (): FrameState =>
  frameTransition(mounted(), { ready: READY, t: "ready" });

describe("frameTransition", () => {
  test("a frame is only connected by its own bound ack", () => {
    // The bug this machine removes: the page assumed the port it posted was
    // being served. `bound` before `ready` is not a connected frame.
    const unproven = frameTransition(mounted(), { t: "bound" });

    expect(unproven).toEqual(mounted());
    expect(Frame.$is("Connected")(unproven)).toBe(false);
  });

  test("ready, then bound is the connected path", () => {
    expect(frameTransition(answered(), { t: "bound" })).toEqual(
      Frame.Connected()
    );
  });

  test("a late ready after the deadline is dropped, not revived", () => {
    const failed = frameTransition(mounted(), { t: "deadline" });

    expect(frameTransition(failed, { ready: READY, t: "ready" })).toEqual(
      failed
    );
    expect(frameTransition(failed, { t: "bound" })).toEqual(failed);
  });

  test("each load of an unanswered frame counts as an attempt", () => {
    const first = frameTransition(mounted(), { t: "load" });

    expect(first).toEqual(Frame.Loading({ attempts: 2 }));
    expect(frameTransition(first, { t: "load" })).toEqual(
      Frame.Loading({ attempts: 3 })
    );
  });

  test("an answered but non-isolated frame fails closed", () => {
    expect(frameTransition(answered(), { t: "not-isolated" })).toEqual(
      Frame.Failed({ reason: "isolation" })
    );
  });

  test("an answered frame that never acks fails with unbound", () => {
    expect(frameTransition(answered(), { t: "unbound" })).toEqual(
      Frame.Failed({ reason: "unbound" })
    );
  });

  test("a connected frame ignores every later event", () => {
    const connected = frameTransition(answered(), { t: "bound" });

    for (const event of [
      { t: "deadline" },
      { t: "load" },
      { t: "not-isolated" },
      { t: "mount" },
      { ready: READY, t: "ready" },
      { t: "unbound" },
    ] as const) {
      expect(frameTransition(connected, event)).toEqual(connected);
    }
  });

  test("every failure says a different, actionable thing", () => {
    const messages = new Set(
      (["isolation", "timeout", "unbound"] as const).map((reason) =>
        frameFailureMessage(reason, "https://pod.example")
      )
    );

    expect(messages.size).toBe(3);
  });
});

describe("the handshake messages", () => {
  const bound = { nonce: "n", t: "bound" as const, v: 1 };

  test("a bound ack is not a ready", () => {
    // The bug e2e caught: the ready parser accepted any object with a nonce,
    // a string `t` and a numeric `v`, so the ack was read as a second `ready`
    // and the page never learned its port had landed.
    expect(readPodReady(bound)).toBeNull();
    expect(readPodBound(bound)).toEqual(bound);
  });

  test("a ready is not a bound ack", () => {
    expect(readPodBound(READY)).toBeNull();
    expect(readPodReady(READY)).toEqual(READY);
  });

  test("neither parser takes a message missing its fields", () => {
    expect(readPodReady({ t: "ready" })).toBeNull();
    expect(readPodBound({ t: "bound" })).toBeNull();
  });
});
