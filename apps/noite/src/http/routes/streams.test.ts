/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
import { afterEach, describe, expect, test } from "bun:test";

import { controlStreamRefusalDecision } from "../session";
import { sleepUnlessAborted } from "../sse";
import { metricsWindowHours, proxyRunnerFetch, streamMetrics } from "./streams";

const realFetch = globalThis.fetch;

const setFetch = (
  impl: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the tests only need the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = impl as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

const metricsRequest = (query: string) =>
  new Request(`http://localhost/api/apps/a/metrics/stream${query}`);

const countingSignal = () => {
  const controller = new AbortController();
  let live = 0;
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<typeof add>) => {
    live += 1;
    add(...args);
  };

  signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    live -= 1;
    remove(...args);
  };

  return { controller, live: () => live };
};

const runMetricsStream = async (versionFor: (call: number) => number) => {
  const chunks: string[] = [];
  let versionCalls = 0;
  setFetch(async (url) => {
    if (url.includes("/metrics/version")) {
      versionCalls += 1;

      return Response.json({ version: versionFor(versionCalls) });
    }

    return Response.json([]);
  });
  const controller = new AbortController();

  const done = streamMetrics({
    auth: { authorization: "Bearer t" },
    base: "http://runner.test/v1/apps/a",
    envQuery: "",
    pollMs: 20,
    signal: controller.signal,
    sink: {
      send: (message: { data: string }) => {
        chunks.push(`data: ${message.data}\n\n`);

        return Promise.resolve();
      },
    },
    windowQuery: "hours=24",
  });

  await Bun.sleep(200);
  controller.abort();
  await done;

  return { chunks, versionCalls };
};

describe("control stream gate", () => {
  test("admits only a signed-in, non-impersonated instance admin", () => {
    expect(
      controlStreamRefusalDecision({
        impersonatedBy: null,
        isAdmin: true,
        signedIn: true,
      })
    ).toBeNull();
    expect(
      controlStreamRefusalDecision({
        impersonatedBy: null,
        isAdmin: true,
        signedIn: false,
      })
    ).toMatchObject({ status: 401 });
    // An admin touring as another user must not watch the control plane.
    expect(
      controlStreamRefusalDecision({
        impersonatedBy: "admin1",
        isAdmin: true,
        signedIn: true,
      })
    ).toMatchObject({ status: 403 });
    expect(
      controlStreamRefusalDecision({
        impersonatedBy: null,
        isAdmin: false,
        signedIn: true,
      })
    ).toMatchObject({ status: 403 });
  });
});

describe("metricsWindowHours", () => {
  test("accepts the offered windows and defaults everything else to 24h", () => {
    expect(metricsWindowHours(metricsRequest("?hours=24"))).toBe(24);
    expect(metricsWindowHours(metricsRequest("?hours=168"))).toBe(168);
    expect(metricsWindowHours(metricsRequest("?hours=720"))).toBe(720);
    expect(metricsWindowHours(metricsRequest(""))).toBe(24);
    expect(metricsWindowHours(metricsRequest("?hours=9999"))).toBe(24);
    expect(metricsWindowHours(metricsRequest("?hours=abc"))).toBe(24);
  });
});

describe("sleepUnlessAborted", () => {
  test("leaves no abort listener behind, however many cycles sleep", async () => {
    const { controller, live } = countingSignal();

    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential sleeps, like the stream loop
      await sleepUnlessAborted(1, controller.signal);
    }

    expect(live()).toBe(0);
  });

  test("wakes early on abort and cleans up", async () => {
    const { controller, live } = countingSignal();
    const started = Date.now();
    const sleeping = sleepUnlessAborted(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(live()).toBe(0);
  });

  test("returns at once for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepUnlessAborted(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("streamMetrics", () => {
  test("an unchanged runner version still sleeps between cycles (no busy loop)", async () => {
    const { chunks, versionCalls } = await runMetricsStream(() => 7);
    // ~200 ms at 20 ms per cycle is about ten cycles; a loop without a pause
    // would make thousands of calls in the same time.
    expect(versionCalls).toBeGreaterThanOrEqual(3);
    expect(versionCalls).toBeLessThan(40);
    // The first poll sends its frame; unchanged cycles send nothing (the
    // keep-alive comments come from `eventStream`, not the loop).
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((chunk) => chunk.startsWith("data: "))).toBe(true);
  });

  test("a moved version polls again", async () => {
    const { versionCalls } = await runMetricsStream((n) => n);
    expect(versionCalls).toBeGreaterThanOrEqual(3);
  });
});

describe("proxyRunnerFetch", () => {
  test("a dead runner becomes a short 502, keeping the abort signal", async () => {
    const seen: (AbortSignal | null)[] = [];
    setFetch(async (_url, init) => {
      seen.push(init?.signal ?? null);
      throw new Error("connection refused");
    });
    const controller = new AbortController();

    const response = await proxyRunnerFetch(
      "http://runner.test/v1/apps/a/logs/stream",
      "tok",
      controller.signal
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("runner unavailable");
    expect(seen[0]).toBe(controller.signal);
  });

  test("an upstream error passes through with its status", async () => {
    setFetch(async () => new Response("no such app", { status: 404 }));
    const controller = new AbortController();

    const response = await proxyRunnerFetch(
      "http://runner.test/v1/apps/a/logs/stream",
      "tok",
      controller.signal
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("no such app");
  });

  test("a live upstream is re-wrapped as an event stream", async () => {
    const body = "data: [1]\n\n";
    setFetch(
      async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        })
    );
    const controller = new AbortController();

    const response = await proxyRunnerFetch(
      "http://runner.test/v1/apps/a/logs/stream",
      "tok",
      controller.signal
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe(body);
  });
});
