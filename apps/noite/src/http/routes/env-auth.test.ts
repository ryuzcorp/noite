/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a fake session, runner fetch and env stand in for the platform */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { grantCollaborator } from "../../lib/collaborators";
import { controlEnv } from "../../lib/control-env";
import { ensureDbPromise, setD1Binding, withDb } from "../../lib/db";
import { stampRunnerEnv } from "../../lib/runner";
import type { TestD1 } from "../../testing/d1";
import { createTestD1 } from "../../testing/d1";
import { handleEnvAuth } from "./env-auth";

/** The signed-in account the route sees; null = signed out. */
let sessionUser: { email: string; id: string; name: string } | null = null;

// The route reads its session through session.server; replace that one read
// (nothing else in that module is used here) so the test can drive both the
// signed-out and signed-in paths without minting a real better-auth session.
// Bun hoists `mock.module` above the imports.
mock.module("../../lib/server/session.server", () => ({
  getSessionOrNull: async () =>
    sessionUser ? { impersonatedBy: null, user: sessionUser } : null,
}));

const ENV = {
  BASE_DOMAIN: "noite.localhost",
  BETTER_AUTH_SECRET: "env-auth-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://noite.localhost:9080",
  RUNNER_TOKEN: "runner-secret",
  RUNNER_URL: "http://runner.test",
};

const APP = { id: "app-1", slug: "app-one" };

const ENVIRONMENT = {
  appId: "app-1",
  appSlug: "app-one",
  id: "env-1",
  label: "feat-x",
};

let db: TestD1;
let calls: { method: string; params: Record<string, string> }[] = [];

const answer = (method: string): unknown => {
  if (method === "apps.get") {
    return APP;
  }

  if (method === "environments.list") {
    return [ENVIRONMENT];
  }

  if (method === "environments.grant") {
    return { token: "tok" };
  }

  return null;
};

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
  controlEnv.RUNNER_TOKEN = ENV.RUNNER_TOKEN;
  controlEnv.RUNNER_URL = ENV.RUNNER_URL;
  stampRunnerEnv(ENV as never);
  // SAFETY: the double only has to satisfy the JSON-RPC call shape runnerRpc makes.
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit
  ) => {
    // SAFETY: runnerRpc always sends a JSON-RPC envelope as a string body.
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: Record<string, string>;
    };

    calls.push({ method: body.method, params: body.params });
    const result = answer(body.method);

    return result === null
      ? Response.json({ error: { code: -32_001, message: "no" }, id: body.id })
      : Response.json({ id: body.id, jsonrpc: "2.0", result });
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  calls = [];
  sessionUser = null;
  db.raw.run(`DELETE FROM app_collaborator`);
  db.raw.run(`DELETE FROM "user"`);
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    "u-view",
    "View",
    "view@example.com",
  ]);
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    "u-stranger",
    "Stranger",
    "stranger@example.com",
  ]);
});

// The `mock.module` session double above leaks into later test files in a
// full-suite run (one shared module registry): leave it signed out so a
// signed-in case here cannot turn another file's 401 into a 403.
afterEach(() => {
  sessionUser = null;
});

const signIn = (id: string) => {
  sessionUser = { email: `${id}@example.com`, id, name: id };
};

const call = async (
  query: string,
  headers: Record<string, string> = {}
): Promise<Response> => {
  const request = new Request(`http://127.0.0.1:8090/api/env-auth${query}`, {
    headers,
  });

  const response = await handleEnvAuth(request, ENV as never, {});

  if (!response) {
    throw new Error("route answered nothing");
  }

  return response;
};

const returnUrl = (host = "feat-x.app-one.noite.localhost:9080") =>
  encodeURIComponent(`http://${host}/files/a.ts?line=3`);

describe("GET /api/env-auth", () => {
  test("requires env and app", async () => {
    const missing = await call("");
    const noApp = await call("?env=env-1");
    const noEnv = await call("?app=app-1");
    expect(missing.status).toBe(400);
    expect(noApp.status).toBe(400);
    expect(noEnv.status).toBe(400);
  });

  test("sends a signed-out viewer to /login with this URL to come back to", async () => {
    const response = await call(`?env=env-1&app=app-1&return=${returnUrl()}`);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith("/login?return=")).toBe(true);

    const back = new URLSearchParams(location.slice("?login".length)).get(
      "return"
    );

    expect(back).toBe(
      `/api/env-auth?env=env-1&app=app-1&return=${returnUrl()}`
    );
    // No runner call is made before the session exists.
    expect(calls).toEqual([]);
  });

  test("refuses a signed-in non-collaborator", async () => {
    signIn("u-stranger");
    const response = await call(`?env=env-1&app=app-1&return=${returnUrl()}`);
    expect(response.status).toBe(403);
    expect(calls.map((one) => one.method)).toEqual(["apps.get"]);
  });

  test("answers a frame with a page, never a bare line or the login form", async () => {
    // A preview frame's own navigation carries `Sec-Fetch-Dest: iframe`; the
    // login form is not an answer inside one, so the signed-out case is a page
    // whose sign-in link opens top-level.
    const signedOut = await call(`?env=env-1&app=app-1&return=${returnUrl()}`, {
      "sec-fetch-dest": "iframe",
    });

    expect(signedOut.status).toBe(401);
    expect(signedOut.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    const signInPage = await signedOut.text();
    expect(signInPage).toContain("Sign in to view this preview");
    expect(signInPage).toContain('target="_top"');
    expect(signInPage).toContain('href="/login?return=');
    // A refusal the gate cannot resolve reads as a page too.
    signIn("u-view");
    await withDb(grantCollaborator(APP.id, "u-view", "view"));

    const missing = await call(`?env=other&app=app-1&return=${returnUrl()}`, {
      "sec-fetch-dest": "iframe",
    });

    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("expired or was deleted");
  });

  test("mints a grant and 302s to the environment's own /__noite/auth", async () => {
    signIn("u-view");
    await withDb(grantCollaborator(APP.id, "u-view", "view"));

    const response = await call(`?env=env-1&app=app-1&return=${returnUrl()}`, {
      "x-forwarded-host": "noite.localhost:9080",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://feat-x.app-one.noite.localhost:9080/__noite/auth?token=tok&return=%2Ffiles%2Fa.ts%3Fline%3D3"
    );
    expect(calls.map((one) => one.method)).toEqual([
      "apps.get",
      "environments.list",
      "environments.grant",
    ]);
    expect(
      calls.find((one) => one.method === "environments.list")?.params.role
    ).toBe("view");
    expect(
      calls.find((one) => one.method === "environments.grant")?.params.userId
    ).toBe("u-view");
  });

  test("never trusts the host inside return", async () => {
    signIn("u-view");
    await withDb(grantCollaborator(APP.id, "u-view", "view"));

    const response = await call(
      `?env=env-1&app=app-1&return=${returnUrl("evil.example")}`,
      { "x-forwarded-host": "noite.localhost:9080" }
    );

    expect(response.headers.get("location")).toBe(
      "http://feat-x.app-one.noite.localhost:9080/__noite/auth?token=tok&return=%2F"
    );
  });

  test("404s an environment the app does not own", async () => {
    signIn("u-view");
    await withDb(grantCollaborator(APP.id, "u-view", "view"));

    const response = await call(`?env=other&app=app-1&return=${returnUrl()}`, {
      "x-forwarded-host": "noite.localhost:9080",
    });

    expect(response.status).toBe(404);
  });
});
