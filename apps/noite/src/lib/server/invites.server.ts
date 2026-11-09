import { eq, sql } from "void/db";

import { inviteTable } from "../../db/schema";
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
 * it needs no code; every later one does. */
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

interface InviteState {
  id: string;
  revoked: boolean;
  usedBy: string | null;
}

/** The code's state, without consuming it: one query for everything the
 * gate and the claim need. */
const lookup = (code: string): Promise<InviteState | null> =>
  withDb(async () => {
    const rows = await getDb()
      .select({
        id: inviteTable.id,
        revoked: inviteTable.revoked,
        usedBy: inviteTable.usedBy,
      })
      .from(inviteTable)
      .where(eq(inviteTable.code, normalizeInviteCode(code)))
      .limit(1);

    const [row] = rows;

    return row
      ? { id: row.id, revoked: Boolean(row.revoked), usedBy: row.usedBy }
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

  if (row.usedBy) {
    return "used";
  }

  return row.revoked ? "revoked" : null;
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

export const revokeInvite = async (id: string): Promise<void> => {
  await withDb(() =>
    getDb()
      .update(inviteTable)
      .set({ revoked: true })
      .where(sql`${inviteTable.id} = ${id} AND ${inviteTable.usedBy} IS NULL`)
  );
};

export interface InviteView {
  code: string;
  createdAt: string;
  createdByEmail: string;
  id: string;
  revoked: boolean;
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
    usedAt: asIso(row.usedAt),
    usedByEmail: row.usedByEmail ?? "",
  }));
};
