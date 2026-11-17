import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { getTableConfig, SQLiteTable } from "void/schema-d1";

import * as schema from "./schema";

/** The control schema as every install before the Void/Drizzle swap created
 * it (paranorm's DDL: TEXT timestamps, table-level unique constraints). The
 * first migration must adopt this shape without touching a row. */
const LEGACY_DDL = `
CREATE TABLE "user" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "email" varchar(255) NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT 0,
  "image" varchar(255),
  "role" varchar(255) NOT NULL DEFAULT 'user',
  "banned" boolean NOT NULL DEFAULT 0,
  "banReason" varchar(255),
  "banExpires" timestamp,
  "onboardedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_user_email" UNIQUE ("email")
);
CREATE TABLE "session" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "token" varchar(255) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" varchar(255),
  "userAgent" varchar(255),
  "userId" varchar(255) NOT NULL,
  "impersonatedBy" varchar(255),
  CONSTRAINT "uq_session_token" UNIQUE ("token"),
  CONSTRAINT "fk_session_userId" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_session_userId" ON "session" ("userId");
CREATE TABLE "account" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "accountId" varchar(255) NOT NULL,
  "providerId" varchar(255) NOT NULL,
  "userId" varchar(255) NOT NULL,
  "accessToken" varchar(255),
  "refreshToken" varchar(255),
  "idToken" varchar(255),
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" varchar(255),
  "password" varchar(255),
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fk_account_userId" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_account_userId" ON "account" ("userId");
CREATE TABLE "verification" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "identifier" varchar(255) NOT NULL,
  "value" varchar(255) NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "idx_verification_identifier" ON "verification" ("identifier");
CREATE TABLE "passkey" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255),
  "publicKey" varchar(255) NOT NULL,
  "userId" varchar(255) NOT NULL,
  "credentialID" varchar(255) NOT NULL,
  "counter" integer NOT NULL,
  "deviceType" varchar(255) NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" varchar(255),
  "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
  "aaguid" varchar(255),
  CONSTRAINT "fk_passkey_userId" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_passkey_credentialID" ON "passkey" ("credentialID");
CREATE INDEX "idx_passkey_userId" ON "passkey" ("userId");
CREATE TABLE "apikey" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "configId" varchar(255) NOT NULL DEFAULT 'default',
  "name" varchar(255),
  "start" varchar(255),
  "referenceId" varchar(255) NOT NULL,
  "prefix" varchar(255),
  "key" varchar(255) NOT NULL,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" timestamp,
  "enabled" boolean NOT NULL DEFAULT 1,
  "rateLimitEnabled" boolean NOT NULL DEFAULT 0,
  "rateLimitTimeWindow" integer,
  "rateLimitMax" integer,
  "requestCount" integer NOT NULL DEFAULT 0,
  "remaining" integer,
  "lastRequest" timestamp,
  "expiresAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "permissions" varchar(255),
  "metadata" varchar(255)
);
CREATE INDEX "idx_apikey_key" ON "apikey" ("key");
CREATE INDEX "idx_apikey_referenceId" ON "apikey" ("referenceId");
CREATE INDEX "idx_apikey_configId" ON "apikey" ("configId");
CREATE TABLE "app_collaborator" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "appId" varchar(255) NOT NULL,
  "userId" varchar(255) NOT NULL,
  "role" varchar(255) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_app_collaborator_appId_userId" UNIQUE ("appId", "userId"),
  CONSTRAINT "fk_app_collaborator_userId" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE
);
CREATE INDEX "idx_app_collaborator_userId" ON "app_collaborator" ("userId");
CREATE INDEX "idx_app_collaborator_appId" ON "app_collaborator" ("appId");
CREATE TABLE "collaborator_invite" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "appId" varchar(255) NOT NULL,
  "appName" varchar(255) NOT NULL,
  "email" varchar(255) NOT NULL,
  "role" varchar(255) NOT NULL,
  "invitedBy" varchar(255) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_collaborator_invite_appId_email" UNIQUE ("appId", "email")
);
CREATE INDEX "idx_collaborator_invite_email" ON "collaborator_invite" ("email");
CREATE INDEX "idx_collaborator_invite_appId" ON "collaborator_invite" ("appId");
CREATE TABLE "invite" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "code" varchar(255) NOT NULL,
  "createdBy" varchar(255) NOT NULL,
  "usedBy" varchar(255),
  "usedAt" timestamp,
  "revoked" boolean NOT NULL DEFAULT 0,
  "note" varchar(255),
  "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_invite_code" UNIQUE ("code")
);
CREATE INDEX "idx_invite_createdBy" ON "invite" ("createdBy");
CREATE TABLE "paranorm_migrations" (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
);
CREATE TABLE "paranorm_idempotency" (
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "key" varchar(255) PRIMARY KEY NOT NULL
);
`;

/** The shipped migrations, in file order (the same SQL the worker applies),
 * with their file names: the runner applies each migration once
 * (journal-tracked), never the whole chain twice. */
const migrations = (): { name: string; sql: string }[] => {
  const dir = path.join(import.meta.dir, "migrations");

  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(dir, name), "utf-8"),
    }));
};

const applyShippedMigrations = (raw: Database): void => {
  // A TEMP table: per-connection, so it never leaks into the `sqlite_master`
  // shape assertions below, and it survives across `applyShippedMigrations`
  // calls the way the runner's journal survives across boots.
  raw.run(
    `CREATE TEMP TABLE IF NOT EXISTS __test_journal (name TEXT PRIMARY KEY NOT NULL)`
  );

  for (const { name, sql } of migrations()) {
    const done =
      raw.query(`SELECT name FROM __test_journal WHERE name = ?`).get(name) !==
      null;

    if (done) {
      continue;
    }

    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        raw.run(statement);
      }
    }

    raw.run(`INSERT INTO __test_journal (name) VALUES (?)`, [name]);
  }
};

describe("control migrations", () => {
  test("adopt an existing alpha.29 database without touching its rows", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    raw.run(LEGACY_DDL);
    raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified, role, onboardedAt, createdAt, updatedAt)
       VALUES ('u-1', 'One', 'one@example.com', 1, 'admin', '2026-11-08T10:00:00.000Z', '2026-11-08T09:00:00.000Z', '2026-11-08T09:00:00.000Z')`
    );
    raw.run(
      `INSERT INTO invite (id, code, createdBy, revoked, createdAt)
       VALUES ('i-1', 'AAAA-BBBB-CCCC', 'u-1', 0, '2026-11-08T09:00:00.000Z')`
    );

    applyShippedMigrations(raw);

    const user = raw
      .query(`SELECT id, email, role, onboardedAt, status FROM "user"`)
      .get();

    expect(user).toEqual({
      email: "one@example.com",
      id: "u-1",
      onboardedAt: "2026-11-08T10:00:00.000Z",
      role: "admin",
      // The waitlist migration defaults every pre-existing account to
      // active: nobody already on the instance waits for approval.
      status: "active",
    });
    // The invite-code pool is gone: outstanding codes stop working, table
    // and all. Nothing else dropped or rewrote the data.
    expect(
      raw
        .query(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'invite'`
        )
        .get()
    ).toEqual({ n: 0 });
    expect(
      raw
        .query(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'email_invite'`
        )
        .get()
    ).toEqual({ n: 1 });
    // The old ledger is inert; nothing dropped or rewrote the data.
    expect(
      raw.query(`SELECT count(*) AS n FROM paranorm_migrations`).get()
    ).toEqual({ n: 0 });
  });

  test("create the whole shape on a fresh database and stay idempotent", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");

    applyShippedMigrations(raw);
    applyShippedMigrations(raw);

    // SAFETY: the query selects exactly the name column of every table.
    const tables = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as { name: string }[];

    expect(tables.map((table) => table.name)).toEqual([
      "account",
      "apikey",
      "app_collaborator",
      "bootstrap_setup",
      "collaborator_invite",
      "email_invite",
      "instance_setting",
      "passkey",
      "session",
      "user",
      "verification",
    ]);
  });

  test("migrations are append-only: shipped files never change", () => {
    // A shipped migration is already recorded as applied in every upgraded
    // install's journal, so editing it reaches fresh installs only — the
    // worst divergence. Register a new file's hash when it ships; never
    // touch an existing entry.
    const manifest = {
      "20261109122217_talented_lady_bullseye.sql":
        "49de0debe6d730c6c721ac1015ac62d77cfb72c3df9931a7e5e4112ccb9be5db",
      "20261114120000_first_admin_setup_code.sql":
        "41a92a9f9fd3a777805bcaea7d85ae5323a9aa03bedfee60cde93c71178da6a9",
      "20261116120000_email_invites_waitlist.sql":
        "4e7f6d4856143eb9a96c50a957b9f48735c9095bd12516302dfdec8a29314559",
    } satisfies Record<string, string>;

    const dir = path.join(import.meta.dir, "migrations");

    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .toSorted();

    for (const name of files) {
      const entry = Object.entries(manifest).find(([file]) => file === name);

      if (entry === undefined) {
        throw new Error(
          `unregistered migration ${name}: ship it as a new file and register its sha256 here`
        );
      }

      const actual = createHash("sha256")
        .update(readFileSync(path.join(dir, name)))
        .digest("hex");

      expect(actual).toBe(entry[1]);
    }

    for (const name of Object.keys(manifest).toSorted()) {
      expect(
        files.includes(name),
        `shipped migration ${name} is gone: migrations are append-only, never delete one`
      ).toBe(true);
    }
  });

  test("schema.ts matches the migrated shape", () => {
    // Fresh installs build from schema.ts while upgraded installs replay
    // the migrations: a drift between them is a silent fork. Every declared
    // table must exist after the replay with the same columns (names, types,
    // nullability, default presence) and index names, and no replayed table
    // may lack a declaration.
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    applyShippedMigrations(raw);

    // SAFETY: widening to unknown for the instanceof narrow below; every
    // export of ./schema is a drizzle sqlite table.
    const declared = (Object.values(schema) as unknown[]).filter(
      (table): table is SQLiteTable => table instanceof SQLiteTable
    );

    expect(declared.length).toBeGreaterThan(0);

    // SAFETY: the query selects exactly the name column of every table.
    const migratedNames = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as { name: string }[];

    expect(migratedNames.map((table) => table.name).toSorted()).toEqual(
      declared.map((table) => getTableConfig(table).name).toSorted()
    );

    for (const table of declared) {
      const config = getTableConfig(table);

      // SAFETY: the pragma selects exactly one signature row per column.
      const columns = raw
        .query(
          `SELECT name || ':' || type || ':' || [notnull] || ':' || (dflt_value IS NOT NULL) AS signature FROM pragma_table_info("${config.name}") ORDER BY name`
        )
        .all() as { signature: string }[];

      expect(
        columns.map((column) => column.signature.toLowerCase()).toSorted()
      ).toEqual(
        config.columns
          .map((column) =>
            `${column.name}:${column.getSQLType()}:${column.notNull ? 1 : 0}:${column.default === undefined ? 0 : 1}`.toLowerCase()
          )
          .toSorted()
      );

      // SAFETY: the query selects exactly the name column of every index.
      const indexes = raw
        .query(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${config.name}' AND sql IS NOT NULL ORDER BY name`
        )
        .all() as { name: string }[];

      const declaredIndexes = [
        ...config.indexes.map((index) => index.config.name),
        ...config.uniqueConstraints.map((unique) => unique.name),
      ]
        .filter((name): name is string => name !== undefined)
        .toSorted();

      expect(indexes.map((index) => index.name)).toEqual(declaredIndexes);
    }
  });
});
