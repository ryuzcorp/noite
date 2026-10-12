// Durable Object storage: one SQLite file per object (`dostore` for values,
// `dometa` for the alarm), with the Cloudflare sync/async storage shape.
// Values round-trip through the tag/untag codec as JSON text.
import { isBigint, isString } from "../guards.ts";
import type { SqliteDatabase } from "../types.ts";
import { decodeValue, encodeValue } from "./codec.ts";

export interface DOListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
}

export interface DOSyncStorage {
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: mirrors the synchronous DO storage read; values are arbitrary.
  get: (key: string | string[]) => unknown;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- contract: mirrors the synchronous DO storage write; entries are arbitrary.
  put: (key: string | Record<string, unknown>, value?: unknown) => void;
  delete: (key: string | string[]) => boolean | number;
  list: (options?: DOListOptions) => Map<string, unknown>;
  deleteAll: () => void;
}

export class DOStorage {
  private readonly db: SqliteDatabase;
  private alarmListener: ((at: number | null) => void) | null = null;
  readonly sql: {
    exec: (sql: string, ...params: unknown[]) => { count: number };
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: rows carry arbitrary SQLite columns.
    query: (sql: string, ...params: unknown[]) => Record<string, unknown>[];
  };

  constructor(db: SqliteDatabase) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS dostore (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS dometa (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );
    this.sql = {
      exec: (sql: string, ...params: unknown[]) => {
        if (/^\s*select\b/iu.test(sql)) {
          this.db.prepare(sql).all(...params);
          return { count: 0 };
        }
        const info = this.db.prepare(sql).run(...params);
        return {
          count: isBigint(info.changes) ? Number(info.changes) : info.changes,
        };
      },
      query: (sql: string, ...params: unknown[]) =>
        this.db.prepare(sql).all(...params),
    };
  }

  onAlarm(listener: (at: number | null) => void): void {
    this.alarmListener = listener;
  }

  sync(): DOSyncStorage {
    return {
      delete: (key: string | string[]): boolean | number => {
        if (Array.isArray(key)) {
          let count = 0;
          for (const name of key) {
            count += this.deleteOne(name) ? 1 : 0;
          }
          return count;
        }
        return this.deleteOne(key);
      },
      deleteAll: (): void => {
        this.db.exec("DELETE FROM dostore");
      },
      get: (key: string | string[]) => {
        if (Array.isArray(key)) {
          const out = new Map<string, unknown>();
          for (const name of key) {
            const value = this.getOne(name);
            if (value !== undefined) {
              out.set(name, value);
            }
          }
          return out;
        }
        return this.getOne(key);
      },
      list: (options: DOListOptions = {}): Map<string, unknown> =>
        this.listRows(options),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- contract: mirrors the synchronous DO storage write; entries are arbitrary.
      put: (key: string | Record<string, unknown>, value?: unknown): void => {
        if (isString(key)) {
          this.putOne(key, value);
          return;
        }
        for (const [name, entry] of Object.entries(key)) {
          this.putOne(name, entry);
        }
      },
    };
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: storage reads decode to arbitrary values.
  private getOne(key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM dostore WHERE key = ?")
      .get(key);
    if (row === undefined) {
      return undefined;
    }
    return decodeValue(String(row["value"]));
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: storage writes accept arbitrary values.
  private putOne(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO dostore (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(key, encodeValue(value));
  }

  private deleteOne(key: string): boolean {
    const info = this.db.prepare("DELETE FROM dostore WHERE key = ?").run(key);
    return Number(info.changes) > 0;
  }

  private listRows(options: DOListOptions): Map<string, unknown> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.start !== undefined) {
      clauses.push("key >= ?");
      params.push(options.start);
    }
    if (options.startAfter !== undefined) {
      clauses.push("key > ?");
      params.push(options.startAfter);
    }
    if (options.end !== undefined) {
      clauses.push("key < ?");
      params.push(options.end);
    }
    if (options.prefix !== undefined) {
      clauses.push("key LIKE ? ESCAPE '\\'");
      params.push(
        `${options.prefix.replaceAll(/[%_\\]/gu, (char) => `\\${char}`)}%`
      );
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = options.reverse === true ? "DESC" : "ASC";
    const limit = options.limit === undefined ? "" : "LIMIT ?";
    if (limit !== "") {
      params.push(options.limit);
    }
    const rows = this.db
      .prepare(
        `SELECT key, value FROM dostore ${where} ORDER BY key ${order} ${limit}`
      )
      .all(...params);
    const out = new Map<string, unknown>();
    for (const row of rows) {
      out.set(String(row["key"]), decodeValue(String(row["value"])));
    }
    return out;
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- contract: mirrors the async DO storage read; values are arbitrary.
  async get(key: string): Promise<unknown>;
  async get(keys: string[]): Promise<Map<string, unknown>>;
  // oxlint-disable-next-line eslint/require-await, anti-slop/no-unknown-returns -- mirrors the async DO storage API (faults surface as rejections); values are arbitrary.
  async get(key: string | string[]): Promise<unknown> {
    return this.sync().get(key);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: storage writes accept arbitrary values.
  async put(key: string, value: unknown): Promise<void>;
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: storage writes accept arbitrary entries.
  async put(entries: Record<string, unknown>): Promise<void>;
  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async put(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- contract: storage writes accept arbitrary entries.
    key: string | Record<string, unknown>,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: storage writes accept arbitrary values.
    value?: unknown
  ): Promise<void> {
    this.sync().put(key, value);
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async delete(key: string | string[]): Promise<boolean | number> {
    return this.sync().delete(key);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async list(options?: DOListOptions): Promise<Map<string, unknown>> {
    return this.sync().list(options);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async deleteAll(): Promise<void> {
    this.sync().deleteAll();
  }

  private alarmRow(): number | null {
    const row = this.db
      .prepare("SELECT value FROM dometa WHERE key = 'alarm'")
      .get();
    if (row === undefined) {
      return null;
    }
    return Number(row["value"]);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async getAlarm(): Promise<number | null> {
    return this.alarmRow();
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const at =
      scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    this.db
      .prepare(
        "INSERT INTO dometa (key, value) VALUES ('alarm', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(String(at));
    this.alarmListener?.(at);
  }

  // oxlint-disable-next-line eslint/require-await -- mirrors the async DO storage API; sync driver faults surface as rejections.
  async deleteAlarm(): Promise<void> {
    this.db.prepare("DELETE FROM dometa WHERE key = 'alarm'").run();
    this.alarmListener?.(null);
  }

  readAlarmSync(): number | null {
    return this.alarmRow();
  }

  clearAlarmSync(firedAt: number): void {
    if (this.alarmRow() === firedAt) {
      this.db.prepare("DELETE FROM dometa WHERE key = 'alarm'").run();
    }
  }

  async transaction<T>(
    closure: (txn: DOSyncStorage) => Promise<T> | T
  ): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await closure(this.sync());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The rollback itself failed; the original error is what matters.
      }
      throw error;
    }
  }

  transactionSync<T>(closure: (txn: DOSyncStorage) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = closure(this.sync());
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The rollback itself failed; the original error is what matters.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
