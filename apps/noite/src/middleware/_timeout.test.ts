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
  routeTimeout,
  TIMEOUT_MS,
  timeoutMiddleware as withTimeout,
} from "./01-timeout";

const ENV = {};

const contextFor = (path: string) =>
  testRouteContext(
    new Request(`http://localhost${path}`),
    // SAFETY: the middleware reads no env; the empty object only satisfies the context shape.
    ENV as unknown as never
  );

const exempt = (path: string): boolean => routeTimeout(path).kind === "exempt";

describe("routeTimeout", () => {
  test("spares streams and R2 objects", () => {
    expect(exempt("/api/apps/a/logs/stream")).toBe(true);
    expect(exempt("/api/apps/stream")).toBe(true);
    expect(exempt("/api/streams")).toBe(true);
    expect(exempt("/storage/a/r2/b/raw?key=k")).toBe(true);
    expect(exempt("/storage/a/r2/b/upload?key=k")).toBe(true);
    expect(exempt("/api/apps/a/source/commit")).toBe(false);
    expect(exempt("/api/auth/session")).toBe(false);
    expect(exempt("/health")).toBe(false);
    expect(exempt("/mcp")).toBe(false);
  });

  test("a bounded route carries the bound; an exempt one states why", () => {
    expect(routeTimeout("/api/auth/session")).toEqual({
      kind: "bounded",
      ms: TIMEOUT_MS,
    });
    expect(routeTimeout("/api/apps/a/logs/stream")).toEqual({
      kind: "exempt",
      why: "stream",
    });
    expect(routeTimeout("/storage/a/r2/b/raw?key=k")).toEqual({
      kind: "exempt",
      why: "download",
    });
    expect(routeTimeout("/assets/pages-client-CA3vIREc.js")).toEqual({
      kind: "exempt",
      why: "static",
    });
  });

  test("spares the fingerprinted client bundle, bounded pages included", () => {
    // The e2e flake wave: a chunk that outlived the bound was answered with
    // this middleware's JSON 504, so the module never executed and the page
    // never hydrated. A static file must never carry the action bound — not
    // even the miss fall-through or a direct-to-worker request (celld serves
    // the bundle itself; see `RUN_WORKER_FIRST` in void.config.ts).
    for (const path of [
      "/assets/pages-client-CA3vIREc.js",
      "/assets/layout-CirV7yER.css",
      "/assets/geist-latin-wght-normal-BgDaEnEv.woff2",
    ]) {
      expect(routeTimeout(path)).toEqual({ kind: "exempt", why: "static" });
    }

    // A page, an action and the pod document keep the bound.
    expect(routeTimeout("/apps/new")).toEqual({
      kind: "bounded",
      ms: TIMEOUT_MS,
    });
    expect(routeTimeout("/api/apps/create")).toEqual({
      kind: "bounded",
      ms: TIMEOUT_MS,
    });
  });

  test("a JSON action merely containing /stream is still bounded", () => {
    // The old substring rule spared this path, so a hung action here could
    // outlive the platform deadline.
    expect(exempt("/api/x/streamSomething")).toBe(false);
    expect(exempt("/api/apps/streaming-info")).toBe(false);
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
      expect(exempt(new URL(url, "http://localhost").pathname)).toBe(true);
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

  test("a static file never arms the bound, so it can never be 504'd", async () => {
    // The real failure: `next()` (for `/assets/*` that is Void's pages
    // fallback reading `env.ASSETS`) outlived the bound, and the middleware
    // replaced the module with a 504 the browser cannot execute. An exempt
    // path never arms the timer at all, so there is nothing to fire however
    // long the read takes — and a page still arms it.
    const realSetTimeout = globalThis.setTimeout;
    let armed = 0;

    // SAFETY: the middleware reads `setTimeout` from the global scope; this
    // stub only counts the calls it makes and delegates to the real one.
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      armed += 1;

      return realSetTimeout(...args);
    }) as typeof setTimeout;

    try {
      await withTimeout(20)(
        contextFor("/assets/pages-client-CA3vIREc.js"),
        () => Promise.resolve()
      );
      expect(armed).toBe(0);

      await withTimeout(20)(contextFor("/apps/new"), () => Promise.resolve());
      expect(armed).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
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
