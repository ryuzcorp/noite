import { afterEach, describe, expect, test } from "bun:test";
/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
import { setImmediate } from "node:timers/promises";

import { controlStreamRefusalDecision } from "../session";
import { sleepUnlessAborted } from "../sse";
import { metricsWindowHours, proxyRunnerFetch, streamMetrics } from "./streams";

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const setFetch = (
  impl: (url: string, init?: RequestInit) => Promise<Response>
) => {
  // SAFETY: the tests only need the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = impl as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

/** Manual timer queue for the stream loop: pauses are fired by hand, so no
 * test waits out a real poll interval. A loop with no pause (the busy-loop
 * regression) leaves the queue empty and fails at the pump. */
const installManualTimers = () => {
  const queue: { delay: number; handler: () => void; id: number }[] = [];
  const delays: number[] = [];
  let nextId = 1;
  // SAFETY: test-only clock; every scheduled pause is fired by hand below.
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    const id = nextId;
    nextId += 1;
    delays.push(delay ?? 0);
    queue.push({ delay: delay ?? 0, handler, id });

    return id;
  }) as typeof setTimeout;
  // SAFETY: test-only clock; an aborted pause leaves the queue.
  globalThis.clearTimeout = ((id?: number) => {
    const at = queue.findIndex((entry) => entry.id === id);

    if (at !== -1) {
      queue.splice(at, 1);
    }
  }) as typeof clearTimeout;

  const fire = (): void => {
    const next = queue.shift();

    if (next === undefined) {
      throw new Error("the stream scheduled no pause between cycles");
    }

    next.handler();
  };

  return { delays, fire, queue };
};

/** Drain the loop's fetch/send chain after firing a pause: settling two
 * immediates means a settled cycle, with no wall-clock involved. */
const settleCycle = async (): Promise<void> => {
  await setImmediate();
  await setImmediate();
};

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
  const timers = installManualTimers();

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

  // Five cycles, each closed by firing its own scheduled pause: exactly one
  // poll per cycle, exactly one pause per cycle.
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential pump-and-settle; parallel pumps would race the queue
    await settleCycle();
    expect(versionCalls).toBe(cycle);
    expect(timers.queue).toHaveLength(1);

    if (cycle < 5) {
      timers.fire();
    }
  }

  controller.abort();
  await done;

  return { chunks, timers, versionCalls };
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
    const { chunks, timers, versionCalls } = await runMetricsStream(() => 7);
    // Five pumped cycles, one version read each: the loop keeps polling.
    expect(versionCalls).toBe(5);
    // Every cycle scheduled exactly one 20 ms pause, and the abort cleaned
    // up the last one: a loop without a pause would fail at the pump, and
    // would make thousands of calls in the time a real wait would take.
    expect(timers.delays).toEqual([20, 20, 20, 20, 20]);
    expect(timers.queue).toHaveLength(0);
    // The first poll sends its frame; unchanged cycles send nothing (the
    // keep-alive comments come from `eventStream`, not the loop).
    expect(chunks.length).toBe(1);
    expect(chunks.every((chunk) => chunk.startsWith("data: "))).toBe(true);
  });

  test("a moved version polls again", async () => {
    const { chunks, timers, versionCalls } = await runMetricsStream((n) => n);
    expect(versionCalls).toBe(5);
    expect(timers.delays).toEqual([20, 20, 20, 20, 20]);
    expect(timers.queue).toHaveLength(0);
    expect(chunks.length).toBe(1);
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
