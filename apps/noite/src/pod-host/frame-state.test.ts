import { describe, expect, test } from "bun:test";

import { Frame, boundMessage, frameTransition } from "./frame-state";
import type { FrameState } from "./frame-state";
import type { PodAddress } from "./handshake";

const ADDRESS: PodAddress = {
  appId: "app-1",
  branch: "main",
  nonce: "nonce-1",
  parentOrigin: "https://app.example",
};

const listening = (): FrameState =>
  frameTransition(Frame.Inert({ reason: "unframed" }), {
    address: ADDRESS,
    t: "serve",
  });

describe("frameTransition (pod frame)", () => {
  test("a document nobody opened serves nothing", () => {
    const inert = frameTransition(Frame.Inert({ reason: "unframed" }), {
      t: "bind",
    });

    expect(inert).toEqual(Frame.Inert({ reason: "unframed" }));
  });

  test("hello is answered only while listening", () => {
    const bound = frameTransition(listening(), { t: "bind" });

    expect(frameTransition(bound, { t: "hello" })).toEqual(bound);
    expect(frameTransition(listening(), { t: "hello" })).toEqual(listening());
  });

  test("the port is bound once", () => {
    const bound = frameTransition(listening(), { t: "bind" });

    expect(bound).toEqual(Frame.Bound({ nonce: ADDRESS.nonce }));
    expect(frameTransition(bound, { t: "bind" })).toEqual(bound);
  });

  test("a bind that throws is a readable state, not a silent dead frame", () => {
    const broken = frameTransition(listening(), {
      error: "boom",
      t: "bind-failed",
    });

    expect(broken).toEqual(Frame.Broken({ reason: "boom" }));
    expect(frameTransition(broken, { t: "bind" })).toEqual(broken);
  });

  test("the ack names the same nonce and protocol revision", () => {
    expect(boundMessage("nonce-1")).toEqual({
      nonce: "nonce-1",
      t: "bound",
      v: 1,
    });
  });
});
