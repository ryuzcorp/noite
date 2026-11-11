/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import type { Json } from "effect/Schema";

import { authFromEnv } from "../lib/auth";
import { ensureDb, setD1Binding } from "../lib/db";
import { resetPlatformLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { installRunnerMock, makeApp } from "../testing/runner-mock";
import type { RunnerMock } from "../testing/runner-mock";
import { MAX_BODY_BYTES } from "./body";
import { handleMcp } from "./routes/mcp";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "mcp-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

const MCP_URL = "http://localhost:9080/mcp";

let db: TestD1;

beforeEach(async () => {
  resetPlatformLimits();
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

/** An account plus a scoped key, minted through better-auth exactly as the
 * account page's create action does. */
interface TestKeyMetadata {
  appIds?: string[] | null;
  roleCeiling?: "view" | "push" | "admin";
}

const mintKey = async (
  userId: string,
  permissions?: Record<string, string[]>,
  metadata?: TestKeyMetadata
): Promise<string> => {
  // OR IGNORE: a suite may seed the account (and its grants) before minting.
  db.raw.run(
    `INSERT OR IGNORE INTO "user" (id, name, email) VALUES (?, ?, ?)`,
    [userId, userId, `${userId}@example.com`]
  );

  const created = await authFromEnv(ENV, ENV.BETTER_AUTH_URL).api.createApiKey({
    body: {
      metadata,
      name: "mcp-test",
      permissions: permissions ?? { apps: ["manage"] },
      userId,
    },
  });

  const key = created?.key;

  if (!key) {
    throw new Error("better-auth minted no API key");
  }

  return key;
};

const call = async (
  body: string,
  init?: { headers?: Record<string, string>; method?: string }
): Promise<Response | undefined> => {
  const requestInit: RequestInit = {
    headers: { "content-type": "application/json", ...init?.headers },
    method: init?.method ?? "POST",
  };

  // A GET carries no body: `new Request` throws on one.
  if (body !== "") {
    requestInit.body = body;
  }

  return await handleMcp(
    new Request(MCP_URL, requestInit),
    // SAFETY: the handler takes the full Worker env; the test env carries the auth/runner keys this path reads.
    ENV as unknown as never
  );
};

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("POST /mcp", () => {
  test("serves POST only", async () => {
    for (const method of ["GET", "DELETE"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- two method probes, read in order
      const response = await call("", { method });
      expect(response?.status).toBe(405);
      expect(response?.headers.get("allow")).toBe("POST");
    }
  });

  test("refuses a missing or wrong key with WWW-Authenticate", async () => {
    // better-auth logs every rejected key at ERROR level; this case is about
    // the HTTP answer, so keep the lane's output clean.
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const missing = await call(`{"id":1,"method":"ping"}`);
      expect(missing?.status).toBe(401);
      expect(missing?.headers.get("www-authenticate")).toBe("Bearer");
      expect(missing?.headers.get("cache-control")).toBe("no-store");

      const wrong = await call(`{"id":1,"method":"ping"}`, {
        headers: bearer("noite_not-a-real-key"),
      });

      expect(wrong?.status).toBe(401);
      expect(wrong?.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      logged.mockRestore();
    }
  });

  test("refuses a key without the app-management scope", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const eventsOnly = await mintKey("u-events", { events: ["push"] });

      const response = await call(`{"id":1,"method":"ping"}`, {
        headers: bearer(eventsOnly),
      });

      expect(response?.status).toBe(401);
    } finally {
      logged.mockRestore();
    }
  });

  test("a valid key whose owner is banned is refused", async () => {
    // `banUser` revokes sessions but not API keys, and the plugin never checks
    // the owner's ban flag: the endpoint has to, or a ban leaves /mcp (and git
    // push) working as the banned account.
    const key = await mintKey("banned-owner");
    db.raw.run(`UPDATE "user" SET banned = 1 WHERE id = 'banned-owner'`);

    const response = await call(`{"id":1,"method":"ping"}`, {
      headers: bearer(key),
    });

    expect(response?.status).toBe(401);
    expect(response?.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("rejects a browser origin that is not this control site", async () => {
    const key = await mintKey("u-origin");

    const hostile = await call(`{"id":1,"method":"ping"}`, {
      headers: { ...bearer(key), origin: "https://evil.example" },
    });

    expect(hostile?.status).toBe(403);

    const sameSite = await call(`{"id":1,"method":"ping"}`, {
      headers: { ...bearer(key), origin: "http://localhost:9080" },
    });

    expect(sameSite?.status).toBe(200);
  });

  test("answers initialize, tools/list and ping for a real key", async () => {
    const key = await mintKey("u-ok");

    const initialized = await call(
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      { headers: bearer(key) }
    );

    expect(initialized?.status).toBe(200);
    expect(initialized?.headers.get("content-type")).toContain(
      "application/json"
    );
    expect(await initialized?.json()).toMatchObject({
      id: 1,
      result: {
        capabilities: { tools: {} },
        protocolVersion: "2025-06-18",
        serverInfo: { name: "noite" },
      },
    });

    const listed = await call(JSON.stringify({ id: 2, method: "tools/list" }), {
      headers: bearer(key),
    });

    // SAFETY: handleHttp answers JSON for a tools/list request (asserted 200 above by the initialize probe).
    const payload = (await listed?.json()) as {
      result?: { tools?: { name: string }[] };
    };

    const names = payload.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("list_apps");
    expect(names).toContain("create_app");
    expect(names).toContain("repo_commit");
    expect(names).toContain("env_set");
  });

  test("a notification is 202 with no body", async () => {
    const key = await mintKey("u-notify");

    const response = await call(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      { headers: bearer(key) }
    );

    expect(response?.status).toBe(202);
    expect(await response?.text()).toBe("");
  });

  test("an unknown method is a JSON-RPC error, not a 404", async () => {
    const key = await mintKey("u-method");

    const response = await call(
      JSON.stringify({ id: 3, method: "resources/list" }),
      { headers: bearer(key) }
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      error: { code: -32_601 },
      id: 3,
    });
  });

  test("an unparseable body is a 400 with a parse error", async () => {
    const key = await mintKey("u-parse");
    const response = await call("{not json", { headers: bearer(key) });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: -32_700 },
      id: null,
    });
  });

  test("a body over the bound is refused before it is read", async () => {
    const key = await mintKey("u-big");

    const response = await call("x".repeat(MAX_BODY_BYTES + 1), {
      headers: bearer(key),
    });

    expect(response?.status).toBe(413);
  });

  test("rejects an unsupported MCP-Protocol-Version header", async () => {
    const key = await mintKey("u-version");

    const response = await call(`{"id":1,"method":"ping"}`, {
      headers: { ...bearer(key), "mcp-protocol-version": "1999-01-01" },
    });

    expect(response?.status).toBe(400);

    const supported = await call(`{"id":1,"method":"ping"}`, {
      headers: { ...bearer(key), "mcp-protocol-version": "2025-06-18" },
    });

    expect(supported?.status).toBe(200);
  });
});

const callTool = async (key: string, name: string, args: Json) => {
  const response = await call(
    JSON.stringify({
      id: 7,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: args, name },
    }),
    { headers: bearer(key) }
  );

  // SAFETY: a tools/call answers one JSON-RPC envelope (the route asserted
  // 200 for every call that reaches here).
  return (await response?.json()) as {
    result?: {
      content: { text: string }[];
      isError?: boolean;
      structuredContent?: {
        apps?: { id: string }[];
        app?: { slug: string };
      };
    };
  };
};

describe("a scoped key over MCP", () => {
  const SCOPED = makeApp({ id: "app-1", slug: "app-one", userId: "u-scoped" });

  const OTHER = makeApp({
    id: "app-2",
    name: "Two",
    slug: "two",
    userId: "u-other",
  });

  let runner: RunnerMock;

  beforeEach(() => {
    runner = installRunnerMock([SCOPED, OTHER]);
    db.raw.run(
      `INSERT OR IGNORE INTO "user" (id, name, email) VALUES ('u-scoped', 'u-scoped', 'u-scoped@example.com')`
    );
    db.raw.run(
      `INSERT INTO app_collaborator (id, appId, userId, role) VALUES ('c1', 'app-1', 'u-scoped', 'push'), ('c2', 'app-2', 'u-scoped', 'push')`
    );
  });

  afterEach(() => {
    runner.restore();
  });

  test("list_apps returns only the apps the key may act on", async () => {
    const key = await mintKey(
      "u-scoped",
      { apps: ["manage"] },
      {
        appIds: ["app-1"],
      }
    );

    const payload = await callTool(key, "list_apps", {});

    expect(
      payload.result?.structuredContent?.apps?.map((app) => app.id)
    ).toEqual(["app-1"]);
  });

  test("an app outside the key's set is refused by every app tool", async () => {
    const key = await mintKey(
      "u-scoped",
      { apps: ["manage"] },
      {
        appIds: ["app-1"],
      }
    );

    const foreign = await callTool(key, "get_app", { app: "two" });

    expect(foreign.result?.isError).toBe(true);
    expect(foreign.result?.content[0]?.text).toContain("No app");
  });

  test("create_app attributes its import commit to the key", async () => {
    const key = await mintKey("u-scoped", { apps: ["manage"] });

    await callTool(key, "create_app", {
      slug: "imported",
      source: { kind: "template", template: "ilha-void" },
    });

    // SAFETY: the runner mock records each call's params object as sent.
    const create = runner.requests.find(
      (request) => (request as { slug?: string }).slug === "imported"
    );

    expect(create).toMatchObject({
      source: {
        actor: { name: "u-scoped via key mcp-test", userId: "u-scoped" },
      },
    });
  });

  test("a capped key cannot create an app", async () => {
    const key = await mintKey(
      "u-scoped",
      { apps: ["manage"] },
      {
        appIds: null,
        roleCeiling: "push",
      }
    );

    const created = await callTool(key, "create_app", { slug: "capped" });

    expect(created.result?.isError).toBe(true);
    expect(created.result?.content[0]?.text).toContain(
      "role ceiling cannot create apps"
    );
  });

  test("an app-scoped key cannot create an app", async () => {
    const key = await mintKey(
      "u-scoped",
      { apps: ["manage"] },
      {
        appIds: ["app-1"],
      }
    );

    const created = await callTool(key, "create_app", { slug: "fresh" });

    expect(created.result?.isError).toBe(true);
    expect(created.result?.content[0]?.text).toContain(
      "limited to specific apps"
    );
  });

  test("an expired key is refused with its own message", async () => {
    const key = await mintKey("u-scoped");

    db.raw.run(
      `UPDATE apikey SET expiresAt = ? WHERE referenceId = 'u-scoped'`,
      [new Date("2020-01-01T00:00:00Z").toISOString()]
    );

    // better-auth logs every refused key at ERROR level; this case is about
    // the answer.
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await call(`{"id":1,"method":"ping"}`, {
        headers: bearer(key),
      });

      expect(response?.status).toBe(401);
      expect(await response?.json()).toEqual({ error: "API key expired" });
    } finally {
      logged.mockRestore();
    }
  });

  test("a push ceiling keeps an admin's key out of admin tools", async () => {
    // The owner is a full admin on the app; the key may only push.
    db.raw.run(`UPDATE "user" SET role = 'admin' WHERE id = 'u-scoped'`);
    db.raw.run(
      `UPDATE app_collaborator SET role = 'admin' WHERE userId = 'u-scoped'`
    );

    const key = await mintKey(
      "u-scoped",
      { apps: ["manage"] },
      {
        appIds: null,
        roleCeiling: "push",
      }
    );

    const settings = await callTool(key, "env_set", {
      app: "app-one",
      key: "A",
      value: "1",
    });

    expect(settings.result?.isError).toBe(true);
    expect(settings.result?.content[0]?.text).toContain("administer");

    const read = await callTool(key, "get_app", { app: "app-one" });
    expect(read.result?.isError).toBeFalsy();
  });
});
