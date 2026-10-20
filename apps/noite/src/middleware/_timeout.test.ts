/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { describe, expect, test } from "bun:test";

import {
  appStateUrl,
  applistUrl,
  deploysUrl,
  errorsUrl,
  eventsUrl,
  logsUrl,
  metricsUrl,
  streamHubUrl,
} from "../lib/feeds";
import { testRouteContext } from "../testing/context";
import defaultTimeoutMiddleware, {
  TIMEOUT_MS,
  timeoutExempt,
  timeoutMiddleware as withTimeout,
} from "./01-timeout";

const ENV = {};

const contextFor = (path: string) =>
  testRouteContext(
    new Request(`http://localhost${path}`),
    // SAFETY: the middleware reads no env; the empty object only satisfies the context shape.
    ENV as unknown as never
  );

describe("timeoutExempt", () => {
  test("spares streams, R2 objects, and the source archive", () => {
    expect(timeoutExempt("/api/apps/a/logs/stream")).toBe(true);
    expect(timeoutExempt("/api/apps/stream")).toBe(true);
    expect(timeoutExempt("/storage/a/r2/b/raw?key=k")).toBe(true);
    expect(timeoutExempt("/storage/a/r2/b/upload?key=k")).toBe(true);
    expect(timeoutExempt("/api/apps/a/source/archive")).toBe(true);
    expect(timeoutExempt("/api/apps/a/source/commit")).toBe(false);
    expect(timeoutExempt("/api/auth/session")).toBe(false);
    expect(timeoutExempt("/health")).toBe(false);
    expect(timeoutExempt("/mcp")).toBe(false);
  });

  test("spares every live-feed stream (a 15 s bound would cut them)", () => {
    // Every URL builder in lib/feeds.ts: bounding one would cut a healthy
    // long-lived stream with a 504.
    const streams = [
      applistUrl(),
      deploysUrl("app_1"),
      deploysUrl("app_1", "env_1"),
      errorsUrl("app_1", "open"),
      logsUrl("app_1"),
      logsUrl("app_1", "env_1"),
      metricsUrl("app_1", 24),
      appStateUrl("app_1"),
      eventsUrl("app_1", "deploys", 50),
      streamHubUrl([logsUrl("app_1"), deploysUrl("app_1")]),
    ];

    expect(streams.length).toBeGreaterThan(0);

    for (const url of streams) {
      expect(timeoutExempt(new URL(url, "http://localhost").pathname)).toBe(
        true
      );
    }
  });
});

describe("timeout middleware", () => {
  test("lets a fast route through", async () => {
    let nextCalls = 0;

    const result = await withTimeout(20)(contextFor("/health"), () => {
      nextCalls += 1;

      return Promise.resolve();
    });

    expect(nextCalls).toBe(1);
    expect(result).toBeUndefined();
  });

  test("answers a stuck route with a JSON 504", async () => {
    // Genuine delay, not a guessed wait: the middleware's own timer is the
    // behavior under test, and the race always settles on it.
    const result = await withTimeout(20)(
      contextFor("/api/invite/status"),
      // oxlint-disable-next-line promise/avoid-new -- a never-settling next() is the stuck route under test
      () => new Promise<void>(() => {})
    );

    expect(result?.status).toBe(504);
    expect(await result?.json()).toEqual({ error: "Request timed out" });
  });

  test("never races an exempt path", async () => {
    let nextCalls = 0;

    const result = await withTimeout(20)(
      contextFor("/api/apps/a/logs/stream"),
      () => {
        nextCalls += 1;

        return Promise.resolve();
      }
    );

    expect(nextCalls).toBe(1);
    expect(result).toBeUndefined();
  });

  test("the default export gates with the 15 s bound", async () => {
    expect(TIMEOUT_MS).toBe(15_000);
    let nextCalls = 0;

    const result = await defaultTimeoutMiddleware(contextFor("/health"), () => {
      nextCalls += 1;

      return Promise.resolve();
    });

    expect(nextCalls).toBe(1);
    expect(result).toBeUndefined();
  });
});
