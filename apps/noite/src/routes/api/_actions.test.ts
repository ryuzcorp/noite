/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: stub handlers, a minimal KitEnv and a stubbed fetch stand in for the platform; assertions read JSON bodies back as their wire shapes */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";
import type { CloudContext } from "void";

import { api, ApiError } from "../../lib/api";
import { MissingAuthSecretError, UnauthorizedError } from "../../lib/auth";
import { ensureDbPromise, setD1Binding } from "../../lib/db";
import {
  actionErrorResponse,
  apiAction,
  apiActionNoInput,
  fail,
} from "../../lib/server/api";
import { testRouteContext } from "../../testing/context";
import { createTestD1 } from "../../testing/d1";
import { POST as myInviteCodesPost } from "./account/myInviteCodes";
import { POST as slugCheckPost } from "./apps/slugCheck";

beforeAll(async () => {
  const fresh = createTestD1();
  setD1Binding(fresh.d1);
  await ensureDbPromise();
});

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "actions-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Drive a JSON-action handler with a JSON body (none, unless given). */
const post = async (
  handler: (c: CloudContext) => unknown,
  path: string,
  env: Record<string, string>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the helper forwards whatever JSON body the case needs; the endpoint decodes it through its schema.
  body?: unknown
): Promise<Response> => {
  const request = new Request(`http://localhost:9080${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  // SAFETY: the test env carries the KitEnv keys the handlers read; unset keys stay undefined as handlers tolerate.
  const raw = await handler(
    testRouteContext(request, env as unknown as KitEnv)
  );
  if (raw instanceof Response) {
    return raw;
  }
  throw new Error("the handler did not answer a Response");
};
describe("actionErrorResponse", () => {
  test("fail(message) maps to 422 {errors}", async () => {
    const thrown = (() => {
      try {
        fail("Name is required");
      } catch (error) {
        return error;
      }
      throw new Error("fail did not throw");
    })();
    const response = actionErrorResponse(thrown);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      errors: { form: "Name is required" },
    });
  });

  test("the auth errors map to 401 {error}", async () => {
    const signedOut = actionErrorResponse(
      new UnauthorizedError({ message: "Sign in required" })
    );
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "Sign in required" });
    const misconfigured = actionErrorResponse(
      new MissingAuthSecretError({ message: "no secret" })
    );
    expect(misconfigured.status).toBe(401);
    expect(await misconfigured.json()).toEqual({ error: "no secret" });
  });

  test("anything else is masked as 500 Internal error", async () => {
    const response = actionErrorResponse(new Error("db exploded"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal error" });
  });
});

describe("apiAction", () => {
  const echo = apiAction(
    Schema.Struct({ word: Schema.String }),
    ({ word }) => ({
      said: word,
    })
  );

  test("a decoded body reaches the action and answers as JSON", async () => {
    const response = await post(echo, "/api/test/echo", {}, { word: "hi" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ said: "hi" });
  });

  test("undefined answers {ok: true}", async () => {
    const silent = apiAction(Schema.Struct({}), () => {});
    const response = await post(silent, "/api/test/silent", {}, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("a schema decode failure answers 422 Invalid input", async () => {
    const response = await post(echo, "/api/test/echo", {}, {});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      errors: { form: "Invalid input" },
    });
  });

  test("an unreadable body answers 400", async () => {
    const request = new Request("http://localhost:9080/api/test/echo", {
      body: "{nope",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    // SAFETY: the echo handler only reads the request body.
    const response = (await echo(
      testRouteContext(request, {} as unknown as KitEnv)
    )) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
  });

  test("a thrown fail answers 422 with its message", async () => {
    const refusing = apiAction(Schema.Struct({}), () => {
      fail("taken");
      return null;
    });
    const response = await post(refusing, "/api/test/refusing", {}, {});
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ errors: { form: "taken" } });
  });

  test("apiActionNoInput ignores the body", async () => {
    const ping = apiActionNoInput(() => ({ pong: true }));
    const response = await post(ping, "/api/test/ping", {}, { extra: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pong: true });
  });
});

describe("endpoint auth gating", () => {
  test("a signed-out caller gets 401, never Internal error", async () => {
    const response = await post(slugCheckPost, "/api/apps/slugCheck", ENV, {
      slug: "my-app",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required" });
  });

  test("an inputless endpoint gates the same way", async () => {
    const response = await post(
      myInviteCodesPost,
      "/api/account/myInviteCodes",
      ENV
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Sign in required" });
  });

  test("a misconfigured instance answers 401, not 500", async () => {
    const response = await post(
      slugCheckPost,
      "/api/apps/slugCheck",
      {},
      { slug: "my-app" }
    );
    expect(response.status).toBe(401);
  });
});

/** Answer every client request with one canned status + JSON body. */
const stubFetch = (
  status: number,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the stub answers whatever body the case needs; the client parses it at its boundary.
  body: unknown
): void => {
  // SAFETY: the client only reads status, headers and the JSON body.
  globalThis.fetch = (async () =>
    new Response(body === null ? null : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    })) as unknown as typeof fetch;
};

/** Run an action call that must reject, and hand back the ApiError. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- forwards the case's JSON body; the endpoint (or stub) parses it at its boundary.
const fails = async (path: string, input: unknown): Promise<ApiError> => {
  try {
    await api<null>(path, input);
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected ${path} to reject`);
};

describe("api client", () => {
  test("an ok response resolves the value", async () => {
    stubFetch(200, { id: "app_1" });
    await expect(api<{ id: string }>("/api/apps/create", {})).resolves.toEqual({
      id: "app_1",
    });
  });

  test("a 422 rejects with the joined field errors", async () => {
    stubFetch(422, { errors: { form: "Slug is reserved" } });
    const error = await fails("/api/apps/create", {});
    expect(error.status).toBe(422);
    expect(error.message).toBe("Slug is reserved");
    expect(error.errors).toEqual({ form: "Slug is reserved" });
  });

  test("a 401 rejects with the error body", async () => {
    stubFetch(401, { error: "Sign in required" });
    const error = await fails("/api/apps/get", "x");
    expect(error.message).toBe("Sign in required");
  });

  test("an empty error body falls back to the status", async () => {
    stubFetch(500, null);
    const error = await fails("/api/apps/get", "x");
    expect(error.message).toBe("Request failed (500)");
  });
});
