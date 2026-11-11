//! One API key in, one principal out — the only place a key is verified.
//!
//! Every key-authenticated surface (`/mcp`, the runner's git smart-HTTP auth,
//! event ingest, and any route that later accepts a key) calls
//! {@link authenticateKey} and then enforces the principal's scope through
//! `lib/server/key-access.server`. Nothing else parses `verifyApiKey`'s reply,
//! so a new surface cannot forget the ban check, the scope read or the expiry.
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> MissingKey: no credential presented
//!   [*] --> Rejected: verifyApiKey refused (wrong key, wrong scope)
//!   [*] --> Expired: the key's own expiresAt has passed
//!   [*] --> Rejected: metadata does not describe a scope
//!   [*] --> OwnerBanned: the owner is banned or has no row
//!   [*] --> Misconfigured: BETTER_AUTH_SECRET missing
//!   [*] --> Authed: principal { user, key, scope, expiry }
//! ```
//!
//! `Rejected.code` keeps the plugin's own reason (`KEY_NOT_FOUND` covers an
//! unknown key *and* a key without the scope the surface asked for — the
//! plugin deliberately does not tell them apart), so the log names what
//! happened while the wire keeps one uniform body. `Expired` is separate
//! because the caller holds the key: telling it the credential is past its
//! expiry is useful, not an oracle.
import { Data } from "effect";

import { authFromEnv, MissingAuthSecretError } from "../auth";
import { ensureDb } from "../db";
import { keyScopeOf, parseKeyScope } from "../key-principal";
import type { KeyPrincipal } from "../key-principal";
import { keyOwnerActive } from "./api-keys.server";

/** The permission sets a surface asks the key to carry (better-auth's
 * `resource: [actions]` map). The plugin checks the key's own permissions
 * against these before the principal exists. */
export type KeyNeeds = Record<string, string[]>;

/** The credential state behind one key-authenticated request. */
export type KeyAuth = Data.TaggedEnum<{
  Authed: { readonly principal: KeyPrincipal };
  /** No credential at all. */
  MissingKey: Record<never, never>;
  /** The key was presented and refused. `code` is the plugin's reason;
   * `KEY_NOT_FOUND` means unknown key *or* missing scope. */
  Rejected: { readonly code: string };
  /** The key exists but its `expiresAt` has passed (the plugin refuses and
   * deletes it; we name it so the caller reads why). */
  Expired: Record<never, never>;
  /** The key is valid but its owner is banned: a ban must revoke machine
   * credentials too, or "Ban" would leave `/mcp` (and git push) working. */
  OwnerBanned: Record<never, never>;
  /** The worker has no auth secret: a deployment fault, not a caller's. */
  Misconfigured: { readonly message: string };
}>;

export const KeyAuthState = Data.taggedEnum<KeyAuth>();

/** The key in an `Authorization: Bearer …` header, or null. */
export const bearerKey = (request: Request): string | null => {
  const header = request.headers.get("authorization") ?? "";

  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const key = header.slice("bearer ".length).trim();

  return key === "" ? null : key;
};

/** A date column from the adapter (a `Date`, an ISO string, or absent). */
const asDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** The one authentication transition for a key-authenticated surface: verify
 * the key against `needs`, read its scope, refuse an expired or banned one,
 * and answer the principal the surface acts as. `origin` is the auth base the
 * worker was configured with (the request's origin is the fallback). */
export const authenticateKey = async (
  request: Request,
  env: KitEnv,
  key: string | null,
  needs: KeyNeeds
): Promise<KeyAuth> => {
  if (!key) {
    return KeyAuthState.MissingKey();
  }

  await ensureDb();

  try {
    const auth = authFromEnv(
      env,
      env.BETTER_AUTH_URL ?? new URL(request.url).origin
    );

    const verified = await auth.api.verifyApiKey({
      body: { key, permissions: needs },
    });

    const verifiedKey = verified.valid ? verified.key : null;

    if (!verifiedKey) {
      return verified.error?.code === "KEY_EXPIRED"
        ? KeyAuthState.Expired()
        : KeyAuthState.Rejected({
            code: verified.error?.code ?? "UNKNOWN",
          });
    }

    // A present-but-unreadable expiry must refuse, not read as "never": the
    // plugin's own comparison (`Date.now() > new Date(NaN)`) is false, so a
    // corrupt row would otherwise be a perpetual key.
    const expiresAt = asDate(verifiedKey.expiresAt);

    if (
      expiresAt === null &&
      verifiedKey.expiresAt !== null &&
      verifiedKey.expiresAt !== undefined
    ) {
      return KeyAuthState.Rejected({ code: "KEY_EXPIRY_INVALID" });
    }

    // A key whose metadata cannot be read is refused instead of being treated
    // as account-wide: a scope we cannot parse must not widen the credential.
    const read = parseKeyScope(verifiedKey.metadata);

    if (read._tag === "Malformed") {
      return KeyAuthState.Rejected({ code: "KEY_SCOPE_INVALID" });
    }

    // An API key outlives the sessions `banUser` revokes, and the plugin's
    // verification never checks the owner's ban flag: the shared owner
    // predicate (lib/server/api-keys.server) reads it here so a ban really
    // does stop this account's machine credentials.
    if (!(await keyOwnerActive(verifiedKey.referenceId))) {
      return KeyAuthState.OwnerBanned();
    }

    return KeyAuthState.Authed({
      principal: {
        expiresAt,
        keyId: verifiedKey.id,
        keyName: verifiedKey.name?.trim() ?? "",
        scope: keyScopeOf(read),
        userId: verifiedKey.referenceId,
      },
    });
  } catch (error) {
    if (error instanceof MissingAuthSecretError) {
      return KeyAuthState.Misconfigured({ message: error.message });
    }

    throw error;
  }
};
