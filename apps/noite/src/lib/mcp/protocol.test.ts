/* oxlint-disable anti-slop/no-unknown-returns -- the wire assertions compare whole JSON-RPC envelopes with `toMatchObject`; narrowing every field would test the test */
import { describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";

import {
  defineTool,
  handleMcpMessage,
  McpToolError,
  negotiateProtocolVersion,
  RPC_CODES,
} from "./protocol";
import type { JsonRpcError, JsonRpcResponse } from "./protocol";

/** The three shapes a tool can have: it runs, it rejects its arguments, or it
 * fails while running. */
const ECHO = defineTool({
  description: "Echo the text back.",
  name: "echo",
  params: Schema.Struct({ text: Schema.String.check(Schema.isNonEmpty()) }),
  run: (_context, { text }) => ({
    structured: { said: text },
    text: `said ${text}`,
  }),
});
const STRICT = defineTool({
  description: "Needs a text argument.",
  name: "strict",
  params: Schema.Struct({ text: Schema.String }),
  run: () => ({ structured: {}, text: "ok" }),
});
const BROKEN = defineTool({
  description: "Fails while running.",
  name: "broken",
  params: Schema.Record(Schema.String, Schema.Json),
  run: () => {
    throw new McpToolError("The runner is unreachable.");
  },
});

const TOOLS = [ECHO, STRICT, BROKEN];

const CALLER = { userId: "u1" };

const send = (message: Schema.Json) => handleMcpMessage(CALLER, message, TOOLS);

const errorOf = (response: JsonRpcResponse | null): JsonRpcError => {
  if (!response || !("error" in response)) {
    throw new Error(
      `expected a JSON-RPC error, got ${JSON.stringify(response)}`
    );
  }
  return response.error;
};

const resultOf = (response: JsonRpcResponse | null): unknown => {
  if (!response || !("result" in response)) {
    throw new Error(`expected a result, got ${JSON.stringify(response)}`);
  }
  return response.result;
};

describe("MCP protocol", () => {
  test("initialize answers with the negotiated version, tools capability and server info", async () => {
    const supported = await send({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { clientInfo: { name: "probe" }, protocolVersion: "2025-06-18" },
    });
    expect(resultOf(supported)).toMatchObject({
      capabilities: { tools: {} },
      protocolVersion: "2025-06-18",
      serverInfo: { name: "noite" },
    });

    const unknown = await send({
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    });
    expect(resultOf(unknown)).toMatchObject({ protocolVersion: "2025-06-18" });

    const bare = await send({ id: 3, method: "initialize" });
    expect(resultOf(bare)).toMatchObject({ protocolVersion: "2025-06-18" });
  });

  test("a client's supported version is what comes back", () => {
    expect(negotiateProtocolVersion("2025-06-18")).toBe("2025-06-18");
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2025-06-18");
    expect(negotiateProtocolVersion()).toBe("2025-06-18");
  });

  test("ping answers an empty result", async () => {
    const response = await send({ id: 7, jsonrpc: "2.0", method: "ping" });
    expect(resultOf(response)).toEqual({});
  });

  test("tools/list publishes the schema, never the implementation", async () => {
    const response = await send({ id: 8, method: "tools/list", params: {} });
    expect(resultOf(response)).toMatchObject({
      tools: [
        {
          description: "Echo the text back.",
          inputSchema: {
            properties: { text: { minLength: 1, type: "string" } },
            required: ["text"],
            type: "object",
          },
          name: "echo",
        },
        { name: "strict" },
        { name: "broken" },
      ],
    });
    expect(JSON.stringify(resultOf(response))).not.toContain("invoke");
  });

  test("tools/call runs the tool and returns text plus structured content", async () => {
    const response = await send({
      id: 9,
      method: "tools/call",
      params: { arguments: { text: "hi" }, name: "echo" },
    });
    expect(resultOf(response)).toMatchObject({
      content: [{ text: "said hi", type: "text" }],
      structuredContent: { said: "hi" },
    });
  });

  test("arguments that miss the schema are a JSON-RPC error, not a tool result", async () => {
    const bad = await send({
      id: 10,
      method: "tools/call",
      params: { arguments: { nope: 1 }, name: "strict" },
    });
    expect(errorOf(bad)).toMatchObject({ code: RPC_CODES.invalidParams });
    expect(errorOf(bad).message).toBe(
      'strict: "arguments" do not match the tool\'s inputSchema'
    );
  });

  test("a tool that fails while running is an isError result", async () => {
    const response = await send({
      id: 11,
      method: "tools/call",
      params: { name: "broken" },
    });
    expect(resultOf(response)).toMatchObject({
      content: [{ text: "The runner is unreachable.", type: "text" }],
      isError: true,
    });
  });

  test("bad params answer -32602 with what was expected", async () => {
    const missingName = await send({
      id: 12,
      method: "tools/call",
      params: {},
    });
    expect(errorOf(missingName).code).toBe(RPC_CODES.invalidParams);

    const wrongArgs = await send({
      id: 13,
      method: "tools/call",
      params: { arguments: "text", name: "echo" },
    });
    expect(errorOf(wrongArgs).code).toBe(RPC_CODES.invalidParams);

    const noParams = await send({ id: 14, method: "tools/call" });
    expect(errorOf(noParams)).toMatchObject({ code: RPC_CODES.invalidParams });

    const unknown = await send({
      id: 15,
      method: "tools/call",
      params: { name: "delete_everything" },
    });
    expect(errorOf(unknown)).toMatchObject({
      code: RPC_CODES.invalidParams,
      message: "Unknown tool: delete_everything",
    });
  });

  test("an unknown method answers -32601, keeping the id", async () => {
    const response = await send({ id: "abc", method: "resources/list" });
    expect(response).toMatchObject({
      error: { code: RPC_CODES.methodNotFound },
      id: "abc",
    });
  });

  test("notifications answer nothing, with or without an id", async () => {
    expect(
      await send({ jsonrpc: "2.0", method: "notifications/initialized" })
    ).toBeNull();
    expect(
      await send({ id: 1, method: "notifications/cancelled", params: {} })
    ).toBeNull();
    expect(await send({ jsonrpc: "2.0", method: "ping" })).toBeNull();
  });

  test("a malformed message answers -32600 with a null id", async () => {
    expect(await send("hello")).toMatchObject({
      error: { code: RPC_CODES.invalidRequest },
      id: null,
    });
    expect(await send([{ id: 1, method: "ping" }])).toMatchObject({
      error: { code: RPC_CODES.invalidRequest },
      id: null,
    });
    expect(await send({ id: 1, params: {} })).toMatchObject({
      error: { code: RPC_CODES.invalidRequest },
      id: null,
    });
  });
});
