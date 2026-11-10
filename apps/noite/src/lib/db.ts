import type { D1Database } from "@cloudflare/workers-types";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createDb, eq } from "void/db";

import { schema, userTable } from "../db/schema";
import { controlEnv } from "./control-env";

// D1 holds auth (better-auth tables) plus collaborator grants and their
// pending invitations — the ONLY app-shaped state the UI owns. App rows and
// deploy history live in the runner (single writer, behind its bearer API),
// so `app_collaborator.appId` is a plain key into that store: no local FK, no
// mirror, no sync job.
//
// The schema lives in `src/db/schema.ts` (Void's `void/schema-d1`), its
// migrations in `src/db/migrations/`, and the runner applies them through the
// worker's Void migration endpoint before traffic switches to the new
// generation. Nothing here migrates or reshapes the database at boot.

export type DB = typeof schema;

export type AppCollaborator = typeof schema.app_collaborator.$inferSelect;

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class MissingDbError extends Schema.TaggedError<MissingDbError>()(
  "MissingDbError",
  { message: Schema.String }
) {}

export const missingDb = () =>
  new MissingDbError({
    message: "noite: D1 database binding is missing (DB)",
  });

let d1Binding: D1Database | undefined;

/** Stamp the Worker D1 binding for calls outside a request store. The setup
 * pass is keyed on the binding, so a new database gets a fresh pass. */
export const setD1Binding = (db: D1Database) => {
  d1Binding = db;
};

/** Live D1: the middleware-stamped binding (`src/middleware/03-db.ts` stamps
 * it on every request; tests stamp it by hand). */
export const resolveD1 = (): D1Database => {
  if (d1Binding) {
    return d1Binding;
  }

  throw missingDb();
};

/** Drizzle over the request's D1 binding (a Void API: `createDb` from
 * `void/db` opens the same session-aware connection the runtime uses). */
export const getDb = () => createDb(resolveD1());

/** Request-scoped env over control defaults (Worker-safe: no bare process.env).
 * The middleware stamps the live Worker env onto `controlEnv` per request, so
 * readers here see it without threading `c.env` through every query. */
// SAFETY: the spread mirrors KitEnv (control defaults, stamped per request by the middleware); unset keys stay undefined as callers tolerate.
export const resolveEnv = (): KitEnv => ({ ...controlEnv }) as KitEnv;

/** Better Auth's database: the Drizzle adapter over the same `void/db`
 * connection and this app's schema. */
export const getAuthDb = () =>
  drizzleAdapter(getDb(), { provider: "sqlite", schema });

/** The anchored address already promoted *in this isolate*, or undefined.
 * Isolate-scoped and never request-scoped: the promotion is a one-time write
 * per process, and every request used to redo the SELECT for an address that
 * was already an admin. A process restart simply re-reads once. */
let promotedAdminEmail: string | undefined;

/** The setup pass itself: the instance-admin bootstrap below. Schema
 * migrations are the runner's job (the Void migration endpoint), so a boot
 * only has to promote `NOITE_ADMIN_EMAIL` once it has registered. */
const runDbSetup = async (): Promise<void> => {
  const adminEmail = resolveEnv().NOITE_ADMIN_EMAIL?.trim().toLowerCase();

  if (!adminEmail || promotedAdminEmail === adminEmail) {
    return;
  }

  const db = getDb();

  const existing = await db
    .select({ id: userTable.id, role: userTable.role })
    .from(userTable)
    .where(eq(userTable.email, adminEmail))
    .limit(1);

  const [user] = existing;

  if (!user) {
    // Not registered yet: the next pass promotes it. Caching now would lose
    // the promotion for an account created later in this isolate.
    return;
  }

  if (user.role !== "admin") {
    await db
      .update(userTable)
      .set({ role: "admin" })
      .where(eq(userTable.id, user.id));
  }

  promotedAdminEmail = adminEmail;
};

/** The admin bootstrap, run per request: once per isolate it does one indexed
 * lookup (and a write only when `NOITE_ADMIN_EMAIL` names a registered
 * non-admin), then answers from the isolate's record. Nothing is cached across
 * requests, so a pass can never outlive its request or pin the isolate to a
 * stale binding; only the "already promoted" fact is remembered. */
export const ensureDb = async (): Promise<void> => {
  await runDbSetup();
};

/** Bound on one `withDb` unit of work. A D1 read that never answers fails
 * the action (the client sees an error) instead of leaving it pending. */
const DB_CALL_TIMEOUT = "10 seconds";

/** Run one database unit of work: the admin bootstrap first, then the
 * caller's Drizzle work, bounded so a stuck D1 call cannot hang a request. */
export const withDb = async <A>(work: () => Promise<A>): Promise<A> => {
  await ensureDb();

  const bounded = Effect.tryPromise({
    catch: (error) => error,
    try: work,
  }).pipe(Effect.timeout(DB_CALL_TIMEOUT));

  // SAFETY: timeout only narrows the error channel to TimeoutException,
  // which runPromise throws; the success value is exactly A.
  return await Effect.runPromise(bounded as Effect.Effect<A, never>);
};
