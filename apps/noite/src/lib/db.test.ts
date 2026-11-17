import { beforeEach, describe, expect, test } from "bun:test";

import { Cause } from "effect";
import { sql } from "void/db";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import { controlEnv } from "./control-env";
import {
  DB_MIGRATING_BODY,
  DbUnavailableError,
  ensureDb,
  getDb,
  isMissingTableFailure,
  setD1Binding,
  withDb,
} from "./db";
import { errorMessage } from "./errors";

let db: TestD1;

beforeEach(() => {
  db = createTestD1();
  setD1Binding(db.d1);
  delete controlEnv.NOITE_ADMIN_EMAIL;
});

describe("admin bootstrap", () => {
  test("promotes the anchored account once it exists", async () => {
    db.raw.run(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES ('u-admin', 'Admin', 'admin@example.com', 1, '2026-11-09', '2026-11-09')`
    );
    controlEnv.NOITE_ADMIN_EMAIL = "Admin@Example.com";
    await ensureDb();

    // SAFETY: the query selects exactly the role column of one row.
    const row = db.raw
      .query(`SELECT role FROM "user" WHERE id = 'u-admin'`)
      .get() as { role: string };

    expect(row.role).toBe("admin");
  });

  test("is a no-op without the env anchor or before the account registers", async () => {
    await ensureDb();
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });

    controlEnv.NOITE_ADMIN_EMAIL = "late@example.com";
    await ensureDb();
    expect(db.raw.query(`SELECT count(*) AS n FROM "user"`).get()).toEqual({
      n: 0,
    });
  });

  test("never throws on a missing account, and does not cache the miss", async () => {
    controlEnv.NOITE_ADMIN_EMAIL = "none@example.com";

    await ensureDb();
    const executed = db.executed.length;
    await ensureDb();

    // Per-request lookup: the second call re-checks the account (a sign-up
    // after the first request must still get promoted).
    expect(db.executed.length).toBeGreaterThan(executed);
  });
});

describe("withDb", () => {
  test("runs the unit of work against the stamped binding", async () => {
    db.raw.run(
      `INSERT INTO email_invite (id, tokenHash, email, createdBy, expiresAt, createdAt)
       VALUES ('i-1', 'hash-1', 'friend@example.com', 'u-1', '2026-11-09', '2026-11-09')`
    );

    const rows = await withDb(() =>
      getDb().all<{ email: string }>(sql`SELECT email FROM email_invite`)
    );

    expect(rows).toEqual([{ email: "friend@example.com" }]);
  });

  test("propagates the work's failure", async () => {
    await expect(
      withDb(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
  });
});

describe("migration gate", () => {
  test("ensureDb throws DbUnavailableError while tables are missing", async () => {
    // A database whose migrations have not applied yet: the runner is still
    // retrying them, so the bootstrap must read as "migrating", never as a
    // broken schema. A fresh address avoids the isolate's promoted record.
    db.raw.run(`DROP TABLE "user"`);
    controlEnv.NOITE_ADMIN_EMAIL = "unmigrated@example.com";

    let thrown;

    try {
      await ensureDb();
      thrown = null;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DbUnavailableError);
    expect(errorMessage(thrown)).toBe(DB_MIGRATING_BODY);
  });

  test("withDb maps a half-migrated work failure the same way", async () => {
    db.raw.run(`DROP TABLE email_invite`);

    let thrown;

    try {
      await withDb(() =>
        getDb().all<{ email: string }>(sql`SELECT email FROM email_invite`)
      );
      thrown = null;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DbUnavailableError);
    expect(errorMessage(thrown)).toBe(DB_MIGRATING_BODY);
  });

  test("other failures still propagate untouched", async () => {
    await expect(
      withDb(() => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
  });

  test("isMissingTableFailure names an unmigrated database", () => {
    expect(isMissingTableFailure(new Error("no such table: user"))).toBe(true);
    expect(
      isMissingTableFailure(
        new Error("SQLITE_ERROR: no such table: email_invite")
      )
    ).toBe(true);

    // Through effect's wrapper, the shape withDb rejects with.
    expect(
      isMissingTableFailure(
        new Cause.UnknownError(
          new Error("no such table: user"),
          "An error occurred in Effect.tryPromise"
        )
      )
    ).toBe(true);

    // Through drizzle's wrapper: the statement is the wrapper's own text, the
    // driver names the missing table in the cause.
    const wrapped = Object.assign(
      new Error('Failed query: select * from "user"'),
      {
        cause: new Error("no such table: user"),
        params: [],
        query: 'select * from "user"',
      }
    );

    expect(isMissingTableFailure(wrapped)).toBe(true);
    expect(isMissingTableFailure(new Error("D1 is down"))).toBe(false);
    expect(isMissingTableFailure(null)).toBe(false);
  });

  test("isMissingTableFailure lets a wrong table name 500", () => {
    // A table the schema never declares is a code bug, not a pending
    // migration: it must read as a 500, never as 503 "migrating" forever.
    expect(isMissingTableFailure(new Error("no such table: typo_table"))).toBe(
      false
    );
    expect(
      isMissingTableFailure(
        new Cause.UnknownError(
          new Error("no such table: typo_table"),
          "An error occurred in Effect.tryPromise"
        )
      )
    ).toBe(false);
  });
});
