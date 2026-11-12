/** The control UI's MCP endpoint — the one JSON API a profile API key can
 * reach: the runner's REST wants `RUNNER_TOKEN`, which a user's key can never
 * be. Every platform command (environments, and whatever follows) goes through
 * it, so the CLI and an agent share one implementation of every rule (roles
 * included: the tools re-check the caller's role on every call).
 *
 * The transport is Streamable HTTP in its plain-JSON mode: one POST, one
 * message, one JSON response, no session — so a `tools/call` needs no
 * `initialize` before it.
 *
 * Every call ends in one closed outcome, produced by `classifyCall`:
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> Transport: POST /mcp
 *   Transport --> Http: status != 2xx
 *   Transport --> Protocol: body is not JSON-RPC
 *   Transport --> Rpc: JSON-RPC error
 *   Transport --> Tool: result.isError
 *   Transport --> Protocol: no result / no structuredContent
 *   Transport --> Ok: structuredContent
 * ```
 */
import { Data, Effect } from "effect";
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

/** Why a call did not produce a tool result. The kind is the part an agent
 * can branch on; the message is what today's CLI prints. */
export type CallFailureKind =
  | "http"
  | "protocol"
  | "rpc"
  | "tool"
  | "transport";

export type CallOutcome<T> = Data.TaggedEnum<{
  Failed: { readonly kind: CallFailureKind; readonly message: string };
  Ok: { readonly structured: T; readonly text: string };
}>;

/** Generic tagged enums carry their type parameter through the definition. */
export interface CallOutcomeDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: CallOutcome<this["A"]>;
}

const { Failed, Ok } = Data.taggedEnum<CallOutcomeDef>();

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

type RpcPayload = Schema.Schema.Type<typeof RpcResponse>;

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

/** Everything that can come back from one POST, in one closed input type. */
export type CallInput =
  | {
      readonly cause: unknown;
      readonly kind: "transport";
      readonly url: string;
    }
  | {
      readonly body: string;
      readonly kind: "http";
      readonly status: number;
      readonly statusText: string;
      readonly url: string;
    }
  | { readonly body: string; readonly kind: "unparsed" }
  | { readonly kind: "json"; readonly payload: RpcPayload };

/** The protocol revision this client speaks (the header the server checks). */
export const PROTOCOL_VERSION = "2025-06-18";

/** How long one call may take by default: a runner RPC behind an action is
 * bounded at 15 s, so this fails well before a CI step's own patience runs
 * out. `wait_for_deploy` passes its own, longer bound. */
const TIMEOUT_MS = 30_000;

/** Classify one call result. This is the only place the ladder lives: the
 * order (and therefore the message) is stable, and every rung is a tag. */
export const classifyCall = (
  input: CallInput,
  name: string
): CallOutcome<unknown> => {
  switch (input.kind) {
    case "http": {
      return Failed({
        kind: "http",
        message: `${input.url}: ${input.status} ${refusalReason(input.body, input.statusText)}`,
      });
    }

    case "json": {
      const { error, result } = input.payload;

      if (error !== undefined) {
        return Failed({
          kind: "rpc",
          message: `MCP ${name}: ${error.code} ${error.message}`,
        });
      }

      if (result === undefined) {
        return Failed({
          kind: "protocol",
          message: `MCP ${name}: no result`,
        });
      }

      const text = (result.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();

      if (result.isError === true) {
        return Failed({
          kind: "tool",
          message: text === "" ? `${name} failed` : text,
        });
      }

      if (result.structuredContent === undefined) {
        return Failed({
          kind: "protocol",
          message: `MCP ${name}: no structured content`,
        });
      }

      return Ok({ structured: result.structuredContent, text });
    }

    case "transport": {
      return Failed({
        kind: "transport",
        message: `cannot reach ${input.url}/mcp: ${String(input.cause)}`,
      });
    }

    case "unparsed": {
      return Failed({
        kind: "protocol",
        message: `${name}: the MCP response is not a JSON-RPC message`,
      });
    }

    default: {
      const unhandled: never = input;

      throw new Error(`unhandled MCP call input: ${String(unhandled)}`);
    }
  }
};

/** Call one MCP tool as the API key's account. A tool-level failure (a
 * refused role, a missing app, a denied key) fails here with the tool's own
 * message, which is what the user must read. `timeoutMs` is for the one tool
 * that waits on purpose (`wait_for_deploy`): its own bound plus the write it
 * answers with. */
export const callTool = <T>(
  connection: { readonly appUrl: string; readonly token: string },
  name: string,
  args: ToolArgs,
  options?: { readonly timeoutMs?: number }
): Effect.Effect<ToolCall<T>, Error> =>
  Effect.gen(function* run() {
    const { appUrl, token } = connection;

    const fetched = yield* Effect.tryPromise({
      catch: (cause) => cause,
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
          signal: AbortSignal.timeout(options?.timeoutMs ?? TIMEOUT_MS),
        }),
    }).pipe(
      Effect.map((response) => ({ response, tag: "Response" as const })),
      Effect.orElseSucceed((cause) => ({ cause, tag: "Failed" as const }))
    );

    let outcome: CallOutcome<unknown>;

    if (fetched.tag === "Failed") {
      outcome = classifyCall(
        { cause: fetched.cause, kind: "transport", url: appUrl },
        name
      );
    } else {
      const body = yield* Effect.promise(() => fetched.response.text());

      if (fetched.response.ok) {
        try {
          outcome = classifyCall(
            { kind: "json", payload: decodeResponse(body) },
            name
          );
        } catch {
          outcome = classifyCall({ body, kind: "unparsed" }, name);
        }
      } else {
        outcome = classifyCall(
          {
            body,
            kind: "http",
            status: fetched.response.status,
            statusText: fetched.response.statusText,
            url: `${appUrl}/mcp`,
          },
          name
        );
      }
    }

    if (outcome._tag === "Failed") {
      return yield* Effect.fail(new Error(outcome.message));
    }

    // SAFETY: the caller names the tool and its result shape; the published
    // schema is the server's half of that contract.
    return { structured: outcome.structured as T, text: outcome.text };
  });
