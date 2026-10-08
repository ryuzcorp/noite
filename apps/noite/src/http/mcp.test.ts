/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: a minimal KitEnv stands in for the Worker env */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";

import { authFromEnv } from "../lib/auth";
import { ensureDbPromise, setD1Binding } from "../lib/db";
import { resetRateLimits } from "../lib/rate-limit";
import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { MAX_BODY_BYTES } from "./body";
import { handleHttp } from "./router";

const ENV = {
  BASE_DOMAIN: "localhost",
  BETTER_AUTH_SECRET: "mcp-test-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:9080",
  RUNNER_TOKEN: "runner-secret",
};

const MCP_URL = "http://localhost:9080/mcp";

let db: TestD1;

beforeEach(async () => {
  resetRateLimits();
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

/** An account plus a scoped key, minted through better-auth exactly as the
 * account page's create action does. */
const mintKey = async (
  userId: string,
  permissions?: Record<string, string[]>
): Promise<string> => {
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    userId,
    userId,
    `${userId}@example.com`,
  ]);
  const created = await authFromEnv(ENV, ENV.BETTER_AUTH_URL).api.createApiKey({
    body: {
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
  return await Promise.resolve(
    handleHttp(new Request(MCP_URL, requestInit), ENV as unknown as never)
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
