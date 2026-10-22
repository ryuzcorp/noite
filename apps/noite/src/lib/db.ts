import type { D1Database } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
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

/** Live D1: the middleware-stamped binding (`src/middleware/03-db.ts` stamps
 * it on every request; tests stamp it by hand). */
export const resolveD1 = (): D1Database => {
  if (d1Binding) {
    return d1Binding;
  }

  throw missingDb();
};

/** Request-scoped env over control defaults (Worker-safe: no bare process.env).
 * The middleware stamps the live Worker env onto `controlEnv` per request, so
 * readers here see it without threading `c.env` through every query. */
// SAFETY: the spread mirrors KitEnv (control defaults, stamped per request by the middleware); unset keys stay undefined as callers tolerate.
export const resolveEnv = (): KitEnv => ({ ...controlEnv }) as KitEnv;

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

/** Bound on one setup pass. A stuck D1 call fails the pass (and clears it)
 * well inside a request's own deadline instead of hanging it. */
const SETUP_TIMEOUT_MS = 15_000;

/** How long a request waits on a pass another request started before it
 * shares the single replacement pass instead. celld drops a request's
 * pending work when that request answers or its client leaves, so a shared
 * pass can be orphaned without ever failing — without this bound, every
 * later request on the isolate would wait on it forever. */
const SHARED_SETUP_WAIT_MS = 5000;

/** A request-scoped lifetime for the shared setup pass: the middleware
 * passes the worker's execution context, and the pass starter registers
 * the pass with `waitUntil` so the pass survives its starter answering or
 * disconnecting. An unregistered pass dies with its starter, and every
 * waiter burns the full wait below (5 s, 10 s, 15 s stalls on actions and
 * asset chunks alike — issues #91, #92, flake H). */
export interface SetupLifetime {
  waitUntil: (promise: Promise<unknown>) => void;
}

/** Per-request knobs for the shared setup pass: the worker lifetime that
 * keeps the pass alive past its starter, and the wait bound (tests inject a
 * small one and await real signals, never a sleep). */
export interface EnsureDbOptions {
  ctx?: SetupLifetime;
  waitMs?: number;
}

/** One in-flight setup pass: its promise plus whether it settled. A settled
 * failure is dropped from the table so the next caller retries. */
interface SetupPass {
  promise: Promise<void>;
  settled: boolean;
}

const setupPasses = new WeakMap<D1Database, SetupPass>();

const failAfter = async (promise: Promise<void>, ms: number): Promise<void> => {
  const expiry = Effect.runPromise(
    Effect.andThen(
      Effect.sleep(ms),
      Effect.fail(new Error(`noite: db setup did not settle within ${ms}ms`))
    )
  );

  // `Promise.race` (unlike `Effect.race`, where only the first *success*
  // wins) lets the first *settlement* win, so a fast setup failure rejects
  // here instead of waiting out the sleep. The race handles both branches,
  // so neither rejection is ever unhandled.
  await Promise.race([promise, expiry]);
};

const startSetupPass = (db: D1Database, ctx?: SetupLifetime): SetupPass => {
  const promise = failAfter(
    Effect.runPromise(
      runDbSetup.pipe(Effect.provide(D1Client.layer({ db })), Effect.scoped)
    ),
    SETUP_TIMEOUT_MS
  );

  const pass: SetupPass = { promise, settled: false };
  setupPasses.set(db, pass);

  // Survive the starter: a pass whose request answers or disconnects first
  // would otherwise hang every waiter to the full wait below. The derived
  // promise settles with the pass without observing its failure (which
  // travels on the pass promise itself, as before).
  const tracked = (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // The setup failure travels on the pass promise itself; `waitUntil`
      // only extends the pass lifetime past its starter.
    }
  })();

  ctx?.waitUntil(tracked);
  void (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // The setup failure travels on the pass promise itself; here it only
      // ends the wait so a settled failure is dropped and retried next call.
      if (setupPasses.get(db) === pass) {
        setupPasses.delete(db);
      }
    }

    pass.settled = true;
  })();

  return pass;
};

/** At most one setup pass per isolate, per D1 binding (an isolate-once
 * helper, whose semantics this keeps): concurrent callers share one pass;
 * the starter registers it with the worker lifetime so it survives the
 * starter answering or disconnecting; a failure or timeout clears it so the
 * next request retries; and a caller that has waited out its bound shares
 * the single replacement pass instead of starting its own, so one slow
 * pass can never turn N waiters into N concurrent migrations hammering
 * celld's single-threaded D1. The binding is the pass key, so a test that
 * swaps in a fresh database gets a fresh pass. */
const runDbSetupOnce = async (
  db: D1Database,
  opts?: EnsureDbOptions
): Promise<void> => {
  const waitMs = opts?.waitMs ?? SHARED_SETUP_WAIT_MS;
  const cached = setupPasses.get(db);

  if (cached === undefined) {
    return startSetupPass(db, opts?.ctx).promise;
  }

  if (cached.settled) {
    return cached.promise;
  }

  // A settled pass answers false so the caller shares it; only an expired
  // wait shares the single replacement pass. `Promise.race` lets the first
  // *settlement* win (see `failAfter`); the race handles both branches.
  const shared = (async (): Promise<boolean> => {
    try {
      await cached.promise;
    } catch {
      // A failed pass still counts as settled: the caller shares its
      // rejection through `cached.promise` below.
    }

    return false;
  })();

  const elapsed = Effect.runPromise(Effect.as(Effect.sleep(waitMs), true));

  const waited = await Promise.race([shared, elapsed]);

  if (!waited) {
    return cached.promise;
  }

  // Single-flight replacement: only the waiter that still sees the pass it
  // waited on replaces it; a waiter that lost the race shares the winner's
  // replacement. Both then await that pass outright: it is registered with
  // the worker lifetime and bounded by its own timeout, and re-expiring
  // here would replace it again, rebuilding the herd this removes.
  const current = setupPasses.get(db);

  if (current !== undefined && current !== cached) {
    return current.promise;
  }

  setupPasses.delete(db);

  return startSetupPass(db, opts?.ctx).promise;
};

export const ensureDb = Effect.promise(() => runDbSetupOnce(resolveD1()));

export const ensureDbPromise = (opts?: EnsureDbOptions): Promise<void> =>
  runDbSetupOnce(resolveD1(), opts);

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
