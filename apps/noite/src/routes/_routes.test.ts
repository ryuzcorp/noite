/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { afterEach, describe, expect, test } from "bun:test";

import type { TypedHandler } from "void";

import { testRouteContext } from "../testing/context";
import { POST as commitPost } from "./api/apps/[appId]/source/commit";
import { GET as healthGet } from "./health";
import { GET as mcpGet } from "./mcp";
import { POST as webhookPost } from "./webhook";

const ENV = { RUNNER_TOKEN: "runner-secret", RUNNER_URL: "http://runner.test" };

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

/** Drive a Void route handler with URL params (none, unless given). */
const drive = async (
  handler: TypedHandler,
  request: Request,
  params: Record<string, string> = {}
): Promise<Response> =>
  // SAFETY: the adapters always answer a Response (declines become 404).
  (await handler(
    testRouteContext(request, ENV as unknown as never, params)
  )) as Response;

/** A source-commit POST with the given route params and content type. */
const commit = (params: Record<string, string>, contentType: string) =>
  drive(
    commitPost,
    new Request("http://localhost:9080/api/apps/app_1/source/commit", {
      body: `{"message":"m","files":[]}`,
      headers: {
        "content-type": contentType,
        origin: "http://localhost:9080",
      },
      method: "POST",
    }),
    params
  );

describe("GET /health", () => {
  test("reports the build id and needs no auth", async () => {
    const res = await drive(healthGet, new Request("http://localhost/health"));
    const body = (await res.json()) as { build: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.build).toBeTypeOf("string");
    expect(body.build.length).toBeGreaterThan(0);
  });
});

describe("POST /webhook", () => {
  test("refuses callers without the runner token", async () => {
    let forwarded = false;
    setFetch(() => {
      forwarded = true;

      return Promise.resolve(new Response("ok"));
    });

    const anonymous = await drive(
      webhookPost,
      new Request("http://localhost/webhook", { body: "{}", method: "POST" })
    );

    expect(anonymous.status).toBe(401);

    const wrong = await drive(
      webhookPost,
      new Request("http://localhost/webhook", {
        body: "{}",
        headers: { authorization: "Bearer nope", cookie: "session=abc" },
        method: "POST",
      })
    );

    expect(wrong.status).toBe(401);
    expect(forwarded).toBe(false);
  });

  test("forwards only the body and content type — never cookies", async () => {
    let seen: { headers: Headers; url: string } | undefined;
    setFetch((url, init) => {
      seen = { headers: new Headers(init?.headers), url };

      return Promise.resolve(new Response("nudged"));
    });

    const res = await drive(
      webhookPost,
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

    expect(res.status).toBe(200);
    expect(seen?.url).toBe("http://runner.test/webhook");
    expect(seen?.headers.get("authorization")).toBe("Bearer runner-secret");
    expect(seen?.headers.get("cookie")).toBeNull();
    expect(seen?.headers.get("x-forwarded-for")).toBeNull();
  });

  test("refuses an oversized body", async () => {
    setFetch(() => Promise.resolve(new Response("ok")));

    const res = await drive(
      webhookPost,
      new Request("http://localhost/webhook", {
        body: "x".repeat(300 * 1024),
        headers: { authorization: "Bearer runner-secret" },
        method: "POST",
      })
    );

    expect(res.status).toBe(413);
  });
});

describe("POST /mcp", () => {
  test("serves POST only", async () => {
    const res = await drive(mcpGet, new Request("http://localhost/mcp"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /api/apps/:appId/source/commit", () => {
  test("reads the app id from the route params", async () => {
    const missing = await commit({}, "application/json");
    expect(missing.status).toBe(400);
  });

  test("still gates the content type first", async () => {
    const wrongType = await commit({ appId: "app_1" }, "text/plain");
    expect(wrongType.status).toBe(415);
  });
});
