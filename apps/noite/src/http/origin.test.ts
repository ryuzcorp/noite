/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { describe, expect, test } from "bun:test";

import { isSameOriginAction } from "./origin";

// SAFETY: the gate reads only BETTER_AUTH_URL from the env; the remaining KitEnv keys stay undefined as the gate tolerates.
const ENV = { BETTER_AUTH_URL: "http://localhost:9080" } as unknown as KitEnv;

const request = (url: string, headers: Record<string, string> = {}): Request =>
  new Request(url, { headers, method: "POST" });

describe("isSameOriginAction", () => {
  test("the request's own origin passes", () => {
    expect(
      isSameOriginAction(
        request("http://localhost:9080/api/x", {
          origin: "http://localhost:9080",
        }),
        ENV
      )
    ).toBe(true);
  });

  test("the BETTER_AUTH_URL origin passes", () => {
    expect(
      isSameOriginAction(
        request("http://proxy.internal/api/x", {
          origin: "http://localhost:9080",
        }),
        ENV
      )
    ).toBe(true);
  });

  test("a sibling origin is refused", () => {
    expect(
      isSameOriginAction(
        request("http://localhost:9080/api/x", {
          origin: "http://evil.localhost:9080",
          "sec-fetch-site": "same-site",
        }),
        ENV
      )
    ).toBe(false);
  });

  test("Origin: null is refused", () => {
    expect(
      isSameOriginAction(
        request("http://localhost:9080/api/x", { origin: "null" }),
        ENV
      )
    ).toBe(false);
  });

  test("no Origin with a cross-site hint is refused", () => {
    expect(
      isSameOriginAction(
        request("http://localhost:9080/api/x", {
          "sec-fetch-site": "cross-site",
        }),
        ENV
      )
    ).toBe(false);
  });

  test("no Origin with a same-origin hint passes", () => {
    expect(
      isSameOriginAction(
        request("http://localhost:9080/api/x", {
          "sec-fetch-site": "same-origin",
        }),
        ENV
      )
    ).toBe(true);
  });

  test("no Origin and no hint passes (non-browser client)", () => {
    expect(
      isSameOriginAction(request("http://localhost:9080/api/x"), ENV)
    ).toBe(true);
  });
});
