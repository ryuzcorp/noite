/* eslint-disable max-classes-per-file -- driver and statement are one cohesive node:sqlite adapter */
// Default SQLite driver over `node:sqlite` (DatabaseSync). Node ≥ 22 and the
// Nodepod pod both provide it (pod-side `preloadSqlite()` is the
// integration's job, never this package's).
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import { isBoolean } from "./guards.ts";
import type { SqliteDatabase, SqliteDriver, SqliteStatement } from "./types.ts";

/** Values the driver accepts after normalization (mirrors SQLInputValue). */
type DriverParam = string | number | bigint | Uint8Array | null;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: SqliteStatement takes positional unknown params.
const normalizeParams = (params: unknown[]): DriverParam[] =>
  params.map((param) => {
    if (param instanceof ArrayBuffer) {
      return Buffer.from(param);
    }
    if (ArrayBuffer.isView(param)) {
      return Buffer.from(param.buffer, param.byteOffset, param.byteLength);
    }
    if (isBoolean(param)) {
      return param ? 1 : 0;
    }
    // SAFETY: remaining params are driver pass-through values (string, number, bigint, Uint8Array, null); anything else fails loudly in the driver.
    return param as DriverParam;
  });

class NodeSqliteStatement implements SqliteStatement {
  private readonly inner: StatementSync;

  constructor(inner: StatementSync) {
    this.inner = inner;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: SqliteStatement takes positional unknown params.
  run = (
    ...params: unknown[]
  ): { changes: number | bigint; lastInsertRowid: number | bigint } =>
    this.inner.run(...normalizeParams(params));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: SqliteStatement takes positional unknown params.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: rows carry arbitrary SQLite columns.
  all = (...params: unknown[]): Record<string, unknown>[] =>
    this.inner.all(...normalizeParams(params));

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: SqliteStatement takes positional unknown params.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: rows carry arbitrary SQLite columns.
  get = (...params: unknown[]): Record<string, unknown> | undefined =>
    this.inner.get(...normalizeParams(params)) ?? undefined;

  columns = (): { name: string }[] =>
    this.inner.columns().map((column) => ({ name: column.name }));
}

class NodeSqliteDatabase implements SqliteDatabase {
  private readonly inner: DatabaseSync;

  constructor(path: string) {
    this.inner = new DatabaseSync(path);
  }

  exec = (sql: string): void => {
    this.inner.exec(sql);
  };

  prepare = (sql: string): SqliteStatement =>
    new NodeSqliteStatement(this.inner.prepare(sql));

  close = (): void => {
    this.inner.close();
  };
}

export const defaultSqliteDriver: SqliteDriver = {
  open: (path: string): SqliteDatabase => new NodeSqliteDatabase(path),
};
