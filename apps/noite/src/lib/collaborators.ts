import { and, asc, desc, eq, sql } from "void/db";

import { appCollaboratorTable, collaboratorInviteTable } from "../db/schema";
import { resolveAdminEmail, UnauthorizedError } from "./auth";
import { getDb, withDb } from "./db";
import { parseAppRole, roleAtLeast } from "./roles";
import type { AppRole } from "./roles";
import { runnerGetApp, runnerGetAppBySlug, runnerListApps } from "./runner";
import type { RunnerApp } from "./runner";

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
): Promise<void> =>
  withDb(async () => {
    const db = getDb();

    const existing = await db
      .select({ id: appCollaboratorTable.id, role: appCollaboratorTable.role })
      .from(appCollaboratorTable)
      .where(
        and(
          eq(appCollaboratorTable.appId, appId),
          eq(appCollaboratorTable.userId, userId)
        )
      )
      .limit(1);

    const [found] = existing;

    if (found) {
      if (found.role !== role) {
        await db
          .update(appCollaboratorTable)
          .set({ role })
          .where(eq(appCollaboratorTable.id, found.id));
      }

      return;
    }

    await db.insert(appCollaboratorTable).values({
      appId,
      id: crypto.randomUUID(),
      role,
      userId,
    });
  });

/** Drop every grant and pending invitation for an app (the runner owns the
 * app row, so nothing else cascades it). Called after a successful runner
 * delete. */
export const dropAppCollaborators = (appId: string): Promise<void> =>
  withDb(async () => {
    const db = getDb();

    await db.batch([
      db
        .delete(appCollaboratorTable)
        .where(eq(appCollaboratorTable.appId, appId)),
      db
        .delete(collaboratorInviteTable)
        .where(eq(collaboratorInviteTable.appId, appId)),
    ]);
  });

/** One round trip for the whole access decision: the account's role/origin
 * anchor, and its collaborator row for this app. The gate runs on every page
 * load, so it stays a single statement — one dispatch beats N. */
interface AccessRow {
  anchored: number;
  collabRole: string | null;
  isAdmin: number;
}

const accessRow = (appId: string, userId: string, adminEmail: string | null) =>
  withDb(async () => {
    const rows = await getDb().all<AccessRow>(sql`
      SELECT
        (SELECT CASE WHEN role = 'admin' THEN 1 ELSE 0 END FROM "user" WHERE id = ${userId}) AS isAdmin,
        (SELECT CASE WHEN ${adminEmail} IS NOT NULL AND lower(email) = ${adminEmail} THEN 1 ELSE 0 END FROM "user" WHERE id = ${userId}) AS anchored,
        (SELECT role FROM app_collaborator WHERE appId = ${appId} AND userId = ${userId}) AS collabRole
    `);

    return rows[0] ?? { anchored: 0, collabRole: null, isAdmin: 0 };
  });

/** Instance admins manage every app, collaborator or not. */
const roleFor = async (
  app: RunnerApp,
  userId: string
): Promise<AppRole | null> => {
  const anchored = resolveAdminEmail();
  const row = await accessRow(app.id, userId, anchored);

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

  const rows = await withDb(() =>
    getDb().all<{ anchored: number; isAdmin: number }>(sql`
      SELECT CASE WHEN role = 'admin' THEN 1 ELSE 0 END AS isAdmin,
             CASE WHEN ${anchored} IS NOT NULL AND lower(${email}) = ${anchored} THEN 1 ELSE 0 END AS anchored
        FROM "user" WHERE id = ${userId}
    `)
  );

  const [row] = rows;

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
    withDb(() =>
      getDb()
        .select({ appId: appCollaboratorTable.appId })
        .from(appCollaboratorTable)
        .where(eq(appCollaboratorTable.userId, userId))
    ),
  ]);

  const granted = new Set(grants.map((grant) => grant.appId));

  // A create whose runner RPC outlived the control plane's bound lands after
  // the caller gave up, so its grant below never ran: the row exists, has no
  // grant at all, and is invisible (and undeletable) to everyone. Revoking a
  // creator always leaves another admin on the app, so "no grants anywhere"
  // is unambiguous evidence of the lost grant, never a revocation: heal it
  // for the creator. Revoked creators keep their other admins and are not
  // re-granted here.
  for (const app of apps) {
    if (app.userId !== userId || granted.has(app.id)) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- one candidate at a time; only a grantless app is written
    const any = await withDb(() =>
      getDb()
        .select({ id: appCollaboratorTable.id })
        .from(appCollaboratorTable)
        .where(eq(appCollaboratorTable.appId, app.id))
        .limit(1)
    );

    if (!any[0]) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the write follows this app's read
        await grantCollaborator(app.id, userId, "admin");
      } catch (error) {
        // The page and its SSE stream can heal the same app at once; the
        // unique (appId, userId) row means the loser reads the winner's.
        // oxlint-disable-next-line eslint/no-await-in-loop -- one conflict check for this app
        const raced = await withDb(() =>
          getDb()
            .select({ id: appCollaboratorTable.id })
            .from(appCollaboratorTable)
            .where(
              and(
                eq(appCollaboratorTable.appId, app.id),
                eq(appCollaboratorTable.userId, userId)
              )
            )
            .limit(1)
        );

        if (!raced[0]) {
          throw error;
        }
      }

      granted.add(app.id);
    }
  }

  return apps
    .filter((app) => granted.has(app.id))
    .toSorted(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
};

export const countAdmins = (appId: string): Promise<number> =>
  withDb(async () => {
    const rows = await getDb()
      .select({ id: appCollaboratorTable.id })
      .from(appCollaboratorTable)
      .where(
        and(
          eq(appCollaboratorTable.appId, appId),
          eq(appCollaboratorTable.role, "admin")
        )
      );

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

/** Every grant on an app with the account behind it, in ONE query: one
 * dispatch beats a per-collaborator user lookup on any app with members. */
export const listCollaboratorRows = async (
  appId: string
): Promise<CollaboratorRow[]> => {
  const rows = await withDb(() =>
    getDb().all<CollaboratorSqlRow>(sql`
      SELECT c.userId AS userId, c.role AS role, c.createdAt AS createdAt,
             u.email AS email, u.name AS name
        FROM app_collaborator c
        LEFT JOIN "user" u ON u.id = c.userId
       WHERE c.appId = ${appId}
       ORDER BY u.email
    `)
  );

  const out: CollaboratorRow[] = [];

  for (const row of rows) {
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

/** Invitations waiting on one app (admin view). */
export const listPendingInvites = (appId: string): Promise<PendingInvite[]> =>
  withDb(async () =>
    asPendingInvites(
      await getDb()
        .select()
        .from(collaboratorInviteTable)
        .where(eq(collaboratorInviteTable.appId, appId))
        .orderBy(asc(collaboratorInviteTable.email))
    )
  );

/** Invitations addressed to one email, newest first (the invitee's view). */
export const listInvitesForEmail = (email: string): Promise<PendingInvite[]> =>
  withDb(async () =>
    asPendingInvites(
      await getDb()
        .select()
        .from(collaboratorInviteTable)
        .where(eq(collaboratorInviteTable.email, normalizeEmail(email)))
        .orderBy(desc(collaboratorInviteTable.createdAt))
    )
  );

/** Record (or re-role) the invitation for one email on one app. */
export const upsertPendingInvite = (invite: {
  appId: string;
  appName: string;
  email: string;
  invitedBy: string;
  role: AppRole;
}): Promise<void> =>
  withDb(async () => {
    const db = getDb();

    await db
      .insert(collaboratorInviteTable)
      .values({
        appId: invite.appId,
        appName: invite.appName,
        createdAt: new Date().toISOString(),
        email: normalizeEmail(invite.email),
        id: crypto.randomUUID(),
        invitedBy: invite.invitedBy,
        role: invite.role,
      })
      .onConflictDoUpdate({
        set: {
          appName: invite.appName,
          invitedBy: invite.invitedBy,
          role: invite.role,
        },
        target: [collaboratorInviteTable.appId, collaboratorInviteTable.email],
      });
  });

/** Withdraw an invitation from the app side. */
export const revokePendingInvite = (
  appId: string,
  inviteId: string
): Promise<void> =>
  withDb(async () => {
    await getDb()
      .delete(collaboratorInviteTable)
      .where(
        and(
          eq(collaboratorInviteTable.id, inviteId),
          eq(collaboratorInviteTable.appId, appId)
        )
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
  const target = normalizeEmail(email);

  const invite = await withDb(async () => {
    const rows = await getDb()
      .select()
      .from(collaboratorInviteTable)
      .where(
        and(
          eq(collaboratorInviteTable.id, inviteId),
          eq(collaboratorInviteTable.email, target)
        )
      )
      .limit(1);

    return rows[0] ?? null;
  });

  if (!invite) {
    return null;
  }

  await withDb(async () => {
    const db = getDb();

    await db.batch([
      db
        .insert(appCollaboratorTable)
        .values({
          appId: invite.appId,
          createdAt: new Date().toISOString(),
          id: crypto.randomUUID(),
          role: invite.role,
          userId,
        })
        .onConflictDoUpdate({
          set: { role: invite.role },
          target: [appCollaboratorTable.appId, appCollaboratorTable.userId],
        }),
      db
        .delete(collaboratorInviteTable)
        .where(eq(collaboratorInviteTable.id, invite.id)),
    ]);
  });

  return { appId: invite.appId };
};

/** Decline: delete the invitation, but only one addressed to `email`. */
export const declinePendingInvite = (
  inviteId: string,
  email: string
): Promise<void> =>
  withDb(async () => {
    await getDb()
      .delete(collaboratorInviteTable)
      .where(
        and(
          eq(collaboratorInviteTable.id, inviteId),
          eq(collaboratorInviteTable.email, normalizeEmail(email))
        )
      );
  });
