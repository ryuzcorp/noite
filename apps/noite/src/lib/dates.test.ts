import { describe, expect, test } from "bun:test";

import { formatDuration } from "./dates";

const START = "2026-11-12T10:00:00.000Z";

/** `formatDuration` from a start stamp to `seconds` later. */
const took = (seconds: number): string | null =>
  formatDuration(START, new Date(Date.parse(START) + seconds * 1000));

describe("formatDuration", () => {
  test("a sub-minute run reads in whole seconds", () => {
    expect(took(0)).toBe("0s");
    expect(took(42)).toBe("42s");
    expect(took(59)).toBe("59s");
  });

  test("a run under an hour reads in minutes and seconds", () => {
    expect(took(60)).toBe("1m");
    expect(took(102)).toBe("1m 42s");
    expect(took(3599)).toBe("59m 59s");
  });

  test("an hour or more reads in hours and minutes", () => {
    expect(took(3600)).toBe("1h");
    expect(took(3900)).toBe("1h 5m");
    expect(took(7500)).toBe("2h 5m");
  });

  test("a missing or unparseable stamp renders nothing", () => {
    expect(formatDuration(START, null)).toBeNull();
    expect(formatDuration(undefined, START)).toBeNull();
    expect(formatDuration("not a date", START)).toBeNull();
  });

  test("a clock that went backwards never paints a negative time", () => {
    expect(formatDuration(START, "2026-11-12T09:59:59.000Z")).toBe("0s");
  });
});
