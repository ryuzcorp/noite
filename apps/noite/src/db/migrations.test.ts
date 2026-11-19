import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getTableConfig, SQLiteTable } from "void/schema-d1";

import * as schema from "./schema";

/** The single post-reset baseline: the only migration the runner applies to
 * a control database. */
const applyBaseline = (raw: Database): void => {
  const sql = readFileSync(
    path.join(import.meta.dir, "migrations", "001_baseline.sql"),
    "utf-8"
  );

  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) {
      raw.run(statement);
    }
  }
};

// SAFETY: the query selects exactly the name column of every table.
const tableNames = (raw: Database): string[] =>
  (
    raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_void\\_%' ESCAPE '\\' ORDER BY name`
      )
      .all() as { name: string }[]
  ).map((table) => table.name);

const refusalOf = (raw: Database): string => {
  try {
    applyBaseline(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);

    // SAFETY: asserted an Error instance above; the refused baseline fails
    // with a SQLite error carrying the reset text.
    return (error as Error).message;
  }

  throw new Error("the baseline applied: expected a refusal");
};

describe("control baseline", () => {
  test("applies the whole shape on an empty database and stays idempotent", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");

    applyBaseline(raw);
    applyBaseline(raw);

    expect(tableNames(raw)).toEqual([
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

  test("never creates the dropped invite table", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    applyBaseline(raw);

    expect(
      raw
        .query(
          `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'invite'`
        )
        .get()
    ).toEqual({ n: 0 });
  });

  test("a ledger naming a pre-reset migration refuses", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    raw.run(
      `CREATE TABLE _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`
    );
    raw.run(`INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)`, [
      "20261116120000_email_invites_waitlist",
      "2026-11-16T00:00:00.000Z",
    ]);

    const refusal = refusalOf(raw);
    expect(refusal).toContain("before the 0.2.0 beta reset");
    expect(refusal).toContain(
      "wipe the data volume and the bucket prefix (or use an empty bucket)"
    );
  });

  test("legacy tables refuse", () => {
    const raw = new Database(":memory:");
    raw.run(
      `CREATE TABLE paranorm_migrations (migration_id integer PRIMARY KEY NOT NULL, name VARCHAR(255) NOT NULL)`
    );
    raw.run(
      `CREATE TABLE invite (id text PRIMARY KEY NOT NULL, code text NOT NULL)`
    );

    const refusal = refusalOf(raw);
    expect(refusal).toContain("before the 0.2.0 beta reset");
    expect(refusal).toContain("cannot be upgraded");
  });

  test("a baseline-stamped database is not a pre-reset lineage", () => {
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    applyBaseline(raw);
    raw.run(`INSERT INTO _void_migrations (name, applied_at) VALUES (?, ?)`, [
      "001_baseline",
      "2026-11-19T00:00:00.000Z",
    ]);

    applyBaseline(raw);

    expect(tableNames(raw)).toContain("user");
  });

  test("schema.ts matches the migrated shape", () => {
    // Fresh installs build from schema.ts while the baseline builds them from
    // SQL: a drift between them is a silent fork. Every declared table must
    // exist after the baseline with the same columns (names, types,
    // nullability, default presence) and index names, and no migrated table
    // may lack a declaration.
    const raw = new Database(":memory:");
    raw.run("PRAGMA foreign_keys = ON");
    applyBaseline(raw);

    // SAFETY: widening to unknown for the instanceof narrow below; every
    // export of ./schema is a drizzle sqlite table.
    const declared = (Object.values(schema) as unknown[]).filter(
      (table): table is SQLiteTable => table instanceof SQLiteTable
    );

    expect(declared.length).toBeGreaterThan(0);

    // SAFETY: the query selects exactly the name column of every table.
    const migratedNames = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_void\\_%' ESCAPE '\\' ORDER BY name`
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
