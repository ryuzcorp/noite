import { describe, expect, test } from "bun:test";

import { frameAddress, handshakeMessage } from "./handshake";

const CONTROL = "https://noite.example";
const PREVIEW = "https://app-0.preview.demo.example";
const NONCE = "3f0c2f6e";

/** The frame's URL as the control builds it, with `over` replacing fields. */
const frameUrl = (over: Record<string, string> = {}): string => {
  const query = new URLSearchParams({
    appId: "app1",
    branch: "main",
    nonce: NONCE,
    parentOrigin: CONTROL,
    ...over,
  });

  return `${PREVIEW}/noite-pod-host.html?${query}`;
};

describe("the frame's own URL", () => {
  test("names the page, the ref and the nonce", () => {
    expect(frameAddress(frameUrl(), true)).toEqual({
      appId: "app1",
      branch: "main",
      nonce: NONCE,
      parentOrigin: CONTROL,
    });
  });

  test.each(["appId", "branch", "nonce", "parentOrigin"])(
    "is refused when it names no %s",
    (missing) => {
      expect(frameAddress(frameUrl({ [missing]: "" }), true)).toBeNull();
    }
  );

  test("is refused when the parent origin is not an origin", () => {
    for (const parentOrigin of [
      "https://noite.example/",
      "https://noite.example/path",
      "https://user:pass@noite.example",
      "not a url",
      "null",
    ]) {
      expect(frameAddress(frameUrl({ parentOrigin }), true)).toBeNull();
    }
  });

  test("is refused when the frame is its own parent's origin", () => {
    // The shape a preview document on this origin would use to open a pod
    // frame of its own and answer it itself.
    expect(frameAddress(frameUrl({ parentOrigin: PREVIEW }), true)).toBeNull();
  });

  test("is refused for a document that is not framed", () => {
    expect(frameAddress(frameUrl(), false)).toBeNull();
  });

  test("is refused for a URL that does not parse", () => {
    expect(frameAddress("", true)).toBeNull();
  });
});

describe("a message on the frame's window", () => {
  test("a hello carries the nonce and the revision", () => {
    expect(handshakeMessage({ nonce: NONCE, t: "hello", v: 1 })).toEqual({
      nonce: NONCE,
      t: "hello",
      v: 1,
    });
  });

  test("a connect carries the port", () => {
    const { port1, port2 } = new MessageChannel();

    const message = handshakeMessage({
      nonce: NONCE,
      port: port2,
      t: "connect",
      v: 1,
    });

    expect(message?.t).toBe("connect");
    expect(message?.t === "connect" ? message.port : null).toBe(port2);
    port1.close();
    port2.close();
  });

  test("anything that is not a handshake is refused", () => {
    const { port1, port2 } = new MessageChannel();

    const wrong = [
      null,
      undefined,
      "hello",
      7,
      {},
      { nonce: NONCE, t: "ready", v: 1 },
      // The page never sends its own answer back.
      { t: "hello", v: 1 },
      { nonce: NONCE, t: "hello" },
      { nonce: NONCE, t: "hello", v: "1" },
      { nonce: NONCE, t: "connect", v: 1 },
      { nonce: NONCE, port: "port", t: "connect", v: 1 },
      { nonce: NONCE, port: port1, t: "postMessage", v: 1 },
    ];

    for (const value of wrong) {
      expect(handshakeMessage(value)).toBeNull();
    }

    port1.close();
    port2.close();
  });
});
