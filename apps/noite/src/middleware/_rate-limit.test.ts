/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { beforeEach, describe, expect, test } from "bun:test";

import { resetRateLimits } from "../lib/rate-limit";
import { testRouteContext } from "../testing/context";
import rateLimit from "./04-rate-limit";

beforeEach(() => {
  resetRateLimits();
});

const limited = (host: string, env: KitEnv = {}) =>
  rateLimit(
    testRouteContext(
      new Request("http://localhost/api/invite/status", {
        headers: { "x-forwarded-for": `${host}, 203.0.113.9` },
      }),
      // SAFETY: the middleware takes the full Worker env; the test env carries the rate-limit key it reads.
      env as unknown as never
    ),
    () => Promise.resolve()
  );

describe("rate-limit middleware", () => {
  test("rotating the client-supplied X-Forwarded-For prefix does not dodge it", async () => {
    const env = { NOITE_RATE_LIMIT_RPM: "2" };
    const statuses: (number | undefined)[] = [];

    for (const spoofed of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential: the limiter counts in order
      const res = await limited(spoofed, env);
      statuses.push(res?.status);
    }

    // The first two pass through (undefined = downstream ran); the rest 429.
    expect(statuses.slice(0, 2)).toEqual([undefined, undefined]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });

  test("a 429 carries the retry headers", async () => {
    const env = { NOITE_RATE_LIMIT_RPM: "1" };
    await limited("9.9.9.9", env);
    const refused = await limited("9.9.9.9", env);
    expect(refused?.status).toBe(429);
    expect(await refused?.text()).toBe("Too many requests");
    expect(refused?.headers.get("retry-after")).toBeTypeOf("string");
    expect(refused?.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  test("leaves unlimited paths alone", async () => {
    let nextCalls = 0;

    const result = await rateLimit(
      testRouteContext(
        new Request("http://localhost/health"),
        // SAFETY: the unlimited-path case reads no env at all; the empty object only satisfies the context shape.
        {} as unknown as never
      ),
      () => {
        nextCalls += 1;

        return Promise.resolve();
      }
    );

    expect(nextCalls).toBe(1);
    expect(result).toBeUndefined();
  });
});
