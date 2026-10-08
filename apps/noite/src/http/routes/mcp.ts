/**
 * `POST /mcp`: the hosted MCP endpoint agents talk to (alpha.4 A4).
 *
 * There is no session and no OAuth: the caller authenticates with a Noite API
 * key in `Authorization: Bearer noite_…`, verified exactly like
 * `/internal/git-auth` does, and every tool then runs as that account through
 * the same role gate the UI's actions use. The transport is Streamable HTTP in
 * its plain-JSON mode — one POST, one message, one JSON response — so `GET`
 * (which the spec reserves for a server-initiated SSE stream we do not offer)
 * and `DELETE` (sessions we never create) both answer 405, and a notification
 * answers 202 with no body.
 *
 * Browser `Origin`s are checked because this endpoint accepts a bearer token
 * from a page: a cross-site caller that got hold of a key must still be turned
 * away by the browser's own preflight rules, and a rebound DNS name must not
 * be treated as the control site.
 */
import type { Json } from "effect/Schema";

import { authFromEnv, MissingAuthSecretError } from "../../lib/auth";
import { ensureDbPromise } from "../../lib/db";
import {
  handleMcpMessage,
  PROTOCOL_VERSION_HEADER,
  RPC_CODES,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../../lib/mcp/protocol";
import type { JsonRpcFailure } from "../../lib/mcp/protocol";
import { MCP_TOOLS } from "../../lib/mcp/tools";
import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../body";
import type { RouteHandler } from "../config";

const unauthorized = (): Response =>
  Response.json(
    { error: "missing or invalid API key" },
    {
      headers: {
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      },
      status: 401,
    }
  );

const parseFailure = (): Response => {
  const body: JsonRpcFailure = {
    error: { code: RPC_CODES.parse, message: "Parse error: body is not JSON" },
    id: null,
    jsonrpc: "2.0",
  };
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status: 400,
  });
};

/** Whether a browser may call this endpoint from where it says it is: this
 * site (the control UI's own fetch), plus the configured auth URL when a proxy
 * makes the two differ. A request without `Origin` (any non-browser MCP
 * client) is unaffected. */
const originAllowed = (request: Request, env: KitEnv): boolean => {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  try {
    if (origin === new URL(request.url).origin) {
      return true;
    }
  } catch {
    return false;
  }
  if (!env.BETTER_AUTH_URL) {
    return false;
  }
  try {
    return origin === new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    // A malformed BETTER_AUTH_URL already fails loudly on the auth path; it
    // does not widen what this endpoint accepts.
    return false;
  }
};

const bearerKey = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const key = header.slice("bearer ".length).trim();
  return key === "" ? null : key;
};

export const handleMcp: RouteHandler = async (request, env) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      headers: { allow: "POST" },
      status: 405,
    });
  }
  if (!originAllowed(request, env)) {
    return Response.json(
      { error: "origin not allowed" },
      { headers: { "cache-control": "no-store" }, status: 403 }
    );
  }
  const version = request.headers.get(PROTOCOL_VERSION_HEADER);
  if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return Response.json(
      { error: `unsupported MCP protocol version: ${version}` },
      { headers: { "cache-control": "no-store" }, status: 400 }
    );
  }
  const key = bearerKey(request);
  if (!key) {
    return unauthorized();
  }
  await ensureDbPromise();
  let userId: string;
  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );
    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: { apps: ["manage"] } },
    });
    const owner = verified.valid ? verified.key?.referenceId : null;
    if (!owner) {
      return unauthorized();
    }
    userId = owner;
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return new Response(error.message, { status: 500 });
    }
    throw error;
  }
  const body = await readBoundedText(request, MAX_BODY_BYTES);
  if (body === null) {
    return tooLarge();
  }
  let message: Json;
  try {
    message = JSON.parse(body);
  } catch {
    return parseFailure();
  }
  const response = await handleMcpMessage({ userId }, message, MCP_TOOLS);
  if (response === null) {
    return new Response(null, { status: 202 });
  }
  return Response.json(response, {
    headers: { "cache-control": "no-store" },
  });
};
