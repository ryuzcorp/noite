import { describe, expect, test } from "bun:test";

import type { RunnerDeploy } from "../runner";
import {
  createWaitGate,
  isTerminalDeploy,
  MAX_CONCURRENT_WAITS,
  waitForDeploy,
} from "./deploy-wait";

const deploy = (over: Partial<RunnerDeploy> = {}): RunnerDeploy => ({
  actor: null,
  appId: "app-1",
  createdAt: "2026-11-11T00:00:00Z",
  environmentId: null,
  id: "dep-1",
  intent: "deploy",
  log: "",
  sha: "a".repeat(40),
  status: "building",
  updatedAt: "2026-11-11T00:00:01Z",
  ...over,
});

/** A fake clock and a fake sleep: the budget is driven by the test, so no test
 * ever waits on wall time. */
const clock = (rows: (RunnerDeploy | null)[]) => {
  let now = 0;
  let reads = 0;
  const sleeps: number[] = [];

  return {
    deps: {
      now: () => now,
      read: (): Promise<RunnerDeploy | null> => {
        const row = rows[Math.min(reads, rows.length - 1)] ?? null;
        reads += 1;

        return Promise.resolve(row);
      },
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        now += ms;

        return Promise.resolve();
      },
    },
    get reads() {
      return reads;
    },
    sleeps,
  };
};

describe("isTerminalDeploy", () => {
  test("only the four settled statuses are terminal", () => {
    for (const status of [
      "success",
      "failed",
      "cancelled",
      "stalled",
    ] as const) {
      expect(isTerminalDeploy(status), status).toBe(true);
    }

    for (const status of ["queued", "building", "deploying"] as const) {
      expect(isTerminalDeploy(status), status).toBe(false);
    }
  });
});

describe("waitForDeploy", () => {
  test("a row that already settled answers without sleeping", async () => {
    const fake = clock([deploy({ status: "success" })]);
    const outcome = await waitForDeploy(fake.deps, 10_000);

    expect(outcome._tag).toBe("Settled");
    expect(fake.sleeps).toEqual([]);
    expect(fake.reads).toBe(1);
  });

  test("a row that settles mid-budget answers with the terminal row", async () => {
    const fake = clock([
      deploy({ status: "building" }),
      deploy({ status: "deploying" }),
      deploy({ status: "success" }),
    ]);

    const outcome = await waitForDeploy(fake.deps, 10_000);

    expect(outcome._tag).toBe("Settled");
    expect(outcome._tag === "Settled" && outcome.deploy.status).toBe("success");
    expect(fake.sleeps).toEqual([2000, 2000]);
  });

  test("a row still moving when the budget runs out answers Waiting", async () => {
    const fake = clock([deploy({ status: "building" })]);
    const outcome = await waitForDeploy(fake.deps, 2500);

    expect(outcome._tag).toBe("Waiting");
    expect(outcome._tag === "Waiting" && outcome.deploy.status).toBe(
      "building"
    );
    // 1000 + 1000 + the 500 left, never past the budget.
    expect(fake.sleeps).toEqual([2000, 500]);
  });

  test("no row yet answers Missing instead of Waiting", async () => {
    const fake = clock([null]);
    const outcome = await waitForDeploy(fake.deps, 2000);

    expect(outcome._tag).toBe("Missing");
  });

  test("a row that appears later is found", async () => {
    const fake = clock([null, deploy({ id: "dep-2", status: "success" })]);
    const outcome = await waitForDeploy(fake.deps, 5000);

    expect(outcome._tag === "Settled" && outcome.deploy.id).toBe("dep-2");
  });
});

describe("the wait gate", () => {
  test("caps one key's in-flight waits and frees a slot on leave", () => {
    const gate = createWaitGate(2);

    expect(gate.enter("key-a")).toBe(true);
    expect(gate.enter("key-a")).toBe(true);
    expect(gate.enter("key-a")).toBe(false);
    expect(gate.active("key-a")).toBe(2);
    // Another key has its own slots.
    expect(gate.enter("key-b")).toBe(true);
    expect(gate.enter("key-b")).toBe(true);
    expect(gate.enter("key-b")).toBe(false);

    gate.leave("key-a");
    expect(gate.active("key-a")).toBe(1);
    expect(gate.enter("key-a")).toBe(true);
    expect(gate.enter("key-a")).toBe(false);

    gate.leave("key-a");
    gate.leave("key-a");
    // A released key is forgotten, so the map holds only live waits.
    expect(gate.active("key-a")).toBe(0);
    expect(gate.enter("key-a")).toBe(true);
  });

  test("the agent loop's default limit leaves room for a burst", () => {
    const gate = createWaitGate();

    expect(MAX_CONCURRENT_WAITS).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < MAX_CONCURRENT_WAITS; i += 1) {
      expect(gate.enter("key-a")).toBe(true);
    }

    expect(gate.enter("key-a")).toBe(false);
  });

  test("a stray leave never underflows another key's count", () => {
    const gate = createWaitGate(1);

    gate.leave("key-nobody");
    expect(gate.active("key-nobody")).toBe(0);
    expect(gate.enter("key-nobody")).toBe(true);
    expect(gate.enter("key-nobody")).toBe(false);
    gate.leave("key-nobody");
    gate.leave("key-nobody");
    expect(gate.active("key-nobody")).toBe(0);
  });
});
