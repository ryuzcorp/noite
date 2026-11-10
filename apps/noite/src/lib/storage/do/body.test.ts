import { describe, expect, test } from "bun:test";

import { doBodyOf, doSummary } from "./body";

describe("DO preview body", () => {
  test("null is one state, and the copy does not invent a reason", () => {
    const body = doBodyOf(null);
    expect(body._tag).toBe("Silent");
    expect(doSummary(body)).toBe("no preview reported");
  });

  test("a JSON object becomes key/value entries", () => {
    const body = doBodyOf(JSON.stringify({ count: 2, name: "x" }));

    expect(body._tag).toBe("Json");

    if (body._tag === "Json") {
      expect(body.entries.map((entry) => entry.key)).toEqual(["count", "name"]);
    }
  });

  test("an empty object is not a record with rows", () => {
    expect(doSummary(doBodyOf("{}"))).toBe("{} (empty)");
  });

  test("an array or scalar is text, not a fake record", () => {
    expect(doBodyOf("[1,2]")._tag).toBe("Text");
    expect(doBodyOf("plain")._tag).toBe("Text");
  });
});
