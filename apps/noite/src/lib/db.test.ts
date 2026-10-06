import { beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { ensureDbPromise, ledgerMismatch, setD1Binding } from "./db";

const KNOWN = [
  { id: 1, name: "1.3.0" },
  { id: 2, name: "1.4.0" },
];

let db: TestD1;

beforeEach(() => {
  db = createTestD1();
  setD1Binding(db.d1);
});

describe("ledgerMismatch", () => {
  test("agrees with an empty or matching ledger", () => {
    expect(ledgerMismatch([], KNOWN)).toBeUndefined();
    expect(
      ledgerMismatch(
        [
          { migration_id: 1, name: "1.3.0" },
          { migration_id: 2, name: "1.4.0" },
        ],
        KNOWN
      )
    ).toBeUndefined();
  });

  test("refuses a ledger newer than this build", () => {
    const reason = ledgerMismatch(
      [
        { migration_id: 1, name: "1.3.0" },
        { migration_id: 2, name: "1.4.0" },
        { migration_id: 3, name: "9.9.9" },
      ],
      KNOWN
    );
    expect(reason).toContain("newer Noite");
    expect(reason).toContain("Downgrades are not supported");
  });

  test("refuses a ledger whose entry was written by a different schema", () => {
    const reason = ledgerMismatch([{ migration_id: 1, name: "1.2.0" }], KNOWN);
    expect(reason).toContain('recorded as "1.2.0"');
    expect(reason).toContain('expects "1.3.0"');
  });
});

describe("ensureDb", () => {
  test("migrates a fresh database and records the ledger", async () => {
    await ensureDbPromise();
    const rows = db.raw
      .query(`SELECT migration_id, name FROM paranorm_migrations`)
      .all();
    expect(rows).toEqual([
      { migration_id: 1, name: "1.3.0" },
      { migration_id: 2, name: "1.4.0" },
    ]);
  });

  test("boots again over its own ledger without re-running the migration", async () => {
    await ensureDbPromise();
    // Same binding: the cached pass is reused. Swap in a fresh handle over
    // the same database to force a second pass.
    // SAFETY: a spread of the shim keeps its prepare/batch methods: a distinct handle over the same database.
    const again = { ...db.d1 } as typeof db.d1;
    setD1Binding(again);
    await ensureDbPromise();
    const rows = db.raw
      .query(`SELECT migration_id FROM paranorm_migrations`)
      .all();
    expect(rows).toHaveLength(2);
  });

  test("refuses to boot on a ledger from a newer build", async () => {
    await ensureDbPromise();
    db.raw.run(
      `INSERT INTO paranorm_migrations (migration_id, name) VALUES (3, '9.9.9')`
    );
    // SAFETY: a spread of the shim keeps its prepare/batch methods: a distinct handle over the same database.
    const again = { ...db.d1 } as typeof db.d1;
    setD1Binding(again);
    await expect(ensureDbPromise()).rejects.toThrow(/newer Noite/u);
  });
});
