import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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

/** The shipped migrations, in file order (the same SQL the worker applies). */
const migrations = (): string[] => {
  const dir = path.join(import.meta.dir, "migrations");

  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()
    .map((name) => readFileSync(path.join(dir, name), "utf-8"));
};

const applyShippedMigrations = (raw: Database): void => {
  for (const sql of migrations()) {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) {
        raw.run(statement);
      }
    }
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
      .query(`SELECT id, email, role, onboardedAt FROM "user"`)
      .get();

    expect(user).toEqual({
      email: "one@example.com",
      id: "u-1",
      onboardedAt: "2026-11-08T10:00:00.000Z",
      role: "admin",
    });
    expect(raw.query(`SELECT count(*) AS n FROM invite`).get()).toEqual({
      n: 1,
    });
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
      "collaborator_invite",
      "invite",
      "passkey",
      "session",
      "user",
      "verification",
    ]);
  });
});
