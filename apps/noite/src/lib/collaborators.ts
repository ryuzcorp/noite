/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

import { resolveAdminEmail, UnauthorizedError } from "./auth";
import { orm, withDb } from "./db";
import { parseAppRole, roleAtLeast } from "./roles";
import type { AppRole } from "./roles";
import { runnerGetApp, runnerListApps } from "./runner";
import type { RunnerApp } from "./runner";

export { parseAppRole, roleAtLeast } from "./roles";
export type { AppRole } from "./roles";

/** The runner is the single source of truth for apps; D1 keeps collaborator
 * grants only. `App` is that runner row — the UI never holds a second copy. */
export type App = RunnerApp;

/** Soft-delete tombstones the runner still keeps: never show or gate on them. */
const live = (app: RunnerApp): boolean =>
  app.desiredState !== "deleted" &&
  app.status !== "deleting" &&
  app.status !== "gone";

/** Look up a live app by id (runner GET) or slug (runner list). Returns null
 * when the runner is down or the app does not exist; callers 401 either way. */
const findApp = async (
  key: { id: string } | { slug: string }
): Promise<RunnerApp | null> => {
  try {
    if ("id" in key) {
      const app = await runnerGetApp(key.id);
      return app && live(app) ? app : null;
    }
    const apps = await runnerListApps();
    return apps.find((app) => app.slug === key.slug && live(app)) ?? null;
  } catch {
    return null;
  }
};

/** Ensure the app creator has an admin grant (apps created before grants
 * existed, or a lost row). */
export const ensureOwnerAdmin = (app: RunnerApp) =>
  Effect.gen(function* run() {
    const existing = yield* orm.app_collaborator.findFirst({
      where: { appId: app.id, userId: app.userId },
    });
    if (existing) {
      return existing;
    }
    return yield* orm.app_collaborator.create({
      data: {
        appId: app.id,
        id: crypto.randomUUID(),
        role: "admin",
        userId: app.userId,
      },
    });
  });

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

/** Drop every grant for an app (the runner owns the app row, so nothing else
 * cascades it). Called after a successful runner delete. */
export const dropAppCollaborators = (appId: string) =>
  Effect.gen(function* run() {
    yield* orm.app_collaborator.delete({ where: { appId } });
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
  const role = row.collabRole ? parseAppRole(row.collabRole) : null;
  if (role) {
    return role;
  }
  // Creator fallback if the grant row was lost.
  if (app.userId === userId) {
    await withDb(ensureOwnerAdmin(app));
    return "admin";
  }
  return null;
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

/** Same gate as `requireAppRole`, resolved by app slug (Git HTTP auth). */
export const requireAppRoleBySlug = async (
  slug: string,
  userId: string,
  need: AppRole
): Promise<{ app: App; role: AppRole }> =>
  await gate(await findApp({ slug }), userId, need);

/** Apps the user can see (creator or any collaborator role), newest first.
 * Instance admins see only their own apps here too — the global view lives in
 * god-mode (`listAllApps`). */
export const listAppsForCollaborator = async (
  userId: string
): Promise<RunnerApp[]> => {
  const [apps, grants] = await Promise.all([
    runnerListApps(),
    withDb(orm.app_collaborator.findMany({ where: { userId } })),
  ]);
  const granted = new Set(grants.map((grant) => grant.appId));
  return apps
    .filter(
      (app) => live(app) && (app.userId === userId || granted.has(app.id))
    )
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
