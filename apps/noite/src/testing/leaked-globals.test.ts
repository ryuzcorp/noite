import { describe, expect, test } from "bun:test";

import { leakedGlobals } from "./leaked-globals";

describe("leakedGlobals", () => {
  test("names every watched global the test added", () => {
    expect(
      leakedGlobals(new Set(["fetch"]), new Set(["fetch", "window", "Node"]))
    ).toEqual(["window", "Node"]);
  });

  test("a global the test put back is not a leak", () => {
    expect(
      leakedGlobals(new Set(["window", "document"]), new Set(["window"]))
    ).toEqual([]);
  });
});
