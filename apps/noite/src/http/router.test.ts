/* oxlint-disable eslint/require-await, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetRateLimits } from "../lib/rate-limit";
import { handleHttp } from "./router";

const ENV = { RUNNER_TOKEN: "runner-secret", RUNNER_URL: "http://runner.test" };

const realFetch = globalThis.fetch;
const setFetch = (
  impl: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the tests only need the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = impl as unknown as typeof fetch;
};

beforeEach(() => {
  resetRateLimits();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (request: Request, env: Record<string, string> = ENV) =>
  // SAFETY: the handler reads only string env keys.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- minimal KitEnv for the route under test.
  Promise.resolve(handleHttp(request, env as unknown as never));

describe("/health", () => {
  test("reports the build id and needs no auth", async () => {
    const res = await call(new Request("http://localhost/health"));
    const body = (await res?.json()) as { build: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.build).toBeTypeOf("string");
    expect(body.build.length).toBeGreaterThan(0);
  });
});

describe("/webhook", () => {
  test("refuses callers without the runner token", async () => {
    let forwarded = false;
    setFetch(async () => {
      forwarded = true;
      return new Response("ok");
    });
    const anonymous = await call(
      new Request("http://localhost/webhook", { body: "{}", method: "POST" })
    );
    expect(anonymous?.status).toBe(401);
    const wrong = await call(
      new Request("http://localhost/webhook", {
        body: "{}",
        headers: { authorization: "Bearer nope", cookie: "session=abc" },
        method: "POST",
      })
    );
    expect(wrong?.status).toBe(401);
    expect(forwarded).toBe(false);
  });

  test("forwards only the body and content type — never cookies", async () => {
    let seen: { headers: Headers; url: string } | undefined;
    setFetch(async (url, init) => {
      seen = { headers: new Headers(init?.headers), url };
      return new Response("nudged");
    });
    const res = await call(
      new Request("http://localhost/webhook", {
        body: '{"ref":"main"}',
        headers: {
          authorization: "Bearer runner-secret",
          "content-type": "application/json",
          cookie: "session=abc",
          "x-forwarded-for": "6.6.6.6",
        },
        method: "POST",
      })
    );
    expect(res?.status).toBe(200);
    expect(seen?.url).toBe("http://runner.test/webhook");
    expect(seen?.headers.get("authorization")).toBe("Bearer runner-secret");
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("x-forwarded-for")).toBeNull();
  });

  test("refuses an oversized body", async () => {
    setFetch(async () => new Response("ok"));
    const res = await call(
      new Request("http://localhost/webhook", {
        body: "x".repeat(300 * 1024),
        headers: { authorization: "Bearer runner-secret" },
        method: "POST",
      })
    );
    expect(res?.status).toBe(413);
  });
});

describe("platform rate limit", () => {
  test("rotating the client-supplied X-Forwarded-For prefix does not dodge it", async () => {
    const env = { ...ENV, NOITE_RATE_LIMIT_RPM: "2" };
    const statuses: (number | undefined)[] = [];
    for (const spoofed of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
      // The first requests pass the limiter and reach a handler that needs
      // a database this test does not have; only the limiter's verdict matters.
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: the limiter counts in order
      const res = await call(
        new Request("http://localhost/api/invite/status", {
          headers: { "x-forwarded-for": `${spoofed}, 203.0.113.9` },
        }),
        env
      ).catch(() => null);
      statuses.push(res?.status);
    }
    expect(statuses.slice(2)).toEqual([429, 429]);
  });
});
