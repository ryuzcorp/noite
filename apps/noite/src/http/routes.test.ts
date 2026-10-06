/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetRateLimits } from "../lib/rate-limit";
import {
  controlStreamRefusalDecision,
  handleHttp,
  metricsWindowHours,
  readBoundedText,
  sleepUnlessAborted,
  streamMetrics,
} from "./routes";

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
  const decoder = new TextDecoder();
  const done = streamMetrics({
    auth: { authorization: "Bearer t" },
    base: "http://runner.test/v1/apps/a",
    controller: {
      close: () => {},
      enqueue: (chunk: Uint8Array) => {
        chunks.push(decoder.decode(chunk));
      },
      // SAFETY: streamMetrics only calls enqueue and close.
    } as unknown as ReadableStreamDefaultController,
    pollMs: 20,
    signal: controller.signal,
    windowQuery: "hours=24",
  });
  await Bun.sleep(200);
  controller.abort();
  await done;
  return { chunks, versionCalls };
};

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
  /** An AbortSignal that counts its listeners. */

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
    // One frame for the first poll, heartbeats for every unchanged cycle.
    expect(chunks[0]?.startsWith("data: ")).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk === ": ping\n\n")).toBe(true);
  });

  test("a moved version polls again", async () => {
    const { versionCalls } = await runMetricsStream((n) => n);
    expect(versionCalls).toBeGreaterThanOrEqual(3);
  });
});
