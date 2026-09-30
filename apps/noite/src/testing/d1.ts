/* oxlint-disable eslint/require-await, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- test doubles: they mirror async platform interfaces and stand in for bindings they only partly implement */
//! Test-only D1 stand-in over bun:sqlite: enough of the binding surface for
//! `@effect/sql-d1` (prepare → bind → all/raw/run, batch), so unit tests run
//! the real migrations and the real SQL. Counts statements so tests can pin
//! "one query" claims.
import { Database } from "bun:sqlite";

import type { D1Database } from "@cloudflare/workers-types";

type Param = string | number | boolean | null;

export interface TestD1 {
  /** Every SQL text executed so far, in order. */
  executed: string[];
  d1: D1Database;
  raw: Database;
}

export const createTestD1 = (): TestD1 => {
  const raw = new Database(":memory:");
  raw.run("PRAGMA foreign_keys = ON");
  const executed: string[] = [];

  const statement = (sql: string, params: Param[] = []) => {
    const run = () => {
      executed.push(sql);
      const stmt = raw.query(sql);
      return stmt;
    };
    return {
      all: async () => {
        const rows = run().all(...params);
        return { meta: {}, results: rows, success: true };
      },
      bind: (...next: Param[]) => statement(sql, next),
      first: async () => run().get(...params) ?? null,
      raw: async () => run().values(...params),
      run: async () => {
        run().run(...params);
        return { meta: {}, results: [], success: true };
      },
    };
  };

  const db = {
    batch: async (statements: { all: () => Promise<unknown> }[]) => {
      const out: unknown[] = [];
      for (const item of statements) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- batch statements run in order
        out.push(await item.all());
      }
      return out;
    },
    prepare: (sql: string) => statement(sql),
  };
  // SAFETY: the shim implements the D1 surface the SQL client and the
  // migrator call; nothing else in the app touches the binding directly.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double for a platform binding.
  return { d1: db as unknown as D1Database, executed, raw };
};
