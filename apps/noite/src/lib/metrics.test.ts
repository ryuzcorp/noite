import { afterEach, describe, expect, test } from "bun:test";

import { metricsWindowHours } from "../http/routes/streams";
import { METRICS_WINDOWS_HOURS, pollMetricsFrame } from "./metrics";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const metricsRequest = (query: string) =>
  new Request(`http://localhost/api/apps/a/metrics/stream${query}`);

const stubRunner = (requests: number): void => {
  // SAFETY: the poll only needs the (url, init) call shape.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for the global fetch.
  globalThis.fetch = ((url: string) =>
    Promise.resolve(
      url.includes("/metrics?")
        ? Response.json([{ path: "/", requests }])
        : Response.json([])
    )) as unknown as typeof fetch;
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
      { path: "/", requests: 3 },
    ]);
  });

  test("answers null when the request total hasn't moved", async () => {
    stubRunner(3);

    expect(await pollMetricsFrame(poll, 3)).toBeNull();
  });
});
