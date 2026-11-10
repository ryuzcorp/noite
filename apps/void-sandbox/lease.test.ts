// The lease machine: one transition function, the durable shape unchanged.
import { describe, expect, test } from "bun:test";

import type { Lease, LeaseEffect, StoredLease } from "./src/lease.ts";
import { decodeLease, encodeLease, stepLease } from "./src/lease.ts";

const runningFacts = { container: "running", starting: false } as const;
const stoppedFacts = { container: "stopped", starting: false } as const;

const tags = (effects: readonly LeaseEffect[]): string[] =>
  effects.map((effect) => {
    if (effect._tag === "Admit") {
      return `Admit:${effect.method}`;
    }

    return effect._tag === "Persist"
      ? `Persist:${effect.lease._tag}`
      : effect._tag;
  });

describe("decode / encode", () => {
  test("round-trips every durable shape", () => {
    const leases: Lease[] = [
      { _tag: "Pending", generation: "g1" },
      { _tag: "Running", generation: "g1" },
      { _tag: "Stopping", generation: "g1" },
      { _tag: "Stopped", generation: "g1" },
    ];

    for (const lease of leases) {
      const stored = encodeLease(lease);

      expect(stored).not.toBeNull();
      expect(decodeLease(stored ?? undefined)).toEqual(
        lease._tag === "Stopped"
          ? { _tag: "Stopping", generation: "g1" }
          : lease
      );
    }

    expect(encodeLease({ _tag: "Absent" })).toBeNull();
  });

  test("writes exactly the previous code's shape", () => {
    expect(encodeLease({ _tag: "Pending", generation: "g" })).toEqual({
      generation: "g",
      phase: "pending",
    });
    expect(encodeLease({ _tag: "Running", generation: "g" })).toEqual({
      generation: "g",
      phase: "running",
    });
    expect(encodeLease({ _tag: "Stopping", generation: "g" })).toEqual({
      generation: "g",
      phase: "stopped",
    });
  });

  test("a malformed or unknown record is released, never adopted", () => {
    expect(decodeLease()).toEqual({ _tag: "Absent" });
    expect(decodeLease({ generation: "", phase: "pending" })).toEqual({
      _tag: "Absent",
    });

    // SAFETY: storage can hold a phase this build does not know (rollback, a
    // newer writer); the decoder must release it instead of adopting it.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a phase outside this build's union is exactly the case under test.
    const unknown = {
      generation: "g",
      phase: "bogus",
    } as unknown as StoredLease;

    expect(decodeLease(unknown)).toEqual({
      _tag: "Stopping",
      generation: "g",
    });
  });
});

describe("Start", () => {
  test("a fresh start persists pending before reserving", () => {
    const decision = stepLease(
      { _tag: "Absent" },
      { _tag: "Start", generation: "g2" },
      stoppedFacts
    );

    expect(decision._tag).toBe("Next");
    expect(decision).toMatchObject({
      lease: { _tag: "Pending", generation: "g2" },
    });
    expect(tags(decision.effects)).toEqual([
      "Persist:Pending",
      "Arm",
      "Admit:reserve",
    ]);
  });

  test("a live running lease only heartbeats", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Start", generation: "g2" },
      runningFacts
    );

    expect(decision).toMatchObject({
      lease: { _tag: "Running", generation: "g1" },
    });
    expect(tags(decision.effects)).toEqual(["Admit:heartbeat", "Arm"]);
  });

  test("a superseded lease releases its generation before the new reserve", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Start", generation: "g2" },
      stoppedFacts
    );

    expect(tags(decision.effects)).toEqual([
      "MarkStopping",
      "Arm",
      "ReleaseAdmission",
      "Clear",
      "Persist:Pending",
      "Arm",
      "Admit:reserve",
    ]);
  });

  test("an unowned container is killed before the new record", () => {
    const decision = stepLease(
      { _tag: "Absent" },
      { _tag: "Start", generation: "g2" },
      runningFacts
    );

    expect(tags(decision.effects)[0]).toBe("Kill");
  });
});

describe("Started", () => {
  test("pending becomes running with the admission receipt first", () => {
    const decision = stepLease(
      { _tag: "Pending", generation: "g1" },
      { _tag: "Started" },
      runningFacts
    );

    expect(decision).toMatchObject({
      lease: { _tag: "Running", generation: "g1" },
    });
    expect(tags(decision.effects)).toEqual([
      "Admit:started",
      "Persist:Running",
      "Touch",
      "Arm",
    ]);
  });

  test("running is idempotent", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Started" },
      runningFacts
    );

    expect(tags(decision.effects)).toEqual(["Arm"]);
  });

  test("a refusal destroys the container it cannot own", () => {
    for (const lease of [
      { _tag: "Absent" },
      { _tag: "Stopping", generation: "g1" },
    ] as const) {
      const decision = stepLease(lease, { _tag: "Started" }, runningFacts);

      expect(decision._tag).toBe("Refused");
      expect(tags(decision.effects)).toEqual(["Destroy"]);
    }
  });

  test("a container that is not running is refused and torn down", () => {
    const decision = stepLease(
      { _tag: "Pending", generation: "g1" },
      { _tag: "Started" },
      stoppedFacts
    );

    expect(decision._tag).toBe("Refused");
    expect(tags(decision.effects)).toEqual(["Destroy"]);
  });
});

describe("Use and Release", () => {
  test("Use only heartbeats a running lease", () => {
    expect(
      tags(
        stepLease(
          { _tag: "Running", generation: "g1" },
          { _tag: "Use" },
          runningFacts
        ).effects
      )
    ).toEqual(["Admit:heartbeat"]);

    for (const lease of [
      { _tag: "Absent" },
      { _tag: "Pending", generation: "g1" },
      { _tag: "Stopping", generation: "g1" },
    ] as const) {
      const decision = stepLease(lease, { _tag: "Use" }, runningFacts);

      expect(decision._tag).toBe("Refused");
      expect(decision.effects).toEqual([]);
    }
  });

  test("Release never runs while the container is live", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Release" },
      runningFacts
    );

    expect(decision._tag).toBe("Refused");
    expect(decision.effects).toEqual([]);
  });

  test("Release writes the stop mark before the receipt", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Release" },
      stoppedFacts
    );

    expect(decision).toMatchObject({ lease: { _tag: "Stopped" } });
    expect(tags(decision.effects)).toEqual([
      "MarkStopping",
      "Arm",
      "ReleaseAdmission",
      "Clear",
    ]);
  });

  test("Release finishes a mark a crash left behind without rewriting it", () => {
    const decision = stepLease(
      { _tag: "Stopping", generation: "g1" },
      { _tag: "Release" },
      stoppedFacts
    );

    expect(tags(decision.effects)).toEqual([
      "Arm",
      "ReleaseAdmission",
      "Clear",
    ]);
  });

  test("Release on an absent lease is a no-op", () => {
    const decision = stepLease(
      { _tag: "Absent" },
      { _tag: "Release" },
      stoppedFacts
    );

    expect(decision).toMatchObject({ _tag: "Next", lease: { _tag: "Absent" } });
    expect(decision.effects).toEqual([]);
  });
});

describe("Recover", () => {
  test("a live running lease heartbeats", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Recover" },
      runningFacts
    );

    expect(tags(decision.effects)).toEqual(["Admit:heartbeat", "Arm"]);
  });

  test("a running lease whose container died is torn down", () => {
    const decision = stepLease(
      { _tag: "Running", generation: "g1" },
      { _tag: "Recover" },
      stoppedFacts
    );

    expect(decision).toMatchObject({ lease: { _tag: "Stopping" } });
    expect(tags(decision.effects)).toEqual(["Destroy"]);
  });

  test("a pending start in flight is left alone", () => {
    const decision = stepLease(
      { _tag: "Pending", generation: "g1" },
      { _tag: "Recover" },
      { container: "stopped", starting: true }
    );

    expect(tags(decision.effects)).toEqual(["Arm"]);
  });

  test("a pending lease with no start in flight is a crash artifact", () => {
    const decision = stepLease(
      { _tag: "Pending", generation: "g1" },
      { _tag: "Recover" },
      { container: "stopped", starting: false }
    );

    expect(tags(decision.effects)).toEqual(["Destroy"]);
  });

  test("a torn stop is finished", () => {
    const decision = stepLease(
      { _tag: "Stopping", generation: "g1" },
      { _tag: "Recover" },
      stoppedFacts
    );

    expect(decision).toMatchObject({ lease: { _tag: "Stopped" } });
    expect(tags(decision.effects)).toEqual(["ReleaseNow"]);
  });

  test("an absent lease recovers to nothing", () => {
    const decision = stepLease(
      { _tag: "Absent" },
      { _tag: "Recover" },
      stoppedFacts
    );

    expect(decision).toMatchObject({ lease: { _tag: "Absent" } });
    expect(decision.effects).toEqual([]);
  });
});
