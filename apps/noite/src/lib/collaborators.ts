/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";

import { resolveAdminEmail, UnauthorizedError } from "./auth";
import { orm, withDb } from "./db";
import { parseAppRole, roleAtLeast } from "./roles";
import type { AppRole } from "./roles";
import { runnerGetApp, runnerGetAppBySlug, runnerListApps } from "./runner";
import type { RunnerApp } from "./runner";

export { parseAppRole, roleAtLeast } from "./roles";
export type { AppRole } from "./roles";

/** The runner is the single source of truth for apps; D1 keeps collaborator
 * grants only. `App` is that runner row — the UI never holds a second copy. */
export type App = RunnerApp;

/** Look up a live app by id or slug (one runner GET either way). Returns null
 * when the runner is down or the app does not exist; callers 401 either way. */
const findApp = async (
  key: { id: string } | { slug: string }
): Promise<RunnerApp | null> => {
  try {
    const app =
      "id" in key
        ? await runnerGetApp(key.id)
        : await runnerGetAppBySlug(key.slug);
    return app ?? null;
  } catch {
    return null;
  }
};

export const grantCollaborator = (
  appId: string,
  userId: string,
  role: AppRole
) =>
  Effect.gen(function* run() {
    const existing = yield* orm.app_collaborator.findFirst({
      where: { appId, userId },
    });
    if (existing) {
      if (existing.role !== role) {
        yield* orm.app_collaborator.update({
          data: { role },
          where: { id: existing.id },
        });
      }
      return;
    }
    yield* orm.app_collaborator.create({
      data: { appId, id: crypto.randomUUID(), role, userId },
    });
  });

/** Drop every grant and pending invitation for an app (the runner owns the
 * app row, so nothing else cascades it). Called after a successful runner
 * delete. */
export const dropAppCollaborators = (appId: string) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(`DELETE FROM app_collaborator WHERE appId = ?`, [appId]);
    yield* sql.unsafe(`DELETE FROM collaborator_invite WHERE appId = ?`, [
      appId,
    ]);
  });

/** One round trip for the whole access decision: the account's role/origin
 * anchor, and its collaborator row for this app. The gate runs on every page
 * load, so it stays a single `sql.unsafe` call — the builder path issues a
 * query per lookup, and under celld's D1 the second and later calls in one
 * action stall (the first answers immediately).
 *
 * `app_collaborator` has no foreign key to `app` any more (the runner owns the
 * app row), so this reads the grant table directly. */
interface AccessRow {
  anchored: number;
  collabRole: string | null;
  isAdmin: number;
}

const accessRow = (appId: string, userId: string, adminEmail: string | null) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe(
      `SELECT
         (SELECT CASE WHEN role = 'admin' THEN 1 ELSE 0 END FROM "user" WHERE id = ?) AS isAdmin,
         (SELECT CASE WHEN ? IS NOT NULL AND lower(email) = ? THEN 1 ELSE 0 END FROM "user" WHERE id = ?) AS anchored,
         (SELECT role FROM app_collaborator WHERE appId = ? AND userId = ?) AS collabRole`,
      [userId, adminEmail, adminEmail, userId, appId, userId]
    );
    // SAFETY: the projection is the three columns named above; D1 returns
    // plain rows.
    const [row] = rows as AccessRow[];
    return row ?? { anchored: 0, collabRole: null, isAdmin: 0 };
  });

/** Instance admins manage every app, collaborator or not. */
const roleFor = async (
  app: RunnerApp,
  userId: string
): Promise<AppRole | null> => {
  const anchored = resolveAdminEmail();
  const row = await withDb(accessRow(app.id, userId, anchored));
  if (row.isAdmin === 1 || row.anchored === 1) {
    return "admin";
  }
  // Grants are the only source of access below instance admin: the creator
  // gets an admin grant on create, and can be removed like anyone else (as
  // long as another admin remains).
  return row.collabRole ? parseAppRole(row.collabRole) : null;
};

const gate = async (
  app: RunnerApp | null,
  userId: string,
  need: AppRole
): Promise<{ app: RunnerApp; role: AppRole }> => {
  const role = app ? await roleFor(app, userId) : null;
  if (!(app && role && roleAtLeast(role, need))) {
    throw new UnauthorizedError({ message: "App not found" });
  }
  return { app, role };
};

export const requireAppRole = async (
  appId: string,
  userId: string,
  need: AppRole
): Promise<{ app: App; role: AppRole }> =>
  await gate(await findApp({ id: appId }), userId, need);

/** Instance-admin check for a signed-in account: the `admin` role, or an
 * address matching the `NOITE_ADMIN_EMAIL` anchor. One query, the same
 * role/anchor test `roleFor` applies — used where there is no app row to gate
 * on (the control D1 browser, whose pseudo app never reaches the runner). */
export const isInstanceAdmin = async (
  userId: string,
  email: string
): Promise<boolean> => {
  const anchored = resolveAdminEmail();
  const rows = await withDb(
    Effect.gen(function* run() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(
        `SELECT CASE WHEN role = 'admin' THEN 1 ELSE 0 END AS isAdmin,
                CASE WHEN ? IS NOT NULL AND lower(?) = ? THEN 1 ELSE 0 END AS anchored
           FROM "user" WHERE id = ?`,
        [anchored, email, anchored, userId]
      );
    })
  );
  // SAFETY: the projection is exactly those two integer columns; a missing
  // row yields undefined, handled below.
  const row = rows[0] as { anchored?: number; isAdmin?: number } | undefined;
  return row !== undefined && (row.isAdmin === 1 || row.anchored === 1);
};

/** Same gate as `requireAppRole`, resolved by app slug (Git HTTP auth). */
export const requireAppRoleBySlug = async (
  slug: string,
  userId: string,
  need: AppRole
): Promise<{ app: App; role: AppRole }> =>
  await gate(await findApp({ slug }), userId, need);

/** Apps the user can see (any collaborator role), newest first.
 * Instance admins see only their own apps here too — the global view lives on
 * the admin home's Apps tab (`listAllApps`). */
export const listAppsForCollaborator = async (
  userId: string
): Promise<RunnerApp[]> => {
  const [apps, grants] = await Promise.all([
    runnerListApps(),
    withDb(orm.app_collaborator.findMany({ where: { userId } })),
  ]);
  const granted = new Set(grants.map((grant) => grant.appId));
  return apps
    .filter((app) => granted.has(app.id))
    .toSorted(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
};

export const countAdmins = (appId: string) =>
  Effect.gen(function* run() {
    const rows = yield* orm.app_collaborator.findMany({
      where: { appId, role: "admin" },
    });
    return rows.length;
  });

export interface CollaboratorRow {
  createdAt: string;
  email: string;
  name: string;
  role: AppRole;
  userId: string;
}

interface CollaboratorSqlRow {
  createdAt: string | Date | null;
  email: string | null;
  name: string | null;
  role: string;
  userId: string;
}

/** Every grant on an app with the account behind it, in ONE query: under
 * celld's D1 the second and later queries in one action stall, so the old
 * per-collaborator user lookup could hang on any app with a few members. */
export const listCollaboratorRows = async (
  appId: string
): Promise<CollaboratorRow[]> => {
  const rows = await withDb(
    Effect.gen(function* run() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(
        `SELECT c.userId AS userId, c.role AS role, c.createdAt AS createdAt,
                u.email AS email, u.name AS name
           FROM app_collaborator c
           LEFT JOIN "user" u ON u.id = c.userId
          WHERE c.appId = ?
          ORDER BY u.email`,
        [appId]
      );
    })
  );
  // SAFETY: the projection is the five columns named above; D1 returns plain rows.
  const found = rows as CollaboratorSqlRow[];
  const out: CollaboratorRow[] = [];
  for (const row of found) {
    const role = parseAppRole(row.role);
    if (!role) {
      continue;
    }
    out.push({
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt ?? ""),
      email: row.email ?? "",
      name: row.name ?? "",
      role,
      userId: row.userId,
    });
  }
  return out;
};

// ---- Pending invitations ----
//
// Inviting an email never creates access by itself: it records an invitation
// the invitee accepts (or declines) after signing in with that address. The
// inviter learns nothing about whether the address has an account, and an
// invitee who registers later finds it waiting.

/** Emails are matched lowercased and trimmed on both sides. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export interface PendingInvite {
  appId: string;
  appName: string;
  createdAt: string;
  email: string;
  id: string;
  role: AppRole;
}

interface PendingInviteSqlRow {
  appId: string;
  appName: string;
  createdAt: string | Date | null;
  email: string;
  id: string;
  role: string;
}

const asPendingInvites = (rows: PendingInviteSqlRow[]): PendingInvite[] => {
  const out: PendingInvite[] = [];
  for (const row of rows) {
    const role = parseAppRole(row.role);
    if (!role) {
      continue;
    }
    out.push({
      appId: row.appId,
      appName: row.appName,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt ?? ""),
      email: row.email,
      id: row.id,
      role,
    });
  }
  return out;
};

const PENDING_COLUMNS = "id, appId, appName, email, role, createdAt";

/** SELECT the invitation columns with a caller-supplied WHERE/ORDER tail. */
const selectPendingInvites = async (
  tail: string,
  params: string[]
): Promise<PendingInvite[]> => {
  const rows = await withDb(
    Effect.gen(function* run() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(
        `SELECT ${PENDING_COLUMNS} FROM collaborator_invite ${tail}`,
        params
      );
    })
  );
  // SAFETY: the projection is PENDING_COLUMNS, i.e. exactly PendingInviteSqlRow; D1 returns plain rows.
  return asPendingInvites(rows as PendingInviteSqlRow[]);
};

/** Record (or re-role) the invitation for one email on one app. */
export const upsertPendingInvite = (invite: {
  appId: string;
  appName: string;
  email: string;
  invitedBy: string;
  role: AppRole;
}) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO collaborator_invite (id, appId, appName, email, role, invitedBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (appId, email) DO UPDATE SET
         role = excluded.role,
         appName = excluded.appName,
         invitedBy = excluded.invitedBy`,
      [
        crypto.randomUUID(),
        invite.appId,
        invite.appName,
        normalizeEmail(invite.email),
        invite.role,
        invite.invitedBy,
        new Date().toISOString(),
      ]
    );
  });

/** Invitations waiting on one app (admin view). */
export const listPendingInvites = (appId: string): Promise<PendingInvite[]> =>
  selectPendingInvites("WHERE appId = ? ORDER BY email", [appId]);

/** Invitations addressed to one email, newest first (the invitee's view). */
export const listInvitesForEmail = (email: string): Promise<PendingInvite[]> =>
  selectPendingInvites("WHERE email = ? ORDER BY createdAt DESC", [
    normalizeEmail(email),
  ]);

/** Withdraw an invitation from the app side. */
export const revokePendingInvite = (appId: string, inviteId: string) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `DELETE FROM collaborator_invite WHERE id = ? AND appId = ?`,
      [inviteId, appId]
    );
  });

/** Accept an invitation addressed to `email`: grant the role, then consume
 * the invitation. Returns the app it was for, or null when no such invitation
 * exists for that address (so an id alone never grants access). If the
 * account already holds a grant, the invitation's role replaces it: it is the
 * newest word from an admin. */
export const acceptPendingInvite = async (
  inviteId: string,
  email: string,
  userId: string
): Promise<{ appId: string } | null> => {
  const [invite] = await selectPendingInvites("WHERE id = ? AND email = ?", [
    inviteId,
    normalizeEmail(email),
  ]);
  if (!invite) {
    return null;
  }
  await withDb(
    Effect.gen(function* run() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        `INSERT INTO app_collaborator (id, appId, userId, role, createdAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (appId, userId) DO UPDATE SET role = excluded.role`,
        [
          crypto.randomUUID(),
          invite.appId,
          userId,
          invite.role,
          new Date().toISOString(),
        ]
      );
      yield* sql.unsafe(`DELETE FROM collaborator_invite WHERE id = ?`, [
        invite.id,
      ]);
    })
  );
  return { appId: invite.appId };
};

/** Decline: delete the invitation, but only one addressed to `email`. */
export const declinePendingInvite = (inviteId: string, email: string) =>
  Effect.gen(function* run() {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `DELETE FROM collaborator_invite WHERE id = ? AND email = ?`,
      [inviteId, normalizeEmail(email)]
    );
  });
