import * as Effect from "effect/Effect";

import { isUserAdminById, UnauthorizedError } from "./auth";
import { orm, withDb } from "./db";
import type { App } from "./db";
import { parseAppRole, roleAtLeast } from "./roles";
import type { AppRole } from "./roles";
import { runnerGetApp } from "./runner";

export { parseAppRole, roleAtLeast } from "./roles";
export type { AppRole } from "./roles";

const asApp = (row: App): App => ({
  ...row,
  internalPort: row.internalPort ?? null,
  lastDeploySha: row.lastDeploySha ?? null,
  lastError: row.lastError ?? null,
  listenPort: row.listenPort ?? null,
});

/** Overlay live runner state onto a D1 app row (runner may be briefly
 * down — then the local row stands). Single implementation backing both
 * the detail header and the SSE list so they can never disagree. */
export const withLiveRunner = async (local: App): Promise<App> => {
  try {
    const remote = await runnerGetApp(local.id);
    return asApp({
      ...local,
      desiredState: remote.desiredState,
      fleetBucket: remote.fleetBucket,
      internalPort: remote.internalPort,
      lastDeploySha: remote.lastDeploySha,
      lastError: remote.lastError,
      listenPort: remote.listenPort,
      status: remote.status,
      subdomain: remote.subdomain,
    });
  } catch {
    /* runner may be briefly down */
    return asApp(local);
  }
};

/** Ensure the app creator has an admin membership row (legacy apps). */
export const ensureOwnerAdmin = (app: App) =>
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

const membershipFor = (appId: string, userId: string) =>
  Effect.gen(function* run() {
    const app = yield* orm.app.findFirst({ where: { id: appId } });
    if (
      !app ||
      app.desiredState === "deleted" ||
      app.status === "deleting" ||
      app.status === "gone"
    ) {
      return null;
    }
    yield* ensureOwnerAdmin(app);
    // Instance admins manage every app, collaborator or not.
    if (yield* isUserAdminById(userId)) {
      // SAFETY: instance admins are granted the top app role; roleAtLeast("admin", need) holds for every need.
      return { app: asApp(app), membership: null, role: "admin" as AppRole };
    }
    let membership = yield* orm.app_collaborator.findFirst({
      where: { appId, userId },
    });
    // Creator fallback if row race lost.
    if (!membership && app.userId === userId) {
      membership = yield* ensureOwnerAdmin(app);
    }
    if (!membership) {
      return null;
    }
    const role = parseAppRole(membership.role);
    if (!role) {
      return null;
    }
    return { app: asApp(app), membership, role };
  });

export const requireAppRole = async (
  appId: string,
  userId: string,
  need: AppRole
): Promise<{ app: App; role: AppRole }> => {
  const access = await withDb(membershipFor(appId, userId));
  if (!access || !roleAtLeast(access.role, need)) {
    throw new UnauthorizedError({ message: "App not found" });
  }
  return { app: access.app, role: access.role };
};

const membershipForSlug = (slug: string, userId: string) =>
  Effect.gen(function* run() {
    const app = yield* orm.app.findFirst({ where: { slug } });
    if (!app) {
      return null;
    }
    return yield* membershipFor(app.id, userId);
  });

/** Same gate as `requireAppRole`, resolved by app slug (Git HTTP auth). */
export const requireAppRoleBySlug = async (
  slug: string,
  userId: string,
  need: AppRole
): Promise<{ app: App; role: AppRole }> => {
  const access = await withDb(membershipForSlug(slug, userId));
  if (!access || !roleAtLeast(access.role, need)) {
    throw new UnauthorizedError({ message: "App not found" });
  }
  return { app: access.app, role: access.role };
};

/** Apps the user can see (any collaborator role), newest first.
 * Admins see only their own apps here too — the global view lives
 * in god-mode (`listAllApps`). */
export const listAppsForCollaborator = (userId: string) =>
  Effect.gen(function* run() {
    // Backfill owner→admin for apps this user created.
    const owned = yield* orm.app.findMany({ where: { userId } });
    for (const app of owned) {
      yield* ensureOwnerAdmin(app);
    }
    const memberships = yield* orm.app_collaborator.findMany({
      where: { userId },
    });
    const apps: App[] = [];
    const seen = new Set<string>();
    for (const m of memberships) {
      if (seen.has(m.appId)) {
        continue;
      }
      seen.add(m.appId);
      const app = yield* orm.app.findFirst({ where: { id: m.appId } });
      if (!app) {
        continue;
      }
      if (
        app.desiredState === "deleted" ||
        app.status === "deleting" ||
        app.status === "gone"
      ) {
        continue;
      }
      apps.push(asApp(app));
    }
    apps.sort((a, b) => {
      const at = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
      const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
      return bt - at;
    });
    return apps;
  });

export const countAdmins = (appId: string) =>
  Effect.gen(function* run() {
    const rows = yield* orm.app_collaborator.findMany({
      where: { appId, role: "admin" },
    });
    return rows.length;
  });
