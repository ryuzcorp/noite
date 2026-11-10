//! The one owner check every profile-API-key consumer reads, plus the key
//! revocation a ban performs.
//!
//! Better Auth's `verifyApiKey` never looks at the owner's ban flag, and a key
//! outlives the sessions the admin plugin's `banUser` deletes. So a banned
//! account would keep `git push`, event ingest, and `/mcp` working unless the
//! consumers ask this module. States for one key's owner:
//!
//! | state      | how it is reached                              | consumers |
//! | ---------- | ---------------------------------------------- | --------- |
//! | `Active`   | `user.banned` is false (or the column is null) | serve the request |
//! | `Banned`   | `user.banned` is true                          | refuse   |
//! | `Missing`  | no `user` row for the key's `referenceId`      | refuse   |
//!
//! `banUser` (admin plugin) also calls `revokeApiKeysForUser` from its
//! `databaseHooks.user.update.after` hook, so the keys are deleted in the same
//! flow and an unban cannot resurrect them: revoked stays revoked. The
//! `Banned` check stays as defence in depth for a ban that landed but whose
//! revocation did not, and for environments where the hook was not run.
import { eq } from "void/db";

import { apikeyTable, userTable } from "../../db/schema";
import { getDb, withDb } from "../db";

/** Whether an API key's owner may still act. A missing row counts as banned:
 * never serve a credential whose owner cannot be established. */
export const keyOwnerActive = (userId: string): Promise<boolean> =>
  withDb(async () => {
    const rows = await getDb()
      .select({ banned: userTable.banned })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    const [row] = rows;

    return row !== undefined && row.banned !== true;
  });

/** Delete every API key owned by an account. Called when the account is
 * banned. Unban never recreates a key: the user mints a new one. */
export const revokeApiKeysForUser = (userId: string): Promise<void> =>
  withDb(async () => {
    await getDb()
      .delete(apikeyTable)
      .where(eq(apikeyTable.referenceId, userId));
  });
