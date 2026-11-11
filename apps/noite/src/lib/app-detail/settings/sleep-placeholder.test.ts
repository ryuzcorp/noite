import { describe, expect, test } from "bun:test";

import { sleepPlaceholder } from "./sleep-placeholder";

describe("sleep placeholder", () => {
  test("reads the derived default in its largest exact unit", () => {
    // A <= 2 GiB host derives 15 minutes; the input must not read "900 s".
    expect(sleepPlaceholder(15 * 60)).toBe("Default: 15 min");
    expect(sleepPlaceholder(3600)).toBe("Default: 1 h");
    expect(sleepPlaceholder(24 * 3600)).toBe("Default: 24 h");
    expect(sleepPlaceholder(90)).toBe("Default: 90 s");
    expect(sleepPlaceholder(0)).toBe("Default: never");
  });
});
