/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { action, useEnv, useRequest } from "oxidejs";

import { checkedSchema } from "./action-schema";
import {
  ActionError,
  authFromEnv,
  failAction,
  failUnknown,
  MissingAuthSecretError,
  resolveAdminEmail,
  UnauthorizedError,
} from "./auth";
import { ensureDbPromise, withDb } from "./db";
import { listInvites, mintInvites, revokeInvite } from "./invites.server";
import { runnerListApps } from "./runner";
import type { RunnerApp } from "./runner";

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

const AuthError = Schema.Union([
  UnauthorizedError,
  MissingAuthSecretError,
  ActionError,
]);

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
 * (promoted on the way in so the role persists afterwards). Never throws:
 * async actions surface every throw as unmapped "Internal error"
 * (Oxide wraps them with `catch: asDefect`), so denial is a null return
 * and only genuine infra failures escape (logged server-side). */
const requireAdmin = async (): Promise<AdminSession | null> => {
  try {
    const request = useRequest();
    const env = useEnv<KitEnv>() ?? process.env;
    await ensureDbPromise();
    const origin = (() => {
      try {
        return new URL(request.url).origin;
      } catch {
        return null;
      }
    })();
    if (!origin) {
      return null;
    }
    const auth = authFromEnv(
      // SAFETY: the request-scoped env (or process.env fallback) provides the same KitEnv control keys used by every action.
      env as KitEnv,
      origin
    );
    const session = await auth.api.getSession({ headers: request.headers });
    const user = session?.user;
    if (!user?.email || !user.id) {
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

const adminAuth = () => {
  const request = useRequest();
  const env = useEnv<KitEnv>() ?? process.env;
  const origin = (() => {
    try {
      return new URL(request.url).origin;
    } catch {
      throw new UnauthorizedError({ message: "Sign in required" });
    }
  })();
  const auth = authFromEnv(
    // SAFETY: same KitEnv control keys as every other server action.
    env as KitEnv,
    origin
  );
  return { auth, headers: request.headers };
};

export interface AdminUserRow {
  banned: boolean;
  createdAt: string;
  email: string;
  id: string;
  name: string;
  role: string;
}

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
 * works regardless of framework error mapping. */
export const adminOverview = action(
  async () => {
    const admin = await requireAdmin();
    if (!admin) {
      return { email: "", isAdmin: false as const };
    }
    return { email: admin.email, isAdmin: true as const };
  },
  { error: AuthError }
);

/** Every account on this instance (admin only). */
export const listUsers = action(
  async () => {
    const admin = await requireAdmin();
    if (!admin) {
      failAction("Admin only");
    }
    try {
      // Plain SELECT outside the paranorm builder: the builder exceeds
      // tsc's depth budget in some configs, while the untyped call stays
      // shallow everywhere.
      const found = await withDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          return yield* sql.unsafe(
            `SELECT id, email, name, banned, role, createdAt FROM "user"`
          );
        })
      );
      // SAFETY: the column list mirrors DbUser and D1 returns plain row
      // objects.
      const rows = found as DbUser[];
      const users = rows.map((row) => asUserRow(row));
      users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return users.slice(0, 200);
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  },
  { error: AuthError }
);

export interface AdminAppRow {
  desiredState: string;
  id: string;
  name: string;
  ownerId: string;
  slug: string;
  status: string;
}

const asAppRow = (app: RunnerApp): AdminAppRow => ({
  desiredState: app.desiredState ?? "",
  id: app.id,
  name: app.name,
  ownerId: app.userId,
  slug: app.slug,
  status: app.status,
});

/** Every app on this instance, all owners (admin only; runner is source). */
export const listAllApps = action(
  async () => {
    const admin = await requireAdmin();
    if (!admin) {
      failAction("Admin only");
    }
    try {
      const apps = await runnerListApps();
      return apps.map(asAppRow);
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  },
  { error: AuthError }
);

const UserId = Schema.String;

/** Ban (also revokes sessions via the admin plugin). Never self-ban. */
export const banUser = action(
  checkedSchema(UserId, async (userId: string) => {
    const admin = (await requireAdmin()) ?? failAction("Admin only");
    if (userId === admin.id) {
      failAction("Cannot ban your own account");
    }
    const { auth, headers } = await adminAuth();
    try {
      await auth.api.banUser({ body: { userId }, headers });
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

export const unbanUser = action(
  checkedSchema(UserId, async (userId: string) => {
    const admin = await requireAdmin();
    if (!admin) {
      failAction("Admin only");
    }
    const { auth, headers } = await adminAuth();
    try {
      await auth.api.unbanUser({ body: { userId }, headers });
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

// ---- Invitations (admin-gated; see invites.server.ts for the code rules) ----

const InviteCount = Schema.Struct({ count: Schema.Number });

/** Every invitation code with both ends of the exchange. */
export const adminListInvites = action(
  async () => {
    const admin = await requireAdmin();
    if (!admin) {
      failAction("Admin only");
    }
    try {
      return await listInvites();
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  },
  { error: AuthError }
);

/** Mint more codes for the admin to hand out. */
export const adminCreateInvites = action(
  checkedSchema(InviteCount, async ({ count }) => {
    const admin = (await requireAdmin()) ?? failAction("Admin only");
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      failAction("Ask for between 1 and 50 codes");
    }
    try {
      return { codes: await mintInvites(admin.id, count, "admin") };
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Revoke an unused code (a redeemed one is history and stays visible). */
export const adminRevokeInvite = action(
  checkedSchema(Schema.String, async (id: string) => {
    const admin = await requireAdmin();
    if (!admin) {
      failAction("Admin only");
    }
    try {
      await revokeInvite(id);
      return { ok: true as const };
    } catch (error) {
      if (error instanceof UnauthorizedError || error instanceof ActionError) {
        throw error;
      }
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
