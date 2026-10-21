/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a stub env, clock and runner fetch stand in for the platform */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { controlEnv } from "../lib/control-env";
import { envelopeLimiter } from "../lib/rate-limit";
import { testRouteContext } from "../testing/context";
import envelopeSlash from "./05-envelope-slash";

const ENV = {
  RUNNER_TOKEN: "runner-secret",
  RUNNER_URL: "http://runner.test",
};

const realFetch = globalThis.fetch;

const fixture = (name: string): string =>
  readFileSync(
    path.join(import.meta.dir, "..", "lib", "sentry-fixtures", name),
    "utf-8"
  );

describe("envelope trailing-slash alias", () => {
  test("answers the SDK's trailing-slash POST with the envelope handler", async () => {
    controlEnv.RUNNER_TOKEN = ENV.RUNNER_TOKEN;
    controlEnv.RUNNER_URL = ENV.RUNNER_URL;
    envelopeLimiter.reset();

    // SAFETY: the handler only posts JSON-RPC bodies to the runner.
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: { fingerprints: ["fp-one"] },
        })
      )) as unknown as typeof fetch;

    try {
      const context = testRouteContext(
        new Request("http://localhost:9080/api/42/envelope/?sentry_key=k", {
          body: fixture("session.envelope.txt"),
          headers: { "content-type": "application/x-sentry-envelope" },
          method: "POST",
        }),
        // SAFETY: the handler reads only RUNNER_TOKEN/RUNNER_URL off the env.
        ENV as unknown as never
      );

      const response = await envelopeSlash(context, () => {
        throw new Error("trailing-slash envelope must not reach routing");
      });

      expect(response?.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("passes the slash-less path through to routing", async () => {
    const context = testRouteContext(
      new Request("http://localhost:9080/api/42/envelope?sentry_key=k", {
        body: fixture("session.envelope.txt"),
        headers: { "content-type": "application/x-sentry-envelope" },
        method: "POST",
      }),
      // SAFETY: the request never reaches the handler; the env is unread.
      ENV as unknown as never
    );

    let nextCalls = 0;

    const result = await envelopeSlash(context, () => {
      nextCalls += 1;

      return Promise.resolve();
    });

    expect(nextCalls).toBe(1);
    expect(result).toBeUndefined();
  });
});
