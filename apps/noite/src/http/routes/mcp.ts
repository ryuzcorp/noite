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

import {
  handleMcpMessage,
  PROTOCOL_VERSION_HEADER,
  RPC_CODES,
  versionFromHeader,
} from "../../lib/mcp/protocol";
import type { JsonRpcFailure } from "../../lib/mcp/protocol";
import { MCP_TOOLS } from "../../lib/mcp/tools";
import { authenticateMcp } from "../../lib/server/mcp-auth.server";
import { MAX_BODY_BYTES, readBoundedText, tooLarge } from "../body";
import type { RouteHandler } from "../config";
import { originAllowed } from "../origin";

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

  const version = versionFromHeader(
    request.headers.get(PROTOCOL_VERSION_HEADER)
  );

  if (version._tag === "Unsupported") {
    return Response.json(
      { error: `unsupported MCP protocol version: ${version.requested}` },
      { headers: { "cache-control": "no-store" }, status: 400 }
    );
  }

  // One state per credential outcome (lib/server/mcp-auth.server); every
  // refusal keeps the single "missing or invalid API key" 401 body, so a key
  // without the scope stays indistinguishable from an unknown one.
  const auth = await authenticateMcp(request, env);

  if (auth._tag === "Misconfigured") {
    return new Response(auth.message, { status: 500 });
  }

  if (auth._tag !== "Authed") {
    return unauthorized();
  }

  const { userId } = auth;

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
