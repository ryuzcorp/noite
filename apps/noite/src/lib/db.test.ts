import { beforeEach, describe, expect, test } from "bun:test";

import { sql } from "void/db";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { controlEnv } from "./control-env";
import { ensureDbPromise, getDb, setD1Binding, withDb } from "./db";

let db: TestD1;

beforeEach(() => {
  db = createTestD1();
  setD1Binding(db.d1);
  delete controlEnv.NOITE_ADMIN_EMAIL;
});

const resetSetupPass = () => {
  // A fresh binding starts a fresh pass; the middleware stamps one per
  // request, tests swap handles.
  // SAFETY: a spread of the shim keeps its prepare/batch methods: a distinct handle over the same database.
  const again = { ...db.d1 } as typeof db.d1;
  setD1Binding(again);
};

describe("admin bootstrap", () => {
  test("promotes the anchored account once it exists", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('u-admin', 'Admin', 'admin@example.com', 1, '2026-11-09', '2026-11-09')`
    );
    controlEnv.NOITE_ADMIN_EMAIL = "Admin@Example.com";
    await ensureDbPromise();

    // SAFETY: the query selects exactly the role column of one row.
    const row = db.raw
      .query(`SELECT role FROM "user" WHERE id = 'u-admin'`)
      .get() as { role: string };

    expect(row.role).toBe("admin");
  });

  test("is a no-op without the env anchor or before the account registers", async () => {
    await ensureDbPromise();
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });

    controlEnv.NOITE_ADMIN_EMAIL = "late@example.com";
    resetSetupPass();
    await ensureDbPromise();
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("settles once per isolate and never throws on a missing account", async () => {
    controlEnv.NOITE_ADMIN_EMAIL = "none@example.com";

    await ensureDbPromise();
    const executed = db.executed.length;
    await ensureDbPromise();

    expect(db.executed.length).toBe(executed);
  });
});

describe("withDb", () => {
  test("runs the unit of work against the stamped binding", async () => {
    db.raw.run(
      `INSERT INTO invite (id, code, createdBy, revoked, createdAt)
       VALUES ('i-1', 'AAAA-BBBB-CCCC', 'u-1', 0, '2026-11-09')`
    );

    const rows = await withDb(() =>
      getDb().all<{ code: string }>(sql`SELECT code FROM invite`)
    );

    expect(rows).toEqual([{ code: "AAAA-BBBB-CCCC" }]);
  });

  test("propagates the work's failure", async () => {
    await expect(
      withDb(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
  });
});
