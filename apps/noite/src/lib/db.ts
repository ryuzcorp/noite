import type { D1Database } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { isolateOnce, useEnv } from "oxidejs";
import { createMigrator, defineSchema, paranorm } from "paranorm";
import type { InferSchema, Selectable } from "paranorm";

import { controlEnv } from "./control-env";

// D1 holds auth (better-auth tables) plus collaborator grants and their
// pending invitations — the ONLY app-shaped state the UI owns. App rows and deploy history live in the runner
// (single writer, behind its bearer API), so `app_collaborator.appId` is a
// plain key into that store: no local FK, no mirror, no sync job.
// The alpha baseline. Schema changes after it are NEW versions appended to
// `schemaHistory` below (never edits to a shipped one): paranorm diffs
// consecutive versions into a forward migration and records it in the
// `paranorm_migrations` ledger, so an install upgrades in place.
const schema130 = defineSchema(`
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

  collaborator_invite:
    id: id(uuidv4)
    appId: string index unique=[collaborator_invite.appId,collaborator_invite.email]
    appName: string
    email: string index
    role: string enum=[view,push,admin]
    invitedBy: string
    createdAt: timestamp default=now

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

/** 1.4.0 adds `user.onboardedAt`: NULL means the account has never completed
 * the first-run onboarding, so the dashboard shows it once. Existing rows stay
 * NULL and get the tour; the column is server-set only (see auth.ts
 * `additionalFields`), so a client cannot mark itself onboarded. */
const schema140 = defineSchema(`
  _version: "1.4.0"
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
    onboardedAt: timestamp?
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

  collaborator_invite:
    id: id(uuidv4)
    appId: string index unique=[collaborator_invite.appId,collaborator_invite.email]
    appName: string
    email: string index
    role: string enum=[view,push,admin]
    invitedBy: string
    createdAt: timestamp default=now

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

/** The newest shipped schema: what `orm` types and the migrator's plan use. */
const schema = schema140;

export type DB = InferSchema<typeof schema>;
export type AppCollaborator = Selectable<DB["app_collaborator"]>;

export const orm = paranorm<DB>();

/** Every shipped schema, oldest first. Append the next `defineSchema` (with a
 * higher `_version`) here, and point `schema` above at the newest. Ledger ids
 * are positions in this list, so never reorder or drop an entry. */
const schemaHistory = [schema130, schema140];

const migrator = createMigrator(schemaHistory);

const LEDGER_TABLE = "paranorm_migrations";

/** What the ledger says about this database against the migrations this build
 * knows: `undefined` when the two agree (or the ledger is empty), else an
 * operator-facing reason to refuse. */
export const ledgerMismatch = (
  recorded: readonly { migration_id: number; name: string }[],
  known: readonly { id: number; name: string }[]
): string | undefined => {
  const names = new Map(known.map(({ id, name }) => [id, name]));
  const newest = Math.max(0, ...known.map(({ id }) => id));
  for (const { migration_id: id, name } of recorded) {
    const expected = names.get(id);
    if (expected === undefined) {
      return `the control database was migrated by a newer Noite (migration ${id} "${name}"); this image only knows up to ${newest}. Run the newer image again, or restore a backup taken before the upgrade. Downgrades are not supported.`;
    }
    if (expected !== name) {
      return `the control database has migration ${id} recorded as "${name}", but this image expects "${expected}". It was created by a pre-alpha build; reinstall, or restore a backup from this release line.`;
    }
  }
  return undefined;
};

/** Refuse to touch a database whose ledger this build cannot honour, before
 * the migrator would silently run past it. Fresh databases have no ledger. */
const assertLedgerCompatible = Effect.gen(function* assertLedgerCompatible() {
  const sql = yield* SqlClient;
  const tables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${LEDGER_TABLE}
  `;
  if (tables.length === 0) {
    return;
  }
  const recorded = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM paranorm_migrations ORDER BY migration_id
  `;
  const reason = ledgerMismatch(recorded, migrator.plan());
  if (reason) {
    return yield* Effect.fail(new Error(`noite: refusing to start: ${reason}`));
  }
});

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

/** The setup pass itself: the ledger check, the migration and the admin
 * bootstrap below. `ensureDb` runs it at most once per isolate. */
const runDbSetup = Effect.gen(function* runDbSetup() {
  yield* assertLedgerCompatible;
  yield* migrator.migrate;
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
});

/** Bound on one setup pass. Shorter than oxide's 30 s default so a stuck D1
 * call fails the pass (and clears it) well inside a request's own deadline. */
const SETUP_TIMEOUT_MS = 15_000;

/** How long a request waits on a pass another request started before it drops
 * that pass and runs its own. celld cancels a request's pending work when that
 * request ends or its client goes away, so a shared pass can be orphaned
 * without ever failing — without this bound, every later request on the
 * isolate would wait on it forever. */
const SHARED_SETUP_WAIT_MS = 5000;

/** At most one setup pass per isolate, per D1 binding, through oxidejs
 * `isolateOnce`: concurrent callers share one pass, a failure or timeout
 * clears it (so the next request retries), and a caller that has waited
 * {@link SHARED_SETUP_WAIT_MS} runs its own instead of hanging on a pass
 * orphaned by a finished request. The binding is the pass key, so a test that
 * swaps in a fresh database gets a fresh pass. */
const runDbSetupOnce = isolateOnce(
  async (db: D1Database) => {
    await Effect.runPromise(
      runDbSetup.pipe(Effect.provide(D1Client.layer({ db })), Effect.scoped)
    );
  },
  { timeout: SETUP_TIMEOUT_MS, wait: SHARED_SETUP_WAIT_MS }
);

export const ensureDb = Effect.promise(() => runDbSetupOnce(resolveD1()));

export const ensureDbPromise = (): Promise<void> => runDbSetupOnce(resolveD1());

/** Bound on one `withDb` unit of work. A D1 read that never answers fails
 * the action (the client sees an error) instead of leaving it pending. */
const DB_CALL_TIMEOUT = "10 seconds";

export const withDb = <A, E, R>(
  effect: Effect.Effect<A, E, R | SqlClient>
): Promise<A> => {
  const open = ensureDb.pipe(
    Effect.andThen(() => effect),
    Effect.timeout(DB_CALL_TIMEOUT),
    Effect.provide(sqlLive()),
    Effect.scoped
  );
  // SAFETY: providing the D1 layer and scope collapses the R channel, so runPromise sees a closed effect resolving to exactly A.
  const promise = Effect.runPromise(open as Effect.Effect<A, never, never>);
  return promise;
};
