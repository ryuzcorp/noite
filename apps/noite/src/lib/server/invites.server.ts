import { Data } from "effect";
import { eq, sql } from "void/db";

import { inviteTable, userTable } from "../../db/schema";
import type { InviteLifecycleWire } from "../api-types";
import { getDb, withDb } from "../db";

/** Share-able codes every new account receives once it has redeemed one. */
export const INVITES_PER_USER = 2;

/** Unambiguous alphabet (no I/O/0/1), 12 characters in four-char groups:
 * 32^12 ≈ 2^60 possible codes, short enough to paste into a chat. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const GROUP_LEN = 4;

export const newInviteCode = (): string => {
  const bytes = new Uint8Array(CODE_GROUPS * GROUP_LEN);
  crypto.getRandomValues(bytes);
  const groups: string[] = [];

  for (let group = 0; group < CODE_GROUPS; group += 1) {
    let chars = "";

    for (let i = 0; i < GROUP_LEN; i += 1) {
      // `bytes` is a fixed-size Uint8Array we just filled, so every index in
      // range yields a value; the modulo keeps it inside the alphabet.
      const offset = bytes[group * GROUP_LEN + i] ?? 0;
      chars += ALPHABET[offset % ALPHABET.length];
    }

    groups.push(chars);
  }

  return groups.join("-");
};

/** Normalise what a user pasted: uppercase, ignore spaces/dashes/case. */
export const normalizeInviteCode = (raw: string): string => {
  const cleaned = raw.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");
  const groups: string[] = [];

  for (let i = 0; i < cleaned.length; i += GROUP_LEN) {
    groups.push(cleaned.slice(i, i + GROUP_LEN));
  }

  return groups.join("-");
};

/** Public signup policy: the very first account bootstraps the instance, so
 * it needs no code; every later one does. `firstRun` is a fast read, not an
 * arbitration point — the bootstrap claim (`claimBootstrapAdmin`) is. */
export const signupPolicy = async (): Promise<{
  firstRun: boolean;
  invitesPerUser: number;
  requiresInvite: boolean;
}> => {
  const first = await withDb(() =>
    getDb().get<{ n: number }>(sql`SELECT count(*) AS n FROM "user"`)
  );

  const firstRun = Number(first?.n ?? 0) === 0;

  return {
    firstRun,
    invitesPerUser: INVITES_PER_USER,
    requiresInvite: !firstRun,
  };
};

// ---- The invite-code lifecycle ----
//
// One code, one state, derived from the row's columns by `inviteLifecycle`
// (the only constructor). `Used` wins over `Revoked`: a spent code can never
// become reusable, whatever an operator toggles afterwards.
//
// | state       | `revoked` | `usedBy` | minted by   | next states |
// | ----------- | --------- | -------- | ----------- | ----------- |
// | `Available` | 0         | NULL     | `mintInvites` | `Used`, `Revoked` |
// | `Used`      | any       | user id  | consumption | terminal |
// | `Revoked`   | 1         | NULL     | revoke      | terminal |
//
// The transitions are conditional writes (`consumeInvite` claims with
// `usedBy IS NULL AND revoked = 0`; `revokeInvite` updates with
// `usedBy IS NULL`) and each re-reads its row to confirm which state it
// landed in, so two callers racing on one code cannot both win.

/** One code's state. `Used.by` is the redeemer's id (the account may since
 * have been deleted — the code stays spent). */
export type InviteLifecycle = Data.TaggedEnum<{
  Available: Record<never, never>;
  Revoked: Record<never, never>;
  Used: { readonly at: string; readonly by: string };
}>;

export const InviteState = Data.taggedEnum<InviteLifecycle>();

export const inviteWire = (state: InviteLifecycle): InviteLifecycleWire =>
  // SAFETY: `_tag` is one of the three union tags, and their lowercase forms
  // are exactly the wire values ("available", "revoked", "used").
  state._tag.toLowerCase() as InviteLifecycleWire;

/** The one constructor: DB columns in, closed state out. */
export const inviteLifecycle = (row: {
  revoked: boolean;
  usedAt: string | null;
  usedBy: string | null;
}): InviteLifecycle => {
  if (row.usedBy !== null) {
    return InviteState.Used({ at: row.usedAt ?? "", by: row.usedBy });
  }

  return row.revoked ? InviteState.Revoked() : InviteState.Available();
};

interface InviteRow {
  id: string;
  revoked: boolean;
  usedAt: string | null;
  usedBy: string | null;
}

/** One code's row, without consuming it. */
const lookup = (code: string): Promise<InviteRow | null> =>
  withDb(async () => {
    const rows = await getDb()
      .select({
        id: inviteTable.id,
        revoked: inviteTable.revoked,
        usedAt: inviteTable.usedAt,
        usedBy: inviteTable.usedBy,
      })
      .from(inviteTable)
      .where(eq(inviteTable.code, normalizeInviteCode(code)))
      .limit(1);

    const [row] = rows;

    return row
      ? {
          id: row.id,
          revoked: Boolean(row.revoked),
          usedAt: row.usedAt ?? null,
          usedBy: row.usedBy ?? null,
        }
      : null;
  });

export type InviteProblem = "missing" | "unknown" | "revoked" | "used";

/** Reject an unusable code before an account is created, so a bad or missing
 * invite never reaches `createUser`. */
export const checkInvite = async (
  code: string | undefined
): Promise<InviteProblem | null> => {
  if (!code?.trim()) {
    return "missing";
  }

  const row = await lookup(code);

  if (!row) {
    return "unknown";
  }

  switch (inviteLifecycle(row)._tag) {
    case "Used": {
      return "used";
    }

    case "Revoked": {
      return "revoked";
    }

    default: {
      return null;
    }
  }
};

/** Claim a code for an account. The `usedBy IS NULL` guard in the UPDATE is
 * the arbitration point: two simultaneous registrations with one code cannot
 * both win, and the caller re-reads to confirm it was the winner. */
export const consumeInvite = async (
  code: string,
  userId: string
): Promise<boolean> => {
  const normalized = normalizeInviteCode(code);
  await withDb(() =>
    getDb()
      .update(inviteTable)
      .set({ usedAt: new Date().toISOString(), usedBy: userId })
      .where(
        sql`${inviteTable.code} = ${normalized} AND ${inviteTable.usedBy} IS NULL AND ${inviteTable.revoked} = 0`
      )
  );
  const row = await lookup(normalized);

  return row?.usedBy === userId;
};

/** Mint codes owned by `userId` (the admin panel mints more; registration
 * mints the new account's share). */
export const mintInvites = async (
  userId: string,
  count: number,
  note?: string
): Promise<string[]> => {
  const codes = Array.from({ length: Math.max(1, count) }, () =>
    newInviteCode()
  );

  await withDb(async () => {
    const db = getDb();

    await db.insert(inviteTable).values(
      codes.map((code) => ({
        code,
        createdAt: new Date().toISOString(),
        createdBy: userId,
        id: crypto.randomUUID(),
        note: note ?? null,
        revoked: false,
      }))
    );
  });

  return codes;
};

/** The codes one account can still hand out, oldest first. This is the user's
 * own share (`INVITES_PER_USER` on registration) — the account page shows it,
 * so an invitee can pass one on without admin rights. */
export const listUnusedInvitesFor = (
  userId: string
): Promise<{ code: string; id: string }[]> =>
  withDb(async () => {
    const rows = await getDb()
      .select({ code: inviteTable.code, id: inviteTable.id })
      .from(inviteTable)
      .where(
        sql`${inviteTable.createdBy} = ${userId} AND ${inviteTable.usedBy} IS NULL AND ${inviteTable.revoked} = 0`
      )
      .orderBy(inviteTable.createdAt);

    return rows.map((row) => ({ code: row.code, id: row.id }));
  });

/** What a revoke actually did. A spent code is history: the transition is
 * refused instead of silently answering "revoked". */
export type RevokeOutcome = Data.TaggedEnum<{
  Refused: { readonly reason: "missing" | "used" };
  Revoked: Record<never, never>;
}>;

export const RevokeResult = Data.taggedEnum<RevokeOutcome>();

/** Available -> Revoked. Conditional on `usedBy IS NULL`; the re-read names
 * the state the row is actually in, so the caller can report it. */
export const revokeInvite = async (id: string): Promise<RevokeOutcome> => {
  await withDb(() =>
    getDb()
      .update(inviteTable)
      .set({ revoked: true })
      .where(sql`${inviteTable.id} = ${id} AND ${inviteTable.usedBy} IS NULL`)
  );

  const rows = await withDb(() =>
    getDb()
      .select({
        revoked: inviteTable.revoked,
        usedAt: inviteTable.usedAt,
        usedBy: inviteTable.usedBy,
      })
      .from(inviteTable)
      .where(eq(inviteTable.id, id))
      .limit(1)
  );

  const [row] = rows;

  if (!row) {
    return RevokeResult.Refused({ reason: "missing" });
  }

  return inviteLifecycle({
    revoked: Boolean(row.revoked),
    usedAt: row.usedAt ?? null,
    usedBy: row.usedBy ?? null,
  })._tag === "Revoked"
    ? RevokeResult.Revoked()
    : RevokeResult.Refused({ reason: "used" });
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
 * holds `admin`, so of two registrations that both saw `firstRun`, exactly
 * one becomes the admin. The re-read reports which one this account is (an
 * account that a previous run already promoted also reads as `Claimed`).
 * No schema change: the `user.role` column is the claim's cell. */
export const claimBootstrapAdmin = (userId: string): Promise<BootstrapClaim> =>
  withDb(async () => {
    const db = getDb();

    await db.run(sql`
      UPDATE "user" SET role = 'admin'
       WHERE id = ${userId}
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE role = 'admin')
    `);

    const rows = await db
      .select({ role: userTable.role })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    return rows[0]?.role === "admin" ? Bootstrap.Claimed() : Bootstrap.Lost();
  });

export interface InviteView {
  code: string;
  createdAt: string;
  createdByEmail: string;
  id: string;
  revoked: boolean;
  /** The derived state — the only field the UI branches on. */
  state: InviteLifecycleWire;
  /** The redeemer's email, or "" when the code is unused or the account was
   * deleted since (read `state` to tell those apart). */
  usedByEmail: string;
  usedAt: string;
}

interface InviteJoinRow {
  code: string;
  createdAt: string | Date | null;
  createdByEmail: string | null;
  id: string;
  revoked: number | boolean;
  usedAt: string | Date | null;
  usedBy: string | null;
  usedByEmail: string | null;
}

const asIso = (value: string | Date | null): string =>
  value instanceof Date ? value.toISOString() : String(value ?? "");

/** Every code with the emails on both ends (admin panel). */
export const listInvites = async (): Promise<InviteView[]> => {
  const rows = await withDb(() =>
    getDb().all<InviteJoinRow>(sql`
      SELECT i.id, i.code, i.createdBy, i.usedBy, i.usedAt, i.revoked, i.note, i.createdAt,
             c.email AS createdByEmail, u.email AS usedByEmail
        FROM invite i
        LEFT JOIN "user" c ON c.id = i.createdBy
        LEFT JOIN "user" u ON u.id = i.usedBy
       ORDER BY i.createdAt DESC
       LIMIT 500
    `)
  );

  return rows.map((row) => ({
    code: row.code,
    createdAt: asIso(row.createdAt),
    createdByEmail: row.createdByEmail ?? "(deleted account)",
    id: row.id,
    revoked: Boolean(row.revoked),
    state: inviteWire(
      inviteLifecycle({
        revoked: Boolean(row.revoked),
        usedAt: asIso(row.usedAt) || null,
        usedBy: row.usedBy,
      })
    ),
    usedAt: asIso(row.usedAt),
    usedByEmail: row.usedByEmail ?? "",
  }));
};
