/**
 * MCP wire handling (alpha.4 A4): the JSON-RPC 2.0 subset the hosted
 * Streamable HTTP endpoint speaks — `initialize`, `ping`, `tools/list`,
 * `tools/call` and notifications. Stateless by design: one POST is one
 * message, answered with one JSON object (never an SSE stream), so there is no
 * session, no resumability and no batching, and `POST /mcp` needs no `GET`
 * counterpart (the transport answers 405, which is what the spec asks of a
 * server that offers no server-initiated stream).
 *
 * Everything that arrives is parsed here, at the boundary: the request
 * envelope through `RpcRequest`, each tool's `arguments` through the schema
 * that also publishes its `inputSchema`. Nothing downstream of a parse looks
 * at a raw JSON shape.
 */
import { Data } from "effect";
import type { JsonSchema } from "effect/JsonSchema";
import * as Schema from "effect/Schema";

import { errorMessage } from "../errors";
import type { KeyPrincipal } from "../key-principal";

/** Protocol revisions this server implements. Only the revision that defines
 * a plain-JSON response is listed; a client asking for another one is answered
 * with the default and decides whether it can continue. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18"];

/** Answered when the client's `protocolVersion` is absent or unsupported. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** The HTTP header carrying the negotiated revision on later requests. */
export const PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

/** What the header on a later request asked for. Two rules apply, and this
 * union is where each one is stated: `initialize` answers an unsupported
 * request with the default (the client decides), while a later request whose
 * header names an unsupported revision is refused with 400 — the transport
 * has no session that could have agreed to anything else. */
export type ProtocolVersionCheck = Data.TaggedEnum<{
  Absent: Record<never, never>;
  Supported: { readonly version: string };
  Unsupported: { readonly requested: string };
}>;

export const VersionCheck = Data.taggedEnum<ProtocolVersionCheck>();

/** The header rule (`tools/call` and friends). */
export const versionFromHeader = (
  header: string | null
): ProtocolVersionCheck => {
  if (header === null || header === "") {
    return VersionCheck.Absent();
  }

  return SUPPORTED_PROTOCOL_VERSIONS.includes(header)
    ? VersionCheck.Supported({ version: header })
    : VersionCheck.Unsupported({ requested: header });
};

export const SERVER_INFO = {
  name: "noite",
  version: "0.1.0-alpha.4",
} as const;

/** Handshake guidance agents read before their first tool call (the host
 * injects it as server-wide context). */
export const SERVER_INSTRUCTIONS =
  "Noite deploys apps from a git push. Use create_app (or push to a new slug) to make one, " +
  "repo_* to read its code, deploy_status and deploy_log to follow a deploy, app_logs and " +
  "app_errors to debug it, env_* to set variables, and *_environment (list_environments, " +
  "create_environment, deploy_environment, delete_environment) to preview a branch on its own " +
  "host and storage. Every tool takes `app`: an app slug or id.";

/** JSON-RPC 2.0 error codes used on the wire. */
export const RPC_CODES = {
  invalidParams: -32_602,
  invalidRequest: -32_600,
  methodNotFound: -32_601,
  parse: -32_700,
} as const;

/** JSON-RPC ids are strings or numbers; an unsendable one is answered as
 * null. */
export type JsonRpcId = number | string | null;

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcFailure {
  error: JsonRpcError;
  id: JsonRpcId;
  jsonrpc: "2.0";
}

export interface JsonRpcSuccess {
  id: JsonRpcId;
  jsonrpc: "2.0";
  result: unknown;
}

export type JsonRpcResponse = JsonRpcFailure | JsonRpcSuccess;

/** Who the call runs as: the principal the API key authenticated as — its
 * owner, the key's app set, its role ceiling and its expiry. Role checks
 * happen per app inside each tool, like the server actions do, through the
 * one key-enforcement function (`requireApp` in ./tools). */
export interface McpContext {
  principal: KeyPrincipal;
}

/** What a successful tool call carries: the text the model reads and the same
 * data as JSON, for clients that consume `structuredContent`. */
export interface McpToolResult {
  structured: Schema.Json;
  text: string;
}

/** A refusal a caller can act on: the closed `code` names the reason, the
 * `message` is the runner's own wording, and `hint` says what to do next. It
 * travels as the error result's `structuredContent`, so an agent branches on
 * the code instead of reading English; `tools.ts`'s classifier is the only
 * place one is built. */
export interface ToolRefusal {
  readonly code: string;
  readonly hint: string;
  readonly message: string;
}

/** A tool call that failed. `invalid` marks arguments that do not match the
 * tool's published `inputSchema` — a client error, answered with a JSON-RPC
 * error, per the MCP tools spec; every other failure is a tool result with
 * `isError: true` carrying this message. A `refusal` is the machine-readable
 * half of that result. */
export class McpToolError extends Error {
  override name = "McpToolError";

  readonly invalid: boolean;

  readonly refusal: ToolRefusal | null;

  constructor(
    message: string,
    options?: { invalid?: boolean; refusal?: ToolRefusal }
  ) {
    super(message);
    this.invalid = options?.invalid ?? false;
    this.refusal = options?.refusal ?? null;
  }
}

/** One tool as the transport sees it: published metadata plus a way to run it
 * from raw `arguments`. */
export interface McpToolDefinition {
  description: string;
  /** Published as `inputSchema`, derived from the tool's parser so the two
   * cannot drift. */
  inputSchema: JsonSchema;
  name: string;
  invoke: (context: McpContext, args: Schema.Json) => Promise<McpToolResult>;
}

/** One tool's declaration: `params` is both the parser and the source of the
 * published `inputSchema`, so `run` only ever sees validated arguments. */
export interface McpToolSpec<Args> {
  description: string;
  name: string;
  params: Schema.Codec<Args, Schema.Json>;
  run: (
    context: McpContext,
    args: Args
  ) => McpToolResult | Promise<McpToolResult>;
}

/** Bind a tool's parser to its body and erase the argument type for the
 * table. */
export const defineTool = <Args>(
  spec: McpToolSpec<Args>
): McpToolDefinition => ({
  description: spec.description,
  inputSchema: Schema.toJsonSchemaDocument(spec.params).schema,
  invoke: async (context, args) => {
    const decoded = Schema.decodeUnknownResult(spec.params)(args);

    if (decoded._tag === "Failure") {
      throw new McpToolError(
        `${spec.name}: "arguments" do not match the tool's inputSchema`,
        { invalid: true }
      );
    }

    return await spec.run(context, decoded.success);
  },
  name: spec.name,
});

/** Every request shape the endpoint accepts. Unknown fields (MCP's `_meta`, a
 * client's extra keys) are ignored. */
const RpcRequest = Schema.Struct({
  id: Schema.optional(
    Schema.Union([Schema.Number, Schema.String, Schema.Null])
  ),
  method: Schema.String,
  params: Schema.optional(Schema.Json),
});

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.optional(Schema.String),
});

const ToolCallParams = Schema.Struct({
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  name: Schema.String.check(Schema.isNonEmpty()),
});

/** The version the server answers with: the newest it supports that the client
 * asked for, else its default. */
export const negotiateProtocolVersion = (requested?: string): string =>
  requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;

const failure = (
  id: JsonRpcId,
  code: number,
  message: string
): JsonRpcFailure => ({ error: { code, message }, id, jsonrpc: "2.0" });

/** One `tools/call`: an unmatched argument list is a JSON-RPC error, an
 * execution failure is an `isError` result, and an unexpected throw is
 * reported to the model as text instead of a 500 it cannot read. */
const callTool = async (
  context: McpContext,
  id: JsonRpcId,
  params: Schema.Json | undefined,
  tools: readonly McpToolDefinition[]
): Promise<JsonRpcResponse> => {
  const decoded = Schema.decodeUnknownResult(ToolCallParams)(params ?? {});

  if (decoded._tag === "Failure") {
    return failure(
      id,
      RPC_CODES.invalidParams,
      'Invalid params: expected { "name": string, "arguments"?: object }'
    );
  }

  const { arguments: args, name } = decoded.success;
  const tool = tools.find((candidate) => candidate.name === name);

  if (!tool) {
    return failure(id, RPC_CODES.invalidParams, `Unknown tool: ${name}`);
  }

  try {
    const result = await tool.invoke(context, args ?? {});

    return {
      id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: result.text, type: "text" }],
        structuredContent: result.structured,
      },
    };
  } catch (error) {
    if (error instanceof McpToolError && error.invalid) {
      return failure(id, RPC_CODES.invalidParams, error.message);
    }

    // Strip the runner envelope ("runner rpc git.log: 404 …") so a tool error
    // reads as a sentence, like the push-to-create path does.
    // `errorMessage` peels Effect's wrapper and replaces a database query
    // failure with the fixed text: a tool error is a client string, never the
    // SQL statement or its bound parameters.
    const message = errorMessage(error).replace(
      /^runner (?:rpc \S+: \d+|GET \S+: \d+) /u,
      ""
    );

    // A refusal keeps `isError: true` (the spec's tool-execution error) and
    // carries its code in `structuredContent`, which the spec leaves to the
    // server to shape: a client can branch on `refusal.code` and still show
    // the text it would have shown anyway.
    const content = [{ text: message, type: "text" }];
    const refusal = error instanceof McpToolError ? error.refusal : null;

    return {
      id,
      jsonrpc: "2.0",
      result:
        refusal === null
          ? { content, isError: true }
          : { content, isError: true, structuredContent: { refusal } },
    };
  }
};

/** One client message. Returns null for a notification (and for the
 * `notifications/*` methods), which the transport answers with 202 and no
 * body; anything else gets exactly one JSON-RPC response. */
export const handleMcpMessage = async (
  context: McpContext,
  message: Schema.Json,
  tools: readonly McpToolDefinition[]
): Promise<JsonRpcResponse | null> => {
  const decoded = Schema.decodeUnknownResult(RpcRequest)(message);

  if (decoded._tag === "Failure") {
    return failure(
      null,
      RPC_CODES.invalidRequest,
      'Invalid Request: expected a JSON-RPC request with a "method"'
    );
  }

  const request = decoded.success;
  const id: JsonRpcId = request.id ?? null;

  // No `id`, or a `notifications/*` method, means notification: answer with
  // nothing (the transport replies 202). `id: null` is a real (discouraged)
  // id and still gets a response.
  if (request.id === undefined || request.method.startsWith("notifications/")) {
    return null;
  }

  switch (request.method) {
    case "initialize": {
      const params = Schema.decodeUnknownResult(InitializeParams)(
        request.params ?? {}
      );

      return {
        id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          instructions: SERVER_INSTRUCTIONS,
          protocolVersion: negotiateProtocolVersion(
            params._tag === "Success"
              ? params.success.protocolVersion
              : undefined
          ),
          serverInfo: SERVER_INFO,
        },
      };
    }

    case "ping": {
      return { id, jsonrpc: "2.0", result: {} };
    }

    case "tools/list": {
      return {
        id,
        jsonrpc: "2.0",
        result: {
          tools: tools.map(({ description, inputSchema, name }) => ({
            description,
            inputSchema,
            name,
          })),
        },
      };
    }

    case "tools/call": {
      return await callTool(context, id, request.params, tools);
    }

    default: {
      return failure(
        id,
        RPC_CODES.methodNotFound,
        `Method not found: ${request.method}`
      );
    }
  }
};
