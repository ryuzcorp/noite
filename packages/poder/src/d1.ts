/* eslint-disable max-classes-per-file -- statement and database are one cohesive D1 adapter */
// D1-compatible database over a SQLite file under `<stateDir>/db/` (see
// file-names.ts). Approximations are documented in the README (notably
// `rows_read` and `size_after`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { SqliteDatabase } from "./types.ts";

export interface D1Meta {
  changed_db: string;
  changes: number;
  duration: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  size_after: number;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: D1 rows carry arbitrary columns.
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Partial<D1Meta> & Pick<D1Meta, "duration">;
}

export interface D1Session {
  prepare: (sql: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
  exec: (sql: string) => Promise<{ count: number; duration: number }>;
}

const fileSize = (filePath: string): number => {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
};

export class D1PreparedStatement {
  readonly sql: string;
  private readonly db: SqliteDatabase;
  private readonly dbName: string;
  private readonly filePath: string;
  private readonly params: unknown[];

  constructor(
    db: SqliteDatabase,
    sql: string,
    dbName: string,
    filePath: string,
    params: unknown[] = []
  ) {
    this.db = db;
    this.sql = sql;
    this.dbName = dbName;
    this.filePath = filePath;
    this.params = params;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: bind takes positional unknown params.
  bind = (...params: unknown[]): D1PreparedStatement =>
    new D1PreparedStatement(
      this.db,
      this.sql,
      this.dbName,
      this.filePath,
      params
    );

  private meta = (duration: number): D1Meta => ({
    changed_db: this.dbName,
    changes: 0,
    duration,
    last_row_id: 0,
    rows_read: 0,
    rows_written: 0,
    size_after: fileSize(this.filePath),
  });

  // oxlint-disable-next-line eslint/require-await, anti-slop/no-unsafe-dictionary-type -- mirrors the async D1 API (faults surface as rejections); contract rows carry arbitrary columns.
  first = async <T = Record<string, unknown>>(
    column?: string
  ): Promise<T | null> => {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (row === undefined) {
      return null;
    }
    if (column !== undefined) {
      const value = row[column];
      if (value === undefined || value === null) {
        return null;
      }
      // SAFETY: column values are SQLite scalars; the caller names the expected shape via T.
      return value as T;
    }
    // SAFETY: whole-row reads return the driver's column map; the caller names the expected shape via T.
    return row as T;
  };

  // oxlint-disable-next-line eslint/require-await, anti-slop/no-unsafe-dictionary-type -- mirrors the async D1 API (faults surface as rejections); contract rows carry arbitrary columns.
  all = async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
    const start = Date.now();
    // SAFETY: the driver returns the column map; the caller names the row shape via T.
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    const meta = this.meta(Date.now() - start);
    meta.rows_read = rows.length;
    return { meta, results: rows, success: true };
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async D1 API; sync driver faults surface as rejections.
  run = async (): Promise<D1Result<never>> => {
    const start = Date.now();
    const info = this.db.prepare(this.sql).run(...this.params);
    const meta = this.meta(Date.now() - start);
    const changes = Number(info.changes);
    meta.changes = changes;
    meta.last_row_id = Number(info.lastInsertRowid);
    meta.rows_written = changes;
    return { meta, results: [], success: true };
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async D1 API; sync driver faults surface as rejections.
  raw = async <T = unknown[]>(): Promise<T[]> => {
    const statement = this.db.prepare(this.sql);
    const rows = statement.all(...this.params);
    const [firstRow] = rows;
    const names =
      statement.columns?.().map((column) => column.name) ??
      Object.keys(firstRow ?? {});
    // SAFETY: raw() returns positional column arrays by definition; T names the tuple shape.
    return rows.map((row) => names.map((name) => row[name])) as T[];
  };

  /** Runs the statement the way `batch()` does: queries return rows, writes return metadata. */
  runInBatch = (): Promise<D1Result> => {
    const isQuery = /^\s*(?:select|with|values|pragma|explain)\b/iu.test(
      this.sql
    );
    return isQuery ? this.all() : this.run();
  };
}

export class PoderD1 implements D1Session {
  private readonly db: SqliteDatabase;
  private readonly dbName: string;
  private readonly filePath: string;

  constructor(db: SqliteDatabase, dbName: string, filePath: string) {
    this.db = db;
    this.dbName = dbName;
    this.filePath = filePath;
  }

  prepare = (sql: string): D1PreparedStatement =>
    new D1PreparedStatement(this.db, sql, this.dbName, this.filePath);

  batch = async (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
    this.db.exec("BEGIN");
    try {
      const results: D1Result[] = [];
      for (const statement of statements) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- batch statements run sequentially inside one transaction by design.
        results.push(await statement.runInBatch());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The rollback itself failed; the original error is what matters.
      }
      throw error;
    }
  };

  // oxlint-disable-next-line eslint/require-await -- mirrors the async D1 API; sync driver faults surface as rejections.
  exec = async (sql: string): Promise<{ count: number; duration: number }> => {
    const start = Date.now();
    this.db.exec(sql);
    const count = sql
      .split(";")
      .filter((part) => part.trim().length > 0).length;
    return { count, duration: Date.now() - start };
  };

  // oxlint-disable-next-line eslint/class-methods-use-this -- instance shape mirrors the D1 database; the stub never reads state.
  dump = (): Promise<ArrayBuffer> =>
    Promise.reject(new Error("D1 dump() is not available in Preview"));

  withSession = (): D1Session => this;
}

/** Applies `*.sql` migrations in order, tracked in `d1_migrations` (wrangler's table). Idempotent. */
export const migrateD1 = (
  db: SqliteDatabase,
  options: {
    projectDir: string;
    migrationsDir?: string;
    log?: (line: string) => void;
  }
): void => {
  const dir = path.resolve(
    options.projectDir,
    options.migrationsDir ?? "migrations"
  );
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .toSorted();
  } catch {
    return;
  }
  if (files.length === 0) {
    return;
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
  );
  const applied = new Set(
    db
      .prepare("SELECT name FROM d1_migrations")
      .all()
      .map((row) => String(row["name"]))
  );
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    db.exec(readFileSync(path.join(dir, file), "utf-8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
    options.log?.(`[poder:d1] applied migration ${file}`);
  }
};
