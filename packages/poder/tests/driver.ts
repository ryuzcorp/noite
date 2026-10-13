/* eslint-disable max-classes-per-file -- test driver pairs database and statement adapters */
import { Database } from "bun:sqlite";
// Test-only SqliteDriver over `bun:sqlite`. Production/default is node:sqlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isBoolean } from "../src/guards.ts";
import type {
  SqliteDatabase,
  SqliteDriver,
  SqliteStatement,
} from "../src/types.ts";

const normalize = (params: unknown[]): unknown[] =>
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
    return param;
  });

interface BunInner {
  run: (...params: unknown[]) => {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: rows carry arbitrary SQLite columns.
  all: (...params: unknown[]) => Record<string, unknown>[];
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: rows carry arbitrary SQLite columns.
  get: (...params: unknown[]) => Record<string, unknown> | null | undefined;
  columnNames: string[];
}

class BunStatement implements SqliteStatement {
  private readonly inner: BunInner;

  constructor(inner: BunInner) {
    this.inner = inner;
  }

  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  } {
    return this.inner.run(...normalize(params));
  }

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: rows carry arbitrary SQLite columns.
  all(...params: unknown[]): Record<string, unknown>[] {
    return this.inner.all(...normalize(params));
  }

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test boundary: rows carry arbitrary SQLite columns.
  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.inner.get(...normalize(params)) ?? undefined;
  }

  columns(): { name: string }[] {
    return this.inner.columnNames.map((name) => ({ name }));
  }
}

class BunDatabase implements SqliteDatabase {
  private readonly db: Database;

  constructor(pathname: string) {
    this.db = new Database(pathname, { create: true });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    // SAFETY: bun's Statement exposes run/all/get/columnNames with compatible shapes; asserted once at the test boundary.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test boundary: bun Statement narrowed to structural BunInner.
    const inner = this.db.prepare(sql) as unknown as BunInner;
    return new BunStatement(inner);
  }

  close(): void {
    this.db.close();
  }
}

export const bunDriver: SqliteDriver = {
  open: (pathname: string): SqliteDatabase => new BunDatabase(pathname),
};

export const makeStateDir = (): string =>
  mkdtempSync(path.join(tmpdir(), "poder-state-"));

export const makeProjectDir = (): string =>
  mkdtempSync(path.join(tmpdir(), "poder-project-"));
