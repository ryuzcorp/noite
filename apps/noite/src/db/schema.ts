// The control D1 schema, defined once for Void's Drizzle layer (`void/db`).
//
// Column names and types mirror the database every install already has: the
// timestamp columns stay TEXT (`CURRENT_TIMESTAMP` defaults included) rather
// than Drizzle's integer modes, so an install created before this schema
// keeps its rows and dates through the upgrade. The initial migration is
// idempotent for the same reason (see db/migrations).
//
// Auth tables match better-auth 1.7.x with the admin, api-key, passkey and
// email-OTP plugins. `user.onboardedAt` is server-set only (the onboarding
// action), never from a client body.
import { sql } from "void/db";
import { index, integer, sqliteTable, text, unique } from "void/schema-d1";

const timestamp = (name: string) =>
  text(name)
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`);

export const userTable = sqliteTable(
  "user",
  {
    banExpires: text("banExpires"),
    banReason: text("banReason"),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    createdAt: timestamp("createdAt"),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" })
      .notNull()
      .default(false),
    id: text("id").primaryKey(),
    image: text("image"),
    name: text("name").notNull(),
    onboardedAt: text("onboardedAt"),
    role: text("role").notNull().default("user"),
    updatedAt: timestamp("updatedAt"),
  },
  (table) => [unique("uq_user_email").on(table.email)]
);

export const sessionTable = sqliteTable(
  "session",
  {
    createdAt: timestamp("createdAt"),
    expiresAt: text("expiresAt").notNull(),
    id: text("id").primaryKey(),
    impersonatedBy: text("impersonatedBy"),
    ipAddress: text("ipAddress"),
    token: text("token").notNull(),
    updatedAt: timestamp("updatedAt"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("uq_session_token").on(table.token),
    index("idx_session_userId").on(table.userId),
  ]
);

export const accountTable = sqliteTable(
  "account",
  {
    accessToken: text("accessToken"),
    accessTokenExpiresAt: text("accessTokenExpiresAt"),
    accountId: text("accountId").notNull(),
    createdAt: timestamp("createdAt"),
    id: text("id").primaryKey(),
    idToken: text("idToken"),
    password: text("password"),
    providerId: text("providerId").notNull(),
    refreshToken: text("refreshToken"),
    refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
    scope: text("scope"),
    updatedAt: timestamp("updatedAt"),
    userId: text("userId")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
  },
  (table) => [index("idx_account_userId").on(table.userId)]
);

export const verificationTable = sqliteTable(
  "verification",
  {
    createdAt: timestamp("createdAt"),
    expiresAt: text("expiresAt").notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: timestamp("updatedAt"),
    value: text("value").notNull(),
  },
  (table) => [index("idx_verification_identifier").on(table.identifier)]
);

export const passkeyTable = sqliteTable(
  "passkey",
  {
    aaguid: text("aaguid"),
    backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
    counter: integer("counter").notNull(),
    createdAt: text("createdAt").default(sql`CURRENT_TIMESTAMP`),
    credentialID: text("credentialID").notNull(),
    deviceType: text("deviceType").notNull(),
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("publicKey").notNull(),
    transports: text("transports"),
    userId: text("userId")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("idx_passkey_credentialID").on(table.credentialID),
    index("idx_passkey_userId").on(table.userId),
  ]
);

export const apikeyTable = sqliteTable(
  "apikey",
  {
    configId: text("configId").notNull().default("default"),
    createdAt: timestamp("createdAt"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    expiresAt: text("expiresAt"),
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    lastRefillAt: text("lastRefillAt"),
    lastRequest: text("lastRequest"),
    metadata: text("metadata"),
    name: text("name"),
    permissions: text("permissions"),
    prefix: text("prefix"),
    rateLimitEnabled: integer("rateLimitEnabled", { mode: "boolean" })
      .notNull()
      .default(false),
    rateLimitMax: integer("rateLimitMax"),
    rateLimitTimeWindow: integer("rateLimitTimeWindow"),
    referenceId: text("referenceId").notNull(),
    refillAmount: integer("refillAmount"),
    refillInterval: integer("refillInterval"),
    remaining: integer("remaining"),
    requestCount: integer("requestCount").notNull().default(0),
    start: text("start"),
    updatedAt: timestamp("updatedAt"),
  },
  (table) => [
    index("idx_apikey_key").on(table.key),
    index("idx_apikey_referenceId").on(table.referenceId),
    index("idx_apikey_configId").on(table.configId),
  ]
);

export const appCollaboratorTable = sqliteTable(
  "app_collaborator",
  {
    appId: text("appId").notNull(),
    createdAt: timestamp("createdAt"),
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    role: text("role").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("uq_app_collaborator_appId_userId").on(table.appId, table.userId),
    index("idx_app_collaborator_userId").on(table.userId),
    index("idx_app_collaborator_appId").on(table.appId),
  ]
);

export const collaboratorInviteTable = sqliteTable(
  "collaborator_invite",
  {
    appId: text("appId").notNull(),
    appName: text("appName").notNull(),
    createdAt: timestamp("createdAt"),
    email: text("email").notNull(),
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    invitedBy: text("invitedBy").notNull(),
    role: text("role").notNull(),
  },
  (table) => [
    unique("uq_collaborator_invite_appId_email").on(table.appId, table.email),
    index("idx_collaborator_invite_email").on(table.email),
    index("idx_collaborator_invite_appId").on(table.appId),
  ]
);

export const inviteTable = sqliteTable(
  "invite",
  {
    code: text("code").notNull(),
    createdAt: timestamp("createdAt"),
    createdBy: text("createdBy").notNull(),
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    note: text("note"),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    usedAt: text("usedAt"),
    usedBy: text("usedBy"),
  },
  (table) => [
    unique("uq_invite_code").on(table.code),
    index("idx_invite_createdBy").on(table.createdBy),
  ]
);

export const schema = {
  account: accountTable,
  apikey: apikeyTable,
  app_collaborator: appCollaboratorTable,
  collaborator_invite: collaboratorInviteTable,
  invite: inviteTable,
  passkey: passkeyTable,
  session: sessionTable,
  user: userTable,
  verification: verificationTable,
} as const;

export type AppCollaborator = typeof appCollaboratorTable.$inferSelect;
