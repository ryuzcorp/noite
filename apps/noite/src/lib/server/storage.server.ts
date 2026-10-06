import * as Schema from "effect/Schema";
import { action, fail, withSchema } from "oxidejs";

import { failUnknown } from "../auth";
import type { SessionUser } from "../auth";
import { requireAppRole } from "../collaborators";
import {
  CONTROL_APP_DATABASE_ID,
  CONTROL_APP_ID,
  CONTROL_APP_NAME,
} from "../control-app";
import { resolveD1 } from "../db";
import type { AppRole } from "../roles";
import {
  runnerD1DeleteRows,
  runnerD1Rows,
  runnerD1Schema,
  runnerD1Tables,
  runnerD1Write,
  runnerDoInstances,
  runnerR2Delete,
  runnerR2Get,
  runnerR2List,
  runnerStorage,
} from "../runner";
import type {
  D1DeleteRowsBody,
  D1RowsQuery,
  D1TableCaps,
  D1WriteBody,
} from "../runner";
import {
  controlRows,
  controlSchema,
  deleteControlRows,
  listControlTables,
  writeControlD1,
} from "./control-d1.server";
import {
  AuthError,
  requireControlAdmin,
  requireViewApp,
  sessionUser,
} from "./session.server";

const StorageListArgs = Schema.Struct({ appId: Schema.String });
const D1TablesArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
});
const D1TableArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
  table: Schema.String,
});
const D1KeySchema = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Null])
);
const D1FilterSchema = Schema.Struct({
  column: Schema.String,
  op: Schema.Union([
    Schema.Literal("eq"),
    Schema.Literal("neq"),
    Schema.Literal("lt"),
    Schema.Literal("lte"),
    Schema.Literal("gt"),
    Schema.Literal("gte"),
    Schema.Literal("like"),
    Schema.Literal("is_null"),
    Schema.Literal("not_null"),
  ]),
  value: Schema.String,
});
const D1SortSchema = Schema.Struct({
  column: Schema.String,
  desc: Schema.Boolean,
});
const D1RowsArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
  filters: Schema.optional(Schema.Array(D1FilterSchema)),
  page: Schema.Number,
  pageSize: Schema.Number,
  search: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.NullOr(D1SortSchema)),
  table: Schema.String,
});
const D1DeleteRowsArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
  keys: Schema.Array(D1KeySchema),
  table: Schema.String,
});
const DoPreviewArgs = Schema.Struct({
  appId: Schema.String,
  className: Schema.String,
});
const R2ListArgs = Schema.Struct({
  appId: Schema.String,
  bucket: Schema.String,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  prefix: Schema.optional(Schema.String),
});
const R2GetArgs = Schema.Struct({
  appId: Schema.String,
  bucket: Schema.String,
  key: Schema.String,
});
const R2DeleteArgs = Schema.Struct({
  appId: Schema.String,
  bucket: Schema.String,
  /** 1..100 keys, every one policy-checked before the single delete call. */
  keys: Schema.Array(Schema.String),
});

/** D1 databases + DO classes declared by an app's deployed config.
 * The reserved control app has exactly one resource: the control D1, which
 * lives in THIS worker's binding, so it never reaches the runner. */
export const listAppStorage = action(
  withSchema(StorageListArgs, async ({ appId }) => {
    if (appId === CONTROL_APP_ID) {
      await requireControlAdmin();
      return [
        {
          appId: CONTROL_APP_ID,
          appName: CONTROL_APP_NAME,
          appSlug: CONTROL_APP_ID,
          id: `d1:${CONTROL_APP_DATABASE_ID}`,
          kind: "d1",
          name: CONTROL_APP_DATABASE_ID,
        },
      ];
    }
    await requireViewApp(appId);
    try {
      return await runnerStorage(appId);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Gate one control-D1 call: real non-impersonating admin, and the reserved
 * database only (the control app owns exactly one). */
const requireControlDatabase = async (
  databaseId: string
): Promise<SessionUser> => {
  const user = await requireControlAdmin();
  if (databaseId !== CONTROL_APP_DATABASE_ID) {
    fail(`Unknown control database ${databaseId}`);
  }
  return user;
};

/** Tenant caps from the caller's collaborator role: any write role (push or
 * admin) gets all three; a viewer none. The control branch computes its own
 * per-table policy. */
const capsForRole = (role: AppRole): D1TableCaps =>
  role === "view"
    ? { delete: false, insert: false, update: false }
    : { delete: true, insert: true, update: true };

/** Tables + row counts of an app D1 database (view role). The control
 * database is read IN-PROCESS from the worker's own binding (never via the
 * runner, never via `celld d1 execute` — see SPEC). */
export const d1Tables = action(
  withSchema(D1TablesArgs, async ({ appId, databaseId }) => {
    if (appId === CONTROL_APP_ID) {
      await requireControlDatabase(databaseId);
      try {
        return await listControlTables(resolveD1());
      } catch (error) {
        failUnknown(error);
      }
    }
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      const listed = await runnerD1Tables(appId, databaseId);
      const caps = capsForRole(role);
      return {
        databaseId: listed.databaseId,
        tables: listed.tables.map((table) => ({ ...table, caps })),
      };
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** One table's schema with its caps: the tenant role decides there, the
 * control D1 policy decides for the reserved database. */
export const d1Schema = action(
  withSchema(D1TableArgs, async ({ appId, databaseId, table }) => {
    if (appId === CONTROL_APP_ID) {
      await requireControlDatabase(databaseId);
      try {
        return await controlSchema(resolveD1(), table);
      } catch (error) {
        failUnknown(error);
      }
    }
    const user = await sessionUser();
    const { role } = await requireAppRole(appId, user.id, "view");
    try {
      const schema = await runnerD1Schema(appId, databaseId, table);
      return {
        ...schema,
        caps: capsForRole(role),
        locked: {},
        redacted: [],
        rowAction: null,
      };
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** One server-side page of rows (view role). */
export const d1Rows = action(
  withSchema(
    D1RowsArgs,
    async ({
      appId,
      databaseId,
      filters,
      page,
      pageSize,
      search,
      sort,
      table,
    }) => {
      const query: D1RowsQuery = {
        filters: filters === undefined ? [] : [...filters],
        page,
        pageSize,
        search: search ?? "",
        sort: sort ?? null,
        table,
      };
      if (appId === CONTROL_APP_ID) {
        await requireControlDatabase(databaseId);
        try {
          return await controlRows(resolveD1(), query);
        } catch (error) {
          failUnknown(error);
        }
      }
      await requireViewApp(appId);
      try {
        return await runnerD1Rows(appId, databaseId, query);
      } catch (error) {
        failUnknown(error);
      }
    }
  ),
  { error: AuthError }
);

const D1WriteArgs = Schema.Struct({
  appId: Schema.String,
  databaseId: Schema.String,
  key: Schema.optional(D1KeySchema),
  op: Schema.Union([
    Schema.Literal("insert"),
    Schema.Literal("update"),
    Schema.Literal("delete"),
  ]),
  table: Schema.String,
  values: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Null])
  ),
});

/** Curated tenant-DB write (push-gated): single INSERT, UPDATE or DELETE.
 * The control database is written IN-PROCESS under the policy in
 * lib/server/control-d1.server.ts (admin only, redacted and locked columns refused).
 * `null` binds SQL NULL, "" an empty string; an omitted insert column takes
 * its DDL default. */
export const d1Write = action(
  withSchema(
    D1WriteArgs,
    async ({ appId, databaseId, key, op, table, values }) => {
      const body: D1WriteBody = { key, op, table, values };
      if (appId === CONTROL_APP_ID) {
        const user = await requireControlDatabase(databaseId);
        try {
          await writeControlD1(resolveD1(), {
            actorId: user.id,
            key,
            op,
            table,
            values,
          });
          return { ok: true };
        } catch (error) {
          failUnknown(error);
        }
      }
      const user = await sessionUser();
      await requireAppRole(appId, user.id, "push");
      try {
        return await runnerD1Write(appId, databaseId, body);
      } catch (error) {
        failUnknown(error);
      }
    }
  ),
  { error: AuthError }
);

/** Delete 1..100 rows by key (push-gated): one atomic batch where the backend
 * allows it, every key policy-checked before anything runs. */
export const d1DeleteRows = action(
  withSchema(D1DeleteRowsArgs, async ({ appId, databaseId, keys, table }) => {
    const body: D1DeleteRowsBody = { keys: [...keys], table };
    if (appId === CONTROL_APP_ID) {
      const user = await requireControlDatabase(databaseId);
      try {
        return await deleteControlRows(resolveD1(), {
          actorId: user.id,
          keys: [...keys],
          table,
        });
      } catch (error) {
        failUnknown(error);
      }
    }
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerD1DeleteRows(appId, databaseId, body);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Read-only Durable Object instance list for one class. */
export const doPreview = action(
  withSchema(DoPreviewArgs, async ({ appId, className }) => {
    await requireViewApp(appId);
    try {
      return await runnerDoInstances(appId, className);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** One page of an R2 bucket folder (view role). */
export const r2List = action(
  withSchema(R2ListArgs, async ({ appId, bucket, prefix, cursor }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2List(appId, bucket, prefix ?? "", cursor ?? null);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Read-only R2 object fetch (bounded text preview). */
export const r2Get = action(
  withSchema(R2GetArgs, async ({ appId, bucket, key }) => {
    await requireViewApp(appId);
    try {
      return await runnerR2Get(appId, bucket, key);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);

/** Delete 1..100 R2 objects in one call (push role — a write). */
export const r2Delete = action(
  withSchema(R2DeleteArgs, async ({ appId, bucket, keys }) => {
    if (keys.length === 0 || keys.length > 100) {
      fail("select 1 to 100 objects");
    }
    const user = await sessionUser();
    await requireAppRole(appId, user.id, "push");
    try {
      return await runnerR2Delete(appId, bucket, [...keys]);
    } catch (error) {
      failUnknown(error);
    }
  }),
  { error: AuthError }
);
