import { beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { ensureDbPromise, setD1Binding, withDb } from "../db";
import { ensureAdminAccount } from "./admin.server";

let db: TestD1;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
  db.executed.length = 0;
});

describe("ensureAdminAccount", () => {
  test("an admin needs no promotion round-trip", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, role) VALUES (?, ?, ?, ?)`,
      ["admin-1", "Admin", "admin@example.com", "admin"]
    );
    db.executed.length = 0;

    await withDb(ensureAdminAccount("admin@example.com", "admin"));

    // The session role is read fresh on every request, so a session that
    // already carries `admin` skips the SELECT: one fewer sequential D1
    // query on every admin action.
    expect(db.executed).toHaveLength(0);
  });

  test("a non-admin anchored address is still promoted", async () => {
    db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
      "user-1",
      "User",
      "anchored@example.com",
    ]);
    db.executed.length = 0;

    await withDb(ensureAdminAccount("anchored@example.com", "user"));

    // SAFETY: the projection is the single `role` column selected above.
    const rows = db.raw
      .query(`SELECT role FROM "user" WHERE email = ?`)
      .all("anchored@example.com") as { role: string }[];

    expect(rows).toEqual([{ role: "admin" }]);
    expect(db.executed.length).toBeGreaterThan(0);
  });
});
