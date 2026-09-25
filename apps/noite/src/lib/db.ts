import type { D1Database } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { useEnv } from "oxidejs";
import { createMigrator, defineSchema, paranorm } from "paranorm";
import type { InferSchema, Selectable } from "paranorm";

import { controlEnv } from "./control-env";

// D1 holds auth (better-auth tables) plus collaborator grants — the ONLY
// app-shaped state the UI owns. App rows and deploy history live in the runner
// (single writer, behind its bearer API), so `app_collaborator.appId` is a
// plain key into that store: no local FK, no mirror, no sync job.
const schema = defineSchema(`
  _version: "1.3.0"
  _extends: [idempotency]

  user:
    id: id
    name: string
    email: string unique
    emailVerified: boolean default=false
    image: string?
    role: string default="user"
    banned: boolean default=false
    banReason: string?
    banExpires: timestamp?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      accounts: has_many=account
      sessions: has_many=session
      collaborations: has_many=app_collaborator

  session:
    id: id
    expiresAt: timestamp
    token: string unique
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    ipAddress: string?
    userAgent: string?
    userId: references=user.id on_delete=cascade index
    impersonatedBy: string?
    _relations:
      user: belongs_to=user

  account:
    id: id
    accountId: string
    providerId: string
    userId: references=user.id on_delete=cascade index
    accessToken: string?
    refreshToken: string?
    idToken: string?
    accessTokenExpiresAt: timestamp?
    refreshTokenExpiresAt: timestamp?
    scope: string?
    password: string?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      user: belongs_to=user

  verification:
    id: id
    identifier: string index
    value: string
    expiresAt: timestamp
    createdAt: timestamp default=now
    updatedAt: timestamp default=now

  passkey:
    id: id
    name: string?
    publicKey: string
    userId: references=user.id on_delete=cascade index
    credentialID: string index
    counter: int
    deviceType: string
    backedUp: boolean
    transports: string?
    createdAt: timestamp? default=now
    aaguid: string?
    _relations:
      user: belongs_to=user

  apikey:
    id: id
    configId: string default="default" index
    name: string?
    start: string?
    referenceId: string index
    prefix: string?
    key: string index
    refillInterval: int?
    refillAmount: int?
    lastRefillAt: timestamp?
    enabled: boolean default=true
    rateLimitEnabled: boolean default=false
    rateLimitTimeWindow: int?
    rateLimitMax: int?
    requestCount: int default=0
    remaining: int?
    lastRequest: timestamp?
    expiresAt: timestamp?
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    permissions: string?
    metadata: string?

  app_collaborator:
    id: id(uuidv4)
    appId: string index unique=[app_collaborator.appId,app_collaborator.userId]
    userId: references=user.id on_delete=cascade index
    role: string enum=[view,push,admin]
    createdAt: timestamp default=now
    _relations:
      user: belongs_to=user

  invite:
    id: id(uuidv4)
    code: string unique index
    createdBy: string index
    usedBy: string?
    usedAt: timestamp?
    revoked: boolean default=false
    note: string?
    createdAt: timestamp default=now
`);

export type DB = InferSchema<typeof schema>;
export type AppCollaborator = Selectable<DB["app_collaborator"]>;
export type AppRole = "view" | "push" | "admin";

export const orm = paranorm<DB>();

const migrator = createMigrator([schema]);

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

/** Stamp the Worker D1 binding for calls outside a request store. */
export const setD1Binding = (db: D1Database) => {
  d1Binding = db;
};

/** Live D1: request ALS env first, then the middleware-stamped binding. */
export const resolveD1 = (): D1Database => {
  try {
    const live = useEnv<KitEnv>()?.DB;
    if (live) {
      return live;
    }
  } catch {
    // Outside a request store — fall through to the stamped binding.
  }
  if (d1Binding) {
    return d1Binding;
  }
  throw missingDb();
};

/** Request-scoped env over process defaults (Worker-safe: no bare process.env). */
export const resolveEnv = (): KitEnv => {
  let live: KitEnv | undefined;
  try {
    live = useEnv<KitEnv>();
  } catch {
    // Outside a request store — defaults only.
  }
  // SAFETY: the merged bag mirrors KitEnv (control defaults + live Worker env); unset keys stay undefined as callers tolerate.
  return { ...controlEnv, ...live } as KitEnv;
};

/** Better Auth database: Kysely over D1 (fresh handle per call — D1 has no connections to pool). */
export const getAuthDb = () =>
  new Kysely({ dialect: new D1Dialect({ database: resolveD1() }) });

/** D1-backed SqlClient layer for the resolved binding. */
export const sqlLive = () => D1Client.layer({ db: resolveD1() });

const migrated = { done: false };

export const ensureDb = Effect.gen(function* ensureDb() {
  if (migrated.done) {
    return;
  }
  yield* migrator.migrate;
  // The migrator tracks a single plan id, so a DB created under an older
  // schema version skips tables added later (e.g. app_collaborator) while
  // reporting success. Heal by ensuring every current-schema table/index
  // exists — a no-op on fresh or up-to-date DBs.
  const sql = yield* SqlClient;
  for (const plan of migrator.sql()) {
    for (const stmt of plan.statements) {
      const healed = stmt.sql
        .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
        .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ");
      yield* sql.unsafe(healed, stmt.parameters);
    }
  }
  // Pre-scope API keys stored NULL permissions, which fail scoped verification.
  // Grant them the full set once (matches the plugin defaultPermissions for
  // new keys); a no-op when every key already carries permissions.
  yield* sql.unsafe(
    `UPDATE apikey SET permissions = '{"apps":["manage"],"events":["push"]}' WHERE permissions IS NULL`,
    []
  );
  // Instance admin bootstrap (runs once per process at startup): if
  // NOITE_ADMIN_EMAIL names an already-registered account, ensure it
  // holds the admin role. No-op when unset or not yet registered.
  const adminEmail =
    resolveEnv().NOITE_ADMIN_EMAIL?.trim().toLowerCase() || null;
  if (adminEmail) {
    const existing = yield* orm.user.findFirst({
      where: { email: adminEmail },
    });
    if (existing && existing.role !== "admin") {
      yield* orm.user.update({
        data: { role: "admin" },
        where: { id: existing.id },
      });
    }
  }
  migrated.done = true;
});

export const ensureDbPromise = () =>
  Effect.runPromise(ensureDb.pipe(Effect.provide(sqlLive()), Effect.scoped));

export const withDb = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient>
): Promise<A> => {
  const open = ensureDb.pipe(
    Effect.andThen(() => effect),
    Effect.provide(sqlLive()),
    Effect.scoped
  );
  // SAFETY: providing the D1 layer and scope collapses the R channel, so runPromise sees a closed effect resolving to exactly A.
  const promise = Effect.runPromise(open as Effect.Effect<A, never, never>);
  return promise;
};
