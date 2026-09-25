/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

import { withDb } from "./db";

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

interface CountRow {
  n: number;
}

interface InviteRow {
  code: string;
  createdBy: string;
  createdAt: string | Date | null;
  id: string;
  note: string | null;
  revoked: number | boolean;
  usedAt: string | Date | null;
  usedBy: string | null;
}

/** Public signup policy: the very first account bootstraps the instance, so
 * it needs no code; every later one does. */
export const signupPolicy = async (): Promise<{
  firstRun: boolean;
  invitesPerUser: number;
  requiresInvite: boolean;
}> => {
  const rows = await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(`SELECT count(*) AS n FROM "user"`);
    })
  );
  // SAFETY: the query selects a single `n` count; D1 returns plain rows.
  const [first] = rows as CountRow[];
  const count = first?.n ?? 0;
  const firstRun = Number(count) === 0;
  return {
    firstRun,
    invitesPerUser: INVITES_PER_USER,
    requiresInvite: !firstRun,
  };
};

/** The code's state, without consuming it. */
const lookup = async (
  code: string
): Promise<{ id: string; usedBy: string | null } | null> =>
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe(
        `SELECT id, usedBy FROM invite WHERE code = ?`,
        [normalizeInviteCode(code)]
      );
      // SAFETY: the projection is (id, usedBy); D1 returns plain rows.
      const [row] = rows as InviteRow[];
      return row ? { id: row.id, usedBy: row.usedBy } : null;
    })
  );

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
  const revoked = await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe(
        `SELECT revoked FROM invite WHERE code = ?`,
        [normalizeInviteCode(code)]
      );
      // SAFETY: the projection is (revoked); D1 returns plain rows.
      const [entry] = rows as InviteRow[];
      return entry?.revoked ?? 0;
    })
  );
  return revoked ? "revoked" : null;
};

/** Claim a code for an account. The `usedBy IS NULL` guard in the UPDATE is
 * the arbitration point: two simultaneous registrations with one code cannot
 * both win, and the caller re-reads to confirm it was the winner. */
export const consumeInvite = async (
  code: string,
  userId: string
): Promise<boolean> => {
  const normalized = normalizeInviteCode(code);
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        `UPDATE invite SET usedBy = ?, usedAt = ? WHERE code = ? AND usedBy IS NULL AND revoked = 0`,
        [userId, new Date().toISOString(), normalized]
      );
    })
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
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const code of codes) {
        yield* sql.unsafe(
          `INSERT INTO invite (id, code, createdBy, note, revoked, createdAt) VALUES (?, ?, ?, ?, 0, ?)`,
          [
            crypto.randomUUID(),
            code,
            userId,
            note ?? null,
            new Date().toISOString(),
          ]
        );
      }
    })
  );
  return codes;
};

/** The codes one account can still hand out, oldest first. This is the user's
 * own share (`INVITES_PER_USER` on registration) — the profile page shows it,
 * so an invitee can pass one on without admin rights. */
export const listUnusedInvitesFor = async (
  userId: string
): Promise<{ code: string; id: string }[]> => {
  const rows = await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(
        `SELECT id, code FROM invite WHERE createdBy = ? AND usedBy IS NULL AND revoked = 0 ORDER BY createdAt`,
        [userId]
      );
    })
  );
  // SAFETY: the projection is (id, code); D1 returns plain rows.
  const found = rows as InviteRow[];
  return found.map((row) => ({ code: row.code, id: row.id }));
};

export const revokeInvite = async (id: string): Promise<void> => {
  await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      // Only an unused code can be revoked; a redeemed one is history.
      yield* sql.unsafe(
        `UPDATE invite SET revoked = 1 WHERE id = ? AND usedBy IS NULL`,
        [id]
      );
    })
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

interface InviteJoinRow extends InviteRow {
  createdByEmail: string | null;
  usedByEmail: string | null;
}

const asIso = (value: string | Date | null): string =>
  value instanceof Date ? value.toISOString() : String(value ?? "");

/** Every code with the emails on both ends (admin panel). */
export const listInvites = async (): Promise<InviteView[]> => {
  const rows = await withDb(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(
        `SELECT i.id, i.code, i.createdBy, i.usedBy, i.usedAt, i.revoked, i.note, i.createdAt,
                c.email AS createdByEmail, u.email AS usedByEmail
           FROM invite i
           LEFT JOIN "user" c ON c.id = i.createdBy
           LEFT JOIN "user" u ON u.id = i.usedBy
          ORDER BY i.createdAt DESC
          LIMIT 500`
      );
    })
  );
  // SAFETY: the projection mirrors InviteJoinRow; D1 returns plain rows.
  const found = rows as InviteJoinRow[];
  return found.map((row) => ({
    code: row.code,
    createdAt: asIso(row.createdAt),
    createdByEmail: row.createdByEmail ?? "(deleted account)",
    id: row.id,
    revoked: Boolean(row.revoked),
    usedAt: asIso(row.usedAt),
    usedByEmail: row.usedByEmail ?? "",
  }));
};
