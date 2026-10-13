import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PoderD1 } from "../src/d1.ts";
import { isNumber } from "../src/guards.ts";
import { createPoder } from "../src/index.ts";
import type { Poder } from "../src/types.ts";
import { bunDriver, makeProjectDir, makeStateDir } from "./driver.ts";

const d1From = (env: Poder["env"]): PoderD1 =>
  // SAFETY: env.DB is the PoderD1 this test bound; asserted once at the test boundary.
  env["DB"] as PoderD1;

const makeD1 = async (
  migrations: Record<string, string>
): Promise<{ db: PoderD1; dispose: () => Promise<void> }> => {
  const projectDir = makeProjectDir();
  mkdirSync(path.join(projectDir, "migrations"), { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) {
    writeFileSync(path.join(projectDir, "migrations", name), sql);
  }
  const poder = await createPoder({
    bindings: { d1: [{ binding: "DB", databaseName: "demo" }] },
    projectDir,
    sqlite: bunDriver,
    stateDir: makeStateDir(),
    workerModule: {},
  });
  return { db: d1From(poder.env), dispose: () => poder.dispose() };
};

describe("D1", () => {
  it("runs prepare/bind/first/all/run/raw with meta", async () => {
    const { db, dispose } = await makeD1({
      "0001_init.sql":
        "CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, url TEXT NOT NULL);",
    });
    try {
      const run = await db
        .prepare("INSERT INTO visits (ts, url) VALUES (?, ?)")
        .bind("t0", "https://a/")
        .run();
      expect(run.success).toBe(true);
      expect(run.meta.changes).toBe(1);
      expect(run.meta.last_row_id).toBe(1);
      expect(run.meta.changed_db).toBe("demo");
      expect(isNumber(run.meta.duration)).toBe(true);

      const first = await db
        .prepare("SELECT * FROM visits WHERE id = ?")
        .bind(1)
        .first<{ url: string }>();
      expect(first?.url).toBe("https://a/");

      const missing = await db
        .prepare("SELECT * FROM visits WHERE id = ?")
        .bind(999)
        .first();
      expect(missing).toBeNull();

      const column = await db
        .prepare("SELECT url FROM visits WHERE id = ?")
        .bind(1)
        .first<string>("url");
      expect(column).toBe("https://a/");

      const all = await db
        .prepare("SELECT * FROM visits ORDER BY id")
        .all<{ id: number }>();
      expect(all.results.map((row) => row.id)).toEqual([1]);
      expect(all.meta.rows_read).toBe(1);

      const raw = await db
        .prepare("SELECT id, url FROM visits ORDER BY id")
        .raw<[number, string]>();
      expect(raw).toEqual([[1, "https://a/"]]);
    } finally {
      await dispose();
    }
  });

  it("batches in a transaction and rolls back on error", async () => {
    const { db, dispose } = await makeD1({
      "0001_init.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);",
    });
    try {
      const results = await db.batch([
        db.prepare("INSERT INTO t (v) VALUES (?)").bind("a"),
        db.prepare("INSERT INTO t (v) VALUES (?)").bind("b"),
      ]);
      expect(results).toHaveLength(2);
      expect(results[0]?.meta.changes).toBe(1);

      await expect(
        db.batch([
          db.prepare("INSERT INTO t (v) VALUES (?)").bind("c"),
          db.prepare("INSERT INTO nope (v) VALUES (1)"),
        ])
      ).rejects.toThrow();
      const after = await db
        .prepare("SELECT COUNT(*) AS n FROM t")
        .first<{ n: number }>();
      expect(after?.n).toBe(2);
    } finally {
      await dispose();
    }
  });

  it("applies migrations once and keeps data across instances", async () => {
    const projectDir = makeProjectDir();
    mkdirSync(path.join(projectDir, "migrations"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "migrations", "0001_init.sql"),
      "CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT);"
    );
    writeFileSync(
      path.join(projectDir, "migrations", "0002_seed.sql"),
      "INSERT INTO m (v) VALUES ('seed');"
    );
    const stateDir = makeStateDir();
    const bindings = { d1: [{ binding: "DB", databaseName: "demo" }] };

    const first = await createPoder({
      bindings,
      projectDir,
      sqlite: bunDriver,
      stateDir,
      workerModule: {},
    });
    await d1From(first.env)
      .prepare("INSERT INTO m (v) VALUES (?)")
      .bind("extra")
      .run();
    await first.dispose();

    const second = await createPoder({
      bindings,
      projectDir,
      sqlite: bunDriver,
      stateDir,
      workerModule: {},
    });
    try {
      const db = d1From(second.env);
      const applied = await db
        .prepare("SELECT name FROM d1_migrations ORDER BY name")
        .all<{ name: string }>();
      expect(applied.results.map((row) => row.name)).toEqual([
        "0001_init.sql",
        "0002_seed.sql",
      ]);
      const rows = await db
        .prepare("SELECT v FROM m ORDER BY id")
        .all<{ v: string }>();
      expect(rows.results.map((row) => row.v)).toEqual(["seed", "extra"]);
    } finally {
      await second.dispose();
    }
  });

  it("supports exec, withSession and rejects dump", async () => {
    const { db, dispose } = await makeD1({
      "0001_init.sql": "CREATE TABLE e (id INTEGER PRIMARY KEY);",
    });
    try {
      const execed = await db.exec(
        "INSERT INTO e DEFAULT VALUES; INSERT INTO e DEFAULT VALUES;"
      );
      expect(execed.count).toBe(2);
      const session = db.withSession();
      const counted = await session
        .prepare("SELECT COUNT(*) AS n FROM e")
        .first<{ n: number }>();
      expect(counted?.n).toBe(2);
      await expect(db.dump()).rejects.toThrow("not available in Preview");
    } finally {
      await dispose();
    }
  });
});
