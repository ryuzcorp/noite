import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { createMigrator, defineSchema, paranorm } from "paranorm";
import type { InferSchema, Selectable } from "paranorm";

const schema = defineSchema(`
  _version: "1.2.0"
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
      apps: has_many=app
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

  app:
    id: id(uuidv4)
    slug: string unique
    name: string
    userId: references=user.id on_delete=cascade index
    status: string default="pending"
    subdomain: string
    gitPrefix: string
    fleetBucket: string
    listenPort: int?
    internalPort: int?
    lastDeploySha: string?
    lastError: string?
    desiredState: string default="running"
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      user: belongs_to=user
      secrets: has_many=app_secret
      deploys: has_many=deploy
      collaborators: has_many=app_collaborator

  app_collaborator:
    id: id(uuidv4)
    appId: references=app.id on_delete=cascade index unique=[app_collaborator.appId,app_collaborator.userId]
    userId: references=user.id on_delete=cascade index
    role: string enum=[view,push,admin]
    createdAt: timestamp default=now
    _relations:
      app: belongs_to=app
      user: belongs_to=user

  app_secret:
    id: id(uuidv4)
    appId: references=app.id on_delete=cascade index
    kind: string
    accessKey: string
    secretKey: string
    revealed: boolean default=false
    createdAt: timestamp default=now
    _relations:
      app: belongs_to=app

  deploy:
    id: id(uuidv4)
    appId: references=app.id on_delete=cascade index
    sha: string?
    status: string default="queued"
    log: string default=""
    createdAt: timestamp default=now
    updatedAt: timestamp default=now
    _relations:
      app: belongs_to=app
`);

export type DB = InferSchema<typeof schema>;
export type App = Selectable<DB["app"]>;
export type AppCollaborator = Selectable<DB["app_collaborator"]>;
export type AppSecret = Selectable<DB["app_secret"]>;
export type Deploy = Selectable<DB["deploy"]>;
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
    message: "noite: database path missing (NOITE_DB)",
  });

export const dbFilename = () => process.env.NOITE_DB ?? "./data/noite.sqlite";

let authSqlite: Database | undefined;

/** Better Auth uses bun:sqlite directly. */
export const getAuthDb = () => {
  if (!authSqlite) {
    const file = dbFilename();
    const dir = file.includes("/") ? file.replace(/\/[^/]+$/u, "") : ".";
    if (dir && dir !== ".") {
      mkdirSync(dir, { recursive: true });
    }
    authSqlite = new Database(file, { create: true });
    // Share the file with Effect SqlClient — avoid "database is locked" right
    // after passkey register when list() races session writes.
    authSqlite.exec("PRAGMA journal_mode = WAL;");
    authSqlite.exec("PRAGMA busy_timeout = 5000;");
  }
  return authSqlite;
};

export const SqlLive = SqliteClient.layer({
  create: true,
  filename: dbFilename(),
});

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
  migrated.done = true;
});

export const ensureDbPromise = () =>
  Effect.runPromise(ensureDb.pipe(Effect.provide(SqlLive), Effect.scoped));

export const withDb = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient>
): Promise<A> => {
  const promise = Effect.runPromise(
    ensureDb.pipe(
      Effect.andThen(() => effect),
      Effect.provide(SqlLive),
      Effect.scoped
    )
  );
  // SAFETY: Effect.runPromise unwraps the effect's A channel; providing SqlLive+scoped collapses E+R, so the resolved value is exactly the action's A.
  return promise as Promise<A>;
};

/** @deprecated capture unused — SQLite is process-global */
export const useDb = () => getAuthDb();
