import { sql } from "void/db";

import { getDb, withDb } from "../db";

/** Lifetime of a recovery code, as configured on the emailOTP plugin. */
export const RECOVERY_CODE_TTL_SECONDS = 600;

/** The account a recovery code is minted for: the one named, or (no name) the
 * oldest admin, which is the instance owner. Banned accounts never qualify.
 * `undefined` when there is none. */
export const findRecoveryEmail = (
  requested: string | undefined
): Promise<string | undefined> =>
  withDb(() => {
    const db = getDb();
    const email = requested?.trim().toLowerCase();

    if (email) {
      return db
        .get<{ email: string }>(sql`
          SELECT email FROM "user"
          WHERE lower(email) = ${email} AND banned = 0 LIMIT 1`)
        .then((row) => row?.email);
    }

    return db
      .get<{ email: string }>(sql`
        SELECT email FROM "user"
        WHERE role = 'admin' AND banned = 0
        ORDER BY createdAt LIMIT 1`)
      .then((row) => row?.email);
  });
