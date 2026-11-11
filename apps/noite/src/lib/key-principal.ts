//! What one API key may do, as one value: the app set it is limited to, the
//! role ceiling it may reach, and the instant it stops working.
//!
//! A profile API key is a machine identity for an agent. It acts *as its
//! owner*, so the owner's role is the first half of every decision; the key
//! narrows it:
//!
//! | key field            | absent (every pre-scope key)   | present                        |
//! | -------------------- | ------------------------------ | ------------------------------ |
//! | `appIds`             | account-wide                   | only these app ids             |
//! | `roleCeiling`        | `admin` (no narrowing)         | effective role is the lower    |
//! | `expiresAt`          | never                          | refused once the instant passes |
//!
//! The effective role is `min(the owner's role on that app, the ceiling)`, and
//! a ceiling never grants a role the owner does not hold: the owner's role is
//! always re-resolved per request, so a collaborator removed (or an app
//! transferred) after the key was minted loses access immediately.
//!
//! App restriction is by **id**, checked on the app row the lookup actually
//! resolved — never on the string the caller typed. A slug is only an input:
//! resolving `slug` first and then checking the resolved `id` means a renamed
//! app keeps its restriction, a deleted app is gone, and a key scoped to app A
//! cannot reach app B by naming B's slug (or by naming an id that belongs to a
//! different app than the slug resolved to).
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Expired: now is past expiresAt
//!   [*] --> OutsideScope: app is not in appIds
//!   [*] --> NoAccess: the owner has no role on the app
//!   [*] --> Insufficient: min(owner role, ceiling) is below `need`
//!   [*] --> Granted: the effective role satisfies `need`
//! ```
//!
//! `Expired` is checked by the transport too (better-auth refuses an expired
//! key before a principal exists); it stays here so the one enforcement
//! function is total over the principal and so a principal minted by another
//! path cannot outlive its key.
import { Data } from "effect";
import * as Schema from "effect/Schema";

import { roleAtLeast } from "./roles";
import type { AppRole } from "./roles";

/** The app ids a key may act on; `null` is account-wide. */
export type KeyApps = readonly string[] | null;

/** How far one key may reach: where, and how high. */
export interface KeyScope {
  readonly appIds: KeyApps;
  readonly roleCeiling: AppRole;
}

/** One authenticated key, as every key-authenticated path sees it. Carries no
 * secret: the key is verified before this is built, and never travels again. */
export interface KeyPrincipal {
  /** When the key stops working; `null` is "never" (the default). */
  readonly expiresAt: Date | null;
  readonly keyId: string;
  /** The label the owner gave the key ("ci", "nightly-agent"); shown in the
   * "via key" attribution and may be empty on a legacy row. */
  readonly keyName: string;
  readonly scope: KeyScope;
  readonly userId: string;
}

/** The one account-wide scope: every app, no ceiling. What a key with no
 * metadata means, so a pre-scope key keeps working unchanged. */
export const ACCOUNT_WIDE: KeyScope = { appIds: null, roleCeiling: "admin" };

/** The role ceilings a key may be minted with, widest first. */
export const ROLE_CEILINGS: readonly AppRole[] = ["admin", "push", "view"];

/** The expiry presets the create form offers, in seconds; `null` is "never".
 * The server accepts only these, so a client cannot mint a key that outlives
 * the presets. */
export const EXPIRY_PRESETS = {
  "1d": 86_400,
  "1h": 3600,
  "30d": 2_592_000,
  "7d": 604_800,
  never: null,
} as const satisfies Record<string, number | null>;

export type ExpiryPreset = keyof typeof EXPIRY_PRESETS;

/** Whether a form value names one of the presets. */
export const isExpiryPreset = (value: string): value is ExpiryPreset =>
  Object.hasOwn(EXPIRY_PRESETS, value);

/** What reading one key's metadata produced. `Malformed` is a key whose scope
 * cannot be read (a hand-written metadata row, or a future shape this build
 * does not know): it is refused everywhere rather than treated as
 * account-wide. */
export type KeyScopeRead = Data.TaggedEnum<{
  Account: Record<never, never>;
  Malformed: Record<never, never>;
  Scoped: KeyScope;
}>;

export const KeyScopeReads = Data.taggedEnum<KeyScopeRead>();

/** The scope fields this build writes into a key's `metadata` (stored as JSON
 * by better-auth's api-key plugin). Unknown fields are dropped, so metadata a
 * newer build wrote still parses. */
const KeyMetadata = Schema.Struct({
  appIds: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String.check(Schema.isNonEmpty())))
  ),
  roleCeiling: Schema.optional(
    Schema.NullOr(Schema.Literals(["view", "push", "admin"]))
  ),
});

/** Read the scope out of a key's `metadata` column. `null`/`undefined` (every
 * key minted before scopes existed) is account-wide; anything that does not
 * match {@link KeyMetadata} is `Malformed` — refused, never treated as
 * account-wide. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this IS the boundary parser for the api-key plugin's JSON metadata column; the schema below is what turns it into a domain value
export const parseKeyScope = (metadata: unknown): KeyScopeRead => {
  if (metadata === null || metadata === undefined) {
    return KeyScopeReads.Account();
  }

  const decoded = Schema.decodeUnknownResult(KeyMetadata)(metadata);

  if (decoded._tag === "Failure") {
    return KeyScopeReads.Malformed();
  }

  const { appIds } = decoded.success;

  // An empty list is ambiguous ("no apps" or "not set"). Refuse it instead of
  // guessing a meaning that could widen or silently strand a key.
  if (appIds !== undefined && appIds !== null && appIds.length === 0) {
    return KeyScopeReads.Malformed();
  }

  return KeyScopeReads.Scoped({
    appIds:
      appIds === undefined || appIds === null ? null : [...new Set(appIds)],
    roleCeiling: decoded.success.roleCeiling ?? "admin",
  });
};

/** The scope a readable key has. `Malformed` has none: it is refused before
 * this is called. */
export const keyScopeOf = (read: KeyScopeRead): KeyScope => {
  switch (read._tag) {
    case "Account": {
      return ACCOUNT_WIDE;
    }

    case "Scoped": {
      return { appIds: read.appIds, roleCeiling: read.roleCeiling };
    }

    case "Malformed": {
      throw new Error("a malformed key scope has no scope");
    }

    default: {
      throw new Error("unknown key scope state");
    }
  }
};

/** Whether the key may act on this app id at all. */
export const keyCoversApp = (scope: KeyScope, appId: string): boolean =>
  scope.appIds === null || scope.appIds.includes(appId);

/** The lowest of the owner's role and the key's ceiling. */
export const effectiveRole = (
  accountRole: AppRole,
  ceiling: AppRole
): AppRole => (roleAtLeast(accountRole, ceiling) ? ceiling : accountRole);

/** Whether the key's own expiry has passed at `now`. */
export const keyExpired = (principal: KeyPrincipal, now: Date): boolean =>
  principal.expiresAt !== null &&
  principal.expiresAt.getTime() <= now.getTime();

/** One app's verdict for one key, as one value every key-authenticated path
 * branches on. */
export type KeyAccess = Data.TaggedEnum<{
  /** Allowed, with the effective role (never above the ceiling). */
  Granted: { readonly role: AppRole };
  Expired: Record<never, never>;
  /** The app is outside the key's app set. */
  OutsideScope: Record<never, never>;
  /** The owner holds no role on the app. */
  NoAccess: Record<never, never>;
  /** The role this app requires is above the ceiling (or the owner's role). */
  Insufficient: { readonly role: AppRole };
}>;

export const KeyAccesses = Data.taggedEnum<KeyAccess>();

export interface KeyAccessInput {
  /** The owner's role on `appId`, re-resolved for this request; `null` when
   * the app does not exist or the owner holds no grant. */
  readonly accountRole: AppRole | null;
  readonly appId: string;
  readonly need: AppRole;
  readonly now: Date;
  readonly principal: KeyPrincipal;
}

/** The one enforcement transition: expiry, then the app set, then the role
 * ceiling, then the role the path needs. */
export const decideKeyAccess = (input: KeyAccessInput): KeyAccess => {
  const { accountRole, appId, need, now, principal } = input;

  if (keyExpired(principal, now)) {
    return KeyAccesses.Expired();
  }

  if (!keyCoversApp(principal.scope, appId)) {
    return KeyAccesses.OutsideScope();
  }

  if (accountRole === null) {
    return KeyAccesses.NoAccess();
  }

  const role = effectiveRole(accountRole, principal.scope.roleCeiling);

  if (!roleAtLeast(role, need)) {
    return KeyAccesses.Insufficient({ role });
  }

  return KeyAccesses.Granted({ role });
};

/** "%s via key %s": how a key's actions are attributed in commit authors,
 * pull-request authors and deploy rows, so a bot's work is visible as one. */
export const attributor = (displayName: string, keyName: string): string => {
  const owner = displayName.trim() === "" ? "Noite user" : displayName.trim();
  const key = keyName.trim();

  return key === "" ? owner : `${owner} via key ${key}`;
};
