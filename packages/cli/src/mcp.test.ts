import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import { Effect } from "effect";

import { callTool, PROTOCOL_VERSION } from "./mcp.js";

const CONNECTION = { appUrl: "https://app.noite.now", token: "noite_key" };

const fetchSpy = spyOn(globalThis, "fetch");

/** What the client sent last: the stub answers with `response` and records the
 * request, so one test can check both halves of the contract. */
let sent: { body: string; headers: Headers; url: string } | null = null;

const stubFetch = (response: Response): void => {
  const stub = (
    input: string | URL | Request,
    requestInit?: BunFetchRequestInit
  ): Promise<Response> => {
    sent = {
      body: String(requestInit?.body ?? ""),
      headers: new Headers(requestInit?.headers),
      url: String(input),
    };

    return Promise.resolve(response);
  };

  // SAFETY: the stub has the call signature and no `fetch.preconnect` (which
  // nothing here uses) — the same narrowing Bun's own `FetchSession.fetch` docs
  // prescribe.
  fetchSpy.mockImplementation(stub as typeof fetch);
};

afterEach(() => {
  fetchSpy.mockClear();
  sent = null;
});

afterAll(() => {
  fetchSpy.mockRestore();
});

describe("callTool", () => {
  test("posts one tools/call with the key and the protocol revision", async () => {
    stubFetch(
      Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          content: [{ text: "the text", type: "text" }],
          structuredContent: { ok: true },
        },
      })
    );

    const answer = await Effect.runPromise(
      callTool<{ ok: boolean }>(CONNECTION, "list_environments", {
        app: "my-app",
      })
    );

    expect(answer).toEqual({ structured: { ok: true }, text: "the text" });
    expect(sent?.url).toBe("https://app.noite.now/mcp");
    expect(sent?.headers.get("authorization")).toBe("Bearer noite_key");
    expect(sent?.headers.get("mcp-protocol-version")).toBe(PROTOCOL_VERSION);
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { app: "my-app" }, name: "list_environments" },
    });
  });

  test("fails with a tool error's own message", async () => {
    stubFetch(
      Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          content: [{ text: "no such environment\n", type: "text" }],
          isError: true,
        },
      })
    );

    const failure = await Effect.runPromise(
      Effect.flip(callTool(CONNECTION, "delete_environment", {}))
    );

    expect(failure.message).toBe("no such environment");
  });

  test("fails on a refused key, with the reason out of the JSON body", async () => {
    stubFetch(
      Response.json(
        { error: "missing or invalid API key" },
        { status: 401, statusText: "Unauthorized" }
      )
    );

    const failure = await Effect.runPromise(
      Effect.flip(callTool(CONNECTION, "list_environments", {}))
    );

    expect(failure.message).toBe(
      "https://app.noite.now/mcp: 401 missing or invalid API key"
    );
  });

  test("fails on a JSON-RPC error", async () => {
    stubFetch(
      Response.json({ error: { code: -32_601, message: "not found" }, id: 1 })
    );

    const failure = await Effect.runPromise(
      Effect.flip(callTool(CONNECTION, "nope", {}))
    );

    expect(failure.message).toBe("MCP nope: -32601 not found");
  });

  test("fails when a successful result carries no data", async () => {
    stubFetch(
      Response.json({ id: 1, jsonrpc: "2.0", result: { content: [] } })
    );

    const failure = await Effect.runPromise(
      Effect.flip(callTool(CONNECTION, "list_environments", {}))
    );

    expect(failure.message).toBe(
      "MCP list_environments: no structured content"
    );
  });

  test("fails when the response is not a JSON-RPC message", async () => {
    stubFetch(new Response("<html>gateway</html>", { status: 200 }));

    const failure = await Effect.runPromise(
      Effect.flip(callTool(CONNECTION, "list_environments", {}))
    );

    expect(failure.message).toBe(
      "list_environments: the MCP response is not a JSON-RPC message"
    );
  });
});
