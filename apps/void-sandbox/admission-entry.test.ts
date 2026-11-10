// The admission entry machine: state derivation, storage compatibility and
// every refused transition.
import { describe, expect, test } from "bun:test";

import type { AdmissionEvent } from "./src/admission-entry.ts";
import { applyEntry, decodeEntry, encodeEntry } from "./src/admission-entry.ts";

const reserve: AdmissionEvent = {
  _tag: "Reserve",
  admitted: true,
  fenced: false,
  generation: "g1",
  hasCapacity: true,
};

describe("decode / encode", () => {
  test("round-trips the stored shapes", () => {
    expect(decodeEntry({ generation: "g1", phase: "reserved" })).toEqual({
      _tag: "Reserved",
      generation: "g1",
    });
    expect(
      decodeEntry({ generation: "g1", phase: "running", startedAt: 5 })
    ).toEqual({ _tag: "Running", generation: "g1", startedAt: 5 });
    expect(
      decodeEntry({
        generation: "g1",
        phase: "running",
        startedAt: 5,
        stoppedAt: 9,
      })
    ).toEqual({
      _tag: "Stopping",
      generation: "g1",
      startedAt: 5,
      stoppedAt: 9,
    });
  });

  test("phase is not trusted; startedAt/stoppedAt decide the state", () => {
    // The old code could store this combination; it never wrote it.
    expect(decodeEntry({ generation: "g1", phase: "running" })).toEqual({
      _tag: "Reserved",
      generation: "g1",
    });
    expect(
      decodeEntry({ generation: "g1", phase: "reserved", startedAt: 5 })
    ).toEqual({ _tag: "Running", generation: "g1", startedAt: 5 });
  });

  test("an unusable value is undefined, never a fabricated entry", () => {
    expect(decodeEntry()).toBeUndefined();
    expect(decodeEntry({ generation: "", phase: "reserved" })).toBeUndefined();
  });

  test("encode keeps the exact previous wire shape", () => {
    expect(encodeEntry({ _tag: "Reserved", generation: "g1" })).toEqual({
      generation: "g1",
      phase: "reserved",
    });
    expect(
      encodeEntry({ _tag: "Running", generation: "g1", startedAt: 5 })
    ).toEqual({ generation: "g1", phase: "running", startedAt: 5 });
    expect(
      encodeEntry({ _tag: "Stopping", generation: "g1", stoppedAt: 9 })
    ).toEqual({ generation: "g1", phase: "reserved", stoppedAt: 9 });
    expect(
      encodeEntry({
        _tag: "Stopping",
        generation: "g1",
        startedAt: 5,
        stoppedAt: 9,
      })
    ).toEqual({
      generation: "g1",
      phase: "running",
      startedAt: 5,
      stoppedAt: 9,
    });
  });
});

describe("Reserve", () => {
  test("a new generation is reserved when there is room", () => {
    expect(applyEntry(undefined, reserve)).toEqual({
      _tag: "Admitted",
      changed: true,
      entry: { _tag: "Reserved", generation: "g1" },
    });
  });

  test("a full table is refused with concurrency", () => {
    expect(applyEntry(undefined, { ...reserve, hasCapacity: false })).toEqual({
      _tag: "Refused",
      reason: "concurrency",
    });
  });

  test("a fenced generation is never re-admitted", () => {
    expect(applyEntry(undefined, { ...reserve, fenced: true })).toEqual({
      _tag: "Refused",
      reason: "unavailable",
    });
  });

  test("re-reserving the same generation is idempotent", () => {
    expect(applyEntry({ _tag: "Reserved", generation: "g1" }, reserve)).toEqual(
      {
        _tag: "Admitted",
        changed: false,
        entry: { _tag: "Reserved", generation: "g1" },
      }
    );
  });

  test("another generation is unavailable under any cap", () => {
    expect(
      applyEntry({ _tag: "Running", generation: "g0", startedAt: 1 }, reserve)
    ).toEqual({ _tag: "Refused", reason: "unavailable" });
    expect(
      applyEntry({ _tag: "Stopping", generation: "g0", stoppedAt: 1 }, reserve)
    ).toEqual({ _tag: "Refused", reason: "unavailable" });
  });

  test("a cap shrink refuses an existing entry outside the keep set", () => {
    expect(
      applyEntry(
        { _tag: "Running", generation: "g1", startedAt: 1 },
        { ...reserve, admitted: false }
      )
    ).toEqual({ _tag: "Refused", reason: "concurrency" });
  });
});

describe("Start", () => {
  test("a reserved entry becomes running with a timestamp", () => {
    expect(
      applyEntry(
        { _tag: "Reserved", generation: "g1" },
        {
          _tag: "Start",
          admitted: true,
          at: 7,
          generation: "g1",
        }
      )
    ).toEqual({
      _tag: "Admitted",
      changed: true,
      entry: { _tag: "Running", generation: "g1", startedAt: 7 },
    });
  });

  test("an already running entry is unchanged", () => {
    expect(
      applyEntry(
        { _tag: "Running", generation: "g1", startedAt: 1 },
        {
          _tag: "Start",
          admitted: true,
          at: 7,
          generation: "g1",
        }
      )
    ).toEqual({
      _tag: "Admitted",
      changed: false,
      entry: { _tag: "Running", generation: "g1", startedAt: 1 },
    });
  });

  test("an unknown or wrong-generation entry is unavailable", () => {
    const event: AdmissionEvent = {
      _tag: "Start",
      admitted: true,
      at: 7,
      generation: "g1",
    };

    expect(applyEntry(undefined, event)).toEqual({
      _tag: "Refused",
      reason: "unavailable",
    });
    expect(applyEntry({ _tag: "Reserved", generation: "g0" }, event)).toEqual({
      _tag: "Refused",
      reason: "unavailable",
    });
  });
});

describe("Heartbeat", () => {
  test("an existing entry outside the keep set is refused", () => {
    expect(
      applyEntry(
        { _tag: "Running", generation: "g1", startedAt: 1 },
        {
          _tag: "Heartbeat",
          admitted: false,
          generation: "g1",
        }
      )
    ).toEqual({ _tag: "Refused", reason: "concurrency" });
  });

  test("a valid heartbeat leaves the entry alone", () => {
    const entry = { _tag: "Running", generation: "g1", startedAt: 1 } as const;

    expect(
      applyEntry(entry, {
        _tag: "Heartbeat",
        admitted: true,
        generation: "g1",
      })
    ).toEqual({ _tag: "Admitted", changed: false, entry });
  });
});

describe("Stop", () => {
  test("marks a running entry stopping, keeping its phase", () => {
    expect(
      applyEntry(
        { _tag: "Running", generation: "g1", startedAt: 1 },
        { _tag: "Stop", at: 9, generation: "g1" }
      )
    ).toEqual({
      _tag: "Released",
      entry: {
        _tag: "Stopping",
        generation: "g1",
        startedAt: 1,
        stoppedAt: 9,
      },
    });
  });

  test("marks a reserved entry stopping with no timestamp", () => {
    expect(
      applyEntry(
        { _tag: "Reserved", generation: "g1" },
        { _tag: "Stop", at: 9, generation: "g1" }
      )
    ).toEqual({
      _tag: "Released",
      entry: { _tag: "Stopping", generation: "g1", stoppedAt: 9 },
    });
  });

  test("a stop that overtakes its reserve has nothing to drop", () => {
    expect(
      applyEntry(undefined, { _tag: "Stop", at: 9, generation: "g1" })
    ).toEqual({ _tag: "Released" });
    expect(
      applyEntry(
        { _tag: "Running", generation: "g0", startedAt: 1 },
        { _tag: "Stop", at: 9, generation: "g1" }
      )
    ).toEqual({ _tag: "Released" });
  });

  test("an already stopping entry is released without a rewrite", () => {
    const entry = { _tag: "Stopping", generation: "g1", stoppedAt: 3 } as const;

    expect(
      applyEntry(entry, { _tag: "Stop", at: 9, generation: "g1" })
    ).toEqual({ _tag: "Released", entry });
  });
});
