//! The control D1 as a browsable table editor, served IN-PROCESS from the
//! worker's own D1 binding (never via the runner, and never via
//! `celld d1 execute` — see SPEC "Do not write to a live D1 with the celld d1
//! CLI"). One module owns the security policy so read (redaction) and write
//! (refusal) can never drift:
//!
//! - default deny: a table not listed in {@link WRITE_POLICY} is read-only,
//!   so an auth table added in a later release is not silently writable;
//! - columns in {@link REDACTED_COLUMNS} are masked on read and refused on
//!   write, filter and sort (and skipped by search), so they never leave the
//!   worker and cannot be recovered by bisection;
//! - `user.role` and the `user` ban columns are set only through the admin
//!   home's Users tab;
//! - an admin can edit their own `user` row (role and ban stay locked, the id
//!   is the key) but never delete it here;
//! - `session` rows can only be DELETED (revoking a session), by primary key.
//!
//! Every read is server-side (paging, sort, filters, search, COUNT) and every
//! identifier comes from a PRAGMA allowlist while every value is a bound
//! parameter.
import type { D1Database, D1Result } from "@cloudflare/workers-types";
import * as Schema from "effect/Schema";

import { CONTROL_APP_DATABASE_ID } from "./control-app";
import type {
  D1Cell,
  D1Column,
  D1Key,
  D1RowAction,
  D1Rows,
  D1RowsQuery,
  D1TableCaps,
  D1TableInfo,
  D1TableSchema,
  D1Tables,
  D1WriteBody,
} from "./runner";

/** Value shipped to the client in place of a redacted column's real value.
 * The real value never leaves the worker. */
export const REDACTED_VALUE = "•••• redacted";

/** Largest page the rows query serves (mirrors the shared contract). */
export const D1_ROWS_MAX = 100;

/** Filters accepted on one rows query (contract bound). */
export const D1_FILTERS_MAX = 10;

/** Rows one `deleteRows` call may remove, atomically. */
export const D1_DELETE_MAX = 100;

/** Columns whose values are masked on read and refused on write. */
const REDACTED_COLUMNS = {
  account: ["accessToken", "idToken", "password", "refreshToken"],
  apikey: ["key"],
  passkey: ["credentialID", "publicKey"],
  session: ["token"],
  verification: ["value"],
} satisfies Record<string, readonly string[]>;

interface WriteRule {
  delete: boolean;
  insert: boolean;
  /** Columns that may never appear in a write (redacted or managed
   * elsewhere). */
  lockedColumns: readonly string[];
  update: boolean;
}

/** Per-table write policy — DEFAULT DENY: a table absent here is read-only,
 * so an auth table added in a later release is not silently writable. Keyed
 * by a table name read at runtime, hence the own-key `lookup` helper. */
const WRITE_POLICY = {
  app_collaborator: {
    delete: true,
    insert: true,
    lockedColumns: [],
    update: true,
  },
  collaborator_invite: {
    delete: true,
    insert: true,
    lockedColumns: [],
    update: true,
  },
  invite: { delete: true, insert: true, lockedColumns: [], update: true },
  // Sessions are revoked by deleting the row; minting or editing one here
  // would hand out a credential, so both are refused.
  session: { delete: true, insert: false, lockedColumns: [], update: false },
  // `role` and the ban columns are set only through the admin home's Users
  // tab; the raw editor refuses them.
  user: {
    delete: true,
    insert: true,
    lockedColumns: ["role", "banned", "banReason", "banExpires"],
    update: true,
  },
} satisfies Record<string, WriteRule>;

/** Own-key read of one of the static tables above (a table named like an
 * Object.prototype member must not resolve to the prototype). */
const lookup = <R extends Record<string, unknown>>(
  table: string,
  record: R
): R[keyof R] | undefined => {
  if (!Object.hasOwn(record, table)) {
    return undefined;
  }
  // SAFETY: Object.hasOwn proved the key is in `record`; the cast only tells
  // the compiler which member to read back.
  return record[table as keyof R];
};

/** The write capabilities the UI should offer for one table. */
export const controlTableCaps = (table: string): D1TableCaps => {
  const rule = lookup(table, WRITE_POLICY);
  return {
    delete: rule?.delete ?? false,
    insert: rule?.insert ?? false,
    update: rule?.update ?? false,
  };
};

/** Per-table link from a raw grid row to the proper admin action: the admin
 * home's Users or Invites tab, its search prefilled from the row. Managed by
 * the server so the policy (which table maps to which tab and search) lives
 * next to the write rules it mirrors. */
const ROW_ACTIONS = {
  invite: {
    column: "code",
    label: "Manage in Invites",
    param: "iq",
    tab: "invites",
  },
  user: {
    column: "email",
    label: "Manage in Users",
    param: "uq",
    tab: "users",
  },
} satisfies Record<string, D1RowAction>;

/** Note beside a policy-locked column, pointing at the surface that owns it. */
const MANAGED_NOTE = "managed in Users";

/** Note beside a redacted column: it is shown masked and never written. */
const REDACTED_NOTE = "redacted";

/** Redacted columns of one table (empty when it hides nothing). */
const redactedColumnsFor = (table: string): readonly string[] =>
  lookup(table, REDACTED_COLUMNS) ?? [];

/** Columns the editor must not write, with the note to show beside them:
 * policy-locked (`user.role`, the ban columns) or redacted (never written).
 * The server refuses them anyway; this keeps the UI from offering an edit it
 * would reject. */
const lockedFor = (table: string) =>
  Object.fromEntries([
    ...(lookup(table, WRITE_POLICY)?.lockedColumns ?? []).map(
      (name) => [name, MANAGED_NOTE] as const
    ),
    ...redactedColumnsFor(table).map((name) => [name, REDACTED_NOTE] as const),
  ]);

/** Table names the browser never lists: SQLite/celld internals and Wrangler's
 * migration bookkeeping — mirrors the runner's filter (host/storage/d1.rs). */
export const isVisibleTable = (name: string): boolean => {
  if (name.startsWith("_") || name.startsWith("sqlite_")) {
    return false;
  }
  return name !== "d1_migrations";
};

/** Why this session may not browse or write the control D1, or null when it
 * may. Pure so the gate is unit-tested without a request store; the action
 * turns the message into a client-visible `fail(message)`. An impersonated
 * session is refused even when the impersonated account is an admin. */
export const controlAccessRefusal = (access: {
  impersonatedBy: string | null;
  isAdmin: boolean;
}): string | null => {
  if (access.impersonatedBy !== null) {
    return "The control database is not available while impersonating";
  }
  if (!access.isAdmin) {
    return "Instance admins only";
  }
  return null;
};

/** Refusal thrown by every control-D1 operation; the action surfaces its
 * message through `failUnknown`. */
export class ControlD1RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlD1RefusedError";
  }
}

const refuse = (message: string): never => {
  throw new ControlD1RefusedError(message);
};

/** SQLite identifier quoting. Only ever called with names read back from
 * `PRAGMA`/`sqlite_master`, never with client input. */
const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Refuse a name the browser is never allowed to touch. */
const assertVisibleTable = (table: string): void => {
  if (!isVisibleTable(table)) {
    refuse(`unknown table ${table}`);
  }
};

/** A row that does not fit its schema is skipped (the view stays up) instead
 * of failing the whole table. */
const decodeRows = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  rows: readonly unknown[]
): S["Type"][] => {
  const decode = Schema.decodeUnknownSync(schema);
  const out: S["Type"][] = [];
  for (const row of rows) {
    try {
      out.push(decode(row));
    } catch {
      // Skip the malformed row.
    }
  }
  return out;
};

/** One `PRAGMA table_info` row, parsed at the I/O boundary. */
const PragmaColumnRow = Schema.Struct({
  dflt_value: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))
  ),
  name: Schema.String,
  notnull: Schema.optional(Schema.Union([Schema.Number, Schema.Boolean])),
  pk: Schema.optional(Schema.Union([Schema.Number, Schema.Boolean])),
  type: Schema.optional(Schema.String),
});

/** One `PRAGMA foreign_key_list` row (other fields ignored). */
const ForeignKeyRow = Schema.Struct({
  from: Schema.String,
  table: Schema.String,
  to: Schema.String,
});

/** One `PRAGMA index_list` row. */
const IndexListRow = Schema.Struct({
  name: Schema.String,
  unique: Schema.optional(Schema.Union([Schema.Number, Schema.Boolean])),
});

/** One `PRAGMA index_info` row; `name` is null for an expression index. */
const IndexInfoRow = Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One `sqlite_master` name row. */
const TableNameRow = Schema.Struct({ name: Schema.String });

/** One `sqlite_master` CREATE-statement row. */
const TableSqlRow = Schema.Struct({
  sql: Schema.optional(Schema.NullOr(Schema.String)),
});

/** One `COUNT(*)` row. */
const CountRow = Schema.Struct({
  n: Schema.Union([Schema.Number, Schema.String]),
});

/** One raw cell as the driver returns it: scalars, NULL, and the blob forms
 * a future schema might add (rendered, not dropped). */
const CellValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Uint8Array,
  Schema.instanceOf(ArrayBuffer),
]);

/** One data row: column name -> raw cell. */
const DataRow = Schema.Record(Schema.String, CellValue);

const toColumn = (
  row: Schema.Schema.Type<typeof PragmaColumnRow>
): D1Column => ({
  defaultValue:
    row.dflt_value === null || row.dflt_value === undefined
      ? null
      : String(row.dflt_value),
  name: row.name,
  notNull: row.notnull === true || Number(row.notnull ?? 0) === 1,
  pk: Number(row.pk ?? 0) || 0,
  type: row.type ?? "",
});

/** Read one result set's `COUNT(*) AS n` (0 when absent). */
const countOf = (result: D1Result<unknown> | undefined): number => {
  const [row] = decodeRows(CountRow, result?.results ?? []);
  return row === undefined ? 0 : Number(row.n) || 0;
};

/** Decode a blob as the editor's read-only `x'…'` hex form. */
const bytesToHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `x'${hex}'`;
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- a D1 cell is the driver's raw value; this is the one place that maps it onto the editor's text contract. */
/** One cell as the editor sees it: NULL stays null, numerics become their
 * exact text, blobs their `x'…'` hex form. */
const cellValue = (value: unknown): D1Cell => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value instanceof ArrayBuffer) {
    return bytesToHex(new Uint8Array(value));
  }
  if (value instanceof Uint8Array) {
    return bytesToHex(value);
  }
  // D1 only returns the shapes above; anything else is rendered as text
  // rather than dropped.
  return String(value);
};
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

const readColumns = async (
  db: D1Database,
  table: string
): Promise<D1Column[]> => {
  const result = await db
    .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
    .all<unknown>();
  return decodeRows(PragmaColumnRow, result.results ?? []).map(toColumn);
};

/** The columns a table has, or a refusal when it does not exist. */
const requireColumns = async (
  db: D1Database,
  table: string
): Promise<D1Column[]> => {
  assertVisibleTable(table);
  const cols = await readColumns(db, table);
  if (cols.length === 0) {
    refuse(`unknown table ${table}`);
  }
  return cols;
};

const namesOf = (cols: readonly D1Column[]): string[] =>
  cols.map((col) => col.name);

const namesMatch = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  const a = [...left].toSorted();
  const b = [...right].toSorted();
  return a.length === b.length && a.every((name, index) => name === b[index]);
};

/** Tables in this database with their row counts. One round trip lists the
 * names, one batch counts every table. */
export const listControlTables = async (db: D1Database): Promise<D1Tables> => {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
    )
    .all<unknown>();
  const names = decodeRows(TableNameRow, result.results ?? [])
    .map((row) => row.name)
    .filter(isVisibleTable);
  if (names.length === 0) {
    return { databaseId: CONTROL_APP_DATABASE_ID, tables: [] };
  }
  const counts = await db.batch<unknown>(
    names.map((name) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)
    )
  );
  const tables: D1TableInfo[] = names.map((name, index) => ({
    caps: controlTableCaps(name),
    name,
    rowCount: countOf(counts[index]),
  }));
  return { databaseId: CONTROL_APP_DATABASE_ID, tables };
};

/** One table's schema: columns, foreign keys, indexes and CREATE statement,
 * plus the control policy (caps, locked notes, redaction, row action). */
export const controlSchema = async (
  db: D1Database,
  table: string
): Promise<D1TableSchema> => {
  assertVisibleTable(table);
  const quoted = quoteIdent(table);
  const [infoResult, fkResult, indexResult, sqlResult] =
    await db.batch<unknown>([
      db.prepare(`PRAGMA table_info(${quoted})`),
      db.prepare(`PRAGMA foreign_key_list(${quoted})`),
      db.prepare(`PRAGMA index_list(${quoted})`),
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`
        )
        .bind(table),
    ]);
  const columns = decodeRows(PragmaColumnRow, infoResult?.results ?? []).map(
    toColumn
  );
  if (columns.length === 0) {
    refuse(`unknown table ${table}`);
  }
  const foreignKeys = decodeRows(ForeignKeyRow, fkResult?.results ?? []).map(
    (row) => ({ from: row.from, table: row.table, to: row.to })
  );
  const indexRows = decodeRows(IndexListRow, indexResult?.results ?? []);
  let indexes: D1TableSchema["indexes"] = [];
  if (indexRows.length > 0) {
    const infos = await db.batch<unknown>(
      indexRows.map((row) =>
        db.prepare(`PRAGMA index_info(${quoteIdent(row.name)})`)
      )
    );
    indexes = indexRows.map((row, index) => ({
      columns: decodeRows(IndexInfoRow, infos[index]?.results ?? [])
        .map((info) => info.name)
        .filter((name): name is string => typeof name === "string"),
      name: row.name,
      unique: row.unique === true || Number(row.unique ?? 0) === 1,
    }));
  }
  const [sqlRow] = decodeRows(TableSqlRow, sqlResult?.results ?? []);
  const sql = sqlRow?.sql ?? null;
  return {
    caps: controlTableCaps(table),
    columns,
    foreignKeys,
    indexes,
    locked: lockedFor(table),
    redacted: [...redactedColumnsFor(table)],
    rowAction: lookup(table, ROW_ACTIONS) ?? null,
    sql,
    table,
  };
};

/** Escape a LIKE needle: `%`, `_` and `\` become literals. */
const LIKE_SPECIAL = /[\\%_]/gu;

const escapeLike = (needle: string): string =>
  needle.replaceAll(LIKE_SPECIAL, (char) => `\\${char}`);

const clampPageSize = (size: number): number => {
  if (!Number.isFinite(size)) {
    return 25;
  }
  return Math.min(Math.max(Math.trunc(size), 1), D1_ROWS_MAX);
};

interface WhereClause {
  params: (string | null)[];
  sql: string[];
}

/** WHERE clauses for the filters and search, with every value bound and
 * every identifier from the column allowlist. Redacted columns are refused
 * as filters (bisection would leak the secret) and skipped by search. */
const whereClause = (
  cols: readonly D1Column[],
  redacted: ReadonlySet<string>,
  filters: readonly D1RowsQuery["filters"][number][],
  search: string
): WhereClause => {
  if (filters.length > D1_FILTERS_MAX) {
    refuse(`at most ${D1_FILTERS_MAX} filters`);
  }
  const known = new Set(namesOf(cols));
  const sql: string[] = [];
  const params: (string | null)[] = [];
  for (const filter of filters) {
    if (!known.has(filter.column)) {
      refuse(`unknown column ${filter.column}`);
    }
    if (redacted.has(filter.column)) {
      refuse(`${filter.column} is redacted and cannot be filtered`);
    }
    const column = quoteIdent(filter.column);
    switch (filter.op) {
      case "eq": {
        sql.push(`${column} = ?`);
        params.push(filter.value);
        break;
      }
      case "neq": {
        sql.push(`${column} <> ?`);
        params.push(filter.value);
        break;
      }
      case "lt": {
        sql.push(`${column} < ?`);
        params.push(filter.value);
        break;
      }
      case "lte": {
        sql.push(`${column} <= ?`);
        params.push(filter.value);
        break;
      }
      case "gt": {
        sql.push(`${column} > ?`);
        params.push(filter.value);
        break;
      }
      case "gte": {
        sql.push(`${column} >= ?`);
        params.push(filter.value);
        break;
      }
      case "like": {
        // The user's pattern as typed — no extra escaping (the runner's
        // tenant path emits the same plain LIKE).
        sql.push(`${column} LIKE ?`);
        params.push(filter.value);
        break;
      }
      case "is_null": {
        sql.push(`${column} IS NULL`);
        break;
      }
      case "not_null": {
        sql.push(`${column} IS NOT NULL`);
        break;
      }
      default: {
        refuse(`unknown filter op ${String(filter.op)}`);
      }
    }
  }
  if (search !== "") {
    const pattern = `%${escapeLike(search)}%`;
    const matches: string[] = [];
    for (const col of cols) {
      if (redacted.has(col.name)) {
        continue;
      }
      matches.push(`CAST(${quoteIdent(col.name)} AS TEXT) LIKE ? ESCAPE '\\'`);
      params.push(pattern);
    }
    if (matches.length > 0) {
      sql.push(`(${matches.join(" OR ")})`);
    }
  }
  return { params, sql };
};

/** ORDER BY: the requested column when it is writable, else the primary key,
 * else rowid. */
const orderClause = (
  cols: readonly D1Column[],
  redacted: ReadonlySet<string>,
  sort: D1RowsQuery["sort"]
): string => {
  if (sort !== null) {
    const known = new Set(namesOf(cols));
    if (!known.has(sort.column)) {
      refuse(`unknown column ${sort.column}`);
    }
    if (redacted.has(sort.column)) {
      refuse(`${sort.column} is redacted and cannot be sorted`);
    }
    return `${quoteIdent(sort.column)} ${sort.desc ? "DESC" : "ASC"}`;
  }
  const pk = cols
    .filter((col) => col.pk > 0)
    .toSorted((left, right) => left.pk - right.pk);
  if (pk.length > 0) {
    return pk.map((col) => `${quoteIdent(col.name)} ASC`).join(", ");
  }
  return "rowid ASC";
};

/** One server-side page of rows: filters/search in SQL, COUNT under the same
 * WHERE, redacted columns masked on the way out. */
export const controlRows = async (
  db: D1Database,
  query: D1RowsQuery
): Promise<D1Rows> => {
  const cols = await requireColumns(db, query.table);
  const redacted = new Set(redactedColumnsFor(query.table));
  const page = Number.isFinite(query.page)
    ? Math.max(Math.trunc(query.page), 0)
    : 0;
  const pageSize = clampPageSize(query.pageSize);
  const where = whereClause(
    cols,
    redacted,
    query.filters ?? [],
    query.search ?? ""
  );
  const whereSql =
    where.sql.length > 0 ? ` WHERE ${where.sql.join(" AND ")}` : "";
  const columns = namesOf(cols);
  const select = columns.map(quoteIdent).join(", ");
  const [countResult, rowsResult] = await db.batch<unknown>([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ${quoteIdent(query.table)}${whereSql}`
      )
      .bind(...where.params),
    db
      .prepare(
        `SELECT ${select} FROM ${quoteIdent(query.table)}${whereSql} ORDER BY ${orderClause(cols, redacted, query.sort)} LIMIT ? OFFSET ?`
      )
      .bind(...where.params, pageSize, page * pageSize),
  ]);
  const rows: D1Cell[][] = [];
  for (const entry of decodeRows(DataRow, rowsResult?.results ?? [])) {
    rows.push(
      columns.map((name) =>
        redacted.has(name) ? REDACTED_VALUE : cellValue(entry[name])
      )
    );
  }
  return {
    columns,
    page,
    pageSize,
    rows,
    table: query.table,
    total: countOf(countResult),
  };
};

export interface ControlD1Write {
  /** The signed-in admin's id: their own `user` row can't be deleted. */
  actorId: string;
  key?: D1Key;
  op: D1WriteBody["op"];
  table: string;
  /** Change set for insert/update; ignored by delete. */
  values?: Record<string, D1Cell>;
}

export interface ControlD1DeleteRows {
  /** The signed-in admin's id: their own `user` row can't be deleted. */
  actorId: string;
  keys: D1Key[];
  table: string;
}

interface Statement {
  params: (string | null)[];
  sql: string;
}

/** Every key/value identifier must come from the table's PRAGMA, must not be
 * redacted and must not be policy-locked. */
const assertColumnsWritable = (
  table: string,
  cols: readonly D1Column[],
  redacted: ReadonlySet<string>,
  locked: ReadonlySet<string>,
  record: Record<string, D1Cell>
): void => {
  const known = new Set(namesOf(cols));
  for (const name of Object.keys(record)) {
    if (!known.has(name)) {
      refuse(`unknown column ${name} on ${table}`);
    }
    if (redacted.has(name)) {
      refuse(`${table}.${name} is never written here`);
    }
    if (locked.has(name)) {
      refuse(
        `${table}.${name} is managed in the admin home's Users tab and cannot be edited here`
      );
    }
  }
};

/** The key must name the primary key exactly (every column when the table has
 * none), each with a value. */
const assertKey = (
  op: string,
  table: string,
  cols: readonly D1Column[],
  key: Record<string, D1Cell>
): void => {
  const keyCols = Object.keys(key);
  if (keyCols.length === 0) {
    refuse(`${op} needs a key`);
  }
  const pk = cols
    .filter((col) => col.pk > 0)
    .toSorted((left, right) => left.pk - right.pk)
    .map((col) => col.name);
  const expected = pk.length > 0 ? pk : namesOf(cols);
  if (!namesMatch(expected, keyCols)) {
    const what = pk.length > 0 ? "primary key" : "every column";
    refuse(`${op} must be keyed by the ${what} (${expected.join(", ")})`);
  }
};

/** Key conditions: NULL keys spelled `IS NULL`, everything else bound. */
const keyClause = (key: Record<string, D1Cell>) => {
  const clauses: string[] = [];
  const params: (string | null)[] = [];
  for (const [name, value] of Object.entries(key)) {
    if (value === null) {
      clauses.push(`${quoteIdent(name)} IS NULL`);
      continue;
    }
    clauses.push(`${quoteIdent(name)} = ?`);
    params.push(value);
  }
  return { clauses, params };
};

/** Build the INSERT: exactly the columns present in `values`, so an omitted
 * column takes its DDL default; `null` binds SQL NULL, "" an empty string.
 * An empty single-column `id` primary key with no DDL default is filled with
 * a generated UUID (the `id(uuidv4)` convention of the control schema). */
const buildInsert = (
  table: string,
  cols: readonly D1Column[],
  values: Record<string, D1Cell>
): Statement => {
  if (Object.keys(values).length === 0) {
    refuse("no values to insert");
  }
  const filled = { ...values };
  const idColumn = cols.find(
    (col) =>
      col.name === "id" &&
      col.pk > 0 &&
      col.notNull &&
      col.defaultValue === null
  );
  if (idColumn !== undefined) {
    const { id } = filled;
    if (id === undefined || id === null || id === "") {
      filled.id = crypto.randomUUID();
    }
  }
  const names = Object.keys(filled);
  for (const col of cols) {
    if (
      col.notNull &&
      col.defaultValue === null &&
      (filled[col.name] === undefined || filled[col.name] === null)
    ) {
      refuse(`${table}.${col.name} is required`);
    }
  }
  return {
    params: names.map((name) => filled[name] ?? null),
    sql: `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  };
};

/** Build the UPDATE for one row, keyed by the validated columns. */
const buildUpdate = (
  table: string,
  values: Record<string, D1Cell>,
  key: Record<string, D1Cell>
): Statement => {
  const names = Object.keys(values);
  if (names.length === 0) {
    refuse("no values to update");
  }
  const where = keyClause(key);
  return {
    params: [...names.map((name) => values[name] ?? null), ...where.params],
    sql: `UPDATE ${quoteIdent(table)} SET ${names.map((name) => `${quoteIdent(name)} = ?`).join(", ")} WHERE ${where.clauses.join(" AND ")}`,
  };
};

/** Build the DELETE for one row, keyed by the validated columns. */
const buildDelete = (table: string, key: Record<string, D1Cell>): Statement => {
  const where = keyClause(key);
  return {
    params: where.params,
    sql: `DELETE FROM ${quoteIdent(table)} WHERE ${where.clauses.join(" AND ")}`,
  };
};

/** Rows actually changed, when the backend reports it (D1 does; the test
 * shim does not). */
const changedRows = (results: readonly D1Result<unknown>[]): number | null => {
  let total = 0;
  let saw = false;
  for (const result of results) {
    const changes = result?.meta?.changes;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the driver's meta is untyped at the edge (the test shim reports no `changes`).
    if (typeof changes === "number" && Number.isFinite(changes)) {
      total += changes;
      saw = true;
    }
  }
  return saw ? total : null;
};

/** One write's statement, dispatched on the op. */
const buildStatement = (
  op: D1WriteBody["op"],
  table: string,
  cols: readonly D1Column[],
  values: Record<string, D1Cell>,
  key: Record<string, D1Cell>
): Statement => {
  if (op === "insert") {
    return buildInsert(table, cols, values);
  }
  if (op === "update") {
    return buildUpdate(table, values, key);
  }
  return buildDelete(table, key);
};

/** One curated write against the control D1 (never raw SQL): a single
 * INSERT/UPDATE/DELETE on an allowlisted table with columns from that table's
 * PRAGMA, bound parameters only, UPDATE/DELETE keyed by the table's exact
 * primary key. Everything else is refused with a client-visible message. */
export const writeControlD1 = async (
  db: D1Database,
  write: ControlD1Write
): Promise<void> => {
  const { actorId, op, table } = write;
  const values = write.values ?? {};
  const key = write.key ?? {};
  assertVisibleTable(table);
  const rule =
    lookup(table, WRITE_POLICY) ??
    refuse(`${table} is read-only in the control database`);
  const cols = await readColumns(db, table);
  if (cols.length === 0) {
    refuse(`unknown table ${table}`);
  }
  if (!rule[op]) {
    if (op === "update" && table === "session") {
      refuse(
        "session rows cannot be edited here — delete the row to revoke the session"
      );
    }
    refuse(`${op} is not allowed on ${table} in the control database`);
  }
  const redacted = new Set(redactedColumnsFor(table));
  const locked = new Set(rule.lockedColumns);
  assertColumnsWritable(table, cols, redacted, locked, values);
  if (op !== "insert") {
    assertColumnsWritable(table, cols, redacted, locked, key);
    assertKey(op, table, cols, key);
  }
  // Editing your own row is safe: role and ban are locked above and the id is
  // the key. Deleting it would remove the signed-in admin.
  if (table === "user" && op === "delete" && key.id === actorId) {
    refuse(
      "your own account cannot be deleted here — use the admin home's Users tab"
    );
  }
  const statement = buildStatement(op, table, cols, values, key);
  await db
    .prepare(statement.sql)
    .bind(...statement.params)
    .run();
};

/** Delete 1..100 rows in ONE D1 batch (atomic on the real binding), each key
 * policy-checked before anything runs. */
export const deleteControlRows = async (
  db: D1Database,
  body: ControlD1DeleteRows
): Promise<{ deleted: number; ok: true }> => {
  const { actorId, keys, table } = body;
  if (keys.length === 0 || keys.length > D1_DELETE_MAX) {
    refuse(`delete 1 to ${D1_DELETE_MAX} rows at a time`);
  }
  assertVisibleTable(table);
  const rule =
    lookup(table, WRITE_POLICY) ??
    refuse(`${table} is read-only in the control database`);
  if (!rule.delete) {
    refuse(`delete is not allowed on ${table} in the control database`);
  }
  const cols = await readColumns(db, table);
  if (cols.length === 0) {
    refuse(`unknown table ${table}`);
  }
  const redacted = new Set(redactedColumnsFor(table));
  const locked = new Set(rule.lockedColumns);
  const statements = keys.map((key) => {
    assertColumnsWritable(table, cols, redacted, locked, key);
    assertKey("delete", table, cols, key);
    if (table === "user" && key.id === actorId) {
      refuse(
        "your own account cannot be deleted here — use the admin home's Users tab"
      );
    }
    const statement = buildDelete(table, key);
    return db.prepare(statement.sql).bind(...statement.params);
  });
  const results = await db.batch<unknown>(statements);
  return { deleted: changedRows(results) ?? keys.length, ok: true };
};
