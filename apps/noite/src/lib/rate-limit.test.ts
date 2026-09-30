import { beforeEach, describe, expect, test } from "bun:test";

import {
  clientKey,
  limitedClass,
  rateLimitDecision,
  resetRateLimits,
  withTrustedClientAddress,
} from "./rate-limit";

const req = (headers: Record<string, string>) =>
  new Request("http://localhost/api/auth/get-session", { headers });

beforeEach(() => {
  resetRateLimits();
});

describe("rateLimitDecision", () => {
  test("allows up to the limit, then refuses with a retry-after", () => {
    const now = 1_000_000;
    expect(rateLimitDecision("k", 2, now).allowed).toBe(true);
    expect(rateLimitDecision("k", 2, now).allowed).toBe(true);
    const third = rateLimitDecision("k", 2, now);
    expect(third.allowed).toBe(false);
    expect(third.retryAfter).toBeGreaterThanOrEqual(1);
  });

  test("starts a fresh window once the old one expires", () => {
    const now = 1_000_000;
    rateLimitDecision("k", 1, now);
    expect(rateLimitDecision("k", 1, now).allowed).toBe(false);
    expect(rateLimitDecision("k", 1, now + 61_000).allowed).toBe(true);
  });

  test("keys are independent", () => {
    rateLimitDecision("a", 1, 0);
    expect(rateLimitDecision("b", 1, 0).allowed).toBe(true);
  });

  test("a non-positive limit disables the limiter", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(rateLimitDecision("k", 0, 0).allowed).toBe(true);
    }
  });
});

describe("clientKey", () => {
  test("uses the address the trusted proxy appended, not the client's claim", () => {
    // Caddy appends the peer it saw: the left entries are the client's.
    expect(clientKey(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe(
      "203.0.113.9"
    );
  });

  test("rotating the spoofed prefix does not change the bucket", () => {
    const a = clientKey(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }));
    const b = clientKey(req({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }));
    expect(a).toBe(b);
  });

  test("falls back to cf-connecting-ip, then a shared bucket", () => {
    expect(clientKey(req({ "cf-connecting-ip": "198.51.100.4" }))).toBe(
      "198.51.100.4"
    );
    expect(clientKey(req({}))).toBe("unknown");
  });
});

describe("withTrustedClientAddress", () => {
  test("collapses X-Forwarded-For to the trusted address for better-auth", () => {
    const out = withTrustedClientAddress(
      req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" })
    );
    expect(out.headers.get("x-forwarded-for")).toBe("203.0.113.9");
  });

  test("keeps the method, URL and body", async () => {
    const original = new Request("http://localhost/api/auth/sign-in", {
      body: "payload",
      headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
      method: "POST",
    });
    const out = withTrustedClientAddress(original);
    expect(out.method).toBe("POST");
    expect(out.url).toBe("http://localhost/api/auth/sign-in");
    expect(await out.text()).toBe("payload");
  });
});

describe("limitedClass", () => {
  test("covers the public routes only", () => {
    expect(limitedClass("/api/invite/status")).toBe("invite");
    expect(limitedClass("/api/auth/sign-in/passkey")).toBe("auth");
    expect(limitedClass("/api/apps/stream")).toBeNull();
  });
});
