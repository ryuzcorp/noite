import * as Schema from "effect/Schema";
import { eq, sql } from "void/db";

import { apikeyTable, appCollaboratorTable, userTable } from "../../db/schema";
import { runtimeOf, runtimeWire, nextAction } from "../admin/runtime";
import type { AdminAppRow, AdminUserRow } from "../api-types";
import {
  authFromEnv,
  failUnknown,
  resolveAdminEmail,
  UnauthorizedError,
} from "../auth";
import { Authority, authorityOf, authorityWire } from "../authority";
import type { InstanceAuthority } from "../authority";
import { dropAppCollaborators } from "../collaborators";
import { getDb, withDb } from "../db";
import {
  runnerControlFleet,
  runnerDeleteApp,
  runnerListApps,
  runnerPatchApp,
} from "../runner";
import type { RunnerApp } from "../runner";
import { apiAction, apiActionNoInput, fail } from "./api";
import { listInvites, mintInvites, revokeInvite } from "./invites.server";
import { readSession } from "./session.server";

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
 * or the user does not exist yet — they register first via passkeys). The
 * caller passes the session's fresh role: better-auth reads the user row on
 * every session read, so an admin needs no promotion round-trip and the
 * SELECT is skipped, saving one sequential D1 query on every admin action.
 * Exported for the round-trip-count unit test. */
export const ensureAdminAccount = async (
  email: string | null,
  role: string
): Promise<void> => {
  if (!email || role === "admin") {
    return;
  }

  const db = getDb();

  const found = await db
    .select({ id: userTable.id, role: userTable.role })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);

  const [existing] = found;

  if (!existing || existing.role === "admin") {
    return;
  }

  await db
    .update(userTable)
    .set({ role: "admin" })
    .where(eq(userTable.id, existing.id));
};

interface AdminSession {
  /** The one authority union (lib/authority); non-null means an instance
   * admin that is not impersonating. */
  authority: InstanceAuthority;
  email: string;
  id: string;
}

/** What this request's session may do to the instance, without promoting
 * anything. Null when there is no session at all. */
const probeAuthority = async (
  request: Request,
  env: KitEnv
): Promise<InstanceAuthority | null> => {
  const read = await readSession(request, env);

  if (read._tag === "SignedOut") {
    return null;
  }

  const { session } = read;
  const { user } = session;

  return authorityOf({
    adminEmail: resolveAdminEmail(),
    banned: user.banned === true,
    email: user.email,
    impersonatedBy: session.impersonatedBy,
    role: user.role,
  });
};

/** Gate for every admin action: the `admin` role, or the env-anchored
 * address (promoted on the way in so the role persists afterwards), and never
 * an impersonated or banned session — the admin home is hidden while
 * impersonating, and the actions behind it refuse too. The decision is
 * `authorityOf` (lib/authority), the same predicate the control gates and
 * the client surfaces read. Returns null instead of failing so
 * `adminOverview` can probe for the panel; a denying caller turns it into a
 * client-visible `fail("Admin only")`. An infra failure is logged and reads
 * as denial, never as the generic "Internal error". */
const requireAdmin = async (
  request: Request,
  env: KitEnv
): Promise<AdminSession | null> => {
  try {
    const read = await readSession(request, env);

    if (read._tag === "SignedOut") {
      return null;
    }

    const { session } = read;
    const { user } = session;
    const email = user.email?.trim().toLowerCase() ?? "";

    if (!(user.id && email)) {
      return null;
    }

    const anchored = resolveAdminEmail();

    const authority = authorityOf({
      adminEmail: anchored,
      banned: user.banned === true,
      email,
      impersonatedBy: session.impersonatedBy,
      role: user.role,
    });

    if (authority._tag !== "InstanceAdmin") {
      return null;
    }

    if (authority.via === "anchor") {
      // Persist the promotion so every later read sees the role too.
      await ensureAdminAccount(
        anchored,
        user.role === "admin" ? "admin" : "user"
      );
    }

    return { authority, email, id: user.id };
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

const asUserRow = (row: DbUser, actorId: string): AdminUserRow => ({
  banned: row.banned ?? false,
  createdAt:
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt ?? ""),
  email: row.email,
  id: row.id,
  name: row.name ?? "",
  role: row.role === "admin" ? "admin" : "user",
  self: row.id === actorId,
});

/** Probe for the admin UI: resolves instead of throwing, so the panel
 * works regardless of framework error mapping. `controlFleet` tells the
 * control app whether this install supervises the control fleet (false on the
 * dev image, where `vite dev` serves the UI and there is no control celld). */
export const adminOverview = apiActionNoInput(async ({ env, request }) => {
  const admin = await requireAdmin(request, env);

  if (admin) {
    return {
      authority: authorityWire(admin.authority),
      controlFleet: await runnerControlFleet(),
      email: admin.email,
      isAdmin: true as const,
    };
  }

  // The probe answers with the real state (signed out, plain, impersonating
  // or banned) instead of one flat "not admin": the side bar, the control
  // page and the Admin tab all read this field, and only the instance-admin
  // state may see them.
  let authority: InstanceAuthority = Authority.Anonymous();

  try {
    authority = (await probeAuthority(request, env)) ?? authority;
  } catch {
    // A store outage keeps the panel hidden; it reads as signed out, and the
    // session resource itself surfaces the failure to the client gate.
  }

  return {
    authority: authorityWire(authority),
    controlFleet: true,
    email: "",
    isAdmin: false as const,
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
    const admin = (await requireAdmin(request, env)) ?? fail("Admin only");

    const needle = query.trim().slice(0, 100);
    const offset = Math.max(0, Math.floor(page)) * ADMIN_USERS_PAGE_SIZE;

    try {
      const pattern = likePattern(needle.toLowerCase());

      const filter = needle
        ? sql`WHERE lower(email) LIKE ${pattern} ESCAPE '\\' OR lower(name) LIKE ${pattern} ESCAPE '\\'`
        : sql``;

      const rows = await withDb(() =>
        getDb().all<DbUser>(sql`
          SELECT id, email, name, banned, role, createdAt FROM "user"
          ${filter}
          ORDER BY createdAt DESC, id
          LIMIT ${ADMIN_USERS_PAGE_SIZE + 1} OFFSET ${offset}
        `)
      );

      return {
        hasMore: rows.length > ADMIN_USERS_PAGE_SIZE,
        users: rows
          .slice(0, ADMIN_USERS_PAGE_SIZE)
          .map((row) => asUserRow(row, admin.id)),
      };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failUnknown(error);
    }
  }
);

const asAppRow = (app: RunnerApp, emails: Map<string, string>): AdminAppRow => {
  const desiredState = app.desiredState ?? "";
  const runtime = runtimeOf(app.status, desiredState);

  return {
    desiredState,
    id: app.id,
    name: app.name,
    next: nextAction(runtime),
    ownerEmail: emails.get(app.userId) ?? "",
    ownerId: app.userId,
    runtime: runtimeWire(runtime),
    slug: app.slug,
    status: app.status,
  };
};

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
      withDb(() =>
        getDb()
          .select({ email: userTable.email, id: userTable.id })
          .from(userTable)
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
      await dropAppCollaborators(id);

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
const soleAdminApps = (userId: string): Promise<number> =>
  withDb(async () => {
    const rows = await getDb().all<{ appId: string }>(sql`
      SELECT c.appId AS appId FROM app_collaborator c
       WHERE c.userId = ${userId} AND c.role = 'admin'
         AND (SELECT count(*) FROM app_collaborator o
               WHERE o.appId = c.appId AND o.role = 'admin') = 1
    `);

    return rows.length;
  });

/** Remove the account rows better-auth does not own a foreign key for. */
const dropUserLeftovers = (userId: string): Promise<void> =>
  withDb(async () => {
    const db = getDb();

    await db.batch([
      db.delete(apikeyTable).where(eq(apikeyTable.referenceId, userId)),
      db
        .delete(appCollaboratorTable)
        .where(eq(appCollaboratorTable.userId, userId)),
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
      const stranded = await soleAdminApps(userId);

      if (stranded > 0) {
        fail(
          `This account is the only admin of ${stranded} app${stranded === 1 ? "" : "s"} — make someone else an admin or delete the app first`
        );
      }

      const { auth, headers } = await adminAuth(request, env);
      await auth.api.removeUser({ body: { userId }, headers });
      await dropUserLeftovers(userId);

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
      const outcome = await revokeInvite(id);

      if (outcome._tag === "Refused") {
        // A spent code is history: say so instead of reporting a revoke that
        // changed nothing.
        return fail(
          outcome.reason === "used"
            ? "That code has already been used — it cannot be revoked."
            : "That code no longer exists."
        );
      }

      return { ok: true as const };
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }

      return failUnknown(error);
    }
  }
);
