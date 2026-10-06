import { beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../testing/d1";
import type { TestD1 } from "../testing/d1";
import {
  controlAccessRefusal,
  controlRows,
  controlSchema,
  controlTableCaps,
  deleteControlRows,
  listControlTables,
  REDACTED_VALUE,
  writeControlD1,
} from "./control-d1.server";
import { ensureDbPromise, setD1Binding } from "./db";
import type { D1Cell, D1Rows, D1RowsQuery } from "./runner";

let db: TestD1;

beforeEach(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDbPromise();
});

const addUser = (id: string) => {
  db.raw.run(`INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`, [
    id,
    id,
    `${id}@example.com`,
  ]);
};

const addSession = (id: string, token: string, userId: string) => {
  db.raw.run(
    `INSERT INTO session (id, expiresAt, token, userId) VALUES (?, 1, ?, ?)`,
    [id, token, userId]
  );
};

const addInvite = (id: string, code: string, note: string | null) => {
  db.raw.run(
    `INSERT INTO invite (id, code, createdBy, note) VALUES (?, ?, 'a', ?)`,
    [id, code, note]
  );
};

const rowsQuery = (
  table: string,
  extra: Partial<D1RowsQuery> = {}
): D1RowsQuery => ({
  filters: [],
  page: 0,
  pageSize: 25,
  search: "",
  sort: null,
  table,
  ...extra,
});

/** One cell of a rows result (missing row/column is null). */
const cell = (result: D1Rows, column: string, rowIndex = 0): D1Cell => {
  const index = result.columns.indexOf(column);
  if (index === -1) {
    throw new Error(`no column ${column}`);
  }
  return result.rows[rowIndex]?.[index] ?? null;
};

/** Total rows the query matches on the `nums` fixture. */
const numsTotal = async (extra: Partial<D1RowsQuery>): Promise<number> => {
  const result = await controlRows(db.d1, rowsQuery("nums", extra));
  return result.total;
};

const addNums = () => {
  db.raw.run(`CREATE TABLE nums (id TEXT PRIMARY KEY, n INTEGER, s TEXT)`);
  db.raw.run(`INSERT INTO nums (id, n, s) VALUES ('n1', 1, 'plain')`);
  db.raw.run(`INSERT INTO nums (id, n, s) VALUES ('n2', 2, '100%')`);
  db.raw.run(`INSERT INTO nums (id, n, s) VALUES ('n3', 3, 'a_b')`);
  db.raw.run(`INSERT INTO nums (id, n, s) VALUES ('n4', 4, NULL)`);
};

describe("tables", () => {
  test("lists the real tables with row counts, hides internals, attaches caps", async () => {
    db.raw.run(`CREATE TABLE "_hidden" (x TEXT)`);
    db.raw.run(`CREATE TABLE d1_migrations (id INTEGER)`);
    addInvite("i1", "CODE-1", "note");
    const listed = await listControlTables(db.d1);
    const names = listed.tables.map((table) => table.name);
    expect(names).toContain("user");
    expect(names).toContain("session");
    expect(names).toContain("invite");
    expect(names).not.toContain("_hidden");
    expect(names).not.toContain("d1_migrations");
    expect(listed.databaseId).toBe("noite-control");
    const invite = listed.tables.find((table) => table.name === "invite");
    expect(invite?.rowCount).toBe(1);
    expect(invite?.caps).toEqual({ delete: true, insert: true, update: true });
    const session = listed.tables.find((table) => table.name === "session");
    expect(session?.caps).toEqual({
      delete: true,
      insert: false,
      update: false,
    });
    const account = listed.tables.find((table) => table.name === "account");
    expect(account?.caps).toEqual({
      delete: false,
      insert: false,
      update: false,
    });
  });
});

describe("schema", () => {
  test("parses columns, PK, defaults and notes, with policy caps", async () => {
    const schema = await controlSchema(db.d1, "user");
    expect(schema.caps).toEqual({ delete: true, insert: true, update: true });
    const byName = new Map(schema.columns.map((col) => [col.name, col]));
    expect(byName.get("id")).toMatchObject({
      defaultValue: null,
      notNull: true,
      pk: 1,
    });
    expect(byName.get("role")).toMatchObject({
      defaultValue: "'user'",
      notNull: true,
      pk: 0,
    });
    expect(schema.locked.role).toBe("managed in Users");
    expect(schema.locked.banned).toBe("managed in Users");
    expect(schema.locked.banReason).toBe("managed in Users");
    expect(schema.locked.banExpires).toBe("managed in Users");
    expect(schema.redacted).toEqual([]);
    expect(schema.rowAction).toEqual({
      column: "email",
      label: "Manage in Users",
      param: "uq",
      tab: "users",
    });
    expect(schema.sql).toContain("CREATE TABLE");
  });

  test("marks redacted columns locked and points invite rows at Invites", async () => {
    const session = await controlSchema(db.d1, "session");
    expect(session.redacted).toContain("token");
    expect(session.locked.token).toBe("redacted");
    expect(session.rowAction).toBeNull();
    const invite = await controlSchema(db.d1, "invite");
    expect(invite.locked).toEqual({});
    expect(invite.redacted).toEqual([]);
    expect(invite.rowAction).toEqual({
      column: "code",
      label: "Manage in Invites",
      param: "iq",
      tab: "invites",
    });
  });

  test("reads foreign keys, indexes and the CREATE statement", async () => {
    db.raw.run(`CREATE TABLE parent (id TEXT PRIMARY KEY)`);
    db.raw.run(
      `CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent(id), v TEXT)`
    );
    db.raw.run(`CREATE INDEX child_v ON child (v)`);
    const schema = await controlSchema(db.d1, "child");
    expect(schema.foreignKeys).toEqual([
      { from: "pid", table: "parent", to: "id" },
    ]);
    const index = schema.indexes.find((entry) => entry.name === "child_v");
    expect(index).toEqual({ columns: ["v"], name: "child_v", unique: false });
    expect(schema.sql).toContain("CREATE TABLE");
  });

  test("refuses an unknown or internal table", async () => {
    await expect(controlSchema(db.d1, "nope")).rejects.toThrow(
      /unknown table/u
    );
    await expect(controlSchema(db.d1, "sqlite_master")).rejects.toThrow(
      /unknown table/u
    );
  });
});

describe("rows", () => {
  test("pages server-side with a total and a stable column order", async () => {
    for (let i = 0; i < 5; i += 1) {
      addInvite(`i${i}`, `CODE-${i}`, `note ${i}`);
    }
    const first = await controlRows(
      db.d1,
      rowsQuery("invite", { pageSize: 2 })
    );
    expect(first.columns[0]).toBe("id");
    expect(first.total).toBe(5);
    expect(first.page).toBe(0);
    expect(first.pageSize).toBe(2);
    expect(first.rows).toHaveLength(2);
    // No sort: the primary key order (id ASC).
    expect(cell(first, "id", 0)).toBe("i0");
    const last = await controlRows(
      db.d1,
      rowsQuery("invite", { page: 2, pageSize: 2 })
    );
    expect(last.rows).toHaveLength(1);
    expect(cell(last, "id")).toBe("i4");
  });

  test("clamps the page size and the page", async () => {
    const result = await controlRows(
      db.d1,
      rowsQuery("invite", { page: -3, pageSize: 1000 })
    );
    expect(result.page).toBe(0);
    expect(result.pageSize).toBe(100);
  });

  test("falls back to rowid order for a table without a primary key", async () => {
    db.raw.run(`CREATE TABLE nopk (v TEXT)`);
    db.raw.run(`INSERT INTO nopk (v) VALUES ('first'), ('second')`);
    const result = await controlRows(db.d1, rowsQuery("nopk"));
    expect(cell(result, "v", 0)).toBe("first");
  });

  test("sorts by the requested column", async () => {
    addNums();
    const desc = await controlRows(
      db.d1,
      rowsQuery("nums", { sort: { column: "n", desc: true } })
    );
    expect(cell(desc, "n", 0)).toBe("4");
    const asc = await controlRows(
      db.d1,
      rowsQuery("nums", { sort: { column: "n", desc: false } })
    );
    expect(cell(asc, "n", 0)).toBe("1");
  });

  test("applies every filter op", async () => {
    addNums();
    expect(
      await numsTotal({ filters: [{ column: "n", op: "eq", value: "2" }] })
    ).toBe(1);
    expect(
      await numsTotal({ filters: [{ column: "n", op: "neq", value: "2" }] })
    ).toBe(3);
    expect(
      await numsTotal({ filters: [{ column: "n", op: "lt", value: "3" }] })
    ).toBe(2);
    expect(
      await numsTotal({ filters: [{ column: "n", op: "lte", value: "3" }] })
    ).toBe(3);
    expect(
      await numsTotal({ filters: [{ column: "n", op: "gt", value: "2" }] })
    ).toBe(2);
    expect(
      await numsTotal({ filters: [{ column: "n", op: "gte", value: "2" }] })
    ).toBe(3);
    expect(
      await numsTotal({ filters: [{ column: "s", op: "like", value: "1%" }] })
    ).toBe(1);
    expect(
      await numsTotal({ filters: [{ column: "s", op: "is_null", value: "" }] })
    ).toBe(1);
    expect(
      await numsTotal({ filters: [{ column: "s", op: "not_null", value: "" }] })
    ).toBe(3);
  });

  test("ANDs the filters and refuses more than ten", async () => {
    addNums();
    const result = await controlRows(
      db.d1,
      rowsQuery("nums", {
        filters: [
          { column: "s", op: "not_null", value: "" },
          { column: "n", op: "gte", value: "2" },
        ],
      })
    );
    expect(result.total).toBe(2);
    await expect(
      controlRows(
        db.d1,
        rowsQuery("nums", {
          filters: Array.from({ length: 11 }, () => ({
            column: "n",
            op: "eq" as const,
            value: "1",
          })),
        })
      )
    ).rejects.toThrow(/at most 10/u);
  });

  test("searches every non-redacted column, case-insensitively", async () => {
    addNums();
    expect(await numsTotal({ search: "PLAIN" })).toBe(1);
    expect(await numsTotal({ search: "n2" })).toBe(1);
    expect(await numsTotal({ search: "missing" })).toBe(0);
  });

  test("escapes %, _ and \\ in the search needle", async () => {
    addNums();
    // An unescaped "%" would match every row.
    expect(await numsTotal({ search: "%" })).toBe(1);
    expect(await numsTotal({ search: "0%" })).toBe(1);
    // An unescaped "_" matches any single character.
    expect(await numsTotal({ search: "_" })).toBe(1);
    expect(await numsTotal({ search: "a_b" })).toBe(1);
    expect(await numsTotal({ search: "aXb" })).toBe(0);
  });

  test("masks redacted columns and never ships their real values", async () => {
    addUser("u1");
    addSession("s1", "super-secret-token", "u1");
    const result = await controlRows(db.d1, rowsQuery("session"));
    expect(cell(result, "token")).toBe(REDACTED_VALUE);
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  test("refuses filters and sorts on a redacted column, skips it in search", async () => {
    addUser("u1");
    addSession("s1", "zzz-secret-token", "u1");
    await expect(
      controlRows(
        db.d1,
        rowsQuery("session", {
          filters: [{ column: "token", op: "eq", value: "zzz-secret-token" }],
        })
      )
    ).rejects.toThrow(/redacted and cannot be filtered/u);
    await expect(
      controlRows(
        db.d1,
        rowsQuery("session", { sort: { column: "token", desc: false } })
      )
    ).rejects.toThrow(/redacted and cannot be sorted/u);
    // Search silently skips it: the secret must not be a reachable oracle.
    const secretSearch = await controlRows(
      db.d1,
      rowsQuery("session", { search: "zzz-secret-token" })
    );
    expect(secretSearch.total).toBe(0);
    const idSearch = await controlRows(
      db.d1,
      rowsQuery("session", { search: "s1" })
    );
    expect(idSearch.total).toBe(1);
  });
});

describe("write refusals", () => {
  test("auth tables never accept a write (default deny)", async () => {
    const refusals = ["account", "verification", "passkey", "apikey"].flatMap(
      (table) => [
        writeControlD1(db.d1, {
          actorId: "admin1",
          op: "insert",
          table,
          values: { id: "x" },
        }),
        writeControlD1(db.d1, {
          actorId: "admin1",
          key: { id: "x" },
          op: "update",
          table,
          values: { id: "x" },
        }),
        writeControlD1(db.d1, {
          actorId: "admin1",
          key: { id: "x" },
          op: "delete",
          table,
        }),
      ]
    );
    await Promise.all(
      refusals.map((promise) => expect(promise).rejects.toThrow(/read-only/u))
    );
  });

  test("a table this build has never heard of is read-only", async () => {
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        op: "insert",
        table: "future_auth",
        values: { id: "x" },
      })
    ).rejects.toThrow(/read-only/u);
  });

  test("sessions are revoked by delete only", async () => {
    addUser("u1");
    addSession("s1", "tok", "u1");
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { id: "s1" },
        op: "update",
        table: "session",
        values: { userAgent: "x" },
      })
    ).rejects.toThrow(/cannot be edited here/u);
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        op: "insert",
        table: "session",
        values: { id: "s2", token: "tok2", userId: "u1" },
      })
    ).rejects.toThrow(/not allowed/u);
  });

  test("a redacted column is refused even inside a key", async () => {
    addUser("u1");
    addSession("s1", "tok", "u1");
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { token: "tok" },
        op: "delete",
        table: "session",
      })
    ).rejects.toThrow(/never written here/u);
  });

  test("user.role and the ban columns are refused: the Users tab owns them", async () => {
    addUser("u1");
    const refusals = ["role", "banned", "banReason", "banExpires"];
    for (const column of refusals) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential policy refusals, one column at a time
      await expect(
        writeControlD1(db.d1, {
          actorId: "admin1",
          key: { id: "u1" },
          op: "update",
          table: "user",
          values: { [column]: "x" },
        })
      ).rejects.toThrow(/Users tab/u);
    }
    // The row itself stays writable: banning and role changes are the Users
    // tab's actions (admin.server banUser/unbanUser/setUserRole), not this raw
    // editor, but a plain profile update is still allowed here.
    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: "u1" },
      op: "update",
      table: "user",
      values: { name: "renamed" },
    });
    expect(
      db.raw.query(`SELECT name FROM "user" WHERE id = 'u1'`).get()
    ).toEqual({ name: "renamed" });
  });

  test("an admin can edit their own user row but never delete it", async () => {
    addUser("admin1");
    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: "admin1" },
      op: "update",
      table: "user",
      values: { name: "renamed" },
    });
    expect(
      db.raw.query(`SELECT name FROM "user" WHERE id = 'admin1'`).get()
    ).toEqual({ name: "renamed" });
    // Role stays locked on the admin's own row too.
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { id: "admin1" },
        op: "update",
        table: "user",
        values: { role: "user" },
      })
    ).rejects.toThrow(/role/u);
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { id: "admin1" },
        op: "delete",
        table: "user",
      })
    ).rejects.toThrow(/your own account cannot be deleted/u);
  });

  test("update and delete are keyed by the primary key only", async () => {
    addUser("u1");
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { email: "u1@example.com" },
        op: "update",
        table: "user",
        values: { name: "renamed" },
      })
    ).rejects.toThrow(/primary key/u);
    await expect(
      deleteControlRows(db.d1, {
        actorId: "admin1",
        keys: [{ email: "u1@example.com" }],
        table: "user",
      })
    ).rejects.toThrow(/primary key/u);
  });

  test("unknown columns, empty inserts and unknown ops are refused", async () => {
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        op: "insert",
        table: "invite",
        values: { nope: "x" },
      })
    ).rejects.toThrow(/unknown column/u);
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        op: "insert",
        table: "invite",
        values: {},
      })
    ).rejects.toThrow(/no values/u);
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        key: { id: "u1" },
        op: "update",
        table: "user",
        values: {},
      })
    ).rejects.toThrow(/no values/u);
  });
});

describe("permitted writes", () => {
  test("an invite round-trips (explicit id, then an update)", async () => {
    await writeControlD1(db.d1, {
      actorId: "admin1",
      op: "insert",
      table: "invite",
      values: {
        code: "ABCD-EFGH-JKLM",
        createdBy: "admin1",
        id: "11111111-1111-1111-1111-111111111111",
        note: "first",
      },
    });
    // SAFETY: the query selects exactly these two columns from bun:sqlite,
    // which returns one plain row object (or null).
    const inserted = db.raw.query(`SELECT id, note FROM invite`).get() as {
      id: string;
      note: string;
    } | null;
    expect(inserted?.note).toBe("first");
    expect(inserted?.id).toBe("11111111-1111-1111-1111-111111111111");

    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: inserted?.id ?? "" },
      op: "update",
      table: "invite",
      values: { note: "second note" },
    });
    expect(db.raw.query(`SELECT note FROM invite`).get()).toEqual({
      note: "second note",
    });
    const result = await controlRows(db.d1, rowsQuery("invite"));
    expect(cell(result, "note")).toBe("second note");
  });

  test('null binds SQL NULL and "" an empty string', async () => {
    await writeControlD1(db.d1, {
      actorId: "admin1",
      op: "insert",
      table: "invite",
      values: { code: "C1", createdBy: "a", id: "i1", note: null },
    });
    await writeControlD1(db.d1, {
      actorId: "admin1",
      op: "insert",
      table: "invite",
      values: { code: "C2", createdBy: "a", id: "i2", note: "" },
    });
    const result = await controlRows(db.d1, rowsQuery("invite"));
    expect(cell(result, "note", 0)).toBeNull();
    expect(cell(result, "note", 1)).toBe("");

    // The same round-trip through update.
    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: "i1" },
      op: "update",
      table: "invite",
      values: { note: "" },
    });
    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: "i2" },
      op: "update",
      table: "invite",
      values: { note: null },
    });
    const after = await controlRows(db.d1, rowsQuery("invite"));
    expect(cell(after, "note", 0)).toBe("");
    expect(cell(after, "note", 1)).toBeNull();
  });

  test("an insert omitting a column applies its DDL default", async () => {
    await writeControlD1(db.d1, {
      actorId: "admin1",
      op: "insert",
      table: "invite",
      values: { code: "CODE", createdBy: "admin1", id: "i1" },
    });
    // SAFETY: the query selects exactly these columns from bun:sqlite, which
    // returns one plain row object (or null).
    const row = db.raw
      .query(`SELECT note, revoked, createdAt FROM invite`)
      .get() as {
      createdAt: string;
      note: string | null;
      revoked: number;
    } | null;
    // revoked/createdAt are NOT NULL with defaults: omitted, they take the
    // default instead of a NULL that would violate the schema.
    expect(row?.revoked).toBe(0);
    expect(row?.createdAt).toBeTruthy();
    expect(row?.note).toBeNull();
    // An omitted empty `id` primary key is filled with a generated UUID
    // (the control schema's `id(uuidv4)` convention).
    await writeControlD1(db.d1, {
      actorId: "admin1",
      op: "insert",
      table: "invite",
      values: { code: "NO-ID", createdBy: "a" },
    });
    // SAFETY: the query selects exactly `id` from bun:sqlite, which returns
    // one plain row object (or null).
    const generated = db.raw
      .query(`SELECT id FROM invite WHERE code = 'NO-ID'`)
      .get() as { id: string } | null;
    expect(generated?.id).toHaveLength(36);
    // Other NOT NULL columns without a default are still required.
    await expect(
      writeControlD1(db.d1, {
        actorId: "admin1",
        op: "insert",
        table: "invite",
        values: { createdBy: "a" },
      })
    ).rejects.toThrow(/invite\.code is required/u);
  });

  test("a session can be revoked by primary key", async () => {
    addUser("u1");
    addSession("s1", "tok", "u1");
    await writeControlD1(db.d1, {
      actorId: "admin1",
      key: { id: "s1" },
      op: "delete",
      table: "session",
    });
    expect(db.raw.query(`SELECT COUNT(*) AS n FROM session`).get()).toEqual({
      n: 0,
    });
  });

  test("deleteRows removes 1..100 rows in one policy-checked batch", async () => {
    addInvite("i1", "C1", "a");
    addInvite("i2", "C2", "b");
    addInvite("i3", "C3", "c");
    const before = db.executed.length;
    const result = await deleteControlRows(db.d1, {
      actorId: "admin1",
      keys: [{ id: "i1" }, { id: "i2" }, { id: "i3" }],
      table: "invite",
    });
    expect(result).toEqual({ deleted: 3, ok: true });
    expect(
      db.executed.slice(before).filter((sql) => sql.startsWith("DELETE"))
    ).toHaveLength(3);
    expect(db.raw.query(`SELECT COUNT(*) AS n FROM invite`).get()).toEqual({
      n: 0,
    });
  });

  test("deleteRows refuses every key policy-check before running anything", async () => {
    addUser("u1");
    addSession("s1", "tok", "u1");
    const before = db.executed.length;
    // The second key carries a redacted column: the whole call must refuse
    // with nothing deleted (the batch never runs).
    await expect(
      deleteControlRows(db.d1, {
        actorId: "admin1",
        keys: [{ id: "s1" }, { id: "s1", token: "tok" }],
        table: "session",
      })
    ).rejects.toThrow(/never written here/u);
    expect(
      db.executed.slice(before).some((sql) => sql.startsWith("DELETE"))
    ).toBe(false);
    expect(db.raw.query(`SELECT COUNT(*) AS n FROM session`).get()).toEqual({
      n: 1,
    });
  });

  test("deleteRows obeys default deny, own-row and the 1..100 bound", async () => {
    addUser("admin1");
    await expect(
      deleteControlRows(db.d1, {
        actorId: "admin1",
        keys: [{ id: "x" }],
        table: "account",
      })
    ).rejects.toThrow(/read-only/u);
    await expect(
      deleteControlRows(db.d1, {
        actorId: "admin1",
        keys: [{ id: "admin1" }],
        table: "user",
      })
    ).rejects.toThrow(/your own account cannot be deleted/u);
    await expect(
      deleteControlRows(db.d1, { actorId: "admin1", keys: [], table: "invite" })
    ).rejects.toThrow(/delete 1 to 100/u);
    await expect(
      deleteControlRows(db.d1, {
        actorId: "admin1",
        keys: Array.from({ length: 101 }, (_, index) => ({ id: `i${index}` })),
        table: "invite",
      })
    ).rejects.toThrow(/delete 1 to 100/u);
  });
});

describe("gate", () => {
  test("only a real, non-impersonating admin passes", () => {
    expect(
      controlAccessRefusal({ impersonatedBy: null, isAdmin: true })
    ).toBeNull();
    expect(
      controlAccessRefusal({ impersonatedBy: null, isAdmin: false })
    ).toMatch(/admins only/u);
    expect(
      controlAccessRefusal({ impersonatedBy: "admin1", isAdmin: true })
    ).toMatch(/impersonating/u);
  });

  test("capabilities are default-deny per table", () => {
    expect(controlTableCaps("invite")).toEqual({
      delete: true,
      insert: true,
      update: true,
    });
    expect(controlTableCaps("session")).toEqual({
      delete: true,
      insert: false,
      update: false,
    });
    expect(controlTableCaps("account")).toEqual({
      delete: false,
      insert: false,
      update: false,
    });
    expect(controlTableCaps("future_auth")).toEqual({
      delete: false,
      insert: false,
      update: false,
    });
  });
});
