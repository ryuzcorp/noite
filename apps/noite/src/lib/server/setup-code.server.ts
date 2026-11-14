import { Data } from "effect";
import { eq, sql } from "void/db";

import { bootstrapSetupTable, userTable } from "../../db/schema";
import { controlBaseDomain } from "../control-env";
import { getDb, resolveEnv, withDb } from "../db";
import { errorLogText } from "../errors";
import { isLocalhostDomain } from "../local-host";

//! The first-admin setup code (audit N-3).
//!
//! On a fresh public install the hostname appears in certificate-transparency
//! logs, so whoever registers first must prove they are the operator. Two
//! cases, decided by `setupModeOf`:
//!
//! - `email`: `NOITE_ADMIN_EMAIL` is set — only that address may claim the
//!   bootstrap admin slot, and it must still present the one-time setup code
//!   (knowing the address alone never suffices — audit review on N-3).
//! - `code`: no anchor address — the first registration must present the
//!   one-time setup code the runner printed at boot. The control database
//!   holds only its SHA-256 hash, so a database reader can never recover it.
//!
//! Why the control database, not the runner's: first-run is detected here
//! (`count(*) FROM "user"`) and the `user.role` cell is the claim. The
//! exactly-one-admin claim and the single-use consume must arbitrate in the
//! same store (conditional UPDATE + re-read, the same pattern invites use),
//! and no cross-service transaction exists. `localhost`-family bases keep
//! today's behaviour (no code, first account wins) for dev and e2e.
//!
//! Row lifecycle (the singleton `id = 'setup'` row; absent = never issued):
//!
//! | state      | `consumedBy` | next               |
//! | ---------- | ------------ | ------------------ |
//! | `Pending`  | NULL         | `Consumed`, rotate |
//! | `Consumed` | user id      | rotate (reissue)   |
//!
//! Rotation replaces the row: the old code dies with its hash. The plaintext
//! exists once — at generation, when it is logged loudly and (over the
//! loopback runner-token route) handed to the operator — and never in any
//! browser-reachable response.

/** The singleton row id. The table holds at most this one row. */
const SETUP_ID = "setup";

/** Which proof the first registration must present. */
export type SetupMode = "off" | "email" | "code";

/** Pure constructor: no admin (or localhost) needs nothing, the anchor
 * reserves the slot by address, otherwise the setup code is required. The
 * base arrives as a plain string — never defaulted to localhost here: an
 * empty base (misconfigured deploy) fails closed to the strict modes. */
export const setupModeOf = (input: {
  adminEmail: string | null;
  adminExists: boolean;
  baseDomain: string;
}): SetupMode => {
  if (input.adminExists || isLocalhostDomain(input.baseDomain)) {
    return "off";
  }

  return input.adminEmail ? "email" : "code";
};

/** The anchored address, lowercased. Mirrors `lib/auth`'s
 * `resolveAdminEmail` without importing the auth plugin graph (which imports
 * this module). */
const resolveAnchorEmail = (): string | null =>
  resolveEnv().NOITE_ADMIN_EMAIL?.trim().toLowerCase() || null;

/** Unambiguous alphabet (no I/O/0/1), the same value invites use: 32 symbols
 * (5 bits each), 20 characters in four-char groups, so 2^100 codes — past the
 * 96-bit floor while still typable from a log line. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 5;
const GROUP_LEN = 4;

export const newSetupCode = (): string => {
  const bytes = new Uint8Array(CODE_GROUPS * GROUP_LEN);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];

  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let chars = "";

    for (let i = 0; i < GROUP_LEN; i += 1) {
      // `bytes` is a fixed-size Uint8Array just filled, so every index in
      // range yields a value; the modulo keeps it inside the alphabet.
      const offset = bytes[group * GROUP_LEN + i] ?? 0;
      chars += ALPHABET[offset % ALPHABET.length];
    }

    groups.push(chars);
  }

  return groups.join("-");
};

/** Normalise what an operator pasted: uppercase, ignore spaces/dashes/case. */
export const normalizeSetupCode = (raw: string): string => {
  const cleaned = raw.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");
  const groups: string[] = [];

  for (let i = 0; i < cleaned.length; i += GROUP_LEN) {
    groups.push(cleaned.slice(i, i + GROUP_LEN));
  }

  return groups.join("-");
};

/** SHA-256 hex of the normalised code: the only form ever stored. */
export const hashSetupCode = async (normalized: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** Compare two hex hashes with no early exit. */
const hashEquals = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < left.length; index += 1) {
    // oxlint-disable-next-line no-bitwise -- constant-time compare: accumulate every byte's difference
    diff |= (left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
  }

  return diff === 0;
};

interface SetupRow {
  codeHash: string;
  consumedAt: string | null;
  consumedBy: string | null;
}

/** The singleton row, if one was ever issued. */
const readSetupRow = (): Promise<SetupRow | null> =>
  withDb(async () => {
    const rows = await getDb()
      .select({
        codeHash: bootstrapSetupTable.codeHash,
        consumedAt: bootstrapSetupTable.consumedAt,
        consumedBy: bootstrapSetupTable.consumedBy,
      })
      .from(bootstrapSetupTable)
      .where(eq(bootstrapSetupTable.id, SETUP_ID))
      .limit(1);

    const [row] = rows;

    return row
      ? {
          codeHash: row.codeHash,
          consumedAt: row.consumedAt ?? null,
          consumedBy: row.consumedBy ?? null,
        }
      : null;
  });

/** Whether any account holds the admin role. */
export const hasAdmin = async (): Promise<boolean> => {
  const row = await withDb(() =>
    getDb().get<{ n: number }>(
      sql`SELECT count(*) AS n FROM "user" WHERE role = 'admin'`
    )
  );

  return Number(row?.n ?? 0) > 0;
};

/** The user/admin counts behind the signup policy, in one query. */
export const countUsersAndAdmins = (): Promise<{
  admins: number;
  users: number;
}> =>
  withDb(async () => {
    const row = await getDb().get<{ admins: number; users: number }>(
      sql`SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM "user" WHERE role = 'admin') AS admins`
    );

    return {
      admins: Number(row?.admins ?? 0),
      users: Number(row?.users ?? 0),
    };
  });

/** The bootstrap-relevant slice of the signup policy. */
export interface BootstrapPolicy {
  readonly adminExists: boolean;
  readonly setupMode: SetupMode;
}

export const bootstrapPolicy = async (): Promise<BootstrapPolicy> => {
  const { admins } = await countUsersAndAdmins();
  const adminExists = admins > 0;

  return {
    adminExists,
    setupMode: setupModeOf({
      adminEmail: resolveAnchorEmail(),
      adminExists,
      baseDomain: controlBaseDomain(),
    }),
  };
};

/** Loud banner for a fresh code: the fleet log ring (and dev console) is the
 * operator's copy until the runner prints it at boot. `console.error`, so it
 * is never mistaken for a request log line. */
const logSetupCode = (code: string, reason: "generated" | "rotated"): void => {
  const line =
    reason === "generated"
      ? "A one-time setup code was issued for this install's first admin."
      : "The setup code was replaced: the previous one no longer works.";

  console.error(
    [
      "[noite:setup] ============================================================",
      `[noite:setup] ${line}`,
      `[noite:setup] First-admin setup code: ${code}`,
      "[noite:setup] Whoever registers first must present it, and it works",
      "[noite:setup] once. Keep it private: anyone holding it owns the instance.",
      "[noite:setup] Lost it? Run this on the server for a fresh one:",
      "[noite:setup]   docker compose exec noite noite-runner setup-code",
      "[noite:setup] ============================================================",
    ].join("\n")
  );
};

export type SetupEnsure = Data.TaggedEnum<{
  Claimed: Record<never, never>;
  Generated: { readonly code: string };
  Pending: Record<never, never>;
}>;

export const SetupEnsured = Data.taggedEnum<SetupEnsure>();

/** Idempotent issue: at most one pending code exists. Concurrent issuers race
 * on `INSERT OR IGNORE`; the loser finds the winner's row and returns
 * `Pending` without ever seeing its own discarded plaintext. A consumed row
 * with no admin (a crash between claim and consume, or a deleted admin) is
 * replaced, since no valid code exists anymore. */
export const ensureSetupCode = async (): Promise<SetupEnsure> => {
  if (await hasAdmin()) {
    return SetupEnsured.Claimed();
  }

  const existing = await readSetupRow();

  if (existing && !existing.consumedBy) {
    return SetupEnsured.Pending();
  }

  const code = newSetupCode();
  const hash = await hashSetupCode(normalizeSetupCode(code));
  const now = new Date().toISOString();

  // Only a spent row is replaced: a concurrent issuer's pending row is
  // left alone, and the re-read below reports it.
  await (existing
    ? withDb(() =>
        getDb().run(
          sql`UPDATE bootstrap_setup SET codeHash = ${hash}, createdAt = ${now}, consumedAt = NULL, consumedBy = NULL WHERE id = ${SETUP_ID} AND consumedBy IS NOT NULL`
        )
      )
    : withDb(() =>
        getDb().run(
          sql`INSERT OR IGNORE INTO bootstrap_setup (id, codeHash, createdAt) VALUES (${SETUP_ID}, ${hash}, ${now})`
        )
      ));

  const row = await readSetupRow();

  if (row && !row.consumedBy && hashEquals(row.codeHash, hash)) {
    logSetupCode(code, existing ? "rotated" : "generated");

    return SetupEnsured.Generated({ code });
  }

  return SetupEnsured.Pending();
};

/** Operator reissue (`noite-runner setup-code`, the installer): a fresh code,
 * the old one dead. Refused once an admin exists — setup codes are
 * meaningless then. */
export const rotateSetupCode = async (): Promise<SetupEnsure> => {
  if (await hasAdmin()) {
    return SetupEnsured.Claimed();
  }

  const code = newSetupCode();
  const hash = await hashSetupCode(normalizeSetupCode(code));
  const now = new Date().toISOString();

  await withDb(() =>
    getDb().run(
      sql`INSERT OR REPLACE INTO bootstrap_setup (id, codeHash, createdAt, consumedAt, consumedBy) VALUES (${SETUP_ID}, ${hash}, ${now}, NULL, NULL)`
    )
  );
  logSetupCode(code, "rotated");

  return SetupEnsured.Generated({ code });
};

export type SetupProblem = "missing" | "invalid" | "used";

/** Reject an unusable code before an account is created. Unknown hashes read
 * as `invalid` even when a spent code exists, so guesses learn nothing. */
export const checkSetupCode = async (
  code: string | undefined
): Promise<SetupProblem | null> => {
  if (!code?.trim()) {
    return "missing";
  }

  const row = await readSetupRow();

  if (!row) {
    return "invalid";
  }

  const hash = await hashSetupCode(normalizeSetupCode(code));

  if (!hashEquals(hash, row.codeHash)) {
    return "invalid";
  }

  return row.consumedBy ? "used" : null;
};

/** Spend the code for an account. The `consumedBy IS NULL` guard is the
 * arbitration point: two simultaneous registrations presenting one code
 * cannot both win, and the caller re-reads to confirm it was the winner. */
export const consumeSetupCode = async (
  code: string,
  userId: string
): Promise<boolean> => {
  const hash = await hashSetupCode(normalizeSetupCode(code));

  await withDb(() =>
    getDb().run(
      sql`UPDATE bootstrap_setup SET consumedAt = ${new Date().toISOString()}, consumedBy = ${userId} WHERE id = ${SETUP_ID} AND codeHash = ${hash} AND consumedBy IS NULL`
    )
  );

  const row = await readSetupRow();

  return row?.consumedBy === userId;
};

/** Which account the bootstrap slot belongs to. `firstRun` is only a hint:
 * two concurrent first registrations both read an empty table, so the claim
 * below is what decides which of them owns the instance. */
export type BootstrapClaim = Data.TaggedEnum<{
  Claimed: Record<never, never>;
  Lost: Record<never, never>;
}>;

export const Bootstrap = Data.taggedEnum<BootstrapClaim>();

/** Claim the instance's bootstrap admin slot for `userId`.
 *
 * One conditional UPDATE: the role is only written while no other account
 * holds `admin`, so of two registrations that both saw no admin, exactly
 * one becomes the admin. With a `codeHash` the UPDATE additionally requires
 * that same hash to be still unconsumed in `bootstrap_setup` — one
 * statement, so a rotation between the proof check and the claim refuses
 * instead of admitting. The re-read reports which one this account is (an
 * account that a previous run already promoted also reads as `Claimed`).
 * No schema change: the `user.role` column is the claim's cell. */
export const claimBootstrapAdmin = (
  userId: string,
  codeHash?: string
): Promise<BootstrapClaim> =>
  withDb(async () => {
    const db = getDb();

    const claim =
      codeHash === undefined
        ? sql`
      UPDATE "user" SET role = 'admin'
       WHERE id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')
    `
        : sql`
      UPDATE "user" SET role = 'admin'
       WHERE id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')
         AND EXISTS (SELECT 1 FROM bootstrap_setup WHERE id = ${SETUP_ID} AND codeHash = ${codeHash} AND consumedBy IS NULL)
    `;

    await db.run(claim);

    const rows = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    return rows[0]?.role === "admin" ? Bootstrap.Claimed() : Bootstrap.Lost();
  });

export type FirstAdminOutcome = Data.TaggedEnum<{
  Admitted: Record<never, never>;
  Refused: { readonly reason: "reserved" | SetupProblem | "lost" };
}>;

export const FirstAdmin = Data.taggedEnum<FirstAdminOutcome>();

/** User-facing reason a first registration was refused. Shown verbatim. */
export const firstAdminProblemMessage = (
  reason: "reserved" | SetupProblem | "lost"
): string => {
  switch (reason) {
    case "reserved": {
      return "Only the instance's configured admin address may create the first account.";
    }

    case "missing": {
      return "This instance needs its one-time setup code to create the first account. Find it in the server logs.";
    }

    case "invalid": {
      return "That setup code is not valid. The server logs always show the current one.";
    }

    case "used": {
      return "That setup code has already been used. Run `noite-runner setup-code` on the server for a fresh one.";
    }

    default: {
      return "Another registration just claimed the admin account. This instance is now invite-only.";
    }
  }
};

/** Machine code for a bootstrap refusal (the panel reads the message). */
export const firstAdminErrorCode = (
  reason: "reserved" | SetupProblem | "lost"
): string => {
  switch (reason) {
    case "reserved": {
      return "ADMIN_EMAIL_RESERVED";
    }

    case "invalid": {
      return "SETUP_CODE_INVALID";
    }

    case "used": {
      return "SETUP_CODE_USED";
    }

    case "lost": {
      return "INVITE_REQUIRED";
    }

    default: {
      return "SETUP_CODE_REQUIRED";
    }
  }
};

/** The proof check before an account is created: strangers are refused
 * without leaving a user row behind. `email` is already trimmed and
 * lowercased, `policy` is the current signup policy. */
export const checkFirstAdminProof = async (
  email: string,
  setupCode: string | undefined,
  policy: BootstrapPolicy
): Promise<FirstAdminOutcome> => {
  if (policy.setupMode === "off") {
    return FirstAdmin.Admitted();
  }

  if (policy.setupMode === "email") {
    const anchor = resolveAnchorEmail();

    if (!anchor || email !== anchor) {
      return FirstAdmin.Refused({ reason: "reserved" });
    }
  }

  const problem = await checkSetupCode(setupCode);

  return problem
    ? FirstAdmin.Refused({ reason: problem })
    : FirstAdmin.Admitted();
};

/** The claim after the account is created: exactly one of two concurrent
 * first registrations wins the admin slot (the conditional UPDATE in
 * `claimBootstrapAdmin`), and the winner spends the setup code.
 *
 * The `codeHash` checked at proof time rides into the claim's UPDATE, so a
 * rotation between proof and claim refuses instead of admitting. Order
 * otherwise matters: the admin slot is claimed FIRST, the code spent after,
 * so a crash between them leaves an admin (bootstrap done, code inert)
 * rather than a spent code with no admin (bootstrap impossible). The claim
 * is the real single-use gate — reuse is impossible once an admin exists —
 * and the consume keeps the code's own lifecycle honest.
 *
 * `spendCode` is a seam for the consume-failure test; production passes
 * nothing and gets `consumeSetupCode`. */
export const claimFirstAdminSlot = async (
  userId: string,
  setupCode: string | undefined,
  policy: BootstrapPolicy,
  spendCode: (
    code: string,
    claimingUserId: string
  ) => Promise<boolean> = consumeSetupCode
): Promise<FirstAdminOutcome> => {
  const codeHash =
    policy.setupMode === "off"
      ? undefined
      : await hashSetupCode(normalizeSetupCode(setupCode ?? ""));

  const claim = await claimBootstrapAdmin(userId, codeHash);

  if (claim._tag === "Lost") {
    return FirstAdmin.Refused({
      reason: policy.setupMode === "off" ? "lost" : "used",
    });
  }

  if (policy.setupMode !== "off") {
    try {
      await spendCode(setupCode ?? "", userId);
    } catch (error) {
      // The claim already arbitrated and this account holds the only admin
      // slot, so admission stands: once an admin exists the code is inert.
      // Loud, so a real store fault still surfaces in the fleet log.
      console.warn(
        "[noite:setup] setup code consume failed after the admin claim; admission stands",
        errorLogText(error)
      );
    }
  }

  return FirstAdmin.Admitted();
};
