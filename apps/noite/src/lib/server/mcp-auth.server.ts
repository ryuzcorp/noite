//! `POST /mcp` authentication, as one state instead of nested guards.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> MissingKey: no Bearer credential
//!   [*] --> Rejected: verifyApiKey refused
//!   [*] --> Misconfigured: BETTER_AUTH_SECRET missing
//!   [*] --> Authed: key valid + apps:manage scope
//!   Authed --> [*]: the tool call runs as that userId
//! ```
//!
//! `Rejected.code` keeps the plugin's own reason (`KEY_NOT_FOUND` covers an
//! unknown key *and* a key without the `apps:manage` scope — the plugin
//! deliberately does not tell them apart), so the log names what happened
//! while the wire keeps its one 401 body.
import { Data } from "effect";

import { authFromEnv, MissingAuthSecretError } from "../auth";
import { ensureDb } from "../db";
import { keyOwnerActive } from "./api-keys.server";

/** The credential state behind one MCP request. */
export type McpAuth = Data.TaggedEnum<{
  Authed: { readonly userId: string };
  /** No `Authorization: Bearer …` at all. */
  MissingKey: Record<never, never>;
  /** The key was presented and refused. `code` is the plugin's reason;
   * `KEY_NOT_FOUND` means unknown key *or* missing `apps:manage` scope. */
  Rejected: { readonly code: string };
  /** The key is valid but its owner is banned: a ban must revoke machine
   * credentials too, or "Ban" would leave `/mcp` (and git push) working. */
  OwnerBanned: Record<never, never>;
  /** The worker has no auth secret: a deployment fault, not a caller's. */
  Misconfigured: { readonly message: string };
}>;

export const McpAuthState = Data.taggedEnum<McpAuth>();

/** The key in an `Authorization: Bearer …` header, or null. */
export const bearerKey = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";

  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const key = header.slice("bearer ".length).trim();

  return key === "" ? null : key;
};

/** The one authentication transition for the endpoint. */
export const authenticateMcp = async (
  request: Request,
  env: KitEnv
): Promise<McpAuth> => {
  const key = bearerKey(request);

  if (!key) {
    return McpAuthState.MissingKey();
  }

  await ensureDb();

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
      return McpAuthState.Rejected({
        code: verified.error?.code ?? "UNKNOWN",
      });
    }

    // A API key outlives the sessions `banUser` revokes, and the plugin's
    // verification never checks the owner's ban flag: the shared owner
    // predicate (lib/server/api-keys.server) reads it here so a ban really
    // does stop this account's machine credentials.
    return (await keyOwnerActive(owner))
      ? McpAuthState.Authed({ userId: owner })
      : McpAuthState.OwnerBanned();
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return McpAuthState.Misconfigured({ message: error.message });
    }

    throw error;
  }
};
