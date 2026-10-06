/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";

import { withDb } from "../db";

/** Lifetime of a recovery code, as configured on the emailOTP plugin. */
export const RECOVERY_CODE_TTL_SECONDS = 600;

/** The account a recovery code is minted for: the one named, or (no name) the
 * oldest admin, which is the instance owner. Banned accounts never qualify.
 * `undefined` when there is none. */
export const findRecoveryEmail = (
  requested: string | undefined
): Promise<string | undefined> =>
  withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const email = requested?.trim().toLowerCase();
      const rows = email
        ? yield* sql<{ email: string }>`
            SELECT email FROM "user"
            WHERE lower(email) = ${email} AND banned = 0 LIMIT 1`
        : yield* sql<{ email: string }>`
            SELECT email FROM "user"
            WHERE role = 'admin' AND banned = 0
            ORDER BY createdAt LIMIT 1`;
      return rows[0]?.email;
    })
  );
