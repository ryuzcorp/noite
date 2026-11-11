//! How a key-authenticated action is attributed: the actor a commit or a
//! deploy row records, naming the key behind it.
//!
//! Bot actions must stay visible as bot actions. The runner's `Actor` is
//! `{ userId, name }` and its commit identity writes `name` as both author and
//! committer (`host/git_identity.rs`), so a key's actor spells the key out:
//! `"Ada via key ci"`. The build tag `userId` keeps the account link the UI
//! already resolves, and a key with no name (or an account with no display
//! name) degrades to the plain account name instead of a dangling "via".
import { sql } from "void/db";

import { getDb, withDb } from "../db";
import { attributor } from "../key-principal";
import type { KeyPrincipal } from "../key-principal";

/** The account's display name, for attribution. An absent account (or an
 * empty name) becomes the platform default. */
export const userDisplayName = async (userId: string): Promise<string> => {
  const row = await withDb(() =>
    getDb().get<{ name: string | null }>(sql`
      SELECT name FROM "user" WHERE id = ${userId} LIMIT 1`)
  );

  return row?.name?.trim() ?? "";
};

/** The actor one key-authenticated write is attributed to: the shape
 * `SourceCommitBody.actor` and the runner's commit identity take. */
export const keyActor = async (
  principal: KeyPrincipal
): Promise<{ readonly userId: string; readonly name: string }> => ({
  name: attributor(await userDisplayName(principal.userId), principal.keyName),
  userId: principal.userId,
});
