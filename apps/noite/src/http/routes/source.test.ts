/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { authFromEnv } from "../../lib/auth";
import { grantCollaborator } from "../../lib/collaborators";
import { ensureDb, setD1Binding } from "../../lib/db";
import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { installRunnerMock, makeApp } from "../../testing/runner-mock";
import type { RunnerMock } from "../../testing/runner-mock";
import { handleSourceCommit } from "./source";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "commit-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

const COMMIT_URL = "http://localhost:9080/api/apps/app_1/source/commit";

/** An empty header value deletes the header, so a case can drop `Origin`. */
const call = async (
  init: { body?: string; headers?: Record<string, string> } = {}
): Promise<Response | undefined> => {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "http://localhost:9080",
  });

  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value === "") {
      headers.delete(name);
    } else {
      headers.set(name, value);
    }
  }

  const request = new Request(COMMIT_URL, {
    body: init.body ?? `{"message":"m","files":[]}`,
    headers,
    method: "POST",
  });

  // SAFETY: the handler takes the full Worker env; the test env carries the auth/runner keys this path reads.
  return await handleSourceCommit(request, ENV as unknown as never, {
    appId: "app_1",
  });
};

beforeEach(async () => {
  const db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

describe("POST /api/apps/:appId/source/commit", () => {
  test("requires a JSON content type before reading the body", async () => {
    const response = await call({ headers: { "content-type": "text/plain" } });
    expect(response?.status).toBe(415);
  });

  test("refuses a foreign origin", async () => {
    const response = await call({
      headers: { origin: "https://tenant.example" },
    });

    expect(response?.status).toBe(403);
  });

  test("refuses a missing origin", async () => {
    // A browser always sends `Origin` on POST, and only the control UI's own
    // fetch calls this route.
    const response = await call({ headers: { origin: "" } });
    expect(response?.status).toBe(403);
  });

  test("requires a session", async () => {
    const response = await call();
    expect(response?.status).toBe(401);
  });
});

// ---- The API-key path ----
//
// `Authorization: Bearer noite_…` goes through the same authentication `/mcp`
// uses (`authenticateKey`) and the same app gate (`keyAppVerdict`), so a key
// limited to other apps, capped below push, expired or owner-banned cannot
// commit. The cookie path above is unchanged.

interface ForwardedCall {
  body: string;
  authorization: string;
  url: string;
}

const forwarded: ForwardedCall[] = [];

/** Capture the runner commit forward while the app lookup the key gate makes
 * (`/rpc`) keeps answering from the runner double. */
const captureForward = (answer: () => Response): (() => void) => {
  const original = globalThis.fetch;

  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    if (!String(url).includes("/source/")) {
      return await original(url, init);
    }

    const headers = new Headers(init?.headers);

    forwarded.push({
      authorization: headers.get("authorization") ?? "",
      body: String(init?.body ?? ""),
      url: String(url),
    });

    return answer();
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
};

const KEY_APP = makeApp({ id: "app_1", slug: "app-one", userId: "u_creator" });

let db: TestD1;
let runner: RunnerMock | null = null;
let restoreFetch: (() => void) | null = null;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
  forwarded.length = 0;
  restoreFetch?.();
  restoreFetch = null;
  runner?.restore();
  runner = installRunnerMock([KEY_APP]);
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    "u_push",
    "Ada",
    "ada@example.com",
  ]);
  await grantCollaborator("app_1", "u_push", "push");
});

afterAll(() => {
  restoreFetch?.();
  runner?.restore();
});

/** A key on the push-capable account, minted through better-auth exactly as
 * the Account page does. */
const mintKey = async (
  userId: string,
  over: {
    appIds?: string[] | null;
    permissions?: Record<string, string[]>;
    roleCeiling?: string;
  } = {}
): Promise<string> => {
  const created = await authFromEnv(
    // SAFETY: the test env carries the auth keys this path reads.
    ENV as unknown as KitEnv,
    ENV.BETTER_AUTH_URL
  ).api.createApiKey({
    body: {
      metadata: {
        appIds: over.appIds ?? null,
        roleCeiling: over.roleCeiling ?? "admin",
      },
      name: "ci",
      permissions: over.permissions ?? { apps: ["manage"] },
      userId,
    },
  });

  const key = created?.key;

  if (!key) {
    throw new Error("better-auth minted no API key");
  }

  return key;
};

describe("POST /api/apps/:appId/source/commit with an API key", () => {
  test("an agent with no Origin header commits and gets the runner's answer", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "a".repeat(40) }));
    const key = await mintKey("u_push");

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ sha: "a".repeat(40) });
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0].body)).toMatchObject({
      actor: { name: "Ada via key ci", userId: "u_push" },
      role: "push",
    });
    expect(forwarded[0].authorization).toBe("Bearer runner-secret");
  });

  test("a wrong key is refused with the endpoint's one 401 body", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));

    const response = await call({
      headers: { authorization: "Bearer noite_not-a-real-key", origin: "" },
    });

    expect(response?.status).toBe(401);
    expect(await response?.text()).toBe("missing or invalid API key");
    expect(forwarded).toHaveLength(0);
  });

  test("a key without apps:manage is refused", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));

    const key = await mintKey("u_push", {
      permissions: { events: ["ingest"] },
    });

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  test("a key limited to another app cannot commit here", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));
    const key = await mintKey("u_push", { appIds: ["app_other"] });

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test("a key capped below push cannot commit", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));
    const key = await mintKey("u_push", { roleCeiling: "view" });

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test("an expired key is refused", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));
    const key = await mintKey("u_push");
    db.raw.run(`UPDATE apikey SET expiresAt = ? WHERE referenceId = 'u_push'`, [
      "2020-01-01T00:00:00.000Z",
    ]);

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  test("a foreign Origin is still refused, key or not", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "unused" }));
    const key = await mintKey("u_push");

    const response = await call({
      headers: {
        authorization: `Bearer ${key}`,
        origin: "https://tenant.example",
      },
    });

    expect(response?.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test("expectedTip is forwarded to the runner's compare-and-set", async () => {
    restoreFetch = captureForward(() => Response.json({ sha: "b".repeat(40) }));
    const key = await mintKey("u_push");

    await call({
      body: `{"message":"m","files":[],"expectedTip":"${"c".repeat(40)}"}`,
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(JSON.parse(forwarded[0].body).expectedTip).toBe("c".repeat(40));
  });

  test("the runner's stale-tip refusal is passed through untouched", async () => {
    restoreFetch = captureForward(() =>
      Response.json(
        { error: "tip moved under this update: refs/heads/main" },
        { status: 409 }
      )
    );
    const key = await mintKey("u_push");

    const response = await call({
      headers: { authorization: `Bearer ${key}`, origin: "" },
    });

    expect(response?.status).toBe(409);
    expect(await response?.text()).toContain("tip moved");
  });
});
