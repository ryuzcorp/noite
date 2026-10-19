/** The control UI's MCP endpoint — the one JSON API a profile API key can
 * reach: the runner's REST wants `RUNNER_TOKEN`, which a user's key can never
 * be. Every platform command (environments, and whatever follows) goes through
 * it, so the CLI and an agent share one implementation of every rule (roles
 * included: the tools re-check the caller's role on every call).
 *
 * The transport is Streamable HTTP in its plain-JSON mode: one POST, one
 * message, one JSON response, no session — so a `tools/call` needs no
 * `initialize` before it. */
import { Effect } from "effect";
import * as Schema from "effect/Schema";

/** One tool call's arguments. They differ per tool and the server validates
 * them against the tool's published schema, so this is the one loose shape. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see above: the tool's own schema is the contract.
export type ToolArgs = Record<string, unknown>;

/** What a tool call answers: the text a caller prints, plus the same data as
 * JSON. */
export interface ToolCall<T> {
  readonly structured: T;
  readonly text: string;
}

/** Only the MCP fields this client reads; the tool result's content parts are
 * text-only in this server. */
const RpcResponse = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({ code: Schema.Number, message: Schema.String })
  ),
  result: Schema.optional(
    Schema.Struct({
      content: Schema.optional(
        Schema.Array(
          Schema.Struct({
            text: Schema.optional(Schema.String),
            type: Schema.optional(Schema.String),
          })
        )
      ),
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.optional(Schema.Json),
    })
  ),
});

/** A refusal body: the endpoint answers `{"error": "…"}` for a key it will not
 * accept. */
const Refusal = Schema.Struct({
  error: Schema.String.check(Schema.isNonEmpty()),
});

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(RpcResponse)
);

/** The reason out of a refusal body, or the body itself when it is not the
 * endpoint's JSON shape. */
const refusalReason = (body: string, fallback: string): string => {
  const text = body.trim();

  if (text === "") {
    return fallback;
  }

  try {
    return Schema.decodeUnknownSync(Refusal)(JSON.parse(text)).error;
  } catch {
    // Not the refusal shape (an HTML error page, a proxy): show it as it came.
    return text;
  }
};

/** The protocol revision this client speaks (the header the server checks). */
export const PROTOCOL_VERSION = "2025-06-18";

/** How long one call may take: a runner RPC behind an action is bounded at
 * 15 s, so this fails well before a CI step's own patience runs out. */
const TIMEOUT_MS = 30_000;

/** Call one MCP tool as the API key's account. A tool-level failure (a
 * refused role, a missing app, a denied key) fails here with the tool's own
 * message, which is what the user must read. */
export const callTool = <T>(
  connection: { readonly appUrl: string; readonly token: string },
  name: string,
  args: ToolArgs
): Effect.Effect<ToolCall<T>, Error> =>
  Effect.gen(function* run() {
    const { appUrl, token } = connection;

    const response = yield* Effect.tryPromise({
      catch: (cause) =>
        new Error(`cannot reach ${appUrl}/mcp: ${String(cause)}`),
      try: async (): Promise<Response> =>
        await fetch(`${appUrl}/mcp`, {
          body: JSON.stringify({
            id: 1,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: args, name },
          }),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "mcp-protocol-version": PROTOCOL_VERSION,
          },
          method: "POST",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
    });

    const body = yield* Effect.promise(() => response.text());

    if (!response.ok) {
      return yield* Effect.fail(
        new Error(
          `${appUrl}/mcp: ${response.status} ${refusalReason(body, response.statusText)}`
        )
      );
    }

    const payload = yield* Effect.try({
      catch: () =>
        new Error(`${name}: the MCP response is not a JSON-RPC message`),
      try: () => decodeResponse(body),
    });

    const { error, result } = payload;

    if (error) {
      return yield* Effect.fail(
        new Error(`MCP ${name}: ${error.code} ${error.message}`)
      );
    }

    if (result === undefined) {
      return yield* Effect.fail(new Error(`MCP ${name}: no result`));
    }

    const text = (result.content ?? [])
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();

    if (result.isError) {
      return yield* Effect.fail(
        new Error(text === "" ? `${name} failed` : text)
      );
    }

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(
        new Error(`MCP ${name}: no structured content`)
      );
    }

    // SAFETY: the caller names the tool and its result shape; the published
    // schema is the server's half of that contract.
    const structured = result.structuredContent as T;

    return { structured, text };
  });
