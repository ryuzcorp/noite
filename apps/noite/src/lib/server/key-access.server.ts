//! One key's verdict on one app: the one function every key-authenticated
//! path calls before it acts.
//!
//! `authenticateKey` (lib/server/key-auth.server) answers *who* the key is;
//! this answers *what it may do here*. The app is resolved first (slug or id,
//! as the calling surface names it), then `decideKeyAccess` applies the key's
//! expiry, its app set and its role ceiling to the owner's role on that app
//! row — which is re-resolved per request, so a collaborator removed, an app
//! transferred or a role lowered after the key was minted takes effect
//! immediately.
//!
//! The app set is checked against the resolved **app id**, never the string
//! the caller typed: a key scoped to app A cannot reach app B by naming B's
//! slug, an id and a slug can never disagree about which app was resolved,
//! and a renamed app stays covered because the id does not change.
//!
//! `NoAccess` deliberately covers both "no such app" and "the owner holds no
//! role": callers answer one uniform refusal, so a key is never an existence
//! oracle for apps it cannot see.
import { Data } from "effect";

import { resolveAppRole } from "../collaborators";
import { decideKeyAccess, keyExpired } from "../key-principal";
import type { KeyAccess, KeyPrincipal } from "../key-principal";
import type { AppRole } from "../roles";
import type { RunnerApp } from "../runner";

/** What one key may do with one app. */
export type KeyAppVerdict = Data.TaggedEnum<{
  Granted: { readonly app: RunnerApp; readonly role: AppRole };
  /** The key's own expiry passed (defence in depth: `authenticateKey` refuses
   * it first). */
  Expired: Record<never, never>;
  /** No such app, or the owner holds no role on it — one uniform refusal. */
  NoAccess: Record<never, never>;
  /** The app exists, but not for this key. Also answered uniformly. */
  OutsideScope: Record<never, never>;
  /** `role` is the effective role; it is below what this path needs. */
  BelowCeiling: { readonly role: AppRole };
}>;

export const KeyAppVerdicts = Data.taggedEnum<KeyAppVerdict>();

const verdictOf = (access: KeyAccess, app: RunnerApp): KeyAppVerdict => {
  switch (access._tag) {
    case "Granted": {
      return KeyAppVerdicts.Granted({ app, role: access.role });
    }

    case "Expired": {
      return KeyAppVerdicts.Expired();
    }

    case "OutsideScope": {
      return KeyAppVerdicts.OutsideScope();
    }

    case "NoAccess": {
      return KeyAppVerdicts.NoAccess();
    }

    case "Insufficient": {
      return KeyAppVerdicts.BelowCeiling({ role: access.role });
    }

    default: {
      throw new Error("unknown key access state");
    }
  }
};

/** Resolve one app reference for one key and enforce the key's scope, expiry
 * and role ceiling. `need` is the role the calling surface requires. */
export const keyAppVerdict = async (
  principal: KeyPrincipal,
  ref: { id: string } | { slug: string },
  need: AppRole,
  now: Date = new Date()
): Promise<KeyAppVerdict> => {
  // Checked before the app lookup, so an expired key never reaches the runner.
  if (keyExpired(principal, now)) {
    return KeyAppVerdicts.Expired();
  }

  const found = await resolveAppRole(ref, principal.userId);

  if (!found) {
    return KeyAppVerdicts.NoAccess();
  }

  return verdictOf(
    decideKeyAccess({
      accountRole: found.role,
      appId: found.app.id,
      need,
      now,
      principal,
    }),
    found.app
  );
};
