/* oxlint-disable eslint/require-await -- test doubles mirror async platform interfaces */
import { describe, expect, test } from "bun:test";

import { readBoundedText } from "./body";

describe("readBoundedText", () => {
  test("reads a body within the bound", async () => {
    const request = new Request("http://x", { body: "hello", method: "POST" });
    expect(await readBoundedText(request, 10)).toBe("hello");
  });

  test("refuses by declared length", async () => {
    const request = new Request("http://x", {
      body: "x".repeat(20),
      headers: { "content-length": "20" },
      method: "POST",
    });
    expect(await readBoundedText(request, 10)).toBeNull();
  });

  test("refuses a streamed body that lies about, or omits, its length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(8));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const request = new Request("http://x", {
      body,
      // @ts-expect-error -- Bun/undici need duplex for a stream body.
      duplex: "half",
      method: "POST",
    });
    expect(await readBoundedText(request, 10)).toBeNull();
  });
});
