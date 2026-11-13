import { afterEach, describe, expect, test } from "bun:test";

import { metricsWindowHours } from "../http/routes/streams";
import { METRICS_WINDOWS_HOURS, pollMetricsFrame } from "./metrics";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const metricsRequest = (query: string) =>
  new Request(`http://localhost/api/apps/a/metrics/stream${query}`);

const HOUR_ROW = {
  appId: "a",
  bucketTs: "2026-11-13T07:00:00Z",
  cpuMs: 4,
  errors: 1,
  memoryAvgBytes: 1024,
  memoryMaxBytes: 4096,
  p50Ms: 5,
  p95Ms: 40,
  requests: 0,
};

const stubRunner = (requests: number): void => {
  // SAFETY: the poll only needs the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = ((url: string) => {
    if (!url.includes("/metrics?")) {
      return Promise.reject(new Error(`unexpected runner call: ${url}`));
    }

    return Promise.resolve(Response.json([{ ...HOUR_ROW, requests }]));
  }) as unknown as typeof fetch;
};

describe("METRICS_WINDOWS_HOURS", () => {
  test("is the single source the stream and the frame action serve", () => {
    expect([...METRICS_WINDOWS_HOURS]).toEqual([24, 168, 720]);

    for (const hours of METRICS_WINDOWS_HOURS) {
      expect(metricsWindowHours(metricsRequest(`?hours=${hours}`))).toBe(hours);
    }

    expect(metricsWindowHours(metricsRequest("?hours=1"))).toBe(24);
    expect(metricsWindowHours(metricsRequest("?hours=1000"))).toBe(24);
  });
});

describe("pollMetricsFrame", () => {
  const poll = {
    auth: { authorization: "Bearer t" },
    base: "http://runner.test/v1/apps/a",
    envQuery: "",
    windowQuery: "hours=24",
  };

  test("assembles one frame and reports its request total", async () => {
    stubRunner(3);

    const polled = await pollMetricsFrame(poll, -1);

    expect(polled?.total).toBe(3);
    expect(JSON.parse(polled?.frame ?? "{}").metrics).toEqual([
      { ...HOUR_ROW, requests: 3 },
    ]);
  });

  test("answers null when the request total hasn't moved", async () => {
    stubRunner(3);

    expect(await pollMetricsFrame(poll, 3)).toBeNull();
  });
});
