/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";

import type { AdminAppRow, AdminUserRow } from "../api-types";
import {
  authFromEnv,
  failUnknown,
  resolveAdminEmail,
  UnauthorizedError,
} from "../auth";
import { dropAppCollaborators } from "../collaborators";
import { withDb } from "../db";
import {
  runnerControlFleet,
  runnerDeleteApp,
  runnerListApps,
  runnerPatchApp,
} from "../runner";
import type { RunnerApp } from "../runner";
import { apiAction, apiActionNoInput, fail } from "./api";
import { listInvites, mintInvites, revokeInvite } from "./invites.server";
import { getSessionOrNull } from "./session.server";

/** Explicit user-row shape (mirrors the paranorm `user` table). Written
 * out instead of `Selectable<DB["user"]>`, whose instantiation blows up
 * tsc's depth budget (TS2589). */
interface DbUser {
  banned: boolean | null;
  createdAt: Date | string | null;
  email: string;
  id: string;
  name: string | null;
  role: string | null;
}

/** Promote the env-anchored address to `admin` (idempotent, no-op if unset
 * or the user does not exist yet — they register first via passkeys). */
const ensureAdminAccount = (email: string | null) =>
  Effect.gen(function* run() {
    if (!email) {
      return;
    }

    const found = yield* Effect.gen(function* () {
      const sql = yield* SqlClient;

      return yield* sql.unsafe(
        `SELECT id, email, name, banned, role, createdAt FROM "user" WHERE "email" = ?`,
        [email]
      );
    });

    // SAFETY: the column list mirrors DbUser and D1 returns plain row
    // objects; the paranorm builder for this table exceeds tsc's depth
    // budget, so raw SQL stays shallow in every config.
    const existing = (found[0] ?? null) as DbUser | null;

    if (!existing || existing.role === "admin") {
      return;
    }

    const sql = yield* SqlClient;
    yield* sql.unsafe(`UPDATE "user" SET "role" = 'admin' WHERE "id" = ?`, [
      existing.id,
    ]);
  });

interface AdminSession {
  email: string;
  id: string;
  isAdmin: boolean;
}

/** Gate for every admin action: `admin` role, or the env-anchored address
 * (promoted on the way in so the role persists afterwards), and never an
 * impersonated session — the admin home is hidden while impersonating, and
 * the actions behind it refuse too. Returns null instead of failing so
 * `adminOverview` can probe for the panel; a denying caller turns it into a
 * client-visible `fail("Admin only")`. An infra failure is logged and reads
 * as denial, never as the generic "Internal error". */
const requireAdmin = async (
  request: Request,
  env: KitEnv
): Promise<AdminSession | null> => {
  try {
    const session = await getSessionOrNull(request, env);
    const user = session?.user;

    if (!session || !user?.email || !user.id || session.impersonatedBy) {
      return null;
    }

    // SAFETY: the admin plugin augments the session user with an optional role string; allowlist known roles.
    const roleField = (user as { role?: unknown }).role;
    const role = roleField === "admin" ? "admin" : "user";
    const email = user.email.trim().toLowerCase();
    const anchored = resolveAdminEmail();

    if (anchored && email === anchored) {
      await withDb(ensureAdminAccount(anchored));

      return { email, id: user.id, isAdmin: true };
    }

    if (role !== "admin") {
      return null;
    }

    return { email, id: user.id, isAdmin: true };
  } catch (error) {
    console.error(
      "[requireAdmin]",
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    );

    return null;
  }
};

const adminAuth = (request: Request, env: KitEnv) => {
  const origin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      throw new UnauthorizedError({ message: "Sign in required" });
    }
  })();

  const auth = authFromEnv(env, origin);

  return { auth, headers: request.headers };
};

const asUserRow = (row: DbUser): AdminUserRow => ({
  banned: row.banned ?? false,
  createdAt:
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt ?? ""),
  email: row.email,
  id: row.id,
  name: row.name ?? "",
  role: row.role === "admin" ? "admin" : "user",
});

/** Probe for the admin UI: resolves instead of throwing, so the panel
 * works regardless of framework error mapping. `controlFleet` tells the
 * control app whether this install supervises the control fleet (false on the
 * dev image, where `vite dev` serves the UI and there is no control celld). */
export const adminOverview = apiActionNoInput(async ({ env, request }) => {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    return { controlFleet: true, email: "", isAdmin: false as const };
  }

  return {
    controlFleet: await runnerControlFleet(),
    email: admin.email,
    isAdmin: true as const,
  };
});

/** Users per page of the admin home's Users tab. */
export const ADMIN_USERS_PAGE_SIZE = 25;

const ListUsersArgs = Schema.Struct({
  page: Schema.Number,
  query: Schema.String,
});

/** Escape LIKE wildcards so a search for `50%` or `a_b` matches literally. */
const likePattern = (query: string): string =>
  `%${query.replaceAll(/[\\%_]/gu, (char) => `\\${char}`)}%`;

/** One page of accounts (admin only), newest first, optionally filtered by a
 * case-insensitive match on email or name. One query per page: it fetches a
 * row beyond the page to learn whether a next page exists, instead of a
 * second COUNT (the control node's D1 stalls on later queries in an action). */
export const listUsers = apiAction(
  ListUsersArgs,
  async ({ page, query }, { env, request }) => {
    const admin = await requireAdmin(request, env);

    if (!admin) {
      fail("Admin only");
    }

    const needle = query.trim().slice(0, 100);
    const offset = Math.max(0, Math.floor(page)) * ADMIN_USERS_PAGE_SIZE;

    try {
      // Plain SELECT outside the paranorm builder: the builder exceeds
      // tsc's depth budget in some configs, while the untyped call stays
      // shallow everywhere.
      const found = await withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient;

          const filter = needle
            ? `WHERE lower(email) LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\'`
            : "";

          const params: (string | number)[] = needle
            ? [
                likePattern(needle.toLowerCase()),
                likePattern(needle.toLowerCase()),
              ]
            : [];

          return yield* sql.unsafe(
            `SELECT id, email, name, banned, role, createdAt FROM "user"
              ${filter} ORDER BY createdAt DESC, id LIMIT ? OFFSET ?`,
            [...params, ADMIN_USERS_PAGE_SIZE + 1, offset]
          );
        })
      );

      // SAFETY: the column list mirrors DbUser and D1 returns plain row
      // objects.
      const rows = found as DbUser[];

      return {
        hasMore: rows.length > ADMIN_USERS_PAGE_SIZE,
        users: rows
          .slice(0, ADMIN_USERS_PAGE_SIZE)
          .map((row) => asUserRow(row)),
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failUnknown(error);
    }
  }
);

const asAppRow = (
  app: RunnerApp,
  emails: Map<string, string>
): AdminAppRow => ({
  desiredState: app.desiredState ?? "",
  id: app.id,
  name: app.name,
  ownerEmail: emails.get(app.userId) ?? "",
  ownerId: app.userId,
  slug: app.slug,
  status: app.status,
});

/** Every app on this instance, all owners (admin only; runner is source),
 * each with its owner's email. */
export const listAllApps = apiActionNoInput(async ({ env, request }) => {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    fail("Admin only");
  }

  try {
    const [apps, users] = await Promise.all([
      runnerListApps(),
      withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient;

          return yield* sql.unsafe(`SELECT id, email FROM "user"`);
        })
      ),
    ]);

    // SAFETY: the projection is (id, email); D1 returns plain rows.
    const emails = new Map(
      (users as { email: string; id: string }[]).map((u) => [u.id, u.email])
    );

    return apps.map((app) => asAppRow(app, emails));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    return failUnknown(error);
  }
});

const AdminAppState = Schema.Struct({
  desiredState: Schema.String,
  id: Schema.String,
});

/** Start or stop any app, whoever owns it (admin only). */
export const adminSetAppState = apiAction(
  AdminAppState,
  async ({ desiredState, id }, { env, request }) => {
    const admin = await requireAdmin(request, env);

    if (!admin) {
      fail("Admin only");
    }

    if (desiredState !== "running" && desiredState !== "stopped") {
      fail("desiredState must be running or stopped");
    }

    try {
      await runnerPatchApp(id, { desiredState });

      return { ok: true as const };
    } catch (error) {
      return failUnknown(error);
    }
  }
);

/** Delete any app, whoever owns it (admin only): the runner drops the app,
 * then its grants and pending invitations go with it. */
export const adminDeleteApp = apiAction(
  Schema.String,
  async (id: string, { env, request }) => {
    const admin = await requireAdmin(request, env);

    if (!admin) {
      fail("Admin only");
    }

    try {
      await runnerDeleteApp(id);
      await withDb(dropAppCollaborators(id));

      return { ok: true as const };
    } catch (error) {
      return failUnknown(error);
    }
  }
);

const UserId = Schema.String;

/** Ban (also revokes sessions via the admin plugin). Never self-ban. */
export const banUser = apiAction(
  UserId,
  async (userId: string, { env, request }) => {
    const admin = (await requireAdmin(request, env)) ?? fail("Admin only");

    if (userId === admin.id) {
      fail("Cannot ban your own account");
    }

    const { auth, headers } = await adminAuth(request, env);

    try {
      await auth.api.banUser({ body: { userId }, headers });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failUnknown(error);
    }
  }
);

export const unbanUser = apiAction(
  UserId,
  async (userId: string, { env, request }) => {
    const admin = await requireAdmin(request, env);

    if (!admin) {
      fail("Admin only");
    }

    const { auth, headers } = await adminAuth(request, env);

    try {
      await auth.api.unbanUser({ body: { userId }, headers });
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failUnknown(error);
    }
  }
);

const SetUserRole = Schema.Struct({
  role: Schema.String,
  userId: Schema.String,
});

/** Promote or demote an account (admin only). Never your own: an admin who
 * demotes themselves cannot undo it, and the acting admin is what guarantees
 * the instance always has one. */
export const setUserRole = apiAction(
  SetUserRole,
  async ({ role, userId }, { env, request }) => {
    const admin = (await requireAdmin(request, env)) ?? fail("Admin only");
    const nextRole = role === "admin" || role === "user" ? role : null;

    if (nextRole === null) {
      return fail("role must be admin or user");
    }

    if (userId === admin.id) {
      return fail("Cannot change your own role");
    }

    const { auth, headers } = await adminAuth(request, env);

    try {
      await auth.api.setRole({ body: { role: nextRole, userId }, headers });

      return { ok: true as const };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failUnknown(error);
    }
  }
);

/** Apps whose only admin is this account: deleting the account would leave
 * them with nobody to manage them. */
const soleAdminApps = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const rows = yield* sql.unsafe(
      `SELECT c.appId AS appId FROM app_collaborator c
        WHERE c.userId = ? AND c.role = 'admin'
          AND (SELECT count(*) FROM app_collaborator o
                WHERE o.appId = c.appId AND o.role = 'admin') = 1`,
      [userId]
    );

    return rows.length;
  });

/** Remove the account rows better-auth does not own a foreign key for. */
const dropUserLeftovers = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(`DELETE FROM apikey WHERE referenceId = ?`, [userId]);
    yield* sql.unsafe(`DELETE FROM app_collaborator WHERE userId = ?`, [
      userId,
    ]);
  });

/** Delete an account (admin only), its sessions, keys and grants. Refused for
 * yourself, and while the account is the only admin of an app (hand the app
 * over or delete it first). */
export const deleteUser = apiAction(
  UserId,
  async (userId: string, { env, request }) => {
    const admin = (await requireAdmin(request, env)) ?? fail("Admin only");

    if (userId === admin.id) {
      fail("Cannot delete your own account");
    }

    try {
      const stranded = await withDb(soleAdminApps(userId));

      if (stranded > 0) {
        fail(
          `This account is the only admin of ${stranded} app${stranded === 1 ? "" : "s"} — make someone else an admin or delete the app first`
        );
      }

      const { auth, headers } = await adminAuth(request, env);
      await auth.api.removeUser({ body: { userId }, headers });
      await withDb(dropUserLeftovers(userId));

      return { ok: true as const };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failUnknown(error);
    }
  }
);

// ---- Invitations (admin-gated; see invites.server.ts for the code rules) ----

const InviteCount = Schema.Struct({ count: Schema.Number });

/** Every invitation code with both ends of the exchange. */
export const adminListInvites = apiActionNoInput(async ({ env, request }) => {
  const admin = await requireAdmin(request, env);

  if (!admin) {
    fail("Admin only");
  }

  try {
    return await listInvites();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }

    failUnknown(error);
  }
});

/** Mint more codes for the admin to hand out. */
export const adminCreateInvites = apiAction(
  InviteCount,
  async ({ count }, { env, request }) => {
    const admin = (await requireAdmin(request, env)) ?? fail("Admin only");

    if (!Number.isInteger(count) || count < 1 || count > 50) {
      fail("Ask for between 1 and 50 codes");
    }

    try {
      return { codes: await mintInvites(admin.id, count, "admin") };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failUnknown(error);
    }
  }
);

/** Revoke an unused code (a redeemed one is history and stays visible). */
export const adminRevokeInvite = apiAction(
  Schema.String,
  async (id: string, { env, request }) => {
    const admin = await requireAdmin(request, env);

    if (!admin) {
      fail("Admin only");
    }

    try {
      await revokeInvite(id);

      return { ok: true as const };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      failUnknown(error);
    }
  }
);
