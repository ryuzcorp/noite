import { beforeEach, describe, expect, test } from "bun:test";

import { createTestD1, gateD1 } from "../testing/d1";
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

describe("shared setup pass", () => {
  test("the starter registers its pass with the worker lifetime", async () => {
    // celld drops a request's pending work when that request answers or its
    // client leaves. Registering the shared pass with `waitUntil` is what
    // keeps it alive past its starter, so waiters never hang on a dropped
    // pass (issues #91, #92, flake H).
    const waited: Promise<unknown>[] = [];
    await ensureDbPromise({
      ctx: {
        waitUntil: (promise) => {
          waited.push(promise);
        },
      },
      waitMs: 0,
    });
    expect(waited).toHaveLength(1);
    await waited[0];
  });

  test("expired waiters share one replacement pass instead of starting their own", async () => {
    // A gated D1: setup statements block until `release` models the store
    // answering, so the first pass never settles while the waiters' zero
    // bound expires. Every pass prepares the same pipeline, so the prepare
    // count is the pass count up to a measured per-pass baseline.
    let release!: () => void;

    // oxlint-disable-next-line promise/avoid-new -- the test resolves the gate by hand after asserting the herd count
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    let prepares = 0;

    // The lane's control database is migrated long before any contention:
    // migrate first, then contend over the migrated store, so the passes
    // under test issue the production mid-lane statements (reads plus an
    // idempotent ledger write) instead of racing fresh DDL at each other
    // (a boot-time-only hazard this fix narrows from N passes to two).
    await ensureDbPromise({ waitMs: 0 });

    // SAFETY: a spread of the shim keeps its prepare/batch methods: a distinct handle over the same database.
    const again = { ...db.d1 } as typeof db.d1;
    setD1Binding(
      gateD1(again, {
        gate,
        onPrepare: () => {
          prepares += 1;
        },
      })
    );

    // Loop-turn yields (never a sleep): lets scheduled Effect work run
    // while the gate holds every pass. Exits on quiescence — the prepare
    // count settling — which is the real signal that every in-flight pass
    // has issued all the statements it can.
    const quiesce = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        const before = prepares;
        // oxlint-disable-next-line eslint/no-await-in-loop, promise/avoid-new -- sequential quiescence poll: each turn re-reads the live prepare count until it settles, never a sleep
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        if (prepares === before) {
          return;
        }
      }
    };

    const starter = ensureDbPromise({ waitMs: 0 });
    await quiesce();
    const baseline = prepares;
    expect(baseline).toBeGreaterThan(0);

    const waiter1 = ensureDbPromise({ waitMs: 0 });
    const waiter2 = ensureDbPromise({ waitMs: 0 });
    const waiter3 = ensureDbPromise({ waitMs: 0 });
    await quiesce();

    // One starter pass plus one shared replacement: without single-flight
    // each expired waiter starts its own, counting four baselines.
    expect(prepares).toBe(baseline * 2);

    release();
    await starter;
    await waiter1;
    await waiter2;
    await waiter3;
  });
});
